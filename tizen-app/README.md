# C9 — Application TV Samsung Tizen (réception seule)

Application TV **permanente** : affiche un écran de **veille** (vidéo ambiante +
message) au repos, **décroche automatiquement** un appel entrant en **remplaçant**
la veille, affiche le(s) interlocuteur(s) en **grille (multipartite / écran
splitté)**, puis **reprend la veille là où elle s'était arrêtée** en fin d'appel.
Pilotable à la télécommande (flèches, OK, BACK). Audio sur les HP de la TV.

> Réveil de la TV depuis la veille et « numéro d'appel » : voir
> [`../docs/TV-STANDBY-ET-NUMERO.md`](../docs/TV-STANDBY-ET-NUMERO.md).
> Appels à plusieurs / écran splitté : voir [`../docs/MULTIPARTITE.md`](../docs/MULTIPARTITE.md).

**Réception seule** : aucun `getUserMedia`, aucune capture. Donc :
- pas de privilège caméra/micro,
- pas de certificat *partenaire* Samsung,
- seul le privilège `internet` standard est requis.

## Fichiers

| Fichier            | Rôle                                                                 |
|--------------------|----------------------------------------------------------------------|
| `config.xml`       | Manifeste widget Tizen (profil `tv`, privilège `internet`, `access`).|
| `index.html`       | Vidéo plein écran, overlay d'appel, chargement du CDN livekit-client.|
| `js/app.js`        | Signaling WS + cycle d'appel + connexion LiveKit réception seule.    |
| `js/remote.js`     | Mapping keycodes télécommande Samsung + `registerKey` (try/catch).   |
| `css/style.css`    | Plein écran noir, overlay « 10-foot UI » lisible de loin.            |
| `icon/icon.png`    | Icône 117×117 (placeholder).                                         |
| `build.sh`         | Empaquette en `.wgt` (zip). Signature = Tizen Studio (voir plus bas).|

## Stratégie de réception (3 niveaux, par ordre de préférence)

1. **WebRTC web (implémenté ici).** L'app charge `livekit-client` (UMD CDN) dans
   le WebView Tizen et joint la Room LiveKit en réception seule
   (`autoSubscribe` video+audio, token `canPublish=false`). C'est la voie la plus
   simple et la plus portable ; elle se valide aussi dans un navigateur normal.
   *Risque :* le WebView de certaines TV anciennes (Chromium figé) peut avoir un
   support WebRTC/codec partiel (voir limites L7/L12).

2. **API WebRTC native Tizen (`webrtc.h`) — repli si (1) insuffisant.** Si le
   WebView ne décode pas le flux de façon fiable, réimplémenter la réception via
   l'API native C/C++ `webrtc.h` (module natif Tizen) en s'abonnant au même SFU.
   Plus de travail, mais accès direct au décodeur matériel.

3. **HLS via AVPlay — repli ultime.** Si le WebRTC (web ou natif) n'est pas
   viable sur le parc TV, convertir le flux en **HLS** côté serveur (LiveKit
   Egress / go2rtc) et le lire avec **AVPlay** (lecteur natif Tizen, codecs
   matériels garantis). On perd le temps réel (latence HLS de plusieurs
   secondes) — acceptable seulement en dégradé. Le signaling fournirait alors
   une URL HLS au lieu d'un token LiveKit.

## Protocole de signalisation (WS `ws://<host>:9090`, rôle `tv`) — figé avec C7

**TV → signaling :**
```json
{ "type": "register",   "role": "tv", "device": "tv-salon" }
{ "type": "decrocher",  "callId": "<id>", "device": "tv-salon" }
{ "type": "refuser",    "callId": "<id>", "device": "tv-salon" }
{ "type": "raccrocher", "callId": "<id>", "device": "tv-salon" }
```

**signaling → TV :**
```json
{ "type": "registered",    "role": "tv", "state": { } }
{ "type": "appel_entrant", "callId": "<id>", "from": "Marco" }
{ "type": "appel_etabli",  "callId": "<id>", "token": "<jwt>", "wsUrl": "ws://localhost:7880", "room": "salon" }
{ "type": "appel_manque",  "callId": "<id>" }   // sonnerie expirée
{ "type": "appel_termine", "callId": "<id>" }   // raccrochage / fin
{ "type": "erreur",        "message": "..." }
```

Le `token` est émis par **token-service** avec `canPublish:false` (réception
seule) — fait automatiquement par C7 au décrochage.

## Modes de décrochage

- **auto** (auto-answer, **DÉFAUT**) : **AUCUNE sonnerie, aucun overlay, aucune
  action utilisateur** — la TV décroche toute seule dès `appel_entrant` et
  **remplace la veille** par l'appel. (L'état serveur « sonnerie » est un transitoire
  de quelques ms, pas un signal sur la TV.)
- **manuel** : overlay « Appel de X — OK pour décrocher / BACK pour refuser ».

Sélection : `?mode=manuel` ou `?mode=auto`. Sur TV, fixer le mode dans l'URL de lancement.

## Contenu TV de fond + reprise (le fond reprend là où il en était)

Au repos, la TV affiche un **contenu de fond** : par défaut une vidéo de démo,
mais ce peut être un **flux TV LIVE / IPTV / HLS** (`?standby=<URL>&live=1`). À
l'arrivée d'un appel (mode auto), le fond est **masqué et mis en pause** (VOD) ou
laissé au direct (live), l'appel s'affiche ; en fin d'appel, le fond **reprend**
(VOD : **position exacte** ; LIVE : **retour au direct**). `tizen.power.request`
empêche l'extinction de l'écran.

> ⚠️ **Prendre le pas sur Canal+ / une autre app / le tuner** (et non un flux
> embarqué) est un cas distinct soumis à une **limite Tizen** : voir
> [`../docs/PRISE-EN-MAIN-ECRAN.md`](../docs/PRISE-EN-MAIN-ECRAN.md).

## Grille multipartite (écran splitté)

La TV s'abonne à **tous** les participants de la salle et compose une **grille
adaptative** (1=plein écran, 2=côte à côte, 3-4=2×2, n=`ceil(√n)` colonnes), avec
ajout/retrait dynamique des tuiles. La caméra Eufy est l'une des tuiles. Détails :
[`../docs/MULTIPARTITE.md`](../docs/MULTIPARTITE.md).

## Paramètres d'URL (utiles pour la validation navigateur)

| Param         | Défaut                  | Effet                                  |
|---------------|-------------------------|----------------------------------------|
| `host`        | `location.hostname`     | Hôte backend.                          |
| `signaling`   | `ws://<host>:9090`      | URL WS du signaling (surcharge totale).|
| `mode`        | `auto`                  | `auto` (auto-décrochage) ou `manuel`.  |
| `device`      | `tv-salon`              | Identifiant de l'appareil.             |
| `standby`     | `media/standby-sample.mp4` | Flux/fichier de **fond** (HLS/MP4 ; vide = aucun). |
| `live`        | (absent)                | Fond **LIVE** : reprise au **direct** (sinon à la position). |
| `message`     | (vide si flux fourni)   | Message affiché par-dessus le fond.    |

## Touches télécommande

| Touche               | Repos        | Overlay appel        | En appel            |
|----------------------|--------------|----------------------|---------------------|
| OK / Enter (13)      | —            | **Décrocher**        | réaffiche l'indice  |
| BACK / Return (10009)| quitte l'app | **Refuser**          | **Raccrocher**      |
| Flèches G/D          | —            | bascule le focus     | —                   |
| MediaPlayPause       | —            | —                    | réaffiche l'indice  |

`tizen.tvinputdevice.registerKey` est appelé pour les touches média si l'API est
présente (sinon no-op : l'app reste fonctionnelle dans un navigateur).

## Build & sideload

```bash
./build.sh          # produit VisioTvRx0.wgt (NON SIGNÉ)
```

**Signature (obligatoire pour une vraie TV) — via Tizen Studio :**

1. Récupérer le **DUID** (Device Unique ID) de la TV :
   `sdb connect <IP_TV>:26101` puis `sdb shell 0 getduid`.
2. **Certificate Manager** : créer un certificat **auteur** + un certificat
   **distributeur (Samsung TV)** contenant le/les DUID des TV cibles
   (~10 DUID max par profil).
3. Signer : `tizen package -t wgt -s <profil> -- <dossier>` (ou laisser Tizen
   Studio packager+signer).
4. Installer : `sdb connect <IP_TV>:26101` puis
   `tizen install -n VisioTvRx0.wgt -t <device-id>`.

**Expiration du certificat développeur** : le profil développeur/TV expire
(typiquement ~2 ans). À l'expiration, l'app **cesse de démarrer** ; il faut
re-signer puis ré-installer. Noter la date d'échéance du profil.

## Limites du cahier des charges

- **L7 — compatibilité WebView TV.** Le moteur web des TV Tizen est un Chromium
  figé par millésime ; le support WebRTC / les codecs (VP8/VP9/H.264, Opus)
  varie selon le modèle/année. À valider sur la TV cible réelle ; prévoir les
  replis 2 (natif) et 3 (HLS/AVPlay) si le décodage échoue.
- **L12 — non testable sans la TV.** Tant qu'aucune TV physique n'est
  disponible, l'app n'est validée qu'en **navigateur headless** (chargement sans
  erreur, signaling, logique d'appel simulée via `window.VisioTV._simulateIncoming(...)`).
  Le décrochage réel + flux LiveKit + audio HP exigent un test sur matériel.

## Validation navigateur (headless)

L'app se charge sans API `tizen.*` (toutes optionnelles via try/catch). Pour
simuler un appel entrant dans une console navigateur :

```js
window.VisioTV._simulateIncoming("Marco");   // affiche l'overlay
window.VisioTV._state();                       // inspecte l'état interne
```
