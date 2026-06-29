# LATENCE — budget de bout en bout (cahier §9)

Ce document chiffre la latence des deux sens d'un appel, identifie le **goulot
d'étranglement** (le P2P Eufy en sortant), et décrit **comment le mesurer réellement
en P0**. Voir la chaîne complète dans [`ARCHITECTURE.md`](ARCHITECTURE.md).

> **Hypothèse de travail explicite :** les chiffres marqués *(est.)* sont des estimations
> d'ordre de grandeur tirées de l'expérience WebRTC/LiveKit en LAN-WAN proche. Le seul
> segment réellement **INCONNU** est le P2P Eufy ; il **doit** être mesuré (P0) avant
> tout engagement de SLA. Ne pas considérer les totaux comme garantis tant que P0 n'est
> pas fait.

---

## 1. Les deux sens n'ont pas le même budget

| Sens | Chemin | Domine | Ordre de grandeur |
|------|--------|--------|-------------------|
| **SORTANT** (domicile → interlocuteur) | S350 → Cloud Eufy → eufy-visio → shim → go2rtc → Ingress → SFU → navigateur | **P2P Eufy** | **INCONNU 0,5–2 s** (à mesurer) |
| **ENTRANT** (interlocuteur → domicile/TV) | navigateur → SFU → TV Tizen | réseau WebRTC | **~150–400 ms** *(est.)* |

La conséquence pratique : un appel sera probablement **asymétrique**. L'interlocuteur
verra le salon avec un **retard notable** (sortant lent), tandis que la personne au
domicile verra/entendra l'interlocuteur **quasi en direct** (entrant rapide). Cette
asymétrie est **structurelle** (P2P propriétaire Eufy) et ne se corrige pas côté SFU.

---

## 2. Budget SORTANT — décomposition

```
S350 capture + encode H.264          ~50–150 ms  (est., interne caméra)
    │
P2P Eufy (S350 → cloud → eufy-visio) ►►► INCONNU 0,5–2 s ◄◄◄  ← GOULOT, à mesurer P0
    │
shim → go2rtc (dépaquetage/adaptation) ~20–80 ms (est.)
    │
go2rtc → Ingress (RTMP)              ~50–200 ms (est. ; RTMP + transcodage tamponnent)
    │   (chemin WHIP bypass : ~30–80 ms si H.264/Opus compatibles)
    │
Ingress → SFU → navigateur (WebRTC)  ~100–300 ms (est.)
    │
jitter buffer + décodage navigateur  ~50–150 ms (est.)
═══════════════════════════════════════════════════════════════
TOTAL SORTANT ≈ P2P_Eufy + 0,3–0,9 s d'overhead pipeline (est.)
```

**Le terme `P2P_Eufy` écrase tout le reste.** Tant qu'il n'est pas mesuré, le total
sortant est inconnu. Les optimisations d'aval (WHIP vs RTMP, bypass transcodage) ne
gagnent que des **centaines de ms**, négligeables si le P2P fait 1,5 s.

### Levier d'aval connu : RTMP vs WHIP
- **RTMP** (`:1935`, chemin par défaut, testé P1) : robuste, transcode → **+100 à
  +200 ms** de tampon.
- **WHIP** (`:8085`, `bypassTranscoding` possible si la source est déjà H.264/Opus) :
  basse latence, **−100 à −200 ms** vs RTMP. À privilégier **si** le flux Eufy sort en
  H.264 + Opus compatibles (à vérifier en P0 en même temps que la latence).

---

## 3. Budget ENTRANT — décomposition

```
capture micro/cam interlocuteur       ~20–60 ms  (est.)
    │
navigateur → SFU (WebRTC)             ~50–150 ms (est., dépend du RTT réseau)
    │
SFU → TV Tizen (WebRTC)               ~50–150 ms (est.)
    │
jitter buffer + décodage TV           ~50–150 ms (est.)
═══════════════════════════════════════════════════════════════
TOTAL ENTRANT ≈ 150–400 ms (est.)
```

WebRTC de bout en bout, sans étape propriétaire : **rapide et prévisible**. La seule
variable significative est le **RTT réseau** entre l'interlocuteur et la VM (d'où
l'intérêt du TURN/IP publique en prod, cf. [`PRODUCTION.md`](PRODUCTION.md)).

---

## 4. P0 — comment mesurer la latence P2P Eufy RÉELLEMENT

**Objectif P0 :** obtenir une valeur chiffrée, reproductible, de la latence
**glass-to-glass** du sens sortant, et isoler la part imputable au P2P Eufy. À faire
**sur la vraie caméra** (profil `eufy`), donc en coordination avec toute autre
intégration utilisant la même caméra (slot P2P unique, voir
[`ARCHITECTURE.md`](ARCHITECTURE.md) §5).

### Méthode A — horloge filmée (glass-to-glass, la plus fiable)
1. Afficher une **horloge à millisecondes** (page web `Date.now()` plein écran, ou
   appli chronomètre ms) sur un écran.
2. Placer la **caméra S350 face à cet écran**.
3. Sur l'écran de l'interlocuteur (web-client C8), afficher le flux reçu **à côté** de
   la même horloge de référence (même machine, donc même base de temps).
4. Prendre une **photo unique** cadrant les deux horloges (la réelle et celle vue par
   la caméra via toute la chaîne).
5. **Latence sortante glass-to-glass = (horloge de référence) − (horloge filmée)**.
   Répéter **≥ 20 fois**, garder min / médiane / max / p95.

> Cette méthode mesure le **total sortant** (§2), pas seulement le P2P. Pour isoler le
> P2P, soustraire l'overhead pipeline mesuré en Méthode B.

### Méthode B — isoler le segment pipeline (sans P2P)
Mesurer le **même total** en mode **synthétique** (source go2rtc, sans Eufy) avec la
Méthode A : on obtient `T_pipeline` (go2rtc → … → navigateur). Puis :

```
T_P2P_Eufy ≈ T_sortant_reel − T_pipeline
```

(Approximation : suppose que l'encode interne S350 ≈ encode ffmpeg synthétique ; à
documenter comme incertitude.)

### Méthode C — horodatage applicatif (complément)
- Côté `eufy-shim` (C2) : logguer un timestamp **à la réception du premier octet** de
  chaque frame P2P.
- Comparer à l'horloge de la HomeBase si exposée (souvent indisponible) ⇒ la Méthode A
  reste la référence. Utiliser C dabord pour détecter la **gigue** (variation
  inter-frames), pas la latence absolue.

### Conditions à documenter pour chaque mesure
- Réseau de la caméra (Wi-Fi domicile : RSSI, débit montant), heure, charge cloud Eufy.
- Mode d'ingestion (RTMP vs WHIP, transcodage on/off).
- Résolution / fps effectifs du flux Eufy (à relever : la S350 peut négocier plus bas).

---

## 5. Gigue (jitter) et stabilité

La latence **moyenne** ne suffit pas : un P2P qui oscille entre 0,6 s et 2 s est pire
qu'un P2P stable à 1,5 s (le jitter buffer devra surdimensionner et la latence perçue
grimpe). **Mesurer la variance** (Méthode C pour l'inter-frame, Méthode A répétée pour
le glass-to-glass) est aussi important que la moyenne.

---

## 6. Critères d'acceptation

| Critère | Sens | Cible | Source |
|---------|------|-------|--------|
| Latence entrant (interlocuteur → TV) | entrant | **< 0,5 s** glass-to-glass | mesure A |
| Latence sortant (domicile → interlocuteur) | sortant | **objectif < 2 s** ; **acceptable < 3 s** | mesure A, P0 |
| Gigue sortant | sortant | écart p95−médiane **< 0,5 s** | mesures A/C |
| Conversation tenable | les deux | pas de « collision » de tour de parole gênante | test humain |

**Décision de bascule (gate P0) :** si le sortant médian dépasse **~3 s** ou que la
gigue rend la conversation impraticable, le mode « visio temps réel » via P2P Eufy est
**remis en cause** (revoir l'usage : appel « semi-direct » assumé, ou autre voie de
capture). Cette décision ne peut être prise **qu'après** P0 — ne rien promettre avant.

---

## 7. Lien avec l'écho

Une latence sortante élevée et **variable** est précisément ce qui rend l'AEC standard
inopérant (le motif à annuler arrive avec un retard imprévisible). Le budget de latence
ci-dessus est donc une **entrée directe** de la stratégie anti-écho — voir
[`ECHO.md`](ECHO.md).
