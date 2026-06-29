#!/usr/bin/env bash
# Helpers partagés : démarrer/arrêter l'ingestion synthétique (source go2rtc -> ingress).
TS="${TS:-http://127.0.0.1:9080}"
G2="${G2:-http://127.0.0.1:1984}"
ROOM="${ROOM_NAME:-salon}"
CAM="${CAMERA_IDENTITY:-camera-salon}"

_jq() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
_enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }

# start_ingestion -> exporte INGRESS_ID ; pousse la source synthétique vers l'ingress RTMP
start_ingestion() {
  curl -fsS -X POST "$TS/rooms/$ROOM" >/dev/null
  local ing pub
  ing=$(curl -fsS -X POST "$TS/rooms/$ROOM/ingress" -H 'content-type: application/json' \
        -d "{\"inputType\":\"rtmp\",\"identity\":\"$CAM\"}")
  pub=$(echo "$ing" | _jq "d['publishUrl']")
  INGRESS_ID=$(echo "$ing" | _jq "d['ingressId']")
  [ -n "$pub" ] || { echo "publishUrl vide" >&2; return 1; }
  curl -fsS -X POST "$G2/api/streams?src=$ROOM&dst=$(_enc "$pub")" >/dev/null
  echo "ingestion démarrée (ingressId=$INGRESS_ID)"
}

stop_ingestion() {
  curl -fsS -X POST "$G2/api/streams?src=$ROOM&dst=" >/dev/null 2>&1 || true
  [ -n "${INGRESS_ID:-}" ] && curl -fsS -X DELETE "$TS/ingress/$INGRESS_ID" >/dev/null 2>&1 || true
}
