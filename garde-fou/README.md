# Garde-fou

Appli Android perso pour limiter Instagram par **phases horaires** : sessions chronométrées avec pause obligatoire, blocage complet, ou blocage des Reels uniquement.

## Ce que ça fait

Tu définis des **phases** (jours + plage horaire). Chacune a une règle :

| Mode | Effet |
|---|---|
| **Libre** | Pas de limite de temps. |
| **Sessions** | X minutes d'Instagram, puis pause forcée de Y minutes. Option : N sessions max par jour. |
| **Bloqué** | Instagram se referme dès qu'on l'ouvre. |

En plus, dans les modes Libre et Sessions, l'option **Bloquer les Reels** ferme l'écran des Reels et laisse le reste (messages, fil, stories). Une option étend ça aux Shorts YouTube.

Quand aucune phase ne couvre l'heure qu'il est, c'est la **règle par défaut** qui s'applique. Si deux phases se chevauchent, celle du haut de la liste gagne.

Réglages de départ (tout se change dans l'appli) : bloqué lun → ven 9h–12h et 14h–18h, sessions de 10 min / pause 20 min de 12h à 14h, sessions de 15 min / pause 1 h de 18h à 23h, et le reste du temps libre avec Reels bloqués.

Le **mode strict** (désactivé au départ) empêche de modifier les règles pendant qu'Instagram est bloqué.

## Comment ça marche

```
Instagram à l'écran
      │  Android prévient le service d'accessibilité
      ▼
GardeService (app/)          1 tick par seconde, cherche l'écran des Reels
      │  « on en est où ? »
      ▼
Moteur (core/)               phase active → règle → autorisé ou bloqué
      │  bloqué
      ▼
BlocageActivity              écran « Session terminée, retour à 12:30 »
```

| Chemin | Rôle |
|---|---|
| `core/` | Le moteur de règles, en Kotlin pur (pas d'Android) avec ses tests. C'est là que vit toute la logique. |
| `app/…/GardeService.kt` | Service d'accessibilité : détecte Instagram, compte le temps, détecte les Reels. |
| `app/…/MainActivity.kt` | L'écran de réglages (Jetpack Compose). |
| `app/…/BlocageActivity.kt` | L'écran affiché à la place d'Instagram. |
| `app/…/Depot.kt` | Sauvegarde des réglages (JSON dans les SharedPreferences). |
| `signature/gardefou.jks` | Clé de signature de l'APK (voir plus bas). |

L'appli n'a pas la permission Internet : rien ne sort du téléphone.

## Installer sur ton téléphone

1. Récupère l'APK : sur GitHub, onglet **Actions** → dernier run « garde-fou » → **Artifacts** → `garde-fou-apk` (un zip qui contient `garde-fou.apk`). Il faut être connecté à GitHub.
2. Ouvre l'APK sur le téléphone. Android demande d'autoriser ton navigateur ou ton gestionnaire de fichiers à « installer des applis inconnues » : accepte. Play Protect peut afficher un avertissement (appli inconnue) : « Installer quand même ».
3. Ouvre Garde-fou. Une carte demande d'activer le **service d'accessibilité** :
   - Sur Android 13 et plus, une appli installée hors Play Store est d'abord bridée : *Infos de l'appli* → menu ⋮ en haut à droite → **Autoriser les paramètres restreints**. (Le menu n'apparaît qu'après avoir essayé une fois d'activer le service.)
   - Puis *Accessibilité* → *Applis installées* → *Garde-fou* → activer.
4. Désactive l'optimisation de batterie pour Garde-fou si ton téléphone tue les services (Xiaomi, Samsung, Oppo…) : *Infos de l'appli* → *Batterie* → *Sans restriction*.

Pour mettre à jour : installe le nouvel APK par-dessus, les réglages sont conservés.

## Construire toi-même

Avec [Android Studio](https://developer.android.com/studio) : *Open* → dossier `garde-fou/`, branche le téléphone en USB (mode développeur + débogage USB activés), bouton ▶.

En ligne de commande (JDK 17 et SDK Android installés) :

```bash
./gradlew :core:test
```

```bash
./gradlew :app:assembleRelease
```

L'APK sort dans `app/build/outputs/apk/release/`.

## Limites à connaître

- **Ça se contourne** : il suffit de couper le service d'accessibilité ou de désinstaller l'appli. C'est un garde-fou, pas un coffre-fort ; le mode strict ajoute juste un peu de friction.
- **Instagram dans le navigateur** n'est pas concerné, seulement l'appli.
- **La détection des Reels dépend d'Instagram.** Elle repère une vue interne (`clips_viewer_view_pager`). Les Reels qui défilent dans le fil d'accueil ne sont pas bloqués, seulement l'écran Reels plein écran.

### Si les Reels ne sont plus détectés

Une mise à jour d'Instagram peut renommer la vue. Pour retrouver le bon nom : téléphone branché en USB, écran des Reels ouvert, puis

```bash
adb shell uiautomator dump /sdcard/ecran.xml
```

```bash
adb pull /sdcard/ecran.xml
```

Cherche dans le fichier un `resource-id` qui contient `clips` ou `reel`, et ajoute-le à `DETECTEURS_SHORTS` dans `GardeService.kt`.

## La clé de signature

Android refuse d'installer une mise à jour signée avec une autre clé que la version déjà installée. La clé `signature/gardefou.jks` est donc commitée, mot de passe compris, pour que tous les APK (CI ou PC) soient compatibles entre eux. Ce n'est acceptable que pour une appli perso jamais publiée : n'installe que des APK que tu as construits toi-même.
