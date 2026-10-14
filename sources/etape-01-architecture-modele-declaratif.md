# Étape 1 — Architecture et modèle déclaratif

**Objectif** : à la fin de cette étape, tu sais ce qui se passe *réellement* entre le moment où tu tapes `kubectl apply` et le moment où un conteneur tourne sur un nœud. Tu connais les objets de base, tu lis un manifeste sans hésiter, et tu as le réflexe `describe` / `logs` / `explain`.

**Prérequis** : étape 0 faite, cluster `kind` nommé `lab` disponible.

---

## 1.1 L'idée centrale : Kubernetes est une base de données avec des robots autour

Oublie l'image d'un « orchestrateur qui lance des conteneurs ». Le modèle mental juste est celui-ci :

1. Il y a une **base de données** (etcd) qui contient des objets décrivant un **état désiré** : « je veux 3 réplicas de cette image ».
2. Il y a une **API** (l'API server) qui est la seule porte d'entrée pour lire ou écrire ces objets. `kubectl` ne fait rien d'autre que des appels HTTP à cette API.
3. Il y a des **contrôleurs**, des boucles infinies qui comparent en permanence l'état désiré à l'état observé, et agissent pour combler l'écart. C'est la **réconciliation**.

Conséquence fondamentale : **tu ne demandes jamais à Kubernetes de *faire* quelque chose, tu lui décris ce que tu veux *obtenir*.** Si tu supprimes un pod géré par un Deployment, le contrôleur constate qu'il manque un pod et en recrée un. Ce n'est pas un bug, c'est le système qui fonctionne. L'étape 2 est entièrement consacrée aux conséquences de ça.

---

## 1.2 Le control plane : les composants qui décident

Le **control plane** est l'ensemble des composants qui gèrent le cluster. Sur ton cluster kind ils tournent tous sur le nœud unique ; chez un client ils sont sur des nœuds dédiés (ou gérés par le cloud, comme sur GKE où tu ne les vois même pas).

| Composant | Rôle | Ce qui se passe s'il tombe |
|---|---|---|
| **kube-apiserver** | La porte d'entrée. Valide, authentifie, autorise chaque requête, puis lit/écrit dans etcd. | Plus rien ne bouge : ni `kubectl`, ni les contrôleurs. Les pods déjà lancés continuent de tourner. |
| **etcd** | La base de données clé-valeur qui stocke *tout* l'état du cluster. | Idem, et si les données sont perdues, le cluster est perdu (d'où les sauvegardes, §10). |
| **kube-scheduler** | Pour chaque pod sans nœud assigné, choisit un nœud selon les ressources, contraintes, affinités. | Les nouveaux pods restent en `Pending` pour toujours. |
| **kube-controller-manager** | Héberge les contrôleurs intégrés : Deployment, ReplicaSet, Node, Job, ServiceAccount… | L'état désiré n'est plus réconcilié : rien ne se répare, rien ne scale. |
| **cloud-controller-manager** | Sur un cloud, fait le lien avec le fournisseur : crée les LoadBalancers, attache les disques, étiquette les nœuds. | Un `Service` de type LoadBalancer reste en `<pending>` sans IP externe. |

Le point important : **l'API server est le seul composant qui parle à etcd.** Tous les autres (scheduler, contrôleurs, kubelets) parlent à l'API server. C'est ce qui rend le système extensible : un opérateur (étape 9) n'est qu'un contrôleur de plus qui regarde l'API.

---

## 1.3 Les nœuds : les composants qui exécutent

Un **nœud** est une machine (VM ou physique) qui fait tourner des pods. Sur chaque nœud :

| Composant | Rôle |
|---|---|
| **kubelet** | L'agent du nœud. Il surveille l'API server, et pour chaque pod assigné à *son* nœud, demande au runtime de lancer les conteneurs, exécute les probes, remonte l'état du pod. |
| **container runtime** | containerd (le plus courant) ou CRI-O. Télécharge les images, crée les conteneurs. Docker n'est plus utilisé comme runtime depuis Kubernetes 1.24 ; les images restent les mêmes. |
| **kube-proxy** | Configure les règles réseau du nœud (iptables ou IPVS) pour que l'IP d'un `Service` redirige vers les pods. Certains CNI comme Cilium le remplacent. |

Le kubelet ne prend aucune décision d'orchestration. Il exécute ce que l'API server lui dit pour son nœud. Si l'API server est injoignable, le kubelet continue de faire tourner ce qu'il a déjà, mais ne reçoit plus de nouvelles instructions.

---

## 1.4 Le trajet complet d'un `kubectl apply`

C'est LE schéma à avoir en tête. Tu appliques un Deployment demandant 2 réplicas :

```
kubectl apply -f deploy.yaml
      │
      ▼
 kube-apiserver ──(valide, autorise, écrit)──▶ etcd : objet Deployment
      │
      ▼  le Deployment controller voit un nouveau Deployment
 Deployment controller ──▶ crée un objet ReplicaSet (replicas: 2)
      │
      ▼  le ReplicaSet controller voit un ReplicaSet à 2 et 0 pod
 ReplicaSet controller ──▶ crée 2 objets Pod (sans nœud assigné)
      │
      ▼  le scheduler voit 2 pods sans nodeName
 kube-scheduler ──▶ écrit nodeName sur chaque pod
      │
      ▼  le kubelet du nœud voit un pod qui lui est assigné
 kubelet ──▶ demande à containerd de tirer l'image et lancer le conteneur
      │
      ▼
 kubelet ──▶ remonte le status du pod (Running, Ready…) à l'API server
```

Chaque flèche est un contrôleur indépendant qui ne connaît que l'API. Personne ne « pilote » l'ensemble. Quand tu diagnostiques un pod qui ne démarre pas, tu remontes cette chaîne : le pod existe-t-il ? a-t-il un nœud ? le kubelet a-t-il pu tirer l'image ? Le champ `status` et les événements (`describe`) te disent à quelle étape ça bloque.

---

## 1.5 Anatomie d'un objet

Tout objet Kubernetes a la même forme :

```yaml
apiVersion: apps/v1          # groupe/version de l'API qui définit ce type
kind: Deployment             # le type d'objet
metadata:                    # identité : nom, namespace, labels, annotations
  name: web
  namespace: default
  labels:
    app: web
spec:                        # l'ÉTAT DÉSIRÉ — ce que tu écris
  replicas: 2
  ...
status:                      # l'ÉTAT OBSERVÉ — ce que les contrôleurs écrivent
  readyReplicas: 2
  ...
```

- `spec` t'appartient. `status` appartient aux contrôleurs — tu ne l'écris jamais.
- `apiVersion` : `v1` pour les objets de base (Pod, Service, ConfigMap…), `apps/v1` pour Deployment/StatefulSet/DaemonSet, `batch/v1` pour Job/CronJob, `networking.k8s.io/v1` pour Ingress. Quand un client a un vieux cluster, ce sont ces versions qui posent des problèmes de compatibilité (étape 10).
- `kubectl explain deployment.spec.strategy` te donne la documentation de n'importe quel champ, directement depuis le cluster, pour la version réellement installée. C'est plus fiable que la doc en ligne.

---

## 1.6 Les objets de base

### Pod
La plus petite unité déployable : un ou plusieurs conteneurs qui partagent la même IP, le même réseau et les mêmes volumes. Dans 95 % des cas, un pod = un conteneur (+ éventuellement des *sidecars* ou des *init containers*). Un pod est **mortel** : il a une IP éphémère, il ne se déplace jamais d'un nœud à l'autre, et quand il meurt, on en crée un autre. **Tu ne crées presque jamais un pod à la main** ; tu le fais via un Deployment.

### ReplicaSet
Maintient N copies identiques d'un pod. Tu ne le manipules jamais directement : c'est le Deployment qui les crée.

### Deployment
L'objet que tu utilises vraiment pour une application sans état. Il gère des ReplicaSets pour permettre les mises à jour progressives : quand tu changes l'image, le Deployment crée un *nouveau* ReplicaSet, le monte progressivement, et descend l'ancien. C'est ce qui permet le `rollback`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web              # « mes pods sont ceux qui ont ce label »
  template:                 # le modèle de pod à créer
    metadata:
      labels:
        app: web            # doit correspondre au selector
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - containerPort: 80
```

### Service
Un pod a une IP éphémère ; un **Service** donne une IP et un nom DNS **stables** devant un groupe de pods sélectionnés par labels. Le trafic arrivant sur le Service est réparti entre les pods `Ready`.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web                # cible les pods avec ce label
  ports:
    - port: 80              # port du Service
      targetPort: 80        # port du conteneur
```

Depuis n'importe quel pod du cluster, `http://web` (même namespace) ou `http://web.default.svc.cluster.local` joint ces pods. Les types de Service (ClusterIP, NodePort, LoadBalancer) sont détaillés à l'étape 4.

### Namespace
Une partition logique du cluster : les noms d'objets sont uniques *dans* un namespace. Sert à séparer les applications, appliquer des quotas, des droits (RBAC), des politiques réseau. Une plateforme LLM chez un client occupera typiquement plusieurs namespaces (un par plan ou par famille de composants). Le namespace par défaut s'appelle `default` ; les composants système sont dans `kube-system`.

### ConfigMap et Secret
Deux objets pour sortir la configuration de l'image. Un **ConfigMap** contient des paires clé/valeur en clair (toutes les valeurs sont des chaînes, cf. étape 0.4). Un **Secret** a exactement la même forme, mais les valeurs sont encodées en base64 (ce qui n'est **pas** du chiffrement — un Secret est protégé par le RBAC, pas par l'encodage). Les deux se consomment soit en variables d'environnement, soit montés comme fichiers. Détails à l'étape 6.

### Labels, selectors, annotations
- **Labels** : des paires clé/valeur sur `metadata.labels`, faites pour être *sélectionnées*. C'est le seul mécanisme qui relie un Deployment à ses pods, un Service à ses pods, une NetworkPolicy à ses cibles. `kubectl get pods -l app=web`.
- **Annotations** : des paires clé/valeur sur `metadata.annotations`, faites pour porter de la *métadonnée* non sélectionnable (config d'un ingress controller, checksum d'un ConfigMap, info d'outillage). Helm et ArgoCD en mettent partout.

Convention Helm à reconnaître dès maintenant : `app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app.kubernetes.io/component`. Sur un cluster client, filtrer par `app.kubernetes.io/instance=<release>` te donne tout ce qu'une release Helm a créé.

---

## 1.7 kubectl : les commandes qui font 90 % du travail

### Se repérer
```bash
kubectl config get-contexts          # les clusters connus et l'actif (*)
kubectl config current-context       # à vérifier AVANT toute commande destructive
kubectl config use-context kind-lab  # changer de cluster (ou : kubectx kind-lab)
kubectl config set-context --current --namespace=monns   # namespace par défaut (ou : kubens monns)
```

Le fichier `~/.kube/config` (ou la variable `KUBECONFIG`) contient les clusters, les identités et les contextes. Chez les clients tu en manipuleras plusieurs ; un contexte actif erroné est la façon la plus classique de casser quelque chose en production.

### Lire
```bash
kubectl get pods                       # tableau
kubectl get pods -A                    # tous les namespaces
kubectl get pods -o wide               # + nœud, IP
kubectl get pods -l app=web            # filtre par label
kubectl get pods -w                    # watch : voit les changements en direct
kubectl get deploy web -o yaml         # l'objet complet, spec ET status
kubectl describe pod web-abc123        # état lisible + ÉVÉNEMENTS en bas
kubectl get events --sort-by=.lastTimestamp
kubectl explain pod.spec.containers    # doc du champ
```

`describe` est ton premier réflexe sur un pod qui va mal : la section **Events** en bas raconte ce que le scheduler, le kubelet et le runtime ont essayé de faire et pourquoi ça a échoué (`FailedScheduling`, `ErrImagePull`, `Unhealthy`…).

### Entrer dans un pod
```bash
kubectl logs web-abc123                # logs du conteneur
kubectl logs web-abc123 -f             # suivre en direct
kubectl logs web-abc123 --previous     # logs de l'instance PRÉCÉDENTE (crash)
kubectl logs web-abc123 -c init-db     # un conteneur précis (init ou sidecar)
kubectl logs deploy/web                # un pod au hasard du Deployment
kubectl exec -it web-abc123 -- sh      # shell dans le conteneur
kubectl port-forward svc/web 8080:80   # joindre le Service depuis ta machine sur :8080
```

`--previous` est capital : sur un pod en `CrashLoopBackOff`, les logs de l'instance courante sont souvent vides parce qu'elle vient de redémarrer ; l'erreur est dans l'instance d'avant.

### Écrire
```bash
kubectl apply -f deploy.yaml           # déclaratif : crée ou met à jour
kubectl diff -f deploy.yaml            # ce qui changerait, sans appliquer
kubectl apply --dry-run=server -f x.yaml   # validation par l'API server, sans écrire
kubectl delete -f deploy.yaml
kubectl rollout status deploy/web      # attend la fin d'un déploiement
kubectl rollout history deploy/web
kubectl rollout undo deploy/web        # retour à la révision précédente
```

**Impératif vs déclaratif.** `kubectl create deployment web --image=nginx` ou `kubectl scale --replicas=3` sont des commandes *impératives* : pratiques pour tester, mais elles ne laissent aucune trace dans un fichier. En contexte client, **tout passe par des fichiers versionnés** (Helm, étape 7) : une modification impérative sera écrasée au prochain déploiement. C'est la distinction « correction ponctuelle vs durable » de l'étape 2.

### Astuces
- `-o yaml` sur n'importe quel objet pour voir la vérité (y compris les valeurs par défaut que tu n'as pas écrites).
- `-o jsonpath='{.status.podIP}'` ou `-o json | jq` pour extraire un champ.
- Les raccourcis de types : `po`, `deploy`, `svc`, `ns`, `cm`, `rs`, `sts`, `ds`, `ing`. `kubectl api-resources` les liste tous — c'est aussi la commande pour voir quels types (dont les CRDs) existent sur un cluster client.

---

## 1.8 Lire le statut d'un pod

La colonne `STATUS` de `kubectl get pods` condense beaucoup d'information. Les valeurs que tu verras tout le temps :

| Statut | Signification | Où regarder |
|---|---|---|
| `Pending` | Pas encore planifié, ou image en cours de téléchargement | `describe` → Events (`FailedScheduling` ? ressources insuffisantes ? volume manquant ?) |
| `ContainerCreating` | Le kubelet prépare le conteneur (volumes, réseau, image) | Normal quelques secondes ; au-delà, `describe` |
| `Init:0/1` | Un init container tourne encore | `logs -c <init>` |
| `Running` | Au moins un conteneur tourne | Vérifie aussi `READY` (ex. `0/1` = tourne mais readiness probe en échec) |
| `CrashLoopBackOff` | Le conteneur démarre, meurt, et Kubernetes attend de plus en plus longtemps avant de réessayer | `logs --previous` |
| `ImagePullBackOff` / `ErrImagePull` | Image introuvable ou accès refusé au registre | `describe` → Events (nom, tag, secret de registre) |
| `OOMKilled` (dans `describe`, Last State) | Tué pour dépassement de la limite mémoire | Augmenter la limite ou corriger l'app |
| `Completed` | Un Job a terminé | Normal |
| `Terminating` | En cours de suppression | Bloqué ? souvent un finalizer (étape 2) |

Les colonnes `READY` (`1/1`), `RESTARTS` et `AGE` complètent le tableau : un pod `Running 1/1` avec 47 restarts n'est pas sain. La méthode complète de diagnostic est à l'étape 20 ; ici, il s'agit juste de reconnaître les mots.

---

## 1.9 Exercice — clavier en main

Travaille dans un namespace dédié pour prendre l'habitude.

1. **Prépare le terrain** :
   ```bash
   kubectl config current-context           # doit être kind-lab
   kubectl create namespace lab1
   kubens lab1                              # ou : kubectl config set-context --current --namespace=lab1
   ```

2. **Écris le manifeste** `web.yaml` avec le Deployment et le Service de la section 1.6 (les deux dans le même fichier, séparés par `---`), puis :
   ```bash
   kubectl diff -f web.yaml                 # tout est « à créer »
   kubectl apply -f web.yaml
   kubectl get deploy,rs,pods,svc           # observe la chaîne Deployment → ReplicaSet → Pods
   ```

3. **Suis la réconciliation en direct.** Dans un premier terminal, `kubectl get pods -w`. Dans un second :
   ```bash
   kubectl delete pod -l app=web            # supprime les 2 pods
   ```
   Regarde le premier terminal : les pods passent en `Terminating`, et 2 nouveaux apparaissent aussitôt. Tu n'as rien demandé — le ReplicaSet controller a comblé l'écart.

4. **Vérifie que le Service suit.** Note que les nouveaux pods ont de nouvelles IPs (`-o wide`), mais que le Service, lui, n'a pas bougé :
   ```bash
   kubectl port-forward svc/web 8080:80
   curl -i http://localhost:8080            # 200 OK, page nginx
   ```

5. **Fais une mise à jour progressive.** Change `nginx:1.27` en `nginx:1.26` dans `web.yaml`, puis :
   ```bash
   kubectl diff -f web.yaml                 # une seule ligne change
   kubectl apply -f web.yaml
   kubectl rollout status deploy/web
   kubectl get rs                           # deux ReplicaSets : l'ancien à 0, le nouveau à 2
   kubectl rollout history deploy/web
   kubectl rollout undo deploy/web          # retour à 1.27
   ```

6. **Casse-le et lis les événements.** Mets `image: nginx:1.27-nexistepas`, applique, puis :
   ```bash
   kubectl get pods                         # un pod ImagePullBackOff… mais les anciens sont toujours là
   kubectl describe pod <le pod en erreur>  # lis les Events jusqu'à la ligne « not found »
   ```
   Remarque : le Deployment n'a **pas** supprimé les anciens pods sains. Une mise à jour progressive protège de ce genre d'erreur. Remets `nginx:1.27` et applique.

7. **Explore la vérité de l'API** :
   ```bash
   kubectl get deploy web -o yaml | less    # repère spec vs status, et les défauts ajoutés (strategy, progressDeadlineSeconds…)
   kubectl explain deployment.spec.strategy.rollingUpdate
   ```

8. **Nettoie** : `kubectl delete namespace lab1` — et observe que tout ce qu'il contenait disparaît avec lui (suppression en cascade, étape 2).

---

## Validé si…

Tu peux, sans regarder :

- dessiner le trajet d'un `kubectl apply` de Deployment jusqu'au conteneur, avec les 5 acteurs (API server, Deployment controller, ReplicaSet controller, scheduler, kubelet) ;
- expliquer pourquoi supprimer un pod « ne marche pas » et ce qu'il faudrait faire à la place ;
- dire à quoi sert un Service alors que les pods ont déjà une IP ;
- citer la différence entre `spec` et `status`, et entre label et annotation ;
- donner la commande pour lire les logs d'un conteneur qui vient de crasher.

**Étape suivante** : `etape-02-controleurs-ownership-actions-destructives.md` — pourquoi Kubernetes annule ce que tu fais à la main, et comment agir correctement.
