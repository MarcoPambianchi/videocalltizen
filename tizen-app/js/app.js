// app.js — Application TV Tizen, RÉCEPTION SEULE.
//
// Cycle :
//   1. Connexion au service de signalisation (WS) en rôle 'tv', device 'tv-salon'.
//   2. Réception 'appel_entrant' -> overlay (mode manuel) ou décrochage immédiat
//      (mode auto-answer).
//   3. Envoi 'decrocher' / 'refuser' selon l'action de l'utilisateur.
//   4. Réception 'appel_etabli' {token, wsUrl, room} -> connexion LiveKit en
//      réception seule (autoSubscribe video+audio), vidéo plein écran + audio HP.
//   5. Touche BACK en appel -> 'raccrocher' + déconnexion de la Room.
//
// Aucune capture locale : on ne demande JAMAIS getUserMedia. La Room est jointe
// avec un token canPublish=false (fourni par token-service via le signaling).

(function () {
  "use strict";

  // ── Configuration ──────────────────────────────────────────────────────────
  // Hôte du backend. Par défaut on suppose que la TV joint le même hôte que celui
  // qui sert l'app. Surchargeable via ?host=, ?signaling=, ?mode= dans l'URL
  // (utile pour la validation navigateur).
  var params = new URLSearchParams(window.location.search || "");
  var HOST = params.get("host") || window.location.hostname || "localhost";

  var SIGNALING_URL =
    params.get("signaling") || ("ws://" + HOST + ":9090");

  // Mode de décrochage : 'auto' (auto-answer, DÉFAUT) ou 'manuel' (overlay).
  // L'usage cible (visio familiale, personne âgée) veut le décrochage automatique.
  var ANSWER_MODE = (params.get("mode") || "auto").toLowerCase();

  var DEVICE_ID = params.get("device") || "tv-salon";
  var ROLE = "tv";

  // VEILLE : vidéo ambiante en boucle + message, affichés au repos et REPRIS à
  // la même position après chaque appel. ?standby=URL pour changer la vidéo
  // (?standby= vide pour la désactiver) ; ?message= pour le texte.
  // Contenu TV de FOND affiché au repos. Peut être un **flux LIVE/IPTV/HLS**
  // (pas seulement la mire de démo). ?standby=<URL> ; ?standby= vide = aucun fond.
  var DEFAULT_BG = "media/standby-sample.mp4";
  var STANDBY_VIDEO = params.has("standby") ? params.get("standby") : DEFAULT_BG;
  // Message par-dessus le fond. Vide par défaut dès qu'un vrai flux de fond est
  // fourni (on n'écrit pas « en veille » par-dessus Canal+).
  var IDLE_MESSAGE = params.has("message")
    ? params.get("message")
    : (STANDBY_VIDEO === DEFAULT_BG ? "Téléviseur — en veille" : "");
  // Flux de fond LIVE : à la reprise, revenir au DIRECT (bord live) et non à un
  // horodatage sauvegardé. ?live=1.
  var STANDBY_LIVE = params.has("live");

  // Reconnexion signaling : délai (ms) avec backoff léger.
  var RECONNECT_BASE_MS = 2000;
  var RECONNECT_MAX_MS = 15000;

  // ── État ───────────────────────────────────────────────────────────────────
  var ws = null;
  var reconnectDelay = RECONNECT_BASE_MS;
  var reconnectTimer = null;

  var room = null;            // LivekitClient.Room en cours, ou null
  var pendingCall = null;     // { callId, callerName } en attente de décrochage
  var currentCallId = null;   // callId de l'appel en cours (pour raccrocher)
  var inCall = false;
  var savedStandbyTime = 0;   // position de la vidéo de veille (reprise après appel)
  var tiles = {};             // identity -> {el, video, audios[]} (grille multipartite)

  // ── Éléments DOM ───────────────────────────────────────────────────────────
  var elGrid = document.getElementById("grid");
  var elAudioPool = document.getElementById("audioPool");
  var elStatus = document.getElementById("status");
  var elOverlay = document.getElementById("overlay");
  var elCaller = document.getElementById("overlay-caller");
  var elBtnAnswer = document.getElementById("btn-answer");
  var elBtnReject = document.getElementById("btn-reject");
  var elIncallHint = document.getElementById("incall-hint");
  var elStandby = document.getElementById("standby");
  var elStandbyVideo = document.getElementById("standbyVideo");
  var elStandbyMessage = document.getElementById("standbyMessage");

  // Référence à la lib LiveKit (UMD). Peut être absente si le CDN n'a pas chargé.
  var LK = window.LivekitClient || null;

  // ── Utilitaires UI ─────────────────────────────────────────────────────────
  function setStatus(text, visible) {
    if (!elStatus) return;
    elStatus.textContent = text;
    elStatus.style.display = (visible === false) ? "none" : "block";
  }

  function showOverlay(callerName) {
    if (!elOverlay) return;
    if (elCaller) {
      elCaller.textContent = "Appel de " + (callerName || "—");
    }
    elOverlay.classList.remove("hidden");
    // Focus le bouton "décrocher" pour la navigation télécommande.
    if (elBtnAnswer && typeof elBtnAnswer.focus === "function") {
      try { elBtnAnswer.focus(); } catch (e) {}
    }
  }

  function hideOverlay() {
    if (elOverlay) elOverlay.classList.add("hidden");
  }

  function showIncallHint() {
    if (!elIncallHint) return;
    elIncallHint.classList.remove("hidden");
    // Masque l'indice après quelques secondes pour ne pas gêner la vidéo.
    window.setTimeout(function () {
      if (elIncallHint) elIncallHint.classList.add("hidden");
    }, 4000);
  }

  // ── Veille (reprise là où elle s'était arrêtée) ────────────────────────────
  function setupStandby() {
    if (elStandbyMessage) elStandbyMessage.textContent = IDLE_MESSAGE;
    if (elStandbyVideo && STANDBY_VIDEO && elStandbyVideo.getAttribute("src") !== STANDBY_VIDEO) {
      elStandbyVideo.src = STANDBY_VIDEO;
    }
    enterStandby();
  }

  // Replace la lecture au bord LIVE (direct) pour un flux en continu.
  function seekToLiveEdge(v) {
    try {
      if (v.seekable && v.seekable.length) {
        v.currentTime = v.seekable.end(v.seekable.length - 1);
      }
    } catch (e) {}
  }

  // Réaffiche le fond TV et REPREND la lecture :
  //  - flux LIVE  -> retour au DIRECT (bord live) ;
  //  - flux VOD   -> reprise EXACTE à la position sauvegardée.
  function enterStandby() {
    if (!elStandby) return;
    elStandby.classList.remove("hidden");
    if (elStandbyVideo && STANDBY_VIDEO) {
      if (STANDBY_LIVE) {
        seekToLiveEdge(elStandbyVideo);
      } else {
        try { elStandbyVideo.currentTime = savedStandbyTime || 0; } catch (e) {}
      }
      var p = elStandbyVideo.play && elStandbyVideo.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
    }
  }

  // Masque la veille pour l'appel et MET EN PAUSE la vidéo ambiante (position mémorisée).
  function exitStandbyForCall() {
    if (elStandbyVideo && STANDBY_VIDEO) {
      try { savedStandbyTime = elStandbyVideo.currentTime || savedStandbyTime; } catch (e) {}
      try { elStandbyVideo.pause(); } catch (e) {}
    }
    if (elStandby) elStandby.classList.add("hidden");
  }

  // ── Signalisation (WebSocket) ──────────────────────────────────────────────
  function connectSignaling() {
    setStatus("Connexion au service d'appel… (" + SIGNALING_URL + ")");
    try {
      ws = new WebSocket(SIGNALING_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      reconnectDelay = RECONNECT_BASE_MS;
      setStatus("Prêt — en attente d'appel (" + DEVICE_ID + ")");
      // Protocole signaling C7 : enregistrement de la TV.
      sendSignal({ type: "register", role: ROLE, device: DEVICE_ID });
    };

    ws.onmessage = function (event) {
      var msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return; // message non-JSON ignoré
      }
      handleSignal(msg);
    };

    ws.onclose = function () {
      setStatus("Service d'appel injoignable — nouvelle tentative…");
      scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose suivra et déclenchera la reconnexion.
      try { ws.close(); } catch (e) {}
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
      connectSignaling();
    }, reconnectDelay);
  }

  function sendSignal(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  function handleSignal(msg) {
    switch (msg.type) {
      case "appel_entrant":
        onIncomingCall(msg);
        break;
      case "appel_etabli":
        onCallEstablished(msg);
        break;
      case "appel_annule":
      case "appel_termine":
        // L'appelant a raccroché / annulé avant ou pendant l'appel.
        onRemoteHangup();
        break;
      case "appel_manque":
        // Sonnerie expirée côté serveur : on remet l'UI au repos.
        pendingCall = null;
        hideOverlay();
        setStatus("Appel manqué — en attente d'appel");
        break;
      case "erreur":
        // Réinitialise complètement l'UI pour ne pas rester coincé sur "Décrochage…".
        pendingCall = null;
        currentCallId = null;
        hideOverlay();
        cleanupRoom();
        setStatus("Erreur : " + (msg.message || "inconnue") + " — en attente d'appel");
        break;
      default:
        // Types inconnus ignorés (ping, ack, etc.).
        break;
    }
  }

  // ── Logique d'appel ────────────────────────────────────────────────────────
  function onIncomingCall(msg) {
    if (inCall) {
      // Déjà en appel : on refuse poliment.
      sendSignal({ type: "refuser", callId: msg.callId, device: DEVICE_ID,
                   reason: "occupé" });
      return;
    }
    pendingCall = { callId: msg.callId, callerName: msg.callerName || msg.from || "Inconnu" };

    if (ANSWER_MODE === "auto") {
      setStatus("Appel entrant — décrochage automatique…");
      answerCall();
    } else {
      setStatus("Appel entrant", false);
      showOverlay(pendingCall.callerName);
    }
  }

  function answerCall() {
    if (!pendingCall) return;
    currentCallId = pendingCall.callId;
    hideOverlay();
    setStatus("Décrochage…");
    sendSignal({ type: "decrocher", callId: pendingCall.callId, device: DEVICE_ID });
    // On attend ensuite 'appel_etabli' avec le token.
  }

  function rejectCall() {
    if (!pendingCall) return;
    hideOverlay();
    sendSignal({ type: "refuser", callId: pendingCall.callId, device: DEVICE_ID });
    pendingCall = null;
    setStatus("Appel refusé — en attente d'appel");
  }

  function onCallEstablished(msg) {
    if (!msg.token || !msg.wsUrl) {
      setStatus("Erreur : token ou wsUrl manquant");
      return;
    }
    currentCallId = msg.callId || currentCallId;
    connectRoom(msg.token, msg.wsUrl, msg.room || "salon");
  }

  // ── LiveKit (réception seule, MULTIPARTITE : grille de participants) ────────
  function connectRoom(token, wsUrl, roomName) {
    if (!LK) {
      // Le CDN n'a pas chargé (ex. validation hors-ligne). On signale sans crasher.
      setStatus("livekit-client indisponible (CDN). Réception impossible.");
      return;
    }

    setStatus("Connexion à la salle « " + roomName + " »…");

    room = new LK.Room({ adaptiveStream: true, dynacast: false });

    // Une tuile par participant distant ; ajout/retrait dynamique.
    room.on(LK.RoomEvent.TrackSubscribed, function (track, pub, participant) {
      attachTrack(track, participant);
    });
    room.on(LK.RoomEvent.TrackUnsubscribed, function (track) {
      try { track.detach(); } catch (e) {}
    });
    room.on(LK.RoomEvent.ParticipantDisconnected, function (participant) {
      removeTile(participant && participant.identity);
    });
    room.on(LK.RoomEvent.Disconnected, function () {
      onRoomClosed();
    });

    // Connexion en RÉCEPTION SEULE : autoSubscribe abonne automatiquement
    // aux pistes de TOUS les participants (caméra + interlocuteurs).
    room.connect(wsUrl, token, { autoSubscribe: true })
      .then(function () {
        inCall = true;
        pendingCall = null;
        setStatus("En appel", false);
        showIncallHint();
        attachExistingTracks();
      })
      .catch(function (err) {
        setStatus("Échec de connexion à la salle : " + (err && err.message ? err.message : err));
        cleanupRoom();
      });
  }

  function attachExistingTracks() {
    if (!room || !room.remoteParticipants) return;
    room.remoteParticipants.forEach(function (participant) {
      participant.trackPublications.forEach(function (pub) {
        if (pub.isSubscribed && pub.track) attachTrack(pub.track, participant);
      });
    });
  }

  // ── Grille multipartite (split-screen) ─────────────────────────────────────
  function tileFor(identity, name) {
    if (!identity) identity = "?";
    if (tiles[identity]) return tiles[identity];
    var el = document.createElement("div");
    el.className = "tile";
    el.setAttribute("data-id", identity);
    var v = document.createElement("video");
    v.autoplay = true;
    v.muted = true; // l'audio passe par des pistes audio dédiées (HP TV)
    v.setAttribute("playsinline", "");
    var label = document.createElement("div");
    label.className = "tile-label";
    label.textContent = name || identity;
    el.appendChild(v);
    el.appendChild(label);
    if (elGrid) elGrid.appendChild(el);
    tiles[identity] = { el: el, video: v, audios: [] };
    // Au moins un participant -> l'appel REMPLACE la veille.
    exitStandbyForCall();
    updateGridLayout();
    return tiles[identity];
  }

  function removeTile(identity) {
    var t = identity && tiles[identity];
    if (!t) return;
    t.audios.forEach(function (a) { try { a.remove(); } catch (e) {} });
    try { t.el.remove(); } catch (e) {}
    delete tiles[identity];
    updateGridLayout();
  }

  function clearTiles() {
    Object.keys(tiles).forEach(function (id) { removeTile(id); });
  }

  // Layout adaptatif : colonnes = ceil(sqrt(n)). 1=plein écran, 2=côte à côte,
  // 3-4=mosaïque 2x2, 5-9=3x3, etc.
  function updateGridLayout() {
    if (!elGrid) return;
    var n = Object.keys(tiles).length;
    var cols = n <= 1 ? 1 : Math.ceil(Math.sqrt(n));
    var rows = Math.max(1, Math.ceil(n / cols));
    elGrid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
    elGrid.style.gridTemplateRows = "repeat(" + rows + ", 1fr)";
  }

  function attachTrack(track, participant) {
    if (!LK || !track) return;
    var identity = participant ? participant.identity : "?";
    var name = participant ? (participant.name || participant.identity) : identity;
    var t = tileFor(identity, name);
    if (track.kind === LK.Track.Kind.Video) {
      track.attach(t.video);
    } else if (track.kind === LK.Track.Kind.Audio) {
      // Un élément audio par participant (mixés sur les HP de la TV).
      var a = track.attach();
      a.autoplay = true;
      if (elAudioPool) elAudioPool.appendChild(a);
      t.audios.push(a);
      if (typeof a.play === "function") {
        var p = a.play();
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
    }
  }

  function onRemoteHangup() {
    pendingCall = null;
    hideOverlay();
    cleanupRoom();
    setStatus("Appel terminé — en attente d'appel");
  }

  function onRoomClosed() {
    cleanupRoom();
    setStatus("En attente d'appel");
  }

  // Raccrochage initié par la TV (touche BACK pendant l'appel).
  function hangUp() {
    if (pendingCall) {
      // Sonnerie en cours mais pas encore en appel : équivaut à un refus.
      rejectCall();
      return;
    }
    if (inCall || room) {
      sendSignal({ type: "raccrocher", callId: currentCallId, device: DEVICE_ID });
      currentCallId = null;
      cleanupRoom();
      setStatus("Appel raccroché — en attente d'appel");
    }
  }

  function cleanupRoom() {
    inCall = false;
    if (room) {
      try { room.disconnect(); } catch (e) {}
      room = null;
    }
    clearTiles();
    if (elIncallHint) elIncallHint.classList.add("hidden");
    // Fin d'appel : retour en VEILLE, la vidéo ambiante REPREND où elle en était.
    enterStandby();
  }

  // ── Entrées télécommande ───────────────────────────────────────────────────
  function onKeyDown(ev) {
    var action = window.VisioRemote ? window.VisioRemote.actionFromEvent(ev) : null;
    if (!action) return;

    // Overlay "appel entrant" ouvert : OK décroche, BACK refuse.
    if (pendingCall && !inCall) {
      if (action === "ok") {
        ev.preventDefault();
        answerCall();
      } else if (action === "back") {
        ev.preventDefault();
        rejectCall();
      } else if (action === "left" || action === "right") {
        // Bascule le focus entre Décrocher / Refuser.
        ev.preventDefault();
        toggleOverlayFocus();
      }
      return;
    }

    // En appel : BACK raccroche.
    if (inCall) {
      if (action === "back") {
        ev.preventDefault();
        hangUp();
      } else if (action === "ok" || action === "playpause") {
        // Réaffiche brièvement l'indice de raccrochage.
        ev.preventDefault();
        showIncallHint();
      }
      return;
    }

    // Au repos : BACK peut quitter l'app sur TV (API tizen.application).
    if (action === "back") {
      tryExitApp();
    }
  }

  function toggleOverlayFocus() {
    var active = document.activeElement;
    if (active === elBtnAnswer && elBtnReject) {
      try { elBtnReject.focus(); } catch (e) {}
    } else if (elBtnAnswer) {
      try { elBtnAnswer.focus(); } catch (e) {}
    }
  }

  function tryExitApp() {
    try {
      if (window.tizen && window.tizen.application &&
          typeof window.tizen.application.getCurrentApplication === "function") {
        window.tizen.application.getCurrentApplication().exit();
      }
    } catch (e) {
      // Navigateur : pas de sortie possible, on ignore.
    }
  }

  // ── Initialisation ─────────────────────────────────────────────────────────
  function init() {
    // App PERMANENTE : empêche la mise en veille de l'écran TV.
    try {
      if (window.tizen && window.tizen.power) {
        window.tizen.power.request("SCREEN", "SCREEN_NORMAL");
      }
    } catch (e) {}

    // Affiche la VEILLE (vidéo ambiante + message) dès le démarrage.
    setupStandby();

    // Enregistre les touches média de la télécommande (no-op hors TV).
    if (window.VisioRemote) {
      window.VisioRemote.registerRemoteKeys();
    }

    document.addEventListener("keydown", onKeyDown, false);

    // Clics souris sur les boutons (utile pour la validation navigateur).
    if (elBtnAnswer) elBtnAnswer.addEventListener("click", function () { answerCall(); });
    if (elBtnReject) elBtnReject.addEventListener("click", function () { rejectCall(); });

    if (!LK) {
      // Avertissement non-bloquant : l'app reste chargée et navigable.
      setStatus("Attention : livekit-client non chargé (CDN). Signaling actif.");
    }

    connectSignaling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose un point d'entrée de test pour la validation navigateur (simulation).
  window.VisioTV = {
    _simulateIncoming: function (callerName, callId) {
      onIncomingCall({ type: "appel_entrant", callerName: callerName, callId: callId || "test" });
    },
    _enterStandby: enterStandby,
    _exitStandbyForCall: exitStandbyForCall,
    _simulateTile: function (id) { tileFor(id, id); },     // pour la validation grille
    _clearTiles: clearTiles,
    _gridState: function () {
      return { tiles: Object.keys(tiles).length,
               columns: elGrid ? elGrid.style.gridTemplateColumns : "" };
    },
    _state: function () {
      return { inCall: inCall, pendingCall: pendingCall, mode: ANSWER_MODE,
               signaling: SIGNALING_URL, hasLiveKit: !!LK,
               standbyVisible: elStandby ? !elStandby.classList.contains("hidden") : false,
               savedStandbyTime: savedStandbyTime,
               live: STANDBY_LIVE,
               tiles: Object.keys(tiles).length };
    }
  };
})();
