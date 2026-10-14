# Étape 2 — Contrôleurs, ownership et actions destructives

**Objectif** : à la fin de cette étape, tu ne te bats plus contre Kubernetes. Tu sais retrouver *qui* possède un objet, agir au bon niveau, distinguer une correction ponctuelle d'une correction durable, et supprimer sans surprise.

**Notions couvertes** : §14 (contrôleurs, ownership et actions destructives).

**Prérequis** : étape 1 faite. Tu as vu un ReplicaSet recréer un pod que tu venais de supprimer.

---

## 2.1 Le problème : « je l'ai supprimé et il est revenu »

C'est la situation de l'étape 1, et elle a mille variantes :

- tu supprimes un pod → il revient ;
- tu modifies le `replicas` d'un ReplicaSet → il est remis à sa valeur ;
- tu mets un Deployment à 0 réplicas → quelque chose le remonte à 1 ;
- tu changes une valeur dans un ConfigMap avec `kubectl edit` → elle est écrasée au déploiement suivant ;
- tu supprimes un objet → il reste en `Terminating` indéfiniment.

Toutes ces situations ont la même explication : **quelqu'un d'autre possède l'objet ou le champ que tu touches, et ce quelqu'un est une boucle de réconciliation qui ne s'arrête jamais.** Tu ne gagneras pas contre une boucle. La seule issue est d'agir sur ce qu'elle lit — son état désiré — au lieu d'agir sur ce qu'elle produit.

---

## 2.2 ownerReference : la trace du propriétaire

Chaque objet créé par un contrôleur porte dans ses métadonnées une référence vers son propriétaire :

```bash
kubectl get pod web-7d9f8b6c4-x2k9p -o yaml | yq '.metadata.ownerReferences'
```

```yaml
- apiVersion: apps/v1
  kind: ReplicaSet
  name: web-7d9f8b6c4
  uid: 3a1f…
  controller: true
  blockOwnerDeletion: true
```

Deux champs comptent :

- **`controller: true`** signifie : « cet objet est *géré* par ce propriétaire ». Un contrôleur va constamment vérifier que l'objet existe et correspond à ce qu'il attend. C'est la marque qu'il ne faut pas agir sur l'objet, mais sur son propriétaire.
- **`blockOwnerDeletion: true`** : si on supprime le propriétaire en mode « foreground », il attendra que cet enfant soit supprimé d'abord.

Le réflexe à acquérir : **devant un objet qui « revient », lis ses `ownerReferences` et remonte.** Et remonte encore, parce que le propriétaire a souvent lui-même un propriétaire :

```
Pod  ──controller──▶  ReplicaSet  ──controller──▶  Deployment  ──(Helm / ArgoCD)──▶  values.yaml dans git  ──▶  un humain
```

À chaque échelon la question est la même : *qui écrit l'état désiré de cet objet ?* On s'arrête au premier échelon où la réponse est « un fichier versionné » ou « une personne ». C'est **là** que se fait la correction durable.

`kubectl describe` affiche aussi le propriétaire, sur la ligne `Controlled By:`.

---

## 2.3 Les propriétaires qui ne sont pas dans le cluster

Le haut de la chaîne sort de Kubernetes, et c'est là que les débutants se perdent.

**Helm.** Helm n'a **pas** de contrôleur : il n'y a pas de boucle qui surveille les objets d'une release. Si tu modifies un Deployment installé par Helm avec `kubectl edit`, ta modification tient… jusqu'au prochain `helm upgrade`, qui réapplique le manifeste rendu et écrase ta modification sans prévenir. Les objets Helm se reconnaissent à leurs métadonnées :

```yaml
labels:
  app.kubernetes.io/managed-by: Helm
annotations:
  meta.helm.sh/release-name: platform
  meta.helm.sh/release-namespace: platform
```

**ArgoCD / Flux (GitOps).** Eux **ont** un contrôleur. Avec l'option *self-heal* activée, toute dérive entre le cluster et le dépôt git est corrigée en quelques secondes ou minutes. Une modification manuelle sur un cluster géré par ArgoCD en self-heal ne survit pas au temps de la lire. Reconnaissables aux labels `argocd.argoproj.io/instance` ou `kustomize.toolkit.fluxcd.io/name`.

**Les opérateurs.** Un opérateur (étape 9) est un contrôleur qui gère des objets à partir d'une ressource personnalisée (CRD). Un Pod de base de données créé par un opérateur PostgreSQL a pour propriétaire un StatefulSet, lui-même propriété d'un objet `Cluster` (la CRD). Modifier le StatefulSet ne sert à rien ; il faut modifier le `Cluster`.

La conséquence pratique, sur un cluster client : **avant de toucher à un objet, identifie l'outil qui le gère.** Une modification `kubectl` sur un objet géré par ArgoCD est non seulement inutile, elle est trompeuse : tu croiras avoir corrigé quelque chose.

---

## 2.4 Un champ peut avoir un propriétaire différent de l'objet

Cas plus subtil : l'objet t'appartient, mais *un champ précis* est piloté par un contrôleur. L'exemple canonique est le **HorizontalPodAutoscaler** (HPA).

Un HPA cible un Deployment et écrit lui-même dans `spec.replicas` en fonction de la charge, entre `minReplicas` et `maxReplicas`. À partir de là, `spec.replicas` ne t'appartient plus :

- tu fais `kubectl scale deploy/api --replicas=5` → l'HPA constate que la charge ne justifie pas 5 et redescend ;
- tu fais `kubectl scale deploy/api --replicas=0` pour couper un service → selon la version de Kubernetes et l'outillage présent, ça ne tient pas.

Sur ce dernier point, sois précis avec toi-même, car le comportement dépend du contexte :

- Sur un Kubernetes récent sans autre outillage, mettre un Deployment à 0 met l'HPA **en pause** (condition `ScalingActive=False`, raison `ScalingDisabled`) : il ne remonte pas tout seul. C'est le comportement documenté.
- Mais dès qu'un autre acteur remet une valeur non nulle — un `helm upgrade` qui réapplique `replicas: 2` du chart, un ArgoCD en self-heal, un KEDA ScaledObject — l'HPA se réveille et impose au minimum `minReplicas`. Dans une plateforme déployée par chart parapluie, c'est le cas courant : **tu constates que ton `--replicas=0` a été annulé** et tu ne sais pas par qui.

La bonne action, dans tous les cas, n'est pas de scaler le Deployment : c'est d'agir sur l'état désiré — désactiver ou supprimer l'HPA, ou passer le composant à `enabled: false` dans les values du chart. Et de **noter ce que tu as observé**, pas ce que tu supposes (2.7).

Ce mécanisme de « champ possédé » a un nom technique, le *field ownership* (visible dans `metadata.managedFields`) ; on y reviendra à l'étape 9 avec le server-side apply.

---

## 2.5 Choisir la bonne action

Le tableau à intérioriser :

| Ce que tu veux | Action réflexe (mauvaise) | Action correcte |
|---|---|---|
| Redémarrer une application | `kubectl delete pod …` | `kubectl rollout restart deploy/…` — crée de nouveaux pods proprement, un par un |
| Redémarrer *un* pod précis (fuite mémoire) | idem | `kubectl delete pod` est acceptable **ici** : c'est le rôle du ReplicaSet de le remplacer, et tu le sais |
| Changer le nombre de réplicas | `kubectl scale rs …` | `kubectl scale deploy …` — et sache que ça sera écrasé au prochain déploiement ; durable = values du chart |
| Couper temporairement un composant avec HPA | `kubectl scale deploy … --replicas=0` | supprimer/désactiver l'HPA d'abord, ou `enabled: false` côté chart |
| Changer une variable d'environnement | `kubectl edit deploy …` | modifier les values / le manifeste versionné, redéployer ; `edit` uniquement pour un test dont tu sais qu'il sera perdu |
| Changer une config d'application | `kubectl edit configmap …` | idem — et note qu'un pod ne relit pas un ConfigMap monté en env sans redémarrer |
| Supprimer une application | supprimer les pods, puis le RS, puis… | supprimer l'objet **parent** (Deployment, release Helm, CRD) — la cascade fait le reste |
| Supprimer un objet géré par un opérateur | `kubectl delete sts …` | supprimer ou modifier la ressource personnalisée qui le pilote |

La ligne « redémarrer un pod précis » montre que supprimer un pod n'est pas interdit : c'est interdit *quand tu ne sais pas qui le recrée*. Une fois que tu le sais, c'est un outil comme un autre.

---

## 2.6 Suppression, cascade et finalizers

**La cascade.** Supprimer un propriétaire supprime ses enfants. Trois politiques :

```bash
kubectl delete deploy web                          # background (défaut) : le parent disparaît tout de suite, les enfants suivent
kubectl delete deploy web --cascade=foreground     # le parent attend que tous les enfants soient supprimés
kubectl delete deploy web --cascade=orphan         # le parent disparaît, les pods RESTENT, désormais sans propriétaire
```

`orphan` est utile pour une migration délicate (garder les pods vivants pendant qu'on remplace le contrôleur) — et dangereux si c'est involontaire : des pods orphelins ne sont plus gérés par personne, ne se réparent plus, et survivent à `helm uninstall`.

Supprimer un **namespace** supprime tout ce qu'il contient. C'est pratique en lab, et c'est l'action la plus destructive que tu puisses faire en une commande chez un client. Vérifie le contexte avant.

**Les finalizers.** Un objet peut porter dans `metadata.finalizers` une liste de « verrous » posés par des contrôleurs : tant qu'un finalizer est présent, l'API server marque l'objet `Terminating` mais ne le supprime pas. Le contrôleur concerné est censé faire son ménage (détacher un disque, supprimer un LoadBalancer cloud, nettoyer une entrée DNS) puis retirer son finalizer.

Quand un objet reste en `Terminating` :

```bash
kubectl get pvc data-db-0 -o yaml | yq '.metadata.finalizers'
# - kubernetes.io/pvc-protection
```

Le cas typique : le contrôleur qui devait retirer le finalizer n'existe plus (opérateur désinstallé avant ses ressources, namespace supprimé avant le contrôleur qui y vivait). Retirer un finalizer à la main débloque l'objet :

```bash
kubectl patch pvc data-db-0 -p '{"metadata":{"finalizers":null}}' --type=merge
```

**mais** c'est un dernier recours, à faire en sachant ce que le ménage non fait laisse derrière : un disque cloud, un LoadBalancer, un enregistrement DNS qui continueront d'exister et d'être facturés (§15 sur les ressources orphelines). Avant de forcer, demande-toi toujours : « qui a posé ce finalizer et pourquoi ne le retire-t-il pas ? »

---

## 2.7 Correction ponctuelle, correction durable, et ce que tu écris

Sur un incident, il y a souvent deux temps :

1. **La correction ponctuelle** : `rollout restart`, `scale`, `edit`. Elle rétablit le service maintenant. Elle **sera perdue** au prochain déploiement, par construction. Ce n'est pas un défaut, c'est son rôle.
2. **La correction durable** : le changement dans la configuration versionnée (values du chart, manifeste dans git, ressource personnalisée). Elle survit aux déploiements.

L'erreur n'est pas de faire une correction ponctuelle. L'erreur est de **ne pas dire qu'elle est ponctuelle**. Trois habitudes :

- Quand tu fais une action manuelle sur un environnement partagé, laisse une trace : un message dans le canal de l'environnement, ou une annotation sur l'objet (`kubectl annotate deploy api ops/manual-change="scaled to 3 by hugo 2026-09-16, revert at next deploy"`).
- Ouvre dans la foulée le ticket ou la PR de la correction durable.
- Dans tout compte rendu, sépare explicitement ce que tu as **vérifié** de ce que tu **supposes** :

  > ❌ « L'HPA remet le service à 1 quand on scale à 0. »
  > ✅ « Vérifié sur preview-42 (K8s 1.31, chart 3.8) : scale à 0 annulé en ~30 s après un helm upgrade. Non vérifié sur un cluster sans redéploiement. »

Cette discipline de « vérifié / non vérifié » est la même que celle exigée en communication client (étape 23). Elle commence ici, dans tes notes de lab.

---

## 2.8 Exercice — clavier en main

```bash
kubectl config current-context     # kind-lab
kubectl create namespace lab2 && kubens lab2
```

Déploie le `web.yaml` de l'étape 1 (Deployment `web`, 2 réplicas, + Service).

1. **Lis la chaîne de propriété.**
   ```bash
   kubectl get pods
   kubectl get pod <un pod> -o yaml | yq '.metadata.ownerReferences'
   kubectl get rs <le rs> -o yaml | yq '.metadata.ownerReferences'
   kubectl get deploy web -o yaml | yq '.metadata.ownerReferences'   # null : le sommet, c'est toi
   ```

2. **Agis au mauvais niveau et regarde la boucle gagner.** Dans un terminal, `kubectl get rs -w`. Dans l'autre :
   ```bash
   kubectl scale rs <le rs> --replicas=0
   ```
   Le ReplicaSet passe à 0 puis revient à 2 en moins d'une seconde : le Deployment controller a réécrit `spec.replicas`.

3. **Orpheline un pod sans le supprimer.** Retire-lui le label qui le lie au ReplicaSet :
   ```bash
   kubectl label pod <un pod> app-
   kubectl get pods --show-labels
   ```
   Tu as maintenant 3 pods : le ReplicaSet, qui compte ses pods *par label*, en a créé un nouveau, et l'ancien vit encore, sans propriétaire. `kubectl get pod <l'orphelin> -o yaml | yq '.metadata.ownerReferences'` → `null`. Supprime-le à la main : personne ne le recrée.

4. **Redémarre proprement.** `kubectl rollout restart deploy/web` puis `kubectl get pods -w` : les pods sont remplacés un par un, le service ne s'interrompt pas. Compare avec `kubectl delete pod -l app=web`, qui tue tout d'un coup.

5. **Installe un HPA et observe le comportement réel.** Sur kind, l'HPA a besoin de metrics-server :
   ```bash
   kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
   kubectl patch -n kube-system deploy metrics-server --type=json \
     -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
   kubectl -n kube-system rollout status deploy/metrics-server
   kubectl top nodes                      # doit répondre au bout d'une minute
   ```
   Ajoute des `resources.requests.cpu: 50m` au conteneur dans `web.yaml` (l'HPA en a besoin), applique, puis :
   ```bash
   kubectl autoscale deploy web --min=1 --max=3 --cpu-percent=50
   kubectl get hpa -w
   ```
   Maintenant, dans un autre terminal :
   ```bash
   kubectl scale deploy web --replicas=0
   kubectl get hpa web -o yaml | yq '.status.conditions'   # cherche ScalingActive et sa raison
   kubectl apply -f web.yaml                                # simule un redéploiement qui remet replicas: 2
   kubectl get deploy web -w                                # que fait l'HPA maintenant ?
   ```
   **Écris en trois lignes ce que tu as observé**, avec version de Kubernetes (`kubectl version`) et ce que tu n'as pas testé. C'est l'exercice de 2.7, pas une formalité.

6. **Cascade et orphelins.**
   ```bash
   kubectl delete hpa web
   kubectl delete deploy web --cascade=orphan
   kubectl get rs,pods            # tout est encore là, sans Deployment
   kubectl delete rs --all        # les pods disparaissent : le RS est leur propriétaire direct
   ```

7. **Finalizer bloquant, version contrôlée.** Pose un finalizer factice sur un ConfigMap, tente de le supprimer, débloque :
   ```bash
   kubectl create configmap demo --from-literal=a=b
   kubectl patch configmap demo -p '{"metadata":{"finalizers":["lab/hold"]}}' --type=merge
   kubectl delete configmap demo --wait=false
   kubectl get configmap demo -o yaml | yq '.metadata.deletionTimestamp, .metadata.finalizers'   # Terminating, bloqué
   kubectl patch configmap demo -p '{"metadata":{"finalizers":null}}' --type=merge               # disparaît aussitôt
   ```

8. **Nettoie** : `kubectl delete namespace lab2`. Garde metrics-server, il resservira.

---

## Validé si…

- Devant n'importe quel objet, tu sais retrouver son propriétaire en une commande, et remonter jusqu'à un fichier ou une personne.
- Tu sais dire en une phrase pourquoi `kubectl scale rs` et `kubectl edit` sur un objet Helm sont des pièges.
- Tu sais expliquer ce qu'est un finalizer, pourquoi un objet reste en `Terminating`, et pourquoi forcer est un dernier recours.
- Tu as un compte rendu de trois lignes sur le comportement HPA, qui distingue le vérifié du supposé.

**Étape suivante** : `etape-03-workloads-avances.md` — StatefulSet, DaemonSet, Job, cycle de vie d'un pod, probes, ressources et scheduling.
