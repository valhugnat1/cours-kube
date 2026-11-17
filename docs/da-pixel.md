# DA « pixel chill » : référence pour le site du cours

Ce document garde la trace de la direction artistique de **Limiter App** (repo [`valhugnat1/app-perso-limiter`](https://github.com/valhugnat1/app-perso-limiter)) et explique comment l'appliquer au site du cours, pour que les deux aient la même identité.

Les deux restent indépendants : le site marche seul, l'appli marche seule. Le lien entre les deux : l'appli ouvre le site dans son onglet cours, et une leçon validée y rapporte un crédit de session. La même DA rend ce passage naturel.

**Statut :** première application au site (branche de design). Ce qui est en place :

- palette, polices Jersey 10 et Silkscreen, mode sombre « nuit » (`src/styles/global.css`) ;
- carte pixel `.px` et bouton `.bouton` (contour 2 px, coins coupés, ombre pleine) ;
- 8 paysages portés en TypeScript (`src/scripts/pixel/`) : mer, prairie, pluie, montagne, forêt, aube, lucioles, aurore. Montage et boucle dans `src/scripts/paysages.ts`, composant `Paysage.astro` ;
- un paysage par partie (`src/data/paysages.ts`) : bandeau des leçons, en-têtes de partie, fête de fin de quiz ;
- accueil : paysage qui suit le soleil (jour = partie en cours, crépuscule = aube, nuit = lucioles ou aurore) ;
- encadrés, `Compare`, rail, quiz, récap animé et schémas mermaid passés en pixel ; icône du site régénérée depuis `scripts/logo.py` (avec un voilier sur le lac).

Une PR de design reste séparée des PR de contenu.

---

## 1. L'intention

Pixel art doux, pastel, un peu animé. L'ambiance d'un petit jeu calme, pas d'une appli de productivité. Tout doit donner envie de ralentir.

- **Calme avant tout :** pas de couleurs saturées ni d'animation rapide, et rien qui clignote pour attirer l'œil.
- **Un geste signature :** on touche un paysage et il réagit (un rond dans l'eau, une étoile filante). Ce n'est pas utile, c'est mignon, et c'est ce qui donne de la personnalité.
- **Pixel pour l'identité, texte normal pour la lecture :** titres, étiquettes, boutons et chiffres sont en police pixel. Les paragraphes restent dans une police de lecture confortable : un cours se lit longtemps.

## 2. Couleurs

La source de vérité est `app/src/main/kotlin/app/gardefou/Theme.kt` (objet `Pal`).

| Rôle | Nom dans l'appli | Hex | Usage |
|---|---|---|---|
| Fond de page | `papier` | `#F6F1E4` | fond général, chaud, papier |
| Fond de carte | `creme` | `#FFF9EC` | cartes, barre d'onglets |
| Encre | `encre` | `#2F3550` | texte, **tous les contours**, ombres |
| Encre douce | `encreDouce` | `#666B82` | texte secondaire, légendes |
| Ciel | `ciel` | `#CFE8EE` | onglet actif, carte « leçon », info |
| Mer | `mer` | `#6DBFC3` | barres de progression, accents froids |
| Herbe foncée | `herbeFonce` | `#4F8A3C` | bouton principal (action) |
| Libre | `libre` / `libreFort` | `#C6E5A4` / `#8CC266` | OK, validé |
| Session | `session` / `sessionFort` | `#FFE19C` / `#F2B940` | attention douce, crédits ★ |
| Bloqué | `bloque` / `bloqueFort` | `#F4B4AB` / `#E07A6E` | erreur, piège |
| Corail | `corail` | `#D9645A` | trait « maintenant », texte d'alerte |
| Ombre | `ombre` | `#2F3550` à 20 % | ombre décalée des cartes |

Les versions `…Fort` servent aux petits éléments (carrés de légende, cases cochées) : les pastels seuls disparaissent en petit.

### Correspondance avec les variables du site (`src/styles/global.css`)

| Variable actuelle | Nouvelle valeur | Commentaire |
|---|---|---|
| `--papier` | `#F6F1E4` | |
| `--surface` | `#FFF9EC` | |
| `--encre` | `#2F3550` | bleu nuit plutôt que noir |
| `--encre-douce` | `#666B82` | |
| `--trait` | `#2F3550` (contours épais) ou `#2F355020` (séparateurs) | |
| `--pin`, `--pin-clair` | `#4F8A3C`, `#C6E5A4` | progression, validé, action |
| `--ambre`, `--ambre-clair` | `#B7860F`, `#FFE19C` | pièges, à revoir |
| `--rouge`, `--rouge-clair` | `#C8574B`, `#F4B4AB` | |
| `--bleu`, `--bleu-clair` | `#3F8C97`, `#CFE8EE` | analogies, `:::ext` |
| `--violet`, `--violet-clair` | `#7D6FA5`, `#E4DCF0` | terrain, `:::regle` (lilas de l'aube) |
| `--code-fond` | `#EFE8D6` | sable clair |
| `--rayon` | `0` | coins coupés, pas arrondis (voir § 4) |

Les couleurs foncées ci-dessus (`--ambre`, `--rouge`, `--bleu`, `--violet`) sont des propositions pour garder un contraste suffisant en texte : à vérifier (WCAG AA) au moment de l'intégration.

**Mode sombre :** reprendre la palette des paysages de nuit (scène `LUCIOLES`, `AURORE`) : papier `#141B33`, surface `#1E2A4A`, encre `#F3EFCF` (couleur de la lune), contours `#F3EFCF` à 70 %, accents inchangés mais un cran plus clairs. C'est une proposition : l'appli, elle, n'a qu'un thème clair.

### Couleurs des schémas (rôles `:::ext`, `:::regle`…)

Garder le principe « une couleur = un rôle » et passer aux pastels de la palette. Fonds pastel, **contour `--encre` 2 px pour tous les nœuds** (c'est ce qui fait « pixel ») ; la couleur du rôle reste visible par le fond et la légende.

| Rôle | Fond | Pourquoi |
|---|---|---|
| `ext` (qui appelle) | ciel `#CFE8EE` | |
| `regle` (la règle écrite) | lilas `#E4DCF0` | |
| `moteur` (ce qui agit) | session `#FFE19C` | |
| `cible` (le résultat) | libre `#C6E5A4` | |
| `ko` (l'erreur) | bloqué `#F4B4AB` | |

Dans le CSS : `rx: 0` sur les rectangles des nœuds, et `stroke-width: 2px`.

## 3. Typographie

| Usage | Police | Paquet npm (web) | Remarque |
|---|---|---|---|
| Titres, boutons, chiffres, onglets | **Jersey 10** | `@fontsource/jersey-10` | pixel condensée, chiffres nets. Petite à taille égale : **× 1,28** par rapport à une police normale. Une seule graisse : ne pas demander de gras (sinon faux gras baveux). |
| Étiquettes, titres de section, titres de paysage | **Silkscreen** | `@fontsource/silkscreen` | petites capitales pixel, toujours en MAJUSCULES, petit corps (9 à 15 px), un peu d'espacement. |
| Texte courant | police de lecture | déjà là : Literata | on garde : le pixel en paragraphe fatigue. |
| Code | IBM Plex Mono | déjà là | on garde. |

À éviter : **Pixelify Sans**, essayée au départ, dont le « 5 » ressemble à un « S ».

Les deux polices sont sous licence OFL (texte de licence dans `LICENCE-polices.txt` du repo de l'appli).

## 4. Composants

Tout repose sur trois règles : **contour encre 2 px**, **coins coupés** (pas arrondis), **ombre pleine décalée** (pas de flou).

### Carte (`PixelCarte`)

```css
.pixel-carte {
  --coupe: 6px;
  background: var(--surface);
  border: 2px solid var(--encre);
  clip-path: polygon(var(--coupe) 0, calc(100% - var(--coupe)) 0, 100% var(--coupe),
    100% calc(100% - var(--coupe)), calc(100% - var(--coupe)) 100%, var(--coupe) 100%,
    0 calc(100% - var(--coupe)), 0 var(--coupe));
  filter: drop-shadow(4px 4px 0 rgb(47 53 80 / 0.2));
  padding: 14px;
}
```

`clip-path` coupe aussi la bordure dans les coins. Si le rendu des coins déplaît, deux autres pistes : `border-image` avec un petit SVG pixel, ou un pseudo-élément par coin. Le `drop-shadow` se pose sur un parent, pas sur l'élément coupé lui-même.

### Bouton (`PixelBouton`)

- Fond `--pin` (`#4F8A3C`), texte blanc en Jersey 10, contour encre 2 px, coins coupés 5 px.
- Ombre **pleine** encre décalée de 3 px en bas à droite. À l'appui, le bouton descend de 3 px dans son ombre : `transform: translate(3px, 3px)` et ombre retirée.
- Bouton secondaire : fond crème ou ciel, texte encre.
- Désactivé : opacité 0,5.

### Pastille à cocher (`PixelPuce`)

Pour les filtres, jours et choix : fond crème, contour encre à 25 %. Choisie : fond ciel, contour encre plein, texte en gras.

### Carré de légende (`CarreMode`)

Carré de 12 à 16 px, contour encre 2 px, rempli de la couleur `…Fort`. Il remplace partout les pastilles rondes.

### Barre en cases (`BarrePixel`)

La progression se dessine en cases séparées par 2 px : 16 à 24 cases, pleines en `--mer` ou `--pin`, vides en encre à 10 %. À utiliser pour le score de quiz, la progression d'étape et la barre de scènes animées.

### Icônes

Elles sont dessinées case par case à partir d'une grille de caractères (`#` = pixel plein) : soleil, montagne, réglages, stats, coche. Les motifs sont dans `Theme.kt` (`ICONE_*`). Pour le web, un petit SVG de `<rect>` généré depuis la même grille suffit.

### Titre de section et séparateur

Titre de section en Silkscreen majuscules. Le séparateur est une ligne pointillée faite de carrés de 4 px, encre à 15 %.

## 5. Les paysages animés

C'est l'élément le plus reconnaissable. Il y en a 18 :

- **Jour :** mer, prairie, pluie sur le lac, lac de montagne, forêt, grand large, icebergs, chalet sous la neige, café sous la pluie.
- **Lever et coucher :** aube sur les crêtes, coucher de soleil, volcan endormi, vieille ville au soir.
- **Nuit :** lucioles, aurore boréale, dunes, toits de la ville, phare.

**Comment ils marchent** (`core/src/main/kotlin/app/gardefou/core/pixel/`) :

- **Rendu :** chaque scène se dessine dans une petite image d'environ 90 pixels de large (`Toile` : un tableau d'entiers ARGB), puis s'agrandit **sans lissage**.
- **Outils de dessin :** dégradés tramés (trame de Bayer 4×4), formes simples, pseudo-hasard stable (`hasard(n)`). Il n'y a aucune image : tout est calculé, donc léger.
- **Animation :** environ 11 images par seconde, avec une pause quand ce n'est pas visible.
- **Interaction :** on touche, une `Touche(x, y, t)` est ajoutée, et la scène dessine son effet pendant quelques secondes (ronds, étoile filante, feuilles…).
- **Choix de la scène :** il suit le soleil. Le lever et le coucher sont calculés (formules NOAA, Paris, `Soleil.kt`), avec un crépuscule de ± 45 min autour.

**Portage web :** le code est en Kotlin pur, sans Android. La traduction en TypeScript est quasi ligne à ligne : `Toile` devient un `Uint32Array` puis une `ImageData` sur un `<canvas>` en `image-rendering: pixelated`. Il faut ajouter :

- `requestAnimationFrame` limité à environ 11 images par seconde ;
- une pause par `IntersectionObserver` et `visibilitychange` ;
- **une image fixe si `prefers-reduced-motion`**.

Les fichiers sont courts (une centaine de lignes par scène), et il vaut mieux porter seulement les scènes utilisées.

## 6. Où appliquer tout ça sur le site

Ce sont des idées, à trier au moment de la PR de design.

| Élément du site | Avec la DA |
|---|---|
| En-tête d'une étape | Un bandeau paysage de 150 à 200 px, par exemple une scène par partie A à E, avec le titre de l'étape sur une étiquette crème (comme dans l'appli). |
| Rail de progression (`Rail.astro`) | Stations en carrés pixel (vide : contour, lu : rempli `--pin`, récap : carré doré `sessionFort`), ligne en pointillés pixel. |
| Encadrés `Idee`, `Analogie`, `Terrain`, `Piege`, `Retenir` | Cartes pixel : un bandeau de titre en Silkscreen et le fond de la couleur de rôle. `Retenir` en ciel, `Piege` en bloqué clair. |
| `Compare` | Deux cartes pixel côte à côte, en ✔ libre et ✘ bloqué. |
| Quiz | Réponses en pastilles pixel, bouton « Vérifier » en `PixelBouton` et score en barre en cases. |
| Leçon validée (quiz sans faute) | Un petit paysage (étoile filante, rond dans l'eau) et « ★ +1 crédit », qui fait écho à l'appli. |
| Récap animé (`scenes.ts`) | Barre de scènes en carte pixel, points en carrés et boutons en `PixelBouton`. |
| Schémas mermaid | Nœuds à coins droits, contour encre 2 px, fonds pastel des rôles (§ 2) et police Jersey 10 pour les libellés si ça reste lisible (sinon la police de lecture). |
| Icône / favicon | Le logo de l'appli (aube sur la montagne, rond dans le lac), généré par `scripts/logo.py` du repo de l'appli. Il peut sortir en SVG pour le site. |

**À ne pas faire :**

- Mettre les paragraphes en police pixel.
- Animer les schémas en continu : seuls les paysages bougent tout seuls.
- Ajouter des couleurs vives hors palette.

## 7. Continuité avec l'appli

- **Même vocabulaire :** ★ crédits, « Faire une leçon de 5 min », paysages.
- **Écran de cours dans l'appli :** l'appli affiche le site dans une WebView (`CoursActivity.kt`). Elle crédite une leçon quand `localStorage['ck:progression'].lues[id]` passe à une date postérieure à l'ouverture. **Ne pas changer ce format** sans mettre l'appli à jour.
- **Plus tard, si utile :** le site pourrait détecter qu'il tourne dans l'appli (par exemple avec un paramètre d'URL `?depuis=limiter`) pour afficher un bouton « Retour à Instagram… » ou cacher la navigation. Ce n'est pas nécessaire aujourd'hui.

## 8. Fichiers de référence (repo de l'appli)

| Fichier | Contenu |
|---|---|
| `app/src/main/kotlin/app/gardefou/Theme.kt` | palette, polices, carte, bouton, pastille, barre, icônes |
| `app/src/main/kotlin/app/gardefou/ScenePixel.kt` | affichage animé d'une scène, étiquette de titre |
| `core/src/main/kotlin/app/gardefou/core/pixel/` | les 18 scènes, la toile, la trame, le soleil |
| `scripts/logo.py` | génération du logo (et de son aperçu PNG) |
| branche `captures` | captures d'écran de l'appli, refaites à chaque push |
