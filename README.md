# videocalltizen — Visioconférence TV Tizen ⟷ caméra Eufy S350 (Architecture B)

Stack **indépendante** de visioconférence, conforme au cahier des charges « Architecture B »
(ingestion via cloud P2P Eufy, TV en réception seule, zéro équipement ajouté chez la personne).

> **Statut :** squelette de dérisquage construit et testé **en local** avec une **source vidéo
> synthétique** (aucune caméra réelle sollicitée). Le branchement de la vraie Eufy S350 est la
> dernière étape, isolée derrière un profil Docker désactivé par défaut.

---

## ⚠️ Contrainte structurante n°1 — ressource caméra partagée

Cette machine héberge **déjà** un système de surveillance domicile « **Gardien** » qui exploite la
**même caméra Eufy S350** via le **même type de brique `eufy-security-ws`** (conteneur déjà actif
sur `ws://127.0.0.1:3000`, trusted device dédié `eufy-mcp`).

La HomeBase / caméra ne supporte **qu'UN seul livestream P2P à la fois** (le code du Gardien le
sérialise déjà via un `flock`, cf. `eufy_client.py`). Le Gardien fonctionne en mode **ponctuel**
(1 réveil P2P → snapshot + court audio → stop). **Une visio tient le flux en continu** ⇒ pendant un
appel, le Gardien est aveugle. **Ce conflit est physique, pas logiciel.**

**Décision projet (actée) :** ce projet est **totalement isolé** du Gardien — répertoire dédié,
projet Compose dédié (`visio`), réseau dédié, ports libres, units `visio-*`. Le seul point de
contact possible est le « tap » caméra, branché **en dernier** via une **instance
`eufy-security-ws` dédiée** (`eufy-visio`, trusted device distinct, port 3010), sous profil
Docker `eufy` **désactivé par défaut**. Voir [`eufy-ingest/README.md`](eufy-ingest/README.md).

---

## Cartographie des services et des ports

Tous les ports ci-dessous ont été choisis pour **ne croiser aucun** des ~80 ports déjà occupés sur
la machine (Gardien, GeminiFit, OpenClaw, neo4j, searxng, telegram-bot-api, etc.).

| Service | Composant cahier | Image | Ports (hôte) | Rôle |
|---|---|---|---|---|
| `redis` | — | `redis:7-alpine` | (interne) | backend LiveKit + Ingress |
| `livekit` | C5 (SFU) | `livekit/livekit-server` | 7880, 7881/tcp, 50000-50019/udp | serveur SFU WebRTC |
| `ingress` | C4 | `livekit/ingress` | 1935 (rtmp), 8085 (whip), 7885-7895/udp | flux → participant |
| `go2rtc` | C3 | `alexxit/go2rtc` | 1984 (api), 8554 (rtsp), 8555 (webrtc) | adaptation média + source synthétique |
| `token-service` | C6 | build local (node) | 9080 | JWT + liens invités + admin LiveKit |
| `signaling` | C7 | build local (node) | 9090 | sonnerie / décrochage (websocket) |
| `web-client` | C8 | build local (nginx) | 9088 | client interlocuteur (LiveKit JS) |
| `coturn` | C5 (TURN) | `coturn/coturn` | profil `turn` (prod) | relais NAT |
| `eufy-visio` | C1 (dédié) | `eufy-security-ws:hb2hb3` | profil `eufy` (port 3010) | ingestion Eufy isolée |
| `eufy-shim` | C2 | build local (python) | profil `eufy` | P2P octets → go2rtc |

`tizen-app/` (C9) et `supervision/` (C10) sont des composants hors-Compose (build/sideload TV et
watchdog).

## Identifiants média (dev)

Source de vérité **unique** : [`.env`](.env.example) (copié depuis [`.env.example`](.env.example),
**non commité**). LiveKit et l'Ingress lisent leurs clés depuis `.env` (via `LIVEKIT_KEYS` /
`INGRESS_CONFIG_BODY` dans le compose) — **aucun secret dans un fichier suivi**. Pour la prod :
`./scripts/gen-keys.sh`. Salle de référence : `salon` ; participant caméra : `camera-salon`.
Installation détaillée : [INSTALL.md](INSTALL.md).

---

## Démarrer (local, source synthétique)

```bash
cp .env.example .env
docker compose up -d --build redis livekit ingress go2rtc token-service
./scripts/wait-ready.sh          # attend que tous les services répondent
./scripts/test-p1-ingestion.sh   # P1 : pousse la source synthétique -> assert participant 'camera-salon'
```

Tout vert ⇒ la chaîne **go2rtc → Ingress → LiveKit** fonctionne de bout en bout, sans toucher l'Eufy.

## Tester

| Script | Phase | Vérifie |
|---|---|---|
| `scripts/wait-ready.sh` | — | tous les services up |
| `scripts/test-p1-ingestion.sh` | P1 | `camera-salon` apparaît avec piste vidéo+audio (assert côté serveur) |
| `scripts/test-p2-media.sh` | P2 | un client headless **reçoit réellement** des octets média de `camera-salon` |
| `scripts/test-token.sh` | P2 | token-service émet des JWT valides + lien invité |
| `scripts/test-signaling.sh` | P4 | cycle sonnerie → décrochage → raccrochage |

## Phases (cahier §12)

| Phase | Statut local |
|---|---|
| P0 mesures Eufy (latence P2P réelle) | **à faire sur la vraie caméra** (hors build synthétique) |
| P1 chaîne d'ingestion | ✅ testée (synthétique) |
| P2 client interlocuteur | ✅ token + client web + assert média headless |
| P3 app TV réception | 🟡 app Tizen écrite, non testable sans la TV (validée navigateur) |
| P4 signalisation d'appel | ✅ service + tests d'intégration |
| P5 audio / écho | 🟡 stratégie O4+O5 câblée + documentée (§8 cahier) |
| P6 durcissement | 🟡 watchdog + reconnexion + units systemd + runbook |

## Documentation

| Document | Contenu |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Chaîne complète C1–C10, schémas (synthétique + Eufy réel) |
| [docs/MULTIPARTITE.md](docs/MULTIPARTITE.md) | Appels à plusieurs + écran splitté sur la TV |
| [docs/PRISE-EN-MAIN-ECRAN.md](docs/PRISE-EN-MAIN-ECRAN.md) | Fond TV (Canal+/IPTV), prise en main de l'écran, limites Tizen |
| [docs/TV-STANDBY-ET-NUMERO.md](docs/TV-STANDBY-ET-NUMERO.md) | Réveil de la TV (SmartThings) + « numéro d'appel » |
| [docs/ECHO.md](docs/ECHO.md) | Problème d'écho audio (L5) et stratégies O1–O5 |
| [docs/LATENCE.md](docs/LATENCE.md) | Budget de latence + méthode de mesure P0 |
| [docs/PRODUCTION.md](docs/PRODUCTION.md) | Bascule dev local → VM cloud (TLS, TURN, ports) |
| [FINDINGS.md](FINDINGS.md) | Constats mesurés (RTMP vérifié, WHIP, versions d'images) |
| [RAPPORT.md](RAPPORT.md) | Rapport de construction + état des phases |
| [tizen-app/README.md](tizen-app/README.md) | App TV : fond/veille, multipartite, sideload, signature DUID |
| [eufy-ingest/README.md](eufy-ingest/README.md) | Shim P2P Eufy → go2rtc + instance dédiée |
| [supervision/RUNBOOK.md](supervision/RUNBOOK.md) | Exploitation, watchdog, dépannage |

## Licence

[MIT](LICENSE).

## Production (VM cloud, plus tard)

Même `docker-compose.yml`, en activant le profil `turn` (coturn) et en réglant
`rtc.use_external_ip: true` + domaine/TLS. Voir [`docs/PRODUCTION.md`](docs/PRODUCTION.md).
