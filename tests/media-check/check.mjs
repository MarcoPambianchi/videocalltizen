// P2 — Preuve média de bout en bout : un client headless rejoint la salle,
// s'abonne au participant caméra, et compte les frames vidéo RÉELLEMENT reçues
// via le SFU. Exit 0 si des frames arrivent. À exécuter DANS le réseau 'visio'.
import { Room, RoomEvent, VideoStream } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";

const URL = process.env.LIVEKIT_WS_URL || "ws://livekit:7880";
const KEY = process.env.LIVEKIT_API_KEY || "APIVisioDev";
const SECRET = process.env.LIVEKIT_API_SECRET || "VkS3cret_dev_0123456789abcdef0123456789";
const ROOM = process.env.ROOM_NAME || "salon";
const CAM = process.env.CAMERA_IDENTITY || "camera-salon";
const TIMEOUT = Number(process.env.TIMEOUT_MS || 45000);
const NEED = Number(process.env.NEED_FRAMES || 10);

const at = new AccessToken(KEY, SECRET, { identity: "media-check", name: "media-check" });
at.addGrant({ roomJoin: true, room: ROOM, canSubscribe: true, canPublish: false });
const token = await at.toJwt();

const room = new Room();
let videoFrames = 0;
let gotVideoTrack = false;

room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
  const idn = participant?.identity;
  console.log(`[sub] ${idn} kind=${track.kind} source=${pub?.source}`);
  if (idn !== CAM) return;
  // Tente un flux vidéo ; sur une piste audio, l'itération ne produira simplement rien.
  try {
    const stream = new VideoStream(track);
    gotVideoTrack = true;
    (async () => {
      for await (const _frame of stream) {
        videoFrames++;
      }
    })().catch(() => {});
  } catch (_) {
    /* piste non vidéo */
  }
});

console.log(`[connect] ${URL} room=${ROOM} attend '${CAM}'`);
await room.connect(URL, token, { autoSubscribe: true, dynacast: false });
console.log("[connected]");

const deadline = Date.now() + TIMEOUT;
while (Date.now() < deadline && videoFrames < NEED) {
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`  frames=${videoFrames} gotVideoTrack=${gotVideoTrack}`);
}
await room.disconnect().catch(() => {});

if (videoFrames >= NEED) {
  console.log(`✅ P2 PASS — ${videoFrames} frames vidéo reçues de '${CAM}' via le SFU`);
  process.exit(0);
}
console.log(`❌ P2 FAIL — seulement ${videoFrames} frames (gotVideoTrack=${gotVideoTrack})`);
process.exit(1);
