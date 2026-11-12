# Étape 25 — Déployer ClickHouse chez un client

**Objectif** : à la fin de cette étape, tu sais installer et exploiter un ClickHouse répliqué dans le cluster Kubernetes d'un client avec un opérateur : ce que tu demandes au client avant, ce que tu écris, ce que l'opérateur fabrique, comment tu mets à jour, sauvegardes et diagnostiques.

**Prérequis** : étapes 3 (StatefulSet), 5 (stockage), 6 (secrets), 9 (CRDs et opérateurs). L'étape 17.8 situe la base analytique dans le plan de données de la plateforme.

Pourquoi ça compte pour toi : dans la plateforme, la base analytique porte la consommation, les traces et les évaluations (étape 17.8). Si elle tombe, le produit continue de répondre, mais les tableaux de bord et la facturation se figent : c'est une **panne silencieuse**. Et c'est une base à état, donc tout ce qui varie d'un client à l'autre (StorageClass, registry, droits sur les CRDs, exposition) la touche directement.

Sources de cette étape : documentation de l'opérateur Altinity (`github.com/Altinity/clickhouse-operator`, dossier `docs/`), dépôt de l'opérateur officiel (`github.com/ClickHouse/clickhouse-operator`), documentation ClickHouse. Versions à l'écriture (novembre 2026) : opérateur Altinity 0.27, opérateur officiel en `v1alpha1`. Ce qui dépend d'une version est marqué « à vérifier ».

---

## 25.1 ClickHouse en trois phrases, et la carte

ClickHouse est une base **colonnaire** : elle range les données par colonne, ce qui rend les agrégations massives très rapides (« tokens par organisation par jour sur 90 jours ») et les modifications ligne à ligne coûteuses. On y écrit **par lots**, on y lit par agrégats.

Sur Kubernetes, un ClickHouse de production a quatre morceaux :

| Morceau | Rôle |
|---|---|
| **Les pods ClickHouse** | Stockent et interrogent les données. Un pod = un « hôte » ClickHouse, avec son disque. |
| **ClickHouse Keeper** | Petit service de coordination (remplace ZooKeeper). Tient le journal de ce que chaque réplica doit avoir. |
| **L'opérateur** | Un Deployment qui lit une ressource (`ClickHouseInstallation`) et fabrique les StatefulSets, Services, ConfigMaps. |
| **Les PVC** | Les disques. La seule chose irremplaçable. |

Trois étages se superposent, et chacun a sa propre notion de « ça marche » :

1. **Kubernetes** : le pod est `Running` et `Ready`.
2. **L'opérateur** : la ressource est en statut `Completed`.
3. **ClickHouse** : les réplicas sont synchronisés, les tables ne sont pas en lecture seule, les fusions suivent.

Un pod `Running` ne dit rien de l'étage 3. C'est le fil rouge de l'étape : **trois étages, trois vérifications**.

---

## 25.2 Parts, merges, et pourquoi on insère par lots

Le moteur de table standard est **MergeTree**. Chaque `INSERT` crée une **part** : un répertoire immuable sur disque, trié selon la clé `ORDER BY` de la table. En arrière-plan, ClickHouse **fusionne** (merge) les petites parts en plus grosses.

Conséquences d'exploitation :

- **Un insert = une part.** Mille inserts d'une ligne créent mille parts. Les fusions ne suivent plus, les requêtes ralentissent, puis ClickHouse **refuse** les inserts avec `Too many parts`. Le seuil (`parts_to_throw_insert`) vaut 3000 parts actives **par partition** par défaut. Monter le seuil ne fait que retarder l'erreur.
- **Le bon rythme** : des lots de milliers de lignes, quelques inserts par seconde au plus par table. Dans la plateforme, ce sont les consommateurs du bus qui accumulent puis écrivent (étape 17.8). Si l'application ne peut pas grouper, ClickHouse sait le faire côté serveur (`async_insert`).
- **Partitions** : `PARTITION BY toYYYYMM(ts)` découpe la table par mois. Utile pour supprimer un mois d'un coup. Trop de partitions (par jour et par client) multiplie les parts : même erreur.
- **TTL** : `TTL ts + INTERVAL 30 DAY` supprime les vieilles données lors des fusions. Sans TTL, le disque se remplit lentement jusqu'au jour où il est plein (étape 17.8).
- **Modifier ou supprimer une ligne** (`ALTER TABLE … DELETE`) est une **mutation** : réécriture de parts entières, asynchrone, lourde. À réserver (RGPD, corrections).

Compter les parts d'une table : `SELECT count() FROM system.parts WHERE active AND table = 'events'`.

---

## 25.3 Shards, réplicas et Keeper

Deux axes, à ne pas confondre :

| Axe | Ce que c'est | Ce que ça apporte | Ce que ça coûte |
|---|---|---|---|
| **Réplica** | Une copie complète des mêmes données sur un autre pod | Haute disponibilité, lectures réparties | Un disque de plus par copie |
| **Shard** | Un morceau des données ; chaque shard a des données différentes | Capacité et parallélisme au-delà d'une machine | Complexité : tables `Distributed`, rééquilibrage manuel |

La topologie de départ raisonnable chez un client : **1 shard, 2 ou 3 réplicas**. On n'ajoute des shards que quand un seul nœud ne suffit plus, parce que redécouper des données existantes n'est pas automatique.

**La réplication se fait table par table**, avec le moteur `ReplicatedMergeTree`. Une table `MergeTree` simple n'est **pas** répliquée, même dans un cluster à trois réplicas : elle existe sur le pod où on l'a créée, c'est tout.

**Keeper** est le journal partagé de la réplication : chaque réplica y lit quelles parts il doit avoir et va les chercher chez l'autre (port inter-serveurs 9009). Les requêtes `ON CLUSTER` (créer une table sur tous les hôtes) passent aussi par lui.

- Keeper fonctionne à la **majorité** : 3 instances tolèrent la perte d'une, 5 la perte de deux. Toujours un nombre impair, sur des nœuds différents.
- **Keeper perdu** (plus de majorité) : les tables répliquées passent en **lecture seule**. Les `SELECT` marchent, les `INSERT` échouent avec `Table is in readonly mode`. Les données ne sont pas perdues ; l'écriture reprend au retour de Keeper.
- Keeper est sensible à la **latence disque** : chaque écriture est synchronisée sur disque. Un disque lent ou partagé se traduit par des sessions expirées côté ClickHouse.
- Une table `Distributed` ne stocke rien : c'est un guichet qui envoie la requête à tous les shards et rassemble. Avec un seul shard, on peut s'en passer.

Vérifier la réplication : `SELECT database, table, is_readonly, absolute_delay, queue_size FROM system.replicas`.

---

## 25.4 L'opérateur : ce qu'il lit, ce qu'il fabrique

On ne déploie pas ClickHouse avec un StatefulSet écrit à la main : la configuration de cluster (qui est réplica de qui, où est Keeper, macros par hôte) doit être générée et tenue à jour. C'est le travail d'un opérateur (étape 9).

Deux opérateurs existent :

| | **Altinity** (`Altinity/clickhouse-operator`) | **Officiel** (`ClickHouse/clickhouse-operator`) |
|---|---|---|
| Ressources | `ClickHouseInstallation` (`chi`), `ClickHouseKeeperInstallation` (`chk`) | `ClickHouseCluster`, `KeeperCluster` |
| API | `clickhouse.altinity.com/v1` | `clickhouse.com/v1alpha1` |
| Maturité | Des années de production, très répandu | Récent, API encore alpha |
| Prérequis | Aucun autre opérateur | cert-manager (certificats des webhooks), Kubernetes 1.28+ |

Le reste de l'étape utilise **l'opérateur Altinity**, celui que cite l'étape 9. Les idées se transposent à l'autre ; les noms de champs non.

Pour un `ClickHouseInstallation` nommé `prod`, avec un cluster `main`, 1 shard et 2 réplicas, l'opérateur fabrique :

| Objet | Nom | Remarque |
|---|---|---|
| StatefulSet | `chi-prod-main-0-0`, `chi-prod-main-0-1` | **Un StatefulSet par hôte**, d'un seul pod chacun |
| Pod | `chi-prod-main-0-0-0`, `chi-prod-main-0-1-0` | `chi-<chi>-<cluster>-<shard>-<réplica>-0` |
| Service par hôte | `chi-prod-main-0-0`, `chi-prod-main-0-1` | Headless, ports 8123, 9000, 9009 |
| Service d'entrée | `clickhouse-prod` | **Type LoadBalancer par défaut**, ports 8123 et 9000 |
| ConfigMaps | `chi-prod-common-configd`, `chi-prod-common-usersd`, un par hôte | La configuration générée |
| PVC | un par hôte et par volume | Selon `volumeClaimTemplates` |

Pourquoi un StatefulSet par hôte : pour pouvoir redémarrer, reconfigurer ou mettre à jour **un hôte à la fois**, dans l'ordre que l'opérateur choisit.

Règle héritée de l'étape 2 : **on agit sur le propriétaire**. Un `kubectl edit statefulset` ou `kubectl scale` sur ces objets sera défait à la prochaine réconciliation, ou pire, laissera un état que l'opérateur ne comprend plus. Tout changement passe par le `chi`.

Lire l'état : `kubectl get chi -n <ns>` (colonne `STATUS` : `InProgress`, `Completed`, `Aborted`), `kubectl describe chi`, et les logs du Deployment `clickhouse-operator`.

---

## 25.5 Lire et écrire un ClickHouseInstallation

```yaml
apiVersion: clickhouse.altinity.com/v1
kind: ClickHouseInstallation
metadata:
  name: prod
spec:
  configuration:
    zookeeper:
      nodes:
        - host: keeper-prod        # Service du Keeper
          port: 2181
    clusters:
      - name: main
        layout:
          shardsCount: 1
          replicasCount: 2
  defaults:
    templates:
      podTemplate: ch
      dataVolumeClaimTemplate: data
  templates:
    podTemplates:
      - name: ch
        spec:
          containers:
            - name: clickhouse
              image: registry.client.example/clickhouse/clickhouse-server:25.8
    volumeClaimTemplates:
      - name: data
        reclaimPolicy: Retain
        spec:
          storageClassName: fast
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: 200Gi
```

Quatre blocs à repérer :

- **`configuration.clusters[].layout`** : la topologie. `shardsCount` × `replicasCount` = nombre de pods.
- **`configuration.zookeeper`** : où est Keeper. Soit une liste `nodes` (hôte et port), soit, depuis l'opérateur 0.27, une référence directe à un `chk` : `zookeeper.keeper.name: prod`. Sans ce bloc, pas de réplication possible.
- **`templates.podTemplates`** : un `spec` de pod ordinaire. C'est là que vont l'**image**, les `resources`, l'affinité, les tolerations, le `securityContext`.
- **`templates.volumeClaimTemplates`** : le disque de chaque hôte, plus un champ propre à l'opérateur, `reclaimPolicy`.

`defaults.templates` dit quels templates s'appliquent partout. **Un template défini mais pas référencé n'est pas utilisé** : c'est l'erreur la plus fréquente, et elle est silencieuse (le pod démarre avec l'image par défaut de l'opérateur et sans disque persistant).

Le Keeper se déclare de la même façon, avec `kind: ClickHouseKeeperInstallation`, `apiVersion: clickhouse-keeper.altinity.com/v1`, et `replicasCount: 3`.

Dans un chart parapluie, le `chi` est un template comme un autre ; les valeurs à exposer par client sont : image et registry, `storageClassName`, taille, `replicasCount`, ressources, type de Service.

---

## 25.6 Stockage, mémoire, placement

**Stockage** (étape 5, appliquée) :

- **StorageClass du client**, jamais supposée. Disque bloc `ReadWriteOnce`, rapide (SSD). Pas de NFS pour les données ClickHouse ni pour Keeper.
- **`reclaimPolicy: Retain`** dans le `volumeClaimTemplate` : sans lui, **supprimer le `chi` supprime ses PVC**. Avec lui, les PVC survivent à un `kubectl delete chi` ou à un `helm uninstall`. Ne pas confondre avec la reclaim policy du **PV** (celle de la StorageClass), qui joue ensuite, quand le PVC lui-même est supprimé.
- **Agrandir** : on change la taille dans le `chi`. Cela ne marche que si la StorageClass a `allowVolumeExpansion: true`. À tester sur l'environnement de preview avant de le promettre.
- **Disque plein** : ClickHouse ne peut plus fusionner ni insérer. Surveiller l'espace libre (`system.disks`) et poser des TTL.

**Mémoire** :

- ClickHouse lit la limite mémoire de son conteneur et se borne lui-même à une fraction (`max_server_memory_usage_to_ram_ratio`, 0,9 par défaut). Une requête trop gourmande échoue alors avec `Memory limit exceeded` (code 241) : **la requête meurt, pas le pod**.
- Si le pod est quand même tué (`OOMKilled`, exit 137), c'est que la limite est trop basse pour la charge ou que d'autres conteneurs du pod consomment. Mettre **requests = limits en mémoire** (QoS Guaranteed, étape 3) pour une base.
- Pas de limite CPU serrée : les fusions prennent du retard.

**Placement** :

- **Anti-affinité** entre réplicas d'un même shard, et entre les trois Keeper : deux réplicas sur le même nœud, ce n'est pas de la haute disponibilité (étape 17.14).
- En cloud multi-zone, un PV bloc est **collé à sa zone** : le pod ne peut renaître que là (étape 5). Répartir les réplicas sur les zones.
- **Un `PodDisruptionBudget`** pour que le drain d'un nœud n'emporte pas deux réplicas ou deux Keeper à la fois.

---

## 25.7 Accès : Services, ports, utilisateurs

| Port | Usage |
|---|---|
| 8123 | HTTP : clients HTTP, la plupart des SDK, outils de BI |
| 9000 | Protocole natif : `clickhouse-client`, drivers natifs |
| 9009 | Inter-serveurs : réplication entre réplicas |
| 8443, 9440 | Variantes TLS de 8123 et 9000 |

**Le Service d'entrée `clickhouse-<chi>` est de type LoadBalancer par défaut.** Chez un client cloud, cela peut créer une IP **externe** vers la base analytique ; on-prem sans MetalLB, il reste en `pending` (étape 4). Dans les deux cas, ce n'est pas ce que tu veux pour une base interne : un `serviceTemplate` de type `ClusterIP` règle la question. Les applications de la plateforme appellent `clickhouse-prod.<ns>.svc.cluster.local:8123`.

**Utilisateurs** :

- L'utilisateur **`default`** existe sans mot de passe, mais l'opérateur le **restreint aux pods du cluster ClickHouse lui-même** (règles réseau dans la configuration générée). Depuis un autre pod, `default` est refusé. C'est voulu : il sert aux échanges entre réplicas.
- Les applications utilisent des **utilisateurs dédiés**, déclarés dans `spec.configuration.users`. Le mot de passe ne s'écrit pas dans le `chi` : il vient d'un **Secret** (`valueFrom.secretKeyRef`), de préférence sous forme de hash (`password_sha256_hex`).
- `networks/ip` borne d'où un utilisateur peut se connecter. Combiné à une NetworkPolicy (si le CNI l'applique, étape 4), c'est l'isolation de la base.
- Un utilisateur par application, avec le profil qui convient (`readonly` pour un outil de BI).

```yaml
spec:
  configuration:
    users:
      app/password_sha256_hex:
        valueFrom:
          secretKeyRef: { name: clickhouse-app, key: password_sha256 }
      app/networks/ip: "10.244.0.0/16"
      app/profile: default
```

---

## 25.8 Avant d'installer : ce qu'on demande au client

L'opérateur s'installe **une fois par cluster** (manifeste unique ou chart Helm `altinity-clickhouse-operator`). Par défaut le manifeste l'installe dans `kube-system` et il surveille **tous** les namespaces.

Ce que l'installation crée, et qui demande des droits d'administrateur de cluster :

- **4 CRDs** : `clickhouseinstallations`, `clickhouseinstallationtemplates`, `clickhouseoperatorconfigurations` (groupe `clickhouse.altinity.com`) et `clickhousekeeperinstallations` (groupe `clickhouse-keeper.altinity.com`).
- Un ServiceAccount, un ClusterRole et son binding, le Deployment `clickhouse-operator` (deux conteneurs : l'opérateur et un exporteur de métriques, port 8888).

Les questions à poser, dans l'ordre :

| Question | Pourquoi |
|---|---|
| **Un opérateur ClickHouse tourne-t-il déjà ?** `kubectl get crd \| grep clickhouse` | Deux opérateurs sur les mêmes CRDs se battent ; une CRD plus ancienne que ton `chi` fait disparaître des champs (étape 9) |
| **Qui installe les CRDs ?** | Objets de cluster : souvent l'équipe plateforme du client, pas toi |
| **Quel registry ?** | En air-gapped, 4 images à pousser : `clickhouse-server`, `clickhouse-keeper`, `clickhouse-operator`, `metrics-exporter`. Chaque image du `chi` et de l'opérateur doit pointer dessus, avec son `imagePullSecret` |
| **Quelle StorageClass ?** Bloc, SSD, extensible ? | 25.6 |
| **Combien de nœuds, de zones ?** | Anti-affinité de 3 Keeper et 2 ou 3 réplicas |
| **Où vont les sauvegardes ?** Un S3 est-il disponible ? | 25.10 |
| **Pod Security, UID imposé ?** (OpenShift) | Le conteneur tourne par défaut avec l'UID 101 et un `fsGroup` ; à vérifier pour la distribution du client |
| **Qui consomme la base ?** Depuis le cluster seulement ? | Type de Service, utilisateurs, NetworkPolicy |

Le chart Helm de l'opérateur installe et met à jour ses CRDs par un hook (`crdHook.enabled`), contrairement au comportement Helm standard vu à l'étape 9 : à désactiver si le client gère les CRDs lui-même.

---

## 25.9 Mettre à jour et opérer sans casser

**Changer la version de ClickHouse** : on modifie le tag de l'image dans le `podTemplate` du `chi`, on applique. L'opérateur redémarre les hôtes **un par un** (rolling update), en attendant que chacun soit de retour avant de passer au suivant. Avec deux réplicas ou plus, la base reste disponible pendant l'opération. Avec un seul, il y a coupure.

Règles de prudence :

- Monter de version progressivement, tester d'abord en preview avec une copie du schéma. Revenir en arrière d'une version majeure n'est pas garanti : **sauvegarde avant**.
- Toutes les images viennent du registry du client : pousser la nouvelle image **avant** de changer le tag, sinon le premier hôte reste en `ImagePullBackOff` et la mise à jour s'arrête là (c'est la bonne nouvelle : les autres hôtes ne sont pas touchés).
- Suivre : `kubectl get chi -w` jusqu'à `Completed`, puis `SELECT hostName(), version() FROM clusterAllReplicas('main', system.one)`.

**Ajouter un réplica** : augmenter `replicasCount`. L'opérateur crée le pod, son PVC, et y recrée le schéma ; les tables répliquées se remplissent seules depuis les autres réplicas. **Retirer** un réplica ou un shard est plus délicat (données du shard à déplacer avant) : jamais à l'improviste.

**Mettre à jour l'opérateur** : une version mineure à la fois (sauter plusieurs mineures n'est pas supporté), en lisant les notes de version, CRDs d'abord (étape 9). Une mise à jour d'opérateur peut déclencher une réconciliation, donc un redémarrage roulant des hôtes.

**Arrêter proprement** : `spec.stop: "yes"` dans le `chi` arrête les pods en gardant les PVC et la ressource. C'est la bonne façon de « scaler à zéro », pas `kubectl scale`.

**Changer une configuration** (`spec.configuration.settings`, `profiles`, `users`) : l'opérateur régénère les ConfigMaps ; selon le réglage, ClickHouse le recharge à chaud ou l'opérateur redémarre les hôtes.

---

## 25.10 Sauvegarder, et le prouver

**Un réplica n'est pas une sauvegarde.** Un `DROP TABLE` ou une mutation erronée se répliquent en quelques secondes sur tous les réplicas.

Deux mécanismes :

| Mécanisme | Comment | Remarque |
|---|---|---|
| **`BACKUP` / `RESTORE` natifs** | Commande SQL : `BACKUP DATABASE analytics TO S3('https://…/bucket/2026-11-12', '<clé>', '<secret>')` | Intégré à ClickHouse ; suivi dans `system.backups` ; à planifier (CronJob) |
| **`clickhouse-backup`** (Altinity) | Outil séparé, souvent en conteneur d'accompagnement du pod | Gère rétention, sauvegardes incrémentales, envoi vers S3, GCS, Azure |

Dans les deux cas, la destination est un **stockage objet hors du cluster** (étape 17.9). En air-gapped, c'est le S3 du client (MinIO, Ceph) : à demander en 25.8.

Ce qu'on sauvegarde : avec des tables répliquées, un seul réplica par shard suffit. Le contenu de Keeper se reconstruit à la restauration, mais la procédure doit avoir été jouée une fois.

Comme à l'étape 17.13, **ne jamais affirmer une sauvegarde sans preuve** :

1. **Configurée ?** Le CronJob existe et sa dernière exécution a réussi.
2. **Présente ?** Les objets sont dans le bucket, récents, d'une taille plausible ; `system.backups` indique `BACKUP_CREATED`.
3. **Restaurable ?** Restauration dans un autre namespace, puis un `SELECT count()` comparé à la production. Seul vrai test.

La décision appartient au client : cette base est « de l'analytique », mais c'est la **source de la facturation** (étape 17.8). La décision doit être explicite, pas héritée d'un oubli.

---

## 25.11 Diagnostiquer : trois étages, trois vérifications

Toujours dans cet ordre :

| Étage | Question | Commande |
|---|---|---|
| 1. Kubernetes | Les pods sont-ils `Running` et `Ready` ? Les PVC `Bound` ? | `kubectl get pods,pvc -n <ns>` ; `kubectl describe pod` |
| 2. Opérateur | Le `chi` est-il `Completed` ? Sinon, que dit l'opérateur ? | `kubectl get chi` ; `kubectl describe chi` ; logs de `clickhouse-operator` |
| 3. ClickHouse | Réplication, parts, erreurs, disque ? | `system.replicas`, `system.parts`, `system.errors`, `system.disks` |

Les symptômes que tu verras :

| Symptôme | Étage | Cause probable | Vérification |
|---|---|---|---|
| Pod `Pending` | 1 | PVC non lié (StorageClass absente), anti-affinité impossible, zone | `describe pod`, `describe pvc` (étape 5) |
| `ImagePullBackOff` | 1 | Image absente du registry du client, secret de pull | `describe pod` |
| `OOMKilled`, exit 137 | 1 | Limite mémoire trop basse | `describe pod` → `Last State` |
| `chi` bloqué `InProgress` | 2 | Un hôte ne revient pas `Ready` : l'opérateur attend | état du pod concerné, logs de l'opérateur |
| `chi` en `Aborted` | 2 | Ressource invalide, réconciliation interrompue | `describe chi`, logs de l'opérateur |
| Champ du `chi` sans effet | 2 | Template non référencé, ou CRD plus ancienne qui supprime le champ | `kubectl get chi -o yaml` (étape 9) |
| `Table is in readonly mode` | 3 | Keeper injoignable ou sans majorité | pods Keeper, `system.replicas.is_readonly` |
| `Too many parts` | 3 | Inserts trop petits et trop fréquents | `system.parts`, côté application |
| `Memory limit exceeded` (241) | 3 | Requête trop lourde pour la limite | la requête, `system.query_log` |
| Réplica en retard | 3 | Réseau entre pods (9009), disque lent, file de réplication | `absolute_delay`, `queue_size` |
| `ON CLUSTER` qui n'aboutit pas | 3 | Un hôte arrêté ou Keeper lent : la requête attend tous les hôtes | `system.distributed_ddl_queue` |
| Disque plein | 1 et 3 | Pas de TTL, logs système de ClickHouse | `system.disks`, `df` dans le pod |
| Tableaux de bord figés, produit OK | 3 | La base est tombée ou refuse les inserts : panne silencieuse | les trois étages, puis le retard des consommateurs du bus |

Le piège constant : s'arrêter à l'étage 1. « Les pods sont verts » ne répond pas à « les données arrivent ».

---

## 25.12 Exercice — clavier en main

Sur le cluster kind `lab`. Environ une heure.

1. **Installer l'opérateur.** `kubectl apply -f https://raw.githubusercontent.com/Altinity/clickhouse-operator/master/deploy/operator/clickhouse-operator-install-bundle.yaml`. Vérifie le Deployment dans `kube-system` et les 4 CRDs.
2. **Keeper.** Dans un namespace `lab25`, crée un `ClickHouseKeeperInstallation` `lab` à 3 réplicas avec un volume de 1Gi. Note les noms des pods et du Service.
3. **ClickHouse.** Crée un `ClickHouseInstallation` `lab`, cluster `main`, 1 shard, 2 réplicas, volume `data` de 1Gi avec `reclaimPolicy: Retain`, Keeper référencé. Attends `Completed`. Liste StatefulSets, pods, Services, ConfigMaps, PVC et compare avec le tableau de 25.4.
4. **Le Service d'entrée.** Regarde le type de `clickhouse-lab` et son `EXTERNAL-IP` sur kind. Relie à l'étape 4.
5. **Répliquée ou pas.** Crée une base `ON CLUSTER`, une table `ReplicatedMergeTree` et une table `MergeTree`. Insère sur le réplica 0, lis sur le réplica 1 : une seule des deux a les données.
6. **Parts.** Fais dix inserts d'une ligne, compte les parts actives, lance `OPTIMIZE TABLE … FINAL`, recompte.
7. **Perdre un pod.** Supprime le pod du réplica 0. Regarde-le revenir avec le même nom et les mêmes données.
8. **Perdre un Keeper sur trois.** Supprime un des trois pods Keeper et insère aussitôt : l'insert passe, la majorité tient à deux sur trois. Avec un seul Keeper, il aurait échoué en `readonly`.
9. **Changer de version.** Change le tag de l'image dans le `chi`. Observe le redémarrage hôte par hôte.
10. **Supprimer le `chi`.** Les PVC restent (`Retain`). Recrée le `chi` : les données sont là.
11. **Nettoyer**, PVC et PV compris.

---

## Validé si…

- Tu sais dire pourquoi mille petits inserts cassent ClickHouse, et quel message d'erreur le signale.
- Tu sais distinguer shard et réplica, et proposer une topologie de départ.
- Tu sais ce que fait Keeper, combien il en faut, et ce que voient les applications quand il est perdu.
- Tu sais nommer les objets que l'opérateur fabrique à partir d'un `chi`, et pourquoi on ne les modifie pas à la main.
- Tu sais lire un `chi` : topologie, Keeper, templates, et l'erreur du template non référencé.
- Tu sais ce qui arrive aux PVC quand on supprime un `chi`, avec et sans `reclaimPolicy: Retain`.
- Tu sais pourquoi le Service par défaut pose problème chez un client et comment les applications se connectent.
- Tu sais lister ce que tu demandes au client avant d'installer (CRDs, registry, StorageClass, nœuds, S3).
- Tu sais mettre à jour ClickHouse sans coupure et dire ce qui se passe si l'image manque.
- Tu sais pourquoi un réplica n'est pas une sauvegarde et donner les trois preuves d'une sauvegarde.
- Tu sais diagnostiquer dans l'ordre pod, opérateur, base, et reconnaître `readonly`, `Too many parts` et le code 241.

**Étape suivante** : aucune, c'est un cas pratique. Les étapes 17 (plan de données) et 20 (méthode de debug) donnent le cadre général.
