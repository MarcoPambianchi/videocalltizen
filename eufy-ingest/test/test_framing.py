#!/usr/bin/env python3
"""Test UNITAIRE du framing eufy -> go2rtc (shim.py).

Un faux serveur websocket (asyncio + websockets) rejoue une sequence d'evenements
eufy-security-ws MOCKES : reponses a set_api_schema / start_listening / start_livestream,
puis quelques 'livestream video data' avec des octets bidons. On monkeypatche le
publisher go2rtc (aucun ffmpeg lance) pour capturer les chunks ecrits, et on verifie :
  - _buffer_bytes() decode correctement le Node Buffer JSON ;
  - le shim parse les trames video et appelle write() avec les octets ATTENDUS,
    dans l'ordre ;
  - le filtrage par serialNumber fonctionne (autre camera ignoree) ;
  - aucune connexion reseau reelle, aucune vraie camera (flock -> fichier temporaire).

Dependances : stdlib + websockets uniquement. Lancer :
    python3 test/test_framing.py
"""
import asyncio
import importlib
import json
import os
import socket
import sys
import tempfile
import uuid
from pathlib import Path

import websockets


def _free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ── Donnees mockees ──────────────────────────────────────────────────────────
CAMERA_SERIAL = "T8FAKE0001"
OTHER_SERIAL = "T8FAKE9999"
# 3 chunks video bidons (octets distincts pour verifier l'ordre et l'integrite).
VIDEO_CHUNKS = [bytes([0, 0, 0, 1, 9, 16]), bytes(range(32)), bytes([255] * 10)]
# Un chunk pour une AUTRE camera : doit etre ignore par le shim.
FOREIGN_CHUNK = bytes([1, 2, 3, 4])


def _node_buffer(b):
    """Serialise des bytes comme le fait eufy-security-ws (Node Buffer -> JSON)."""
    return {"type": "Buffer", "data": list(b)}


def _video_event(serial, payload):
    return {
        "type": "event",
        "event": {
            "source": "device",
            "event": "livestream video data",
            "serialNumber": serial,
            "buffer": _node_buffer(payload),
            "metadata": {"videoCodec": "H264"},
        },
    }


async def fake_eufy_server(ws):
    """Rejoue une session eufy-security-ws minimale puis pousse les events video."""
    # 1) frame "version" (le shim fait un recv() initial)
    await ws.send(json.dumps({"type": "version", "driverVersion": "test", "schemaVersion": 21}))

    async def reply(message_id, result=None):
        await ws.send(json.dumps({
            "type": "result", "success": True,
            "messageId": message_id, "result": result or {},
        }))

    livestream_started = asyncio.Event()

    async def push_video():
        await livestream_started.wait()
        await asyncio.sleep(0.05)
        # event pour une AUTRE camera (doit etre filtre)
        await ws.send(json.dumps(_video_event(OTHER_SERIAL, FOREIGN_CHUNK)))
        for chunk in VIDEO_CHUNKS:
            await ws.send(json.dumps(_video_event(CAMERA_SERIAL, chunk)))
            await asyncio.sleep(0.01)

    pusher = asyncio.create_task(push_video())
    try:
        async for raw in ws:
            m = json.loads(raw)
            cmd = m.get("command")
            mid = m.get("messageId")
            if cmd == "set_api_schema":
                await reply(mid)
            elif cmd == "start_listening":
                await reply(mid, {"state": {"stations": [], "devices": []}})
            elif cmd == "device.start_livestream":
                await reply(mid)
                livestream_started.set()
            elif cmd == "device.stop_livestream":
                await reply(mid)
            else:
                await reply(mid)
    except websockets.ConnectionClosed:
        pass
    finally:
        pusher.cancel()


class FakePublisher:
    """Remplace Go2rtcPublisher : capture les chunks, ne lance AUCUN ffmpeg."""
    instances = []

    def __init__(self, rtsp_url, in_fmt="h264"):
        self.rtsp_url = rtsp_url
        self.in_fmt = in_fmt
        self.chunks = []
        self.started = False
        self.stopped = False
        FakePublisher.instances.append(self)

    async def start(self):
        self.started = True

    async def write(self, chunk):
        self.chunks.append(bytes(chunk))
        return True

    async def stop(self):
        self.stopped = True


async def run_test():
    port = _free_port()
    tmp_lock = Path(tempfile.gettempdir()) / f"shim-test-{uuid.uuid4().hex}.lock"

    # Configurer l'env AVANT d'importer shim (les constantes sont lues au chargement).
    os.environ["EUFY_WS_URL"] = f"ws://127.0.0.1:{port}"
    os.environ["EUFY_CAMERA_SERIAL"] = CAMERA_SERIAL
    os.environ["EUFY_LIVESTREAM_LOCK"] = str(tmp_lock)
    os.environ["EUFY_LOCK_TIMEOUT"] = "5"

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import shim as shim_mod
    importlib.reload(shim_mod)

    # 1) test direct du decodeur de Node Buffer
    assert shim_mod._buffer_bytes({"buffer": _node_buffer(b"\x01\x02\x03")}) == b"\x01\x02\x03"
    assert shim_mod._buffer_bytes({"buffer": [10, 20, 30]}) == bytes([10, 20, 30])
    assert shim_mod._buffer_bytes({}) == b""
    assert shim_mod._buffer_bytes({"buffer": None}) == b""

    # 2) monkeypatch du publisher (aucun ffmpeg / aucun go2rtc reel)
    shim_mod.Go2rtcPublisher = FakePublisher
    FakePublisher.instances.clear()

    server = await websockets.serve(fake_eufy_server, "127.0.0.1", port)
    try:
        shim = shim_mod.EufyShim()
        session = asyncio.create_task(shim.run_session())
        # laisser la session se monter et pomper les 3 chunks
        await asyncio.sleep(0.6)
        shim.request_stop()
        await asyncio.wait_for(session, timeout=5)
    finally:
        server.close()
        await server.wait_closed()
        try:
            tmp_lock.unlink()
        except FileNotFoundError:
            pass

    # 3) verifications de framing
    assert FakePublisher.instances, "aucun publisher cree"
    pub = FakePublisher.instances[0]
    assert pub.started, "publisher jamais demarre"
    assert pub.stopped, "publisher jamais arrete (risque d'orphelin)"
    assert pub.chunks == VIDEO_CHUNKS, (
        f"chunks video mal parses/ordonnes.\n  attendu={VIDEO_CHUNKS}\n  recu={pub.chunks}"
    )
    assert FOREIGN_CHUNK not in pub.chunks, "chunk d'une AUTRE camera non filtre"

    print(f"OK — {len(pub.chunks)} chunks video parses et pousses dans l'ordre, "
          f"filtrage serial OK, publisher arrete proprement.")


if __name__ == "__main__":
    asyncio.run(run_test())
