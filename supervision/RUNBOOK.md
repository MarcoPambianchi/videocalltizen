# RUNBOOK — supervision videocalltizen (C10)

Exploitation de la stack visio (Architecture B, source synthétique par défaut) et de
son watchdog. Projet Compose : `visio`. Conteneurs nommés `visio-<svc>-1`.

> Rappel d'isolation : ce projet est **totalement séparé** de toute autre intégration
> utilisant la même caméra Eufy S350 (ex. domotique/surveillance type Home Assistant,
> avec ses propres units/services). Ici tout est préfixé `visio-*`. Ne JAMAIS toucher
> aux units/services ni au code de cette autre intégration.

---

## 1. Démarrage / Arrêt

> Les chemins `/opt/videocalltizen` ci-dessous sont un **exemple** — adaptez-les à votre
> installation (ainsi que `User=` et `WorkingDirectory=` dans les units systemd).

### Manuel (dev, source synthétique)
```bash
cd /opt/videocalltizen
cp -n .env.example .env                       # si pas déjà fait
docker compose up -d redis livekit ingress go2rtc token-service signaling web-client
./scripts/wait-ready.sh                        # attend que tout réponde
./scripts/test-p1-ingestion.sh                 # pousse la source synthétique -> 'camera-salon'
```

Lancer le watchdog en avant-plan (debug) :
```bash
python3 /opt/videocalltizen/supervision/watchdog.py
```

Arrêt :
```bash
cd /opt/videocalltizen && docker compose stop
# ou tout supprimer : docker compose down
```

### Via systemd (units fournies)
Les units vivent dans `supervision/systemd/`. Installation (à faire une fois, en root) :
```bash
sudo cp /opt/videocalltizen/supervision/systemd/visio-stack.service /etc/systemd/system/
sudo cp /opt/videocalltizen/supervision/systemd/visio-watchdog.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now visio-stack.service visio-watchdog.service
```

Pilotage :
```bash
systemctl status visio-stack.service visio-watchdog.service
sudo systemctl restart visio-watchdog.service
sudo systemctl stop visio-stack.service          # stoppe la stack (ExecStop = compose stop)
journalctl -u visio-watchdog.service -f          # logs JSON du watchdog
```

> Les units `visio-stack` n'activent **PAS** les profils `eufy`/`turn`. Pour brancher
> la vraie caméra (dernière étape), voir `eufy-ingest/README.md` — hors de ce runbook.

---

## 2. Watchdog — ce qu'il surveille

Boucle toutes les `POLL_INTERVAL` s (défaut 5 s) :

| Maillon | Sonde | Sain si… |
|---|---|---|
| go2rtc (C3)  | `GET http://localhost:1984/api/streams` | source `salon` présente **et** octets en progression |
| ingress (C4) | `GET http://localhost:9080/rooms/salon/participants` | `camera-salon` présent avec ≥1 piste |
| livekit (C5) | `GET http://localhost:7880/` | le SFU répond (tout code HTTP = vivant) |

**Détection FLUX GELÉ** : si le total d'octets de la source `salon` ne progresse plus
pendant `FREEZE_TIMEOUT` s (défaut 15 s), le maillon go2rtc est marqué `frozen` → coupure.

**En cas de coupure** : RETRY exponentiel plafonné (`RETRY_BASE`=2 s → `RETRY_MAX`=60 s).
Chaque tentative relance l'ingestion comme le test P1 :
1. `POST /rooms/salon` (ensure room)
2. `POST /rooms/salon/ingress` → récupère `publishUrl`
3. `POST go2rtc /api/streams?src=salon&dst=<publishUrl encodé>`

Si LiveKit est HS, la relance est **différée** (inutile de ré-ingérer vers un SFU mort).

**Alerte** : log `WARN` dès la 1re coupure, `ERROR` après `ALERT_AFTER` échecs
consécutifs (défaut 5) → échec persistant.

### Endpoint d'état
```bash
curl -s http://localhost:9095/status | python3 -m json.tool
```
Renvoie l'état de chaque maillon, `reconnects` (compteur de reconnexions),
`consecutive_failures`, l'état `freeze`, `uptime_s`. HTTP 200 si sain, 503 sinon.
`GET /healthz` répond toujours 200 tant que le process vit.

### Variables d'environnement (surcharge)
`GO2RTC_URL`, `TOKEN_SERVICE_URL`, `LIVEKIT_URL`, `ROOM_NAME`, `CAMERA_IDENTITY`,
`GO2RTC_STREAM`, `STATUS_PORT` (9095), `POLL_INTERVAL`, `FREEZE_TIMEOUT`,
`HTTP_TIMEOUT`, `RETRY_BASE`, `RETRY_MAX`, `ALERT_AFTER`, `INGRESS_INPUT_TYPE`.

---

## 3. Diagnostic — où regarder

Logs par service (projet Compose `visio`) :
```bash
docker logs --tail 80 visio-livekit-1
docker logs --tail 80 visio-ingress-1
docker logs --tail 80 visio-go2rtc-1
docker logs --tail 80 visio-token-service-1
docker logs --tail 80 visio-signaling-1
docker logs -f        visio-go2rtc-1        # suivi temps réel
```

| Symptôme | Piste |
|---|---|
| watchdog `go2rtc` KO « source absente » | `docker logs visio-go2rtc-1` ; vérifier que ffmpeg (mire synthétique) tourne |
| watchdog `go2rtc` « FLUX GELÉ » | la source ne progresse plus : ffmpeg figé ou consommateur tombé → la relance va re-publier |
| watchdog `ingress` « camera-salon absent » | `docker logs visio-ingress-1` + `POST /rooms/salon/ingress` n'a pas abouti |
| watchdog `livekit` injoignable | `docker logs visio-livekit-1` ; redis sain ? `docker logs visio-redis-1` |
| `/status` injoignable | watchdog mort : `journalctl -u visio-watchdog.service -e` |
| port 9095 occupé | changer `STATUS_PORT` (Environment dans l'unit) |

Vérif manuelle de la chaîne :
```bash
curl -s http://localhost:1984/api/streams | python3 -m json.tool      # go2rtc
curl -s http://localhost:9080/rooms/salon/participants | python3 -m json.tool
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7880/       # livekit vivant
```

---

## 4. Reconnexion manuelle

Si le watchdog n'arrive pas à reconnecter (échec persistant `ERROR`), refaire le P1 à la main :
```bash
cd /opt/videocalltizen
./scripts/test-p1-ingestion.sh        # recrée room + ingress + publish go2rtc
```
Puis redémarrer le watchdog pour repartir d'un backoff neuf :
```bash
sudo systemctl restart visio-watchdog.service
```

Forcer go2rtc à relâcher / republier la source :
```bash
# arrêter la publication
curl -s -X POST 'http://localhost:1984/api/streams?src=salon&dst='
# republier (PUB = publishUrl renvoyé par POST /rooms/salon/ingress)
DST=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],""))' "$PUB")
curl -s -X POST "http://localhost:1984/api/streams?src=salon&dst=$DST"
```

---

## 5. Contrainte slot P2P partagé avec une autre intégration

⚠️ La HomeBase/caméra Eufy S350 ne supporte **qu'UN seul livestream P2P à la fois**.
Toute autre intégration utilisant la même caméra (trusted device distinct) et ce projet
(instance dédiée `eufy-visio`, trusted device distinct, profil Docker `eufy`) se
disputent ce **slot unique**.

- En **dev / source synthétique** (mode par défaut de ce runbook) : **aucun** conflit,
  rien ne touche la caméra réelle. Le watchdog peut tourner en continu sans risque.
- En **prod / profil `eufy` activé** : pendant un appel visio, l'**autre intégration est
  aveugle** (conflit physique, pas logiciel). **Ne pas** activer le profil `eufy` tant
  qu'un réveil de l'autre intégration est en cours, et inversement. Le watchdog ne
  sérialise PAS ce slot — il ne relance que l'ingestion média côté go2rtc/ingress/livekit,
  jamais la session P2P Eufy.
- Avant un appel long en prod : confirmer qu'aucune routine de l'autre intégration ne va
  se déclencher, ou accepter qu'elle soit suspendue pour la durée de l'appel.

---

## 6. Checklist appel long (>= 30 min)

Avant :
- [ ] `./scripts/wait-ready.sh` → tout vert.
- [ ] `curl -s http://localhost:9095/status` → `healthy:true`, `reconnects` noté (base).
- [ ] (prod) profil `eufy` : confirmer le slot P2P libre côté autre intégration (cf. §5).
- [ ] `FREEZE_TIMEOUT` adapté (défaut 15 s convient ; augmenter si réseau lent).

Pendant :
- [ ] `journalctl -u visio-watchdog.service -f` → surveiller `chaine.coupure` / `reconnexion.tentee`.
- [ ] Surveiller le compteur `reconnects` via `/status` : quelques reconnexions = toléré,
      croissance continue = instabilité réseau/CPU à investiguer.
- [ ] Aucun log `ERROR chaine.coupure` persistant (sinon §4 reconnexion manuelle).

Après :
- [ ] Noter le delta `reconnects` et les pics `consecutive_failures`.
- [ ] (prod) arrêter le profil `eufy` pour rendre le slot P2P à l'autre intégration.

---

## 7. Fichiers de ce composant
- `supervision/watchdog.py` — boucle de surveillance + relance + serveur `/status` (stdlib).
- `supervision/requirements.txt` — vide en pratique (stdlib pure ; `requests` optionnel).
- `supervision/systemd/visio-stack.service` — oneshot `docker compose up -d`.
- `supervision/systemd/visio-watchdog.service` — service du watchdog.
- `supervision/RUNBOOK.md` — ce document.
