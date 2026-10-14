# Partie A — Socle Kubernetes : résumé et take-aways

Récap des étapes 0 à 6. À relire avant un déploiement, ou quand un symptôme te laisse sans idée.

---

## Les 10 idées à garder en tête

1. **Un conteneur est un processus Linux** isolé par des namespaces et limité par des cgroups. `OOMKilled` = le noyau a tué le processus pour dépassement de sa limite mémoire. Rien de magique.
2. **Kubernetes est une base de données (etcd) avec des contrôleurs autour.** Tu décris un état désiré, des boucles infinies comblent l'écart. Tu ne demandes jamais une action, tu déclares un résultat.
3. **L'API server est la seule porte.** `kubectl`, le scheduler, le kubelet, les opérateurs : tout le monde passe par lui. Diagnostiquer = remonter la chaîne apply → controller → scheduler → kubelet → runtime.
4. **Tout objet a un propriétaire.** `ownerReferences` → ReplicaSet → Deployment → chart Helm → fichier versionné → humain. On agit au premier échelon qui est un fichier ou une personne. Une modif `kubectl` sur un objet géré est ponctuelle par construction.
5. **Les probes ne sont pas interchangeables.** Liveness = « suis-je bloqué ? » (jamais de dépendance externe) ; readiness = « puis-je servir ? » (retire du Service, ne redémarre pas) ; startup = « laissez-moi le temps ». Une liveness sur la base de données fait redémarrer toute la plateforme quand la base ralentit.
6. **Requests servent au scheduling, limits à la protection.** Pas de requests = `BestEffort` = premier expulsé. Un nœud « plein » au sens du scheduler peut être vide en réalité (`describe node` vs `top`).
7. **Un Service ne route que vers des pods sélectionnés par label ET Ready.** `kubectl get endpoints` est la première commande sur « injoignable » ; `<none>` a trois causes : selector faux, readiness en échec, pas de selector.
8. **Un Ingress sans controller (ou avec la mauvaise `ingressClassName`) est inerte, sans erreur.** Le CNI, l'ingress class et la StorageClass par défaut sont les trois choses à vérifier sur tout nouveau cluster client.
9. **Ce qui survit à un pod, c'est un PVC.** Les PVC d'un StatefulSet survivent à sa suppression ; la reclaim policy décide si le disque survit au PVC ; RWX n'existe que sur des systèmes de fichiers partagés (pas sur les disques GKE par défaut).
10. **Un Secret Kubernetes est du base64, protégé par le RBAC seulement.** Il n'est jamais affiché, jamais en argument de commande, jamais en partage d'écran. Chez un client, on demande *comment* les secrets arrivent (ESO, Sealed Secrets, Vault) avant de demander les secrets.

---

## Le trajet d'un `kubectl apply`, à connaître par cœur

```
apply ─▶ API server (valide, autorise, admission) ─▶ etcd
     ─▶ Deployment controller crée un ReplicaSet
     ─▶ ReplicaSet controller crée les Pods (sans nœud)
     ─▶ scheduler assigne un nœud (ressources, taints, affinités)
     ─▶ kubelet du nœud : volumes, init containers, image, conteneurs, probes
     ─▶ status remonté ; readiness OK ─▶ le pod entre dans les endpoints du Service
```

Un pod qui ne marche pas est bloqué à **une** de ces étapes. `describe pod` → Events te dit laquelle.

---

## Lire un statut de pod en une seconde

| Ce que tu vois | Ce que c'est | Commande suivante |
|---|---|---|
| `Pending` | Pas de nœud (ressources, taint, affinité, volume, zone) ou image en cours | `describe pod` → `FailedScheduling …` |
| `Init:0/1` | Un init container tourne (attente base, migration) — **souvent normal** | `logs -c <init>` |
| `ContainerCreating` long | Volume (`Multi-Attach`, `FailedMount`), secret manquant, image lente | `describe pod`, `get volumeattachment` |
| `CreateContainerConfigError` | ConfigMap/Secret référencé introuvable | `describe pod` |
| `ImagePullBackOff` | `not found` (nom/tag) / `unauthorized` (pull secret) / `x509` (CA du registre) | `describe pod` → Events |
| `CrashLoopBackOff` | Démarre puis meurt, backoff croissant | `logs --previous` |
| `Running 0/1` | Tourne mais readiness en échec → hors du Service | `describe pod`, tester la probe |
| `Running 1/1`, RESTARTS élevé | Liveness qui tue, ou OOM | `describe` → `Last State`, `OOMKilled` ? |
| `Evicted` | Nœud sous pression (mémoire/disque) | `describe node` |
| Deployment `0/1` sans aucun pod | Refusé par Pod Security / webhook d'admission | `describe rs`, `get events` |
| `Terminating` bloqué | Finalizer dont le contrôleur ne répond plus | `-o yaml \| yq .metadata.finalizers` |

---

## Codes HTTP renvoyés par un ingress controller

| Code | Sens | Regarder |
|---|---|---|
| 404 | Aucune règle ne matche host/chemin, ou classe absente | `get ingress` (ADDRESS vide ?), `get ingressclass` |
| 502 | Endpoint joint, connexion refusée | targetPort faux, app écoute sur 127.0.0.1 |
| 503 | Aucun endpoint | readiness, selector |
| 504 | Backend trop lent | timeouts du controller (annotations), app saturée |

---

## Réflexes d'action

| Tu veux | Fais | Pas |
|---|---|---|
| Redémarrer une app | `kubectl rollout restart deploy/x` | `delete pod` en masse |
| Changer une config durablement | values / manifeste versionné, redéployer | `kubectl edit` |
| Couper un composant avec HPA | désactiver l'HPA ou `enabled: false` dans le chart | `scale --replicas=0` |
| Supprimer une application | supprimer le parent (Deployment, release, CRD) | supprimer pods puis RS puis… |
| Débloquer un `Terminating` | comprendre qui a posé le finalizer d'abord | `patch finalizers: null` en premier réflexe |
| Récupérer un secret | `… \| base64 -d \| pbcopy` | l'afficher |
| Donner un mot de passe à une commande | stdin ou fichier 600 | `--password=…` |
| Savoir si tu as le droit | `kubectl auth can-i --list` | demander des droits sans avoir testé |

---

## Ce qui change d'un client à l'autre (à vérifier en arrivant)

```bash
kubectl version                         # version du cluster : dépréciations d'API
kubectl get nodes -o wide               # nombre, OS, runtime, zones (labels topology.kubernetes.io/zone)
kubectl get pods -n kube-system         # quel CNI ? (calico, cilium, kindnet, flannel, ovn) → NetworkPolicy appliquées ou non
kubectl get ingressclass                # nom exact à mettre dans les charts ; absent = pas de controller
kubectl get storageclass                # laquelle est (default) ? RWX possible ? expansion ? snapshots ?
kubectl get csidrivers
kubectl get ns --show-labels | grep pod-security     # niveau PSA imposé
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations   # Kyverno, Gatekeeper, mesh
kubectl get crd | head -50              # opérateurs présents (cert-manager, ESO, postgres…)
kubectl auth can-i --list -n <ns>       # ce que TU peux faire
kubectl auth can-i create clusterroles  # installation cluster-wide possible ?
```

Cinq questions à poser au client si les commandes ne suffisent pas : CNI et policies ? ingress controller et classe ? StorageClass par défaut, RWX, snapshots ? registre d'images et comment on y pousse ? comment arrivent les secrets ?

---

## Les valeurs d'un chart qui changent presque toujours par client

`ingress.className` · `ingress.host` · `storageClass` (et tailles) · `service.type` (LoadBalancer vs NodePort/ClusterIP) · `image.registry` + `imagePullSecrets` · `existingSecret` pour chaque mot de passe · `securityContext` (OpenShift : pas d'UID fixe) · `nodeSelector`/`tolerations` (GPU) · `resources` · `podAntiAffinity` (`required` impossible sur un cluster à 2 nœuds).

---

## Pièges vécus, par étape

- **0** — deux `kubectl` dans le PATH ; `AGENT=1` posé par un terminal d'agent ; `$HOME` non inscriptible ; doc interne périmée → noter l'écart.
- **1** — mauvais contexte kubectl ; `spec` vs `status` ; `logs` sans `--previous` sur un crash.
- **2** — scaler un ReplicaSet ; `--cascade=orphan` involontaire ; forcer un finalizer et laisser un disque cloud facturé ; ne pas dire qu'une correction est ponctuelle.
- **3** — liveness sur une dépendance ; pas de startup probe sur un chargement de modèle ; `BestEffort` ; anti-affinité `required` > nombre de nœuds ; PDB qui bloque un drain ; RWO + RollingUpdate.
- **4** — `ingressClassName` faux (silencieux) ; `ndots:5` ; NetworkPolicy ignorée par le CNI ; `NO_PROXY` sans les plages du cluster ; keep-alive collé à un pod.
- **5** — pas de StorageClass par défaut ; `storageClassName: ""` ≠ absent ; RWX sur GKE ; `volumeClaimTemplates` immuable ; `helm uninstall` et les PVC ; `fsGroup` codé en dur sur OpenShift.
- **6** — ConfigMap en env sans redémarrage ; `subPath` jamais rafraîchi ; `list secrets` = tout lire ; ClusterRole refusé par le client ; Pod Security `restricted` non prévu par le chart ; webhook mutant qui modifie le rendu ; ADC vs session `gcloud`.

---

## Auto-évaluation express

Réponds à voix haute, sans support :

1. Pourquoi `kubectl delete pod` sur un pod de Deployment « ne marche pas », et quand est-ce quand même le bon geste ?
2. Trois causes d'un `FailedScheduling`, et le mot-clé de chaque dans l'événement.
3. Différence liveness / readiness, en une phrase chacune.
4. Trois causes d'un Service sans endpoints.
5. Pourquoi un PVC reste `Pending` sur un cluster kubeadm nu ?
6. Que se passe-t-il à un `helm upgrade` qui ne change qu'un ConfigMap consommé en env ?
7. Que protège réellement un Secret Kubernetes ?
8. Deployment à `0/1` et aucun pod : premier suspect ?
9. Les deux authentifications GCP et à quoi sert chacune.
10. Un objet reste en `Terminating` : la question à se poser avant de forcer.

Si une réponse hésite, rouvre l'étape correspondante et refais son exercice.
