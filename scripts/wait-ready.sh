#!/usr/bin/env bash
# Attend que tous les services du socle répondent. Sortie 0 = prêt, 1 = timeout.
set -u
TIMEOUT="${1:-90}"
deadline=$(( $(date +%s) + TIMEOUT ))

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
ko() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

http_ready() { curl -fsS -o /dev/null --max-time 3 "$1" 2>/dev/null; }
tcp_ready()  { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&- ; }

wait_for() { # nom  type  cible
  local name="$1" type="$2" target="$3"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$type" = http ]; then http_ready "$target" && { ok "$name"; return 0; }
    else tcp_ready "$target" && { ok "$name"; return 0; }; fi
    sleep 1
  done
  ko "$name (timeout)"; return 1
}

echo "Attente des services (timeout ${TIMEOUT}s)…"
rc=0
wait_for "livekit (7880)"        http "http://127.0.0.1:7880/"            || rc=1
wait_for "go2rtc (1984)"         http "http://127.0.0.1:1984/api/streams" || rc=1
wait_for "token-service (9080)"  http "http://127.0.0.1:9080/healthz"     || rc=1
wait_for "ingress rtmp (1935)"   tcp  "1935"                              || rc=1
wait_for "ingress whip (8085)"   tcp  "8085"                              || rc=1
exit $rc
