# Étape 14 — Gouvernance de l'usage

**Objectif** : à la fin de cette étape, tu sais expliquer comment une plateforme LLM limite et compte ce que consomment ses utilisateurs, où ces décisions sont prises dans le chemin d'une requête, où vivent les compteurs, et comment remonter d'un `429` jusqu'à la valeur exacte qui l'a déclenché. Tu sais surtout **vérifier** qu'une route est protégée au lieu de le supposer.

**Notions couvertes** : §6 (quotas, rate limiting, compteurs en cache clé-valeur, table de routage réelle, consommation et facturation par organisation).

**Prérequis** : étape 11 (carte), étape 12 (gateway), étape 13 (identité, organisation, clés API).

---

## 14.1 Pourquoi gouverner l'usage

Une requête LLM ne coûte pas comme une requête web classique. Afficher une page coûte quelques millisecondes de CPU ; générer 2 000 tokens sur un grand modèle mobilise un GPU pendant des secondes. Et ce coût est **très variable** d'une requête à l'autre (taille du prompt, longueur de la réponse, modèle, outils appelés).

Sans gouvernance :

- **un seul script** en boucle sature les GPU et dégrade tous les autres utilisateurs (« voisin bruyant ») ;
- une clé API fuitée devient une **facture** (inférence déportée) ou une **panne** (inférence locale) ;
- le client ne peut pas répartir la capacité entre ses équipes ni refacturer en interne ;
- tu ne peux pas répondre à « qui consomme quoi ? », qui sera posée à la première réunion de pilotage.

Quatre mécanismes distincts, souvent confondus :

| Mécanisme | Question | Horizon | Réponse en cas de dépassement |
|---|---|---|---|
| **Rate limiting** | Combien de requêtes / tokens *par unité de temps* ? | Seconde, minute | `429`, réessayer bientôt |
| **Quota** | Combien *au total* sur une période ? | Jour, mois | `429` (ou `402`/`403` selon la plateforme), attendre la période suivante ou relever le quota |
| **Limite de concurrence** | Combien de requêtes *en même temps* ? | Instantané | `429` ou mise en file |
| **Comptabilisation (metering)** | Combien a été consommé, par qui ? | Continu, rétrospectif | Aucune : c'est un enregistrement, pas un blocage |

Les trois premiers **décident** (avant l'inférence). Le quatrième **constate** (après). Ils ne vivent pas au même endroit, n'ont pas la même exigence de précision, et ne cassent pas de la même façon.

---

## 14.2 Où se place la décision : en amont de l'inférence

```
requête ─▶ gateway ─▶ authN (qui ?) ─▶ rattachement (quelle org / projet / clé ?)
        ─▶ GOUVERNANCE : rate limit, quota, concurrence   ◀── lit/incrémente le cache KV
        ─▶ routeur de modèles ─▶ inférence
        ─▶ réponse
        ─▶ METERING : tokens réels consommés                ──▶ bus ─▶ base analytique / facturation
```

Trois contraintes d'ordre, à comprendre plutôt qu'à apprendre :

1. **Après l'authentification** : on ne peut pas compter pour une organisation qu'on n'a pas identifiée. Corollaire : le trafic *non authentifié* (tentatives de login, clés invalides) doit être limité **ailleurs**, typiquement à la gateway, par IP (étape 12).
2. **Avant l'inférence** : l'intérêt est de ne pas dépenser le GPU. Un rate limit appliqué après génération protège la facture, pas la capacité.
3. **Le metering après la réponse** : le nombre réel de tokens de sortie n'est connu qu'à la fin (surtout en streaming).

D'où une difficulté inhérente : **au moment de décider, on ne connaît pas le coût réel.** Stratégies courantes :

- compter en **requêtes** (simple, imprécis) ;
- **estimer** les tokens d'entrée (le prompt est connu) et réserver le `max_tokens` demandé, puis **ajuster** à la fin avec le réel ;
- décider sur la consommation **passée** (le quota se ferme à la requête suivante celle qui l'a dépassé).

Conséquence à connaître et à dire : **un quota peut être légèrement dépassé.** Une requête acceptée à 99 % du quota peut consommer au-delà. Ce n'est pas un bug, c'est le modèle.

---

## 14.3 Les dimensions de la limite

Une limite a toujours quatre composantes. Quand tu lis une configuration ou un message d'erreur, identifie-les :

| Composante | Exemples |
|---|---|
| **Sujet** (qui est compté) | organisation, projet, clé API, utilisateur, IP |
| **Ressource** (quoi) | requêtes, tokens d'entrée, tokens de sortie, tokens totaux, requêtes concurrentes, documents ingérés, minutes audio |
| **Périmètre** (sur quoi) | tous modèles, un modèle, une famille d'APIs (chat, embeddings, OCR) |
| **Fenêtre** (quand) | par seconde, minute, jour, mois calendaire, mois glissant |

« 429 rate limit exceeded » ne suffit pas. « 429 : organisation `acme`, tokens de sortie, modèle `large`, fenêtre 1 min, 100 000/100 000 » est un diagnostic. Un bon système renvoie ces informations dans la réponse ; sinon, tu vas les chercher dans le compteur (14.6).

**Hiérarchie.** Les limites s'empilent souvent : plateforme > organisation > projet > clé. La requête est refusée par **la première limite atteinte**, qui n'est pas forcément celle à laquelle on pense. Un client qui relève le quota de sa clé et reçoit toujours des `429` a atteint celui de son organisation.

**Limites sur des modèles partagés.** En inférence locale, la capacité GPU est finie et partagée : un quota par organisation ne garantit pas la disponibilité si la somme des quotas dépasse la capacité réelle. C'est de la **surréservation**, parfois voulue, à expliciter au client (étape 15 pour le dimensionnement).

---

## 14.4 Les algorithmes, juste assez pour lire une config

| Algorithme | Principe | Comportement visible |
|---|---|---|
| **Fenêtre fixe** | Compteur remis à zéro chaque minute pleine | Rafales possibles aux frontières (99 à 12:00:59, 100 à 12:01:00) |
| **Fenêtre glissante** | Compte les N dernières secondes, pondérée ou par journal d'horodatages | Plus lisse, un peu plus coûteux |
| **Token bucket** | Un seau se remplit à débit constant jusqu'à une capacité ; chaque requête prend des jetons | Autorise des **rafales** jusqu'à la capacité, puis impose le débit moyen |
| **Leaky bucket** | File qui se vide à débit constant | Lisse le trafic, ajoute de la latence plutôt que des refus |
| **Sémaphore** | Compteur incrémenté à l'entrée, décrémenté à la sortie | Limite de concurrence |

Les deux notions qui piègent :

- **`limit` et `burst` ne sont pas la même chose.** « 60/min, burst 20 » autorise 20 requêtes d'un coup puis une par seconde, pas 60 d'un coup.
- **Un sémaphore de concurrence doit être libéré.** Si un pod meurt au milieu d'une requête longue (streaming), le décrément n'a jamais lieu. Sans expiration (TTL) sur l'entrée, la concurrence disponible **fuit** jusqu'à ce que l'organisation soit bloquée en permanence. Symptôme : `429` de concurrence alors que personne n'utilise rien ; disparaît après redémarrage du cache ou expiration. À connaître absolument.

---

## 14.5 Les compteurs vivent dans le cache clé-valeur

Plusieurs réplicas du composant de gouvernance (ou de l'API) reçoivent les requêtes d'une même organisation. Un compteur **en mémoire dans chaque pod** donnerait une limite multipliée par le nombre de réplicas — et remise à zéro à chaque redémarrage. Les compteurs doivent donc être **partagés** : c'est le rôle du cache KV (type Redis / Valkey) du plan de données.

Pourquoi un cache KV et pas la base relationnelle : il faut une opération **atomique, en mémoire, en quelques microsecondes**, sur chaque requête, avec **expiration automatique**. Typiquement :

```
INCRBY  rl:org:acme:tokens_out:model:large:202609171204   1850
EXPIRE  rl:org:acme:tokens_out:model:large:202609171204   120
```

Une clé par sujet × ressource × périmètre × fenêtre ; le suffixe temporel fait office de fenêtre fixe, l'expiration fait le ménage. Les implémentations sérieuses regroupent lecture, comparaison et incrément dans un **script atomique** (sinon deux réplicas lisent 99 en même temps et acceptent chacun).

### Ce qui se passe quand le cache tombe

C'est la question la plus importante de l'étape, parce que la réponse est **un choix de conception** que tu dois connaître pour chaque plateforme :

| Comportement | Effet si le cache est indisponible | Risque |
|---|---|---|
| **Fail-closed** | Toutes les requêtes gouvernées sont refusées (`429`, `503` ou `500`) | Panne générale du produit pour une panne de cache |
| **Fail-open** | Les requêtes passent sans limite | Voisin bruyant, facture, saturation GPU — mais le produit reste disponible |
| **Repli local** | Chaque pod applique une limite en mémoire | Limite approximative (× nombre de réplicas), dégradé mais borné |

Ni l'un ni l'autre n'est « le bon » dans l'absolu ; l'important est de **savoir lequel est configuré** et de le dire au client. Une panne de cache en fail-closed ressemble à « tout le monde prend des 429 », ce qui oriente à tort vers une configuration de quota.

Autres effets d'une panne ou d'un vidage du cache (à relier à la carte) :

- compteurs remis à zéro → une organisation qui était bloquée repasse ;
- sessions perdues (étape 13) → déconnexion générale en même temps ;
- sémaphores de concurrence fuités → **libérés** (d'où le « redémarrer Redis a réglé le problème » qui masque la vraie cause).

### Latence et capacité du cache

Chaque requête ajoute un ou plusieurs allers-retours au cache. Un cache saturé, lointain (autre zone), ou dont le pooler de connexions côté client est trop petit ajoute de la latence **à toutes les requêtes**, avant même l'inférence. Symptôme : temps avant le premier token qui grimpe uniformément, GPU peu chargés. Descendre d'un plan (étape 11).

---

## 14.6 Remonter d'un 429 au compteur

La méthode, dans l'ordre.

### 1. Qui a répondu 429 ?

Plusieurs composants peuvent renvoyer un `429`, pour des raisons totalement différentes :

| Émetteur | Indice | Cause |
|---|---|---|
| **Ingress controller / gateway** | Page HTML générique, en-tête `server:` du controller, log du controller | Limite par IP ou connexions configurée à la gateway (étape 12) |
| **Composant de gouvernance / API** | Corps JSON de la plateforme, code d'erreur métier | Quota ou rate limit applicatif |
| **Moteur d'inférence local** | Erreur propagée par le routeur, file pleine | Capacité GPU saturée (file d'attente du serveur d'inférence pleine) |
| **Fournisseur de modèles déporté** | Message du fournisseur relayé, en-têtes du fournisseur | Limite du **compte de la plateforme** chez le fournisseur, commune à tous les clients |
| **Service externe appelé par un outil** | Erreur dans une trace d'agent / connecteur | API tierce (recherche web, SaaS) |

Les deux derniers cas sont les plus trompeurs : **l'organisation du client n'a rien dépassé**, et relever son quota ne change rien.

### 2. Lire la réponse

```bash
curl -s -D - -o body.json -H @<(printf 'Authorization: Bearer %s\n' "$PLT_KEY") \
  https://api.client.com/v1/chat/completions -d @req.json | grep -iE '^(HTTP|server|retry-after|x-ratelimit|x-request-id)'
jq . body.json
```

En-têtes à chercher (les noms exacts varient) :

- `Retry-After` : secondes avant de réessayer (fenêtre courte) ou date (quota) ;
- `X-RateLimit-Limit`, `-Remaining`, `-Reset` (souvent déclinés par ressource : requêtes, tokens) ;
- un identifiant de requête pour la corrélation.

Un `Retry-After` de quelques secondes suggère un rate limit ; de plusieurs heures, un quota ; absent, un 429 d'un autre émetteur que la gouvernance.

### 3. Identifier le sujet et la ressource

À partir de l'identifiant de requête, retrouve la ligne du composant de gouvernance :

```bash
kubectl logs -n platform deploy/<gouvernance-ou-api> --since=10m | grep '<request-id>'
```

Tu dois en tirer : organisation / projet / clé, ressource, périmètre, fenêtre, limite, valeur courante. Si les logs ne donnent pas ces éléments, c'est un **retour produit** à faire (un 429 inexplicable est un ticket support garanti).

### 4. Lire le compteur

Sur un environnement de test, ou chez un client **avec son accord et en lecture seule** :

```bash
# le mot de passe du cache vient d'un Secret : jamais affiché, jamais en argument
kubectl exec -it -n platform <pod-cache> -- sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --scan --pattern "rl:org:acme:*" | head'
kubectl exec -it -n platform <pod-cache> -- sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli GET "rl:org:acme:tokens_out:model:large:202609171204"; REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli TTL "rl:org:acme:tokens_out:model:large:202609171204"'
```

Règles :

- **`--scan`, jamais `KEYS *`** : `KEYS` bloque le cache (mono-thread) le temps de parcourir toutes les clés — sur une plateforme en production, c'est toi qui provoques la panne.
- Le **format des clés** est un détail d'implémentation : lis-le dans le code ou la doc de la version déployée, ne le suppose pas d'après une autre version.
- Ne **modifie** jamais un compteur pour « débloquer » un client en production : c'est une correction ponctuelle invisible, qui sera annulée ou oubliée (étape 2). Le geste durable est de changer la limite dans la configuration versionnée, ou via la console d'administration, avec une trace.

### 5. Comparer à la configuration

Où est définie la limite qui s'applique ? Plusieurs sources possibles, par ordre de spécificité :

- défauts de la plateforme (values du chart) ;
- palier / offre de l'organisation ;
- surcharge par organisation ou projet (base, console admin) ;
- surcharge par clé.

Vérifie laquelle gagne. Le cas classique : la valeur a été changée dans la console, mais un **cache de configuration** (TTL) fait que les pods appliquent encore l'ancienne.

---

## 14.7 Vérifier la table de routage réelle

Point le plus sous-estimé de l'étape :

> **Ne suppose jamais que toutes les routes passent par la gouvernance. Vérifie le chemin réel de chaque route.**

Pourquoi des routes y échappent, en pratique :

- **Plusieurs Ingress / plusieurs hosts** : l'API publique passe par le composant de quota, mais un autre host (celui de l'UI, d'un service interne exposé, d'une API de compatibilité) route **directement** vers le routeur de modèles ou un moteur d'inférence.
- **Routes ajoutées après coup** : un nouvel endpoint (embeddings, OCR, transcription, nouvelle version d'API `/v2`) implémenté sans le middleware de quota.
- **Appels internes** : l'UI conversationnelle, les agents, le RAG (embeddings d'ingestion), les tâches planifiées appellent le routeur **de l'intérieur**, souvent sans passer par la gouvernance — ou avec une identité de service non limitée. Une ingestion massive de documents peut ainsi saturer les GPU sans jamais toucher un quota.
- **Accès direct au Service** : un moteur d'inférence en `ClusterIP` est joignable par **n'importe quel pod** du cluster si aucune NetworkPolicy ne l'interdit.
- **Réécritures de chemin** à la gateway (étape 12) : la règle d'exclusion `/health` en `Prefix` qui exclut aussi `/healthcheck-bypass/...`.

Méthode de vérification :

```bash
# 1. Toutes les expositions : quel host / chemin → quel Service
kubectl get ingress,httproute -A -o yaml | yq -N '
  .items[] | select(.kind=="Ingress") | .spec.rules[] as $r | $r.http.paths[] |
  $r.host + "  " + .path + "  →  " + .backend.service.name + ":" + (.backend.service.port.number // .backend.service.port.name | tostring)'

# 2. Pour chaque Service cible : est-ce la gouvernance, ou un composant en aval ?
#    Tout backend qui est le routeur ou un moteur d'inférence = contournement potentiel.

# 3. Qui peut joindre le routeur / l'inférence depuis le cluster ?
kubectl get networkpolicy -n platform -o yaml | yq '.items[] | {"name": .metadata.name, "podSelector": .spec.podSelector, "ingress": .spec.ingress}'
```

Puis **le test empirique**, qui seul fait foi : épuise une petite limite sur une organisation de test via l'API publique, et vérifie que **chaque autre chemin** (autre host, UI, endpoint embeddings, appel direct depuis un pod de test au Service du routeur) est refusé lui aussi — ou note explicitement qu'il ne l'est pas.

Le résultat attendu n'est pas forcément « tout passe par le quota » : il est normal que certains appels internes soient exemptés. Ce qui n'est pas normal, c'est de ne pas le **savoir**. Livrable : une table « route → gouvernée oui/non → pourquoi ».

---

## 14.8 Consommation et facturation par organisation

Le metering répond à « qui a consommé quoi », après coup.

### Le chemin des données

```
fin de requête (tokens entrée/sortie réels, modèle, org, projet, clé, durée, statut)
 ─▶ événement publié sur le bus de messages
 ─▶ consommateur ─▶ base analytique colonnaire (agrégations par jour / org / modèle)
 ─▶ tableaux de bord, export, facturation, refacturation interne du client
```

Pourquoi un bus et une base analytique plutôt qu'un `INSERT` dans la base relationnelle à chaque requête : le volume (une ligne par requête), l'écriture ne doit pas ralentir la réponse, et les requêtes d'analyse (« tokens par modèle par équipe sur 90 jours ») sont exactement ce pour quoi une base colonnaire est faite.

### Ce qui distingue le metering des compteurs de quota

| | Compteurs de quota (cache KV) | Metering (base analytique) |
|---|---|---|
| But | Décider maintenant | Constater, facturer, analyser |
| Précision | Approximative, éphémère | Doit être exacte et durable |
| Durée de vie | Minutes à un mois (TTL) | Mois, années |
| Si ça tombe | Blocage ou passage libre (14.5) | **Rien de visible immédiatement** — données perdues ou retardées |

Le second point de la dernière ligne est crucial : **une panne du metering est silencieuse** (étape 11). Le produit fonctionne, les utilisateurs sont contents, et en fin de mois le rapport de consommation montre un trou. Selon la conception, les événements sont conservés dans le bus et rattrapés (retard) ou perdus (trou définitif). Il faut savoir lequel, et **surveiller le retard du consommateur** (lag) plutôt que découvrir le trou au moment de la facture.

### Pièges de comptabilisation

- **Double comptage** : un consommateur qui redémarre et relit des événements sans idempotence (identifiant d'événement unique).
- **Requêtes interrompues** : un client coupe le streaming à mi-réponse. Les tokens générés jusque-là ont coûté du GPU ; sont-ils comptés ?
- **Requêtes en échec** : une erreur après génération partielle ; un `429` (normalement non compté).
- **Appels internes** (14.7) : l'ingestion RAG, les agents, les évaluations consomment ; à quelle organisation sont-ils imputés ? Parfois à aucune — la consommation réelle des GPU est alors supérieure à la somme des consommations facturées.
- **Tokenisation** : le nombre de tokens dépend du tokenizer du modèle ; une estimation faite par un autre composant ne coïncide pas avec le décompte du moteur.
- **Fuseau horaire des agrégations** : un « jour » en UTC n'est pas le jour du client. Écarts en bord de période, source classique de contestation.
- **Rattachement mouvant** : un projet déplacé d'une organisation à une autre ; la consommation passée suit-elle ?

Dire au client : ce qui est compté, ce qui ne l'est pas, le délai de mise à jour des tableaux de bord, et la source de vérité en cas d'écart.

---

## 14.9 Côté client de l'API : bien consommer

Tu seras interrogé par les développeurs du client. Les réponses à connaître :

- **Un 429 se réessaie avec un backoff exponentiel et du jitter**, en respectant `Retry-After`. Sans jitter, tous les clients réessaient au même instant et recréent la rafale.
- **Ne jamais réessayer un 429 de quota** en boucle serrée : il ne se lèvera pas avant la période suivante.
- **Limiter la concurrence côté client** (pool de N requêtes) plutôt que lancer 500 requêtes et gérer 480 refus.
- **Traitements en masse** : utiliser une API de traitement par lots si la plateforme en propose, ou étaler.
- **Une clé par application**, pas une clé partagée par toute l'entreprise : sinon impossible de savoir qui consomme, et un seul script bloque tout le monde.
- Les SDK compatibles OpenAI réessaient souvent **automatiquement** un certain nombre de fois : un client qui « ne voit jamais de 429 » mais constate une latence énorme les subit en silence.

---

## 14.10 Pièges

- **Confondre rate limit, quota, concurrence et metering** ; parler de « quota » pour un 429 à la seconde.
- **Supposer l'émetteur du 429** : gateway, gouvernance, moteur d'inférence saturé, fournisseur déporté, API tierce.
- **Relever le quota de la clé** quand c'est celui de l'organisation (ou du compte fournisseur) qui est atteint.
- **Compteurs en mémoire par pod** : limite × nombre de réplicas.
- **Ignorer le comportement fail-open / fail-closed** du cache.
- **Sémaphore de concurrence fuité** après crash de pods ; « résolu » par un redémarrage du cache sans comprendre.
- **`KEYS *` sur un cache de production.**
- **Modifier un compteur à la main** pour débloquer un client.
- **Cache de configuration** qui retarde l'application d'une nouvelle limite.
- **Routes non gouvernées** : second host, nouvel endpoint, appels internes, Service d'inférence joignable de tout le cluster.
- **Trafic non authentifié non limité** (la gouvernance est après l'authentification).
- **Quota « légèrement dépassé »** signalé comme bug.
- **Somme des quotas > capacité GPU** non explicitée.
- **Panne silencieuse du metering** ; lag du consommateur non surveillé.
- **Double comptage** et **appels internes non imputés**.
- **Fuseau horaire** des agrégations de consommation.
- **Retries sans jitter** côté client qui transforment un pic en tempête.

---

## 14.11 Exercice — déclencher un 429 et remonter au compteur

Sur ton cluster kind.

### Partie 1 — Mettre en place une gouvernance minimale

1. Déploie un cache KV (chart Valkey/Redis) avec mot de passe dans un Secret, **sans persistance** (c'est un cache).
2. Déploie un backend factice « d'inférence » : une petite API qui répond après un délai configurable avec un nombre de « tokens » dans le JSON.
3. Place devant lui une couche de gouvernance, au choix :
   - **Option A (gateway)** : un proxy qui sait faire du rate limiting distribué adossé à Redis (par exemple Envoy + service de rate limit, ou Kong/APISIX avec leur plugin) ;
   - **Option B (applicative)** : écris toi-même un petit service FastAPI qui, pour chaque requête : lit l'en-tête de clé, la mappe à une organisation (dictionnaire en config), fait un `INCR` + `EXPIRE` atomique (script Lua) sur une clé par organisation et par minute, refuse au-delà de la limite avec un `429`, `Retry-After`, et des en-têtes `X-RateLimit-*`, logue sujet / ressource / fenêtre / limite / valeur, puis relaie au backend.
   L'option B est plus formatrice : c'est ce que tu liras chez les autres.
4. Ajoute une **limite de concurrence** par organisation (sémaphore dans Redis, avec et sans TTL — tu vas comparer).
5. Configure **deux réplicas** de la couche de gouvernance.

### Partie 2 — Déclencher et remonter

1. Organisation `acme`, limite 10 requêtes/min. Envoie 15 requêtes. Pour la 11e :
   - code, `Retry-After`, `X-RateLimit-*` ;
   - ligne de log correspondante (par identifiant de requête), **sur le bon réplica** ;
   - clé Redis, valeur, TTL (avec `--scan`).
   Écris la chaîne complète : réponse → log → compteur → configuration.
2. **Démonstration du compteur local** : modifie temporairement la gouvernance pour compter en mémoire du pod. Envoie 25 requêtes. Combien passent ? Pourquoi ? Remets le compteur partagé.
3. **Limite en tokens** : ajoute une limite de 1 000 « tokens »/min, en comptant les tokens renvoyés par le backend *après* la réponse. Montre qu'une requête peut faire dépasser le quota. Note le comportement.

### Partie 3 — Pannes

| # | Provocation | À observer et noter |
|---|---|---|
| 1 | Cache scalé à 0 (en maîtrisant ce qui le recrée) | Comportement actuel de ta gouvernance : fail-open ou fail-closed ? Codes renvoyés. Change-le et compare. |
| 2 | Cache redémarré pendant qu'`acme` est bloquée | Le blocage disparaît. Pourquoi. |
| 3 | Sémaphore de concurrence **sans TTL**, pod de gouvernance tué pendant des requêtes longues | Concurrence « fuitée » : `429` sans trafic. Retrouve les entrées orphelines. Refais avec TTL. |
| 4 | Latence artificielle ajoutée entre gouvernance et cache (ou cache limité en CPU) | Augmentation uniforme de la latence avant le backend |
| 5 | Limite `429` par IP ajoutée **aussi** à l'ingress controller, plus basse | Deux émetteurs de `429` : distingue-les par le corps, `server:`, les logs |

### Partie 4 — Table de routage réelle

1. Ajoute volontairement un second Ingress (autre host) qui route **directement** vers le backend factice, et un pod « interne » qui l'appelle par son Service.
2. Épuise la limite d'`acme` par le chemin nominal, puis appelle par le second host et par le pod interne.
3. Écris la table : route → gouvernée ? → preuve (commande et code obtenu).
4. Ferme les contournements : supprime l'Ingress fautif, ajoute une NetworkPolicy qui n'autorise l'accès au backend que depuis la gouvernance (avec un CNI qui les applique). Revérifie.

### Partie 5 — Metering (léger)

1. Fais publier par la gouvernance un événement par requête (dans une liste ou un stream Redis, ou un bus léger) : org, clé, tokens, statut, horodatage UTC, identifiant d'événement.
2. Écris un consommateur qui agrège par organisation et par jour dans un fichier ou une petite base.
3. Arrête le consommateur 5 minutes pendant du trafic, relance-le : les événements sont-ils rattrapés ? Redémarre-le deux fois de suite : y a-t-il double comptage ? Corrige avec l'identifiant d'événement.

### Partie 6 — Sur l'environnement de preview (lecture seule)

1. Identifie le composant de gouvernance, où sont définies les limites (values, base, console), leurs dimensions et leur hiérarchie.
2. Identifie le cache utilisé, et le comportement en cas de panne (config ou doc ; sinon « à vérifier »).
3. Fais la table de routage réelle (14.7) sur au moins l'API publique, l'UI, les embeddings et un appel interne (agent ou ingestion). Note ce qui n'est pas gouverné et si c'est voulu.
4. Retrouve le chemin du metering jusqu'à la base analytique, et comment on voit un retard.
5. Si tu disposes d'une organisation de test avec une limite basse : déclenche un `429` via l'API publique et remonte jusqu'au log et à la configuration — **sans modifier aucun compteur**.

**Livrable** : section « Gouvernance de l'usage » de `carte-plateforme-<version>.md` : composant, dimensions et hiérarchie des limites, emplacement des compteurs, fail-open/fail-closed, table de routage gouvernée, chemin du metering, ce qui est compté ou non, et la procédure « 429 → compteur » en cinq commandes.

---

## Validé si…

Tu peux expliquer à voix haute :

- la différence entre rate limit, quota, limite de concurrence et metering, et où chacun agit ;
- pourquoi la gouvernance se place après l'authentification et avant l'inférence, et pourquoi un quota peut être légèrement dépassé ;
- les quatre composantes d'une limite, et pourquoi relever un quota ne suffit pas toujours ;
- pourquoi les compteurs vivent dans un cache partagé, et ce qu'une implémentation locale produirait ;
- ce que fait ta plateforme quand le cache tombe, et le symptôme de chaque choix ;
- ce qu'est une fuite de sémaphore de concurrence et comment elle se manifeste ;
- cinq émetteurs possibles d'un `429` et comment les distinguer ;
- la procédure pour remonter d'un `429` au compteur, et les deux gestes interdits en production (`KEYS *`, modifier un compteur) ;
- quatre raisons pour lesquelles une route peut échapper à la gouvernance, et comment le prouver ;
- pourquoi une panne du metering est silencieuse, et trois pièges de comptabilisation ;
- ce qu'un développeur client doit faire face à un `429`.

**Étape suivante** : `etape-15-inference-routage-gpu.md` — inférence, routage de modèles et GPU.
