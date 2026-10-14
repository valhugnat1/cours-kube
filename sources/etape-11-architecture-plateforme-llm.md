# Étape 11 — Architecture d'une plateforme LLM

**Objectif** : à la fin de cette étape, tu sais dessiner de mémoire la plateforme que tu déploies, ranger chacun de ses dizaines de pods dans un plan, et dire pour chaque composant « s'il tombe, voilà ce que voit l'utilisateur ». C'est la carte sur laquelle s'appuient toutes les étapes suivantes de la partie C, le debug (étape 20) et la restitution client (étape 23).

**Notions couvertes** : §1 (modèle vs plateforme, plans, familles de composants, frontière de responsabilité).

**Prérequis** : parties A et B. Tu dois savoir lire un `helm get manifest` et naviguer dans un cluster.

---

## 11.1 Modèle vs plateforme

Un **modèle**, ce sont des poids (quelques Go à quelques centaines de Go) et un moteur d'inférence qui les charge sur des GPU et expose une API : « voici des tokens en entrée, voici des tokens en sortie ». C'est un seul type de workload, gourmand, sans état métier.

Une **plateforme**, c'est tout ce qu'il faut autour pour qu'une organisation l'utilise réellement :

- des humains qui se connectent avec le SSO de leur entreprise ;
- des applications qui appellent une API avec des clés, des quotas, une facturation par équipe ;
- une interface de chat, des conversations sauvegardées, des documents ingérés (RAG), des agents, des connecteurs ;
- des bases de données, des files de messages, du stockage objet, des sauvegardes ;
- de l'observabilité, une console d'administration.

Ordre de grandeur à retenir : **le modèle, c'est une poignée de pods ; la plateforme, c'est les dizaines d'autres.** Et en pratique, la grande majorité des incidents chez un client ne viennent pas du modèle, mais de la plateforme (identité, réseau, base, configuration).

Conséquence directe pour ton rôle : quand un client dit « le modèle ne répond pas », la probabilité que le problème soit dans le moteur d'inférence est faible. Tu dois savoir *où* est le problème avant de savoir *quoi*.

**Inférence déportée vs locale.** La plateforme peut appeler un modèle qui tourne ailleurs (API hébergée) ou un modèle qui tourne dans le cluster sur des GPU du client. Le reste de l'architecture est identique ; seul le dernier maillon change. On détaille à l'étape 15, mais garde en tête dès maintenant la question qu'un client posera toujours : **« qu'est-ce qui tourne réellement chez moi, et qu'est-ce qui sort ? »**

---

## 11.2 Les quatre plans

Pour ne pas se noyer dans 50 pods, on les range en quatre **plans** empilés. Une requête les traverse de haut en bas.

```
┌─────────────────────────────────────────────────────────────┐
│ 1. PLAN D'ENTRÉE (edge)                                     │
│    DNS → load balancer → ingress/gateway → TLS → routage    │
├─────────────────────────────────────────────────────────────┤
│ 2. PLAN D'IDENTITÉ                                          │
│    IdP (OIDC/SAML), sessions, clés API, permissions fines   │
├─────────────────────────────────────────────────────────────┤
│ 3. PLAN APPLICATIF                                          │
│    UI, API publique, quotas, routeur de modèles, inférence, │
│    RAG, agents, connecteurs, workers, sandboxes             │
├─────────────────────────────────────────────────────────────┤
│ 4. PLAN DE DONNÉES                                          │
│    Bases relationnelles, cache KV, bus de messages, moteur  │
│    de workflows, base analytique, stockage objet            │
└─────────────────────────────────────────────────────────────┘
        (en dessous, hors chart : cluster, nœuds, réseau,
         StorageClass, GPU, LB — la responsabilité du client)
```

Pour chaque plan, retiens sa question, son symptôme typique quand il casse, et l'étape du cours qui l'approfondit.

| Plan | Question qu'il répond | Symptôme typique | Étape |
|---|---|---|---|
| Entrée | « La requête arrive-t-elle au bon pod ? » | Timeout, erreur certificat, 404/502/503/504 de l'ingress | 12 |
| Identité | « Qui es-tu, et as-tu le droit ? » | Boucle de login, 401, 403 | 13 |
| Applicatif | « Que dois-je faire de cette requête ? » | 429, 500 applicatif, réponse vide, fonctionnalité absente | 14, 15, 16 |
| Données | « Où est l'état ? » | 500 en rafale, lenteur générale, « too many connections », pods en `Init` | 17 |

À côté des quatre plans, un **plan transverse** : l'observabilité (étape 18), qui regarde les quatre.

### La règle « descendre d'un plan »

C'est la règle la plus utile de toute la partie C :

> **Un symptôme se manifeste dans un plan, mais sa cause est souvent dans le plan du dessous.**

Exemples :

- Une erreur de login (plan identité) … parce que la base de l'IdP est saturée (plan données).
- Une 500 sur l'API de chat (plan applicatif) … parce que le pooler de connexions refuse les connexions (plan données).
- Une 502 de l'ingress (plan entrée) … parce que le pod applicatif est en `CrashLoopBackOff` (plan applicatif), lui-même parce que sa migration de schéma échoue (plan données).
- Tous les plans en erreur en même temps … parce que la couche sous le chart (nœud, DNS du cluster, stockage) est tombée.

Méthode : tu identifies le plan où le symptôme apparaît, tu vérifies que ce plan est sain *en lui-même* (pods Ready, logs sans erreur propre), et s'il l'est, tu **descends**. Tu ne remontes presque jamais : un plan de données en panne ne se répare pas en redémarrant l'UI.

Corollaire : la santé d'un pod d'un plan haut ne prouve rien sur le plan bas. Un pod d'API `Running 1/1` peut très bien renvoyer 500 à toutes les requêtes parce que sa readiness ne teste pas la base (et c'est voulu, cf. partie A, idée 5).

---

## 11.3 Les familles de composants

Chaque plan se décompose en familles. Les noms exacts changent d'une plateforme à l'autre ; les **rôles** sont stables. Apprends les rôles, puis associe-leur les noms de *ta* plateforme à l'exercice.

### Plan d'entrée

| Famille | Rôle | Ce qui casse si ça tombe |
|---|---|---|
| DNS externe (souvent `external-dns`) | Crée les enregistrements pour les hosts de l'ingress | Nouveaux hosts injoignables ; enregistrements orphelins à la suppression |
| Load balancer | Porte d'entrée réseau du cluster | Tout est injoignable |
| Ingress controller / gateway | Routage host + path vers les Services | 404/502/503 selon le cas |
| Émetteur de certificats (cert-manager) | Obtient et renouvelle les certificats | Rien immédiatement ; tout casse à l'expiration |
| Proxy egress | Contrôle ce qui sort (liste blanche, anti-SSRF) | Connecteurs, crawler, inférence déportée en échec |

### Plan d'identité

| Famille | Rôle | Ce qui casse si ça tombe |
|---|---|---|
| Fournisseur d'identité (IdP, type Keycloak) | Login OIDC, broker vers l'IdP du client | Plus aucun login humain ; les sessions existantes survivent un temps |
| Gestion des clés API | Émission, rotation, rattachement à une organisation | Plus d'accès machine |
| Moteur d'autorisation fine (ReBAC) | « Cet utilisateur peut-il lire cette bibliothèque ? » | 403 inattendus, ou pire, trop de droits si fail-open |

### Plan applicatif

| Famille | Rôle | Ce qui casse si ça tombe |
|---|---|---|
| Frontend(s) | UI de chat, console admin | Page blanche, mais l'API continue de répondre |
| API publique / backend | Point d'entrée des requêtes applicatives | Tout le produit |
| Quotas / rate limiting | Compte l'usage avant l'inférence | 429 partout, ou quotas non appliqués |
| Routeur de modèles | Envoie chaque requête au bon moteur, local ou déporté | Aucune complétion |
| Moteurs d'inférence | Chargent les poids, génèrent les tokens (GPU) | Un modèle indisponible ; démarrage lent |
| RAG : ingestion, crawler, workers, embeddings | Transforment des documents en vecteurs interrogeables | Documents « en cours » indéfiniment ; réponses sans sources |
| Agents, connecteurs, sandboxes de code | Outils appelés par le modèle | Fonctionnalité précise en erreur |
| Workers asynchrones / tâches planifiées | Tout ce qui ne tient pas dans une requête HTTP | Actions différées qui n'aboutissent jamais |
| Jobs de migration (hooks Helm, init containers) | Mettent les schémas à jour | Pods bloqués en `Init` à l'upgrade |

### Plan de données

| Famille | Rôle | Ce qui casse si ça tombe |
|---|---|---|
| Base(s) relationnelle(s) (souvent via opérateur) | État métier : utilisateurs, conversations, config | 500 massifs, logins en échec |
| Pooler de connexions | Mutualise les connexions à la base | « too many connections » alors que la base va bien |
| Cache clé-valeur | Sessions, compteurs de quota, cache | Déconnexions, quotas faux, lenteur |
| Bus de messages | Découple producteurs et workers | Tâches asynchrones figées |
| Moteur de workflows durables | Orchestration longue (agents, ingestion) | Workflows bloqués |
| Base analytique colonnaire | Consommation, évaluations, traces produit | Tableaux de bord vides, le produit marche |
| Stockage objet (S3-compatible) | Fichiers, documents, sauvegardes | Uploads en échec, sauvegardes silencieusement cassées |
| Base vectorielle (parfois intégrée à une autre brique) | Recherche sémantique du RAG | RAG sans résultat |

Deux choses à observer dans ces tableaux :

1. **Les pannes n'ont pas toutes le même bruit.** Une base qui tombe fait hurler tout le monde ; un bus de messages qui tombe fait juste que « l'ingestion est lente ». Les pannes silencieuses sont les plus dangereuses : note-les.
2. **Chaque brique du plan de données peut être embarquée dans le chart OU fournie par le client** (base managée, S3 existant, Redis de l'entreprise). Pour une installation donnée, tu dois savoir laquelle des deux — ça change qui la sauvegarde, qui la met à jour, et qui tu appelles quand elle tombe (étape 17).

---

## 11.4 La frontière de responsabilité

Rappel de l'étape 10, à graver ici parce qu'il structure tout le discours client :

> **Le chart déploie des workloads. Il ne fabrique pas le cluster, les nœuds, le réseau, le load balancer, la StorageClass, les drivers GPU, ni l'IdP du client.**

Tout ce qui est *sous* la ligne du schéma 11.2 est un **prérequis**. Si un prérequis manque, le chart ne le compense pas : il échoue, souvent avec un message qui pointe ailleurs (PVC `Pending`, LB `<pending>`, pod GPU `Pending` avec `Insufficient nvidia.com/gpu`).

Entre les deux, une zone grise à clarifier pour chaque client : les opérateurs cluster-wide (cert-manager, External Secrets, opérateur de base, GPU Operator). Sont-ils déjà là ? Qui les installe ? Qui les met à jour ? (étape 9)

Formule pour un client : « la plateforme, c'est nous ; le socle sur lequel elle tourne, c'est vous ; et voici la liste exacte de ce qu'on attend du socle ».

---

## 11.5 Suivre une requête à travers les plans

Pour que la carte soit vivante, trace mentalement deux requêtes typiques.

**Un utilisateur pose une question dans le chat, avec un document de sa bibliothèque :**

```
Navigateur
 → DNS → LB → ingress (TLS terminé)                          [entrée]
 → frontend (déjà chargé) → API backend
 → validation de session / cookie ; si expirée → IdP (OIDC) [identité]
 → vérification de permission sur la bibliothèque (ReBAC)    [identité]
 → quota : lecture/incrément du compteur                      [applicatif → cache KV]
 → recherche RAG : embeddings de la question → base vectorielle [applicatif → données]
 → routeur de modèles → moteur d'inférence (GPU ou déporté via egress)
 → streaming de la réponse vers le navigateur
 → sauvegarde de la conversation                              [données : base]
 → événement de consommation                                  [données : bus → base analytique]
```

**Une application appelle l'API avec une clé :**

```
Client HTTP → DNS → LB → ingress                              [entrée]
 → API publique → validation de la clé → organisation         [identité]
 → quota / rate limit                                          [applicatif → cache KV]
 → routeur de modèles → inférence                              [applicatif]
 → comptabilisation de l'usage                                 [données]
```

Remarque clé : le chemin machine **ne passe pas par l'IdP**. Si les humains ne peuvent plus se connecter mais que l'API répond, tu viens de localiser le problème dans le plan d'identité, côté OIDC, en une observation.

Et une vérification à ne jamais oublier (étape 14) : **toutes les routes passent-elles vraiment par le quota ?** Ne le suppose pas, vérifie la table de routage réelle.

---

## 11.6 Passer du chart à la carte

Sur une installation réelle, la carte ne se devine pas : elle se lit. Quatre sources, de la plus déclarative à la plus concrète.

```bash
# 1. Les sous-charts du parapluie : les grandes briques
helm show chart oci://registry/charts/platform --version X    # section dependencies
helm get values platform -n platform -a | yq 'keys'           # clés de premier niveau = sous-charts

# 2. Ce qui est activé sur CETTE installation
helm get values platform -n platform -a | yq '.. | select(has("enabled")) | path | join(".")' 2>/dev/null
# (plus simplement : grep -B2 'enabled:' sur la sortie)

# 3. Les workloads réels, regroupés
kubectl get deploy,sts,ds,cronjob -n platform -o custom-columns=KIND:.kind,NAME:.metadata.name,COMPONENT:.metadata.labels.app\\.kubernetes\\.io/component
kubectl get pods -n platform -L app.kubernetes.io/name,app.kubernetes.io/component

# 4. Qui parle à qui : les dépendances déclarées dans la config
kubectl get deploy -n platform -o yaml | yq '.items[] | .metadata.name + " → " + (.spec.template.spec.containers[].env[]? | select(.name | test("HOST|URL|DSN|ENDPOINT")) | .name)'
kubectl get svc -n platform
kubectl get ingress -A        # le plan d'entrée : hosts et backends
kubectl get crd | grep -iE 'postgres|redis|kafka|nats|cert|secret'   # opérateurs du plan de données
```

Les labels `app.kubernetes.io/name` et `app.kubernetes.io/component` sont ta meilleure amie — s'ils sont bien posés par le chart, ils te donnent déjà la moitié de la carte. S'ils ne le sont pas, c'est un retour à faire.

Les variables d'environnement de type `*_HOST`, `*_URL`, `DATABASE_*`, `REDIS_*` sont les **arêtes** du graphe : elles disent qui dépend de qui. Attention à ne pas afficher de valeur de secret en faisant ça (filtre sur les noms, pas les valeurs).

---

## 11.7 Pièges

- **Confondre « le modèle » et « la plateforme »** dans un échange client : « le modèle est lent » peut vouloir dire UI, quota, RAG, egress… Reformule toujours avec le plan.
- **Supposer qu'une brique est embarquée** alors qu'elle est fournie par le client (ou l'inverse) : tu cherches la base dans le namespace, elle est chez le DBA du client.
- **Composants désactivés comptés comme présents** : le chart contient un sous-chart, `enabled: false` sur cette installation. La carte, c'est ce qui tourne, pas ce que le chart sait faire.
- **Composants optionnels légitimement en erreur** (connecteur non configuré, fonctionnalité non licenciée) pris pour la cause d'un incident. Les noter sur la carte comme « rouge normal » (étapes 21, 22).
- **Remonter au lieu de descendre** : redémarrer l'API parce qu'elle renvoie des 500, alors que la base est pleine.
- **Dessiner la carte d'une version et l'appliquer à une autre** : les composants apparaissent, fusionnent, disparaissent entre versions du chart. Date et versionne ta carte.
- **Oublier les Jobs et CronJobs** : ils ne sont pas visibles en régime établi mais bloquent les upgrades (migrations) ou font le ménage (rétention, sauvegardes).

---

## 11.8 Exercice — à faire clavier en main

**Partie 1 — De mémoire (30 min, sans rien ouvrir).**

1. Sur une feuille, dessine les quatre plans + la couche socle en dessous.
2. Place dans chaque plan tous les composants de *ta* plateforme dont tu te souviens, avec leur nom réel.
3. Pour chacun, écris en une ligne : son rôle, et le symptôme utilisateur s'il tombe.
4. Trace les deux requêtes de 11.5 sur ta carte avec des flèches.
5. Marque d'un `?` tout ce dont tu n'es pas sûr (embarqué ou externe ? activé ou non ?).

**Partie 2 — Confrontation au réel (sur un environnement de preview ou de démo, jamais un client en prod).**

1. Ouvre k9s sur le namespace de la plateforme, vue `:deploy`, puis `:sts`, `:ds`, `:cronjob`, `:job`.
2. Pour chaque workload, vérifie qu'il est sur ta carte. Ajoute en **rouge** ce que tu avais oublié.
3. Récupère les values effectives (`helm get values -a`) et vérifie tes `?` : activé / désactivé, embarqué / externe.
4. Avec la commande de 11.6 sur les variables d'environnement, trace les arêtes réelles pour au moins trois composants (dont un du plan d'identité et un du plan de données). Corrige tes flèches.
5. `kubectl get ingress -A` : liste les hosts exposés et relie chacun à son composant.

**Partie 3 — Le test de la panne (sur papier).**

Pour chacune de ces pannes, dis quel plan affiche le symptôme, quel plan contient la cause, et ce que voit l'utilisateur :

- le cache KV est coupé ;
- l'IdP est en `CrashLoopBackOff` ;
- le proxy egress refuse tout ;
- le bus de messages est plein ;
- le certificat du host principal a expiré.

**Livrable** : un fichier `carte-plateforme-<version>.md` versionné (plans, composants, rôle, symptôme de panne, embarqué/externe, arêtes principales). Tu le réutiliseras aux étapes 17, 20 et 23.

---

## Validé si…

Tu peux expliquer à voix haute, sans support :

- la différence entre un modèle et une plateforme, et pourquoi la plupart des incidents ne sont pas dans le modèle ;
- les quatre plans, leur question, et un symptôme typique pour chacun ;
- la règle « descendre d'un plan », avec un exemple vécu ou réaliste ;
- pourquoi le chemin machine ne dépend pas de l'IdP, et ce que ça permet de conclure en diagnostic ;
- ce qui est sous la frontière de responsabilité, et ce que le chart attend du client ;
- au moins trois composants dont la panne est **silencieuse**.

Et ta carte de la partie 2 a moins de 20 % de rouge. Sinon, refais la partie 1 dans une semaine.

**Étape suivante** : `etape-12-plan-entree.md` — plan d'entrée.
