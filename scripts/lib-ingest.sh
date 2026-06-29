#!/usr/bin/env bash
# Helpers partagés : démarrer/arrêter l'ingestion (go2rtc -> ingress) via un relais
# FFMPEG (RTSP -> FLV). Le push RTMP NATIF de go2rtc produit un FLV que le pipeline
# GStreamer de l'Ingress refuse ("could not add bin") -> cycle infini ; le muxer FLV
# de ffmpeg passe. Même mécanisme que le signaling de production (cf go2rtcPublish).
TS="${TS:-http://127.0.0.1:9080}"
G2="${G2:-http://127.0.0.1:1984}"
ROOM="${ROOM_NAME:-salon}"
CAM="${CAMERA_IDENTITY:-camera-salon}"
RTSP="${RTSP_URL:-rtsp://127.0.0.1:8554/salon}"
RELAY_PID_FILE="${RELAY_PID_FILE:-/tmp/visio-ingest-relay.pid}"

_jq() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

# start_ingestion -> exporte INGRESS_ID ; relaie la source vers l'ingress (ffmpeg FLV)
start_ingestion() {
  curl -fsS -X POST "$TS/rooms/$ROOM" >/dev/null
  local ing pub hostpub
  ing=$(curl -fsS -X POST "$TS/rooms/$ROOM/ingress" -H 'content-type: application/json' \
        -d "{\"inputType\":\"rtmp\",\"identity\":\"$CAM\"}")
  pub=$(echo "$ing" | _jq "d['publishUrl']")
  INGRESS_ID=$(echo "$ing" | _jq "d['ingressId']")
  [ -n "$pub" ] || { echo "publishUrl vide" >&2; return 1; }
  # publishUrl est en-réseau (host 'ingress') ; depuis l'hôte on cible le port publié.
  hostpub="${pub/\/\/ingress:/\/\/127.0.0.1:}"
  ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "$RTSP" -c copy -f flv "$hostpub" \
    >/dev/null 2>&1 &
  echo $! > "$RELAY_PID_FILE"
  echo "ingestion démarrée (ingressId=$INGRESS_ID, relais ffmpeg pid=$(cat "$RELAY_PID_FILE"))"
}

stop_ingestion() {
  [ -f "$RELAY_PID_FILE" ] && { kill "$(cat "$RELAY_PID_FILE")" 2>/dev/null || true; rm -f "$RELAY_PID_FILE"; }
  [ -n "${INGRESS_ID:-}" ] && curl -fsS -X DELETE "$TS/ingress/$INGRESS_ID" >/dev/null 2>&1 || true
}
