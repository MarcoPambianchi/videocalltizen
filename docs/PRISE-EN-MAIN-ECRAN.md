# Prise en main de l'écran TV pendant un appel (Canal+, flux TV en cours…)

**Besoin :** la TV affiche normalement un **flux TV** (Canal+, IPTV, tuner…). À l'arrivée d'un
appel, l'app visio doit **passer au premier plan** ; à la fin (tout le monde a raccroché), la TV
doit **reprendre le flux précédent**.

C'est techniquement **deux problèmes très différents** selon ce qu'est ce « flux TV ». Soyons clairs
(comme pour le réveil matériel : certaines choses ne sont pas franchissables par une app sideloadée).

---

## Cas A — le flux de fond est lu PAR l'app visio (IPTV / HLS) ✅ traité

Si le contenu de fond est un **flux que l'app peut jouer** (URL **IPTV / HLS / MP4**), alors l'app
visio est l'**unique application au premier plan** et affiche ce flux comme **fond** ; l'appel le
**remplace**, puis le **fond reprend** à la fin. **C'est déjà implémenté et testé :**

```
# Lancer l'app TV avec un flux LIVE de fond (retour au direct après l'appel) :
index.html?standby=https://exemple/flux.m3u8&live=1&message=
# …ou un contenu VOD de fond (reprise EXACTE à la position) :
index.html?standby=https://exemple/film.mp4
```

| Paramètre | Effet |
|---|---|
| `?standby=<URL>` | Flux/fichier de fond (HLS `.m3u8`, MP4…). Vide = pas de fond. |
| `?live=1`        | Fond **LIVE** : à la reprise, retour au **DIRECT** (bord live), pas à un horodatage. |
| `?message=`      | Texte par-dessus le fond (vide par défaut quand un vrai flux est fourni). |

Comportement : appel entrant → **auto-décrochage**, le fond est **mis en pause** (VOD) ou laissé au
direct (live) et **masqué**, l'appel s'affiche (grille multipartite) ; fin d'appel → le fond
**réapparaît** et **reprend** (VOD : position exacte ; LIVE : au direct).

➡️ **C'est la voie recommandée** : faire de l'app visio l'**application TV principale** (mode
« appareil »), avec le flux TV embarqué en fond. La prise en main et la reprise sont alors **100 %
gérées par l'app**, sans dépendre du système.

---

## Cas B — le flux vient d'une AUTRE app (l'app Canal+) ou du TUNER (broadcast) ⚠️ limite

Si le contenu est la **vraie application Canal+** (une autre app Tizen) ou la **chaîne du
tuner/satellite/câble** (source broadcast de la TV), alors :

> **Une app web sideloadée NE PEUT PAS se mettre d'elle-même au premier plan par-dessus une autre
> application ou le broadcast en cours.** Tizen interdit à une app tierce (surtout sideloadée, sans
> **certificat partenaire** Samsung) de s'auto-lancer au premier plan ou d'interrompre l'app/source
> active. Il n'existe pas d'API publique « interrompre ce qui joue et affiche-moi ».

Voies réelles pour ce cas, classées par compatibilité avec « zéro équipement local » :

| Voie | Prend la main sur une autre app/broadcast ? | Sans équipement local ? | Verdict |
|---|---|---|---|
| **SmartThings cloud** (lance l'app visio à distance + restaure la source ensuite) | **Oui** | **Oui** (cloud Samsung) | ✅ voie réaliste (à valider sur la TV) |
| Certificat **partenaire** Samsung (privilèges overlay/launch) | Oui | Oui | ❌ exclu par le cahier (§11) |
| HDMI-CEC / appareil externe | Oui | **Non** | ❌ exclu (équipement local) |

**Solution réaliste (cas B) — SmartThings, en miroir du réveil TV :**
1. À l'`appel_entrant` (ou `decrocher`), le **service de signalisation (C7)** appelle l'API
   **SmartThings** : *« lance l'app VisioTvRx0 »* (la met au premier plan, par‑dessus Canal+).
2. L'app décroche en auto et affiche l'appel.
3. À la fin (tout le monde a raccroché), l'app demande à SmartThings de **restaurer la source
   précédente** (revenir à l'app Canal+ / à la chaîne TV d'avant).

**Pré-requis / limites :** TV liée à un **compte SmartThings**, « réveil/contrôle réseau » activé,
jeton OAuth SmartThings (à fournir par toi) ; **mémoriser la source précédente** pour la restaurer ;
le **switch d'entrée/relance d'app** peut être partiellement **partner-gated** selon le modèle —
**à valider sur la vraie QE43QN90F**. C'est une **intégration cloud complémentaire** (comme le tap
Eufy), pas quelque chose que l'app fait seule. Un hook est prévu côté C7 (env `SMARTTHINGS_*`,
désactivé tant que non configuré).

---

## Recommandation

- **Court terme / le plus fiable :** **Cas A** — l'app visio devient l'app TV principale et embarque
  le flux TV (IPTV/HLS) en fond. Prise en main + reprise **déjà fonctionnelles**.
- **Si Canal+ doit rester l'app native / le tuner :** **Cas B** via **SmartThings** (à brancher et
  valider sur la TV réelle). Sans SmartThings ni partenariat, l'auto-prise-en-main par-dessus une
  autre app **n'est pas possible** — c'est une limite de la plateforme, pas du code.

Voir aussi [TV-STANDBY-ET-NUMERO.md](TV-STANDBY-ET-NUMERO.md) (réveil matériel, même logique
SmartThings) et [MULTIPARTITE.md](MULTIPARTITE.md).
