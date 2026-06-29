# PRODUCTION — bascule du dev local (WSL) vers la VM cloud

Ce document décrit le passage de la stack `videocalltizen` de l'environnement de
**dérisquage local (WSL, source synthétique)** vers une **VM cloud** exposée sur
Internet, avec domaine, TLS et relais TURN. La chaîne et les composants sont décrits
dans [`ARCHITECTURE.md`](ARCHITECTURE.md).

> **Principe :** on **réutilise le même** [`docker-compose.yml`](../docker-compose.yml).
> La prod = dev + activation du profil `turn` + IP externe réelle + TLS + clés
> régénérées. Aucune réécriture de service.

---

## 1. Cible matérielle

- **Fournisseur** : Exoscale ou Infomaniak (UE/CH, RGPD).
- **Dimensionnement** : **4 cœurs** si on garde le **transcodage Ingress** (RTMP →
  WebRTC, chemin robuste). 2 cœurs peuvent suffire en WHIP bypass strict, mais **4
  cœurs recommandés** pour absorber le transcodage + go2rtc + SFU. RAM ≥ 4 Go.
- **Réseau** : **IP publique fixe** (ou enregistrement DNS mis à jour). Indispensable
  pour les candidats WebRTC et le TURN.

---

## 2. Domaine et TLS (Let's Encrypt)

1. Pointer un domaine (ex. `visio.example.com`) vers l'**IP publique** de la VM
   (enregistrement A, + AAAA si IPv6).
2. Obtenir un certificat **Let's Encrypt** pour ce domaine.
   - Option simple : un **reverse-proxy TLS** (Caddy / Traefik / nginx) en façade qui
     termine le HTTPS et le **WSS** vers LiveKit (`:7880`) et sert le web-client.
   - Le **WebSocket LiveKit doit être servi en `wss://`** (sinon un navigateur en HTTPS
     refusera le ws non sécurisé — *mixed content*).
3. **coturn** réutilise les **mêmes certificats** Let's Encrypt pour le TURNS (TLS
   `:5349`) — voir §4.
4. Renouvellement auto Let's Encrypt à prévoir (cron/timer du proxy ou certbot).

> **Important `wss://` :** la TV Tizen (C9) et le web-client (C8) en HTTPS exigent
> `LIVEKIT_PUBLIC_WS_URL=wss://visio.example.com`. C'est la variable la plus
> structurante de la bascule (§5).

---

## 3. `rtc.use_external_ip` et candidats WebRTC

En dev, `use_external_ip: false` (machine derrière NAT/WSL, candidats loopback).
En **prod** :

- **LiveKit** ([`livekit/livekit.yaml`](../livekit/livekit.yaml)) :
  ```yaml
  rtc:
    use_external_ip: true
  ```
  pour que la SFU annonce l'**IP publique** dans ses candidats ICE.
- **Ingress** (bloc `INGRESS_CONFIG_BODY` du [`docker-compose.yml`](../docker-compose.yml)) :
  passer `use_external_ip: true` et **retirer** `enable_loopback_candidate: true`
  (utile seulement en boucle locale dev).
- **go2rtc** ([`go2rtc/go2rtc.yaml`](../go2rtc/go2rtc.yaml)) : remplacer le candidat
  `127.0.0.1:8555` par l'**IP publique** (ou `stun:`), si on expose go2rtc en WebRTC
  direct (sinon non requis quand tout passe par Ingress/SFU).

---

## 4. TURN (profil `turn` / coturn)

Activer le relais TURN, **indispensable** pour les interlocuteurs derrière **NAT
symétrique** (réseaux mobiles 4G/5G, certains pros).

1. **Démarrer le profil** : `docker compose --profile turn up -d coturn`
   (`coturn` est en `network_mode: host`, profil `turn`, désactivé par défaut).
2. **Configurer** [`coturn/turnserver.conf`](../coturn/turnserver.conf) :
   - `realm=visio.example.com` (votre domaine).
   - `static-auth-secret=<NOUVEAU SECRET TURN>` ← **à régénérer** (§5).
   - Décommenter et renseigner :
     ```
     cert=/etc/letsencrypt/live/visio.example.com/fullchain.pem
     pkey=/etc/letsencrypt/live/visio.example.com/privkey.pem
     external-ip=<IP_PUBLIQUE>
     ```
   - Monter le répertoire Let's Encrypt en volume dans le service `coturn`.
3. **Déclarer le TURN à LiveKit** pour qu'il le distribue aux clients. Deux voies :
   - section `turn:` intégrée de LiveKit (cf. bloc commenté dans `livekit.yaml`), **ou**
   - configuration des `ice_servers` côté clients pointant `turn:visio.example.com:3478`
     / `turns:visio.example.com:5349` avec credentials dérivés du secret partagé.
   Le **secret TURN doit être identique** entre `turnserver.conf` et la config qui
   génère les credentials (LiveKit / token-service).
4. **Plage de relais coturn** : `min-port=49160` / `max-port=49200` (déjà fixée) — à
   **ouvrir au pare-feu** (§6).

> ⚠️ **Piège auth** : ne mélangez pas `use-auth-secret` (secret partagé, mode prod
> ci-dessus) et `user=`/`lt-cred-mech` (identifiants statiques) dans la **même** conf —
> le secret partagé écrase l'auth user (`Cannot find credentials of user`) et le relais
> ne s'alloue jamais. Choisissez un seul mode.

### 4.bis Test d'accès distant en LOCAL (Tailscale, sans domaine/TLS)

Pour valider l'accès hors-LAN **avant** la VM cloud, on relaie via Tailscale + coturn en
**auth statique** (pas de secret partagé). Ce setup vit dans des fichiers **gitignorés** :
`docker-compose.override.yml` (monte une conf locale + lance coturn) et
`coturn/turnserver.local.conf` (`lt-cred-mech` + `user=visio:...`, `listening-ip=<IP
Tailscale>`, `relay-ip=172.20.0.1`). Générer le lien interlocuteur prêt à l'emploi :

```bash
HOST=<IP_Tailscale> bash scripts/remote-link.sh   # imprime un lien plein écran via TURN
```

Le client web lit `?turn=&turnUser=&turnPass=` et force `iceTransportPolicy: "relay"`.
En prod cloud (IP publique, candidats WebRTC directs) ce détour TURN local n'est plus
nécessaire pour les clients non-NAT-symétrique.

---

## 5. Variables / secrets à changer (NE PAS garder les valeurs dev)

> Les valeurs dev (`APIVisioDev`, `VkS3cret_dev_...`, `turnSharedSecret_dev_...`) sont
> **publiques de fait** (commitées dans les exemples). **Toutes** doivent être
> régénérées pour la prod.

| Élément | Où | Action |
|---------|----|--------|
| **Clé API LiveKit** (`APIVisioDev`) | [`.env`](../.env) `LIVEKIT_API_KEY` (lu par livekit + ingress via le compose) | **régénérer** : `./scripts/gen-keys.sh` |
| **Secret LiveKit** (`VkS3cret_dev_...`) | [`.env`](../.env) `LIVEKIT_API_SECRET` | **régénérer** : `./scripts/gen-keys.sh` |
| **URL WS publique** | [`.env`](../.env) `LIVEKIT_PUBLIC_WS_URL` | `wss://visio.example.com` (était `ws://localhost:7880`) |
| **Secret TURN** | [`.env`](../.env) `TURN_SHARED_SECRET` · [`coturn/turnserver.conf`](../coturn/turnserver.conf) `static-auth-secret` | **régénérer**, identique aux 2 |
| **Realm TURN** | [`.env`](../.env) `TURN_REALM` · `turnserver.conf` `realm` | `visio.example.com` |
| **WEB_CLIENT_URL** (token-service) | env du service / [`.env`](../.env) | `https://visio.example.com` |
| Identifiants **Eufy** | [`.env`](../.env) `EUFY_*` | renseigner (instance dédiée, **trusted device distinct** `eufy-visio`, port 3010 — jamais le trusted device/port d'une autre intégration) |

Régénérer en une commande : `./scripts/gen-keys.sh` (ou `openssl rand -hex 32`).

> **Source unique LiveKit** : `.env`. livekit-server et l'Ingress lisent leurs clés depuis
> `.env` (via `LIVEKIT_KEYS` / `INGRESS_CONFIG_BODY` dans le compose) — aucun secret dans
> un fichier suivi. En cas de 401 : vérifier `.env` puis `make restart`.

---

## 6. Ouverture des ports (pare-feu VM / security group)

| Port(s) | Proto | Usage |
|---------|-------|-------|
| **443** | tcp | HTTPS + **WSS** LiveKit (via reverse-proxy) |
| **80** | tcp | HTTP → redirection 443 + challenge ACME Let's Encrypt |
| **7881** | tcp | LiveKit ICE/TCP (fallback WebRTC) |
| **3478** | udp (+tcp) | TURN (STUN/relais) |
| **5349** | tcp | TURNS (TURN sur TLS) |
| **50000-50019** | udp | LiveKit SFU — média WebRTC |
| **7885-7895** | udp | Ingress WHIP — média |
| **49160-49200** | udp | coturn — plage de relais (cf. `turnserver.conf`) |
| **1935** | tcp | RTMP Ingress (si publication RTMP externe) |

Notes :
- Si **go2rtc/Ingress publient en interne** (go2rtc pousse vers `ingress` sur le réseau
  `visio`), **1935 n'a pas besoin d'être exposé publiquement** — ne l'ouvrir que si une
  source RTMP **externe** publie. Principe du moindre port.
- Les ports d'**API internes** (`9080` token-service, `9090` signaling, `1984` go2rtc,
  `9088` web-client direct) **ne doivent PAS être exposés** publiquement : ils passent
  derrière le reverse-proxy / restent privés.
- **Ne jamais** exposer le port **3010** (eufy-visio) — ni le port `eufy-security-ws`
  d'une autre intégration — sur Internet.

---

## 7. Profil Eufy en prod

L'activation du profil `eufy` (vraie caméra) suit les mêmes règles qu'en local et reste
**la dernière étape**, soumise à la contrainte du **slot P2P unique partagé avec toute
autre intégration utilisant la même caméra** ([`ARCHITECTURE.md`](ARCHITECTURE.md) §5).
En prod comme en dev, une visio tient le flux en continu ⇒ **coordination explicite avec
l'autre intégration** requise avant d'activer. `eufy-visio` reste sur un **trusted device
distinct** (`eufy-visio`, port **3010**), jamais le trusted device/port d'une autre
intégration.

---

## 8. Checklist de bascule

```
[ ] VM provisionnée (4 cœurs si transcodage), IP publique fixe
[ ] DNS A (+AAAA) visio.example.com → IP publique
[ ] Reverse-proxy TLS installé ; certificat Let's Encrypt obtenu (443/80)
[ ] Renouvellement Let's Encrypt automatisé
[ ] Secrets régénérés : `./scripts/gen-keys.sh` (LiveKit + TURN dans .env) ; secret TURN reporté dans turnserver.conf
[ ] .env : LIVEKIT_PUBLIC_WS_URL = wss://visio.example.com
[ ] .env : WEB_CLIENT_URL = https://visio.example.com ; TURN_REALM = domaine
[ ] livekit.yaml : rtc.use_external_ip: true
[ ] compose INGRESS_CONFIG_BODY : use_external_ip: true ; enable_loopback_candidate retiré
[ ] go2rtc.yaml : candidat 127.0.0.1:8555 → IP publique (si WebRTC direct exposé)
[ ] coturn/turnserver.conf : realm, secret, cert/pkey/external-ip décommentés
[ ] coturn : volume Let's Encrypt monté ; profil 'turn' démarré
[ ] TURN déclaré aux clients (section turn LiveKit OU ice_servers)
[ ] Pare-feu : 443,80,7881/tcp ; 3478/udp ; 5349/tcp ; 50000-50019/udp ;
    7885-7895/udp ; 49160-49200/udp ; 1935/tcp (si RTMP externe)
[ ] Ports internes (9080,9090,1984,9088,3010) NON exposés publiquement
[ ] Test P1 (synthétique) sur la VM : participant 'camera-salon' apparaît
[ ] Test P2 : interlocuteur reçoit le média en wss:// depuis l'extérieur
[ ] Test interlocuteur derrière NAT mobile (4G) → vérifie le relais TURN
[ ] (dernier) profil 'eufy' : coordination avec l'autre intégration (slot P2P), puis P0 latence réelle
```

Une fois la stack synthétique validée sur la VM (P1/P2 en `wss://` depuis l'extérieur),
le branchement Eufy réel et les mesures P0 ([`LATENCE.md`](LATENCE.md)) / écho
([`ECHO.md`](ECHO.md)) peuvent commencer.
