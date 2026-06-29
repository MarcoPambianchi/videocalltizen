# Rapport — construction nocturne autonome (videocalltizen)

**Date :** 2026-06-29 · **Périmètre :** stack de visioconférence Architecture B, **isolée** du système Gardien existant, construite et **testée de bout en bout** en local avec source synthétique.

---

## TL;DR

✅ **Le socle complet est monté et testé vert de bout en bout**, sans jamais toucher ta caméra Eufy ni le Gardien (qui tourne toujours, intact). La chaîne média réelle (go2rtc → Ingress → SFU → abonné) fonctionne ; le cycle d'appel complet (sonnerie → décrochage → token → ingestion → raccrochage) fonctionne ; le client web et l'app TV Tizen se chargent et se connectent.

Ce qui **reste** ne peut PAS être fait sans toi / sans la vraie caméra : **mesure P0** de la latence P2P Eufy réelle, branchement de l'instance `eufy-visio`, signature/sideload sur la vraie TV, et 5 décisions de cadrage (§14 du cahier).

---

## Résultats de tests (tous automatisés, rejouables : `make test`)

| Test | Phase | Résultat |
|---|---|---|
| `test-token.sh` | — | ✅ JWT valides + grant `room=salon` + lien invité |
| `test-p1-ingestion.sh` | **P1** | ✅ `camera-salon` publie vidéo+audio (assert serveur) |
| `test-p2-media.sh` | **P2** | ✅ client headless `@livekit/rtc-node` décode **24 frames vidéo** via le SFU |
| `test-signaling.sh` | **P4** | ✅ cycle complet `register→appel_entrant→decrocher→appel_etabli(token réel)→raccrocher→idle` |
| `test-browser.sh` | **P2/P3** | ✅ web-client (chargé + **connecté à la salle**) ; Tizen (chargé + overlay d'appel) |
| `eufy-ingest/test/test_framing.py` | P1(réel) | ✅ parsing trames H.264 + flock + arrêt propre (mock, **zéro caméra**) |
| watchdog C10 | P6 | ✅ surveille 3 maillons, expose `/status`, **auto-relance** sur coupure |

**Preuve d'isolation :** `docker compose up` ne démarre que les 7 services du socle (profils `eufy`/`turn` OFF). Le Gardien (`eufy-security-ws` Up 6h, units perception/gardien/hue actives, port 3000) est **intact**. Aucune écriture dans `.openclaw` (seul un flock advisory partagé, sous profil désactivé).

---

## Ce qui a été construit (composants C1–C10 du cahier)

| # | Composant | Répertoire | Statut |
|---|---|---|---|
| C3 | go2rtc (adaptation + source synthétique) | `go2rtc/` | ✅ testé |
| C4 | LiveKit Ingress (RTMP testé / WHIP configuré) | compose `INGRESS_CONFIG_BODY` | ✅ RTMP / 🟡 WHIP (voir FINDINGS) |
| C5 | LiveKit SFU + (coturn prod, profil `turn`) | `livekit/`, `coturn/` | ✅ |
| C6 | token-service (JWT + invités + admin) | `token-service/` | ✅ testé |
| C7 | signaling (sonnerie/décrochage) | `signaling/` | ✅ testé E2E |
| C8 | client web interlocuteur | `web-client/` | ✅ validé navigateur |
| C9 | app TV Tizen (réception seule) | `tizen-app/` | 🟡 validé navigateur (TV réelle requise pour P3) |
| C1 | ingestion Eufy dédiée `eufy-visio` | `docker-compose.yml` (profil `eufy`) | 🟡 prêt, non branché |
| C2 | shim P2P → go2rtc | `eufy-ingest/` | 🟡 écrit + unit-test, non branché |
| C10 | supervision/watchdog + units systemd | `supervision/` | ✅ testé |
| docs | architecture, prod, écho, latence | `docs/` | ✅ |

---

## Pour reprendre la main

```bash
cd /home/marco/videocalltizen
make up          # monte le socle (sans Eufy) + attend qu'il soit prêt
make test        # rejoue toute la suite -> doit afficher "TOUT VERT 🟢"
make ps          # état des conteneurs
make logs S=ingress   # logs d'un service
make down        # arrête tout
```

Essayer un appel « à la main » :
1. `make up`
2. Ouvre l'app TV : `python3 -m http.server 9099 --directory tizen-app` puis `http://localhost:9099/?mode=manuel`
3. Déclenche un appel : `curl -X POST http://localhost:9090/call -H 'content-type: application/json' -d '{"from":"Marco"}'`
4. La page TV affiche l'overlay → « Décrocher » → la mire synthétique s'affiche.
5. Côté interlocuteur : `http://localhost:9088/` (saisir un nom → rejoint la salle).

---

## Ce qui reste (nécessite toi / la vraie caméra)

1. **P0 — mesure latence P2P Eufy (priorité absolue, bloquant du cahier).** Brancher `eufy-visio` (`make eufy-up`, ⚠️ touche la vraie caméra et concurrence le Gardien sur l'unique slot P2P), renseigner `EUFY_*` dans `.env`, mesurer la latence sortante réelle. Voir `docs/LATENCE.md`. Si > ~1,5–2 s, rouvrir l'arbitrage d'architecture.
2. **Décisions de cadrage (§14 du cahier)** : mode décrochage (manuel/auto), stratégie anti-écho (O4+O5 par défaut, voir `docs/ECHO.md`), 1-à-1 vs groupe, distribution app TV (sideload vs Seller Office), durée d'appel cible.
3. **App TV sur la vraie QN90F** : `tizen-app/build.sh` → `.wgt` → signer (Certificate Manager, DUID) → sideload. Valider la réception WebRTC réelle (limite L7).
4. **WHIP-bypass** (latence prod) : ajouter un publisher WHIP (ffmpeg ≥7.1 ou gstreamer) — voir `FINDINGS.md`. RTMP marche déjà.
5. **Coordination slot P2P avec le Gardien** : le flock est câblé mais la politique « fenêtre d'appel = Gardien en pause » reste à décider.

---

## Évolutions demandées pendant la nuit (faites + testées)

1. **App TV permanente + veille reprise** (✅ testé navigateur) : l'app affiche au repos une
   **veille** (vidéo ambiante + message), **décroche automatiquement** (mode `auto` par défaut) en
   **remplaçant** la veille, et **reprend la veille EXACTEMENT à la position mémorisée** en fin
   d'appel. `tizen.power.request` empêche l'extinction de l'écran.
2. **Multipartite / écran splitté** (✅ testé navigateur) : la TV affiche les participants en
   **grille adaptative** (1=plein écran, 2=côte à côte, 4=2×2, n=`ceil(√n)` colonnes), tuiles
   ajoutées/retirées dynamiquement. Natif au SFU LiveKit. Voir [docs/MULTIPARTITE.md](docs/MULTIPARTITE.md).
3. **Réveil TV depuis la veille + « numéro d'appel »** (répondu + cadré) : voir
   [docs/TV-STANDBY-ET-NUMERO.md](docs/TV-STANDBY-ET-NUMERO.md). En bref : depuis la **veille
   applicative** (TV allumée) l'auto-décrochage est immédiat ; depuis la **veille matérielle** (TV
   éteinte), une app web ne peut pas rallumer la dalle seule → la seule voie sans équipement local
   est **SmartThings cloud** (à brancher). Le **numéro d'appel = le code TV** (`salon`), exposé par
   `GET /tv` (`callUrl` prêt à l'emploi).

Correctifs de la revue adversariale appliqués : **bug critique** (au décrochage, la publication
go2rtc→ingress n'était pas déclenchée → salle vide) corrigé **et vérifié** ; déconnexion TV en
appel → libération de l'ingress ; reset UI sur erreur ; watchdog **gated sur appel actif**
(plus de reconnexion intempestive ni d'accumulation d'ingress) + DELETE de l'ancien ingress.

## Décisions techniques prises (et pourquoi)

- **RTMP comme chemin d'ingestion vérifié** (go2rtc ne peut pas publier en WHIP — cf `FINDINGS.md`). WHIP-bypass documenté pour la prod.
- **Source synthétique** (mire ffmpeg) pour découpler 90 % du dev de la caméra réelle.
- **Assertion média côté serveur (P1) + client headless rtc-node (P2)** : tests reproductibles sans navigateur ni caméra.
- **Instance `eufy-visio` dédiée** (trusted device distinct), profil Docker désactivé → isolation totale du Gardien à ce stade.
- **Versions d'images figées** : `livekit-server:v1.9.12`, `ingress:v1.5.0`, `go2rtc:1.9.14`, `redis:7-alpine`.
