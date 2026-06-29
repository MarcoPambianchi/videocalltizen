// C7 — Service de signalisation d'appel pour videocalltizen.
// LiveKit raisonne en salles, pas en appels : ce service ajoute la notion de
// sonnerie / décrochage / raccrochage entre un appelant et la TV (app Tizen).
//
// Machine à états (un seul appel à la fois, 1-à-1) :
//   idle -> sonnerie -> en_appel -> idle
//
// La TV ouvre une WS persistante et s'enregistre {type:'register',role:'tv'}.
// Un appelant déclenche via HTTP POST /call {from}. La TV répond par WS
// {type:'decrocher'|'raccrocher', callId}. Au décrochage, on pilote token-service
// pour créer la room, lancer l'ingestion (ingress RTMP) et émettre un token TV.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const {
  PORT = "9090",
  TOKEN_SERVICE_URL = "http://token-service:9080",
  GO2RTC_API_URL = "http://go2rtc:1984",
  GO2RTC_STREAM = "salon",
  ROOM_NAME = "salon",
  CAMERA_IDENTITY = "camera-salon",
  TV_IDENTITY = "tv-salon",
  WEB_CLIENT_URL = "http://localhost:9088",
  RING_TIMEOUT_MS = "30000",
  // "Numéro d'appel" du téléviseur : code stable que l'appelant utilise pour le joindre.
  TV_CODE = "salon",
  TV_NAME = "Téléviseur du salon",
} = process.env;

const RING_TIMEOUT = Number(RING_TIMEOUT_MS);

// ── État global (un seul appel actif) ────────────────────────────────────────
// state.status : 'idle' | 'sonnerie' | 'en_appel'
const state = {
  status: "idle",
  callId: null,
  from: null,
  ingressId: null,
  ringTimer: null,
  // joinUrl/joinError exposés à l'appelant via GET /call/:id/status
  joinUrl: null,
  joinError: null,
};

// Connexion WS courante de la TV (une seule TV pour ce déploiement 1-à-1).
let tvSocket = null;

function resetState() {
  if (state.ringTimer) clearTimeout(state.ringTimer);
  state.status = "idle";
  state.callId = null;
  state.from = null;
  state.ingressId = null;
  state.ringTimer = null;
  state.joinUrl = null;
  state.joinError = null;
}

function snapshot() {
  return {
    status: state.status,
    callId: state.callId,
    from: state.from,
    room: ROOM_NAME,
    tvCode: TV_CODE,
    tvName: TV_NAME,
    tvConnected: !!(tvSocket && tvSocket.readyState === 1),
    joinUrl: state.joinUrl,
  };
}

function sendToTv(payload) {
  if (tvSocket && tvSocket.readyState === 1) {
    tvSocket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

// ── Helpers token-service (fetch natif, erreurs non bloquantes) ──────────────
async function callTokenService(method, path, body) {
  const opts = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${TOKEN_SERVICE_URL}${path}`, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const detail = data && data.error ? data.error : `HTTP ${res.status}`;
    throw new Error(`token-service ${method} ${path}: ${detail}`);
  }
  return data;
}

// Démarre/arrête la publication go2rtc -> ingress (la source 'salon' est lazy :
// sans ce push, l'ingress RTMP reste vide et la TV rejoint une salle sans caméra).
async function go2rtcPublish(dst) {
  const u = `${GO2RTC_API_URL}/api/streams?src=${encodeURIComponent(GO2RTC_STREAM)}&dst=${encodeURIComponent(dst)}`;
  const res = await fetch(u, { method: "POST" });
  if (!res.ok) throw new Error(`go2rtc publish HTTP ${res.status}`);
}
async function go2rtcStop() {
  try {
    await fetch(`${GO2RTC_API_URL}/api/streams?src=${encodeURIComponent(GO2RTC_STREAM)}&dst=`, { method: "POST" });
  } catch (_) {
    /* best effort */
  }
}

// Décrochage : prépare la session LiveKit côté token-service.
// Renvoie { tvToken, wsUrl, room, ingressId, joinUrl }.
async function establishCall() {
  // 1) S'assurer que la room existe.
  await callTokenService("POST", `/rooms/${ROOM_NAME}`);

  // 2) Créer l'ingress caméra (point d'entrée RTMP en attente d'un publisher).
  const ingress = await callTokenService("POST", `/rooms/${ROOM_NAME}/ingress`, {
    inputType: "rtmp",
    identity: CAMERA_IDENTITY,
  });
  if (!ingress || !ingress.publishUrl) throw new Error("ingress sans publishUrl");

  // 2b) DÉMARRER la publication go2rtc -> ingress (sinon la salle reste vide).
  await go2rtcPublish(ingress.publishUrl);

  // 3) Token TV en réception seule.
  const tv = await callTokenService("POST", "/token", {
    room: ROOM_NAME,
    identity: TV_IDENTITY,
    name: "TV Salon",
    canPublish: false,
  });

  if (!tv || !tv.token) throw new Error("token-service: token TV vide");

  // Lien que l'appelant ouvrira pour rejoindre l'appel (web client).
  // On demande un lien invité (token de publication pré-injecté) pour que
  // l'appelant rejoigne "par simple lien", sans saisir de nom (critère #6).
  let joinUrl = `${WEB_CLIENT_URL}/?room=${encodeURIComponent(ROOM_NAME)}`;
  try {
    const inv = await callTokenService(
      "GET",
      `/invite?name=${encodeURIComponent(state.from || "Invité")}&room=${encodeURIComponent(ROOM_NAME)}`
    );
    if (inv && inv.link) joinUrl = inv.link;
  } catch (e) {
    console.error(`[signaling] /invite indisponible, lien sans token: ${e.message}`);
  }

  return {
    tvToken: tv.token,
    wsUrl: tv.wsUrl,
    room: tv.room || ROOM_NAME,
    ingressId: ingress ? ingress.ingressId : null,
    joinUrl,
  };
}

// Nettoyage de fin d'appel : arrête la publication, supprime l'ingress, idle.
async function teardownCall(reason) {
  await go2rtcStop();
  const ingressId = state.ingressId;
  if (ingressId) {
    try {
      await callTokenService("DELETE", `/ingress/${ingressId}`);
    } catch (e) {
      console.error(`[signaling] échec suppression ingress ${ingressId}: ${e.message}`);
    }
  }
  console.log(`[signaling] appel terminé (${reason}) -> idle`);
  resetState();
}

// ── Transitions d'appel ───────────────────────────────────────────────────────
function startRinging(from) {
  const callId = randomUUID();
  resetState();
  state.status = "sonnerie";
  state.callId = callId;
  state.from = from;

  sendToTv({ type: "appel_entrant", callId, from });

  state.ringTimer = setTimeout(() => {
    if (state.status === "sonnerie" && state.callId === callId) {
      console.log(`[signaling] appel ${callId} manqué (timeout ${RING_TIMEOUT}ms)`);
      sendToTv({ type: "appel_manque", callId, from });
      resetState();
    }
  }, RING_TIMEOUT);
  // Ne pas bloquer la fermeture du process sur ce timer.
  if (state.ringTimer.unref) state.ringTimer.unref();

  return callId;
}

async function onDecrocher(callId) {
  if (state.status !== "sonnerie" || state.callId !== callId) {
    sendToTv({ type: "erreur", callId, message: "aucun appel en sonnerie pour ce callId" });
    return;
  }
  if (state.ringTimer) {
    clearTimeout(state.ringTimer);
    state.ringTimer = null;
  }

  try {
    const { tvToken, wsUrl, room, ingressId, joinUrl } = await establishCall();
    state.status = "en_appel";
    state.ingressId = ingressId;
    state.joinUrl = joinUrl;

    sendToTv({ type: "appel_etabli", callId, token: tvToken, wsUrl, room });
    console.log(`[signaling] appel ${callId} établi (room=${room})`);
  } catch (e) {
    state.joinError = e.message;
    console.error(`[signaling] échec établissement appel ${callId}: ${e.message}`);
    sendToTv({ type: "erreur", callId, message: `établissement impossible: ${e.message}` });
    // En cas d'échec, on tente de nettoyer puis on repasse idle.
    await teardownCall("echec_etablissement");
  }
}

async function onRaccrocher(callId) {
  if (state.callId !== callId) return;
  sendToTv({ type: "appel_termine", callId });
  await teardownCall("raccrocher");
}

// Refus explicite par la TV pendant la sonnerie (touche BACK sur l'overlay).
function onRefuser(callId) {
  if (state.status === "sonnerie" && state.callId === callId) {
    if (state.ringTimer) {
      clearTimeout(state.ringTimer);
      state.ringTimer = null;
    }
    console.log(`[signaling] appel ${callId} refusé par la TV -> idle`);
    resetState();
  }
}

// ── WebSocket (TV) ────────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => handleHttp(req, res));
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      ws.send(JSON.stringify({ type: "erreur", message: "JSON invalide" }));
      return;
    }

    switch (msg.type) {
      case "register":
        if (msg.role === "tv") {
          // Remplace proprement une TV précédente (reconnexion / 2e écran).
          if (tvSocket && tvSocket !== ws && tvSocket.readyState === 1) {
            try { tvSocket.close(4000, "remplacée"); } catch (_) {}
          }
          tvSocket = ws;
          ws._role = "tv";
          ws._device = msg.device || "tv";
          console.log(`[signaling] TV enregistrée (${ws._device})`);
          ws.send(JSON.stringify({ type: "registered", role: "tv", state: snapshot() }));
        }
        break;
      // Commandes d'appel honorées seulement depuis la TV active (anti-fantôme).
      case "decrocher":
        if (ws === tvSocket) await onDecrocher(msg.callId);
        break;
      case "raccrocher":
        if (ws === tvSocket) await onRaccrocher(msg.callId);
        break;
      case "refuser":
        if (ws === tvSocket) onRefuser(msg.callId);
        break;
      default:
        ws.send(JSON.stringify({ type: "erreur", message: `type inconnu: ${msg.type}` }));
    }
  });

  ws.on("close", () => {
    if (tvSocket === ws) {
      tvSocket = null;
      console.log("[signaling] TV déconnectée");
      // Anti-fuite : si la TV tombe hors idle, on libère l'ingress.
      if (state.status !== "idle") {
        console.log("[signaling] TV partie hors idle -> teardown");
        teardownCall("tv_deconnectee").catch(() => {});
      }
    }
  });

  ws.on("error", () => {});
});

// Heartbeat : détecte les TV silencieusement déconnectées (NAT/Wi-Fi).
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 15000);
if (heartbeat.unref) heartbeat.unref();

// ── HTTP ──────────────────────────────────────────────────────────────────────
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (_) {
        resolve(null); // signale un corps invalide
      }
    });
    req.on("error", () => resolve(null));
  });
}

async function handleHttp(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  // GET /healthz
  if (req.method === "GET" && path === "/healthz") {
    return json(res, 200, { ok: true, service: "signaling", status: state.status });
  }

  // GET /state
  if (req.method === "GET" && path === "/state") {
    return json(res, 200, snapshot());
  }

  // GET /tv -> "numéro d'appel" (code) du téléviseur + état + comment l'appeler.
  if (req.method === "GET" && path === "/tv") {
    return json(res, 200, {
      code: TV_CODE,
      name: TV_NAME,
      tvConnected: !!(tvSocket && tvSocket.readyState === 1),
      status: state.status,
      // Pour appeler ce téléviseur : POST /call {from}. Lien appelant prêt à l'emploi :
      callUrl: `${WEB_CLIENT_URL}/?call=${encodeURIComponent(TV_CODE)}`,
    });
  }

  // POST /call {from}  -> déclenche la sonnerie vers la TV
  if (req.method === "POST" && path === "/call") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "JSON invalide" });
    const from = body.from || "inconnu";

    if (!tvSocket || tvSocket.readyState !== 1) {
      return json(res, 503, { error: "TV non connectée" });
    }
    if (state.status !== "idle") {
      return json(res, 409, { error: "ligne occupée", status: state.status });
    }

    const callId = startRinging(from);
    return json(res, 201, { callId, status: "sonnerie", from });
  }

  // GET /call/:id/status
  const statusMatch = path.match(/^\/call\/([^/]+)\/status$/);
  if (req.method === "GET" && statusMatch) {
    const callId = decodeURIComponent(statusMatch[1]);
    if (state.callId !== callId) {
      return json(res, 404, { error: "callId inconnu ou appel terminé", status: "idle" });
    }
    if (state.joinError) {
      return json(res, 200, { callId, status: "echec", error: state.joinError });
    }
    if (state.status === "en_appel") {
      return json(res, 200, { callId, status: "etabli", joinUrl: state.joinUrl, room: ROOM_NAME });
    }
    return json(res, 200, { callId, status: state.status });
  }

  json(res, 404, { error: "not found" });
}

httpServer.listen(Number(PORT), () => {
  console.log(`[signaling] écoute :${PORT} — token-service ${TOKEN_SERVICE_URL}`);
});

// Permet l'arrêt propre en test / conteneur.
export { httpServer, state };
