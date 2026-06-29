# Constats techniques mesurés (build local, source synthétique)

Faits établis par test réel sur cette machine — à distinguer des hypothèses du cahier.

## ✅ Chaîne d'ingestion prouvée (RTMP)
`source synthétique (go2rtc) → RTMP → LiveKit Ingress → SFU → abonné` fonctionne de bout en bout.
- **P1** (`scripts/test-p1-ingestion.sh`) : `camera-salon` apparaît dans la salle avec pistes vidéo+audio (assertion serveur).
- **P2** (`scripts/test-p2-media.sh`) : un client headless `@livekit/rtc-node` reçoit et **décode 21 frames vidéo** via le SFU.

## ⚠️ WHIP-bypass : nécessite un publisher dédié
- **go2rtc ne peut PAS publier en WHIP** : `POST /api/streams?src=…&dst=http://…` → `unsupported scheme: http://`. L'API `dst` de go2rtc ne gère que RTSP/RTMP en sortie.
- Le chemin **WHIP-bypass** du cahier (latence minimale, vidéo H.264 sans ré-encodage) reste valable mais impose un **publisher WHIP** distinct lisant le RTSP de go2rtc :
  - `ffmpeg ≥ 7.1` (muxer `whip`) — **l'hôte a ffmpeg 6.1**, donc image dédiée ou VM prod ≥7.1 ;
  - ou `gstreamer` `whipsink`.
- L'endpoint WHIP de l'Ingress est `http://ingress:8085/w/<streamKey>` (exposé par `token-service` dans `publishUrl` pour ce futur publisher).
- **Décision** : RTMP = chemin par défaut **vérifié** (transcodage Ingress, L13). WHIP-bypass = optimisation latence documentée, à activer en prod avec un publisher ffmpeg7.1/gstreamer. Le surcoût CPU RTMP est négligeable en 1‑à‑1.

## Ingress : URL retournée vide en local
`CreateIngress` renvoie `url=""` (pas de `rtmp_base_url`/`whip_base_url` configuré). On reconstruit l'URL interne côté `token-service` :
- RTMP : `rtmp://ingress:1935/x/<streamKey>` (validé) ;
- WHIP : `http://ingress:8085/w/<streamKey>`.
En prod, renseigner `rtmp_base_url`/`whip_base_url` dans la config Ingress (`INGRESS_CONFIG_BODY` du compose) pour des URLs publiques correctes.

## Versions d'images figées (testées)
- `livekit/livekit-server:v1.9.12`, `livekit/ingress:v1.5.0`, `alexxit/go2rtc:1.9.14`, `redis:7-alpine`.
- Tags initialement faux corrigés : `ingress:v1.5.2` et `livekit-server:v1.8.4` n'existent pas.

## P0 — mesures sur une VRAIE caméra (Indoor Cam S350, modèle T8416)
Mesuré avec [`eufy-ingest/measure_p0.py`](eufy-ingest/measure_p0.py) sur une S350 réelle (instance dédiée `eufy-visio`) :

| Mesure | Résultat |
|---|---|
| Alimentation | **secteur** (S350 pan-tilt intérieure) → streaming continu OK (L14 levé) |
| Latence de démarrage (cmd → 1ʳᵉ frame) | **~0,3 s** (bien mieux que les ~5 s redoutés, L4) |
| Stabilité (plus grand trou inter-frame) | **~0,3 s**, aucun gel sur 25 s (L2) |
| Coupure prématurée | **non** sur 25 s (L1 à confirmer sur plus long) |
| **Codec vidéo** | **H.265 (HEVC), 4K (3840×2160)** |
| Cadence / débit | ~15 chunks/s, ~2,5 Mbit/s |

**Conséquence architecture majeure :** le flux est **H.265**, or **WebRTC ne supporte pas le HEVC**
(aucun navigateur). Le « passthrough H.264 » du cahier ne s'applique donc PAS : il faut **transcoder
H.265 → H.264** (et **downscaler** le 4K vers 720p/1080p — souhaitable pour une visio) avant LiveKit.
Coût : CPU + ~100-300 ms (L13). La détection de codec du shim (`metadata.videoCodec`) gère H264/H265.

Reste à mesurer : latence **steady-state** sens sortant (L3 — glass-to-glass en filmant une horloge)
et **durée max** de session (L1 — test long). L'instance `eufy-visio` est dédiée (trusted device
distinct) et indépendante de toute autre intégration utilisant la même caméra.
