#!/usr/bin/env python3
# C10 — supervision/watchdog pour videocalltizen (Architecture B).
#
# Surveille la santé de la chaîne d'ingestion pendant un appel :
#   go2rtc (C3)  : la source 'salon' progresse-t-elle en octets (détection FLUX GELÉ) ?
#   ingress (C4) : 'camera-salon' est-il présent dans la salle avec des pistes ?
#   livekit (C5) : le SFU répond-il (GET / == OK) ?
#
# En cas de coupure : RETRY exponentiel plafonné qui relance l'ingestion
#   (re-POST token-service /rooms/salon/ingress + re-publish go2rtc),
# log structuré (JSON par ligne), et expose GET /status (port 9095) avec
# l'état de chaque maillon + compteur de reconnexions. Alerte WARN/ERROR
# si l'échec persiste.
#
# Stdlib uniquement (urllib + http.server). Aucune dépendance lourde.
# Tout est piloté par variables d'environnement (valeurs par défaut = conventions du projet).

import json
import logging
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── Configuration (env, avec défauts conformes aux conventions projet) ────────
# Depuis l'hôte par défaut ; surcharger en *_URL internes si lancé dans le réseau 'visio'.
GO2RTC_URL       = os.environ.get("GO2RTC_URL", "http://localhost:1984")
TOKEN_SERVICE_URL = os.environ.get("TOKEN_SERVICE_URL", "http://localhost:9080")
LIVEKIT_URL      = os.environ.get("LIVEKIT_URL", "http://localhost:7880")

ROOM            = os.environ.get("ROOM_NAME", "salon")
CAMERA_IDENTITY = os.environ.get("CAMERA_IDENTITY", "camera-salon")
GO2RTC_STREAM   = os.environ.get("GO2RTC_STREAM", "salon")

STATUS_PORT     = int(os.environ.get("STATUS_PORT", "9095"))

# Cadence de la boucle de surveillance (s).
POLL_INTERVAL   = float(os.environ.get("POLL_INTERVAL", "5"))
# Fenêtre sans progression d'octets au-delà de laquelle le flux est jugé GELÉ (s).
FREEZE_TIMEOUT  = float(os.environ.get("FREEZE_TIMEOUT", "15"))
# Délai HTTP (s).
HTTP_TIMEOUT    = float(os.environ.get("HTTP_TIMEOUT", "4"))

# RETRY exponentiel plafonné pour la relance de l'ingestion.
RETRY_BASE      = float(os.environ.get("RETRY_BASE", "2"))      # 1er backoff (s)
RETRY_MAX       = float(os.environ.get("RETRY_MAX", "60"))      # plafond du backoff (s)
# Nombre de tentatives consécutives échouées au-delà duquel on alerte (ERROR persistant).
ALERT_AFTER     = int(os.environ.get("ALERT_AFTER", "5"))

# Type d'entrée ingress utilisé pour la relance (rtmp par défaut, cf. token-service).
INGRESS_INPUT_TYPE = os.environ.get("INGRESS_INPUT_TYPE", "rtmp")

# Service de signalisation : on ne supervise la chaîne média QUE pendant un appel actif.
SIGNALING_URL   = os.environ.get("SIGNALING_URL", "http://localhost:9090")


# ── Log structuré (une ligne JSON par évènement) ──────────────────────────────
class JsonFormatter(logging.Formatter):
    def format(self, record):
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)),
            "level": record.levelname,
            "event": record.getMessage(),
        }
        extra = getattr(record, "fields", None)
        if extra:
            payload.update(extra)
        return json.dumps(payload, ensure_ascii=False)


log = logging.getLogger("visio-watchdog")
log.setLevel(logging.INFO)
_h = logging.StreamHandler(sys.stdout)
_h.setFormatter(JsonFormatter())
log.addHandler(_h)


def logev(level, event, **fields):
    log.log(level, event, extra={"fields": fields})


# ── HTTP helpers (urllib, stdlib) ─────────────────────────────────────────────
def http_get(url, timeout=HTTP_TIMEOUT):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def http_get_json(url, timeout=HTTP_TIMEOUT):
    status, body = http_get(url, timeout)
    return status, json.loads(body.decode("utf-8")) if body else None


def http_post_json(url, payload=None, timeout=HTTP_TIMEOUT):
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        return r.status, json.loads(body.decode("utf-8")) if body else None


def http_delete(url, timeout=HTTP_TIMEOUT):
    req = urllib.request.Request(url, method="DELETE")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status


def call_active():
    """True si un appel est en cours (signaling status == 'en_appel'),
    False si au repos, None si le signaling est injoignable."""
    try:
        _, st = http_get_json(f"{SIGNALING_URL}/state")
    except Exception:
        return None
    return (st or {}).get("status") == "en_appel"


# ── État partagé (lu par /status, écrit par la boucle) ────────────────────────
STATE_LOCK = threading.Lock()
STATE = {
    "started_at": time.time(),
    "appel_actif": None,             # True pendant un appel (sinon repos)
    "ingressId": None,               # dernier ingress créé (supprimé avant relance)
    "reconnects": 0,                 # compteur global de reconnexions réussies
    "consecutive_failures": 0,       # échecs consécutifs de la chaîne
    "next_retry_in": 0.0,            # backoff courant (s)
    "links": {
        "go2rtc":  {"ok": None, "detail": "init"},
        "ingress": {"ok": None, "detail": "init"},
        "livekit": {"ok": None, "detail": "init"},
    },
    "freeze": {
        "last_bytes": None,          # dernier total d'octets observé sur la source
        "last_progress_at": None,    # epoch du dernier avancement d'octets
        "frozen": None,              # True si gelé au-delà de FREEZE_TIMEOUT
    },
    "last_check_at": None,
}


def set_link(name, ok, detail):
    with STATE_LOCK:
        STATE["links"][name] = {"ok": ok, "detail": detail}


def overall_healthy():
    with STATE_LOCK:
        return all(l["ok"] is True for l in STATE["links"].values())


# ── Maillon go2rtc : progression d'octets de la source 'salon' ────────────────
def stream_total_bytes(streams, name):
    """Somme des octets producers(recv)+consumers(send) pour la source `name`.

    La forme de /api/streams varie selon les versions de go2rtc ; on additionne
    tous les champs *bytes* rencontrés dans producers/consumers pour rester robuste.
    Retourne (total_bytes:int, consumers:int) ou (None, 0) si source absente.
    """
    if not isinstance(streams, dict) or name not in streams or streams[name] is None:
        return None, 0
    s = streams[name]
    total = 0
    consumers = 0
    for key in ("producers", "consumers"):
        items = s.get(key) or []
        if key == "consumers":
            consumers = len(items)
        for it in items:
            if not isinstance(it, dict):
                continue
            for fk, fv in it.items():
                if "bytes" in fk and isinstance(fv, (int, float)):
                    total += int(fv)
    return total, consumers


def check_go2rtc():
    """Vérifie la présence de la source et la progression d'octets (anti-gel)."""
    try:
        _, streams = http_get_json(f"{GO2RTC_URL}/api/streams")
    except Exception as e:
        set_link("go2rtc", False, f"injoignable: {e}")
        return False
    total, consumers = stream_total_bytes(streams, GO2RTC_STREAM)
    if total is None:
        set_link("go2rtc", False, f"source '{GO2RTC_STREAM}' absente")
        with STATE_LOCK:
            STATE["freeze"].update(frozen=None, last_bytes=None, last_progress_at=None)
        return False

    # Source lazy (exec) : sans consommateur, aucun octet ne progresse — ce n'est
    # PAS un gel. Maillon sain au repos (évite un faux 'FLUX GELÉ').
    if consumers == 0:
        with STATE_LOCK:
            STATE["freeze"].update(frozen=False, last_bytes=total, last_progress_at=time.time())
        set_link("go2rtc", True, f"octets={total} (repos: 0 consommateur)")
        return True

    now = time.time()
    frozen = False
    with STATE_LOCK:
        fz = STATE["freeze"]
        prev = fz["last_bytes"]
        if prev is None or total > prev:
            fz["last_bytes"] = total
            fz["last_progress_at"] = now
        else:
            # Pas de progression : gelé si la fenêtre est dépassée.
            since = now - (fz["last_progress_at"] or now)
            if since >= FREEZE_TIMEOUT:
                frozen = True
        fz["frozen"] = frozen

    if frozen:
        set_link("go2rtc", False,
                 f"FLUX GELÉ: {total} octets stables depuis >={int(FREEZE_TIMEOUT)}s")
        return False
    set_link("go2rtc", True, f"octets={total} consommateurs={consumers}")
    return True


# ── Maillon ingress : 'camera-salon' présent avec pistes ──────────────────────
def check_ingress():
    try:
        _, data = http_get_json(f"{TOKEN_SERVICE_URL}/rooms/{ROOM}/participants")
    except Exception as e:
        set_link("ingress", False, f"token-service injoignable: {e}")
        return False
    parts = (data or {}).get("participants", [])
    for p in parts:
        if p.get("identity") == CAMERA_IDENTITY:
            ntracks = len(p.get("tracks", []))
            if ntracks > 0:
                set_link("ingress", True, f"'{CAMERA_IDENTITY}' présent, pistes={ntracks}")
                return True
            set_link("ingress", False, f"'{CAMERA_IDENTITY}' présent mais 0 piste")
            return False
    set_link("ingress", False, f"'{CAMERA_IDENTITY}' absent de '{ROOM}'")
    return False


# ── Maillon livekit : SFU répond ──────────────────────────────────────────────
def check_livekit():
    try:
        status, _ = http_get(f"{LIVEKIT_URL}/")
    except urllib.error.HTTPError as e:
        # LiveKit répond souvent un code non-200 sur '/', mais répondre == vivant.
        set_link("livekit", True, f"répond (HTTP {e.code})")
        return True
    except Exception as e:
        set_link("livekit", False, f"injoignable: {e}")
        return False
    set_link("livekit", True, f"OK (HTTP {status})")
    return True


# ── Relance de l'ingestion ────────────────────────────────────────────────────
def url_encode(s):
    return urllib.parse.quote(s, safe="")


def relancer_ingestion():
    """Re-crée la salle + l'ingress (token-service) puis re-publie go2rtc.

    Reproduit la séquence de scripts/test-p1-ingestion.sh.
    Retourne True si la relance a abouti côté API (pas une garantie média).
    """
    try:
        # 0) Supprimer l'ancien ingress AVANT d'en recréer un (anti-accumulation).
        with STATE_LOCK:
            old_id = STATE.get("ingressId")
        if old_id:
            try:
                http_delete(f"{TOKEN_SERVICE_URL}/ingress/{old_id}")
                logev(logging.INFO, "relance.ingress.ancien_supprime", ingressId=old_id)
            except Exception as e:
                logev(logging.WARNING, "relance.ingress.suppr_echec", ingressId=old_id, erreur=str(e))
        # 1) S'assurer que la salle existe.
        http_post_json(f"{TOKEN_SERVICE_URL}/rooms/{ROOM}")
        # 2) (Re)créer une session d'ingress -> publishUrl.
        _, ing = http_post_json(
            f"{TOKEN_SERVICE_URL}/rooms/{ROOM}/ingress",
            {"inputType": INGRESS_INPUT_TYPE, "identity": CAMERA_IDENTITY},
        )
        publish_url = (ing or {}).get("publishUrl")
        if not publish_url:
            logev(logging.ERROR, "relance.ingress.publishUrl_vide", reponse=ing)
            return False
        with STATE_LOCK:
            STATE["ingressId"] = (ing or {}).get("ingressId")
        # 3) Demander à go2rtc de publier la source vers la destination ingress.
        dst = url_encode(publish_url)
        http_post_json(
            f"{GO2RTC_URL}/api/streams?src={url_encode(GO2RTC_STREAM)}&dst={dst}"
        )
        logev(logging.INFO, "relance.ok",
              ingressId=(ing or {}).get("ingressId"), publishUrl=publish_url)
        return True
    except Exception as e:
        logev(logging.ERROR, "relance.echec", erreur=str(e))
        return False


# ── Boucle de surveillance ────────────────────────────────────────────────────
def monitor_loop():
    backoff = RETRY_BASE
    while True:
        # On ne supervise la chaîne média QUE pendant un appel actif. Au repos
        # (ou signaling injoignable), la chaîne est censée être éteinte : aucune
        # relance -> évite reconnexions intempestives et accumulation d'ingress.
        active = call_active()
        with STATE_LOCK:
            STATE["appel_actif"] = active
        if active is not True:
            with STATE_LOCK:
                STATE["consecutive_failures"] = 0
                STATE["next_retry_in"] = 0.0
                for k in STATE["links"]:
                    STATE["links"][k] = {"ok": None, "detail": "repos (pas d'appel)"}
                STATE["freeze"].update(frozen=None, last_bytes=None, last_progress_at=None)
                STATE["last_check_at"] = time.time()
            backoff = RETRY_BASE
            time.sleep(POLL_INTERVAL)
            continue

        g = check_go2rtc()
        i = check_ingress()
        l = check_livekit()
        with STATE_LOCK:
            STATE["last_check_at"] = time.time()
        healthy = g and i and l

        if healthy:
            with STATE_LOCK:
                STATE["consecutive_failures"] = 0
                STATE["next_retry_in"] = 0.0
            backoff = RETRY_BASE
            logev(logging.INFO, "chaine.ok",
                  go2rtc=g, ingress=i, livekit=l)
            time.sleep(POLL_INTERVAL)
            continue

        # Coupure détectée.
        with STATE_LOCK:
            STATE["consecutive_failures"] += 1
            fails = STATE["consecutive_failures"]
            STATE["next_retry_in"] = backoff
            links_snapshot = {k: v["detail"] for k, v in STATE["links"].items()}

        level = logging.ERROR if fails >= ALERT_AFTER else logging.WARNING
        logev(level, "chaine.coupure",
              echecs_consecutifs=fails, backoff=round(backoff, 1),
              go2rtc=g, ingress=i, livekit=l, details=links_snapshot)

        # LiveKit HS : inutile de relancer l'ingestion, on attend qu'il revienne.
        if not l:
            logev(logging.WARNING, "relance.differee", raison="livekit indisponible")
        else:
            relanca = relancer_ingestion()
            if relanca:
                with STATE_LOCK:
                    STATE["reconnects"] += 1
                logev(logging.INFO, "reconnexion.tentee",
                      total_reconnexions=STATE["reconnects"])

        # Backoff exponentiel plafonné avant la prochaine itération.
        time.sleep(min(backoff, RETRY_MAX))
        backoff = min(backoff * 2, RETRY_MAX)


# ── Serveur /status (port 9095) ───────────────────────────────────────────────
class StatusHandler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/status", ""):
            with STATE_LOCK:
                snap = json.loads(json.dumps(STATE))  # copie profonde simple
            idle = snap.get("appel_actif") is not True
            snap["mode"] = "repos" if idle else "appel"
            # Au repos, le watchdog est sain par définition (rien à superviser).
            snap["healthy"] = idle or all(l["ok"] is True for l in snap["links"].values())
            snap["uptime_s"] = round(time.time() - snap["started_at"], 1)
            self._send(200 if snap["healthy"] else 503, snap)
        elif self.path.rstrip("/") == "/healthz":
            self._send(200, {"ok": True, "service": "visio-watchdog"})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, *args):
        return  # silence le log par défaut de http.server (on a notre JSON)


def serve_status():
    srv = ThreadingHTTPServer(("0.0.0.0", STATUS_PORT), StatusHandler)
    logev(logging.INFO, "status.ecoute", port=STATUS_PORT, route="/status")
    srv.serve_forever()


def main():
    logev(logging.INFO, "watchdog.demarrage",
          go2rtc=GO2RTC_URL, token_service=TOKEN_SERVICE_URL, livekit=LIVEKIT_URL,
          room=ROOM, camera=CAMERA_IDENTITY, freeze_timeout=FREEZE_TIMEOUT,
          poll=POLL_INTERVAL, status_port=STATUS_PORT)
    t = threading.Thread(target=serve_status, daemon=True)
    t.start()
    try:
        monitor_loop()
    except KeyboardInterrupt:
        logev(logging.INFO, "watchdog.arret")


if __name__ == "__main__":
    main()
