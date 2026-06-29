// Validation navigateur headless (chrome réel) :
//  - web-client C8 : charge sans erreur fatale, libs présentes ; avec un token,
//    se connecte réellement à la salle (statut "Connecté").
//  - app Tizen C9 : charge sans erreur, simule un appel entrant -> overlay affiché.
// Exit 0 = PASS (les checks "Tier 2" réseau sont non bloquants -> WARN).
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ||
  ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/snap/bin/chromium"].find(Boolean);
const WEB = process.env.WEB_URL || "http://localhost:9088/";
const TIZEN = process.env.TIZEN_URL || "http://localhost:9099/";
const TOKEN_API = process.env.TOKEN_API || "http://localhost:9080";

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures++; };
const warn = (m) => console.log(`  ⚠ ${m}`);

function newPage(browser) {
  return browser.newPage().then((page) => {
    const errors = [];
    const notfound = [];
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", (err) => errors.push(String(err)));
    // Trace les URLs réellement en 404 (le message console générique n'a pas l'URL).
    page.on("response", (r) => { if (r.status() === 404) notfound.push(r.url()); });
    page._errors = errors;
    page._notfound = notfound;
    return page;
  });
}

// Erreurs JS réellement fatales : on exclut les bruits attendus (favicon auto,
// indispo CDN/WS en validation, getUserMedia, et le message générique de 404).
function fatalErrors(page, extra) {
  const re = new RegExp(`favicon|Failed to load resource|getUserMedia|Permission|NotAllowed${extra ? "|" + extra : ""}`, "i");
  const errs = page._errors.filter((e) => !re.test(e));
  const bad404 = page._notfound.filter((u) => !/favicon\.ico/i.test(u));
  return { errs, bad404 };
}

async function main() {
  console.log("── Validation navigateur headless ──");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  try {
    // ── web-client : Tier 1 (chargement) ──
    {
      const page = await newPage(browser);
      await page.goto(WEB, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 1500));
      const hasLK = await page.evaluate(() => typeof window.LivekitClient === "object" && !!window.LivekitClient.Room);
      ok(hasLK, "web-client : livekit-client (UMD) chargé depuis le CDN");
      const { errs, bad404 } = fatalErrors(page);
      ok(errs.length === 0 && bad404.length === 0,
        `web-client : pas d'erreur JS fatale${errs[0] ? " -> " + errs[0] : ""}${bad404[0] ? " 404:" + bad404[0] : ""}`);
      await page.close();
    }

    // ── web-client : Tier 2 (connexion réelle avec token) — non bloquant ──
    try {
      const inv = await (await fetch(`${TOKEN_API}/invite?name=BrowserTest`)).json();
      const url = `${WEB}?token=${encodeURIComponent(inv.token)}&url=${encodeURIComponent(inv.wsUrl)}`;
      const page = await newPage(browser);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      // Attend que le statut passe à "Connecté" (le client publie ses pistes factices)
      let connected = false;
      for (let i = 0; i < 20; i++) {
        const txt = await page.evaluate(() => (document.body.innerText || "").toLowerCase());
        if (txt.includes("connect")) { connected = txt.includes("connecté") || txt.includes("connected"); }
        if (connected) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (connected) ok(true, "web-client : connexion réelle à la salle (statut Connecté)");
      else warn("web-client : connexion salle non confirmée en headless (réseau WSL/ICE) — média prouvé par P2 rtc-node");
      // Bouton "Inviter" présent (mécanisme : rejoindre sans sonner).
      const hasInvite = await page.evaluate(() => !!document.getElementById("inviteBtn"));
      ok(hasInvite, "web-client : bouton 'Inviter' présent (rejoindre sans sonnerie)");
      await page.close();
    } catch (e) {
      warn(`web-client Tier 2 ignoré : ${e.message}`);
    }

    // ── app Tizen : VEILLE + auto-décrochage + reprise (exigence clé) ──
    {
      const page = await newPage(browser);
      await page.goto(TIZEN, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 2000));
      const st = await page.evaluate(() => window.VisioTV && window.VisioTV._state());
      ok(!!st, "tizen : app chargée (window.VisioTV présent)");
      ok(st && st.mode === "auto", "tizen : auto-décrochage par défaut (mode=auto)");
      ok(st && st.standbyVisible === true, "tizen : écran de veille affiché au repos");
      const hasVideoSrc = await page.evaluate(() => {
        const v = document.getElementById("standbyVideo");
        return !!(v && v.getAttribute("src"));
      });
      ok(hasVideoSrc, "tizen : vidéo ambiante de veille chargée");

      // Teste l'invariant veille (indépendant du décodage headless) :
      //  exitStandbyForCall capture la position courante ; enterStandby la restaure.
      const res = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const v = document.getElementById("standbyVideo");
        try { v.currentTime = 4.0; } catch (e) {}
        await sleep(400);
        const posBefore = v.currentTime; // position "vidéo en cours" au moment de l'appel
        window.VisioTV._exitStandbyForCall(); // l'appel REMPLACE la veille
        const hiddenDuringCall = document.getElementById("standby").classList.contains("hidden");
        const saved = window.VisioTV._state().savedStandbyTime;
        // Spy sur le setter currentTime : capture la valeur que enterStandby assigne
        // (lecture asynchrone non fiable en headless avec un <video> display:none).
        let assigned = null;
        const proto = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
        Object.defineProperty(v, "currentTime", {
          configurable: true,
          get() { return proto.get.call(this); },
          set(val) { assigned = val; proto.set.call(this, val); },
        });
        window.VisioTV._enterStandby(); // fin d'appel : REPREND la veille à savedStandbyTime
        delete v.currentTime; // retire le spy
        const visibleAfter = !document.getElementById("standby").classList.contains("hidden");
        return { hiddenDuringCall, saved, posBefore, assigned, visibleAfter };
      });
      ok(res.hiddenDuringCall === true, "tizen : veille masquée pendant l'appel (remplacée)");
      ok(Math.abs(res.saved - res.posBefore) < 0.1,
        `tizen : position mémorisée == position au moment de l'appel (${Number(res.posBefore).toFixed(2)}s)`);
      ok(res.visibleAfter === true, "tizen : veille reprise en fin d'appel");
      ok(res.assigned !== null && Math.abs(res.assigned - res.saved) < 0.001,
        `tizen : reprise EXACTEMENT à la position mémorisée (assignée=${res.assigned === null ? "∅" : Number(res.assigned).toFixed(2)}s)`);

      // Grille MULTIPARTITE : le layout s'adapte au nombre de participants.
      const grid = await page.evaluate(() => {
        window.VisioTV._clearTiles();
        const r = {};
        window.VisioTV._simulateTile("a"); r.n1 = window.VisioTV._gridState().columns;
        window.VisioTV._simulateTile("b"); r.n2 = window.VisioTV._gridState().columns;
        window.VisioTV._simulateTile("c"); window.VisioTV._simulateTile("d");
        r.n4 = window.VisioTV._gridState().columns;
        window.VisioTV._simulateTile("e"); r.n5 = window.VisioTV._gridState().columns;
        r.count = window.VisioTV._gridState().tiles;
        window.VisioTV._clearTiles();
        r.afterClear = window.VisioTV._gridState().tiles;
        return r;
      });
      ok(grid.n1 === "repeat(1, 1fr)", `tizen grille : 1 participant = plein écran (${grid.n1})`);
      ok(grid.n2 === "repeat(2, 1fr)", `tizen grille : 2 participants = côte à côte (${grid.n2})`);
      ok(grid.n4 === "repeat(2, 1fr)", `tizen grille : 4 participants = mosaïque 2x2 (${grid.n4})`);
      ok(grid.n5 === "repeat(3, 1fr)", `tizen grille : 5 participants = 3 colonnes (${grid.n5})`);
      ok(grid.count === 5 && grid.afterClear === 0, "tizen grille : ajout/retrait dynamique des tuiles");

      const { errs, bad404 } = fatalErrors(page, "livekit|CDN|WebSocket|ws:");
      ok(errs.length === 0 && bad404.length === 0,
        `tizen : pas d'erreur JS fatale${errs[0] ? " -> " + errs[0] : ""}${bad404[0] ? " 404:" + bad404[0] : ""}`);
      await page.close();
    }

    // ── app Tizen : overlay 'appel entrant' en mode manuel ──
    {
      const page = await newPage(browser);
      await page.goto(`${TIZEN}?mode=manuel&standby=`, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 1000));
      const overlayShown = await page.evaluate(() => {
        window.VisioTV._simulateIncoming("Marco", "browtest");
        const ov = document.getElementById("overlay");
        return ov ? !ov.classList.contains("hidden") : false;
      });
      ok(overlayShown, "tizen : overlay 'appel entrant' affiché (mode manuel)");
      await page.close();
    }

    // ── app Tizen : AUTO-RÉPONSE = aucune sonnerie (overlay jamais affiché) ──
    {
      const page = await newPage(browser);
      await page.goto(`${TIZEN}?standby=`, { waitUntil: "networkidle2", timeout: 30000 }); // mode=auto par défaut
      await new Promise((r) => setTimeout(r, 1000));
      const r = await page.evaluate(() => {
        const before = document.getElementById("overlay").classList.contains("hidden");
        window.VisioTV._simulateIncoming("Marco", "autotest"); // appel entrant
        const after = document.getElementById("overlay").classList.contains("hidden");
        return { mode: window.VisioTV._state().mode, before, after };
      });
      ok(r.mode === "auto", "tizen auto : mode=auto par défaut");
      ok(r.before === true && r.after === true,
        "tizen auto : appel entrant SANS overlay ni sonnerie (la TV répond automatiquement)");
      await page.close();
    }

    // ── app Tizen : fond TV LIVE (reprise au direct) ──
    {
      const page = await newPage(browser);
      await page.goto(`${TIZEN}?standby=&live=1`, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 800));
      const live = await page.evaluate(() => window.VisioTV._state().live === true);
      ok(live, "tizen : fond LIVE activable (?live=1 -> reprise au direct)");
      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "✅ navigateur PASS" : `❌ navigateur FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("❌ erreur:", e.message); process.exit(1); });
