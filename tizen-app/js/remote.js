// remote.js — Mapping des touches de la télécommande Samsung Tizen.
//
// L'app doit fonctionner À LA FOIS sur TV Tizen ET dans un navigateur normal
// (validation headless). Toutes les API tizen.* sont donc optionnelles et
// protégées par try/catch.
//
// Sur TV, les touches "média" (PlayPause, etc.) ne génèrent d'événement keydown
// que si elles ont été enregistrées via tizen.tvinputdevice.registerKey().
// Les flèches, Enter et Return (BACK = 10009) sont disponibles par défaut.

(function (global) {
  "use strict";

  // Keycodes télécommande Samsung Tizen (et équivalents navigateur).
  var KEY = {
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ENTER: 13,        // OK / centre du pavé directionnel
    BACK: 10009,      // touche Return/Back de la télécommande Samsung
    ESCAPE: 27,       // équivalent BACK dans un navigateur
    MEDIA_PLAY_PAUSE: 10252,
    MEDIA_PLAY: 415,
    MEDIA_PAUSE: 19,
    MEDIA_STOP: 413,
    RED: 403,
    GREEN: 404,
    YELLOW: 405,
    BLUE: 406
  };

  // Touches "additionnelles" à enregistrer si l'API TV est présente.
  // Les flèches / Enter / Return sont déjà actives sans enregistrement.
  var REGISTERABLE = [
    "MediaPlayPause",
    "MediaPlay",
    "MediaPause",
    "MediaStop",
    "ColorF0Red",
    "ColorF1Green"
  ];

  // Enregistre les touches média si tizen.tvinputdevice existe. No-op ailleurs.
  function registerRemoteKeys() {
    var registered = [];
    try {
      if (global.tizen &&
          global.tizen.tvinputdevice &&
          typeof global.tizen.tvinputdevice.registerKey === "function") {
        REGISTERABLE.forEach(function (name) {
          try {
            global.tizen.tvinputdevice.registerKey(name);
            registered.push(name);
          } catch (e) {
            // Touche non supportée par ce modèle : on ignore.
          }
        });
      }
    } catch (e) {
      // Pas d'environnement Tizen (navigateur) : rien à enregistrer.
    }
    return registered;
  }

  // Normalise un événement clavier vers une action logique de l'app.
  // Retourne une chaîne : "left" | "up" | "right" | "down" | "ok" | "back"
  //                       | "playpause" | null.
  function actionFromEvent(ev) {
    var code = ev.keyCode;
    switch (code) {
      case KEY.LEFT:  return "left";
      case KEY.UP:    return "up";
      case KEY.RIGHT: return "right";
      case KEY.DOWN:  return "down";
      case KEY.ENTER: return "ok";
      case KEY.BACK:
      case KEY.ESCAPE: return "back";
      case KEY.MEDIA_PLAY_PAUSE:
      case KEY.MEDIA_PLAY:
      case KEY.MEDIA_PAUSE: return "playpause";
      default: return null;
    }
  }

  global.VisioRemote = {
    KEY: KEY,
    registerRemoteKeys: registerRemoteKeys,
    actionFromEvent: actionFromEvent
  };
})(window);
