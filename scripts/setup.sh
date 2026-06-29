#!/usr/bin/env bash
# Prépare un clone pour le développement / l'installation.
set -u
cd "$(dirname "$0")/.."

# 1) Fichier d'environnement local (jamais commité).
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ .env créé depuis .env.example (remplis-y TES identifiants : Eufy, etc.)"
else
  echo "• .env déjà présent (laissé tel quel)"
fi

# 2) Hook anti-fuite de secrets.
if [ -d .git ]; then
  git config core.hooksPath scripts/git-hooks
  chmod +x scripts/git-hooks/* 2>/dev/null || true
  echo "✓ hook pre-commit activé (anti-fuite de secrets)"
fi

chmod +x scripts/*.sh 2>/dev/null || true

cat <<'EOF'

Prochaines étapes :
  1. (Prod / instance exposée) génère des secrets forts :   ./scripts/gen-keys.sh
  2. Remplis tes identifiants dans .env (Eufy, SmartThings…). NE COMMITE JAMAIS .env.
  3. Démarre :                                               make up
  4. Vérifie :                                               make test
Voir INSTALL.md pour l'installation complète avec tes identifiants.
EOF
