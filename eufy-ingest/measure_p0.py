#!/usr/bin/env python3
"""P0 — instrument de mesure du flux P2P Eufy (latence de demarrage, codec, cadence, stabilite).

Se connecte a l'instance DEDIEE eufy-security-ws (eufy-visio, ws://127.0.0.1:3010 par defaut),
demarre un livestream sur EUFY_CAMERA_SERIAL pendant N secondes, et rapporte :
  - latence de DEMARRAGE (commande start_livestream -> 1ere frame video) ;
  - codec reel (H264 / H265) lu dans la metadata ;
  - cadence (chunks/s), octets, plus grand TROU inter-frame (gel/jitter) ;
  - si le flux a ete COUPE prematurement (duree max de session) ;
  - quelques JPEG sauves (hors repo) pour controle visuel + mesure glass-to-glass.

La latence STEADY-STATE (sens sortant L3) se mesure en filmant une horloge (cf docs).
Aucune valeur en dur ; tout via l'env. Usage : python3 measure_p0.py [duree_s]
"""
import asyncio, json, os, sys, time, uuid
import websockets

WS = os.environ.get("EUFY_WS_URL", "ws://127.0.0.1:3010")
SERIAL = os.environ.get("EUFY_CAMERA_SERIAL", "").strip()
DURATION = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
OUTDIR = os.environ.get("P0_OUTDIR", "/tmp/p0-frames")


def buf_bytes(ev):
    b = ev.get("buffer")
    if isinstance(b, dict) and isinstance(b.get("data"), list):
        return bytes(b["data"])
    if isinstance(b, list):
        return bytes(b)
    return b""


async def main():
    if not SERIAL:
        print("EUFY_CAMERA_SERIAL non defini"); sys.exit(2)
    os.makedirs(OUTDIR, exist_ok=True)
    ws = await websockets.connect(WS, max_size=None, ping_interval=20)
    waiters = {}
    st = {"first": None, "frames": 0, "bytes": 0, "last": None, "maxgap": 0.0, "codec": None,
          "cut": False, "ff": None}

    async def cmd(c, timeout=30):
        mid = uuid.uuid4().hex
        fut = asyncio.get_event_loop().create_future(); waiters[mid] = fut
        await ws.send(json.dumps({**c, "messageId": mid}))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            waiters.pop(mid, None)

    async def reader():
        async for raw in ws:
            m = json.loads(raw)
            if m.get("type") == "result":
                f = waiters.get(m.get("messageId"))
                if f and not f.done():
                    f.set_result(m)
            elif m.get("type") == "event":
                ev = m["event"]
                if ev.get("event") != "livestream video data":
                    continue
                if ev.get("serialNumber") and ev["serialNumber"] != SERIAL:
                    continue
                chunk = buf_bytes(ev)
                if not chunk:
                    continue
                now = time.time()
                if st["first"] is None:
                    st["first"] = now
                    st["codec"] = ev.get("metadata", {}).get("videoCodec") or "H264"
                    infmt = "hevc" if str(st["codec"]).upper() in ("H265", "HEVC") else "h264"
                    st["ff"] = await asyncio.create_subprocess_exec(
                        "ffmpeg", "-hide_banner", "-loglevel", "error",
                        "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err",
                        "-f", infmt, "-i", "pipe:0", "-vf", "fps=1", "-q:v", "3",
                        f"{OUTDIR}/frame-%03d.jpg",
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                if st["last"] is not None:
                    st["maxgap"] = max(st["maxgap"], now - st["last"])
                st["last"] = now; st["frames"] += 1; st["bytes"] += len(chunk)
                ff = st["ff"]
                if ff and ff.stdin:
                    try:
                        ff.stdin.write(chunk); await ff.stdin.drain()
                    except Exception:
                        pass

    await ws.recv()  # frame version
    rt = asyncio.create_task(reader())
    await cmd({"command": "set_api_schema", "schemaVersion": 21})
    await cmd({"command": "start_listening"})
    t_cmd = time.time()
    await cmd({"command": "device.start_livestream", "serialNumber": SERIAL})
    print(f"start_livestream envoye sur {SERIAL} ; mesure pendant {DURATION:.0f}s…")

    deadline = time.time() + DURATION
    while time.time() < deadline:
        await asyncio.sleep(1)
        if st["last"] and time.time() - st["last"] > 8:
            st["cut"] = True
            print("⚠️  flux coupe (>8s sans frame) — fin anticipee")
            break

    try:
        await cmd({"command": "device.stop_livestream", "serialNumber": SERIAL}, timeout=10)
    except Exception:
        pass
    if st["ff"]:
        try:
            st["ff"].stdin.close()
        except Exception:
            pass
        try:
            await asyncio.wait_for(st["ff"].wait(), 5)
        except Exception:
            try:
                st["ff"].kill(); await st["ff"].wait()
            except Exception:
                pass
    rt.cancel()
    try:
        await ws.close()
    except Exception:
        pass

    startup = (st["first"] - t_cmd) if st["first"] else None
    span = (st["last"] - st["first"]) if st["first"] and st["last"] else 0
    nframes = len(os.listdir(OUTDIR)) if os.path.isdir(OUTDIR) else 0
    print("\n════════ RAPPORT P0 ════════")
    print(f"  latence DEMARRAGE (cmd -> 1ere frame) : {f'{startup:.2f}s' if startup else 'AUCUNE FRAME RECUE'}")
    print(f"  codec video                            : {st['codec']}")
    print(f"  chunks recus                           : {st['frames']}" +
          (f"  ({st['frames']/span:.1f}/s sur {span:.0f}s)" if span > 0 else ""))
    print(f"  debit                                  : {st['bytes']/1e6:.1f} Mo")
    print(f"  plus grand trou (gel/jitter)           : {st['maxgap']:.2f}s")
    print(f"  flux coupe prematurement               : {'OUI' if st['cut'] else 'non'}")
    print(f"  frames JPEG sauvees                     : {nframes} dans {OUTDIR}")
    print("════════════════════════════")
    if startup is None:
        print("→ AUCUNE frame : verifier la cam (en ligne ?), le serial, ou reessayer.")
    else:
        print("→ latence STEADY-STATE (sens sortant L3) = a mesurer en filmant une horloge (cf runbook).")


if __name__ == "__main__":
    asyncio.run(main())
