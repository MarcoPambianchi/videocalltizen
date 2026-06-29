# ARCHITECTURE — videocalltizen (Architecture B)

Chaîne complète de la visioconférence TV Tizen ⟷ caméra Eufy S350, en **réception
seule** côté domicile, **ingestion via le cloud P2P Eufy**, zéro équipement ajouté
chez la personne.

Ce document est la **carte de référence** ; les autres docs s'y rattachent :
[`LATENCE.md`](LATENCE.md) (budget de bout en bout), [`ECHO.md`](ECHO.md) (boucle
acoustique L5), [`PRODUCTION.md`](PRODUCTION.md) (bascule cloud).

---

## 1. Vue d'ensemble — les deux sens d'un appel

Un appel met en relation **la personne au domicile** (vue par la caméra Eufy S350,
restituée sur sa **TV Tizen**) et **un interlocuteur** (sur un navigateur, mobile ou
PC). Deux flux indépendants circulent :

- **Sens SORTANT** (domicile → interlocuteur) : la caméra S350 capte image + son du
  salon, le flux remonte par le cloud P2P Eufy, est adapté puis injecté dans la SFU
  LiveKit, et l'interlocuteur le reçoit dans son navigateur. **C'est le sens lent**
  (le P2P Eufy domine la latence — voir [`LATENCE.md`](LATENCE.md)).
- **Sens ENTRANT** (interlocuteur → domicile) : la caméra/micro de l'interlocuteur
  publie dans LiveKit (WebRTC natif, rapide), la **TV Tizen** s'abonne et affiche +
  restitue le son par ses haut-parleurs. **C'est le sens rapide.**

La TV n'émet **jamais** : pas de caméra, pas de micro côté domicile autre que la S350.
Le micro « du domicile » est **celui de la caméra Eufy**, capté à distance via le cloud.

---

## 2. Chaîne média — schéma texte

### 2.1 Mode SYNTHÉTIQUE (dérisquage local, actuel)

La source `salon` est une mire animée + tonalité 440 Hz générée par ffmpeg dans
go2rtc. **Aucune caméra réelle n'est sollicitée.** C'est ce qui tourne aujourd'hui.

```
  [ffmpeg lavfi testsrc2+sine]   (source synthétique, dans go2rtc)
            │  RTSP interne (H.264 high@4.2 + AAC→OPUS)
            ▼
  ┌──────────────────┐   POST /api/streams?src=salon&dst=<rtmp ingress>
  │  C3  go2rtc      │ ──────────────────────────────────────────────┐
  │  :1984 / :8554   │                                                │
  └──────────────────┘                                                │
                                                                      ▼ RTMP :1935
                                                          ┌────────────────────────┐
                                                          │  C4  LiveKit Ingress   │
                                                          │  :1935 rtmp / :8085 whip│
                                                          └────────────────────────┘
                                                                      │ participant 'camera-salon'
                                                                      ▼ ws://livekit:7880
                                                          ┌────────────────────────┐
       interlocuteur (navigateur)  ◀── WebRTC ───────────│  C5  LiveKit SFU       │
       C8 web-client :9088                                │  :7880 / :7881 / udp   │──▶ TV Tizen C9
       TV Tizen (réception seule) ◀── WebRTC ─────────────│                        │    (réception)
                                                          └────────────────────────┘
                                                                      ▲
                                       C6 token-service :9080  ───────┘ (JWT, rooms, ingress)
                                       C7 signaling   :9090  (sonnerie / décrochage, websocket)
```

### 2.2 Mode RÉEL Eufy (cible, profil Docker `eufy` désactivé par défaut)

Seule **l'amont** change : la source `salon` de go2rtc n'est plus la mire synthétique
mais le flux poussé par le **shim Eufy**. Tout l'aval (Ingress → SFU → clients) est
**identique** au mode synthétique — c'est tout l'intérêt du dérisquage.

```
  [Caméra Eufy S350] ──P2P chiffré──▶ [Cloud Eufy] ──P2P──▶ ┌─────────────────────┐
                                                            │ C1 eufy-visio       │
                                                            │ eufy-security-ws    │
                                                            │ (instance DÉDIÉE,   │
                                                            │  port 3010)         │
                                                            └─────────────────────┘
                                                                      │ octets P2P (livestream start)
                                                                      ▼
                                                            ┌─────────────────────┐
                                                            │ C2 eufy-shim        │
                                                            │ P2P octets → go2rtc │
                                                            └─────────────────────┘
                                                                      │ flux (remplace la source 'salon')
                                                                      ▼
                                                            ┌─────────────────────┐
                                                            │ C3 go2rtc           │ ── puis IDENTIQUE au §2.1
                                                            └─────────────────────┘
```

Le point critique du sens sortant est le segment **S350 → Cloud Eufy → eufy-visio**
(P2P propriétaire, latence **INCONNUE 0,5–2 s à mesurer en P0**, voir
[`LATENCE.md`](LATENCE.md)).

---

## 3. Table des composants C1..C10

| ID | Service / artefact | Image / build | Port(s) hôte | Rôle | Statut |
|----|--------------------|---------------|--------------|------|--------|
| **C1** | `eufy-visio` | `eufy-security-ws:hb2hb3` | 3010 (profil `eufy`) | Session Eufy **dédiée** (trusted device distinct du Gardien), expose le livestream P2P | 🟡 écrit, **non branché** (profil off) |
| **C2** | `eufy-shim` | build `./eufy-ingest` (python:3.12-slim) | — (profil `eufy`) | Convertit les octets P2P Eufy en flux exploitable par go2rtc | 🟡 écrit, non testé sur vraie caméra |
| **C3** | `go2rtc` | `alexxit/go2rtc:1.9.9` | 1984, 8554, 8555 | Adaptation média ; source `salon` (synthétique en dev, Eufy en prod) ; ajoute piste OPUS | ✅ opérationnel (synthétique) |
| **C4** | `ingress` | `livekit/ingress:v1.5.2` | 1935 (rtmp), 8085 (whip), 7885-7895/udp | Transforme le flux poussé en **participant** `camera-salon` dans la salle | ✅ testé P1 |
| **C5** | `livekit` (+ `coturn`) | `livekit/livekit-server:v1.8.4` (+ `coturn:4.6-alpine`) | 7880, 7881/tcp, 50000-50019/udp ; TURN 3478/5349 (profil `turn`) | SFU WebRTC ; TURN pour NAT symétrique en prod | ✅ SFU OK ; 🟡 TURN prod uniquement |
| **C6** | `token-service` | build `./token-service` (node:20-alpine) | 9080 | JWT (interlocuteur/TV), liens invités, admin rooms + ingress | ✅ testé |
| **C7** | `signaling` | build `./signaling` (node:20-alpine) | 9090 | Sonnerie → décrochage → raccrochage (websocket) | ✅ testé (intégration) |
| **C8** | `web-client` | build `./web-client` (nginx) | 9088 | Client interlocuteur (LiveKit JS, UMD CDN) | ✅ validé navigateur |
| **C9** | `tizen-app` | hors-Compose (sideload TV) | — | App TV **réception seule** (LiveKit JS) | 🟡 écrite, non testable sans TV (validée navigateur) |
| **C10** | `supervision` | hors-Compose | — | Watchdog / reconnexion / units `visio-*` systemd | 🟡 watchdog + runbook |

Backend interne (hors numérotation cahier) : `redis` (`redis:7-alpine`) — état partagé
LiveKit + Ingress, sans port exposé.

---

## 4. Réseau et isolation

- Réseau Docker dédié **`visio`** (projet Compose `visio`). DNS internes :
  `livekit`, `ingress`, `go2rtc`, `token-service`, `signaling`, `redis`.
- LiveKit : interne `ws://livekit:7880` ; public `ws://localhost:7880` (dev) /
  `wss://<domaine>` (prod). Clés API : **uniquement dans `.env`** (lues par
  livekit + ingress via le compose, `LIVEKIT_KEYS` / `INGRESS_CONFIG_BODY`).
- Salle de référence : **`salon`** ; identité participant caméra : **`camera-salon`**.
- Les composants Eufy (C1/C2) et `coturn` sont en `network_mode: host` (profils
  `eufy` / `turn`), donc hors du réseau `visio` ; ils ne sont **jamais** démarrés en dev.

---

## 5. Contrainte structurante — slot P2P unique partagé avec le Gardien

La machine héberge **déjà** le système de surveillance **« Gardien »**, qui exploite
**la même caméra Eufy S350** via une brique `eufy-security-ws` (conteneur actif sur
`ws://127.0.0.1:3000`, trusted device `eufy-mcp`).

**Le conflit est physique, pas logiciel** : la HomeBase / caméra ne supporte **qu'UN
seul livestream P2P à la fois**. Le Gardien sérialise déjà ses accès via un `flock`
(`eufy_client.py`) et fonctionne en **mode ponctuel** (réveil P2P → snapshot + court
audio → stop). **Une visio tient le flux en continu** : pendant un appel, le Gardien
est **aveugle**.

**Décision actée — isolation totale sauf ce point :**

- Répertoire dédié (`/home/marco/videocalltizen`), projet Compose dédié (`visio`),
  réseau dédié, ports libres, units `visio-*`.
- Le **seul** point de contact est le « tap » caméra : une instance
  `eufy-security-ws` **dédiée** (`eufy-visio`, **trusted device distinct**, port
  **3010** ≠ 3000), sous profil Docker **`eufy` désactivé par défaut**.
- Conséquence à intégrer dans la signalisation / supervision (C7/C10) : avant
  d'ouvrir le livestream visio, considérer le slot P2P comme **exclusif** ; il faudra
  une coordination explicite avec le Gardien (mutex / fenêtre d'appel) au moment du
  branchement réel. Ce point reste **ouvert** tant que le profil `eufy` n'est pas activé.

> **À NE JAMAIS toucher :** les services Gardien en cours d'exécution,
> `/home/marco/.openclaw`, le trusted device `eufy-mcp`, le port 3000.

---

## 6. Cohérence des références

- Budget de latence détaillé : [`LATENCE.md`](LATENCE.md) (notamment le segment P2P
  Eufy du §2.2, à mesurer en P0).
- Boucle acoustique (micro S350 capte la TV) : [`ECHO.md`](ECHO.md) — dépend du fait
  que **capture (cloud) ≠ restitution (TV)**, ce qui casse l'AEC standard.
- Passage en production (TLS, TURN, IP externe, ports) : [`PRODUCTION.md`](PRODUCTION.md).
