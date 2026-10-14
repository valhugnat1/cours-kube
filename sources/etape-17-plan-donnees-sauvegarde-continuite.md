# Étape 17 — Plan de données, sauvegarde et continuité

**Objectif** : à la fin de cette étape, tu sais, pour chaque brique de stockage de la plateforme, dire ce qu'elle contient, qui en dépend, ce que voit l'utilisateur quand elle tombe, comment elle est sauvegardée et comment on la restaure. Tu sais distinguer une installation de preview d'une topologie de production, et tu ne dis **jamais** « c'est sauvegardé » sans l'avoir vérifié.

**Notions couvertes** : §9 (une base par application, pooler, cache clé-valeur, bus de messages, moteur de workflows, base analytique colonnaire, stockage objet, etcd, ce qui casse, services managés externes) et §10 (preview vs production, backup continu et PITR vers objet via plugin d'opérateur, vérification des sauvegardes, haute disponibilité, topologie cible).

**Prérequis** : étape 3 (StatefulSet, PDB, anti-affinité), étape 5 (PV/PVC/StorageClass), étape 9 (opérateurs, CRDs), étape 11 (carte), étapes 13 à 16 (qui utilise quoi).

---

## 17.1 Pourquoi le plan de données mérite une étape à part

Tout ce qui précède est **reconstructible** : un pod d'API, un routeur, un frontend se redéploient depuis le chart et les images. Le plan de données, lui, contient ce qui **ne se reconstruit pas** : utilisateurs, conversations, bibliothèques et leurs vecteurs, jetons de connecteurs, relations d'autorisation, historique des workflows, consommation, fichiers.

Trois conséquences :

1. **Une erreur ici est souvent irréversible.** Un `helm uninstall` qui emporte un PVC, un `DROP`, un bucket vidé : pas de rollback Helm possible (étape 7).
2. **C'est la racine de la règle « descendre d'un plan »** (étape 11) : la majorité des symptômes applicatifs graves se terminent ici.
3. **C'est là que se jouent les questions client les plus sensibles** (étape 23) : où sont les données, sont-elles sauvegardées, en combien de temps on restaure, que se passe-t-il si un nœud meurt.

Deux chiffres structurent toute discussion de continuité, à définir **avec le client**, pas à supposer :

- **RPO** (*Recovery Point Objective*) : combien de données récentes on accepte de perdre. « 5 minutes » exige une sauvegarde continue ; « 24 heures » se contente d'une sauvegarde nocturne.
- **RTO** (*Recovery Time Objective*) : combien de temps la plateforme peut rester indisponible. « 15 minutes » exige de la haute disponibilité et une restauration répétée ; « une journée » laisse le temps de restaurer à la main.

La sauvegarde protège le **RPO** ; la haute disponibilité protège le **RTO** face aux pannes matérielles. **Aucune des deux ne remplace l'autre** : une base répliquée sur trois nœuds réplique aussi un `DELETE` erroné en quelques millisecondes.

---

## 17.2 Vue d'ensemble des briques

| Brique | Contient | Utilisée par | Exemples de technologies |
|---|---|---|---|
| **Bases relationnelles** | État métier : utilisateurs, organisations, conversations, bibliothèques, configuration, jetons chiffrés | Presque tout ; IdP ; moteur ReBAC ; moteur de workflows | PostgreSQL (souvent via opérateur) |
| **Pooler de connexions** | Rien (état transitoire) | Toutes les applications vers PostgreSQL | PgBouncer, Pgpool, pooler intégré à l'opérateur |
| **Cache clé-valeur** | Sessions, compteurs de quota, verrous, caches | API, gouvernance, sessions OIDC, files légères | Redis, Valkey |
| **Bus de messages** | Événements en transit, files de tâches | Ingestion, metering, notifications | NATS JetStream, Kafka, RabbitMQ, Redis Streams |
| **Moteur de workflows** | Historique et état des traitements longs | Ingestion, connecteurs, deep research, tâches planifiées | Temporal et équivalents (sur une base relationnelle) |
| **Base analytique colonnaire** | Consommation, traces produit, évaluations, événements | Tableaux de bord, facturation, observabilité produit | ClickHouse et équivalents |
| **Base vectorielle** | Vecteurs et passages du RAG | RAG, recherche | Extension de PostgreSQL (`pgvector`), moteur dédié, ou fonction d'une autre brique |
| **Stockage objet** | Fichiers originaux, pièces jointes, artefacts, poids de modèles, **sauvegardes** | Ingestion, sandboxes, canvas, audio, sauvegardes | S3-compatible : bucket cloud, MinIO, Ceph RGW, stockage du client |
| **etcd** | L'état du **cluster** Kubernetes | Kubernetes lui-même | Géré par le cloud ou par le client |

Pour chaque brique, trois questions systématiques, qui structurent la suite :

1. **Embarquée dans le chart ou fournie par le client (service managé) ?**
2. **Si elle tombe, qu'est-ce qui casse, et avec quel bruit ?**
3. **Comment est-elle sauvegardée, et la restauration a-t-elle déjà été testée ?**

---

## 17.3 Bases relationnelles : une base par application

### Le principe

Chaque application (API, IdP, moteur d'autorisation, moteur de workflows, gestion des connecteurs…) a **sa propre base de données**, avec son propre utilisateur et ses propres droits. Pas de schéma partagé où plusieurs services lisent les tables des autres.

Ce que ça apporte :

- **Isolation des pannes** : une migration ratée ou une requête folle d'une application ne verrouille pas les tables d'une autre.
- **Isolation de sécurité** : une application compromise ne lit que sa base.
- **Cycles de vie indépendants** : migrations, montées de version, restaurations par application.
- **Diagnostic lisible** : les connexions, la charge, la taille par base disent quel service consomme.

Ce que ça coûte :

- plus d'**objets à gérer** (bases, utilisateurs, secrets, sauvegardes) ;
- plus de **connexions** au total ;
- plus de **ressources** si chaque base a son propre **cluster** PostgreSQL.

### Les trois niveaux d'isolation

| Niveau | Principe | Isolation | Coût |
|---|---|---|---|
| **Schémas** dans une même base | Un schéma par application | Faible (même base, mêmes ressources) | Minimal |
| **Bases distinctes** dans un même cluster PostgreSQL | Une base par application, une instance serveur partagée | Logique : droits, migrations ; **pas** de ressources (CPU, mémoire, connexions, WAL partagés) | Moyen |
| **Clusters distincts** | Un cluster PostgreSQL (primaire + réplicas) par application ou groupe d'applications | Forte : pannes, ressources, versions, sauvegardes indépendantes | Élevé (× nombre de clusters) |

Compromis courant : **bases distinctes dans quelques clusters**, en isolant dans leur propre cluster les applications critiques ou très sollicitées (IdP, moteur de workflows qui écrit beaucoup). Sur une preview, souvent un seul cluster sans réplica.

À savoir pour le diagnostic : dans un cluster partagé, **une application peut en ralentir d'autres** (verrous non, mais CPU, I/O, `max_connections`, génération de WAL, autovacuum). « Tout est lent » + une seule base qui travaille énormément = voisin bruyant au niveau PostgreSQL.

### Les migrations de schéma

Chaque montée de version peut modifier les schémas. Exécutées par un **Job** (hook Helm `pre-upgrade`) ou un **init container**. Rappels et compléments :

- Pods bloqués en `Init:0/1` à l'upgrade = souvent une **migration en cours ou bloquée** (étape 21). Logs de l'init container ou du Job d'abord.
- **Migration bloquée par un verrou** : une transaction longue (ou oubliée dans une session ouverte) empêche un `ALTER TABLE`. Regarder `pg_stat_activity` et `pg_locks`, ne pas tuer à l'aveugle.
- **Migration non réversible** : un `helm rollback` restaure les manifestes, **pas le schéma**. L'ancienne version de l'application face au nouveau schéma peut ne plus démarrer. D'où : sauvegarde (ou point de restauration identifié) **avant** tout upgrade avec migration.
- **`--atomic` + migration longue** : le timeout Helm déclenche un rollback pendant que la migration tourne encore (étape 7).

### Opérateur PostgreSQL

On ne gère pas PostgreSQL de production avec un simple StatefulSet. Un **opérateur** (CloudNativePG, Zalando postgres-operator, Crunchy PGO…) apporte : réplication, bascule automatique (*failover*), gestion des certificats et des utilisateurs, sauvegardes, restauration, montées de version mineures, pooler intégré.

Rappel de l'étape 9 : c'est un **prérequis cluster-wide** (CRDs, webhooks). Présent chez le client ? Quelle version ? Qui le met à jour ?

Commandes de lecture (exemple CloudNativePG, les autres ont des équivalents) :

```bash
kubectl get clusters.postgresql.cnpg.io -A                    # clusters, instances, primaire, statut
kubectl describe cluster <nom> -n <ns>                        # conditions, dernière sauvegarde, WAL archivés
kubectl get pods -n <ns> -l cnpg.io/cluster=<nom> -L role     # quel pod est primaire / réplica
kubectl cnpg status <nom> -n <ns>                             # plugin kubectl : réplication, archivage, sauvegardes
```

---

## 17.4 Le pooler et le faux « too many connections »

### Pourquoi un pooler

Une connexion PostgreSQL est **un processus serveur** (plusieurs Mo de mémoire). Avec des dizaines de pods, chacun avec un pool de 10 à 20 connexions dans son ORM, multipliés par les réplicas et les workers, on atteint vite des milliers de connexions — bien au-delà de ce que PostgreSQL supporte (`max_connections`, souvent 100 à quelques centaines).

Le **pooler** (PgBouncer, le plus répandu) s'intercale :

```
pods (milliers de connexions clientes, légères)
  → PgBouncer (max_client_conn : combien de clients il accepte)
      → quelques dizaines de vraies connexions serveur (default_pool_size par couple base/utilisateur)
          → PostgreSQL (max_connections)
```

### Les modes de pooling

| Mode | Une connexion serveur est rendue au pool… | Compatibilité |
|---|---|---|
| **session** | à la déconnexion du client | Totale, mais peu de gain |
| **transaction** | à la fin de chaque transaction | Gain maximal ; **casse** ce qui dépend de l'état de session |
| **statement** | après chaque requête | Rare ; pas de transactions multi-requêtes |

En mode **transaction**, ce qui casse : **prepared statements** côté serveur (selon les versions du pooler et du driver — erreurs du type `prepared statement "…" does not exist` ou `already exists`), variables de session (`SET`), verrous consultatifs de session (*advisory locks*), `LISTEN/NOTIFY`, tables temporaires. Certains outils (migrations qui prennent un verrou consultatif, certains moteurs de workflows) doivent donc **contourner le pooler** ou utiliser un pool en mode session.

### Le faux « too many connections »

Le message que tout le monde lit comme « la base est saturée » a **plusieurs émetteurs**, et la base est souvent en parfaite santé.

| Où naît l'erreur | Message typique (varie selon versions) | Vraie cause | Vérifier |
|---|---|---|---|
| **PostgreSQL** | `FATAL: sorry, too many clients already` / `remaining connection slots are reserved` | `max_connections` atteint — souvent par des applications **qui contournent le pooler**, des connexions inactives, des jobs de migration ou de sauvegarde | `SELECT usename, application_name, client_addr, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3,4 ORDER BY 5 DESC;` |
| **Le pooler, côté clients** | `no more connections allowed (max_client_conn)` | `max_client_conn` du pooler trop bas pour le nombre de pods × taille des pools applicatifs | `SHOW CONFIG;` / `SHOW CLIENTS;` dans la console d'admin PgBouncer |
| **Le pooler, côté pool** | Timeouts d'attente : `query_wait_timeout`, clients en attente | `default_pool_size` trop petit pour ce couple base/utilisateur ; **transactions longues** qui gardent les connexions serveur | `SHOW POOLS;` → colonnes `cl_waiting`, `sv_active`, `maxwait` |
| **L'application** | `QueuePool limit of size N overflow M reached` (SQLAlchemy), `Connection pool exhausted` | Pool **de l'ORM** plein : fuites de connexions (sessions non fermées), requêtes lentes, trop de concurrence dans le pod | Logs applicatifs, métriques du pool de l'ORM |

La méthode : **lire le texte exact et identifier l'émetteur** avant de toucher à un paramètre. Augmenter `max_connections` de PostgreSQL quand le pooler refuse les clients ne change rien ; l'augmenter pour « régler » une fuite de connexions dans une application déplace la panne et consomme la mémoire du serveur.

Autres symptômes du pooler à connaître :

- **Pooler en panne ou redémarré** : **toutes** les applications perdent la base en même temps, alors que PostgreSQL va bien et que `kubectl get pods` sur le cluster PostgreSQL est tout vert. Premier suspect quand tout le monde échoue en même temps avec des erreurs de connexion.
- **Bascule du primaire** : le pooler doit suivre le nouveau primaire (Service de l'opérateur). Pendant quelques secondes, **rafales d'erreurs** de connexion — **faux positif connu** à documenter (étape 22), à distinguer d'une panne qui dure.
- **Pooler en un seul réplica** : point unique de défaillance devant une base hautement disponible. Classique.

---

## 17.5 Cache clé-valeur

Rappels des étapes 13 et 14, rassemblés :

| Usage | Si le cache tombe |
|---|---|
| Sessions applicatives, état OIDC (`state`, `nonce`) | Tout le monde est déconnecté ; logins en cours en échec (`state` invalide) |
| Compteurs de rate limit / quota | Fail-open (plus de limites) ou fail-closed (429/5xx partout) selon la conception |
| Sémaphores de concurrence, verrous distribués | Libérés (effet « redémarrer a réparé ») ; risque de doublons de traitement si un verrou protégeait une tâche unique |
| Cache de clés API valides, de configuration, de permissions | Lenteur (retour à la base), charge accrue sur la base et le moteur ReBAC → **peut faire tomber le plan du dessous** |
| Files légères (Redis Streams, listes) | Tâches en transit perdues si non persistées |

Points d'exploitation :

- **Persistance** : un cache « pur » n'en a pas besoin ; un Redis qui sert **aussi** de file ou de stockage de sessions longues en a besoin (AOF/RDB). Savoir lequel on a. Un Redis sans persistance redémarré = sessions perdues, et c'est normal.
- **`maxmemory` et politique d'éviction** : quand la mémoire est pleine, Redis évince (`allkeys-lru`…) ou refuse les écritures (`noeviction`). Évincer des compteurs ou des sessions produit des bugs intermittents ; refuser les écritures produit des erreurs `OOM command not allowed`. Le choix dépend des usages mélangés dans l'instance — argument pour **séparer** cache et files.
- **`limits.memory` du pod** doit dépasser `maxmemory` avec marge (fragmentation, réplication, sauvegarde en fork) : sinon `OOMKilled` (étape 0) au lieu d'une éviction contrôlée.
- **Haute disponibilité** : Sentinel ou mode cluster ; les clients doivent le supporter (un client configuré pour une instance unique ne suit pas une bascule).
- **Commandes dangereuses** : `KEYS *`, `FLUSHALL`, `FLUSHDB` — sur une instance partagée entre usages, un « vidage du cache » efface aussi les sessions et les compteurs (étape 14).

---

## 17.6 Bus de messages

Découple les producteurs (API d'ingestion, gouvernance pour le metering) des consommateurs (workers, agrégateurs).

Notions qui suffisent pour exploiter :

- **Persistance / rétention** : un message non persisté (NATS core, Redis pub/sub) est **perdu** si aucun consommateur n'est là ; un flux persistant (JetStream, Kafka, Redis Streams) les conserve selon une rétention (durée, taille, nombre).
- **Acquittement** : un message est retiré (ou marqué traité) quand le consommateur l'acquitte. Consommateur qui crashe avant l'acquittement → **redélivrance** → le traitement doit être **idempotent** (étape 14 : double comptage, étape 16 : passages dupliqués).
- **Lag** : écart entre le dernier message produit et le dernier consommé. **C'est la métrique du bus** : il grandit quand les workers sont trop lents, arrêtés, ou en échec permanent.
- **Messages empoisonnés** : un message qui fait crasher le consommateur à chaque livraison bloque la file derrière lui. Nombre maximal de livraisons et file de lettres mortes (*dead letter*).

Si le bus tombe :

| Conception | Effet |
|---|---|
| Producteur synchrone qui échoue si le bus est absent | Uploads / actions en erreur immédiate (5xx) |
| Producteur qui met en tampon ou réessaie | Rien de visible, puis rattrapage — ou perte si le tampon déborde |
| Consommateurs | Tâches « en attente » partout ; metering en retard ; **panne silencieuse** (étape 11) |
| Bus plein (disque, rétention en « refuser ») | Producteurs bloqués ou en erreur : l'ingestion d'un gros lot peut bloquer le metering de tout le monde s'ils partagent le flux |

Le bus persistant est un **StatefulSet avec PVC** : même discipline que les bases (stockage, anti-affinité, PDB, sauvegarde si les messages ont de la valeur — souvent ils n'en ont pas au-delà de quelques heures, ce qui est une **décision à écrire**).

---

## 17.7 Moteur de workflows : namespaces par application

Complément de l'étape 16, côté données :

- Le moteur stocke **tout l'historique** des workflows dans sa propre base (souvent PostgreSQL, parfois Cassandra), et peut s'appuyer sur une base de recherche pour la visibilité.
- **Un namespace par application** (ingestion, connecteurs, agents, deep research…) : chacun a sa **rétention** d'historique, ses files, ses limites. Isoler évite qu'une application qui lance des millions de workflows courts n'affecte les workflows longs d'une autre, et permet de raisonner la volumétrie par application.
- **Volumétrie** : c'est souvent **la base qui grossit le plus vite** de la plateforme (chaque étape de chaque workflow est écrite). Rétention trop longue ou workflows très bavards → disque plein → **toutes** les fonctionnalités asynchrones à l'arrêt.
- **Charge d'écriture** : candidat naturel à son **propre cluster PostgreSQL** (17.3).
- **Si le moteur ou sa base tombe** : les workflows en cours sont **suspendus, pas perdus** (c'est tout l'intérêt) ; ils reprennent au retour. Les nouvelles tâches ne démarrent pas. Côté utilisateur : « en cours » indéfiniment.
- **Restaurer la base du moteur** à un point antérieur est délicat : des workflows déjà terminés (et leurs effets de bord : documents indexés, emails envoyés) « reviennent » en cours et peuvent se ré-exécuter. Scénario à connaître, et à ne jamais improviser.

---

## 17.8 Base analytique colonnaire

Une base **colonnaire** stocke les données par colonne plutôt que par ligne : agrégations massives (« tokens par organisation par jour sur 90 jours ») très rapides, écritures par lots, mises à jour et suppressions ligne à ligne coûteuses.

Contenu typique : événements de consommation (étape 14), traces de conversations et d'agents, évaluations, métriques produit.

Points d'exploitation :

- **Insertion par lots** : les consommateurs du bus accumulent puis écrivent. Des milliers de petites insertions unitaires dégradent fortement ce type de base (trop de fusions de parties en arrière-plan).
- **Si elle tombe** : le produit **continue de fonctionner** ; tableaux de bord, consommation et traces ne se mettent plus à jour ; selon la rétention du bus, les données sont rattrapées ou perdues. **Panne silencieuse** par excellence.
- **Volumétrie et rétention** : TTL par table (traces sur 30 jours, consommation agrégée sur des années). Sans TTL, le disque se remplit lentement jusqu'au jour où il est plein.
- **Suppressions** (RGPD, rétention des conversations) : plus complexes qu'en relationnel ; à vérifier si les traces contiennent du contenu de conversations.
- **Réplication** : en production, plusieurs réplicas coordonnés (par exemple ClickHouse avec Keeper) ; en preview, une instance unique.
- **Sauvegarde** : souvent négligée « parce que c'est de l'analytique » — alors que c'est **la source de la facturation**. Décision à expliciter.

---

## 17.9 Stockage objet S3

Contient : documents originaux, pièces jointes, fichiers générés, audio, parfois poids de modèles, et surtout **les sauvegardes des autres briques**.

Points d'exploitation :

- **Compatible S3 ne veut pas dire identique** : signatures (v2/v4), adressage *path-style* vs *virtual-hosted* (`bucket.host` exige un DNS wildcard — souvent absent on-prem), multipart, versioning, object lock, politiques de cycle de vie. Un client S3 qui marche sur AWS peut échouer sur un Ceph ou un MinIO avec une erreur obscure. Le premier réglage à vérifier : **path-style**.
- **Endpoint et TLS** : endpoint interne avec certificat d'une CA d'entreprise → CA à monter dans **tous** les pods qui lisent/écrivent, y compris les pods de sauvegarde de l'opérateur PostgreSQL (erreur `x509` dans les logs de sauvegarde, alors que l'application marche — parce que les deux ne sont pas configurés au même endroit).
- **Identité** : clés d'accès en Secret, ou Workload Identity sur GKE (étape 10). Principe du moindre privilège : l'application n'a pas besoin de supprimer les sauvegardes ; le système de sauvegarde n'a pas besoin de lire les documents.
- **Si le stockage objet tombe** : uploads et ingestion en échec, pièces jointes et canvas cassés, **archivage des WAL PostgreSQL en échec** → le disque de WAL du primaire se remplit (les WAL ne sont pas recyclés tant qu'ils ne sont pas archivés) → **la base s'arrête** quand le disque est plein. Une panne du stockage objet peut donc, avec quelques heures de retard, **arrêter la base de données**. Exemple parfait de « descendre d'un plan » différé.
- **Protection des sauvegardes** : versioning, **object lock** (immuabilité, anti-ransomware), réplication vers un autre site ou une autre région, cycle de vie pour supprimer les anciennes sauvegardes **en cohérence** avec la rétention de l'opérateur.
- **Même bucket, même panne** : sauvegarder la base dans le stockage objet **du même cluster** (MinIO dans le namespace de la plateforme, sur les mêmes disques) ne protège de rien en cas de perte du cluster. La sauvegarde doit vivre **ailleurs**.

---

## 17.10 etcd : l'état du cluster, pas celui de la plateforme

etcd contient **tous les objets Kubernetes** : Deployments, Services, Secrets, ConfigMaps, CRs, releases Helm (qui sont des Secrets, étape 7). Il ne contient **pas** les données des applications (qui sont dans les PV).

À savoir :

- **Cloud managé (GKE)** : etcd est invisible et géré par le fournisseur. Tu n'y as pas accès.
- **On-prem** : géré par le client (kubeadm, RKE2, OpenShift). Sa sauvegarde est **de leur responsabilité** (sous la frontière, étape 11) — à confirmer explicitement.
- **Perdre etcd = perdre la définition du cluster**, pas les disques. Les PV peuvent survivre, mais sans les objets PV/PVC qui les référencent, les rattacher demande un travail manuel.
- **Les Secrets sont dans etcd** : chiffrement au repos d'etcd (configuration de l'API server) — question de sécurité client.
- **Sauvegarde d'objets Kubernetes** (Velero, étape 24) : exporte les manifestes et peut piloter des snapshots de volumes. Complémentaire, **pas équivalent**, aux sauvegardes applicatives des bases : un snapshot de disque pris pendant qu'une base écrit n'est cohérent que si la base le supporte (ou si l'outil l'orchestre).
- **Pour la plateforme**, ce qu'on doit pouvoir reconstruire depuis Git + les sauvegardes applicatives : tout ce qui est dans etcd, **sauf** ce qui n'est pas versionné — secrets générés, réglages faits à la main (`kubectl edit`, étape 2), CRs créées dynamiquement. Liste à tenir.

---

## 17.11 Services managés externes à qualifier

Beaucoup de clients veulent (ou exigent) leurs **propres** services : base PostgreSQL managée (Cloud SQL, Azure Database, DBaaS interne), Redis managé, stockage objet de l'entreprise, Kafka d'entreprise. Le chart désactive alors la brique embarquée et reçoit une adresse et des identifiants.

C'est souvent le bon choix (le client sait sauvegarder et exploiter ses bases). Mais « nous avons un PostgreSQL » ne suffit pas. **Qualifier**, point par point, **avant** l'installation :

| Critère | Pourquoi ça compte |
|---|---|
| **Version** | Minimum requis par chaque application ; fonctionnalités utilisées |
| **Extensions** | `pgvector` (RAG), `pgcrypto`, `uuid-ossp`… — souvent **non autorisées** sur un DBaaS d'entreprise, ou dans une version trop ancienne |
| **Droits** | Créer des bases, des utilisateurs, des extensions, des schémas ; migrations qui exigent un propriétaire de schéma |
| **Nombre de bases / utilisateurs** | « Une base par application » = une dizaine de bases : le DBaaS interne le permet-il, en libre-service ou par ticket ? |
| **Connexions** | `max_connections` du service ; pooler fourni ou non ; compatibilité du mode transaction |
| **Latence réseau** | Base dans une autre zone ou un autre site : quelques ms de plus par requête, multipliées par les dizaines de requêtes d'un appel API |
| **TLS et CA** | Obligatoire ? CA à monter partout (17.9) |
| **Réseau** | Joignable depuis les pods ? Via le proxy ? Pare-feu ? (`NO_PROXY`, étape 12) |
| **Sauvegarde et PITR** | Qui, quelle fréquence, quelle rétention, **test de restauration existant**, qui déclenche une restauration et en combien de temps |
| **Haute disponibilité** | Bascule automatique ? Durée ? Adresse stable après bascule ? |
| **Maintenance** | Fenêtres de maintenance imposées, redémarrages, montées de version forcées |
| **Redis** | Mode cluster ou non (et support client), persistance, `maxmemory-policy` imposée, commandes désactivées |
| **Stockage objet** | Path-style, versioning, object lock, multipart, quotas, cycle de vie |
| **Bus** | Création de topics/flux en libre-service, rétention, ACL, authentification (SASL, mTLS) |

Chaque ❌ se traite **avant** l'installation : contournement documenté, brique embarquée à la place, ou décision du client. Découvrir le jour J que `CREATE EXTENSION vector` est refusé est un classique.

La frontière de responsabilité se déplace alors : **la sauvegarde et la HA de ce service sont chez le client**. À écrire noir sur blanc.

---

## 17.12 Preview vs production

Une **preview** (démo, pilote, environnement éphémère, étape 21) et une **production** peuvent déployer **le même chart** avec des topologies radicalement différentes.

| Aspect | Preview typique | Production cible |
|---|---|---|
| Instances PostgreSQL | 1 instance, un cluster pour tout | Primaire + réplicas (≥ 2 au total, souvent 3), plusieurs clusters |
| Pooler | 1 réplica ou absent | ≥ 2 réplicas, PDB |
| Cache | 1 instance sans persistance | HA (Sentinel/cluster) selon les usages |
| Bus | 1 nœud | 3 nœuds (quorum) |
| Base analytique | 1 instance | Réplicas + coordination |
| Stockage objet | MinIO dans le namespace | Stockage du client, hors cluster, versionné |
| Moteur de workflows | Réplicas uniques | Services répliqués, base dédiée |
| Sauvegardes | **Souvent aucune** | Continues + PITR, hors site, testées |
| Anti-affinité, zones | Aucune | Instances réparties sur nœuds et zones |
| PDB | Absents | Présents, cohérents avec le nombre de nœuds |
| Stockage | StorageClass par défaut, petite taille | Classe performante, expansion, snapshots |
| Rétention | Courte | Définie par le client |
| Inférence | Souvent déportée (étape 15) | Souvent locale |

Deux règles :

1. **Ne jamais présenter la preview comme représentative** en matière de performance, de résilience ou de sauvegarde. « Que se passe-t-il si ce nœud tombe ? » a une réponse différente sur les deux, et il faut donner les deux.
2. **Les données de preview sont jetables par défaut.** Si un client commence à y mettre des données réelles (pilote qui dure, documents importants), le dire et décider : soit on migre vers une topologie avec sauvegardes, soit on documente explicitement l'absence de sauvegarde et le client l'accepte par écrit.

---

## 17.13 Sauvegarde continue et PITR vers objet

### Les principes, pour PostgreSQL

Deux composants :

- **Sauvegarde de base (*base backup*)** : copie physique des fichiers de la base à un instant, prise sans arrêter le service. Périodique (quotidienne, par exemple).
- **Archivage continu des WAL** : PostgreSQL écrit chaque modification dans le *Write-Ahead Log* ; chaque segment de WAL est **envoyé en continu** vers le stockage objet.

La restauration **PITR** (*Point-In-Time Recovery*) = prendre la dernière sauvegarde de base antérieure au point voulu, puis **rejouer les WAL** jusqu'à l'instant choisi (« juste avant le `DELETE` de 14:32:10 »).

```
base backup (dim 02:00) ──WAL──WAL──WAL──WAL──WAL── … ──WAL── (mer 14:32:10)
                                                              ▲ restauration à cet instant
RPO ≈ délai d'archivage du dernier WAL (secondes à quelques minutes)
RTO ≈ copie de la base + rejeu des WAL depuis la base backup (d'où des base backups régulières)
```

### Via plugin d'opérateur

Les opérateurs PostgreSQL délèguent souvent l'envoi vers le stockage objet à un **composant dédié** — par exemple, pour CloudNativePG, un **plugin Barman Cloud** qui gère archivage des WAL et sauvegardes vers S3/GCS/Azure. La configuration se fait en déclaratif :

- un objet décrivant **la destination** (bucket, chemin, identifiants en Secret, CA, compression, chiffrement) ;
- le cluster PostgreSQL qui **référence** ce plugin pour l'archivage des WAL ;
- des objets `ScheduledBackup` (planification des sauvegardes de base) et `Backup` (sauvegarde ponctuelle) ;
- une **politique de rétention** (par exemple 30 jours).

(Les noms exacts des CRDs et des champs dépendent de l'opérateur **et de sa version** — l'intégration par plugin a remplacé une configuration intégrée dans des versions antérieures. Lire la documentation de la version installée, étape 9.)

Restauration : on **ne restaure pas « par-dessus »** un cluster existant. On crée un **nouveau** cluster dont la source d'initialisation (`bootstrap: recovery`) est la sauvegarde, avec une **cible de restauration** (instant, transaction, ou dernier WAL disponible). Puis on bascule les applications vers lui. Conséquences : il faut la place pour un deuxième cluster, et une procédure pour rediriger le pooler / les secrets.

### Ne jamais affirmer une sauvegarde sans vérifier

Règle centrale de l'étape, qui rejoint l'étape 23 (constat vs croyance) :

> **« C'est sauvegardé » est une affirmation qui exige une preuve datée. Et « c'est restaurable » en exige une autre.**

Les raisons pour lesquelles une sauvegarde « configurée » n'existe pas, toutes vécues :

- archivage des WAL **en échec depuis des semaines** (CA, identifiants expirés, bucket supprimé, quota) ; seule trace : une condition dans le statut du cluster et des logs que personne ne lit ;
- `ScheduledBackup` créé mais **suspendu**, ou planifié dans un fuseau inattendu, ou pointant vers un autre cluster ;
- sauvegardes présentes mais **dans le même cluster** (MinIO local) ;
- **rétention** supprimant plus que prévu, ou cycle de vie du bucket incohérent avec la rétention de l'opérateur (WAL supprimés → PITR impossible entre deux base backups) ;
- sauvegarde de la base principale, mais **pas** de celle de l'IdP, du moteur de workflows ou du moteur ReBAC (clusters différents) ;
- chiffrement avec une clé **qu'on ne retrouve plus** ;
- restauration **jamais testée**, qui échoue le jour venu (version de l'opérateur, taille, droits).

La vérification, en trois niveaux :

```bash
# 1. Configuré ? (statut de l'opérateur)
kubectl get clusters.postgresql.cnpg.io -A -o yaml | yq '.items[] | {"name": .metadata.name, "conditions": .status.conditions, "firstRecoverabilityPoint": .status.firstRecoverabilityPoint, "lastSuccessfulBackup": .status.lastSuccessfulBackup}'
kubectl get scheduledbackups,backups -A
kubectl cnpg status <cluster> -n <ns>        # archivage des WAL : dernier archivé, dernier échec

# 2. Présent là où on le croit ? (le bucket lui-même, avec les droits de lecture adéquats)
#    lister les base backups et les WAL récents, vérifier les horodatages, la taille, la continuité

# 3. Restaurable ? (le seul vrai test)
#    restaurer dans un NOUVEAU cluster, à un instant donné, et vérifier les données applicatives
```

Et la formulation honnête, selon ce que tu as réellement constaté :

| Constat | Ce que tu peux dire |
|---|---|
| Rien vérifié | « Je n'ai pas vérifié l'état des sauvegardes. » |
| Configuration lue | « Une sauvegarde est configurée vers X ; je n'ai pas vérifié qu'elle réussit. » |
| Statut OK + objets datés dans le bucket | « La dernière sauvegarde réussie date de … ; l'archivage des WAL est à jour à … ; la restauration n'a pas été testée. » |
| Restauration testée | « Restauration testée le …, à un point dans le temps, en … minutes, données applicatives vérifiées. » |

Pour chaque brique **autre** que PostgreSQL, la même grille : cache (souvent « pas de sauvegarde, par décision »), bus (idem ou rétention), base analytique, stockage objet (versioning, réplication), etcd (client). La décision « on ne sauvegarde pas X » est légitime — **à condition d'être écrite**.

---

## 17.14 Haute disponibilité : instances par composant, topologie cible

La HA répond à : **un nœud, une zone, un pod disparaît — que se passe-t-il ?**

### Par composant

| Composant | HA typique | Ce qui est nécessaire | Durée d'interruption à une panne |
|---|---|---|---|
| Applications sans état (API, routeur, UI, workers) | ≥ 2 réplicas | Anti-affinité, PDB, readiness | Nulle à quelques secondes |
| PostgreSQL | Primaire + ≥ 1 réplica, bascule par l'opérateur | Réplicas sur nœuds / zones différents, stockage par instance | Secondes à dizaines de secondes (rafales d'erreurs, 17.4) |
| Pooler | ≥ 2 réplicas | Service stable, PDB | Nulle si ≥ 2 |
| Redis | Sentinel / cluster (3 nœuds pour le quorum) | Clients compatibles | Secondes |
| Bus | 3 nœuds (quorum), réplication des flux | Anti-affinité, stockage par nœud | Secondes |
| Base analytique | Réplicas + coordination (3 nœuds) | Idem | Écritures en attente |
| Moteur de workflows | Services répliqués, base HA | Idem | Workflows suspendus puis repris |
| IdP | ≥ 2 réplicas, cache de sessions distribué | Configuration du cache partagé entre réplicas | Logins en échec pendant la bascule si mal configuré |
| Moteurs d'inférence | ≥ 2 réplicas par modèle | **GPU × 2** (étape 15) | Minutes si 1 seul réplica (rechargement) |
| Stockage objet | Hors cluster / service du client | — | Selon le client |

### Pièges de topologie

- **Réplicas sur le même nœud** : 3 réplicas sans anti-affinité, planifiés sur le même nœud, meurent ensemble. Vérifier **où** tournent les pods, pas combien il y en a :
  ```bash
  kubectl get pods -n platform -o wide --sort-by=.spec.nodeName | awk '{print $1, $7}'
  kubectl get nodes -L topology.kubernetes.io/zone
  ```
- **Anti-affinité `required` avec moins de nœuds que de réplicas** → pods `Pending` (étape 3). **`preferred`** → répartition non garantie. Choisir en fonction du nombre réel de nœuds du client.
- **PDB incohérent** : `minAvailable: 2` sur un composant à 2 réplicas → le drain du nœud est bloqué indéfiniment (étape 3) ; le client ne peut plus faire ses mises à jour de nœuds et t'appelle.
- **Stockage zonal** : un PV de disque persistant est lié à **une zone**. Si la zone tombe, le pod ne peut pas être replanifié ailleurs avec son disque : la HA doit venir de la **réplication applicative** (réplicas PostgreSQL dans d'autres zones), pas du rescheduling.
- **Point unique de défaillance caché** : tout est répliqué sauf le pooler, le Redis des sessions, l'ingress controller, le proxy egress, le serveur du moteur de workflows, ou l'unique réplica d'un modèle. Pour chaque composant de la carte : combien d'instances, sur combien de nœuds, dans combien de zones.
- **Quorum** : 2 nœuds de bus ou de coordination = pas de HA (la perte d'un nœud fait perdre le quorum). Toujours un nombre **impair ≥ 3**.
- **Coût** : la topologie cible multiplie les ressources (et les GPU). C'est une discussion de dimensionnement avec le client (étape 23), pas une valeur par défaut qu'on active sans le dire.

### Topologie cible

Pour chaque client, un document court (dans la carte) : RPO et RTO convenus, nombre de nœuds et de zones, instances par composant, sauvegardes (quoi, où, rétention, dernier test), services managés et leur responsable, **écarts** entre la topologie actuelle et la cible (« actuellement preview : 1 instance PostgreSQL, pas de sauvegarde ; cible : … »).

---

## 17.15 Pièges

- **Confondre HA et sauvegarde** : la réplication réplique aussi les erreurs.
- **RPO/RTO supposés** au lieu d'être convenus avec le client.
- **`helm rollback` après une migration de schéma** : les manifestes reviennent, pas le schéma.
- **Migration bloquée par une transaction longue**, prise pour une migration lente.
- **Cluster PostgreSQL partagé** : voisin bruyant entre applications.
- **« too many connections » attribué à PostgreSQL** alors qu'il vient du pooler ou de l'ORM ; augmenter `max_connections` au hasard.
- **Applications qui contournent le pooler** ; **mode transaction** incompatible avec prepared statements ou verrous de session.
- **Pooler en un seul réplica** devant une base HA.
- **Rafales d'erreurs à la bascule** prises pour une panne (ou une vraie panne prise pour une rafale normale).
- **Redis partagé** entre cache, sessions et files : éviction ou `FLUSHALL` qui efface les sessions.
- **`limits.memory` de Redis ≤ `maxmemory`.**
- **Consommateurs non idempotents** ; messages empoisonnés sans dead letter ; lag non surveillé.
- **Base du moteur de workflows** qui remplit son disque ; restauration de cette base sans mesurer les ré-exécutions.
- **Base analytique non sauvegardée** alors qu'elle porte la facturation ; insertions unitaires.
- **Stockage objet sans path-style** on-prem ; CA non montée dans les pods de **sauvegarde**.
- **Stockage objet en panne → WAL non archivés → disque plein → base arrêtée** quelques heures plus tard.
- **Sauvegardes dans le même cluster** que la base.
- **Cycle de vie du bucket** incohérent avec la rétention de l'opérateur.
- **Sauvegarde de la base principale seulement** (oubli de l'IdP, du ReBAC, du moteur de workflows).
- **« C'est sauvegardé »** sans preuve datée ; restauration jamais testée.
- **Service managé non qualifié** (extension refusée, droits, connexions, latence).
- **Preview présentée comme représentative** ; données réelles dans une preview sans sauvegarde.
- **Réplicas sur le même nœud**, PDB bloquant, stockage zonal pris pour de la HA, quorum à 2.

---

## 17.16 Exercice — couper le cache, puis le pooler, et noter le symptôme applicatif de chacun

Sur ton cluster kind, en réutilisant la gouvernance de l'étape 14 et la chaîne d'ingestion de l'étape 16.

### Partie 1 — Monter un plan de données « à la production », en petit

1. Crée un cluster kind **à 3 nœuds workers**, labellisés avec trois zones fictives (`topology.kubernetes.io/zone=a|b|c`).
2. Installe un **opérateur PostgreSQL** (CloudNativePG, par exemple) et son **plugin de sauvegarde vers objet**, en suivant la documentation **de la version installée**.
3. Installe un stockage objet **séparé du namespace de la plateforme** (MinIO dans son propre namespace, avec un bucket de sauvegardes et un bucket applicatif, identifiants distincts). Note que sur kind c'est encore « le même cluster » — c'est une limite de l'exercice à écrire.
4. Crée **deux clusters PostgreSQL** :
   - `pg-app` (3 instances, anti-affinité par zone, `pgvector` disponible) avec deux bases : `api`, `ingestion` ;
   - `pg-idp` (2 instances) pour l'IdP de l'étape 13.
5. Active pour `pg-app` : archivage des WAL, `ScheduledBackup` quotidien **et** une sauvegarde toutes les 15 minutes (pour l'exercice), rétention courte.
6. Déploie un **pooler** en mode transaction, 2 réplicas, devant `pg-app` ; branche l'API et les workers dessus. Laisse **volontairement** un composant (le Job de migration) se connecter en direct.
7. Déploie Redis (**sans** persistance) utilisé à la fois pour les sessions, les compteurs de quota et les verrous.
8. Ajoute des PDB cohérents.

### Partie 2 — Couper le cache

Prépare avant de couper : une session connectée dans le navigateur, un script qui appelle l'API en boucle (avec code HTTP et latence par requête), une ingestion en cours, un script qui vide la limite de rate d'une organisation de test.

Coupe Redis (scale à 0 en neutralisant ce qui le recrée, ou NetworkPolicy qui l'isole). Pendant 3 minutes, puis au retour, note :

| Observation | Pendant la coupure | Au retour |
|---|---|---|
| Session du navigateur | | |
| Nouveau login OIDC | | |
| Appels API (codes, latence) | | |
| Rate limit de l'organisation bloquée | | |
| Ingestion en cours (verrous) | | |
| Charge sur PostgreSQL (connexions, requêtes) | | |
| Premier message d'erreur, **dans quel composant** | | |

Refais-le avec la gouvernance en **fail-open** puis en **fail-closed** (étape 14). Écris en une phrase le symptôme applicatif de « cache coupé » pour chacun des deux modes.

### Partie 3 — Couper le pooler

Mêmes préparatifs. Coupe **les deux réplicas** du pooler.

| Observation | Pendant la coupure | Au retour |
|---|---|---|
| Appels API (codes, messages exacts) | | |
| Logins (l'IdP utilise `pg-idp`, pas ce pooler) | | |
| Ingestion | | |
| Job de migration (connecté en direct) | | |
| État de `pg-app` selon l'opérateur | | |
| Premier message d'erreur, dans quel composant | | |

Puis :

1. Remets **un seul** réplica du pooler et tue-le : même observation, et note « point unique de défaillance ».
2. Réduis `max_client_conn` du pooler sous le nombre de connexions demandées par les pods : relève **le message exact** et son émetteur.
3. Réduis `default_pool_size` à 2 et lance une requête applicative qui garde une transaction ouverte 30 s : observe l'attente (`SHOW POOLS`) et le message côté application.
4. Fais atteindre `max_connections` de PostgreSQL par des connexions **directes** (script qui ouvre des connexions sans les fermer) : relève le message, et montre avec `pg_stat_activity` qui les détient.
5. Rédige le tableau « émetteur → message → vraie cause » de 17.4 **avec tes propres messages**.

### Partie 4 — Bascule

1. Supprime le pod **primaire** de `pg-app` pendant le trafic.
2. Mesure : durée des erreurs, messages, quel pod est devenu primaire, le pooler a-t-il suivi ?
3. Classe cette rafale dans ta liste de faux positifs connus (étape 22), avec sa durée typique.
4. Draine le nœud qui porte le nouveau primaire : le PDB le permet-il ? Que fait l'opérateur ?

### Partie 5 — Sauvegarde et PITR, avec preuves

1. Vérifie les trois niveaux de 17.13 : statut de l'opérateur, objets datés dans le bucket, puis **restauration**.
2. Crée des données de test horodatées, note l'heure exacte (UTC), puis **supprime** une table ou des lignes.
3. Restaure `pg-app` **dans un nouveau cluster** à l'instant précédant la suppression. Mesure le temps. Vérifie les données.
4. Casse l'archivage (identifiants faux, ou CA retirée des pods de sauvegarde) : combien de temps avant que **quelque chose** le signale ? Où ? Que deviendrait le disque de WAL ?
5. Remplis la formulation honnête (tableau de fin de 17.13) pour `pg-app` **et** `pg-idp` (non sauvegardé : écris-le).

### Partie 6 — Sur l'environnement de preview (lecture seule)

1. Pour chaque brique de 17.2 : embarquée ou managée, technologie, version, nombre d'instances, nœuds et zones réels, PVC et StorageClass, PDB.
2. Bases : combien de clusters, quelles bases dans lesquels, qui passe par le pooler et qui contourne, mode de pooling.
3. Cache : usages mélangés ? persistance ? `maxmemory` et politique ?
4. Bus et moteur de workflows : persistance, rétention, lag actuel, taille de la base du moteur.
5. Sauvegardes : **constats datés uniquement**, pour chaque brique. Écris la phrase honnête de 17.13 pour chacune, y compris « aucune ».
6. Écarts preview → topologie cible.

**Livrable** : section « Plan de données » de `carte-plateforme-<version>.md` : tableau par brique (contenu, dépendants, embarquée/managée, instances et placement, symptôme de panne, bruit, sauvegarde constatée avec date, dernier test de restauration) ; tableau « too many connections » avec tes messages ; symptômes applicatifs mesurés de la coupure du cache et du pooler ; grille de qualification d'un service managé ; RPO/RTO et topologie cible à remplir avec le client.

---

## Validé si…

Tu peux expliquer à voix haute :

- ce que sont RPO et RTO, et pourquoi HA et sauvegarde ne se remplacent pas ;
- les avantages et coûts d'« une base par application », et les trois niveaux d'isolation ;
- pourquoi un `helm rollback` ne défait pas une migration ;
- à quoi sert un pooler, les modes de pooling, et ce que casse le mode transaction ;
- quatre émetteurs possibles de « too many connections » et comment identifier le bon ;
- le symptôme applicatif **mesuré** d'une coupure du cache, puis du pooler ;
- ce qu'un bus garantit (ou non), et pourquoi les consommateurs doivent être idempotents ;
- pourquoi la base du moteur de workflows grossit vite et pourquoi la restaurer est délicat ;
- pourquoi une panne de la base analytique est silencieuse et pourquoi elle se sauvegarde quand même ;
- comment une panne du stockage objet peut arrêter PostgreSQL des heures plus tard ;
- ce que contient etcd et ce qu'il ne contient pas, et qui le sauvegarde ;
- dix critères de qualification d'un service managé ;
- les différences entre une preview et une topologie de production, et les deux règles qui en découlent ;
- comment fonctionnent base backup + WAL + PITR, et comment on restaure (nouveau cluster) ;
- sept raisons pour lesquelles une sauvegarde configurée peut ne pas exister, et les trois niveaux de vérification ;
- la phrase honnête correspondant à chaque niveau de constat ;
- quatre pièges de topologie qui donnent l'illusion de la haute disponibilité.

**Étape suivante** : `etape-18-observabilite.md` — observabilité.
