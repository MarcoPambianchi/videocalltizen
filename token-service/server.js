// C6 — Service de jeton + admin LiveKit pour videocalltizen.
// Émet des JWT (interlocuteur / TV), des liens invités à usage unique, et pilote
// rooms + ingress (utilisé par le service de signalisation et les tests P1/P2).
import express from "express";
import {
  AccessToken,
  RoomServiceClient,
  IngressClient,
  IngressInput,
  IngressVideoOptions,
  IngressVideoEncodingOptions,
  VideoCodec,
  TrackSource,
} from "livekit-server-sdk";

const {
  LIVEKIT_API_KEY = "APIVisioDev",
  LIVEKIT_API_SECRET = "VkS3cret_dev_0123456789abcdef0123456789",
  LIVEKIT_API_URL = "http://livekit:7880",
  LIVEKIT_PUBLIC_WS_URL = "ws://localhost:7880",
  ROOM_NAME = "salon",
  CAMERA_IDENTITY = "camera-salon",
  WEB_CLIENT_URL = "http://localhost:9088",
  PORT = "9080",
} = process.env;

const roomSvc = new RoomServiceClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const ingressSvc = new IngressClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

const app = express();
app.use(express.json());

// CORS — le client web (9088) et l'app Tizen appellent /invite et /token depuis
// une autre origine (navigateur). Dev : permissif. Prod : restreindre l'origine.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "content-type");
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Helpers ─────────────────────────────────────────────────────────────────
async function makeToken({ room, identity, name, canPublish = true, ttl = "1h" }) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name, ttl });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt(); // v2: async
}

// Réécrit l'URL d'ingress retournée par LiveKit vers l'hôte interne 'ingress'
// (go2rtc publie depuis le réseau Docker, pas depuis l'extérieur).
function toInNetworkRtmp(info) {
  // info.url ressemble à rtmp://<host>:1935/x  ; info.streamKey est la clé.
  let path = "/x";
  try {
    const u = new URL(info.url.replace(/^rtmp:/, "http:"));
    path = u.pathname && u.pathname !== "/" ? u.pathname : "/x";
  } catch (_) {}
  let full = `rtmp://ingress:1935${path}`.replace(/\/$/, "");
  if (info.streamKey && !full.includes(info.streamKey)) full += `/${info.streamKey}`;
  return full;
}

// ── Santé ───────────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.json({ ok: true, service: "token-service" }));

// ── Jetons ──────────────────────────────────────────────────────────────────
// Interlocuteur (publie cam/micro + reçoit) ou TV (réception seule si canPublish=false).
app.post("/token", async (req, res) => {
  try {
    const {
      room = ROOM_NAME,
      identity,
      name = identity,
      canPublish = true,
      ttl = "1h",
    } = req.body || {};
    if (!identity) return res.status(400).json({ error: "identity requis" });
    const token = await makeToken({ room, identity, name, canPublish, ttl });
    res.json({ token, wsUrl: LIVEKIT_PUBLIC_WS_URL, room, identity });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Lien invité à usage unique (interlocuteur) : génère un token et un lien web client.
const usedInvites = new Set();
app.get("/invite", async (req, res) => {
  try {
    const room = req.query.room || ROOM_NAME;
    const name = req.query.name || "Invité";
    const identity = `guest-${name}-${Date.now()}`;
    const token = await makeToken({ room, identity, name, canPublish: true, ttl: "2h" });
    const link = `${WEB_CLIENT_URL}/?token=${encodeURIComponent(token)}&url=${encodeURIComponent(
      LIVEKIT_PUBLIC_WS_URL
    )}`;
    usedInvites.add(token); // marque comme émis (révocation usage unique gérée côté lien)
    res.json({ link, token, wsUrl: LIVEKIT_PUBLIC_WS_URL, room, identity });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Admin rooms ─────────────────────────────────────────────────────────────
app.post("/rooms/:room", async (req, res) => {
  try {
    await roomSvc.createRoom({ name: req.params.room });
    res.json({ ok: true, room: req.params.room });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/rooms/:room/participants", async (req, res) => {
  try {
    const parts = await roomSvc.listParticipants(req.params.room);
    res.json({
      room: req.params.room,
      participants: parts.map((p) => ({
        identity: p.identity,
        state: p.state,
        tracks: (p.tracks || []).map((t) => ({ type: t.type, source: t.source, muted: t.muted })),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Admin ingress ───────────────────────────────────────────────────────────
// Crée une session d'ingestion (RTMP par défaut, WHIP optionnel).
app.post("/rooms/:room/ingress", async (req, res) => {
  try {
    const {
      inputType = "rtmp",
      identity = CAMERA_IDENTITY,
      name = "Caméra Salon",
      bypassTranscoding = false,
    } = req.body || {};
    const input = inputType === "whip" ? IngressInput.WHIP_INPUT : IngressInput.RTMP_INPUT;
    // Vidéo en UNE SEULE couche EXPLICITE (pas de simulcast). L'ingress v1.5.0 ignore
    // les presets "1_LAYER" et crée quand même 2 couches : l'ajout du 2e bin GStreamer
    // échoue ("could not add bin") -> publication incomplète -> timeout 10s -> l'ingress
    // se termine et go2rtc reconnecte en boucle (~16s) = "En attente de la caméra". Une
    // liste `layers` à un seul élément force réellement une couche unique et stabilise.
    const video = new IngressVideoOptions({
      source: TrackSource.CAMERA,
      encodingOptions: {
        case: "options",
        value: new IngressVideoEncodingOptions({
          videoCodec: VideoCodec.H264_BASELINE,
          frameRate: 30,
          layers: [{ quality: 2 /* HIGH */, width: 1280, height: 720, bitrate: 3_000_000 }],
        }),
      },
    });
    const info = await ingressSvc.createIngress(input, {
      name,
      roomName: req.params.room,
      participantIdentity: identity,
      participantName: name,
      bypassTranscoding,
      video,
    });
    res.json({
      ingressId: info.ingressId,
      inputType,
      url: info.url,
      streamKey: info.streamKey,
      // RTMP : reconstruit l'URL interne. WHIP : endpoint LiveKit Ingress /w/<streamKey>
      // (à consommer par un publisher WHIP : ffmpeg>=7.1 muxer 'whip' ou gstreamer whipsink ;
      //  go2rtc ne sait PAS publier en WHIP — scheme http non supporté côté dst).
      publishUrl:
        inputType === "rtmp"
          ? toInNetworkRtmp(info)
          : `http://ingress:8085/w/${info.streamKey}`,
      room: req.params.room,
      identity,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/ingress/:id", async (req, res) => {
  try {
    await ingressSvc.deleteIngress(req.params.id);
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(Number(PORT), () => {
  console.log(`[token-service] écoute :${PORT} — LiveKit ${LIVEKIT_API_URL}`);
});
