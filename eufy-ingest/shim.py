#!/usr/bin/env python3
"""C2 — shim P2P Eufy -> go2rtc.

Lit les octets video H.264 (et audio AAC) du livestream P2P emis par l'instance
DEDIEE eufy-security-ws 'eufy-visio' (ws://127.0.0.1:3010 par defaut) et les pousse
en CONTINU vers go2rtc en publiant un flux RTSP : ffmpeg recoit les octets sur
stdin (-f h264 / -f aac) et publie sur rtsp://127.0.0.1:8554/<stream> (video
passthrough -c:v copy, audio transcode en Opus). go2rtc adapte ensuite vers
WebRTC/WHIP pour la chaine LiveKit.

Contraintes structurantes (cf README / cahier) :
  - HomeBase 2 : UN SEUL livestream P2P a la fois, partage avec le Gardien.
    => verrou flock INTER-PROCESS (LIVESTREAM_LOCK) tenu pendant toute la session.
  - L2 : ne jamais laisser de ffmpeg orphelin. proc.kill()+wait() en finally,
    feeder annule proprement, broken pipe geree sans planter la boucle.
  - Arret propre : device.stop_livestream + flock relache a la sortie (SIGTERM/SIGINT).
  - Reconnexion auto exponentielle au ws eufy ; keep-alive (ping websockets).

Aucune valeur n'est codee en dur pour la cible : tout passe par l'env (.env).
NE LANCE JAMAIS de connexion vers la vraie camera depuis les tests.
"""
import asyncio
import json
import logging
import os
import signal
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import fcntl  # POSIX uniquement (conteneur Linux) — verrou inter-process partage avec le Gardien

import websockets

# ── Configuration (env, avec valeurs par defaut sures pour le dev) ───────────
EUFY_WS_HOST = os.environ.get("EUFY_WS_HOST", "127.0.0.1")
EUFY_WS_PORT = int(os.environ.get("EUFY_WS_PORT", "3010"))
EUFY_WS_URL = os.environ.get("EUFY_WS_URL") or f"ws://{EUFY_WS_HOST}:{EUFY_WS_PORT}"
EUFY_CAMERA_SERIAL = os.environ.get("EUFY_CAMERA_SERIAL", "").strip()
SCHEMA_VERSION = int(os.environ.get("EUFY_SCHEMA_VERSION", "21"))

# Cible go2rtc. En host network, go2rtc ecoute RTSP sur 127.0.0.1:8554 et l'API sur 1984.
GO2RTC_RTSP_HOST = os.environ.get("GO2RTC_RTSP_HOST", "127.0.0.1")
GO2RTC_RTSP_PORT = int(os.environ.get("GO2RTC_RTSP_PORT", "8554"))
GO2RTC_STREAM = os.environ.get("GO2RTC_STREAM", "salon")
GO2RTC_RTSP_URL = os.environ.get("GO2RTC_RTSP_URL") or (
    f"rtsp://{GO2RTC_RTSP_HOST}:{GO2RTC_RTSP_PORT}/{GO2RTC_STREAM}"
)

# Verrou flock PARTAGE avec le Gardien. Le Gardien utilise
# <eufy-perception-mcp>/state/livestream.lock (cf eufy_client.py LIVESTREAM_LOCK).
# On pointe le MEME fichier par defaut pour serialiser les deux process. Configurable.
LIVESTREAM_LOCK = Path(
    os.environ.get(
        "EUFY_LIVESTREAM_LOCK",
        "/home/marco/.openclaw/tools/eufy-perception-mcp/state/livestream.lock",
    )
)
LOCK_WAIT_TIMEOUT = float(os.environ.get("EUFY_LOCK_TIMEOUT", "60"))

# Reconnexion exponentielle
RECONNECT_BASE = float(os.environ.get("EUFY_RECONNECT_BASE", "1"))
RECONNECT_MAX = float(os.environ.get("EUFY_RECONNECT_MAX", "30"))

log = logging.getLogger("eufy-shim")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


def _buffer_bytes(ev):
    """Extrait les octets d'un event 'livestream video/audio data'.

    eufy-security-ws emet un Node Buffer serialise en JSON :
        ev["buffer"] == {"type": "Buffer", "data": [12, 34, ...]}
    On accepte aussi une liste brute ou ev["buffer"] deja en bytes (robustesse tests).
    Retourne bytes (eventuellement vide) — JAMAIS None — pour simplifier l'appelant.
    """
    buf = ev.get("buffer")
    if buf is None:
        return b""
    if isinstance(buf, (bytes, bytearray)):
        return bytes(buf)
    if isinstance(buf, list):
        return bytes(buf)
    if isinstance(buf, dict):
        data = buf.get("data")
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
        if isinstance(data, list):
            return bytes(data)
    return b""


class Go2rtcPublisher:
    """Publie les octets H.264 + AAC vers go2rtc via un ffmpeg unique -> RTSP.

    Un seul ffmpeg pour les 2 pistes : on multiplexe en interne... non — eufy livre
    video et audio en flux H.264 et AAC SEPARES. ffmpeg accepte plusieurs entrees
    pipe, mais on ne peut alimenter qu'un seul stdin. Strategie : 2 ffmpeg distincts
    pousseraient 2 flux RTSP (video+audio melanges cote go2rtc = complexe). On choisit
    le plus simple et robuste : un ffmpeg qui lit la VIDEO sur stdin (-f h264) et, si
    l'audio est disponible, on ne l'envoie PAS ici — go2rtc derive deja une piste OPUS
    de la source 'salon' (cf go2rtc.yaml `ffmpeg:salon#audio=opus`). Le shim publie donc
    la VIDEO ; l'audio P2P est documente comme limite (transcodage Opus a cabler en P5).

    NB L2 : kill()+wait() systematiques, broken pipe avale, aucun orphelin.
    """

    def __init__(self, rtsp_url, in_fmt="h264"):
        self.rtsp_url = rtsp_url
        self.in_fmt = in_fmt
        self.proc = None

    async def start(self):
        # -fflags +genpts : le flux H.264 brut n'a pas d'horodatage -> ffmpeg en genere.
        # -c:v copy : passthrough video (zero re-encodage, faible CPU/latence).
        # -rtsp_transport tcp : robuste derriere NAT / pertes (cf go2rtc.yaml).
        args = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err",
            "-f", self.in_fmt, "-i", "pipe:0",
            "-c:v", "copy", "-an",
            "-rtsp_transport", "tcp", "-f", "rtsp", self.rtsp_url,
        ]
        self.proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        log.info("ffmpeg publie %s -> %s", self.in_fmt, self.rtsp_url)

    async def write(self, chunk):
        """Ecrit un chunk video sur stdin de ffmpeg. Retourne False si le pipe est casse
        (ffmpeg mort / go2rtc indisponible) -> l'appelant declenchera un restart."""
        if not self.proc or self.proc.stdin is None:
            return False
        try:
            self.proc.stdin.write(chunk)
            await self.proc.stdin.drain()
            return True
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            # L2 : broken pipe = ffmpeg parti. On NE plante PAS la boucle ; on signale.
            log.warning("broken pipe vers ffmpeg (go2rtc indisponible ?)")
            return False

    async def stop(self):
        """Arret propre et SANS orphelin : ferme stdin, kill, wait (cf L2)."""
        proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.close()
        except Exception:
            pass
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        except Exception:
            pass
        try:
            await proc.wait()
        except Exception:
            pass


@asynccontextmanager
async def livestream_lock(path: Path, timeout: float):
    """Verrou flock EXCLUSIF inter-process partage avec le Gardien.

    Tant qu'il est tenu, le Gardien (eufy_client.py) attend, et reciproquement : on ne
    streame JAMAIS en meme temps sur l'unique slot P2P de la HomeBase. Acquisition
    non-bloquante en boucle pour ne pas figer l'event loop ; TimeoutError au-dela de
    `timeout`. Le fichier reste (lock advisory) ; on relache et on ferme en sortie.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    # Mode "a" : jamais de troncature du fichier de verrou partagé avec le Gardien
    # (le flock advisory fonctionne sur un fd ouvert en append).
    f = open(path, "a")
    deadline = time.time() + timeout
    try:
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.time() > deadline:
                    raise TimeoutError(
                        f"livestream lock {path} occupe (Gardien actif ?) apres {timeout}s"
                    )
                await asyncio.sleep(0.5)
        log.info("flock acquis : %s", path)
        yield
    finally:
        try:
            fcntl.flock(f, fcntl.LOCK_UN)
        except Exception:
            pass
        f.close()
        log.info("flock relache : %s", path)


class EufyShim:
    def __init__(self):
        self.ws = None
        self._waiters = {}
        self._reader_task = None
        self.publisher = None
        self._stop = asyncio.Event()
        self._livestreaming = False

    # ── Protocole eufy-security-ws ───────────────────────────────────────────
    async def _cmd(self, msg, timeout=30):
        mid = msg.setdefault("messageId", uuid.uuid4().hex)
        fut = asyncio.get_event_loop().create_future()
        self._waiters[mid] = fut
        try:
            await self.ws.send(json.dumps(msg))
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._waiters.pop(mid, None)

    async def _reader(self):
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                t = m.get("type")
                if t == "result":
                    fut = self._waiters.pop(m.get("messageId"), None)
                    if fut and not fut.done():
                        fut.set_result(m)
                elif t == "event":
                    await self._on_event(m["event"])
        except Exception as e:
            log.warning("reader ws arrete : %s", e)

    async def _on_event(self, ev):
        name = ev.get("event")
        if name == "livestream video data":
            if ev.get("serialNumber") and EUFY_CAMERA_SERIAL and \
                    ev["serialNumber"] != EUFY_CAMERA_SERIAL:
                return
            chunk = _buffer_bytes(ev)
            if chunk and self.publisher is not None:
                ok = await self.publisher.write(chunk)
                if not ok:
                    # ffmpeg/go2rtc tombe : on relance le publisher (pas la session ws).
                    await self._restart_publisher()
        # 'livestream audio data' : ignore ici (audio gere par go2rtc, cf limites README).

    # ── Session livestream ───────────────────────────────────────────────────
    async def _restart_publisher(self):
        log.info("redemarrage du publisher go2rtc")
        if self.publisher is not None:
            await self.publisher.stop()
        self.publisher = Go2rtcPublisher(GO2RTC_RTSP_URL, in_fmt="h264")
        await self.publisher.start()

    async def run_session(self):
        """Une session complete : connexion ws -> flock -> start_livestream -> pompe les
        octets vers go2rtc jusqu'a l'arret. Tout est nettoye en finally (L2)."""
        if not EUFY_CAMERA_SERIAL:
            raise RuntimeError("EUFY_CAMERA_SERIAL non defini (refus de demarrer un livestream)")

        async with livestream_lock(LIVESTREAM_LOCK, LOCK_WAIT_TIMEOUT):
            # keep-alive : ping toutes les 20s, max_size=None (frames media volumineuses).
            self.ws = await websockets.connect(
                EUFY_WS_URL, max_size=None, ping_interval=20, ping_timeout=20
            )
            try:
                await self.ws.recv()  # frame "version"
                self._reader_task = asyncio.create_task(self._reader())
                await self._cmd({"command": "set_api_schema", "schemaVersion": SCHEMA_VERSION})
                await self._cmd({"command": "start_listening"})

                self.publisher = Go2rtcPublisher(GO2RTC_RTSP_URL, in_fmt="h264")
                await self.publisher.start()

                await self._cmd({
                    "command": "device.start_livestream",
                    "serialNumber": EUFY_CAMERA_SERIAL,
                })
                self._livestreaming = True
                log.info("livestream demarre pour %s -> %s", EUFY_CAMERA_SERIAL, GO2RTC_RTSP_URL)

                # On attend l'ordre d'arret ; les octets sont pompes par le reader.
                await self._stop.wait()
            finally:
                await self._teardown_session()

    async def _teardown_session(self):
        """Arret propre : stop_livestream, ferme reader, kill ffmpeg, ferme ws. Idempotent."""
        if self._livestreaming:
            try:
                await self._cmd(
                    {"command": "device.stop_livestream", "serialNumber": EUFY_CAMERA_SERIAL},
                    timeout=10,
                )
            except Exception as e:
                log.warning("stop_livestream : %s", e)
            self._livestreaming = False

        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
            self._reader_task = None

        if self.publisher is not None:
            await self.publisher.stop()
            self.publisher = None

        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None

    def request_stop(self):
        self._stop.set()


async def main():
    shim = EufyShim()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, shim.request_stop)
        except (NotImplementedError, RuntimeError):
            pass  # plateforme sans add_signal_handler (ex tests) : ignore

    backoff = RECONNECT_BASE
    while not shim._stop.is_set():
        try:
            await shim.run_session()
            # Session terminee proprement (stop demande) -> on sort.
            if shim._stop.is_set():
                break
            backoff = RECONNECT_BASE
        except TimeoutError as e:
            # flock occupe par le Gardien : on retente plus tard, sans bruit excessif.
            log.warning("%s — nouvelle tentative dans %.0fs", e, backoff)
        except Exception as e:
            log.warning("session interrompue : %s — reconnexion dans %.0fs", e, backoff)
        # backoff exponentiel borne, interruptible par l'arret.
        try:
            await asyncio.wait_for(shim._stop.wait(), timeout=backoff)
        except asyncio.TimeoutError:
            pass
        backoff = min(backoff * 2, RECONNECT_MAX)

    log.info("arret du shim eufy")


if __name__ == "__main__":
    asyncio.run(main())
