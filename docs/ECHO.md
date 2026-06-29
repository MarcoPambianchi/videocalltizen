# ECHO — annulation de l'écho acoustique (L5 du cahier)

Le problème L5 : **le micro de la caméra Eufy S350 capte le son de la TV** (sur
laquelle on entend l'interlocuteur), puis le renvoie à l'interlocuteur → celui-ci
**s'entend lui-même avec un retard** = écho. Ce document explique **pourquoi l'AEC
standard ne marche pas ici**, détaille les options O1..O5, et fixe la recommandation
**O4 + O5 par défaut**.

Pré-requis : la chaîne média ([`ARCHITECTURE.md`](ARCHITECTURE.md)) et le budget de
latence ([`LATENCE.md`](LATENCE.md)) — la latence variable est la cause racine.

---

## 1. La boucle d'écho dans notre topologie

```
interlocuteur parle
   └─► SFU LiveKit ─► TV Tizen ─► HAUT-PARLEURS TV  ──(air du salon)──┐
                                                                      │
                                          MICRO de la caméra S350 ◄───┘  (re-capture)
                                                  │
                                          Cloud Eufy P2P (retard 0,5–2 s)
                                                  │
                                          go2rtc ─► Ingress ─► SFU
                                                  │
                                          interlocuteur ENTEND SA PROPRE VOIX en différé
```

---

## 2. Pourquoi l'AEC (Acoustic Echo Cancellation) standard échoue ici

L'AEC classique (celle de WebRTC, de Teams, d'un téléphone) annule l'écho parce que
**le même appareil** joue le son **et** capte le micro : il connaît exactement le
signal de référence (« ce que je viens de jouer ») et son **délai est court et fixe**.
Il soustrait alors la référence du signal micro.

Dans notre cas, **trois conditions de l'AEC sont violées** :

1. **Capture ≠ restitution.** Le son est **restitué par la TV** (haut-parleurs TV,
   pilotés par l'app Tizen C9) mais **capté par la caméra Eufy**, à l'autre bout d'un
   **cloud P2P**. Aucun composant ne voit *à la fois* le signal joué et le signal
   capté avec une base de temps commune → pas de **signal de référence** exploitable.
2. **Délai long et VARIABLE.** Le retour micro arrive après le P2P Eufy
   (**0,5–2 s, instable** — voir [`LATENCE.md`](LATENCE.md)). Les filtres adaptatifs
   AEC sont conçus pour des délais de **quelques dizaines de ms**, fixes. Un délai qui
   bouge fait **diverger** le filtre.
3. **Transformation du signal en route.** Le son passe par les haut-parleurs TV (EQ,
   gain), l'acoustique du salon (réverbération), puis le ré-encodage P2P Eufy. Le motif
   à annuler n'est plus une copie propre de la référence → corrélation faible.

**Conclusion : on ne peut pas « brancher une AEC » et espérer que ça marche.** Il faut
soit casser la boucle (réduire ce qui revient dans le micro), soit supprimer la voix
côté serveur, soit reconstruire un AEC serveur non trivial.

---

## 3. Options O1..O5

| Opt. | Principe | Coût / contrainte | Efficacité écho |
|------|----------|-------------------|-----------------|
| **O1** | **Casque** côté interlocuteur **et/ou** côté domicile | matériel + acceptation usager (domicile : casque sur la personne = souvent refusé) | ✅ supprime la boucle à la source |
| **O2** | **Push-to-talk / half-duplex** : un seul sens audio actif à la fois | dégrade fortement le naturel de la conversation | ✅ mais inconfortable |
| **O3** | **AEC serveur** : reconstruire la référence (le mix sortant TV) et l'annuler dans le flux micro Eufy, avec **alignement temporel** sur le délai P2P mesuré | complexe ; exige estimation continue du délai variable ; CPU | 🟡 partielle, fragile au jitter |
| **O4** | **Réduction acoustique passive** : **volume TV bas** + **placement** (caméra/micro éloigné des HP TV, HP non dirigés vers la caméra) | gratuit, immédiat ; limite le volume confort | 🟡 réduit, ne supprime pas |
| **O5** | **Suppression de voix / RNNoise sur le flux ENTRANT micro** (côté serveur, dans go2rtc/ffmpeg), pour atténuer la composante « parole rejouée » avant qu'elle reparte | gratuit (logiciel) ; peut altérer la voix réelle du domicile | 🟡 réduit l'écho résiduel et le bruit |

---

## 4. Recommandation par défaut : **O4 + O5**

O4 + O5 est retenu **par défaut** car :
- **sans matériel** ni contrainte sur la personne au domicile (pas de casque imposé) ;
- **immédiat** (config + placement), réversible ;
- **suffisant** pour un usage « appel familial » si le volume TV reste raisonnable.

O3 (AEC serveur) reste un **chantier R&D** ; O1 (casque) est le **plan de repli garanti**.

### 4.1 Câbler O5 — suppression de voix / bruit sur le flux micro ENTRANT (go2rtc/ffmpeg)

Le « flux micro entrant » = le flux **audio sortant du domicile** (capté par la S350),
*entrant dans go2rtc* avant injection vers Ingress/SFU. On insère un filtre audio
ffmpeg dans la définition de la source `salon` de [`go2rtc.yaml`](../go2rtc/go2rtc.yaml).

**Principe (à adapter en phase Eufy réelle) :** ajouter un étage de filtrage audio sur
la piste micro Eufy, par exemple :

- **RNNoise** (suppression de bruit basée réseau, dispo via le filtre ffmpeg `arnndn`
  avec un modèle `.rnnn`) :
  ```
  -af "arnndn=m=/models/rnnoise.rnnn"
  ```
- **ou** suppression douce + porte de bruit (sans modèle externe), pour atténuer les
  passages de faible énergie (l'écho rejoué est souvent plus faible que la voix locale) :
  ```
  -af "highpass=f=120,lowpass=f=7500,afftdn=nr=12,agate=threshold=0.03:ratio=4:attack=10:release=120"
  ```

> Ce que O5 fait et **ne fait pas** : il **atténue** le résidu (bruit + queue d'écho de
> faible niveau), il **ne sépare pas** proprement la voix de l'interlocuteur rejouée de
> la voix réelle du domicile (pas de référence — cf. §2). Il complète O4, il ne le
> remplace pas. Régler `nr`/`threshold` en écoutant pour ne **pas hacher** la voix réelle.

**Où :** dans la source `salon` de `go2rtc.yaml`, l'étage OPUS existe déjà
(`ffmpeg:salon#audio=opus`) ; le filtre `-af` se place sur la **commande ffmpeg qui
produit la piste audio Eufy**, en amont de l'encodage OPUS. En mode synthétique, on peut
prototyper le filtre sur la tonalité 440 Hz pour valider la **syntaxe** sans la caméra.

### 4.2 Câbler O4 — réduction acoustique passive (placement + volume)

- **Volume TV bas** : régler la TV au minimum audible confortable. Plus le volume est
  bas, moins le micro S350 récupère de signal rejoué (gain le plus efficace, gratuit).
- **Placement** : éloigner la **caméra S350 des haut-parleurs de la TV** ; ne pas
  pointer les HP TV vers la caméra ; profiter de l'atténuation en 1/distance.
- **Directivité** : si la S350 a un micro directionnel, l'orienter vers la zone où la
  personne parle, **dos à la TV**.
- Documenter le couple (volume TV, distance caméra↔TV) retenu après les mesures du §5.

---

## 5. Mesurer l'écho en conditions réelles

L'écho ne se mesure **qu'avec la vraie chaîne Eufy** (profil `eufy`, donc en
coordination avec le Gardien — slot P2P unique, [`ARCHITECTURE.md`](ARCHITECTURE.md) §5).

### Protocole
1. **Appel de test** interlocuteur ⟷ domicile, TV allumée et restituant l'interlocuteur.
2. L'interlocuteur prononce des **mots-tests espacés** (« un … deux … trois … »),
   puis **se tait** et écoute son propre retour.
3. **Mesurer le délai de l'écho** : enregistrer le flux que reçoit l'interlocuteur
   (capture audio) ; sur la forme d'onde, mesurer l'écart entre le mot prononcé et sa
   **répétition rejouée**. Cet écart ≈ aller-retour (TV → air → micro S350 → P2P).
4. **Mesurer le niveau de l'écho** (ERLE) : comparer l'amplitude de l'écho rejoué à
   celle de la voix directe (en dB). Objectif : écho **≥ 20–25 dB sous** la voix utile
   (devient inaudible/non gênant).
5. **Balayer O4** : refaire les mesures à plusieurs volumes TV et distances caméra↔TV ;
   tracer niveau d'écho = f(volume, distance) → choisir le réglage.
6. **Activer/désactiver O5** : comparer le résidu avec et sans le filtre `-af` pour
   quantifier son apport et vérifier qu'il **ne dégrade pas** la voix réelle.

### Critères d'acceptation
- Écho **non perçu comme gênant** par l'interlocuteur en conversation normale.
- Niveau d'écho **≥ 20 dB** sous la voix utile (cible 25 dB).
- La voix réelle du domicile **reste naturelle** malgré O5 (pas de hachage / pompage).

---

## 6. Plan de bascule (si O4 + O5 insuffisant)

Ordre de repli, du moins au plus contraignant :

1. **Renforcer O4** : baisser encore le volume TV, augmenter la distance, ajouter un
   absorbant. Souvent suffisant.
2. **Durcir O5** : modèle RNNoise dédié / réglage plus agressif (au prix de la
   naturalité — surveiller le critère §5).
3. **O1 — casque côté interlocuteur** : supprime l'écho *pour l'interlocuteur* sans
   rien changer au domicile. **Plan de repli garanti et peu coûteux** ; à proposer en
   premier dès que O4+O5 ne suffit pas.
4. **O1 — casque/oreillette côté domicile** : très efficace mais **acceptabilité
   faible** (personne âgée) → dernier recours côté domicile.
5. **O3 — AEC serveur** : seulement si un duplex confortable **sans casque** est
   exigé. Chantier R&D : estimer en continu le **délai P2P variable**
   ([`LATENCE.md`](LATENCE.md)), reconstruire la référence (mix envoyé à la TV),
   aligner et soustraire dans le flux micro Eufy. À ne lancer qu'après échec documenté
   de 1–4.
6. **O2 — half-duplex / push-to-talk** : solution de **dernier recours** garantie
   (un seul sens audio à la fois supprime mécaniquement l'écho), au prix du naturel.
