# Étape 21 — Environnements éphémères

**Objectif** : à la fin de cette étape, tu sais créer un environnement de preview complet, lire sa timeline de démarrage sans paniquer, distinguer « c'est long » de « c'est cassé », et le détruire vraiment — sans laisser derrière toi des ressources cloud facturées ni casser celles d'un collègue.

**Notions couvertes** : §15 (environnements éphémères, provisionnement asynchrone, hygiène des ressources partagées).

**Prérequis** : partie A (statuts de pod), partie B (parapluie, values empilées), étape 17 (plan de données), étape 20 (méthode de debug).

---

## 21.1 À quoi sert un environnement éphémère

Chez un client, tu ne testes pas sur son cluster. Il te faut un endroit où déployer la plateforme entière, en quelques minutes, pour :

- valider une pile de values avant de la proposer au client ;
- reproduire un bug signalé sur une version précise ;
- préparer une démo sans dépendre d'un environnement partagé ;
- tester une montée de version (étape 9) avant de la jouer chez quelqu'un.

Les trois formes que ça prend en pratique :

| Forme | Ce que c'est | Quand |
|---|---|---|
| **Namespace dédié** | un namespace sur un cluster partagé | le plus courant, le moins isolé |
| **Cluster virtuel** (vcluster, Capsule…) | un control plane léger dans un namespace, avec ses propres CRDs et son propre RBAC | quand tu dois installer des CRDs ou des opérateurs sans polluer le cluster |
| **Cluster réel éphémère** | un vrai cluster créé puis détruit (GKE, kind, k3d) | tests d'infra : CNI, StorageClass, GPU, version de K8s |

La différence qui compte : **avec un simple namespace, tout ce qui est cluster-wide est partagé** — CRDs, webhooks, opérateurs, ClusterRoles, ingress controller, StorageClass. Si ton chart installe cert-manager, tu l'installes *pour tout le monde*. C'est la cause numéro un d'incidents sur environnement partagé.

---

## 21.2 Les trois propriétés à exiger

### Idempotence

Relancer la création doit donner le même résultat, que l'environnement existe déjà ou non. Concrètement :

```bash
helm upgrade --install ...            # jamais helm install seul
kubectl apply -f ...                  # jamais kubectl create seul
kubectl create ns x --dry-run=client -o yaml | kubectl apply -f -   # create ns idempotent
```

Ce qui casse l'idempotence, à repérer dans ton script : un nom généré aléatoirement à chaque passage ; un `randAlphaNum` dans le chart (étape 7) qui régénère un mot de passe et désynchronise l'app de sa base ; un Job de hook sans `before-hook-creation` (`Job already exists`) ; un `kubectl create secret` qui échoue au deuxième tour.

Le test : **lance ton script deux fois de suite. S'il échoue la deuxième fois, il n'est pas idempotent.**

### TTL

Un environnement éphémère sans date de mort est un environnement permanent qu'on a oublié de facturer à quelqu'un. Pose la date **à la création**, pas après :

```bash
kubectl label ns preview-hugo-rag \
  owner=hugo \
  ttl=24h \
  expires-at=2026-09-19T14:00Z \
  purpose=repro-bug-1842
```

Ces labels servent à trois choses : un job de nettoyage automatique peut les lire ; un collègue sait à qui appartient le namespace avant de le supprimer ; toi, tu retrouves pourquoi tu l'avais créé.

```bash
kubectl get ns -L owner,expires-at,purpose
kubectl get ns -l owner=hugo
```

### Coût

Une plateforme LLM complète en preview, c'est des dizaines de pods, des PVC, parfois un GPU. Ce qui coûte, par ordre :

1. **les nœuds GPU** — de loin le poste principal ; ne les demande que si tu testes réellement l'inférence locale (sinon, inférence déportée, étape 15) ;
2. **les disques** — les PV survivent au namespace supprimé si la reclaim policy est `Retain` (étape 5) ;
3. **les load balancers** — un LB cloud par Service de type LoadBalancer, facturé à l'heure ;
4. **les adresses IP réservées et les enregistrements DNS** orphelins (étape 12).

Réflexe : en preview, `service.type: ClusterIP` + port-forward, ou un seul ingress partagé, plutôt qu'un LB par composant.

---

## 21.3 Provisionnement asynchrone

Créer un environnement n'est pas une commande qui rend la main quand c'est prêt. C'est une demande, suivie d'une machine à états :

```
pending ──▶ provisioning ──▶ running
   │             │
   └─────────────┴──▶ failed
```

Trois conséquences pratiques.

**La commande qui réussit ne veut pas dire que l'environnement est prêt.** `helm install` retourne 0 dès que les manifestes sont acceptés par l'API server. Rien n'est démarré. C'est à ça que servent `--wait` (attendre que les pods soient Ready) et `--atomic` (rollback si le délai expire) — avec un `--timeout` réaliste, c'est-à-dire plus long que ta migration de base la plus lente.

**Attendre correctement, plutôt que dormir.**

```bash
# ❌ sleep 300
# ✅ attendre une condition
kubectl wait --for=condition=Available deploy --all -n $NS --timeout=20m
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=api -n $NS --timeout=10m
kubectl wait --for=jsonpath='{.status.phase}'=Bound pvc --all -n $NS --timeout=5m

# suivre en direct
kubectl get pods -n $NS -w
```

⚠️ `kubectl wait` sur une ressource **qui n'existe pas encore** échoue immédiatement (`no matching resources found`) au lieu d'attendre. Sur un chart qui crée ses objets progressivement, boucle :

```bash
until kubectl get deploy/api -n $NS >/dev/null 2>&1; do sleep 5; done
kubectl wait --for=condition=Available deploy/api -n $NS --timeout=15m
```

**Un `failed` est un état, pas forcément une erreur de ta part.** Quota cloud atteint, zone sans capacité GPU, image pas encore répliquée dans le miroir : le diagnostic se fait avec les Events (étape 20), pas en relançant trois fois.

---

## 21.4 La timeline réaliste d'une installation

C'est la partie que personne ne raconte, et qui fait paniquer tout le monde la première fois. Ordre de grandeur pour une plateforme complète sur un cluster déjà chaud :

| Temps | Ce que tu vois | Normal ? |
|---|---|---|
| 0 – 30 s | rien, ou quelques pods `Pending` | ✅ le scheduler travaille |
| 30 s – 3 min | **beaucoup de `Pending` et de `ContainerCreating`** | ✅ pull des images, création des PVC |
| 1 – 5 min | `Init:0/1` sur les applications | ✅ elles attendent la base, ou migrent |
| 2 – 6 min | la base, le cache, le bus passent `Running` | ✅ ils démarrent en premier par construction |
| 3 – 10 min | les migrations tournent ; les apps restent `Init` | ✅ **le moment le plus long et le plus silencieux** |
| 5 – 12 min | les apps passent `Running 0/1` puis `1/1` | ✅ readiness |
| 8 – 15 min | 1 ou 2 composants optionnels en erreur | ⚠️ voir plus bas |
| > 20 min | statut identique depuis 10 min | ❌ diagnostiquer |

**Les Pending massifs du début sont normaux.** Sur un cluster avec autoscaler, ils déclenchent l'ajout de nœuds : compte 3 à 5 minutes de plus. Ce qui est anormal, c'est un Pending dont l'**Event ne change pas** (étape 20, arbre E).

**Les migrations qui bloquent les init containers sont normales.** Un init container qui attend que la base soit prête, ou qui joue une migration de schéma, peut tenir 10 minutes sans écrire une ligne. Avant de conclure, lis ses logs — pas ceux du conteneur principal, qui n'a pas démarré :

```bash
kubectl logs <pod> -c <init-container> -n $NS -f
kubectl get pods -n $NS | grep Init      # combien en attente, et depuis quand
```

### « Long » ou « cassé » ?

La distinction se fait sur **le mouvement**, pas sur la durée :

| Signe | Lecture |
|---|---|
| Le message d'Event change, ou les logs de l'init avancent | ⏳ long |
| Le compteur de pods Running augmente, même lentement | ⏳ long |
| `RESTARTS` augmente | ❌ cassé — ça ne se débloquera pas tout seul |
| Statut et Events identiques depuis plus de 10 min | ❌ cassé |
| `ImagePullBackOff`, `CreateContainerConfigError` | ❌ cassé immédiatement, inutile d'attendre |
| `Init:CrashLoopBackOff` | ❌ cassé : la migration échoue en boucle |

Une commande pour voir le mouvement plutôt qu'un instantané :

```bash
watch -n 10 'kubectl get pods -n preview-hugo | awk "{print \$3}" | sort | uniq -c'
```

Si la répartition des statuts évolue, laisse tourner. Si elle est figée, diagnostique.

### Composants optionnels légitimement en erreur

Sur un environnement de preview, certains composants sont **attendus en erreur** parce que leur dépendance externe n'existe pas : le connecteur vers l'IdP du client, l'export de métriques vers son collecteur, un composant GPU sur un environnement sans GPU, un backup vers un bucket non configuré.

Avant de partir en chasse, **constitue la liste de ce qui est normalement rouge sur ton environnement de preview**, et vérifie-la à chaque nouvelle version. C'est le même travail qu'à l'étape 22 pour les logs. Sans cette liste, tu diagnostiques pendant 40 minutes un composant qui n'est pas censé fonctionner.

---

## 21.5 Hygiène des ressources partagées

Tu partages presque toujours quelque chose : un cluster, un registre, un domaine, un projet cloud, un quota GPU.

**Nommer, toujours.** `preview-hugo-rag-1842`, jamais `test`, `tmp`, `demo2`. Ton nom doit apparaître dans le namespace, dans le sous-domaine, dans le nom de la release et dans les labels. Quelqu'un doit pouvoir dire « c'est à Hugo » sans te demander.

**Ne jamais supprimer ce qui n'est pas à toi.** Avant toute suppression sur un cluster partagé :

```bash
kubectl get ns $NS -o jsonpath='{.metadata.labels}' ; echo
kubectl get ns $NS -o jsonpath='{.metadata.creationTimestamp}' ; echo
helm list -n $NS
```

Si le propriétaire n'est pas identifiable, **demande** avant. Un namespace sans label `owner` qui traîne depuis 3 mois peut très bien être l'environnement de démo d'un commercial.

**Le cluster-wide est à tout le monde.** Sur un cluster partagé, avant d'installer : un opérateur (cert-manager, ESO, GPU Operator) est **déjà là ou pas**, et l'installer en double casse celui des autres. C'est exactement le piège de l'étape 9.

```bash
kubectl get crd | grep -E 'cert-manager|external-secrets|nvidia'
kubectl get deploy -A | grep -iE 'operator|controller'
helm list -A
```

Si l'opérateur existe, désactive-le dans tes values (`cert-manager.enabled: false`) plutôt que de l'installer.

**Tes droits.** Tu n'as peut-être pas le droit de créer des ClusterRoles ou des CRDs. Teste avant de demander (étape 6) :

```bash
kubectl auth can-i create crd
kubectl auth can-i create clusterrole
kubectl auth can-i '*' '*' -n $NS
```

---

## 21.6 Détruire, et vérifier que c'est détruit

**Supprimer en partant est une règle, pas une politesse.** Un environnement oublié coûte de l'argent, occupe du quota GPU que ton collègue attend, et devient un environnement fantôme que personne n'ose supprimer six mois plus tard.

L'ordre compte, parce que certaines suppressions dépendent d'objets encore vivants :

```bash
NS=preview-hugo-rag

# 1. les releases Helm d'abord (les hooks de désinstallation ont besoin du namespace)
helm uninstall platform -n $NS

# 2. ce que Helm ne supprime jamais : PVC et CRDs
kubectl get pvc -n $NS
kubectl delete pvc --all -n $NS

# 3. le namespace
kubectl delete ns $NS
```

Rappels des parties A et B : `helm uninstall` **ne supprime pas les PVC** créés par des `volumeClaimTemplates`, ni les CRDs de `crds/`, ni les objets marqués `helm.sh/resource-policy: keep`.

### Vérifier, hors du cluster aussi

Supprimer le namespace ne supprime pas ce qui vit ailleurs :

```bash
# dans le cluster
kubectl get ns $NS                       # doit répondre NotFound
kubectl get pv | grep $NS                # PV Released ou Retain restants ?
kubectl get crd | grep <ton opérateur>   # installé par toi ? à retirer
kubectl get clusterrole,clusterrolebinding | grep $NS
kubectl get validatingwebhookconfigurations | grep $NS

# hors du cluster (exemple GCP, à adapter)
gcloud compute disks list --filter="-users:*"           # disques non attachés
gcloud compute addresses list --filter="status=RESERVED"
gcloud compute forwarding-rules list                     # LB orphelins
gcloud dns record-sets list --zone=Z | grep preview-hugo
```

Les **enregistrements DNS orphelins** (étape 12) sont particulièrement traîtres : un `external-dns` qui a créé un enregistrement et dont le namespace a été supprimé brutalement laisse un nom qui pointe vers une IP recyclée — chez quelqu'un d'autre.

### Un namespace bloqué en `Terminating`

C'est le cas classique, et la mauvaise réaction est de forcer les finalizers (étape 2). D'abord, comprendre :

```bash
kubectl get ns $NS -o json | jq '.spec.finalizers, .status.conditions'
# quelles ressources refusent de partir ?
kubectl api-resources --verbs=list --namespaced -o name \
  | xargs -n1 kubectl get --show-kind --ignore-not-found -n $NS
```

Deux causes dominantes : une **CRD dont l'opérateur a déjà été supprimé** (plus personne ne retire le finalizer), ou un **webhook injoignable** qui bloque la suppression. Corrige la cause (réinstaller brièvement l'opérateur, supprimer le webhook), et le namespace part seul. Forcer laisse des ressources cloud vivantes et facturées, sans plus rien dans le cluster pour te les rappeler.

---

## 21.7 Aide-mémoire

```
CRÉER      upgrade --install · apply · labels owner/ttl/expires-at/purpose · nom qui te désigne
ATTENDRE   kubectl wait --for=condition · jamais sleep · --wait --atomic --timeout > migration
LIRE       Pending & Init au début = normal · mouvement = long · figé ou RESTARTS = cassé
           logs de l'INIT container, pas du principal
PARTAGÉ    vérifier opérateurs/CRDs déjà présents · auth can-i · ne rien supprimer sans owner
DÉTRUIRE   helm uninstall → PVC → namespace → vérifier PV, CRD, clusterrole, DNS, disques, IP, LB
BLOQUÉ     comprendre le finalizer AVANT de forcer
```

---

## 21.8 Exercice — à faire clavier en main

L'exercice complet est : **créer, observer la timeline, détruire, vérifier**. Sur kind, ou sur un cluster de dev si tu en as un.

**1. Écris le script de création**, avec les labels et l'idempotence :

```bash
#!/usr/bin/env bash
# up.sh — crée un environnement de preview
set -euo pipefail
NS="preview-${USER}-lab"
TTL_END=$(date -u -d '+24 hours' +%Y-%m-%dT%H:%MZ 2>/dev/null || date -u -v+24H +%Y-%m-%dT%H:%MZ)

kubectl create ns "$NS" --dry-run=client -o yaml | kubectl apply -f -
kubectl label ns "$NS" --overwrite \
  owner="${USER}" ttl=24h expires-at="$TTL_END" purpose=exercice-etape-21

helm upgrade --install platform ./platform -n "$NS" \
  -f values/base.yaml -f values/preview.yaml \
  --timeout 15m
echo "$(date -u +%H:%M:%S) demande envoyée sur $NS"
```

Note qu'il n'y a **ni `--wait` ni `--atomic`** : c'est volontaire, pour pouvoir observer la timeline. En usage réel, tu les mets.

**2. Lance-le deux fois de suite.** S'il échoue au deuxième passage, corrige jusqu'à ce qu'il soit idempotent. Note ce qui cassait.

**3. Observe la timeline** dans un second terminal, dès la première seconde :

```bash
NS=preview-$USER-lab
watch -n 10 'kubectl get pods -n '"$NS"' | awk "{print \$3}" | sort | uniq -c'
```

Remplis un tableau au fur et à mesure, avec l'heure réelle :

| Heure | Pending | Init | Running 0/1 | Running 1/1 | Erreur |
|---|---|---|---|---|---|

**4. Pendant l'attente, entraîne-toi à la question « long ou cassé ? »** sur trois pods au hasard, dont au moins un en `Init`. Pour chacun, écris ta réponse **et la preuve** :

```bash
kubectl describe pod <p> -n $NS | tail -20        # l'Event a-t-il changé ?
kubectl logs <p> -c <init> -n $NS --tail=20       # la migration avance-t-elle ?
kubectl get pod <p> -n $NS -o wide                # RESTARTS bouge-t-il ?
```

**5. Constitue ta liste de rouges normaux.** Une fois l'environnement stabilisé, liste tout ce qui n'est pas `Running` complet et, pour chaque ligne, écris pourquoi c'est attendu ou non. Garde le fichier : c'est ta référence pour les prochaines installations.

```bash
kubectl get pods -n $NS | grep -vE 'Completed|Running' ; \
kubectl get pods -n $NS -o json \
  | jq -r '.items[] | select([.status.containerStatuses[]?.ready] | all | not) | .metadata.name'
```

**6. Détruis et vérifie**, en suivant 21.6. Vérifie explicitement les PVC et les PV : si des PV restent en `Released`, explique pourquoi (reclaim policy) et nettoie.

**7. Bonus — fabrique un namespace bloqué**, puis débloque-le par la cause :

```bash
kubectl create ns stuck-lab
# installe un opérateur dont la CR pose un finalizer, crée la CR,
# supprime l'opérateur, puis supprime le namespace → Terminating
```

Trouve quelle ressource bloque avec la commande `api-resources` de 21.6. Résous-le **sans** éditer les finalizers, en réinstallant l'opérateur. Ne force les finalizers qu'ensuite, pour voir la différence — et note ce qui serait resté facturé sur un vrai cloud.

---

## Validé si…

Tu peux, sans support :

- expliquer pourquoi `helm install` qui retourne 0 ne veut pas dire que l'environnement est prêt ;
- donner trois choses qui cassent l'idempotence d'un script de création ;
- dire quels statuts sont normaux dans les 5 premières minutes d'une installation, et lesquels sont cassés d'emblée ;
- donner le critère qui sépare « long » de « cassé », en une phrase ;
- dire dans quel conteneur tu lis les logs d'un pod en `Init:0/1` depuis 8 minutes ;
- citer quatre choses qui survivent à `kubectl delete ns` ;
- expliquer pourquoi forcer les finalizers d'un namespace est une mauvaise première réaction ;
- dire ce que tu vérifies avant d'installer un opérateur sur un cluster partagé.

**Étape suivante** : `etape-22-faux-positifs-recurrents.md` — les faux positifs récurrents.
