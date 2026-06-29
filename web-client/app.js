// C8 — Client web interlocuteur (vanilla JS, sans framework).
// Lit token & url depuis la query string ; sinon affiche un formulaire qui appelle
// le token-service (C6) pour obtenir un lien. Connecte la Room LiveKit, publie
// caméra+micro locaux et affiche le participant distant 'camera-salon'.

(() => {
  "use strict";

  // Référence globale du client UMD chargé depuis le CDN.
  const LK = window.LivekitClient;
  if (!LK) {
    alert("Échec du chargement de livekit-client (CDN indisponible).");
    return;
  }
  const { Room, RoomEvent, Track, ConnectionQuality, createLocalTracks } = LK;

  // ── Configuration ───────────────────────────────────────────────────────────
  // URL du token-service (C6) côté hôte. Surchargée via le query param ?api=.
  const _qs = new URLSearchParams(location.search);
  const TOKEN_SERVICE = _qs.get("api") || "http://localhost:9080";
  // Identité de la caméra distante à mettre en grand (cf. conventions du projet).
  const CAMERA_IDENTITY = "camera-salon";
  // Relais TURN optionnel (accès distant derrière NAT/Tailscale) :
  //   ?turn=turn:host:3478&turnUser=...&turnPass=...
  const TURN_URL = _qs.get("turn");
  const TURN_USER = _qs.get("turnUser") || "";
  const TURN_PASS = _qs.get("turnPass") || "";
  function buildRtcConfig() {
    if (!TURN_URL) return undefined;
    // 'relay' force le passage par le TURN (le chemin direct vers l'IP interne du
    // SFU n'est pas joignable depuis l'extérieur).
    return {
      iceServers: [{ urls: TURN_URL, username: TURN_USER, credential: TURN_PASS }],
      iceTransportPolicy: "relay",
    };
  }

  // ── Références DOM ──────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"),
    quality: $("quality"),
    roomName: $("roomName"),
    join: $("join"),
    call: $("call"),
    nameInput: $("nameInput"),
    getInviteBtn: $("getInviteBtn"),
    linkInput: $("linkInput"),
    useLinkBtn: $("useLinkBtn"),
    joinError: $("joinError"),
    remoteWrap: $("remoteWrap"),
    remotePlaceholder: $("remotePlaceholder"),
    localWrap: $("localWrap"),
    micBtn: $("micBtn"),
    camBtn: $("camBtn"),
    inviteBtn: $("inviteBtn"),
    hangupBtn: $("hangupBtn"),
  };

  // État courant.
  let room = null;
  let localTracks = [];

  // ── Utilitaires d'affichage ─────────────────────────────────────────────────
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = "status status--" + cls;
  }

  function setQuality(q) {
    // Mappe ConnectionQuality -> couleur/texte.
    let color = "#888", label = "inconnue";
    if (q === ConnectionQuality.Excellent) { color = "#37d67a"; label = "excellente"; }
    else if (q === ConnectionQuality.Good) { color = "#f5c451"; label = "correcte"; }
    else if (q === ConnectionQuality.Poor) { color = "#e84a4a"; label = "faible"; }
    els.quality.style.color = color;
    els.quality.title = "Qualité : " + label;
  }

  function showJoinError(msg) {
    els.joinError.textContent = msg;
    show(els.joinError);
  }

  // ── Récupération du token/url ────────────────────────────────────────────────
  // Extrait token & url depuis une chaîne : soit une URL complète (?token=&url=),
  // soit un token brut. Retourne {token, url} ou null.
  function parseCredentials(raw) {
    if (!raw) return null;
    const value = raw.trim();
    // Tentative : URL complète contenant les query params.
    try {
      const u = new URL(value);
      const token = u.searchParams.get("token");
      const url = u.searchParams.get("url");
      if (token) return { token, url: url || null };
    } catch (_) {
      // pas une URL → on suppose un token JWT brut.
    }
    // Heuristique JWT : trois segments séparés par des points.
    if (value.split(".").length === 3) return { token: value, url: null };
    return null;
  }

  // Appelle le token-service pour générer une invitation à partir d'un nom.
  async function fetchInvite(name) {
    const u = new URL(TOKEN_SERVICE + "/invite");
    if (name) u.searchParams.set("name", name);
    const res = await fetch(u.toString(), { method: "GET" });
    if (!res.ok) throw new Error("token-service a répondu " + res.status);
    return res.json(); // {link, token, wsUrl, room, identity}
  }

  // ── Gestion des pistes (rendu vidéo/audio) ──────────────────────────────────
  // Attache une piste distante. La caméra-salon va dans la grande zone ; le reste
  // (audio) est attaché de façon audible sur les haut-parleurs.
  function attachRemoteTrack(track, participant) {
    const el = track.attach(); // <video> ou <audio>
    el.dataset.sid = track.sid;
    const pid = participant ? participant.identity : "?";
    el.dataset.pid = pid;
    if (track.kind === Track.Kind.Video) {
      // Évite les doublons : retire toute vidéo RÉSIDUELLE du même participant
      // (re-souscription / participant recréé) -> pas de "split d'écran" fantôme.
      els.remoteWrap.querySelectorAll('video[data-pid="' + pid + '"]').forEach((v) => v.remove());
      hide(els.remotePlaceholder);
      el.classList.add("video");
      el.setAttribute("playsinline", "");
      els.remoteWrap.appendChild(el);
    } else if (track.kind === Track.Kind.Audio) {
      // Audio distant : on l'ajoute au DOM pour qu'il soit lu sur les HP.
      el.classList.add("hidden-audio");
      els.remoteWrap.appendChild(el);
    }
  }

  function detachTrack(track) {
    // detach() retourne les éléments média créés par attach().
    track.detach().forEach((el) => el.remove());
  }

  // Retire tous les éléments média (vidéo/audio) d'un participant qui quitte —
  // sinon une vidéo "fantôme" reste et la grille se divise en 2.
  function removeParticipantMedia(pid) {
    els.remoteWrap.querySelectorAll('[data-pid="' + pid + '"]').forEach((e) => e.remove());
  }

  // Si plus aucune vidéo distante n'est affichée, on remontre le placeholder.
  function refreshRemotePlaceholder() {
    const hasVideo = els.remoteWrap.querySelector("video");
    if (hasVideo) hide(els.remotePlaceholder);
    else show(els.remotePlaceholder);
  }

  // ── Connexion à la salle ─────────────────────────────────────────────────────
  async function connect(token, wsUrl) {
    setStatus("Connexion…", "connecting");

    room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });

    // — Événements salle —
    room
      .on(RoomEvent.Connected, onConnected)
      .on(RoomEvent.Disconnected, onDisconnected)
      .on(RoomEvent.Reconnecting, () => setStatus("Reconnexion…", "connecting"))
      .on(RoomEvent.Reconnected, () => setStatus("Connecté", "connected"))
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        attachRemoteTrack(track, participant);
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        detachTrack(track);
        refreshRemotePlaceholder();
      })
      .on(RoomEvent.ParticipantConnected, (p) => {
        console.log("[visio] participant connecté :", p.identity);
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        console.log("[visio] participant déconnecté :", p.identity);
        removeParticipantMedia(p.identity);  // nettoie les éléments fantômes
        refreshRemotePlaceholder();
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        // On suit la qualité du participant local.
        if (!participant || participant.isLocal) setQuality(quality);
      });

    try {
      await room.connect(wsUrl, token, { rtcConfig: buildRtcConfig() });
    } catch (e) {
      setStatus("Échec connexion", "error");
      throw e;
    }
  }

  async function onConnected() {
    setStatus("Connecté", "connected");
    els.roomName.textContent = room.name ? "Salle : " + room.name : "";
    hide(els.join);
    show(els.call);

    // Publie caméra + micro locaux.
    try {
      localTracks = await createLocalTracks({ audio: true, video: true });
      for (const t of localTracks) {
        await room.localParticipant.publishTrack(t);
        if (t.kind === Track.Kind.Video) {
          const v = t.attach();
          v.classList.add("video");
          v.setAttribute("playsinline", "");
          v.muted = true; // évite tout larsen sur la preview locale
          els.localWrap.appendChild(v);
        }
      }
    } catch (e) {
      console.warn("[visio] impossible de publier cam/micro :", e);
      showOverlayWarning("Caméra/micro indisponibles — vous êtes en réception seule.");
    }

    // Affiche d'éventuelles pistes déjà présentes (participant distant déjà là).
    refreshRemotePlaceholder();
  }

  function onDisconnected() {
    setStatus("Déconnecté", "idle");
    cleanup();
    // Retour à l'écran d'accueil pour pouvoir relancer.
    show(els.join);
    hide(els.call);
  }

  function showOverlayWarning(msg, ms) {
    // Avertissement non bloquant inséré dans la zone distante.
    const warn = document.createElement("div");
    warn.className = "warn";
    warn.textContent = msg;
    warn.style.userSelect = "text"; // permet de sélectionner/copier (ex. lien d'invitation)
    els.remoteWrap.appendChild(warn);
    setTimeout(() => warn.remove(), ms || 6000);
  }

  // Génère un lien d'invitation à partager : la personne rejoint la salle SANS
  // faire sonner la TV (politique décidée : seul le 1er appel sonne).
  async function inviteOther() {
    try {
      const inv = await fetchInvite("Invité");
      let copied = false;
      try { await navigator.clipboard.writeText(inv.link); copied = true; } catch (_) {}
      showOverlayWarning(
        (copied ? "Lien copié — partagez-le (rejoint sans sonnerie) : " : "Lien (rejoint sans sonnerie) : ") + inv.link,
        15000
      );
    } catch (e) {
      showOverlayWarning("Échec de génération du lien : " + (e.message || e));
    }
  }

  // ── Contrôles ────────────────────────────────────────────────────────────────
  async function toggleMic() {
    if (!room) return;
    const enabled = room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(!enabled);
    els.micBtn.classList.toggle("off", enabled); // si était activé → maintenant coupé
    els.micBtn.textContent = enabled ? "🔇 Micro" : "🎤 Micro";
  }

  async function toggleCam() {
    if (!room) return;
    const enabled = room.localParticipant.isCameraEnabled;
    await room.localParticipant.setCameraEnabled(!enabled);
    els.camBtn.classList.toggle("off", enabled);
    els.camBtn.textContent = enabled ? "🚫 Caméra" : "📷 Caméra";
  }

  async function hangup() {
    if (room) await room.disconnect();
    else onDisconnected();
  }

  function cleanup() {
    // Stoppe et libère les pistes locales + vide les zones vidéo.
    for (const t of localTracks) {
      try { t.stop(); } catch (_) {}
    }
    localTracks = [];
    els.localWrap.innerHTML = "";
    // Retire les vidéos/audios distants mais conserve le placeholder.
    [...els.remoteWrap.querySelectorAll("video,audio,.warn")].forEach((el) => el.remove());
    show(els.remotePlaceholder);
    setQuality(null);
    if (room) {
      room.removeAllListeners();
      room = null;
    }
  }

  // ── Flux de démarrage ────────────────────────────────────────────────────────
  async function start(creds) {
    // Si l'URL ws manque (token brut sans url), on prend la valeur publique par défaut.
    const wsUrl = creds.url || "ws://localhost:7880";
    try {
      await connect(creds.token, wsUrl);
    } catch (e) {
      console.error("[visio] connexion échouée :", e);
      show(els.join);
      hide(els.call);
      showJoinError("Connexion impossible : " + (e.message || e));
    }
  }

  function bindControls() {
    els.micBtn.addEventListener("click", toggleMic);
    els.camBtn.addEventListener("click", toggleCam);
    els.inviteBtn.addEventListener("click", inviteOther);
    els.hangupBtn.addEventListener("click", hangup);

    els.getInviteBtn.addEventListener("click", async () => {
      hide(els.joinError);
      const name = els.nameInput.value.trim() || "Invité";
      els.getInviteBtn.disabled = true;
      try {
        const inv = await fetchInvite(name);
        // Met à jour l'URL pour que le lien soit partageable/rechargeable.
        const shareUrl = new URL(location.href);
        shareUrl.searchParams.set("token", inv.token);
        shareUrl.searchParams.set("url", inv.wsUrl);
        history.replaceState(null, "", shareUrl.toString());
        await start({ token: inv.token, url: inv.wsUrl });
      } catch (e) {
        showJoinError("Échec de l'obtention du lien : " + (e.message || e));
      } finally {
        els.getInviteBtn.disabled = false;
      }
    });

    els.useLinkBtn.addEventListener("click", async () => {
      hide(els.joinError);
      const creds = parseCredentials(els.linkInput.value);
      if (!creds) {
        showJoinError("Lien ou token invalide.");
        return;
      }
      await start(creds);
    });
  }

  // ── Amorçage ─────────────────────────────────────────────────────────────────
  function init() {
    bindControls();
    setQuality(null);

    // Lecture des paramètres : token & url directement, ou via un lien complet.
    const params = new URLSearchParams(location.search);
    const direct = parseCredentials(
      params.get("token")
        ? location.href // l'URL courante contient déjà token (+ éventuellement url)
        : ""
    );

    if (direct && direct.token) {
      // On a des identifiants → connexion immédiate, pas de formulaire.
      hide(els.join);
      start(direct);
    } else {
      // Pas de token → on montre le formulaire d'accueil.
      show(els.join);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
