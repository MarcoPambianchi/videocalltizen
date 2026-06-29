# C2 — Shim P2P Eufy → go2rtc (`eufy-ingest`)

Lit les octets vidéo **H.264** (et audio) du livestream **P2P** émis par
`eufy-security-ws` sur un websocket, et les pousse vers **go2rtc** (C3), qui adapte
ensuite le flux vers WebRTC/WHIP pour la chaîne Ingress → LiveKit (P1).

> Profil Docker `eufy` (désactivé par défaut). Ce composant est le **seul** point de
> contact avec la **vraie caméra**. Il se branche **en dernier**, après validation de
> toute la chaîne synthétique.

---

## Stratégie : instance dédiée `eufy-visio`

Le shim ne parle **jamais** à l'instance `eufy-security-ws` du Gardien
(`ws://127.0.0.1:3000`, trusted device `eufy-mcp`). Il parle à une instance
**dédiée** `eufy-visio` (`docker-compose.yml`, profil `eufy`), trusted device
**distinct**, sur **`ws://127.0.0.1:3010`** (`EUFY_WS_PORT`). Deux trusted devices
séparés = deux jetons de session Eufy indépendants ; on évite d'invalider la session
du Gardien et réciproquement.

Variables (`.env`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `EUFY_WS_PORT` | `3010` | port du ws `eufy-visio` (instance dédiée) |
| `EUFY_WS_HOST` / `EUFY_WS_URL` | `127.0.0.1` / `ws://…:3010` | hôte / URL ws (override total possible) |
| `EUFY_CAMERA_SERIAL` | *(vide)* | n° de série de la S350 à streamer (**obligatoire**) |
| `GO2RTC_RTSP_URL` | `rtsp://127.0.0.1:8554/salon` | destination RTSP go2rtc (host network) |
| `GO2RTC_STREAM` | `salon` | nom du stream go2rtc cible |
| `EUFY_LIVESTREAM_LOCK` | `…/eufy-perception-mcp/state/livestream.lock` | **flock partagé avec le Gardien** |
| `EUFY_LOCK_TIMEOUT` | `60` | attente max du flock (s) |

En l'absence de `EUFY_CAMERA_SERIAL`, le shim **refuse de démarrer un livestream**
(garde-fou : on ne réveille jamais une caméra inconnue).

---

## Contrainte n°1 : un seul slot P2P, partagé avec le Gardien (flock)

La **HomeBase 2** ne tolère **qu'UN seul livestream P2P à la fois**. Le Gardien
(`eufy-perception-mcp/eufy_client.py`) sérialise déjà ses réveils ponctuels via un
**`flock`** sur `state/livestream.lock`. Le shim **réutilise le même fichier de
verrou** (`EUFY_LIVESTREAM_LOCK`) : tant que la visio tient le flux, le Gardien
attend ; et si le Gardien prend un snapshot, le shim attend (`TimeoutError` →
reconnexion exponentielle).

- **Le conflit est physique, pas logiciel.** Pendant un appel visio, le Gardien est
  **aveugle** (le flux est tenu en continu, contrairement à ses réveils ponctuels).
- Le verrou est **advisory** (`fcntl.flock`) : les deux process doivent l'honorer.
  Le chemin par défaut pointe sur le verrou du Gardien ; il est **configurable** si
  l'intégrateur déplace le fichier (montage volume partagé en conteneur).
- En conteneur (`network_mode: host`), monter le répertoire `state/` du Gardien en
  volume pour que le `flock` soit réellement partagé entre les deux processus.

---

## Ce qu'on a appris de la référence Gardien (lecture seule)

Source : `~/.openclaw/tools/eufy-perception-mcp/eufy_client.py` & `discover.py`.

- **Handshake** : à la connexion, `eufy-security-ws` envoie d'abord une frame
  `version` (à consommer par `recv()`), puis on envoie `set_api_schema`
  (`schemaVersion` **21**) et `start_listening` (renvoie l'état stations/devices).
- **Requêtes / réponses** : chaque commande porte un `messageId` (uuid) ; la réponse
  arrive en `{"type":"result","messageId":…,"success":…,"result":…}`. Un *reader*
  asyncio démultiplexe résultats et événements.
- **Livestream** : `device.start_livestream` / `device.stop_livestream`
  (`serialNumber`). Les octets arrivent en **événements** :
  - `livestream video data` → `ev["buffer"]` = **Node Buffer** sérialisé
    (`{"type":"Buffer","data":[…]}`) → `bytes(...)` (ce sont des octets **bruts
    H.264**, **pas** du base64). La `metadata.videoCodec` indique `H264` (2C/HB2) ou
    `H265` (eufyCam 3/HB3).
  - `livestream audio data` → même format Node Buffer (AAC).
- **Verrou HomeBase 2** : `LIVESTREAM_LOCK = .../state/livestream.lock`, pris en
  `flock(LOCK_EX|LOCK_NB)` en boucle non bloquante (pour ne pas figer l'event loop),
  car « le `_lock` asyncio ne sérialise QUE dans un même process ». C'est exactement
  la contrainte qu'on honore ici.
- **Anti-orphelin (L2)** : le Gardien `proc.kill()` **et** `await proc.wait()` en
  `finally`, et n'utilise jamais `communicate()` quand un feeder alimente `stdin` en
  parallèle. On reprend ce pattern.

---

## Chemin média : passthrough H.264 + audio Opus

```
eufy-visio (ws P2P)  ──H.264 brut──▶  shim.py  ──pipe:0──▶  ffmpeg
                                                              │ -c:v copy (passthrough)
                                                              ▼
                                          rtsp://127.0.0.1:8554/salon  (go2rtc)
                                                              │ ffmpeg:salon#audio=opus
                                                              ▼
                                              WebRTC/WHIP ▶ Ingress ▶ LiveKit
```

- **Vidéo H.264 en passthrough** (`-c:v copy`) : zéro ré-encodage → CPU et latence
  minimaux. ffmpeg lit `-f h264 -i pipe:0` et publie en **RTSP TCP** vers go2rtc.
- **Audio → Opus** : WebRTC exige Opus. La conversion est faite **côté go2rtc**, qui
  dérive déjà une piste `OPUS` de la source `salon`
  (`ffmpeg:salon#audio=opus` dans `go2rtc/go2rtc.yaml`). Le shim publie donc la
  **vidéo** ; l'audio P2P (`livestream audio data`, AAC) est **reçu mais pas encore
  injecté** — voir limites ci-dessous.

### Pourquoi RTSP plutôt que `POST /api/stream?dst=`

go2rtc accepte un *ingest* RTSP standard (`-f rtsp -rtsp_transport tcp`), robuste et
bien supporté, vers un stream existant (`salon` est défini dans `go2rtc.yaml`). C'est
plus fiable que de streamer des octets bruts via l'API HTTP. Override possible via
`GO2RTC_RTSP_URL`.

---

## Robustesse (L1/L2/L3/L8)

- **L1 — réveil P2P coûteux / batterie** : un seul `start_livestream` par session ;
  on tient le flux tant que la visio dure, puis `stop_livestream` **propre** à la
  sortie. Pas de réveils répétés.
- **L2 — pas de ffmpeg orphelin** : `Go2rtcPublisher.stop()` ferme `stdin`, `kill()`
  **puis** `await wait()`. La gestion **broken pipe** (`BrokenPipeError`) n'interrompt
  pas la boucle : elle relance uniquement le *publisher* (ffmpeg), pas la session ws.
- **L3 — déconnexions ws** : `ping_interval=20` (keep-alive) ; toute exception de
  session déclenche une **reconnexion exponentielle** bornée (`1s → 30s`),
  interruptible par `SIGINT`/`SIGTERM`.
- **L8 — contention du slot P2P** : si le `flock` est tenu par le Gardien, la session
  lève `TimeoutError` et retente plus tard (backoff), sans jamais forcer le flux.
- **Arrêt propre** : handlers `SIGINT`/`SIGTERM` → `stop_livestream`, kill ffmpeg,
  fermeture ws, **relâche du flock**.

---

## Parcours MFA / captcha (L9)

L'authentification du compte Eufy peut exiger une **vérification (MFA / e-mail OTP)**
ou un **captcha** au **premier** démarrage d'un nouveau trusted device. Comme
`eufy-visio` est un device **distinct** du Gardien, il déclenche **son propre**
challenge la première fois :

1. Démarrer **seulement** `eufy-visio` (`docker compose --profile eufy up eufy-visio`)
   et suivre ses logs.
2. À la demande de captcha/MFA, répondre via l'API d'`eufy-security-ws`
   (`set_captcha` / `set_verify_code`, selon le challenge émis dans les events
   `captcha request` / `verify code`). Le code arrive par e-mail sur le compte Eufy.
3. Une fois le **trusted device** validé, le jeton de session est persistant : les
   redémarrages suivants n'exigent plus de challenge (sauf invalidation côté Eufy).

> Ne **jamais** réutiliser le trusted device du Gardien (`eufy-mcp`) : un même device
> partagé invaliderait les sessions à tour de rôle.

---

## Limites connues

- **Audio non injecté** : le shim reçoit `livestream audio data` (AAC) mais ne le
  pousse pas encore vers go2rtc (vidéo seule). L'audio Opus actuel provient de la
  source `salon`. Câblage du transcodage AAC→Opus du flux réel = **P5**.
- **H.265 (eufyCam 3 / HB3)** : le shim force `-f h264`. Une S350 en H.264 est OK ;
  pour du H.265, ajouter une détection de `metadata.videoCodec` et basculer `-f hevc`
  (la S350 publie en H.264 sur HomeBase 2 — cas nominal).
- **Latence / qualité P2P (P0)** : non mesurées ici (build synthétique). À valider sur
  la vraie caméra.
- **flock partagé** : suppose que le répertoire `state/` du Gardien est accessible
  (même hôte, ou volume monté). Sinon, ajuster `EUFY_LIVESTREAM_LOCK` vers un chemin
  commun aux deux conteneurs.

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `shim.py` | shim asyncio : ws eufy → ffmpeg → RTSP go2rtc, flock, reconnexion, arrêt propre |
| `requirements.txt` | `websockets` |
| `Dockerfile` | `python:3.12-slim` + `ffmpeg` |
| `test/test_framing.py` | test unitaire (faux serveur ws, publisher monkeypatché, **aucun réseau réel**) |

## Tester

```bash
# Validation syntaxe
python3 -m py_compile shim.py test/test_framing.py

# Test unitaire de framing (stdlib + websockets, AUCUNE vraie caméra)
pip install -r requirements.txt   # si websockets absent
python3 test/test_framing.py
```

> Ne **jamais** lancer le shim contre la vraie caméra avant validation complète de la
> chaîne synthétique. Le build/run Compose est du ressort de l'intégrateur (profil
> `eufy`).
