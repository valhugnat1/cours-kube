# Étape 3 — Workloads avancés

**Objectif** : à la fin de cette étape, tu sais choisir le bon type de workload, lire et écrire le cycle de vie complet d'un pod (init containers, probes, arrêt), dimensionner ses ressources, et comprendre pourquoi un pod atterrit sur un nœud plutôt qu'un autre — ou n'atterrit nulle part.

**Prérequis** : étapes 1 et 2 faites.

Pourquoi cette étape est centrale pour toi : un chart parapluie de plateforme LLM mélange des dizaines de Deployments (API, UI, workers), des StatefulSets (bases, caches, bus), des Jobs (migrations), des DaemonSets (collecteurs de logs, GPU device plugin), avec des init containers qui attendent la base, des startup probes longues pour le chargement des modèles, et des contraintes de placement GPU. Tout ce qui est décrit ici, tu le verras dans les manifestes rendus par ton chart.

---

## 3.1 Choisir le bon type de workload

| Type | Pour quoi | Ce qui le caractérise | Exemples dans une plateforme LLM |
|---|---|---|---|
| **Deployment** | Applications *sans état* : n'importe quel réplica peut traiter n'importe quelle requête | Pods interchangeables, noms aléatoires, rolling update, scale libre | API, UI, gateway, workers de crawl, routeur de modèles |
| **StatefulSet** | Applications *avec état* : chaque réplica a une identité et un disque à lui | Noms stables (`db-0`, `db-1`), un PVC par pod qui le suit, démarrage et arrêt ordonnés, DNS individuel via un Service headless | PostgreSQL, Redis, Kafka, ClickHouse, etcd, MinIO |
| **DaemonSet** | *Un pod par nœud* (ou par nœud sélectionné) | Pas de `replicas` : le nombre suit les nœuds ; un nœud ajouté reçoit automatiquement son pod | Collecteur de logs, agent de métriques, CNI, NVIDIA device plugin, CSI node driver |
| **Job** | Une tâche qui *se termine* | Relance en cas d'échec jusqu'à `backoffLimit`, parallélisme possible, pod en `Completed` à la fin | Migration de schéma, import initial, hook Helm |
| **CronJob** | Un Job planifié | Syntaxe cron, `concurrencyPolicy`, historique des Jobs conservés | Nettoyage, sauvegarde, recalcul de statistiques |

Deux précisions qui évitent des erreurs classiques :

- Un StatefulSet **ne remplace pas** un pod tombé aussi vite qu'un Deployment : il attend que `db-0` soit vraiment parti avant de recréer `db-0`, pour ne jamais avoir deux instances avec la même identité et le même disque. C'est voulu.
- Un Job qui a échoué `backoffLimit` fois reste en `Failed` avec ses pods : c'est là que tu vas lire ses logs. Un Job en `Completed` dont tu supprimes le pod ne relance rien.

---

## 3.2 Le cycle de vie d'un pod, dans l'ordre

Un pod ne « démarre » pas d'un coup. Voici la séquence complète, et ce que tu peux brancher à chaque étape.

```
Scheduled ─▶ volumes montés ─▶ init containers (dans l'ordre, un par un)
        ─▶ conteneurs principaux démarrent ensemble
              ├─ postStart hook
              ├─ startupProbe  (jusqu'à succès)
              ├─ livenessProbe (en continu → échec = redémarrage du conteneur)
              └─ readinessProbe (en continu → échec = retiré du Service, pas redémarré)
        ─▶ … vie du pod …
        ─▶ suppression demandée
              ├─ pod retiré des endpoints du Service
              ├─ preStop hook
              ├─ SIGTERM au PID 1
              ├─ attente terminationGracePeriodSeconds (30 s par défaut)
              └─ SIGKILL
```

### Init containers
Des conteneurs qui tournent **avant** les principaux, **un par un**, et doivent **réussir** (code de sortie 0). Si l'un échoue, il est relancé ; les principaux ne démarrent jamais tant qu'ils ne sont pas tous passés. Le pod affiche `Init:0/2`, `Init:1/2`, ou `Init:Error` / `Init:CrashLoopBackOff`.

Usages typiques : attendre qu'une base réponde, exécuter une migration, télécharger un modèle, générer une config. Dans une plateforme LLM, **c'est la cause n° 1 de « ça met des minutes à démarrer »** : un init container de migration qui tourne pendant cinq minutes bloque toute l'application, et c'est normal (§15, distinguer « long » de « cassé »). Réflexe : `kubectl logs <pod> -c <nom-de-l-init>`.

```yaml
initContainers:
  - name: wait-db
    image: busybox:1.36
    command: ['sh', '-c', 'until nc -z db 5432; do echo waiting; sleep 2; done']
```

### Sidecars
Un conteneur auxiliaire qui vit à côté du principal (proxy, collecteur de logs, agent). Depuis Kubernetes 1.29, la façon propre est un init container avec `restartPolicy: Always` : il démarre avant les principaux, reste actif, et s'arrête après eux. Avant, un sidecar était juste un second conteneur dans `containers`, avec les problèmes d'ordre que ça pose (Job qui ne se termine jamais parce que le sidecar tourne encore).

### Les trois probes
C'est le point le plus mal compris de Kubernetes, et le plus important pour la stabilité d'une plateforme.

| Probe | Question posée | Si elle échoue | Erreur classique |
|---|---|---|---|
| **startupProbe** | « L'application a-t-elle fini de démarrer ? » | Rien tant que `failureThreshold × periodSeconds` n'est pas atteint ; ensuite redémarrage. Les deux autres probes sont **désactivées** tant qu'elle n'a pas réussi | L'oublier sur une app lente à démarrer → la liveness tue le conteneur avant qu'il ait fini → CrashLoopBackOff perpétuel |
| **livenessProbe** | « L'application est-elle vivante ou bloquée ? » | Redémarrage du conteneur | La brancher sur une dépendance (base, API tierce) → une base lente redémarre en boucle toute la plateforme |
| **readinessProbe** | « Peut-elle recevoir du trafic maintenant ? » | Le pod est retiré des endpoints du Service (colonne `READY 0/1`), **sans redémarrage** | La confondre avec la liveness ; ou l'omettre → du trafic arrive sur un pod pas prêt → 502/503 pendant les déploiements |

La règle d'or : **liveness = « mon processus est-il bloqué ? » (jamais de dépendance externe) ; readiness = « suis-je capable de servir ? » (dépendances incluses) ; startup = « laissez-moi le temps »**.

Trois types de probe : `httpGet` (code 2xx/3xx = succès), `tcpSocket` (port ouvert = succès), `exec` (commande avec code 0 = succès). Paramètres : `initialDelaySeconds`, `periodSeconds`, `timeoutSeconds`, `failureThreshold`, `successThreshold`.

Cas LLM : un serveur d'inférence charge un modèle de plusieurs dizaines de Go. Sans startup probe généreuse (`failureThreshold: 60, periodSeconds: 10` = 10 minutes), il est tué avant d'avoir fini. On y revient à l'étape 15.

```yaml
containers:
  - name: api
    image: myapi:1.4
    startupProbe:
      httpGet: { path: /healthz, port: 8000 }
      failureThreshold: 30
      periodSeconds: 5
    livenessProbe:
      httpGet: { path: /healthz, port: 8000 }
      periodSeconds: 10
    readinessProbe:
      httpGet: { path: /ready, port: 8000 }
      periodSeconds: 5
```

### L'arrêt propre
À la suppression, le pod est d'abord retiré du Service, puis reçoit `SIGTERM`. Si le processus ne s'arrête pas dans `terminationGracePeriodSeconds`, il est tué. Deux conséquences :

- Une application qui ignore `SIGTERM` (ou dont le PID 1 est un `sh -c` qui ne transmet pas les signaux — étape 0.1) met 30 s à s'arrêter à chaque déploiement, et coupe des requêtes en cours.
- Un `preStop` hook (`sleep 5`, par exemple) laisse le temps à la propagation du retrait des endpoints avant que le processus ne s'arrête : ça évite les erreurs 502 pendant les rolling updates.

### restartPolicy
`Always` (défaut, Deployments), `OnFailure` ou `Never` (Jobs). Le **backoff** de redémarrage double à chaque échec (10 s, 20 s, 40 s… jusqu'à 5 min) : c'est ce que signifie le « BackOff » de `CrashLoopBackOff`. Le compteur se réinitialise après 10 minutes de fonctionnement sans crash.

---

## 3.3 Ressources : requests, limits, QoS

```yaml
resources:
  requests:
    cpu: 500m        # 0,5 cœur — sert au SCHEDULING et au partage garanti
    memory: 512Mi
  limits:
    cpu: "2"         # plafond : au-delà, le conteneur est ralenti (throttling)
    memory: 1Gi      # plafond : au-delà, le conteneur est TUÉ (OOMKilled)
```

**Requests** : ce que le scheduler réserve sur le nœud. Un pod dont la somme des requests ne tient sur aucun nœud reste `Pending` avec `FailedScheduling: Insufficient cpu/memory`. C'est aussi la part garantie en cas de contention.

**Limits** : le plafond appliqué par le cgroup (étape 0.1). La CPU est *compressible* : dépasser la limite ralentit, ne tue pas. La mémoire est *incompressible* : dépasser tue, et le pod affiche `OOMKilled` dans `Last State`, avec `RESTARTS` qui augmente.

**Les classes de QoS**, déduites automatiquement, décident qui est expulsé en premier quand un nœud manque de mémoire :

| Classe | Condition | En cas de pression mémoire |
|---|---|---|
| `Guaranteed` | requests = limits pour CPU et mémoire, sur tous les conteneurs | Expulsé en dernier |
| `Burstable` | au moins une request, mais pas Guaranteed | Expulsé après les BestEffort |
| `BestEffort` | ni requests ni limits | Expulsé en premier |

Sur un cluster client, des pods `BestEffort` sont un signal d'alarme : ils seront les premières victimes d'une éviction, et ils faussent le scheduling puisqu'ils ne réservent rien. Les bases de données d'une plateforme sont typiquement `Guaranteed`.

**Éviction** : quand le kubelet détecte que le nœud manque de mémoire ou de disque, il expulse des pods (statut `Evicted`) par ordre de QoS. Le pod expulsé n'est pas redémarré sur place ; le contrôleur en recrée un ailleurs. Des pods `Evicted` qui s'accumulent = un nœud sous-dimensionné.

**Le point piège** : `kubectl top pod` montre la consommation réelle ; `describe node` montre les *requests* allouées. Un nœud peut être « plein » au sens du scheduler (requests à 100 %) tout en étant presque inactif, et inversement. Les deux vues sont nécessaires.

**Ressources étendues** : `nvidia.com/gpu: 1` se met en `limits` (et implicitement en requests) ; un GPU ne se partage pas par défaut. Étape 15.

---

## 3.4 Scheduling : pourquoi ce pod atterrit là

Le scheduler filtre les nœuds possibles, puis les note. Tu influences les deux avec cinq mécanismes.

### nodeSelector
Le plus simple : le pod ne va que sur les nœuds portant ces labels.
```yaml
nodeSelector:
  nvidia.com/gpu.present: "true"
```

### Affinité et anti-affinité
Plus expressif, avec `required` (contrainte dure : sinon `Pending`) ou `preferred` (souhait pondéré).

- **nodeAffinity** : comme nodeSelector mais avec opérateurs (`In`, `NotIn`, `Exists`, `Gt`…).
- **podAffinity** : « place-moi près des pods qui ont tel label » (ex. : le cache près de l'API).
- **podAntiAffinity** : « ne me place **pas** avec les pods qui ont tel label » — c'est ce qui garantit que 3 réplicas d'une base sont sur 3 nœuds différents. Indispensable pour la haute disponibilité (§10).

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels: { app: db }
        topologyKey: kubernetes.io/hostname   # « un par nœud »
```

Le nom à rallonge `requiredDuringSchedulingIgnoredDuringExecution` dit exactement ce qu'il fait : contrainte appliquée au placement, pas réévaluée ensuite.

Piège fréquent chez les clients : un chart avec anti-affinité `required` sur 3 réplicas, déployé sur un cluster à 2 nœuds → le troisième pod reste `Pending` pour toujours. Le message `FailedScheduling: didn't match pod anti-affinity rules` le dit, mais il faut le lire.

### Taints et tolerations
L'inverse de l'affinité : c'est le **nœud** qui repousse. Un nœud « tainted » n'accepte que les pods qui « tolèrent » la taint.

```bash
kubectl taint nodes gpu-1 nvidia.com/gpu=present:NoSchedule
```
```yaml
tolerations:
  - key: nvidia.com/gpu
    operator: Exists
    effect: NoSchedule
```

Effets : `NoSchedule` (pas de nouveau pod), `PreferNoSchedule` (éviter), `NoExecute` (expulse aussi les pods déjà présents). Usage canonique : réserver les nœuds GPU (chers) aux workloads GPU. Les nœuds du control plane sont tainted par défaut. Kubernetes pose aussi des taints automatiques (`node.kubernetes.io/not-ready`, `…/unreachable`) qui expulsent les pods d'un nœud en panne après `tolerationSeconds` (300 s par défaut).

Une **toleration ne force pas** le placement sur le nœud tainted, elle l'autorise. Pour *forcer*, il faut toleration **+** nodeSelector/affinity. Les charts GPU font toujours les deux.

### Topology spread constraints
Répartir uniformément les réplicas sur un domaine (zones, nœuds), avec un écart maximal toléré. Plus souple que l'anti-affinité pour beaucoup de réplicas.
```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels: { app: api }
```

### Priorité et préemption
Une `PriorityClass` donne un rang au pod. Quand le cluster est plein, un pod de haute priorité peut **expulser** des pods de priorité inférieure pour se faire une place. Utile pour garantir que les composants critiques (gateway, base) passent avant les workers. Les composants système utilisent `system-cluster-critical`.

---

## 3.5 Résilience : rolling update, PDB, autoscaling

### Stratégies de mise à jour
Un Deployment a une `strategy` :
- `RollingUpdate` (défaut) avec `maxSurge` (pods en plus autorisés pendant la transition, défaut 25 %) et `maxUnavailable` (pods en moins tolérés, défaut 25 %). `maxSurge: 1, maxUnavailable: 0` = jamais moins de capacité que prévu, un pod de plus pendant le déploiement.
- `Recreate` : tout couper, puis tout relancer. Pour ce qui ne supporte pas deux versions en parallèle (ou un volume `ReadWriteOnce` qu'un seul pod peut monter — étape 5).

Un StatefulSet fait ses mises à jour **dans l'ordre inverse** (`db-2` d'abord, `db-0` en dernier) et attend que chaque pod soit `Ready` avant de passer au suivant. `partition` permet de ne mettre à jour que les pods d'index ≥ N (canari).

### PodDisruptionBudget
Un PDB dit combien de pods d'un groupe doivent rester disponibles pendant une **perturbation volontaire** : vidage d'un nœud (`kubectl drain`) pour une mise à jour de cluster, autoscaler qui retire un nœud, etc.
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: db }
spec:
  minAvailable: 2          # ou maxUnavailable: 1
  selector:
    matchLabels: { app: db }
```
Sans PDB, une mise à jour de cluster chez un client peut vider un nœud qui porte les 3 réplicas de la base d'un coup. Avec un PDB trop strict (`minAvailable: 3` pour 3 réplicas), le nœud ne peut **jamais** être vidé et la mise à jour se bloque — c'est un piège tout aussi réel. Un PDB ne protège pas contre les perturbations involontaires (panne matérielle).

### HPA et VPA
- **HPA** (vu à l'étape 2) : ajuste `replicas` selon CPU, mémoire ou métriques custom. Nécessite des `requests` et metrics-server.
- **VPA** : ajuste les `requests` d'un pod selon sa consommation observée. Utile en mode `Off` (recommandation seulement) pour dimensionner une plateforme sur un cluster client sans deviner. Ne pas combiner HPA et VPA sur la même métrique.
- **Cluster Autoscaler / Karpenter** : ajoute des *nœuds* quand des pods restent `Pending` par manque de ressources. C'est pourquoi un déploiement sur GKE commence par une vague de `Pending` qui se résorbe en quelques minutes (§15).

---

## 3.6 Exercice — clavier en main

```bash
kubectl config current-context && kubectl create namespace lab3 && kubens lab3
```

1. **Un pod avec init container bloquant.** Écris `app.yaml` : un Deployment `app` (image `nginx:1.27`, 1 réplica) avec un init container `wait-db` qui fait `until nc -z db 5432` (section 3.2), des `requests` CPU 100m / mémoire 64Mi, une readiness `httpGet /` port 80 et une liveness identique. Applique, puis :
   ```bash
   kubectl get pods -w            # reste en Init:0/1
   kubectl logs deploy/app -c wait-db --tail=3
   kubectl describe pod -l app=app | tail -20
   ```
   Lis les Events : rien d'anormal n'y figure — un init container qui attend n'est pas une erreur. C'est le cas « long, pas cassé ».

2. **Débloque-le** en créant ce qu'il attend : un Service `db` sur le port 5432 ciblant un Deployment `db` avec l'image `postgres:16` et `env: POSTGRES_PASSWORD=lab`. Observe le pod `app` passer `Init:0/1` → `PodInitializing` → `Running 1/1`.

3. **CrashLoopBackOff volontaire.** Change la commande du conteneur `app` : `command: ["sh", "-c", "sleep 5; exit 1"]`. Applique, et suis :
   ```bash
   kubectl get pods -w            # Running → Error → CrashLoopBackOff, RESTARTS qui monte
   kubectl describe pod -l app=app | grep -A3 'Last State'
   kubectl logs -l app=app --previous
   ```
   Note comment le délai entre deux redémarrages s'allonge (Events : `Back-off restarting failed container`).

4. **Readiness qui échoue sans crash.** Remets nginx, mais mets la readiness sur `path: /nexistepas`. Applique :
   ```bash
   kubectl get pods               # Running 0/1, RESTARTS = 0
   kubectl get endpoints app      # aucune adresse : le Service ne route plus vers ce pod
   ```
   Puis change la **liveness** (pas la readiness) sur `/nexistepas` : cette fois le conteneur redémarre en boucle. C'est la différence entre les deux probes, vécue.

5. **OOMKilled.** Un Deployment `hog` avec `image: polinux/stress`, `command: ["stress", "--vm", "1", "--vm-bytes", "200M", "--vm-hang", "0"]` et `limits.memory: 100Mi`. Applique :
   ```bash
   kubectl get pods -w
   kubectl describe pod -l app=hog | grep -B2 -A2 OOMKilled
   ```

6. **Pending pour ressources.** Un Deployment `big` avec `requests.cpu: "64"`. Applique, puis lis le motif exact dans `describe` (`Insufficient cpu`). Supprime-le.

7. **Pending pour taint.** Taint ton unique nœud, relance un pod, observe, tolère, observe, retire la taint :
   ```bash
   kubectl taint nodes lab-control-plane team=gpu:NoSchedule
   kubectl rollout restart deploy/app && kubectl get pods -w        # nouveau pod Pending
   kubectl describe pod -l app=app | grep -A2 FailedScheduling       # « untolerated taint »
   # ajoute la toleration au Deployment app, applique → il démarre
   kubectl taint nodes lab-control-plane team-                        # retire la taint
   ```

8. **Anti-affinité impossible.** Passe `app` à 2 réplicas avec une `podAntiAffinity` `required` sur `kubernetes.io/hostname`. Sur ton cluster à un nœud, le second pod reste `Pending` : lis le message. Passe en `preferred` : il démarre.

9. **Rolling update contrôlé.** Mets `strategy.rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }` sur `app` à 2 réplicas, retire l'anti-affinité, applique, puis change le tag nginx et regarde `kubectl get pods -w` : à aucun moment il n'y a moins de 2 pods `Ready`.

10. **StatefulSet.** Remplace le Deployment `db` par un StatefulSet à 2 réplicas avec un `volumeClaimTemplates` de 1Gi et un Service headless (`clusterIP: None`). Observe les noms `db-0`, `db-1`, les PVC `data-db-0`, `data-db-1`, et le démarrage séquentiel. Supprime `db-0` : il revient **avec le même nom et le même PVC**.

11. **Job.** Un Job `migrate` avec `image: busybox:1.36`, `command: ["sh", "-c", "echo migrating; sleep 10; exit 0"]`, `backoffLimit: 2`. Observe `Completed`. Change `exit 0` en `exit 1`, réapplique sous un autre nom : compte les tentatives et lis l'état final.

12. **Nettoie** : `kubectl delete namespace lab3`. Les PVC du StatefulSet partent avec le namespace ; sur un cluster réel, vérifie que les PV associés sont bien libérés (étape 5).

---

## Validé si…

- Tu sais dire en une phrase pourquoi une base est un StatefulSet et une API un Deployment.
- Tu sais distinguer, à la lecture de `kubectl get pods`, un init container qui attend, un crash en boucle, une readiness en échec et un OOMKilled — et quelle commande lancer pour chacun.
- Tu sais expliquer pourquoi brancher une liveness probe sur la base de données est une mauvaise idée.
- Tu sais lire un `FailedScheduling` et dire s'il s'agit de ressources, de taint ou d'affinité.
- Tu sais ce qu'un PDB protège, et comment il peut bloquer une mise à jour de cluster.

**Étape suivante** : `etape-04-reseau-kubernetes.md` — CNI, Services, DNS, Ingress, NetworkPolicy.
