# videocalltizen — Visioconférence sur TV Samsung Tizen ⟷ caméra Eufy S350

Permettre à un proche distant d'**appeler en visioconférence** une personne via sa **télévision
Samsung (Tizen)** : la TV **affiche et fait entendre** l'interlocuteur, tandis qu'une **caméra de
surveillance Eufy S350** déjà présente dans la pièce sert de **caméra + micro** de la personne.
**Aucun équipement n'est ajouté** chez la personne, et la TV est en **réception seule**.

Cas d'usage type : un appel familial vers une personne âgée ou peu à l'aise avec la technique — elle
n'a **rien à faire**, la TV décroche toute seule.

> **« Architecture B ».** L'image de la personne est récupérée depuis le **cloud P2P d'Eufy**
> (comportement natif de la caméra), adaptée dans une infrastructure **self-hosted** (go2rtc →
> LiveKit), puis la TV ne fait que **recevoir**. C'est la seule approche possible quand on s'interdit
> d'installer le moindre équipement sur le réseau de la personne, et que la TV ne peut pas capturer de
> vidéo elle-même (impossible sans certificat partenaire Samsung).

> **Statut : preuve de concept construite et testée de bout en bout en local**, avec une **source
> vidéo synthétique** (mire) — aucune caméra réelle n'est nécessaire pour lancer et tester. Le
> branchement de la vraie Eufy S350 est la dernière étape, isolée derrière un profil Docker
> désactivé par défaut.

---

## Comment ça marche

```
caméra Eufy S350 ──P2P (cloud Eufy)──▶ eufy-security-ws ──▶ go2rtc ──▶ LiveKit Ingress ──▶ LiveKit SFU ──┐
                                                                                                        ├─▶ TV Tizen (réception seule)
                                                                                       interlocuteur ◀──┘   + interlocuteur(s) (client web)
```

- **go2rtc** adapte le flux (vidéo H.264 en passthrough, audio transcodé en Opus).
- **LiveKit** (SFU WebRTC self-hosted) route la visio entre la TV, la caméra et le(s) interlocuteur(s).
- L'**app TV Tizen** reçoit en plein écran, **décroche automatiquement**, peut afficher un **contenu
  TV de fond** (repris en fin d'appel) et compose un **écran splitté** quand il y a plusieurs appelants.
- Un **service de signalisation** ajoute la notion d'« appel » (décrochage), absente de LiveKit.

Détail des composants `C1`…`C10` : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Démarrage rapide (local, source synthétique)

**Prérequis :** Docker + Docker Compose v2. *(Pour la suite de tests : Node ≥ 21 et un Chrome/Chromium.)*

```bash
git clone https://github.com/MarcoPambianchi/videocalltizen.git
cd videocalltizen
./scripts/setup.sh     # crée .env (valeurs dev) + active un hook anti-secret
make up                # monte la stack et attend qu'elle soit prête
make test              # suite de tests -> doit afficher « TOUT VERT 🟢 »
```

Tout vert ⇒ la chaîne `go2rtc → Ingress → LiveKit → clients` fonctionne de bout en bout avec une
**mire synthétique**, **sans aucune caméra ni compte**. Pour installer **avec vos propres
identifiants** (caméra, domaine, TURN…), voir **[INSTALL.md](INSTALL.md)**.

## ⚠️ Contrainte clé — un seul flux caméra à la fois

La HomeBase / caméra Eufy ne supporte **qu'UN seul livestream P2P à la fois**. Si vous faites
**aussi** tourner une autre intégration qui exploite la **même caméra** (par exemple une intégration
domotique ou de surveillance type Home Assistant), les deux **ne peuvent pas streamer simultanément** :
il faut les **coordonner**.

Ce projet reste donc **totalement isolé** (projet Compose `visio` dédié, réseau et ports dédiés) et
ne touche la caméra qu'au tout dernier moment, via une **instance `eufy-security-ws` dédiée** sous le
**profil Docker `eufy` désactivé par défaut**. Le mécanisme de coordination (verrou `flock` partagé,
configurable) est décrit dans [eufy-ingest/README.md](eufy-ingest/README.md).

## Services et ports

> Les ports sont choisis hors des plages par défaut courantes. Ajustez-les dans
> [docker-compose.yml](docker-compose.yml) s'ils entrent en conflit avec des services que vous faites
> déjà tourner.

| Service | Composant | Image | Ports (hôte) | Rôle |
|---|---|---|---|---|
| `redis` | — | `redis:7-alpine` | (interne) | backend LiveKit + Ingress |
| `livekit` | C5 | `livekit/livekit-server` | 7880, 7881/tcp, 50000-50019/udp | serveur SFU WebRTC |
| `ingress` | C4 | `livekit/ingress` | 1935 (rtmp), 8085 (whip), 7885-7895/udp | flux → participant |
| `go2rtc` | C3 | `alexxit/go2rtc` | 1984 (api), 8554 (rtsp), 8555 (webrtc) | adaptation média + source synthétique |
| `token-service` | C6 | build local (node) | 9080 | JWT + liens invités + admin LiveKit |
| `signaling` | C7 | build local (node) | 9090 | signalisation d'appel (websocket) |
| `web-client` | C8 | build local (nginx) | 9088 | client interlocuteur (LiveKit JS) |
| `coturn` | C5 (TURN) | `coturn/coturn` | profil `turn` (prod) | relais NAT |
| `eufy-visio` | C1 | `bropat/eufy-security-ws`¹ | profil `eufy` (port 3010) | ingestion Eufy isolée |
| `eufy-shim` | C2 | build local (python) | profil `eufy` | octets P2P → go2rtc |

¹ Image officielle [`bropat/eufy-security-ws`](https://github.com/bropat/eufy-security-ws), surchargeable
via `EUFY_WS_IMAGE` dans `.env`. Service **désactivé par défaut** (profil `eufy`).

`tizen-app/` (C9) et `supervision/` (C10) sont des composants **hors-Compose** (build/sideload de
l'app TV et watchdog).

## Secrets et identifiants

Source **unique** : un fichier **`.env`** (gitignoré, jamais commité), créé par `./scripts/setup.sh`.
LiveKit et l'Ingress lisent leurs clés depuis `.env` (via `LIVEKIT_KEYS` / `INGRESS_CONFIG_BODY` dans
le compose) — **aucun secret réel dans un fichier suivi**. Génération de secrets forts :
`./scripts/gen-keys.sh`. Un hook `pre-commit` empêche de committer un `.env` par accident.
Salle de référence : `salon` ; participant caméra : `camera-salon`.

## Tester

| Script (`make test` les enchaîne) | Vérifie |
|---|---|
| `scripts/test-token.sh` | le token-service émet des JWT valides + un lien invité |
| `scripts/test-p1-ingestion.sh` | `camera-salon` apparaît dans la salle avec vidéo+audio (assert serveur) |
| `scripts/test-p2-media.sh` | un client headless **reçoit et décode** réellement la vidéo via le SFU |
| `scripts/test-signaling.sh` | cycle d'appel complet : décrochage → caméra publiée → raccrochage |
| `scripts/test-browser.sh` | client web (connecté) + app TV (veille/reprise, écran splitté) en Chrome headless |

## État d'avancement

| Étape | Statut |
|---|---|
| Mesure de la latence P2P Eufy réelle | **à faire sur la vraie caméra** (hors build synthétique) |
| Chaîne d'ingestion (go2rtc → Ingress → SFU) | ✅ testée (source synthétique) |
| Client interlocuteur (web) | ✅ token + client web + réception média headless |
| App TV réception (Tizen) | 🟡 écrite + validée en navigateur ; **non testable sans la TV** |
| Signalisation d'appel | ✅ service + tests d'intégration |
| Audio / écho | 🟡 stratégie documentée — voir [docs/ECHO.md](docs/ECHO.md) |
| Durcissement (watchdog, reconnexion, supervision) | 🟡 en place — voir [supervision/RUNBOOK.md](supervision/RUNBOOK.md) |

## Documentation

| Document | Contenu |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Chaîne complète, composants C1–C10, schémas |
| [INSTALL.md](INSTALL.md) | Installation avec vos propres identifiants |
| [docs/MULTIPARTITE.md](docs/MULTIPARTITE.md) | Appels à plusieurs + écran splitté sur la TV |
| [docs/PRISE-EN-MAIN-ECRAN.md](docs/PRISE-EN-MAIN-ECRAN.md) | Contenu TV de fond, prise en main de l'écran, limites Tizen |
| [docs/TV-STANDBY-ET-NUMERO.md](docs/TV-STANDBY-ET-NUMERO.md) | Réveil de la TV (SmartThings) + « numéro d'appel » |
| [docs/ECHO.md](docs/ECHO.md) | Problème d'écho audio et stratégies |
| [docs/LATENCE.md](docs/LATENCE.md) | Budget de latence + méthode de mesure |
| [docs/PRODUCTION.md](docs/PRODUCTION.md) | Bascule dev local → VM cloud (TLS, TURN, ports) |
| [FINDINGS.md](FINDINGS.md) | Constats mesurés (RTMP vérifié, WHIP, versions d'images) |
| [tizen-app/README.md](tizen-app/README.md) | App TV : fond/veille, multipartite, sideload, signature DUID |
| [eufy-ingest/README.md](eufy-ingest/README.md) | Ingestion Eufy : shim P2P → go2rtc + instance dédiée |
| [supervision/RUNBOOK.md](supervision/RUNBOOK.md) | Exploitation, watchdog, dépannage |

## Production (VM cloud)

Même `docker-compose.yml`, en activant le profil `turn` (coturn), en réglant
`rtc.use_external_ip: true` et un domaine + TLS, et en régénérant les secrets (`./scripts/gen-keys.sh`).
Guide complet : [docs/PRODUCTION.md](docs/PRODUCTION.md).

## Licence

[MIT](LICENSE).
