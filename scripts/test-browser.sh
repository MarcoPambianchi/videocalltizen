#!/usr/bin/env bash
# Validation navigateur headless (chrome) du web-client (C8) et de l'app Tizen (C9).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
NODE="$(command -v node 2>/dev/null)"; [ -n "$NODE" ] || NODE=$(ls $HOME/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)
NPM="$(command -v npm 2>/dev/null)"; [ -n "$NPM" ] || NPM=$(ls $HOME/.nvm/versions/node/*/bin/npm 2>/dev/null | head -1)
[ -n "$NODE" ] || { echo "node introuvable"; exit 1; }

if [ ! -d "$ROOT/tests/browser-check/node_modules" ]; then
  echo "Installation de puppeteer-core (une fois)…"
  ( cd "$ROOT/tests/browser-check" && PUPPETEER_SKIP_DOWNLOAD=1 "$NPM" install --no-audit --no-fund --silent ) || { echo "✗ npm install"; exit 1; }
fi

# Sert l'app Tizen statique (hors Compose) le temps du test.
python3 -m http.server 9099 --directory "$ROOT/tizen-app" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1

"$NODE" "$ROOT/tests/browser-check/check.mjs"
