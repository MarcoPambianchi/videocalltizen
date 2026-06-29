# Installation

Deux parcours : **(1)** essai local immédiat (source vidéo synthétique, aucun identifiant), et
**(2)** installation réelle **avec vos propres identifiants** (caméra, domaine, TURN, SmartThings).

> 🔒 **Règle d'or :** tous les secrets vivent dans **`.env`** (gitignoré). Le dépôt ne contient
> **aucun secret réel**. Un hook `pre-commit` empêche de committer `.env` par accident.

## Pré-requis
- Docker + Docker Compose v2
- (facultatif, pour les tests) Node ≥ 21 et un Chrome/Chromium (validation navigateur)

## 1. Essai local immédiat (synthétique)

```bash
git clone https://github.com/MarcoPambianchi/videocalltizen.git
cd videocalltizen
./scripts/setup.sh     # crée .env (valeurs dev) + active le hook anti-secret
make up                # monte le socle + attend qu'il soit prêt
make test              # doit afficher « TOUT VERT 🟢 »
```

La chaîne `go2rtc → Ingress → LiveKit → clients` tourne avec une **mire synthétique** : aucune
caméra, aucun compte requis.

## 2. Installation avec VOS identifiants

### 2.1 Secrets forts (toute instance exposée)
```bash
./scripts/gen-keys.sh   # régénère LIVEKIT_API_KEY/SECRET + TURN_SHARED_SECRET dans .env
make restart
```
livekit-server et l'Ingress lisent ces clés depuis `.env` (via `LIVEKIT_KEYS` /
`INGRESS_CONFIG_BODY` dans `docker-compose.yml`) — **rien à éditer dans un fichier suivi**.

### 2.2 Caméra Eufy réelle (phase P0)
Renseignez dans `.env` : `EUFY_USERNAME`, `EUFY_PASSWORD`, `EUFY_COUNTRY`, `EUFY_CAMERA_SERIAL`.
L'ingestion réelle utilise une **instance Eufy dédiée** (`eufy-visio`, trusted device distinct) sous
le **profil Docker `eufy`**, désactivé par défaut :

```bash
make eufy-up   # ⚠️ ouvre une session sur le compte Eufy réel ; partage l'unique slot P2P S350
```
Voir [eufy-ingest/README.md](eufy-ingest/README.md) (MFA/captcha, flock partagé) et
[docs/LATENCE.md](docs/LATENCE.md) (mesure P0).

### 2.3 App TV Samsung Tizen
Build → signature DUID → sideload : voir [tizen-app/README.md](tizen-app/README.md).
Fond TV (Canal+/IPTV) et prise en main de l'écran : [docs/PRISE-EN-MAIN-ECRAN.md](docs/PRISE-EN-MAIN-ECRAN.md).

### 2.4 Réveil TV / prise en main par-dessus une autre app (SmartThings, optionnel)
Renseignez `SMARTTHINGS_TOKEN`, `SMARTTHINGS_DEVICE_ID` dans `.env`. Contexte et limites :
[docs/TV-STANDBY-ET-NUMERO.md](docs/TV-STANDBY-ET-NUMERO.md) et [docs/PRISE-EN-MAIN-ECRAN.md](docs/PRISE-EN-MAIN-ECRAN.md).

### 2.5 Mise en production (VM cloud, domaine, TLS, TURN)
Réglez `LIVEKIT_PUBLIC_WS_URL=wss://votre-domaine`, activez le profil `turn` (coturn), `use_external_ip`.
Guide complet : [docs/PRODUCTION.md](docs/PRODUCTION.md).

## Sécurité des secrets — ce qui est garanti
- `.env`, `*.bak`, `*.pem`, `*.key`, `secrets/`, `docker-compose.override.yml` sont **gitignorés**.
- Le hook `pre-commit` (activé par `setup.sh`) **refuse** de committer un `.env` ou un secret évident.
- Aucune clé réelle n'est jamais écrite dans un fichier suivi (tout passe par `.env` → variables d'env).
