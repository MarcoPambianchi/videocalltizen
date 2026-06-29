// Test d'intégration C7 — cycle d'appel complet contre les conteneurs réels
// (signaling + token-service + livekit + ingress). Node >= 21 (WebSocket + fetch natifs).
// Exit 0 = PASS.
const SIG_HTTP = process.env.SIG_HTTP || "http://localhost:9090";
const SIG_WS = process.env.SIG_WS || "ws://localhost:9090";

let failures = 0;
const ok = (c, m) => { if (c) console.log(`  ✓ ${m}`); else { console.log(`  ✗ ${m}`); failures++; } };

const events = [];
async function waitFor(pred, ms = 15000, what = "événement") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout en attendant ${what}`);
}

async function main() {
  console.log("── Test d'intégration signaling (C7) ──");

  // 1. La TV se connecte et s'enregistre
  const tv = new WebSocket(SIG_WS);
  tv.addEventListener("message", (e) => {
    try { events.push(JSON.parse(e.data)); } catch (_) {}
  });
  await new Promise((res, rej) => {
    tv.addEventListener("open", res, { once: true });
    tv.addEventListener("error", () => rej(new Error("WS error")), { once: true });
  });
  tv.send(JSON.stringify({ type: "register", role: "tv", device: "tv-salon" }));
  await waitFor((x) => x.type === "registered", 5000, "registered");
  ok(true, "TV enregistrée");

  // 2. Appelant déclenche un appel
  const call = await (await fetch(`${SIG_HTTP}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "Marco" }),
  })).json();
  const callId = call.callId;
  ok(!!callId && call.status === "sonnerie", `POST /call -> sonnerie (callId=${callId})`);

  // 3. La TV reçoit l'appel entrant
  const inc = await waitFor((x) => x.type === "appel_entrant" && x.callId === callId, 5000, "appel_entrant");
  ok(inc.from === "Marco", "appel_entrant reçu par la TV (from=Marco)");

  // 4. La TV décroche
  tv.send(JSON.stringify({ type: "decrocher", callId }));

  // 5. Appel établi avec token réel
  const est = await waitFor((x) => x.type === "appel_etabli" && x.callId === callId, 20000, "appel_etabli");
  ok(!!est.token && est.token.split(".").length === 3, "appel_etabli avec JWT TV valide");
  ok(!!est.wsUrl && !!est.room, `appel_etabli wsUrl+room (room=${est.room})`);

  // 5b. La caméra doit RÉELLEMENT publier dans la salle (sinon la TV rejoint
  //     une salle vide). C'est la preuve que le décrochage a déclenché go2rtc->ingress.
  const TOKEN_API = process.env.TOKEN_API || "http://localhost:9080";
  let camOk = false;
  for (let i = 0; i < 30; i++) {
    try {
      const parts = await (await fetch(`${TOKEN_API}/rooms/salon/participants`)).json();
      const cam = (parts.participants || []).find((p) => p.identity === "camera-salon");
      if (cam && (cam.tracks || []).length > 0) { camOk = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok(camOk, "caméra publie réellement dans la salle (publication go2rtc->ingress déclenchée)");

  // 6. Statut côté appelant : établi + lien invité (avec token)
  const st = await (await fetch(`${SIG_HTTP}/call/${callId}/status`)).json();
  ok(st.status === "etabli", "GET /call/:id/status -> etabli");
  ok(!!st.joinUrl && st.joinUrl.includes("token="), "joinUrl appelant contient un token");

  // 7. La TV raccroche -> teardown
  tv.send(JSON.stringify({ type: "raccrocher", callId }));
  await waitFor((x) => x.type === "appel_termine" && x.callId === callId, 5000, "appel_termine");
  ok(true, "appel_termine reçu (raccrochage)");

  // 8. Retour à idle (le teardown fait go2rtcStop + DELETE ingress : on poll)
  let idle = false;
  for (let i = 0; i < 50; i++) {
    const state = await (await fetch(`${SIG_HTTP}/state`)).json();
    if (state.status === "idle") { idle = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(idle, "état revenu à idle après teardown");

  tv.close();
  console.log(failures === 0 ? "✅ signaling PASS" : `❌ signaling FAIL (${failures} échecs)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("❌ erreur:", e.message); process.exit(1); });
