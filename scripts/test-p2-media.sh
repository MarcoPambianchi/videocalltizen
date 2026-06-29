#!/usr/bin/env bash
# P2 — Preuve média de bout en bout : un client headless reçoit RÉELLEMENT des
# frames vidéo de 'camera-salon' à travers le SFU. Exit 0 = PASS.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
source "$HERE/lib-ingest.sh"

echo "── P2: réception média headless ──"

if [ ! -d "$ROOT/tests/media-check/node_modules" ]; then
  echo "Installation des deps du client de test (une fois)…"
  docker run --rm -v "$ROOT/tests/media-check:/app" -w /app node:20 \
    npm install --no-audit --no-fund --silent || { echo "✗ npm install"; exit 1; }
fi

echo "Démarrage de l'ingestion…"
start_ingestion || exit 1
trap stop_ingestion EXIT

echo "Lancement du client headless (45s max)…"
docker run --rm --network visio -v "$ROOT/tests/media-check:/app" -w /app \
  -e LIVEKIT_WS_URL=ws://livekit:7880 \
  -e LIVEKIT_API_KEY=APIVisioDev \
  -e LIVEKIT_API_SECRET=VkS3cret_dev_0123456789abcdef0123456789 \
  -e ROOM_NAME="$ROOM" -e CAMERA_IDENTITY="$CAM" \
  node:20 node check.mjs
rc=$?
[ $rc -eq 0 ] && echo "✅ P2 PASS" || echo "❌ P2 FAIL (rc=$rc)"
exit $rc
