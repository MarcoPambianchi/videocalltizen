#!/usr/bin/env python3
"""C2 — shim P2P Eufy -> go2rtc.

Lit les octets video H.264 (et audio AAC) du livestream P2P emis par l'instance
DEDIEE eufy-security-ws 'eufy-visio' (ws://127.0.0.1:3010 par defaut) et les pousse
en CONTINU vers go2rtc en publiant un flux RTSP : ffmpeg recoit les octets sur
stdin (-f h264 / -f aac) et publie sur rtsp://127.0.0.1:8554/<stream> (video
passthrough -c:v copy, audio transcode en Opus). go2rtc adapte ensuite vers
WebRTC/WHIP pour la chaine LiveKit.

Contraintes structurantes (cf README / cahier) :
  - HomeBase 2 : UN SEUL livestream P2P a la fois, partage avec une autre integration
    utilisant la meme camera.
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

import fcntl  # POSIX uniquement (conteneur Linux) — verrou inter-process partage avec une autre integration

import websockets

# ── Configuration (env, avec valeurs par defaut sures pour le dev) ───────────
EUFY_WS_HOST = os.environ.get("EUFY_WS_HOST", "127.0.0.1")
EUFY_WS_PORT = int(os.environ.get("EUFY_WS_PORT", "3010"))
EUFY_WS_URL = os.environ.get("EUFY_WS_URL") or f"ws://{EUFY_WS_HOST}:{EUFY_WS_PORT}"
EUFY_CAMERA_SERIAL = os.environ.get("EUFY_CAMERA_SERIAL", "").strip()
SCHEMA_VERSION = int(os.environ.get("EUFY_SCHEMA_VERSION", "21"))
# Qualité de streaming à appliquer (1=720P, 2=1080P, 3=2K, 4=4K). 720P par défaut :
# transcodage H.265->H.264 léger et flux stable (le double ré-encodage RTMP de l'Ingress
# rend le 1080p plus instable). Vide = ne pas toucher le réglage de la caméra.
EUFY_STREAM_QUALITY = os.environ.get("EUFY_STREAM_QUALITY", "1").strip()
# Débit cible du transcodage H.264 (qualité). 720p : ~2,5-3,5 Mbit/s donne une bonne image.
EUFY_VIDEO_BITRATE = os.environ.get("EUFY_VIDEO_BITRATE", "3000k").strip()

# Cible go2rtc. En host network, go2rtc ecoute RTSP sur 127.0.0.1:8554 et l'API sur 1984.
GO2RTC_RTSP_HOST = os.environ.get("GO2RTC_RTSP_HOST", "127.0.0.1")
GO2RTC_RTSP_PORT = int(os.environ.get("GO2RTC_RTSP_PORT", "8554"))
GO2RTC_STREAM = os.environ.get("GO2RTC_STREAM", "salon")
GO2RTC_RTSP_URL = os.environ.get("GO2RTC_RTSP_URL") or (
    f"rtsp://{GO2RTC_RTSP_HOST}:{GO2RTC_RTSP_PORT}/{GO2RTC_STREAM}"
)

# Verrou flock PARTAGE avec toute autre integration utilisant la meme camera.
# Le defaut est un chemin NEUTRE local a ce projet. Pour se coordonner avec une autre
# integration (ex. domotique/surveillance type Home Assistant), pointer cette variable
# vers le MEME fichier de verrou que cette integration afin de serialiser les deux
# process sur l'unique slot P2P de la HomeBase. Configurable via EUFY_LIVESTREAM_LOCK.
LIVESTREAM_LOCK = Path(
    os.environ.get(
        "EUFY_LIVESTREAM_LOCK",
        "/tmp/eufy-livestream.lock",
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
        # WebRTC ne supporte PAS le H.265 : on transcode HEVC -> H.264 (léger en 720p).
        # Si le flux est déjà H.264, passthrough (-c:v copy, zéro CPU).
        if self.in_fmt == "h264":
            vcodec = ["-c:v", "copy"]
        else:
            # Profil baseline = compatible bypass Ingress / tous navigateurs. Débit cible
            # configurable pour la qualité finale (faible latence conservée).
            vcodec = ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
                      "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "50", "-bf", "0",
                      "-b:v", EUFY_VIDEO_BITRATE, "-maxrate", EUFY_VIDEO_BITRATE,
                      "-bufsize", "7000k"]
        args = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err",
            "-f", self.in_fmt, "-i", "pipe:0",
            *vcodec, "-an",
            "-rtsp_transport", "tcp", "-f", "rtsp", self.rtsp_url,
        ]
        self.proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        mode = "passthrough" if self.in_fmt == "h264" else "transcode->H264"
        log.info("ffmpeg %s (%s) -> %s", self.in_fmt, mode, self.rtsp_url)

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
    """Verrou flock EXCLUSIF inter-process partage avec une autre integration.

    Tant qu'il est tenu, l'autre integration attend, et reciproquement : on ne
    streame JAMAIS en meme temps sur l'unique slot P2P de la HomeBase. Acquisition
    non-bloquante en boucle pour ne pas figer l'event loop ; TimeoutError au-dela de
    `timeout`. Le fichier reste (lock advisory) ; on relache et on ferme en sortie.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    # Mode "a" : jamais de troncature du fichier de verrou partagé avec l'autre integration
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
                        f"livestream lock {path} occupe (autre integration active ?) apres {timeout}s"
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
        # Instrumentation P0 (latence démarrage L4, cadence, gels L2/L6).
        self._in_fmt = None
        self._t_start_ls = None
        self._t_first_frame = None
        self._t_last_frame = None
        self._frames = 0
        self._bytes = 0
        self._max_gap = 0.0
        self._orig_quality = None   # qualité streaming d'origine (restaurée à l'arrêt)

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
            if not chunk:
                return
            now = time.time()
            # Lancement PARESSEUX du publisher avec le CODEC réellement émis
            # (H264 2C/HB2 ou H265 eufyCam3/HB3), lu dans la metadata du flux.
            if self.publisher is None:
                meta = ev.get("metadata") or {}
                codec = str(meta.get("videoCodec") or "H264").upper()
                self._in_fmt = "hevc" if codec in ("H265", "HEVC") else "h264"
                self.publisher = Go2rtcPublisher(GO2RTC_RTSP_URL, in_fmt=self._in_fmt)
                await self.publisher.start()
                self._t_first_frame = now
                startup = now - (self._t_start_ls or now)
                log.info("INSTRUMENT 1ere frame apres %.2fs (latence demarrage L4) ; codec=%s -> -f %s",
                         startup, codec, self._in_fmt)
            # Cadence / détection de gel (L2/L6).
            if self._t_last_frame is not None:
                gap = now - self._t_last_frame
                self._max_gap = max(self._max_gap, gap)
                if gap > 3.0:
                    log.warning("INSTRUMENT trou de %.1fs dans le flux (gel ?)", gap)
            self._t_last_frame = now
            self._frames += 1
            self._bytes += len(chunk)
            if self._frames % 300 == 0:
                dur = now - (self._t_first_frame or now)
                rate = self._frames / dur if dur > 0 else 0
                log.info("INSTRUMENT %d chunks, %.1f chunks/s, %.1f Mo, gap max %.1fs",
                         self._frames, rate, self._bytes / 1e6, self._max_gap)
            ok = await self.publisher.write(chunk)
            if not ok:
                # ffmpeg/go2rtc tombe : on relance le publisher (pas la session ws).
                await self._restart_publisher()
        # 'livestream audio data' : ignore ici (audio gere par go2rtc, cf limites README).

    # ── Session livestream ───────────────────────────────────────────────────
    async def _apply_stream_quality(self):
        """Règle la qualité de streaming caméra (720P par défaut -> transcodage léger).
        Mémorise la valeur d'origine pour la restaurer à l'arrêt. Best-effort (n'échoue jamais)."""
        if not EUFY_STREAM_QUALITY:
            return
        try:
            props = await self._cmd({"command": "device.get_properties",
                                     "serialNumber": EUFY_CAMERA_SERIAL})
            self._orig_quality = props["result"]["properties"].get("videoStreamingQuality")
            target = int(EUFY_STREAM_QUALITY)
            if self._orig_quality != target:
                await self._cmd({"command": "device.set_property",
                                 "serialNumber": EUFY_CAMERA_SERIAL,
                                 "name": "videoStreamingQuality", "value": target})
                await asyncio.sleep(2)
                log.info("qualite streaming %s -> %s (transcodage allege)", self._orig_quality, target)
        except Exception as e:
            log.warning("reglage qualite streaming ignore : %s", e)

    async def _restart_publisher(self):
        log.info("redemarrage du publisher go2rtc")
        if self.publisher is not None:
            await self.publisher.stop()
        self.publisher = Go2rtcPublisher(GO2RTC_RTSP_URL, in_fmt=self._in_fmt or "h264")
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
                await self._apply_stream_quality()

                # Le publisher est lancé PARESSEUSEMENT à la 1ère frame (détection codec).
                self._t_start_ls = time.time()
                await self._cmd({
                    "command": "device.start_livestream",
                    "serialNumber": EUFY_CAMERA_SERIAL,
                })
                self._livestreaming = True
                log.info("livestream demarre pour %s (attente 1ere frame...)", EUFY_CAMERA_SERIAL)

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

        # Restaure la qualité de streaming d'origine (politesse vis-à-vis de l'app Eufy).
        if self._orig_quality is not None and self.ws is not None:
            try:
                await self._cmd({"command": "device.set_property",
                                 "serialNumber": EUFY_CAMERA_SERIAL,
                                 "name": "videoStreamingQuality", "value": self._orig_quality},
                                timeout=10)
            except Exception:
                pass
            self._orig_quality = None

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
            # flock occupe par l'autre integration : on retente plus tard, sans bruit excessif.
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
