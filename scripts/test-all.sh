#!/usr/bin/env bash
# Lance toute la suite de tests et imprime un récapitulatif. Sortie 0 si tout vert.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
cd "$ROOT"
declare -a NAMES RESULTS
run() {
  local name="$1"; shift
  echo ; echo "━━━━━━━━━━ $name ━━━━━━━━━━"
  if "$@"; then NAMES+=("$name"); RESULTS+=("✅"); else NAMES+=("$name"); RESULTS+=("❌"); fi
}

bash scripts/wait-ready.sh 60 || { echo "Stack non prête — lancer 'make up' d'abord"; exit 1; }

run "token-service"        bash scripts/test-token.sh
run "P1 ingestion (RTMP)"  bash scripts/test-p1-ingestion.sh
run "P2 média (rtc-node)"  bash scripts/test-p2-media.sh
run "signaling (cycle)"    bash scripts/test-signaling.sh
run "navigateur (web+tv)"  bash scripts/test-browser.sh
run "eufy-shim (unit)"     bash -c 'cd eufy-ingest && python3 test/test_framing.py'

echo ; echo "════════════ RÉCAPITULATIF ════════════"
fail=0
for i in "${!NAMES[@]}"; do
  printf "  %s  %s\n" "${RESULTS[$i]}" "${NAMES[$i]}"
  [ "${RESULTS[$i]}" = "❌" ] && fail=1
done
echo "═══════════════════════════════════════"
[ $fail -eq 0 ] && echo "TOUT VERT 🟢" || echo "DES ÉCHECS 🔴"
exit $fail
