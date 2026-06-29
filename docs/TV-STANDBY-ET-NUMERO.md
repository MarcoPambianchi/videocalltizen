# Réveil du téléviseur depuis la veille & « numéro d'appel »

Réponses techniques honnêtes à deux questions : (A) la TV peut-elle s'allumer toute seule à
l'arrivée d'un appel ? (B) quel est le « numéro d'appel » du téléviseur ?

---

## A. Deux notions de « veille » à ne pas confondre

| | Veille **applicative** (recommandée) | Veille **matérielle** (TV éteinte) |
|---|---|---|
| État TV | **Allumée**, app au premier plan | Écran éteint / standby matériel |
| App Tizen | **Tourne en permanence** (écran de veille : vidéo ambiante + message) | Suspendue / non exécutée |
| Appel entrant | **Auto-décrochage instantané** : la veille est remplacée par l'appel, puis reprise à la fin (déjà implémenté) | L'app ne tourne pas → ne peut pas décrocher |
| Réveil nécessaire | Aucun (déjà allumée) | **Oui — voir ci-dessous** |

L'app implémente déjà la **veille applicative** : auto-décrochage par défaut, remplacement de la
vidéo ambiante par l'appel, reprise à la même position en fin d'appel, et `tizen.power.request`
pour empêcher l'écran de s'éteindre. **C'est le mode « appareil de visio » recommandé** (comme un
Echo Show / Portal) : la TV reste allumée sur l'écran de veille, prête à décrocher en < 1 s.

## A.bis Peut-on allumer la TV depuis la veille MATÉRIELLE (TV éteinte) ?

**Une app web sideloadée ne peut PAS, à elle seule, rallumer la dalle** quand la TV est en standby
matériel : l'app n'est pas exécutée et Tizen n'expose pas d'API tierce pour sortir la TV d'un
standby profond. Les voies réelles, classées par compatibilité avec la contrainte « aucun
équipement ajouté sur le réseau local » :

| Voie | Allume la TV ? | Compatible « zéro équipement local » ? | Verdict |
|---|---|---|---|
| **SmartThings cloud** (compte Samsung + « Network/Mobile Standby » activé) | **Oui** | **Oui** (passe par le cloud Samsung, pas par le LAN) | ✅ **Voie réaliste** |
| HDMI-CEC « One Touch Play » | Oui | **Non** (exige un appareil sur une entrée HDMI) | ❌ exclu par les contraintes |
| Wake-on-LAN / WoWLAN (magic packet) | Oui (si activé) | **Non** (exige un émetteur sur le LAN ; le cloud ne traverse pas le NAT) | ❌ exclu par les contraintes |

**Conclusion :** pour un réveil matériel réellement automatique **sans équipement local**, la seule
voie est **SmartThings** : la TV doit être liée à un compte SmartThings avec le « réveil réseau »
activé ; le service de signalisation (C7) appelle alors l'API SmartThings pour **allumer la TV et
lancer l'app** avant de router l'appel. Cela nécessite le compte Samsung + un jeton OAuth
SmartThings (à fournir) ; c'est une **intégration cloud complémentaire**, à brancher comme le tap
Eufy. En son absence, on retient le **mode appareil** (veille applicative, TV toujours allumée).

### Pré-requis pour que l'app tienne « en permanence »
1. **Auto-lancement au démarrage** de la TV (sideload : définir l'app comme app par défaut / via
   l'outil de déploiement Tizen ; en magasin : configuration partenaire). À valider sur la QN90F.
2. **Désactiver** l'extinction auto / l'économiseur d'écran de la TV (réglages TV).
3. **Verrou d'écran** applicatif (`tizen.power.request("SCREEN","SCREEN_NORMAL")`, déjà en place).
4. **Reconnexion automatique** du WebSocket de signalisation (déjà en place, backoff).

---

## B. Le « numéro d'appel » du téléviseur

Il n'y a pas de numéro de téléphone : la TV est adressée par un **code stable** (son « numéro
d'appel »). Par défaut `TV_CODE = "salon"` (configurable via l'env du service de signalisation).

- **Connaître le numéro :** `GET http://<signaling>:9090/tv` →
  `{ "code": "salon", "name": "Téléviseur du salon", "tvConnected": true, "status": "idle",
     "callUrl": "http://localhost:9088/?call=salon" }`
- **Appeler la TV :** `POST /call {"from":"Marco"}` → la TV « sonne » (ou décroche en mode auto).
  Lien appelant prêt à l'emploi : `callUrl` ci-dessus.
- **Plusieurs téléviseurs :** donner à chacun un `TV_CODE` distinct (ex. `salon`, `chambre`) et un
  service de signalisation par TV (ou un routage par code). Chaque code = un « numéro » différent.

En résumé : le **numéro d'appel = le code de la TV** (`salon`), exposé par `GET /tv`, et on appelle
en POSTant `/call` ou en ouvrant le `callUrl`. Aucun annuaire téléphonique, aucun opérateur.
