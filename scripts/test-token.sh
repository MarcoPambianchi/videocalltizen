#!/usr/bin/env bash
# P2 — Vérifie que le token-service émet des JWT valides et des liens invités.
set -u
TS="http://127.0.0.1:9080"
fail() { echo "❌ $1"; exit 1; }

echo "── Test token-service ──"
curl -fsS "$TS/healthz" | grep -q '"ok":true' || fail "healthz"

TOK=$(curl -fsS -X POST "$TS/token" -H 'content-type: application/json' \
  -d '{"room":"salon","identity":"tester","name":"Tester"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
[ -n "$TOK" ] || fail "token vide"
# Un JWT a 3 segments séparés par des points
echo "$TOK" | grep -qE '^[^.]+\.[^.]+\.[^.]+$' || fail "token mal formé"
# Décode le payload et vérifie le grant video.room
echo "$TOK" | python3 -c "
import sys,json,base64
p=sys.stdin.read().strip().split('.')[1]
p+='='*(-len(p)%4)
d=json.loads(base64.urlsafe_b64decode(p))
v=d.get('video',{})
assert v.get('room')=='salon', d
assert v.get('roomJoin') in (True,1), d
print('  grant OK:', v)
" || fail "grant invalide"

INV=$(curl -fsS "$TS/invite?name=Mamie" | python3 -c "import sys,json;print(json.load(sys.stdin).get('link',''))")
echo "$INV" | grep -q 'token=' || fail "lien invité sans token"
echo "  lien invité: ${INV:0:70}…"

echo "✅ token-service OK"
