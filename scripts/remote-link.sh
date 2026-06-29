#!/usr/bin/env bash
# Génère le LIEN d'accès distant (interlocuteur) avec relais TURN.
#
# Donne un lien plein écran, stable hors LAN (via Tailscale + relais coturn). Prérequis :
#   - la stack tourne (make up) et la caméra est ingérée (cf docs/PRODUCTION.md / make eufy-up
#     puis `source scripts/lib-ingest.sh && start_ingestion`) ;
#   - coturn tourne (profil turn) et est joignable sur $HOST.
#
# Réglages via variables d'env (valeurs par défaut = setup local Tailscale) :
#   HOST       IP joignable par le navigateur distant (Tailscale)   [100.126.59.91]
#   TS_PORT    port token-service                                   [9080]
#   WEB_PORT   port client web                                      [9088]
#   WS_PORT    port WebSocket LiveKit                               [7880]
#   TURN_PORT  port coturn                                          [3478]
#   TURN_USER / TURN_PASS  identifiants TURN                        [visio / visioturn2026]
#   ROOM       nom de la salle                                      [salon]
#   TTL        durée de validité du jeton                           [6h]
set -euo pipefail
HOST="${HOST:-100.126.59.91}"
TS_PORT="${TS_PORT:-9080}"; WEB_PORT="${WEB_PORT:-9088}"; WS_PORT="${WS_PORT:-7880}"
TURN_PORT="${TURN_PORT:-3478}"; TURN_USER="${TURN_USER:-visio}"; TURN_PASS="${TURN_PASS:-visioturn2026}"
ROOM="${ROOM:-salon}"; TTL="${TTL:-6h}"; NAME="${NAME:-Interlocuteur}"

token=$(curl -fsS -X POST "http://${HOST}:${TS_PORT}/token" -H 'content-type: application/json' \
  -d "{\"room\":\"${ROOM}\",\"identity\":\"web-$(date +%s 2>/dev/null || echo x)\",\"name\":\"${NAME}\",\"canPublish\":true,\"ttl\":\"${TTL}\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
link="http://${HOST}:${WEB_PORT}/?token=${token}&url=$(enc "ws://${HOST}:${WS_PORT}")&turn=$(enc "turn:${HOST}:${TURN_PORT}")&turnUser=${TURN_USER}&turnPass=$(enc "$TURN_PASS")"

echo "Lien d'accès distant (valide ${TTL}, relais TURN) :"
echo
echo "$link"
