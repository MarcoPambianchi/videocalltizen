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

Le shim transcode le H.265 P2P en **H.264** et y multiplexe une piste **audio AAC
silencieuse** (l'audio caméra réel = P5). Cette piste audio est *obligatoire* : l'Ingress
LiveKit fait planter son pipeline GStreamer sur un flux vidéo seul. Le shim intègre aussi
un **watchdog** : si le P2P Eufy gèle (HomeBase qui décroche), il relance automatiquement
la session livestream ; si son ffmpeg meurt, il le relance.

**Ingestion vers l'Ingress = relais ffmpeg (et non le push RTMP natif de go2rtc).** Pour
une source *poussée*, le muxer RTMP de go2rtc produit un FLV que le pipeline GStreamer de
l'Ingress refuse (`could not add bin` → cycle de reconnexion = « En attente de la caméra »).
Le signaling (et `scripts/lib-ingest.sh`) lancent donc un `ffmpeg -i rtsp://go2rtc/salon
-c copy -f flv rtmp://ingress/...` : le muxer FLV de ffmpeg passe sans souci. Validé : flux
720p stable de bout en bout, viewer distant via relais TURN, 0 cycle sur la durée.

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
| **C1** | `eufy-visio` | `bropat/eufy-security-ws` | 3010 (profil `eufy`) | Session Eufy **dédiée** (trusted device distinct de toute autre intégration), expose le livestream P2P | 🟡 écrit, **non branché** (profil off) |
| **C2** | `eufy-shim` | build `./eufy-ingest` (python:3.12-slim) | — (profil `eufy`) | Convertit les octets P2P Eufy en flux exploitable par go2rtc | 🟡 écrit, non testé sur vraie caméra |
| **C3** | `go2rtc` | `alexxit/go2rtc:1.9.14` | 1984, 8554, 8555 | Adaptation média ; source `salon` (synthétique en dev, Eufy en prod) ; ajoute piste OPUS | ✅ opérationnel (synthétique) |
| **C4** | `ingress` | `livekit/ingress:v1.5.0` | 1935 (rtmp), 8085 (whip), 7885-7895/udp | Transforme le flux poussé en **participant** `camera-salon` dans la salle | ✅ testé P1 |
| **C5** | `livekit` (+ `coturn`) | `livekit/livekit-server:v1.9.12` (+ `coturn:4.6-alpine`) | 7880, 7881/tcp, 50000-50019/udp ; TURN 3478/5349 (profil `turn`) | SFU WebRTC ; TURN pour NAT symétrique en prod | ✅ SFU OK ; 🟡 TURN prod uniquement |
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

## 5. Contrainte structurante — slot P2P unique partagé avec une autre intégration

Si la machine héberge **déjà** une autre intégration utilisant **la même caméra Eufy
S350** (ex. domotique/surveillance type Home Assistant) via une brique
`eufy-security-ws` (instance `eufy-security-ws` existante sur un autre port, avec un
trusted device distinct), il faut composer avec cette intégration.

**Le conflit est physique, pas logiciel** : la HomeBase / caméra ne supporte **qu'UN
seul livestream P2P à la fois**. Une telle intégration sérialise typiquement ses accès
via un `flock` et fonctionne souvent en **mode ponctuel** (réveil P2P → snapshot + court
audio → stop). **Une visio tient le flux en continu** : pendant un appel, l'autre
intégration est **aveugle**.

**Décision actée — isolation totale sauf ce point :**

- Répertoire dédié, projet Compose dédié (`visio`),
  réseau dédié, ports libres, units `visio-*`.
- Le **seul** point de contact est le « tap » caméra : une instance
  `eufy-security-ws` **dédiée** (`eufy-visio`, **trusted device distinct**, port
  **3010**), sous profil Docker **`eufy` désactivé par défaut**.
- Conséquence à intégrer dans la signalisation / supervision (C7/C10) : avant
  d'ouvrir le livestream visio, considérer le slot P2P comme **exclusif** ; il faudra
  une coordination explicite avec l'autre intégration (mutex / fenêtre d'appel) au moment
  du branchement réel. Ce point reste **ouvert** tant que le profil `eufy` n'est pas activé.

> **À NE JAMAIS toucher :** les services de l'autre intégration en cours d'exécution,
> son code, son trusted device, son port `eufy-security-ws`.

---

## 6. Cohérence des références

- Budget de latence détaillé : [`LATENCE.md`](LATENCE.md) (notamment le segment P2P
  Eufy du §2.2, à mesurer en P0).
- Boucle acoustique (micro S350 capte la TV) : [`ECHO.md`](ECHO.md) — dépend du fait
  que **capture (cloud) ≠ restitution (TV)**, ce qui casse l'AEC standard.
- Passage en production (TLS, TURN, IP externe, ports) : [`PRODUCTION.md`](PRODUCTION.md).
