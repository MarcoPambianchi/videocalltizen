# Appels à plusieurs (multipartite) + écran splitté sur la TV

**Question :** peut-on avoir plusieurs appelants en même temps, avec un partage de l'écran TV ?
**Réponse : oui, nativement.** LiveKit (C5) est un **SFU** (Selective Forwarding Unit) conçu pour
le multipartite : une salle accueille N participants ; chacun publie son flux, le SFU le route vers
les autres. Aucune brique à ajouter — l'architecture le supporte déjà.

## Ce qui a été implémenté (et testé)

- **Grille adaptative sur la TV** (`tizen-app/`) : une **tuile vidéo par participant**, avec layout
  automatique selon le nombre :

  | Participants | Disposition |
  |---|---|
  | 1 | plein écran |
  | 2 | côte à côte |
  | 3–4 | mosaïque 2×2 |
  | 5–9 | 3×3 |
  | … | `ceil(√n)` colonnes |

- **Ajout/retrait dynamique** des tuiles (`ParticipantDisconnected`, `TrackUnsubscribed`).
- **Audio** : un élément audio par participant, mixés sur les haut-parleurs de la TV.
- La **caméra Eufy** (`camera-salon`) est simplement l'une des tuiles.
- Validé en navigateur headless (`scripts/test-browser.sh`) : layout 1/2/4/5 + ajout/retrait.

## Comment ça se passe à l'usage

1. Chaque appelant rejoint la **même salle** (`salon`) via son **propre lien d'invitation**
   (`token-service` `GET /invite` → identité unique + token de publication).
2. La TV (réception seule) s'abonne à **tous** les participants et compose la grille.
3. Les appelants se voient aussi entre eux (chacun est un client LiveKit standard).

## Limites et points d'attention

- **Bande passante / CPU TV** : chaque flux supplémentaire = décodage H.264 en plus. Le QN90F
  décode plusieurs flux sans peine pour un usage familial (≤ 4–6) ; au-delà, réduire la résolution
  des sous-flux (LiveKit *simulcast*/*dynacast*) — `adaptiveStream` est déjà activé côté TV.
- **Écho (L5)** reste valable : la voix sortante de la personne passe par la S350 (cloud Eufy) ;
  avec plusieurs interlocuteurs, l'écho et la latence sortante sont inchangés (voir `ECHO.md`).
- **Politique d'arrivée (DÉCIDÉE)** : seul le **premier appelant fait sonner la TV** (`POST /call`)
  pour ouvrir la salle. **Tous les arrivants suivants rejoignent par lien d'invitation SANS faire
  sonner** — ils ne passent pas par le signaling, juste par un token de salle (`GET /invite`). Le
  client web expose un bouton **« Inviter »** qui génère/copie ce lien partageable pendant l'appel.
  Côté interlocuteur, l'affichage des distants est aussi une **mosaïque** (chacun voit tout le monde).
- **Disposition** : la grille `ceil(√n)` est un défaut raisonnable ; on peut ajouter un mode
  « intervenant actif en grand + autres en vignettes » (active speaker) si souhaité.
