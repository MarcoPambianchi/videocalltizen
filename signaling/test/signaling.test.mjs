// Test d'intégration C7 — SANS token-service réel.
// On lance un mini token-service mock (HTTP) qui répond aux 3 endpoints utilisés
// au décrochage, on pointe TOKEN_SERVICE_URL dessus, on démarre server.js dans un
// process enfant, puis on simule une TV (client ws) + un POST /call et on vérifie
// la séquence : appel_entrant -> decrocher -> appel_etabli (token non vide).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(__dirname, "..", "server.js");

const SIGNALING_PORT = 19090; // hors liste des ports réservés
const MOCK_TOKEN_PORT = 19080;

let failed = false;
function assert(cond, label) {
  if (cond) {
    console.log(`  ok   - ${label}`);
  } else {
    failed = true;
    console.error(`  FAIL - ${label}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch (_) {}
    await sleep(100);
  }
  return false;
}

// ── Mock token-service ────────────────────────────────────────────────────────
const mockCalls = [];
const mockToken = createServer((req, res) => {
  mockCalls.push(`${req.method} ${req.url}`);
  const reply = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  // POST /rooms/salon
  if (req.method === "POST" && /^\/rooms\/[^/]+$/.test(req.url)) {
    return reply(200, { ok: true, room: "salon" });
  }
  // POST /rooms/salon/ingress
  if (req.method === "POST" && /^\/rooms\/[^/]+\/ingress$/.test(req.url)) {
    return reply(200, {
      ingressId: "ing_mock_123",
      inputType: "rtmp",
      url: "rtmp://ingress:1935/x",
      streamKey: "key_mock",
      publishUrl: "rtmp://ingress:1935/x/key_mock",
      room: "salon",
      identity: "camera-salon",
    });
  }
  // POST /token
  if (req.method === "POST" && req.url === "/token") {
    return reply(200, {
      token: "MOCK.JWT.TOKEN",
      wsUrl: "ws://localhost:7880",
      room: "salon",
      identity: "tv-salon",
    });
  }
  // DELETE /ingress/:id
  if (req.method === "DELETE" && /^\/ingress\/[^/]+$/.test(req.url)) {
    return reply(200, { ok: true, deleted: "ing_mock_123" });
  }
  reply(404, { error: "mock: not found" });
});

// ── Promesse utilitaire : attendre un message WS d'un type donné ─────────────
function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`timeout en attente du message '${type}'`));
    }, timeoutMs);
    function onMsg(raw) {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }
      if (m.type === type) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(m);
      }
    }
    ws.on("message", onMsg);
  });
}

let child;
async function cleanup() {
  try {
    if (child && !child.killed) child.kill("SIGKILL");
  } catch (_) {}
  await new Promise((r) => mockToken.close(r));
}

async function main() {
  // 1) Démarrer le mock token-service.
  await new Promise((r) => mockToken.listen(MOCK_TOKEN_PORT, r));

  // 2) Démarrer server.js pointant sur le mock.
  child = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(SIGNALING_PORT),
      TOKEN_SERVICE_URL: `http://127.0.0.1:${MOCK_TOKEN_PORT}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const healthy = await waitForHealth(SIGNALING_PORT);
  assert(healthy, "le service de signalisation répond sur /healthz");
  if (!healthy) return;

  // 3) Simuler la TV : ouvrir la WS et s'enregistrer.
  const tv = new WebSocket(`ws://127.0.0.1:${SIGNALING_PORT}`);
  await new Promise((res, rej) => {
    tv.on("open", res);
    tv.on("error", rej);
  });
  const registered = waitForMessage(tv, "registered");
  tv.send(JSON.stringify({ type: "register", role: "tv", device: "tv-salon" }));
  await registered;
  assert(true, "la TV s'enregistre et reçoit 'registered'");

  // 4) Armer l'attente de l'appel entrant AVANT le POST /call.
  const incoming = waitForMessage(tv, "appel_entrant");

  // 5) L'appelant déclenche l'appel.
  const callRes = await fetch(`http://127.0.0.1:${SIGNALING_PORT}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "alice" }),
  });
  const callBody = await callRes.json();
  assert(callRes.status === 201, "POST /call renvoie 201");
  assert(typeof callBody.callId === "string" && callBody.callId.length > 0, "POST /call renvoie un callId");

  // 6) La TV reçoit 'appel_entrant' avec le bon callId et from.
  const inc = await incoming;
  assert(inc.callId === callBody.callId, "appel_entrant porte le même callId");
  assert(inc.from === "alice", "appel_entrant porte from='alice'");

  // 7) La TV décroche -> attend 'appel_etabli'.
  const established = waitForMessage(tv, "appel_etabli");
  tv.send(JSON.stringify({ type: "decrocher", callId: callBody.callId }));
  const est = await established;
  assert(est.callId === callBody.callId, "appel_etabli porte le même callId");
  assert(typeof est.token === "string" && est.token.length > 0, "appel_etabli contient un token non vide");
  assert(est.room === "salon", "appel_etabli porte room='salon'");
  assert(typeof est.wsUrl === "string" && est.wsUrl.length > 0, "appel_etabli contient un wsUrl");

  // 8) Vérifier la séquence d'appels au token-service (rooms, ingress, token).
  assert(mockCalls.some((c) => c.startsWith("POST /rooms/salon")), "token-service: POST /rooms/salon appelé");
  assert(
    mockCalls.includes("POST /rooms/salon/ingress"),
    "token-service: POST /rooms/salon/ingress appelé"
  );
  assert(mockCalls.includes("POST /token"), "token-service: POST /token appelé");

  // 9) GET /call/:id/status renvoie 'etabli' avec joinUrl.
  const statusRes = await fetch(
    `http://127.0.0.1:${SIGNALING_PORT}/call/${encodeURIComponent(callBody.callId)}/status`
  );
  const statusBody = await statusRes.json();
  assert(statusBody.status === "etabli", "GET /call/:id/status renvoie 'etabli'");
  assert(typeof statusBody.joinUrl === "string" && statusBody.joinUrl.length > 0, "status contient joinUrl");

  // 10) Raccrochage -> ingress supprimé, retour idle.
  const ended = waitForMessage(tv, "appel_termine");
  tv.send(JSON.stringify({ type: "raccrocher", callId: callBody.callId }));
  await ended;
  await sleep(200); // laisser le DELETE ingress se faire
  assert(mockCalls.some((c) => c.startsWith("DELETE /ingress/")), "token-service: DELETE ingress appelé au raccrochage");

  const stateRes = await fetch(`http://127.0.0.1:${SIGNALING_PORT}/state`);
  const stateBody = await stateRes.json();
  assert(stateBody.status === "idle", "l'état revient à 'idle' après raccrochage");

  tv.close();
}

main()
  .catch((e) => {
    failed = true;
    console.error(`Erreur de test: ${e.stack || e}`);
  })
  .finally(async () => {
    await cleanup();
    if (failed) {
      console.error("\nRÉSULTAT: ÉCHEC");
      process.exit(1);
    }
    console.log("\nRÉSULTAT: SUCCÈS");
    process.exit(0);
  });
