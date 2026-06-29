#!/usr/bin/env bash
# Génère des secrets FORTS et uniques dans .env (LiveKit + TURN).
# À lancer AVANT toute mise en service réelle : ne JAMAIS réutiliser les valeurs
# « dev » publiques du dépôt sur une instance exposée.
set -u
cd "$(dirname "$0")/.."

[ -f .env ] || { cp .env.example .env; echo "→ .env créé depuis .env.example"; }

rand() { # rand <n> : n caractères alphanumériques aléatoires
  head -c $(( $1 * 3 )) /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"
}

KEY="API$(rand 13)"
SECRET="$(rand 48)"
TURN="$(rand 44)"

upd() { # upd CLE VALEUR (remplace ou ajoute dans .env)
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

cp .env .env.bak   # sauvegarde (gitignorée)
upd LIVEKIT_API_KEY "$KEY"
upd LIVEKIT_API_SECRET "$SECRET"
upd TURN_SHARED_SECRET "$TURN"

echo "✓ Secrets régénérés dans .env (sauvegarde: .env.bak) :"
echo "    LIVEKIT_API_KEY=$KEY"
echo "    LIVEKIT_API_SECRET=<48 car.>"
echo "    TURN_SHARED_SECRET=<44 car.>"
echo "→ Relance la stack pour appliquer : make restart"
