#!/usr/bin/env bash
# P1 — Chaîne d'ingestion synthétique de bout en bout.
#   source synthétique (go2rtc) -> RTMP -> LiveKit Ingress -> SFU
#   Assertion CÔTÉ SERVEUR : le participant 'camera-salon' apparaît avec une piste vidéo.
# Aucune caméra réelle sollicitée. Sortie 0 = PASS.
set -u
TS="http://127.0.0.1:9080"
G2="http://127.0.0.1:1984"
ROOM="${ROOM_NAME:-salon}"
CAM="${CAMERA_IDENTITY:-camera-salon}"
JQ() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

echo "── P1: ingestion synthétique → $ROOM ──"

echo "1/4 Création de la salle…"
curl -fsS -X POST "$TS/rooms/$ROOM" >/dev/null || { echo "✗ createRoom"; exit 1; }

echo "2/4 Création de l'ingress RTMP…"
ING=$(curl -fsS -X POST "$TS/rooms/$ROOM/ingress" \
  -H 'content-type: application/json' \
  -d "{\"inputType\":\"rtmp\",\"identity\":\"$CAM\"}") || { echo "✗ createIngress"; exit 1; }
echo "$ING" | python3 -m json.tool
PUB=$(echo "$ING" | JQ "d['publishUrl']")
IID=$(echo "$ING" | JQ "d['ingressId']")
[ -n "$PUB" ] || { echo "✗ publishUrl vide"; exit 1; }

cleanup() {
  curl -fsS -X POST "$G2/api/streams?src=$ROOM&dst=" >/dev/null 2>&1 || true
  [ -n "${IID:-}" ] && curl -fsS -X DELETE "$TS/ingress/$IID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "3/4 go2rtc publie la source '$ROOM' vers l'ingress…"
DST=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$PUB")
curl -fsS -X POST "$G2/api/streams?src=$ROOM&dst=$DST" >/dev/null || { echo "✗ go2rtc publish"; exit 1; }

echo "4/4 Attente du participant '$CAM' avec piste vidéo (60s)…"
deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  P=$(curl -fsS "$TS/rooms/$ROOM/participants" 2>/dev/null) || { sleep 2; continue; }
  HAS=$(echo "$P" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for p in d.get('participants',[]):
    if p['identity']=='$CAM':
        kinds={ (t.get('type')) for t in p.get('tracks',[]) }
        # type 1 = VIDEO, 0 = AUDIO dans le protobuf LiveKit
        print('video' if (1 in kinds or 'VIDEO' in kinds) else 'novideo', len(p.get('tracks',[])))
        break
else:
    print('absent',0)
")
  echo "    état: $HAS"
  set -- $HAS
  if [ "$1" = "video" ]; then
    echo "✅ P1 PASS — '$CAM' publie une piste vidéo (tracks=$2)"
    exit 0
  fi
  sleep 2
done
echo "❌ P1 FAIL — '$CAM' n'a pas publié de vidéo dans le délai"
echo "Diag ingress :"; docker logs --tail 40 visio-ingress-1 2>/dev/null || true
exit 1
