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

## Rappel contrainte caméra (non testée ici — synthétique)
La latence P2P Eufy (L3) et la durée max de session (L1) ne sont **mesurables que sur la vraie caméra** (phase P0, hors build synthétique). L'instance `eufy-visio` dédiée partage l'unique slot P2P de la S350 avec le Gardien.
