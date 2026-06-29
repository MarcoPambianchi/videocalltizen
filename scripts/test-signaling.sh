#!/usr/bin/env bash
# Test d'intégration C7 contre les conteneurs réels. Node >= 21 requis.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
NODE="$(command -v node 2>/dev/null)"
[ -n "$NODE" ] || NODE=$(ls /home/marco/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)
[ -n "$NODE" ] || { echo "node introuvable"; exit 1; }
"$NODE" "$ROOT/tests/signaling-check/check.mjs"
