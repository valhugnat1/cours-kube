# Étape 16 — Fonctionnalités produit autour du modèle

**Objectif** : à la fin de cette étape, tu sais relier chaque fonctionnalité visible par l'utilisateur (chat, documents, connecteurs, agents, exécution de code, tâches planifiées, audio) aux composants qui la réalisent, suivre un document depuis son dépôt jusqu'aux vecteurs en base, et dire pour chaque fonctionnalité **ce qui casse, où, et avec quel symptôme**. Tu sais aussi quelles fonctionnalités sont des **surfaces de risque** et comment elles sont isolées.

**Notions couvertes** : §8 (UI conversationnelle, console admin, gestionnaire de configuration, canvas et isolation, RAG, ingestion, crawler, connecteurs et callbacks OAuth, agents, conversations, deep research, sandboxes de code, workflows durables et tâches planifiées, registres de prompts/skills, audio).

**Prérequis** : étape 11 (carte), 12 (egress, SSRF, domaine du contenu généré), 13 (identité, ReBAC), 14 (gouvernance, appels internes), 15 (modèles spécialisés, embeddings).

---

## 16.1 Le principe : une fonctionnalité = un chemin à travers la carte

Un utilisateur ne voit pas de pods. Il voit « le chat ne cite pas mon document », « le connecteur SharePoint ne se connecte pas », « l'agent tourne dans le vide ». Ton travail est de traduire chaque phrase en **chemin de composants**, puis d'appliquer la règle « descendre d'un plan ».

La plupart des fonctionnalités de cette étape partagent trois propriétés qui changent la façon de diagnostiquer :

1. **Elles sont asynchrones.** L'utilisateur déclenche, un worker traite plus tard. Pas de code HTTP d'erreur à l'instant T : juste un statut qui ne bouge pas (« en cours d'indexation »). Il faut suivre une **tâche**, pas une requête.
2. **Elles appellent le modèle de l'intérieur.** Un agent, une ingestion, une recherche approfondie font des dizaines d'appels au routeur sans passer par l'API publique (étape 14 : gouvernance et imputation).
3. **Elles touchent l'extérieur ou exécutent du contenu non fiable.** Crawler, connecteurs, sandboxes de code, canvas : ce sont les surfaces d'attaque de la plateforme (étape 12 : SSRF, isolation).

Tableau d'orientation, à compléter avec les noms réels de ta plateforme à l'exercice :

| Fonctionnalité | Synchrone ? | Appelle le modèle | Sort du cluster | Exécute du non-fiable | Plan de données touché |
|---|---|---|---|---|---|
| Chat simple | Oui (streaming) | Oui | Si modèle déporté | Non | Base (conversations), cache |
| Chat avec documents (RAG) | Oui, après indexation | Oui + embeddings | Si déporté | Non | Base vectorielle, objet |
| Ingestion de documents | **Non** | Embeddings, OCR | Si déporté | Fichiers utilisateurs parsés | Objet, bus, base, vectorielle |
| Import par URL / crawler | **Non** | Embeddings | **Oui** | Pages web | Idem |
| Connecteurs | **Non** (sync) / oui (outil) | Selon usage | **Oui** | Contenu tiers | Base (jetons), vectorielle |
| Agents / outils | Oui, long | **Beaucoup** | Selon outils | Selon outils | Base, workflows |
| Deep research | **Non**, très long | **Énormément** | **Oui** | Pages web | Workflows, objet |
| Sandbox de code | Oui | Non (c'est l'agent qui l'appelle) | Normalement **non** | **Oui** | Objet (fichiers) |
| Canvas / artefacts | Oui | Oui | Non | **Oui** (navigateur) | Objet |
| Tâches planifiées | **Non** | Oui | Selon tâche | Selon tâche | Workflows |
| Audio | Selon mode | Transcription (+ synthèse) | Si déporté | Non | Objet |

---

## 16.2 Les interfaces : UI conversationnelle, console admin, gestionnaire de configuration

### UI conversationnelle

Le frontend (souvent une SPA servie par un petit serveur ou un CDN interne) et son backend (« BFF », *backend for frontend*) qui gère la session (étape 13), l'historique, le streaming des réponses.

À savoir :

- **Frontend et backend échouent séparément.** Page blanche ou erreur JavaScript = frontend (image, configuration injectée au démarrage, URL de l'API mal construite, CSP trop stricte). Page qui s'affiche mais « Une erreur est survenue » = backend ou en dessous. Ouvre la réponse réseau, lis le code (étape 20).
- **Configuration runtime du frontend.** Une SPA compilée ne lit pas de variables d'environnement : l'URL de l'API, de l'IdP, le domaine du contenu généré lui sont souvent injectés par un fichier `config.js`/`env.json` généré au démarrage du pod. Mauvaise valeur dans les values → le navigateur appelle un host qui n'existe pas (ou celui d'un autre environnement). Vérifier ce fichier servi, pas seulement les values.
- **Cache navigateur / CDN** après une montée de version : ancien JavaScript contre nouvelle API. Symptôme : erreurs pour certains utilisateurs seulement, réglé par un rechargement forcé.
- **Streaming** : buffering du proxy, timeouts du LB (étape 12). L'UI est la première à révéler ces réglages.
- **Conversations** : stockées en base (plan de données), avec leurs pièces jointes en stockage objet. « Mes conversations ont disparu » = mauvaise organisation/realm (étape 13), base différente (autre environnement), ou session sur un autre compte fédéré — rarement une perte de données.

### Console d'administration

Gestion des organisations, membres, rôles, clés API, quotas, modèles activés, connecteurs autorisés, rétention, journal d'audit. Deux points opérationnels :

- **Exposition** : host ou chemin distinct, idéalement restreint au réseau d'administration (étape 12).
- **Deux sources de vérité** : ce qui est réglé **dans la console** (stocké en base) et ce qui est réglé **dans les values** (versionné). Pour chaque réglage, il faut savoir lequel gagne, et si un `helm upgrade` écrase la console. Un réglage fait dans la console sur un environnement non sauvegardé disparaît avec lui.

### Gestionnaire de configuration

Composant (ou module) qui centralise la configuration applicative dynamique : fonctionnalités activées par organisation (*feature flags*), modèles par défaut, paramètres des connecteurs, prompts système. Il se lit souvent au démarrage **et** périodiquement, avec un cache.

Pièges :

- délai de propagation d'un changement (TTL du cache) pris pour « ça ne marche pas » ;
- valeur par défaut du chart **différente** de la valeur en base après une migration ;
- fonctionnalité désactivée par un flag, qui renvoie une **404** ou masque simplement un bouton : pas une panne.

---

## 16.3 Canvas et artefacts : exécuter du contenu généré, isolé

Le **canvas** (ou artefacts, aperçus) affiche et fait tourner dans le navigateur du HTML/JS/SVG **généré par le modèle** ou fourni par un utilisateur. C'est du code non fiable exécuté chez l'utilisateur, avec potentiellement sa session à portée de main.

Défenses en couches (rappel et suite de l'étape 12) :

1. **Domaine parent distinct** pour le contenu (`client-usercontent.com`), sans cookie de session de la plateforme.
2. **iframe `sandbox`** avec le strict minimum (`allow-scripts` sans `allow-same-origin` quand c'est possible).
3. **CSP** stricte sur le domaine du contenu : pas d'appels réseau arbitraires (`connect-src` limité), pas de framing inverse.
4. **Communication parent ↔ iframe** uniquement par `postMessage` avec vérification de l'origine.
5. **Pas de secret** (clé, jeton) injecté dans le contenu.

Conséquences d'installation :

- un **host**, un **enregistrement DNS**, un **certificat** et une **règle d'Ingress** de plus — souvent oubliés dans la liste envoyée au client ;
- si le client refuse un domaine distinct : écart de sécurité documenté, et éventuellement fonctionnalité désactivée ;
- en réseau restreint, les bibliothèques JavaScript que le contenu généré veut charger depuis des CDN publics **ne se chargeront pas** : le canvas « ne marche pas » alors que tout est normal. À annoncer (étape 23 : annoncer ses aspérités).

Diagnostic : console du navigateur (erreurs CSP explicites), requêtes vers le domaine du contenu, certificat de ce domaine.

---

## 16.4 RAG : de la bibliothèque à la réponse

**RAG** (*Retrieval-Augmented Generation*) : au lieu d'espérer que le modèle connaisse les documents du client, on retrouve les passages pertinents et on les injecte dans le prompt.

### Les deux moitiés

```
INDEXATION (asynchrone, en amont)
 source (upload, URL, connecteur)
  → stockage de l'original (objet)
  → extraction du texte (parsing ; OCR si image/scan)
  → découpage en passages (chunks)
  → embeddings de chaque passage (modèle d'embeddings)
  → écriture : passages + vecteurs + métadonnées + permissions (base vectorielle / base)
  → statut "indexé"

INTERROGATION (synchrone, à chaque question)
 question
  → embeddings de la question (même modèle !)
  → recherche des passages proches, FILTRÉE par ce que l'utilisateur a le droit de voir
  → (reranking)
  → prompt = instructions + passages + question
  → modèle de chat → réponse avec citations
```

### La bibliothèque

Objet métier qui regroupe des documents, avec un propriétaire, des membres, une organisation (relations ReBAC, étape 13). Deux règles de sécurité non négociables :

- **Le filtrage par permissions se fait au moment de la recherche**, pas après génération. Un passage d'une bibliothèque non autorisée qui entre dans le prompt a déjà fuité, même si l'UI ne le cite pas.
- **Les permissions d'une source externe** (connecteur SharePoint, Drive) doivent être **reportées** sur les passages indexés, et **mises à jour** quand elles changent à la source. Sinon, le RAG donne accès à des documents que l'utilisateur ne peut plus ouvrir.

### Les pannes de l'indexation, par étape

| Étape | Composant | Symptôme | Cause fréquente |
|---|---|---|---|
| Upload | API + stockage objet | Échec immédiat, `413`, erreur réseau | Limite de body à l'Ingress (étape 12), droits sur le bucket, stockage objet injoignable |
| File de tâches | Bus / moteur de workflows | Statut « en attente » indéfiniment | Bus plein ou arrêté, worker absent (0 réplica), mauvais nom de file / namespace |
| Extraction | Worker de parsing | Statut « échec » ou document vide | Format non supporté, PDF chiffré, fichier corrompu, dépendance manquante dans l'image |
| OCR | Modèle OCR | Très lent, ou texte vide sur les scans | Modèle OCR désactivé ou saturé, déporté et egress fermé |
| Embeddings | Modèle d'embeddings via routeur | Échec ou lenteur massive à l'ingestion | Rate limit interne, modèle saturé par une grosse ingestion, modèle désactivé |
| Écriture | Base vectorielle | Échec d'écriture | Dimension des vecteurs ≠ celle de l'index (modèle d'embeddings changé), base pleine |
| Statut | Base relationnelle | Document indexé mais statut bloqué | Callback / événement de fin perdu |

### Les pannes de l'interrogation

- **Réponse sans source alors que le document est indexé** : permissions (l'utilisateur n'est pas dans la bibliothèque), mauvaise bibliothèque sélectionnée, recherche vide car **modèle d'embeddings différent** entre indexation et question (vecteurs incomparables, étape 15).
- **Réponses hors sujet** : découpage inadapté, trop peu de passages, reranking désactivé, contexte tronqué (`max-model-len` trop court pour les passages injectés).
- **Lenteur** : embeddings de la question sur un modèle saturé par une ingestion en cours (même modèle pour les deux usages) — isoler ou prioriser.
- **Fuite entre utilisateurs** : filtrage de permissions absent ou appliqué après la recherche. C'est un incident de sécurité, pas un bug de pertinence.

---

## 16.5 Le crawler : worker, fetcher, fetcher headless

L'import par URL, l'exploration d'un site, la recherche web d'un agent reposent sur un sous-système en trois rôles, souvent trois déploiements :

```
demande "indexe https://docs.exemple.com (profondeur 2)"
  → CRAWLER WORKER : orchestre — file d'URLs, profondeur, déduplication, robots.txt, politesse (délai par domaine)
      → FETCHER : récupère une URL en HTTP simple (rapide, léger)
      → FETCHER HEADLESS : navigateur sans interface (Chromium) pour les pages qui n'existent qu'après exécution du JavaScript
  → contenu brut → extraction → même chemin que l'ingestion (16.4)
```

Pourquoi séparer :

- **Profils de ressources** très différents : un fetcher HTTP tient des centaines de requêtes avec peu de mémoire ; un navigateur headless consomme des centaines de Mo par page, fuit de la mémoire, plante. On les dimensionne et on les redémarre séparément.
- **Isolation** : les fetchers sont les composants qui **touchent Internet avec des URL fournies par des utilisateurs**. Ils portent le moins de droits possible, **sortent par le proxy anti-SSRF** (étape 12), et n'ont pas accès aux Services internes (NetworkPolicy).

À savoir sur le **fetcher headless** :

- un navigateur exécute tout le JavaScript d'une page arbitraire : c'est la surface d'attaque la plus exposée de la plateforme — pas de privilèges, système de fichiers en lecture seule, pas de jeton de ServiceAccount monté, limites mémoire strictes ;
- Chromium a besoin d'un **`/dev/shm` agrandi** (même piège qu'à l'étape 15) sinon il plante sur les pages lourdes ;
- sur OpenShift / Pod Security `restricted`, le *sandbox* interne de Chromium peut refuser de démarrer (namespaces utilisateurs, seccomp) : ne jamais « régler » ça par `privileged: true` ; chercher la configuration prévue par le produit ;
- OOM et redémarrages fréquents sont **normaux jusqu'à un certain point** : à mettre dans la liste des bruits connus (étape 22), avec un seuil.

Pannes et symptômes :

| Symptôme | Cause probable |
|---|---|
| Toute URL externe échoue, les uploads marchent | Egress / proxy fermé, `NO_PROXY` inversé, CA d'un proxy MITM non montée |
| Pages vides pour les sites modernes | Fetcher headless désactivé, en panne, ou pages non routées vers lui |
| Sites internes du client inaccessibles | **Normal** si le proxy anti-SSRF bloque les plages privées — à arbitrer avec le client, jamais en ouvrant tout |
| Ingestion d'un site interminable | Profondeur/limites trop larges, pièges à robots (calendriers infinis), politesse très lente |
| `403`/`429` des sites cibles | User-agent, IP de sortie du client bloquée ou limitée par les sites — hors plateforme |

**Point à arbitrer avec le client : indexer l'intranet.** C'est un besoin fréquent, et c'est exactement ce que la protection anti-SSRF interdit. La bonne réponse n'est pas de lever la protection pour tous, mais une **liste blanche explicite** de domaines internes autorisés, décidée et documentée par le client, idéalement réservée aux connecteurs ou à un fetcher dédié.

---

## 16.6 Connecteurs, gateway de connecteurs et callbacks OAuth

Un **connecteur** relie la plateforme à une source tierce : SharePoint, OneDrive, Google Drive, Confluence, Jira, Slack, messagerie, bases documentaires. Deux usages :

- **Synchronisation** : indexer le contenu de la source dans une bibliothèque (asynchrone, planifié) ;
- **Outil** : un agent interroge la source à la volée pendant une conversation.

### La gateway de connecteurs

Composant qui centralise : la liste des connecteurs disponibles et autorisés par organisation, les **jetons** des utilisateurs ou des comptes de service, leur **rafraîchissement**, les appels sortants vers les APIs tierces, parfois les webhooks entrants de ces sources.

Les jetons stockés sont **des secrets à haute valeur** (accès aux documents du client) : chiffrés en base, jamais logués, révocables, rattachés à un utilisateur et une organisation.

### Le flux OAuth d'un connecteur

C'est un authorization code (étape 13), mais **la plateforme est cette fois le client OAuth** d'un fournisseur tiers :

```
utilisateur clique "connecter SharePoint"
 → redirection vers le fournisseur (Entra ID) avec client_id de l'application enregistrée, redirect_uri, scopes, state
 → consentement de l'utilisateur (ou consentement admin préalable)
 → retour sur https://<plateforme>/connectors/oauth/callback?code=…&state=…
 → la gateway échange le code (appel sortant) → jetons d'accès + refresh
 → jetons chiffrés en base ; statut "connecté"
```

Ce qui casse, dans l'ordre où ça arrive en installation :

1. **Application non enregistrée chez le fournisseur** : il faut créer une application (Entra ID, Google Cloud, Atlassian) **dans le tenant du client ou de l'éditeur**, avec son `client_id`/`client_secret` en Secret. Qui la crée, dans quel tenant, qui la fait valider : à trancher dès le cadrage, c'est souvent **des semaines** chez un grand compte.
2. **`redirect_uri` non déclarée** ou différente (host interne vs public, chemin, slash) → erreur **chez le fournisseur**, avant tout log de la plateforme. Symptôme : page d'erreur Microsoft/Google, pas la plateforme.
3. **Callback injoignable** : la `redirect_uri` est appelée **par le navigateur** de l'utilisateur, donc le host doit être joignable depuis son poste — pas depuis Internet. En revanche, l'**échange du code** et les appels d'API partent **du pod** : egress, proxy, CA (étape 12).
4. **Scopes insuffisants** ou **consentement admin requis** → connexion réussie mais listes vides, ou `403` du fournisseur à la synchronisation.
5. **`state` invalide** : onglet périmé, ou callback arrivant sur un autre réplica sans session partagée (étape 13 : session dans le cache KV, sinon affinité).
6. **Refresh qui échoue des semaines plus tard** : secret de l'application expiré (Entra ID impose une date d'expiration), jeton révoqué, utilisateur parti. Symptôme : synchronisation silencieusement arrêtée. À surveiller et à documenter (date d'expiration du secret dans la carte).
7. **Webhooks entrants** (notifications de changements) : exigent que le fournisseur, **sur Internet**, puisse joindre la plateforme — impossible si la plateforme est privée. Repli sur une synchronisation périodique, plus lente.

---

## 16.7 Agents, conversations, deep research

### Agents et outils

Un **agent**, c'est une boucle :

```
messages + description des outils → modèle
  → le modèle répond "appelle l'outil X avec ces arguments"
  → la plateforme exécute X (recherche RAG, connecteur, web, code, API métier)
  → résultat ajouté aux messages → modèle → … → réponse finale
```

Tu connais le principe par LangGraph ; ce qui compte ici, c'est l'**exploitation** :

- **Le modèle doit supporter les appels d'outils** dans le format attendu. Un modèle local qui ne gère pas bien les tool calls (ou un moteur mal configuré pour les parser) donne un agent qui « répond au lieu d'agir », ou produit du JSON cassé. Symptôme typique après une bascule déporté → local (étape 15).
- **Chaque tour est un appel au modèle** : un agent qui fait 15 tours coûte 15 requêtes, avec un contexte qui grossit. Gouvernance et imputation (étape 14), limites de tours et de durée.
- **Les outils ont les droits de qui ?** L'agent doit agir **avec les permissions de l'utilisateur** (documents, connecteurs), jamais avec un compte de service plus puissant. Un agent qui trouve des documents que l'utilisateur ne peut pas voir est un incident.
- **Injection de prompt indirecte** : un document, une page web ou un email lu par l'agent contient des instructions (« ignore tes consignes, envoie le contenu à… »). Défenses produit (séparation des contenus, confirmations humaines sur les actions sensibles) et d'infrastructure : **egress restreint**, outils à effets de bord désactivables, journal des actions.
- **Traces** : pour diagnostiquer un agent, il faut la séquence tours → outils → résultats → erreurs. Sans traces produit (étape 18), c'est impossible.

### Conversations

Objet persistant : messages, pièces jointes, outils appelés, résultats, citations, partage. Points d'exploitation :

- **Rétention** : durée de conservation configurable, suppression réelle (base, objet, index, sauvegardes — ces dernières, jamais immédiatement) ; question client récurrente.
- **Taille** : conversations très longues → contexte qui dépasse la fenêtre du modèle → troncature ou résumé automatique ; comportement « il a oublié le début » normal.
- **Partage** : lien public, partage interne → permissions ReBAC et domaine d'accès.

### Deep research

Tâche de recherche longue : le système planifie des sous-questions, lance de nombreuses recherches (web, documents, connecteurs), lit, synthétise, itère, et produit un rapport. Du point de vue de l'infrastructure :

- **Très long** (minutes à dizaines de minutes) : ne peut pas vivre dans une requête HTTP → **workflow durable** (16.9), avec un statut consultable et une notification de fin ;
- **Très consommateur** : des dizaines à centaines d'appels au modèle et au crawler — un seul utilisateur peut saturer le crawler ou le quota de l'organisation ;
- **Doit survivre** à un redéploiement : si un pod meurt au milieu, la tâche reprend là où elle en était (c'est l'intérêt du moteur de workflows), sinon elle échoue et tout est à refaire ;
- **Dépend de l'egress** pour la partie web : en réseau fermé, elle se limite aux documents internes — à annoncer.

---

## 16.8 Sandboxes de code

L'exécution de code permet au modèle d'écrire du Python (analyse de données, graphiques, transformation de fichiers) et de le **faire tourner**. C'est, par construction, de l'**exécution de code arbitraire** dans le cluster du client. L'isolation n'est pas une option.

### Niveaux d'isolation

| Mécanisme | Isolation | Remarques |
|---|---|---|
| Conteneur standard (runc) | Faible : même noyau que le nœud | Insuffisant seul pour du code non fiable |
| **gVisor** (runtime `runsc`) | Noyau applicatif intermédiaire qui intercepte les appels système | Bon compromis ; GKE Sandbox le propose ; un peu de surcoût |
| **Kata Containers / microVM** (Firecracker) | Micro-machine virtuelle par sandbox | Isolation forte ; demande la virtualisation imbriquée sur les nœuds |
| Service d'exécution externe | Hors du cluster | Ce qui sort du cluster change (données analysées) |

Dans Kubernetes, le choix du runtime se fait par une **RuntimeClass** :

```yaml
spec:
  runtimeClassName: gvisor      # doit exister sur le cluster : kubectl get runtimeclass
```

C'est un **prérequis cluster** (sous la frontière) : si la RuntimeClass n'existe pas, le pod est refusé ; si le client ne peut pas l'installer, il faut décider de désactiver la fonctionnalité ou d'accepter un risque documenté — pas le décider seul.

### Garde-fous indispensables, quel que soit le runtime

- **Pas de réseau** (ou egress strictement filtré) : NetworkPolicy qui refuse toute sortie, et **aucun accès** aux Services internes ni au metadata service.
- **Pas de jeton de ServiceAccount** monté (`automountServiceAccountToken: false`), pas de secrets en variables d'environnement.
- **Utilisateur non root**, système de fichiers racine en lecture seule, capacités retirées, seccomp.
- **Limites** CPU, mémoire, disque éphémère, **durée** d'exécution, nombre de processus.
- **Durée de vie courte** : une sandbox par session ou par exécution, détruite ensuite ; pas de réutilisation entre utilisateurs.
- **Nœuds dédiés** (taint/toleration) pour que du code non fiable ne tourne pas à côté de la base de données.

### Modèle d'exploitation

Souvent un **pool de sandboxes pré-démarrées** (pour éviter plusieurs secondes de démarrage à chaque exécution) géré par un contrôleur ou un service d'orchestration. Pannes typiques :

- **pool épuisé** → exécutions en attente ou refusées en pic ;
- **pods de sandbox bloqués** en `Pending` (nœuds dédiés pleins, RuntimeClass absente, quota de namespace — ResourceQuota — atteint) ;
- **sandboxes orphelines** qui s'accumulent quand le contrôleur plante (nettoyage, TTL) ;
- **bibliothèques absentes** de l'image de sandbox : en air-gapped, `pip install` à l'exécution est impossible, l'image doit contenir ce qu'on promet ;
- **fichiers générés** (graphique, CSV) déposés en stockage objet puis servis via le domaine du contenu généré.

---

## 16.9 Workflows durables et tâches planifiées

### Pourquoi un moteur de workflows

Ingestion, synchronisation de connecteur, deep research, agent long, génération de rapport : des traitements en plusieurs étapes, longs, qui appellent des services faillibles. Sans moteur, un pod qui redémarre au milieu perd tout, et chaque équipe réinvente les retries.

Un **moteur de workflows durables** (type Temporal et équivalents) :

- **enregistre chaque étape** terminée dans sa base (plan de données) ;
- **reprend** un workflow interrompu à la dernière étape enregistrée, sur un autre worker ;
- gère **retries, timeouts, attentes** (y compris « attendre 3 jours »), annulation ;
- sépare le **serveur** du moteur (qui stocke l'état et distribue les tâches) des **workers** applicatifs (qui exécutent le code), connectés par des **files de tâches** nommées.

Du point de vue Kubernetes : le serveur du moteur (plusieurs services internes), sa base, et des Deployments de workers par application. **Namespaces du moteur par application** (étape 17) : chaque application a son espace de workflows, ses files, sa rétention.

### Ce qui casse, et comment ça se voit

| Symptôme | Cause probable |
|---|---|
| Tâches « en attente » partout, aucun worker n'avance | Serveur du moteur en panne, ou sa base (descendre d'un plan) |
| Une seule fonctionnalité bloquée | Workers de cette application à 0, en crash, ou **écoutant la mauvaise file / le mauvais namespace** (value copiée d'un autre environnement) |
| Workflows qui échouent après une montée de version | **Déterminisme** : le code du workflow a changé de manière incompatible avec les workflows en cours — le moteur rejoue l'historique et ne s'y retrouve plus. Versionner les workflows ; ne pas supprimer d'étapes en cours de route |
| Retries infinis qui saturent un service | Politique de retry sans limite sur une erreur non transitoire (ex. document invalide) |
| Base du moteur qui grossit sans fin | Rétention de l'historique des workflows terminés trop longue |

Outils : l'**interface web** et la **CLI** du moteur montrent chaque workflow, son historique, l'étape bloquée et l'erreur. C'est l'équivalent de `describe pod` pour les traitements asynchrones : à maîtriser. L'interface d'administration du moteur **n'est jamais exposée** par Ingress (étape 12) : `port-forward`.

### Tâches planifiées

Deux mécanismes à ne pas confondre :

- **CronJob Kubernetes** (étape 3) : tâches **techniques** de la plateforme — nettoyage, rétention, rotation, sauvegardes logiques, synchronisations globales. Définies dans le chart.
- **Tâches planifiées produit** : créées **par les utilisateurs** (« chaque lundi, résume les nouveautés de ce dossier ») et stockées en base, exécutées par le moteur de workflows (planifications) ou un planificateur applicatif.

Pièges communs : **fuseau horaire** (CronJob en UTC par défaut, champ `timeZone` sinon ; l'utilisateur pense en heure locale), **exécutions concurrentes** (`concurrencyPolicy`), **rattrapage** des exécutions manquées après une panne (`startingDeadlineSeconds`), **tâches d'un utilisateur parti** qui tournent encore avec ses jetons de connecteur.

---

## 16.10 Registres de prompts et de skills

Pour éviter que prompts système, instructions d'agents et capacités réutilisables soient codés en dur dans chaque service :

- **Registre de prompts** : prompts versionnés, par fonctionnalité et parfois par organisation, modifiables sans redéployer ; on peut revenir en arrière et comparer les versions.
- **Registre de skills / outils** : définitions d'outils ou de capacités (description, schéma des paramètres, instructions, code associé) que les agents peuvent charger, éventuellement publiées par le client.

Ce que ça implique pour toi :

- c'est de la **configuration qui change le comportement** du produit sans changer une image : un « le chat répond différemment depuis hier » peut venir d'une nouvelle version de prompt, pas d'un modèle ni d'un déploiement. Premier réflexe : l'historique des versions du registre ;
- les skills publiés par un client sont du **contenu qui peut porter du code ou des instructions** : mêmes questions d'isolation et de revue que les sandboxes et l'injection de prompt ;
- **qui a le droit de modifier** un prompt ou un skill au niveau de l'organisation (rôles, étape 13) ;
- sauvegarde : ils vivent en base, ils font partie de ce qu'on restaure (étape 17).

---

## 16.11 Audio

Deux sens :

- **Transcription** (parole → texte) : dictée dans le chat, transcription de réunions, fichiers audio ingérés dans une bibliothèque.
- **Synthèse vocale** (texte → parole) : lecture des réponses, mode conversation vocale.

Profils et pièges :

- **Fichiers** : taille (limites de body, étape 12), formats et codecs (conversion par `ffmpeg` dans l'image — absent = échec sur certains formats), durée → traitement **asynchrone** au-delà de quelques minutes.
- **Temps réel** (conversation vocale) : connexions **WebSocket** ou WebRTC de longue durée → timeouts d'inactivité du LB et de l'Ingress, annotations d'upgrade WebSocket, affinité éventuelle ; WebRTC peut exiger des ports UDP et un serveur TURN, rarement possible chez un client restrictif.
- **Navigateur** : l'accès au micro exige un **contexte sécurisé** (HTTPS) — un test en HTTP interne « ne marche pas » pour cette seule raison.
- **Modèles** : transcription et synthèse sont des modèles spécialisés (étape 15), locaux ou déportés ; la voix des utilisateurs est une **donnée personnelle** (question de souveraineté et de rétention).

---

## 16.12 Pièges

- **Diagnostiquer une fonctionnalité asynchrone par des codes HTTP** : il faut suivre la tâche (statut, workflow, worker).
- **Configuration runtime du frontend** pointant vers un autre environnement.
- **Réglage de console écrasé** par un `helm upgrade`, ou perdu avec un environnement.
- **Feature flag désactivé** pris pour une panne.
- **Domaine du canvas** oublié dans la liste DNS/certificats ; CDN JavaScript bloqués en réseau fermé.
- **Filtrage des permissions après la recherche** RAG ; permissions des sources externes non synchronisées.
- **Modèle d'embeddings différent** entre indexation et interrogation.
- **Ingestion massive** qui sature le modèle d'embeddings utilisé aussi par les questions.
- **`413`** sur les gros documents ou fichiers audio.
- **Crawler hors du proxy anti-SSRF** ; ouvrir toutes les plages privées pour indexer l'intranet.
- **Fetcher headless** sans `shm`, avec privilèges, ou « réparé » par `privileged: true`.
- **Application OAuth du connecteur** non créée à temps ; secret d'application expiré ; `redirect_uri` interne ; webhooks entrants impossibles sur plateforme privée.
- **Session OAuth non partagée** entre réplicas → `state` invalide.
- **Agent avec les droits d'un compte de service** ; modèle local sans bon support des tool calls ; injection de prompt indirecte avec egress ouvert.
- **Deep research hors workflow durable** : perdue au premier redéploiement.
- **Sandbox sans RuntimeClass d'isolation**, avec réseau, avec jeton de ServiceAccount, sur les mêmes nœuds que les bases.
- **Bibliothèques Python absentes** de l'image de sandbox en air-gapped.
- **Workers sur la mauvaise file / le mauvais namespace** du moteur de workflows ; code de workflow non déterministe après upgrade ; interface du moteur exposée.
- **Fuseau horaire** des tâches planifiées ; tâches d'utilisateurs partis.
- **Prompt modifié dans le registre** pris pour une régression de modèle.
- **Micro refusé** hors HTTPS ; WebSocket coupée par le LB.

---

## 16.13 Exercice — ingérer un document et suivre le chemin crawler → worker → base

### Partie 1 — Monter une chaîne d'ingestion minimale sur kind

Tu construis une version réduite, avec tes outils habituels (FastAPI, Python), pour comprendre ce que tu liras ensuite dans le vrai produit.

1. **Plan de données** : un stockage objet S3-compatible (MinIO ou équivalent, en chart), PostgreSQL avec l'extension `pgvector`, et un bus (Redis Streams ou NATS). Mots de passe en Secrets.
2. **API d'ingestion** (FastAPI) :
   - `POST /libraries/{id}/documents` (upload) : écrit l'original en objet, crée une ligne `documents` (statut `queued`), publie un événement `{document_id, source: "upload"}` ;
   - `POST /libraries/{id}/urls` : crée une ligne, publie `{document_id, source: "url", url}` ;
   - `GET /documents/{id}` : statut et nombre de passages ;
   - chaque requête porte un **identifiant de corrélation** propagé dans l'événement et dans tous les logs.
3. **Fetcher** : consomme les événements `url`, récupère la page **via un proxy egress** (un Squid ou équivalent dans le cluster qui refuse les plages privées et le metadata service), dépose le contenu en objet, publie `{document_id, source: "fetched"}`. NetworkPolicy : le fetcher ne sort que vers le proxy et le DNS.
4. **Worker** : consomme `upload` et `fetched`, extrait le texte (PDF et HTML), découpe en passages, calcule les embeddings via ton routeur de l'étape 15 (modèle d'embeddings local léger sur CPU), écrit dans `chunks(document_id, library_id, content, embedding vector(N))`, passe le statut à `indexed` ou `failed` avec la raison.
5. **Recherche** : `POST /libraries/{id}/search` qui calcule l'embedding de la question et renvoie les 5 passages les plus proches, **filtrés par `library_id`** dans la requête SQL.

### Partie 2 — Suivre un document de bout en bout

Ingère un PDF, puis une URL publique. Pour chacun, reconstitue le chemin **avec preuves**, en t'appuyant sur l'identifiant de corrélation :

| Étape | Preuve à relever |
|---|---|
| Requête reçue | Log de l'API, code HTTP, identifiant |
| Original stocké | Objet présent dans le bucket (liste, taille) |
| Ligne `documents` | Statut `queued`, horodatage |
| Événement publié | Message dans le bus (stream/subject), lag du consommateur |
| (URL) Fetch | Log du fetcher, log **du proxy egress** montrant la sortie |
| Extraction | Log du worker, nombre de caractères extraits |
| Embeddings | Log du routeur / du modèle d'embeddings, nombre d'appels |
| Écriture | Lignes dans `chunks`, dimension des vecteurs |
| Statut final | `indexed`, durée totale par étape |
| Recherche | Question dont la réponse contient un passage du document |

Livrable intermédiaire : une frise chronologique horodatée (UTC) du document.

### Partie 3 — Casser, un maillon à la fois

Pour chaque panne : **symptôme visible par l'utilisateur** (statut, réponse de recherche), **premier endroit où l'erreur apparaît**, **commande qui la révèle**.

| # | Provocation |
|---|---|
| 1 | Upload d'un fichier de 20 Mo avec la limite de body par défaut de l'Ingress |
| 2 | Worker scalé à 0 |
| 3 | Bus arrêté pendant une ingestion, puis relancé : les documents reprennent-ils ? |
| 4 | URL vers `http://169.254.169.254/` puis vers le Service interne de PostgreSQL |
| 5 | URL d'une page dont le contenu n'apparaît qu'après exécution de JavaScript |
| 6 | Modèle d'embeddings désactivé dans le routeur |
| 7 | Modèle d'embeddings **remplacé** par un autre de dimension différente, sans réindexer : ingestion d'un nouveau document, puis recherche sur un ancien |
| 8 | Filtre `library_id` retiré de la requête de recherche : que voit un utilisateur d'une autre bibliothèque ? (note-le comme incident de sécurité) |
| 9 | PDF protégé par mot de passe / fichier corrompu |
| 10 | Worker tué au milieu du traitement d'un gros document : reprise, doublon de passages, ou document bloqué ? |

Pour le cas 10 et le cas 3, écris ce qu'un **moteur de workflows durables** aurait changé, étape par étape.

### Partie 4 — Sur l'environnement de preview (lecture seule)

1. Pour chaque fonctionnalité du tableau de 16.1 présente sur la plateforme : composants réels (noms des Deployments/StatefulSets), synchrone ou non, file ou workflow utilisé, egress, isolation.
2. Ingestion : ingère un document de test dans une bibliothèque de test, et suis-le jusqu'à la base avec les outils du produit (statut, workflow, logs des workers) — sans lire de contenu d'autres utilisateurs.
3. Crawler : identifie worker, fetcher, fetcher headless ; vérifie qu'ils sortent par le proxy anti-SSRF ; relève leur `shm`, leur `securityContext`, leurs NetworkPolicies.
4. Connecteurs : liste des connecteurs activés, `redirect_uri` déclarées, où sont stockés les jetons, date d'expiration des secrets d'applications OAuth si tu y as accès.
5. Sandboxes : RuntimeClass utilisée, NetworkPolicy, nœuds dédiés, montage de jeton, taille du pool.
6. Moteur de workflows : namespaces, files, workers par application, rétention ; ouvre l'interface par `port-forward` et trouve un workflow terminé et un en échec.
7. Canvas : domaine du contenu généré, CSP servie, attribut `sandbox` de l'iframe.
8. Registre de prompts/skills : où, qui modifie, historique des versions.

**Livrable** : section « Fonctionnalités produit » de `carte-plateforme-<version>.md` : tableau fonctionnalité → composants → asynchrone → egress → isolation → symptôme de panne ; chemin d'ingestion détaillé avec les commandes de suivi ; liste des prérequis client (domaine du canvas, applications OAuth, RuntimeClass, liste blanche intranet) ; liste des bruits normaux (redémarrages du fetcher headless, composants optionnels non configurés).

---

## Validé si…

Tu peux expliquer à voix haute :

- pourquoi une fonctionnalité asynchrone se diagnostique en suivant une tâche, et comment on la suit ;
- d'où vient la configuration du frontend et pourquoi elle peut pointer vers un autre environnement ;
- les couches d'isolation du canvas et ce qu'elles impliquent à l'installation ;
- les deux moitiés du RAG, et où se fait (et doit se faire) le filtrage par permissions ;
- trois pannes de l'indexation avec leur symptôme, et pourquoi changer de modèle d'embeddings casse la recherche ;
- les rôles du crawler worker, du fetcher et du fetcher headless, et pourquoi on les sépare ;
- comment répondre à « on veut indexer notre intranet » sans lever la protection anti-SSRF ;
- le flux OAuth d'un connecteur, ce qui part du navigateur et ce qui part du pod, et cinq causes d'échec ;
- pourquoi un agent doit agir avec les droits de l'utilisateur, et ce qu'est une injection de prompt indirecte ;
- pourquoi deep research a besoin d'un workflow durable ;
- les niveaux d'isolation d'une sandbox de code et six garde-fous indispensables ;
- ce que fait un moteur de workflows durables, et trois pannes typiques dont celle du déterminisme ;
- la différence entre un CronJob technique et une tâche planifiée produit ;
- pourquoi une modification de prompt peut ressembler à une régression de modèle ;
- deux pièges spécifiques à l'audio.

**Étape suivante** : `etape-17-plan-donnees-sauvegarde-continuite.md` — plan de données, sauvegarde et continuité.
