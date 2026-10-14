# Étape 9 — CRDs, opérateurs et couplage de versions

**Objectif** : à la fin de cette étape, tu sais ce qu'est une CRD et un opérateur, pourquoi Helm gère mal les CRDs et comment faire à la place, ce qu'est le server-side apply et un conflit de propriété de champ, et — surtout — comment remonter de plusieurs erreurs apparemment sans lien à une seule cause : un décalage de version entre deux briques.

**Notions couvertes** : §2 (CRDs et Helm, server-side apply), §3 (opérateurs et couplage version outillage / version chart).

**Prérequis** : étapes 2, 7 et 8.

---

## 9.1 Étendre l'API : les CRDs

Kubernetes ne connaît nativement que ses objets (Pod, Deployment, Service…). Une **CustomResourceDefinition** ajoute un **nouveau type** à l'API, avec son schéma, comme si Kubernetes l'avait toujours eu :

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: certificates.cert-manager.io          # <pluriel>.<groupe>
spec:
  group: cert-manager.io
  scope: Namespaced                            # ou Cluster
  names: { kind: Certificate, plural: certificates, singular: certificate, shortNames: [cert] }
  versions:
    - name: v1
      served: true
      storage: true                            # UNE seule version de stockage dans etcd
      schema:
        openAPIV3Schema: { … }                 # validation des champs
      additionalPrinterColumns: [ … ]          # les colonnes de kubectl get
```

Une fois la CRD créée, on peut créer des **instances** (custom resources, CR) :

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: chat-tls, namespace: platform }
spec:
  secretName: chat-tls
  dnsNames: [chat.client.example]
  issuerRef: { name: letsencrypt, kind: ClusterIssuer }
```

Et **tout `kubectl` fonctionne dessus** : `get certificate`, `describe`, `explain certificate.spec`, `-o yaml`, `delete`. Une CR est un objet dans etcd comme les autres — avec un `spec` que tu écris et un `status` que quelqu'un d'autre écrit. Ce quelqu'un est l'opérateur.

Commandes de base :
```bash
kubectl get crd                                       # toutes les CRDs du cluster = quels opérateurs sont là
kubectl api-resources --api-group=cert-manager.io     # les types d'un groupe
kubectl explain certificate.spec.privateKey           # la doc du schéma, depuis le cluster
kubectl get crd certificates.cert-manager.io -o yaml | yq '.spec.versions[].name'   # versions servies
```

Ce que le schéma implique : un champ **inconnu** dans une CR est, selon la CRD, **rejeté** (`unknown field`) ou **silencieusement supprimé** (*pruning*, le défaut pour `apiextensions.k8s.io/v1`). Ce second cas est traître : tu crois avoir configuré quelque chose, la CR est acceptée, et le champ n'est simplement plus là. `kubectl get -o yaml` après création est la vérité. Retiens-le pour 9.5.

---

## 9.2 Le pattern opérateur

Un **opérateur** = une ou plusieurs CRDs + un **contrôleur** (un Deployment ordinaire) qui surveille ces CR et fait ce qu'il faut pour que le monde y ressemble. C'est exactement le mécanisme de l'étape 2, appliqué à des objets qui décrivent quelque chose de plus haut niveau qu'un pod : « une base PostgreSQL haute disponibilité avec sauvegardes », « un certificat renouvelé automatiquement », « un secret synchronisé depuis Vault ».

Les opérateurs que tu croiseras dans ou autour de la plateforme :

| Opérateur | CRDs principales | Ce qu'il fabrique |
|---|---|---|
| **cert-manager** | `Issuer`, `ClusterIssuer`, `Certificate` | Secrets TLS, renouvelés (ACME/Let's Encrypt, CA interne) — §4 |
| **External Secrets Operator** | `SecretStore`, `ClusterSecretStore`, `ExternalSecret` | Secrets Kubernetes depuis un coffre — étape 6 |
| **CloudNativePG** (ou Zalando, Crunchy) | `Cluster`, `Backup`, `ScheduledBackup`, `Pooler` | Pods PostgreSQL en HA, failover, PITR vers stockage objet, pooler — §9, §10 |
| **ClickHouse operator** (Altinity) | `ClickHouseInstallation` | Cluster analytique — §9 |
| **Strimzi** | `Kafka`, `KafkaTopic`, `KafkaUser` | Bus de messages — §9 |
| **Redis / Valkey operators** | `RedisFailover`, `Redis` | Cache KV avec sentinel — §9 |
| **Argo Workflows / Temporal** | `Workflow`, `CronWorkflow` / (Temporal : chart + CR partielles) | Workflows durables — §9 |
| **Prometheus operator** | `ServiceMonitor`, `PodMonitor`, `PrometheusRule` | Cibles de scrape et alertes — étape 18 |
| **NVIDIA GPU Operator** | `ClusterPolicy` | Drivers, device plugin, toolkit sur les nœuds GPU — étape 15 |
| **Keycloak operator** | `Keycloak`, `KeycloakRealmImport` | IdP — étape 13 |
| **MinIO operator** | `Tenant` | Stockage objet S3 — §9 |

Lire l'état d'une CR se fait toujours de la même façon :
```bash
kubectl get cluster db-main -o yaml | yq '.status'                   # phase, conditions, readyInstances…
kubectl describe cluster db-main                                       # + Events émis par l'opérateur
kubectl -n cnpg-system logs deploy/cnpg-controller-manager --tail=100  # ce que l'opérateur pense
```
`status.conditions` (`Ready: True/False` avec `reason` et `message`) est la convention ; quand une CR n'avance pas, l'ordre est : conditions → events → logs de l'opérateur. Un opérateur **absent ou en panne** se reconnaît à une CR qui reste sans `status` du tout : personne ne l'a lue.

---

## 9.3 Opérateur préexistant ou embarqué ?

Deux façons d'amener un opérateur dans une installation de plateforme, et le choix n'est pas libre.

**Contraintes techniques :**
- Une CRD est **cluster-wide et unique** : deux releases ne peuvent pas chacune « posséder » `certificates.cert-manager.io`. Si le client a déjà cert-manager, ton chart ne doit **pas** l'embarquer, et doit fonctionner avec **sa** version.
- Une CR ne peut être créée que si sa CRD existe **et** que le webhook de validation/conversion de l'opérateur répond. Installer opérateur + CR dans une même release est une course : Helm installe les `crds/` d'abord, mais le Deployment de l'opérateur n'est pas encore `Ready` quand les CR arrivent → `failed calling webhook … connection refused`. Ça marche au deuxième essai, ce qui est pire qu'une erreur franche.
- Les opérateurs d'infrastructure (cert-manager, ESO, GPU operator, ingress controller, Prometheus operator) ont besoin de ClusterRoles larges et touchent tout le cluster : c'est le **domaine du client** (§1, frontière de responsabilité).

**La règle qui en découle :**

| Type d'opérateur | Où il vit | Qui l'installe |
|---|---|---|
| Infrastructure partagée (certificats, secrets, GPU, ingress, monitoring) | Hors du chart, **préexistant** | Le client, ou une étape « prérequis » séparée et documentée (`platform-prereqs`), avec une **matrice de versions supportées** |
| Applicatif, propre à la plateforme (base dédiée, cache dédié, workflows) | **Embarqué**, souvent dans son propre namespace | Le chart parapluie, en deux phases si des CR en dépendent (opérateur d'abord, `helm upgrade` avec `--wait`, puis les CR — ou un hook `post-install` qui attend le webhook) |

Ce que ça veut dire pour toi en avant-vente et en installation : **« quels opérateurs avez-vous déjà, en quelle version ? »** est une question de la première heure. `kubectl get crd | grep -E 'cert-manager|external-secrets|postgresql|nvidia'` y répond en 10 secondes, avec les versions dans `kubectl get deploy -A | grep -E 'cert-manager|external-secrets'` et les images.

---

## 9.4 Helm et les CRDs : le mécanisme et ses trous

Helm a un répertoire dédié, `crds/`, avec un comportement **volontairement limité** :

| À l'`install` | À l'`upgrade` | À l'`uninstall` |
|---|---|---|
| Les CRDs de `crds/` (du chart **et de ses sous-charts**) sont appliquées **avant** tout le reste, sans templating | **Rien.** Les CRDs ne sont ni mises à jour, ni ajoutées si nouvelles | **Rien.** Les CRDs restent (et donc les CR, et donc les données) |

La logique : supprimer une CRD supprime **en cascade toutes ses CR** — sur un opérateur de base de données, c'est la perte de toutes les bases. Helm préfère ne rien faire plutôt que risquer ça. Mais l'absence de mise à jour est un vrai problème : la version 3.9 du chart embarque cert-manager 1.16 dont la CRD `Certificate` a un nouveau champ ; tu montes de 3.8 à 3.9 ; la CRD reste en 1.14 ; la CR rendue par le chart utilise le nouveau champ → **rejetée** (`unknown field`) ou **élaguée** (9.1) selon la CRD, et l'opérateur 1.16 lit une CRD 1.14. Deux symptômes possibles pour une seule cause.

**La méthode qui marche** : extraire les CRDs du chart cible et les appliquer en server-side **avant** l'upgrade.

```bash
# 1. extraire — trois façons selon où sont les CRDs
helm show crds oci://…/platform --version 3.9.0 > /tmp/crds.yaml                     # celles de crds/ (chart + sous-charts)
helm template platform oci://…/platform --version 3.9.0 -f (pile) --include-crds \
  | yq -N 'select(.kind == "CustomResourceDefinition")' > /tmp/crds.yaml              # idem + celles de templates/
helm pull oci://…/platform --version 3.9.0 --untar && find platform -path '*/crds/*.yaml'   # à la main, pour lire

# 2. comparer avec l'existant avant d'appliquer
kubectl diff -f /tmp/crds.yaml --server-side

# 3. appliquer en server-side apply
kubectl apply --server-side -f /tmp/crds.yaml
# 4. seulement ensuite
helm upgrade platform … --version 3.9.0
```

Pourquoi `--server-side` et pas un `kubectl apply` ordinaire : un `apply` client-side stocke l'objet entier dans l'annotation `kubectl.kubernetes.io/last-applied-configuration`, limitée à 256 Ko ; les CRDs modernes (cert-manager, CNPG, Strimzi) dépassent → `metadata.annotations: Too long: must have at most 262144 bytes`. Le server-side apply n'a pas cette annotation. C'est le sujet de 9.5.

**L'autre pattern**, que tu verras dans certains charts : les CRDs dans `templates/` (donc templatées et mises à jour à l'upgrade) avec `helm.sh/resource-policy: keep` pour survivre à l'uninstall. Ça résout la mise à jour, mais l'`install` d'un chart neuf peut alors échouer sur les CR (`no matches for kind`) parce que Helm valide tout le rendu avant d'appliquer — d'où des charts qui exigent `--disable-openapi-validation` ou une installation en deux temps. Les deux patterns ont un trou ; le premier + l'extraction manuelle est le plus prévisible, et c'est ce que la procédure de mise à jour de la plateforme doit **documenter explicitement** (§19, question « procédure de mise à jour »).

Enfin, `--skip-crds` désactive même l'installation initiale (étape 8.9), et `helm diff` ne compare pas les CRDs de `crds/` : une montée de version « sans diff » peut cacher une CRD changée.

---

## 9.5 Server-side apply et la propriété des champs

Depuis Kubernetes 1.22, chaque objet garde dans `metadata.managedFields` **qui a écrit quel champ** : un *field manager* par écrivain (`kubectl-client-side-apply`, `helm`, `kube-controller-manager`, `hpa-controller`, l'opérateur X…).

Le **server-side apply** (`kubectl apply --server-side`, SSA) envoie ton manifeste à l'API server, qui fait lui-même la fusion et vérifie que **tu ne touches pas un champ possédé par un autre manager**. Sinon :

```
error: Apply failed with 1 conflict: conflict with "hpa-controller" using apps/v1: .spec.replicas
Please review the fields above--they currently have other managers. Here are the ways you can resolve this warning:
* If you intend to manage all of these fields, please re-run the apply command with the `--force-conflicts` flag.
* If you do not intend to manage all of these fields, please edit your manifest to remove references to the fields …
* You may co-own fields by updating your manifest to match the existing value …
```

Ce message est **excellent** : il te dit qui possède le champ et te laisse le choix. Trois cas concrets où tu le verras :

1. **Un contrôleur s'est approprié un champ après la création.** Tu crées un Deployment avec `replicas: 2` ; un HPA prend la main sur `replicas` ; ton prochain SSA du même manifeste conflicte. Solution propre : **retirer `replicas` de ton manifeste** (étape 2 et 7 : `{{- if not .Values.autoscaling.enabled }}`). Solution brutale : `--force-conflicts`, qui reprend la propriété — et l'HPA la reprendra au prochain cycle. Ping-pong.
2. **Un opérateur ou un webhook mutant a ajouté des champs** (defaults, annotations, un sidecar). Ils appartiennent au mutant ; tant que ton manifeste ne les mentionne pas, pas de conflit. Le jour où tu les copies « pour être complet » depuis un `kubectl get -o yaml`, tu deviens co-propriétaire et tu conflictes avec lui à la prochaine mutation.
3. **Deux outils appliquent le même objet** : un `kubectl apply` client-side puis un SSA (ou ArgoCD en SSA après Helm) : le manager `kubectl-client-side-apply` possède tout, le nouvel outil conflicte sur tout. `--force-conflicts` une fois pour migrer, puis un seul outil.

À savoir sur Helm : Helm 3 fait sa propre fusion à trois voies côté client (étape 7.4) et n'utilise pas SSA ; Helm 4 ajoute le support du server-side apply — vérifie la version de Helm sur ton poste et celle exigée par les scripts internes, le comportement à l'upgrade n'est pas le même.

Pour lire les propriétaires : `kubectl get deploy api --show-managed-fields -o yaml | yq '.metadata.managedFields[] | {manager, operation, time}'`.

---

## 9.6 Le décalage de version : une cause, plusieurs symptômes

C'est le cœur du §3, et c'est une compétence de diagnostic plus que de Kubernetes.

**La situation.** Une installation de plateforme fait intervenir plusieurs artefacts versionnés séparément : le **chart** (épinglé, ex. 3.8.0), un **outil de génération de configuration** (un CLI interne qui produit les values, les secrets, les CR à partir d'un fichier client — souvent lancé depuis un dépôt à `HEAD`), les **opérateurs** et leurs CRDs, la **doc**. Quand l'outil est à HEAD (fait pour le chart 3.9) et le chart à 3.8, on obtient **en même temps** :

- `values.schema.json` qui rejette une clé (`additionalProperty "inference.router" not allowed`) ;
- un `required "global.registry is required"` dans un sous-chart (la clé s'appelait `global.imageRegistry` en 3.8) ;
- une CR avec un champ inconnu élagué → l'opérateur applique un défaut → un composant tourne avec la mauvaise config sans aucune erreur ;
- une image `platform/router:` avec un tag vide (l'outil génère un composant qui n'existe pas en 3.8) → `ImagePullBackOff` ;
- un Job de migration qui échoue parce que la variable qu'il attend a changé de nom.

Cinq tickets, cinq pistes, cinq heures — ou une question posée en premier.

**La méthode : remonter de plusieurs symptômes hétérogènes à une cause unique.**

1. **Lister les symptômes sans les interpréter.** Message exact, composant, horodatage. Ne pas encore choisir lequel « est le vrai ».
2. **Chercher ce qu'ils ont en commun.** Sont-ils apparus ensemble ? Après quelle action (un `git pull`, un `helm upgrade`, une mise à jour d'outil, un nouveau cluster) ? Touchent-ils tous à la *forme* des objets (clés, champs, noms) plutôt qu'à leur *fonctionnement* (timeout, saturation) ? Des erreurs de **forme** simultanées sur plusieurs composants sans lien = presque toujours un désaccord de version.
3. **Relever toutes les versions en jeu, en une passe :**
   ```bash
   helm list -n platform                                   # version du chart déployé
   <outil> --version ; (cd repo-outil && git log -1 --format='%h %ci')   # version de l'outil et date
   grep -rn 'chart.*version\|platform.*3\.' fichier-client.yaml           # ce que le fichier client déclare
   kubectl get crd -o custom-columns=NAME:.metadata.name,VERSIONS:.spec.versions[*].name | grep <groupe>
   kubectl get deploy -A -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}' | grep -E 'operator|manager'
   helm version ; kubectl version --short
   ```
4. **Tester l'hypothèse « décalage »** avant toute correction locale : aligner l'outil sur la version du chart (`git checkout v3.8.0` du dépôt de l'outil, ou l'inverse : monter le chart) et regénérer. Si trois symptômes sur cinq disparaissent, c'est confirmé ; les deux qui restent sont de vrais problèmes, à traiter ensuite.
5. **Écrire la cause dans le compte rendu, pas les symptômes.** « Outil à HEAD (commit abc, 12 sept) utilisé avec chart 3.8.0 ; clés renommées en 3.9 » vaut mieux que cinq paragraphes.

**Modéliser le correctif par version.** Une plateforme qui vit a une **matrice de compatibilité** — et si elle n'existe pas, tu la construis en la vivant :

| Chart | Outil de config | cert-manager | CNPG | K8s | Notes |
|---|---|---|---|---|---|
| 3.8.x | v3.8.0 – v3.8.4 | ≥ 1.14 | 1.24.x | 1.28 – 1.31 | `global.imageRegistry` |
| 3.9.x | v3.9.0+ | ≥ 1.16 (nouvelle CRD `Certificate`) | 1.25.x | 1.29 – 1.32 | renommé `global.registry` ; router obligatoire |

Et **ce qu'on retire en montant** est aussi important que ce qu'on ajoute. Une montée de version est le moment de supprimer :
- les values de contournement d'un bug corrigé (`api.extraEnv: [{name: WORKAROUND_X…}]`) ;
- les briques devenues défaut (le `nogpu.yaml` si l'inférence déportée est désormais le mode par défaut) ;
- les CRDs appliquées à la main pour une version intermédiaire ;
- les fichiers expérimentaux qui ont motivé la montée.

Sinon les fichiers de values portent des strates archéologiques que plus personne n'ose toucher, et le prochain décalage de version est encore plus dur à lire.

**Le cas frère : les dépréciations de l'API Kubernetes.** Un chart écrit pour Kubernetes 1.24 rend `autoscaling/v2beta2` ; le client est en 1.30 où cette version n'existe plus → `no matches for kind HorizontalPodAutoscaler in version autoscaling/v2beta2`. Même famille de symptôme (forme, pas fonctionnement), même réflexe (versions d'abord). Outils : `pluto detect-helm -n platform`, `kubent`, et dans le chart `.Capabilities.APIVersions.Has` (étape 7.3).

---

## 9.7 Exercice — clavier en main

```bash
mkdir -p lab9 && cd lab9 && kubectl create namespace lab9 && kubens lab9
```

1. **Un opérateur préexistant : cert-manager.**
   ```bash
   helm repo add jetstack https://charts.jetstack.io && helm repo update
   helm search repo jetstack/cert-manager --versions | head -5     # note la dernière version
   kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/<version>/cert-manager.crds.yaml
   # lis l'erreur « Too long: must have at most 262144 bytes » si elle apparaît, puis :
   kubectl apply --server-side -f https://github.com/cert-manager/cert-manager/releases/download/<version>/cert-manager.crds.yaml
   helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --version <version> --wait
   kubectl get crd | grep cert-manager ; kubectl explain certificate.spec | head -30
   ```
   Crée un `ClusterIssuer` selfsigned et une `Certificate` `lab-tls` pour `lab.local` dans `lab9`. Suis `kubectl get certificate -w` jusqu'à `READY True`, puis `kubectl get secret lab-tls -o yaml | yq '.type, (.data | keys)'`. Lis `kubectl describe certificate lab-tls` : les Events sont ceux de l'opérateur.

2. **Une CR sans opérateur.** Supprime temporairement le Deployment de cert-manager (`kubectl -n cert-manager scale deploy cert-manager --replicas=0`), crée une seconde `Certificate` : elle est acceptée, et son `status` reste vide indéfiniment. Remets l'opérateur : elle se remplit. C'est le symptôme « personne ne lit ma CR ».

3. **Le webhook absent.** Scale à 0 `cert-manager-webhook`, puis tente de créer une troisième `Certificate` : `failed calling webhook`. Remets-le. Tu viens de voir pourquoi opérateur + CR dans une même release est une course.

4. **Ta propre CRD dans un chart, et le trou de l'upgrade.** Crée un chart `widgets/` (`version: 0.1.0`) avec dans `crds/widgets.yaml` une CRD `widgets.lab.example` (v1, Namespaced, schéma avec `spec.size: integer`) et dans `templates/` un `Widget` `demo` avec `spec.size: 3`. Installe. Puis version 0.2.0 : ajoute `spec.color: string` au schéma **et** `spec.color: blue` à la CR. `helm upgrade` :
   - Selon ton schéma (avec ou sans `x-kubernetes-preserve-unknown-fields`), soit l'upgrade échoue sur `unknown field "color"`, soit il passe et `kubectl get widget demo -o yaml` **n'a pas** `color`. Constate lequel des deux tu obtiens.
   - Répare avec la méthode : `helm show crds ./widgets > /tmp/crds.yaml && kubectl apply --server-side -f /tmp/crds.yaml && helm upgrade widgets ./widgets`. Vérifie `color` présent.
   - `helm uninstall widgets`, puis `kubectl get crd widgets.lab.example` : toujours là. `kubectl get widget -A` : la CR est partie avec la release, la CRD non.

5. **Conflit server-side apply.**
   ```bash
   cat > dep.yaml <<EOF
   apiVersion: apps/v1
   kind: Deployment
   metadata: { name: ssa }
   spec:
     replicas: 2
     selector: { matchLabels: { app: ssa } }
     template:
       metadata: { labels: { app: ssa } }
       spec: { containers: [ { name: web, image: nginx:1.27 } ] }
   EOF
   kubectl apply --server-side --field-manager=deploy-a -f dep.yaml
   kubectl get deploy ssa --show-managed-fields -o yaml | yq '.metadata.managedFields[] | {manager, operation}'
   sed 's/replicas: 2/replicas: 3/' dep.yaml | kubectl apply --server-side --field-manager=deploy-b -f -    # conflit : lis le message en entier
   sed 's/replicas: 2/replicas: 3/' dep.yaml | kubectl apply --server-side --field-manager=deploy-b --force-conflicts -f -
   kubectl apply --server-side --field-manager=deploy-a -f dep.yaml     # conflit dans l'autre sens : deploy-b possède replicas
   ```
   Puis le cas réel : `kubectl autoscale deploy ssa --min=1 --max=3 --cpu-percent=50` (metrics-server est là depuis l'étape 2), attends une minute, et réapplique `dep.yaml` en SSA avec `deploy-a` : qui possède `replicas` maintenant ? Retire `replicas` du fichier et réapplique : plus de conflit.

6. **Le décalage de version, simulé.** Reprends le parapluie de l'étape 8. Crée une version 0.2.0 du chart `api` où `db.host` devient `database.host` et où une nouvelle value `router.enabled` est **requise** (`required`), et un `values.schema.json` strict (`additionalProperties: false`). Ensuite, **sans lire la suite**, lance le parapluie 0.1.0 (ancien `api`) avec un fichier de values écrit pour 0.2.0 (`api.database.host`, `api.router.enabled: true`), puis l'inverse (parapluie avec `api` 0.2.0 et values 0.1.0). Note **tous** les messages d'erreur obtenus dans chaque sens, sans les interpréter. Puis applique la méthode de 9.6 : liste, point commun, versions, hypothèse, test. Écris le compte rendu en trois lignes, cause d'abord.

7. **Dépréciation d'API.** `helm template` de ton parapluie avec `--kube-version 1.25.0` puis `--api-versions autoscaling/v2beta2/HorizontalPodAutoscaler` : selon ce que tu as écrit avec `.Capabilities` à l'étape 7, l'HPA change d'`apiVersion` ou non. Installe `pluto` (`brew install FairwindsOps/tap/pluto`) et lance `pluto detect-files -d .` sur le rendu.

8. **Nettoie** : `kubectl delete namespace lab9`, `kubectl delete crd widgets.lab.example` (à la main, puisque Helm ne le fait pas — et observe que ça ne supprime plus rien d'autre). Garde cert-manager, il resservira à l'étape 12.

---

## Validé si…

- Tu sais expliquer ce qu'est une CRD, un opérateur, et lire `status.conditions` d'une CR.
- Tu sais dire pourquoi cert-manager ne doit pas être dans le chart parapluie, et comment vérifier en 10 secondes quels opérateurs un client a déjà.
- Tu sais ce que Helm fait des CRDs à l'install, à l'upgrade, à l'uninstall — et la procédure d'extraction + `apply --server-side` avant un upgrade.
- Tu sais lire un message de conflit SSA, dire qui possède le champ, et choisir entre retirer le champ et `--force-conflicts`.
- Tu sais reconnaître un « bouquet » de symptômes de forme, relever toutes les versions en une passe, et écrire un compte rendu qui commence par la cause.
- Tu sais ce qu'on **retire** des values en montant de version.

**Étape suivante** : `etape-10-multi-environnement-clients.md` — GKE, OpenShift, on-prem, air-gapped : ce qui change, ce qu'il faut demander, et comment un même chart s'adapte.
