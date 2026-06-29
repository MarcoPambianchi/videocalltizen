#!/usr/bin/env bash
# build.sh — Empaquette l'app TV Tizen (C9) en archive .wgt (= zip de widget).
#
# IMPORTANT — SIGNATURE :
#   Ce script produit un .wgt NON SIGNÉ. Tizen exige une signature pour le
#   sideload sur une vraie TV. La signature réelle ne se fait PAS ici mais via
#   Tizen Studio (Certificate Manager) :
#
#     1. Récupérer le DUID de la TV (Device Unique ID) :
#        - sur la TV : menu Développeur / Device Info, ou via `sdb` :
#            sdb connect <IP_TV>:26101
#            sdb shell 0 getduid          (ou : 0 cat /opt/etc/duid-gadget ...)
#     2. Tizen Studio > Tools > Certificate Manager :
#        - créer un certificat AUTEUR (author) + un certificat DISTRIBUTEUR
#          (distributor "Samsung TV"), en y inscrivant le ou les DUID des TV
#          ciblées (jusqu'à ~10 DUID par profil).
#     3. Signer le .wgt avec ce profil :
#            tizen package -t wgt -s <profil_certif> -- <dossier_ou_wgt>
#        ou laisser Tizen Studio packager+signer le projet directement.
#     4. Sideload :
#            sdb connect <IP_TV>:26101
#            tizen install -n VisioTvRx0.wgt -t <device-id>   (ou sdb push + pkgcmd)
#
#   RAPPEL — EXPIRATION : le certificat développeur Samsung TV expire (typiquement
#   sous ~2 ans). Une fois expiré, l'app installée cesse de démarrer et doit être
#   re-signée puis ré-installée. Noter la date d'expiration du profil.
#
#   Comme l'app est en RÉCEPTION SEULE (privilège 'internet' uniquement, aucune
#   capture caméra), AUCUN privilège partenaire ni certificat partenaire Samsung
#   n'est requis : un certificat développeur lié au DUID suffit.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME="VisioTvRx0"
OUT="${APP_DIR}/${PKG_NAME}.wgt"

# Fichiers à inclure dans le widget.
INCLUDE=(
  "config.xml"
  "index.html"
  "css"
  "js"
  "icon"
)

# Vérifie la présence des fichiers requis.
for f in config.xml index.html; do
  if [[ ! -f "${APP_DIR}/${f}" ]]; then
    echo "ERREUR : ${f} manquant." >&2
    exit 1
  fi
done

# Validation syntaxe légère avant packaging (best-effort).
if command -v xmllint >/dev/null 2>&1; then
  xmllint --noout "${APP_DIR}/config.xml" && echo "[ok] config.xml bien formé"
fi
if command -v node >/dev/null 2>&1; then
  for js in "${APP_DIR}"/js/*.js; do
    node --check "$js" && echo "[ok] $(basename "$js")"
  done
fi

# Génère le .wgt (zip standard, sans compression du config.xml en premier
# n'est pas requis pour Tizen, contrairement à OCF ; un zip simple convient).
rm -f "$OUT"
( cd "$APP_DIR" && zip -r -X "$OUT" "${INCLUDE[@]}" \
    -x '*.DS_Store' -x '*/.*' >/dev/null )

echo "[wgt] créé : $OUT (NON SIGNÉ)"
echo "      -> signer via Tizen Studio Certificate Manager (DUID) avant sideload."
