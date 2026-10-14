# Étape 8 — Chart parapluie et gestion des values

**Objectif** : à la fin de cette étape, tu sais lire et faire évoluer un chart parapluie de plusieurs dizaines de sous-charts, organiser des values par client et par environnement sans te perdre, comprendre exactement comment elles se fusionnent, et utiliser `helm template` / `helm diff` comme instruments de compréhension — en connaissant leurs angles morts. Tu sais aussi récupérer et mettre en miroir charts et images pour un client fermé.

**Notions couvertes** : §2 (packaging & distribution applicative), sauf CRDs → étape 9.

**Prérequis** : étape 7. Le chart `api` de son exercice est réutilisé.

---

## 8.1 Dépendances : un chart qui embarque des charts

Un chart déclare ses dépendances dans `Chart.yaml` :

```yaml
apiVersion: v2
name: platform
version: 3.8.0
dependencies:
  - name: api
    version: "1.4.x"                         # contrainte semver
    repository: "oci://registry.example.com/charts"
    condition: api.enabled                   # rendu seulement si cette value est vraie
  - name: api
    alias: worker                            # même chart, second exemplaire, sous un autre nom
    version: "1.4.x"
    repository: "oci://registry.example.com/charts"
    condition: worker.enabled
  - name: postgresql
    version: "16.2.1"
    repository: "https://charts.example.com"
    condition: postgresql.enabled
    tags: [datastores]                       # activer/désactiver un groupe : tags.datastores=false
  - name: common
    version: "2.x"
    repository: "file://../common"           # chart local, pratique en mono-dépôt
```

```bash
helm dependency update ./platform    # résout les versions, écrit Chart.lock, télécharge dans charts/*.tgz
helm dependency build ./platform     # même chose à partir de Chart.lock (versions figées) — celui de la CI
helm dependency list ./platform      # statut : ok / missing / wrong version
```

Ce qu'il faut retenir :
- **`Chart.lock`** fige les versions exactes résolues ; `charts/` contient les archives. Les deux vont dans git (ou au moins le lock). Un `update` change potentiellement les versions ; un `build` jamais.
- **`condition`** est une value du chart parent (`api.enabled`), pas une propriété du sous-chart. Elle prime sur `tags`. Si la value n'existe pas, le sous-chart est **rendu** (défaut : activé).
- **`alias`** permet d'installer deux fois le même chart : la clé de values devient l'alias (`worker.image.tag`).
- Une dépendance de dépendance est résolue par le sous-chart lui-même : un parapluie ne contrôle pas directement les versions de la couche en dessous.

---

## 8.2 Comment les values circulent entre parent et sous-charts

C'est le mécanisme central du parapluie, et il est simple à condition de le voir comme un arbre de clés.

**Vers le bas.** Dans les values du parent, tout ce qui est sous la clé portant le nom (ou l'alias) d'un sous-chart **devient `.Values` de ce sous-chart** :

```yaml
# values.yaml du parent « platform »
api:                         # → .Values du sous-chart api
  replicaCount: 3
  image:
    tag: "2.11.0"
worker:                      # → .Values du sous-chart aliasé worker
  replicaCount: 1
postgresql:
  auth:
    database: platform
```

Le sous-chart ne voit **que** sa sous-clé : dans les templates de `api`, `.Values.replicaCount` vaut 3 ; `.Values.postgresql` n'existe pas.

**`global`.** La seule clé visible partout : `.Values.global.*` est identique dans le parent et dans **tous** les sous-charts, quel que soit le niveau. C'est là que vivent le domaine, le registre d'images, le pull secret, la StorageClass, la classe d'ingress :

```yaml
global:
  domain: chat.client.example
  imageRegistry: registry.client.example/mirror
  imagePullSecrets: [regcred]
  storageClass: fast
  ingressClassName: nginx-internal
```

Un sous-chart bien écrit lit `global` en priorité avec repli sur sa value locale : `{{ .Values.global.storageClass | default .Values.persistence.storageClass }}`. Un sous-chart tiers qui **ignore** `global.imageRegistry` t'obligera à surcharger son `image.repository` explicitement : c'est le premier réflexe quand une image continue de pointer vers `docker.io` en air-gapped.

**Vers le haut.** Un sous-chart peut *exporter* des values vers son parent via `import-values` dans la dépendance — rare, et surtout utilisé pour remonter des valeurs de chart « library ».

**Les templates nommés sont globaux.** `include "api.fullname"` fonctionne depuis le parent si le sous-chart `api` est chargé. C'est aussi pour ça que deux sous-charts définissant `common.labels` s'écrasent silencieusement (le dernier chargé gagne) : d'où les préfixes par chart (étape 7.3).

**Library chart.** Un chart `type: library` ne rend rien ; il ne fournit que des templates nommés que les autres incluent. C'est ainsi qu'un parapluie de 40 composants partage un seul `deployment` générique paramétré, au lieu de 40 copies divergentes. Quand tu vois `{{ include "common.deployment" (list . "api.values") }}` dans un sous-chart, c'est ça.

---

## 8.3 Ordre de précédence des values

De la plus faible à la plus forte :

1. `values.yaml` de chaque **sous-chart** (ses défauts) ;
2. `values.yaml` du **parent**, section du sous-chart (surcharge les défauts du sous-chart) ;
3. les fichiers **`-f`**, dans l'ordre de la ligne de commande — **le dernier gagne** ;
4. **`--set`**, `--set-string`, `--set-file`, `--set-json` — après tous les fichiers.

La fusion est **profonde pour les dictionnaires** et **par remplacement pour les listes et les scalaires** :

```yaml
# -f base.yaml
api:
  resources: { requests: { cpu: 500m, memory: 1Gi } }
  tolerations:
    - { key: gpu, operator: Exists }
# -f client.yaml
api:
  resources: { requests: { memory: 2Gi } }        # cpu: 500m est CONSERVÉ (fusion de dictionnaire)
  tolerations:
    - { key: spot, operator: Exists }              # la liste est REMPLACÉE : gpu disparaît
```

Deux conséquences pratiques :
- Pour **retirer** une clé posée par un fichier plus bas, on ne peut pas la « supprimer » : on la met à `null`. `api.ingress.annotations.foo: null` efface la clé ; c'est aussi le seul moyen d'annuler un défaut de sous-chart.
- Une **liste** (tolerations, env, extraVolumes, hosts d'ingress) doit être écrite **en entier** dans le fichier qui la surcharge. C'est le point 8.5 sur `--set`.

`helm get values <release>` montre ce qui a été fourni ; `--all` ajoute les défauts ; `helm template --debug` affiche en tête les **values fusionnées** — le plus rapide pour savoir « ce que le chart a vraiment reçu ».

---

## 8.4 Organiser les overrides : socle, briques, expérimental

Avec des dizaines de clients, la seule discipline qui tienne est une **hiérarchie de fichiers dont chacun a une seule raison d'exister**, empilés dans un ordre fixe.

```
values/
├── base/
│   └── 3.8.yaml              # SOCLE VERSIONNÉ : les réglages du produit pour la version 3.8 du chart
├── platform/                  # BRIQUES RÉUTILISABLES : une par dimension d'environnement
│   ├── gke.yaml               #   ingress class gce/nginx, StorageClass rwo, LB, Workload Identity
│   ├── openshift.yaml         #   routes, pas d'UID, SCC, StorageClass ODF
│   ├── onprem-rke2.yaml
│   ├── airgap.yaml            #   global.imageRegistry, pull secrets, désactivation des appels sortants
│   ├── gpu-nvidia.yaml        #   tolerations, nodeSelector, device plugin
│   └── inference-remote.yaml  #   inférence déportée (pas de GPU) — §7
├── clients/
│   ├── acme/
│   │   ├── common.yaml        #   domaine, IdP, registre, tailles — ce qui est vrai pour tous ses envs
│   │   ├── preprod.yaml       #   ce qui diffère en preprod (répliques, TTL, modèles activés)
│   │   └── prod.yaml
│   └── globex/…
└── experimental/
    └── acme-prod-debug-2026-09.yaml   # FICHIERS EXPÉRIMENTAUX : datés, jetables, jamais en CI
```

```bash
helm upgrade --install platform oci://…/platform --version 3.8.0 -n platform \
  -f values/base/3.8.yaml \
  -f values/platform/gke.yaml \
  -f values/platform/gpu-nvidia.yaml \
  -f values/clients/acme/common.yaml \
  -f values/clients/acme/prod.yaml \
  -f secrets/acme-prod.yaml            # hors git, chiffré (sops) ou généré par ESO — étape 6
```

Les règles qui vont avec :
- **Du général au particulier**, toujours dans le même ordre. Un fichier client ne contient que ce qui **diffère** des briques ; s'il répète une brique, c'est que la brique est mal découpée.
- **Le socle porte la version du chart** : monter de 3.8 à 3.9 commence par écrire `base/3.9.yaml` (et par lire le changelog pour savoir quelles clés ont changé — étape 9).
- **Une brique = une dimension** (cloud, GPU, air-gapped, mode d'inférence). Un client est la combinaison de briques + ses spécificités. Si tu te retrouves à écrire `gke-gpu-airgap.yaml`, tu as perdu.
- **Un fichier expérimental est daté, nommé par son auteur et sa raison, et supprimé** quand l'expérience est finie ou promue dans un fichier client. Un `debug.yaml` de six mois dans une CI, personne ne sait plus s'il est nécessaire.
- **L'appel Helm complet est un script versionné** (Makefile, `helmfile.yaml`, ou une Application ArgoCD listant les fichiers dans l'ordre). Jamais une commande recopiée d'un wiki.

Sur ce dernier point : **helmfile** et **ArgoCD** (étape 24) sont exactement des outils pour décrire « ce chart, cette version, ces fichiers dans cet ordre, ce namespace » de façon déclarative. Un `helmfile.yaml` ressemble à la commande ci-dessus mise en YAML, avec des environnements nommés.

---

## 8.5 `--set` et les listes : le piège précis

`--set` est fait pour un scalaire à la volée (`--set api.image.tag=2.11.1`). Sur une liste, il ne **fusionne pas** : il remplace l'**élément entier** à l'index donné, et ne sait ni ajouter ni supprimer proprement.

```bash
# values : api.tolerations = [{key: gpu, operator: Exists, effect: NoSchedule}]
helm template … --set 'api.tolerations[0].key=spot'
# résultat : [{key: spot, operator: Exists, effect: NoSchedule}]   → OK par hasard, l'index existait
helm template … --set 'api.tolerations[1].key=spot'
# résultat : [{…gpu…}, {key: spot}]                                → élément incomplet, toleration invalide
helm template … --set 'api.env[0].value=x'
# écrase le premier env défini dans les values, quel qu'il soit
```

Ajoute à ça la coercition de type (`--set tag=1.10` → nombre `1.1` ; `--set enabled=false` → booléen, `--set-string enabled=false` → chaîne), les échappements (`,` dans une valeur, `.` dans une clé d'annotation : `--set 'ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-body-size=50m'`), et la disparition à l'upgrade suivant si on oublie `--reuse-values`.

Règle : **toute liste, toute annotation, tout ce qui a plus d'un niveau passe par un fichier `-f`.** `--set` reste pour un tag d'image ou un booléen en session de debug — et ce que tu as mis en `--set`, tu le reportes dans un fichier avant de fermer ton terminal.

---

## 8.6 `helm template` et `--dry-run` comme instruments de compréhension

Sur un parapluie, la première question est toujours « qu'est-ce que ça va réellement rendre ? ». Les outils :

```bash
# rendu complet, hors cluster
helm template platform ./platform -f … > /tmp/rendered.yaml
grep -c '^kind:' /tmp/rendered.yaml                          # combien d'objets
yq 'select(.kind == "Deployment") | .metadata.name' /tmp/rendered.yaml
yq 'select(.kind == "Deployment") | .spec.template.spec.containers[].image' /tmp/rendered.yaml | sort -u   # toutes les images

# un seul template d'un sous-chart
helm template platform ./platform -f … --show-only charts/api/templates/deployment.yaml

# values fusionnées + rendu
helm template platform ./platform -f … --debug 2>&1 | less

# rendu validé par l'API du cluster (schéma, admission, webhooks — sans rien écrire)
helm upgrade --install platform ./platform -f … --dry-run=server --debug

# ce qui changerait par rapport au déployé
helm diff upgrade platform ./platform -f … --context 3
```

**Les limites, à connaître pour ne pas se faire piéger :**

1. **Un sous-chart qui ne se rend pas sans ses `global`.** Beaucoup de sous-charts font `{{ required "global.domain is required" .Values.global.domain }}` ou `{{ .Values.global.imageRegistry }}/…`. Lancé avec un jeu de values incomplet, `helm template` échoue sur un sous-chart que tu ne regardais même pas, ou rend une image `/api:2.11` avec un registre vide. Toujours rendre avec **la pile complète** de fichiers de l'environnement visé, pas avec `values.yaml` seul.
2. **`lookup` renvoie vide** hors cluster et en `--dry-run` client (étape 7.3). Un mot de passe « réutilisé s'il existe » apparaît régénéré dans `helm template` alors qu'il ne le sera pas à l'`upgrade`. `--dry-run=server` corrige ça.
3. **`.Capabilities`** hors cluster = valeurs par défaut de Helm. Passe `--kube-version 1.28.0` et `--api-versions networking.k8s.io/v1/Ingress` pour rendre comme sur le cluster du client.
4. **Les webhooks mutants** (étape 6.5) ne s'appliquent pas au rendu : ce qui tournera peut différer de ce que tu vois. `--dry-run=server` les fait passer, mais seulement en validation ; pour voir la mutation, il faut comparer avec `kubectl get -o yaml` après coup.
5. **`helm template` ne connaît pas l'état de la release** : il ne dit pas ce qui va être supprimé (un sous-chart passé à `enabled: false` disparaît du rendu sans avertissement). C'est le rôle de `helm diff`, qui montre les `-`.
6. Les **CRDs de `crds/`** ne sont pas dans le rendu de `helm template` (sauf `--include-crds`), et `helm diff` ne les compare pas. Étape 9.

---

## 8.7 Récupérer des versions dans un registre OCI

Un registre OCI expose ses tags par `GET /v2/<name>/tags/list`. Beaucoup de registres d'entreprise (ou de règles de proxy) **refusent le listing** tout en autorisant le pull d'un tag précis : `helm search` ne fonctionne pas sur OCI, et `crane ls` ou `oras repo tags` renvoient 401/403.

Ce qui marche alors :

```bash
# 1. Si le listing passe :
crane ls registry.example.com/charts/platform          # ou : oras repo tags registry.example.com/charts/platform

# 2. Sinon, sonder les versions candidates une par une — helm show chart est léger (métadonnées seulement)
for v in 3.8.0 3.8.1 3.8.2 3.9.0 3.9.1; do
  helm show chart oci://registry.example.com/charts/platform --version $v >/dev/null 2>&1 \
    && echo "OK  $v" || echo "--  $v"
done

# 3. Depuis un chart déjà installé, la version en cours et son Chart.lock disent d'où partir
helm list -n platform                                   # colonne CHART : platform-3.8.0
helm get all platform -n platform | head -30
```

Sonder est bête mais fiable : on part de la version installée, on incrémente patch puis minor. Note ce que tu as sondé pour ne pas le refaire.

---

## 8.8 Miroir de charts et d'images pour un registre interne

Un client fermé (air-gapped ou simplement « pas de docker.io ») exige que **tout** — charts et images — vienne de son registre. Deux stratégies, qu'il faut distinguer avant de faire quoi que ce soit.

**Pull-through (miroir proxy).** Le registre interne est configuré comme **cache** d'un registre amont : la première demande d'`registry.client/mirror/library/nginx:1.27` va chercher `docker.io/library/nginx:1.27`, la garde, et sert les suivantes. Rien à pousser : il suffit que `global.imageRegistry` pointe sur le miroir et que le préfixe corresponde. Harbor, Artifactory, Nexus et GCP Artifact Registry (« remote repository ») savent le faire. C'est **la** solution par défaut à proposer, parce qu'elle ne demande pas de maintenir une liste d'images à jour — le cache se remplit à l'usage. Ses limites : il faut une sortie réseau (même filtrée) du registre vers l'amont, et des identifiants pour les registres privés amont.

**Push (copie explicite).** En vrai air-gapped, aucune sortie : on copie chaque artefact depuis une machine connectée vers une machine à l'intérieur (par fichier, disque, ou sas). Il faut alors la **liste exhaustive** des images du rendu, pour la pile de values exacte du client :

```bash
# la liste des images — depuis le rendu, jamais de mémoire
helm template platform … -f (pile complète du client) --include-crds \
  | yq -N 'select(.kind == "Deployment" or .kind == "StatefulSet" or .kind == "DaemonSet" or .kind == "Job" or .kind == "CronJob")
           | .spec.template.spec | (.containers[], .initContainers[]?) | .image' \
  | sort -u > images.txt
# ⚠ ne couvre pas : les images référencées dans une CRD (opérateurs qui lancent leurs propres pods), ni les images tirées par un init container « télécharge-moi ça »
# → compléter avec les images des opérateurs, et vérifier après installation avec :
kubectl get pods -A -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{range .spec.initContainers[*]}{.image}{"\n"}{end}{end}' | sort -u

# copier les images (sans daemon Docker, par digest, multi-arch géré)
while read img; do crane copy "$img" "registry.client/mirror/${img#*/}"; done < images.txt
# ou : skopeo copy docker://$img docker://registry.client/mirror/… ; ou en deux temps via tar : crane pull → crane push

# copier les charts
helm pull oci://registry.example.com/charts/platform --version 3.8.0     # platform-3.8.0.tgz (contient charts/*.tgz des sous-charts)
helm push platform-3.8.0.tgz oci://registry.client/charts
```

Les pièges vécus :
- **Le tag n'est pas l'image.** Copier par tag un jour, et le tag amont bouge le lendemain : deux clients « en 3.8.0 » avec des binaires différents. Copie par **digest**, et fais rendre les digests par le chart quand c'est possible (`image: repo@sha256:…`).
- **Le préfixe du miroir.** `docker.io/library/nginx` devient `registry.client/mirror/library/nginx` ou `registry.client/dockerhub/nginx` selon la configuration du registre du client : `global.imageRegistry` seul ne suffit pas toujours, il faut parfois surcharger `image.repository` sous-chart par sous-chart. Vérifie avec `helm template | grep image:` **avant** d'installer.
- **La CA du registre.** Un registre interne avec un certificat d'entreprise donne `x509: certificate signed by unknown authority` à `ImagePull` : c'est le **nœud** (containerd) qui doit connaître la CA, pas ton chart. À signaler au client, pas à contourner.
- **Un sous-chart tiers qui ignore `global.imageRegistry`** (8.2) est le cas le plus fréquent d'image qui continue de pointer vers `docker.io`.

---

## 8.9 Les flags « raccourcis » qui font plus que leur nom

Certains flags désactivent plus qu'ils n'en ont l'air. Ceux qui ont déjà coûté des heures :

| Flag | Ce qu'on croit | Ce qu'il fait aussi |
|---|---|---|
| `helmfile … --skip-deps` | « ne pas retélécharger les dépendances » | Saute **aussi** `helm repo update` : tu déploies avec un index de dépôt périmé, et une version « introuvable » qui existe pourtant. Et si `charts/` est vide, le rendu échoue sur un sous-chart manquant avec un message sans rapport |
| `helm … --no-hooks` | « pas de tests » | Saute **toutes** les migrations `pre-upgrade` : l'application démarre sur un schéma ancien |
| `helm … --skip-crds` | « les CRDs sont déjà là » | Si elles ne le sont pas, les objets custom du chart sont refusés (`no matches for kind`) |
| `helm … --reuse-values` | « garder mes réglages » | Ignore les **nouveaux défauts** du chart à la montée de version : une value renommée garde son ancienne valeur, muette |
| `helm … --disable-openapi-validation` | « contourner un schéma trop strict » | Laisse passer des manifestes invalides que l'API rejettera au pire moment |
| `helm … --force` | « forcer l'upgrade » | Supprime et recrée : coupure de service, PVC d'un StatefulSet potentiellement orphelins |
| `helm dependency build --skip-refresh` | « plus rapide » | N'actualise pas les index : versions résolues sur une vue ancienne |

Principe : avant d'utiliser un flag de contournement, lire `helm <commande> --help` sur **ce** flag, et se demander ce qu'il désactive d'autre. Un flag posé pour aller plus vite un jour de debug ne doit pas se retrouver dans le script de déploiement sans un commentaire qui dit pourquoi.

---

## 8.10 Exercice — construire un parapluie et deux environnements

```bash
mkdir -p lab8 && cd lab8 && kubectl create namespace lab8 && kubens lab8
cp -r ../lab7/api ./api            # le chart de l'étape 7
```

1. **Un second chart : `db`.** Écris un chart minimal `db/` : StatefulSet postgres 1 réplica (étape 5), Service headless, `persistence.{storageClass,size}` avec repli sur `global.storageClass`, `auth.existingSecret` ou secret généré avec `lookup`. Ajoute au chart `api` la lecture de `global.imageRegistry` (préfixe de `image.repository` s'il est défini) et de `global.ingressClassName`.

2. **Le parapluie.** `platform/Chart.yaml` avec trois dépendances `file://` : `api` (condition `api.enabled`), `api` aliasé `worker` (condition `worker.enabled`), `db` (condition `db.enabled`, tag `datastores`). `platform/values.yaml` : `global.{domain,imageRegistry,storageClass,ingressClassName}` vides, `api.enabled: true`, `worker.enabled: true`, `db.enabled: true`, et sous `api:` le `db.host` pointant vers le Service du sous-chart db (`platform-db`) — devine le nom avec `helm template` avant de l'écrire.
   ```bash
   helm dependency update ./platform && cat platform/Chart.lock && ls platform/charts
   helm template platform ./platform | grep -E '^kind:|^  name:' | paste - - | sort | uniq -c
   ```

3. **La hiérarchie de values.** Crée :
   - `values/base/0.1.yaml` : ressources et probes du produit ;
   - `values/platform/kind.yaml` : `global.storageClass: standard`, `global.ingressClassName: nginx`, service ClusterIP ;
   - `values/platform/nogpu.yaml` : `worker.enabled: false` ;
   - `values/clients/acme/common.yaml` : `global.domain: acme.lab.local`, `api.ingress.enabled: true`, `api.ingress.host: "chat.{{ .Values.global.domain }}"` (via `tpl` dans le sous-chart) ;
   - `values/clients/acme/preprod.yaml` : `api.replicaCount: 1`, `db.persistence.size: 1Gi` ;
   - `values/clients/acme/prod.yaml` : `api.replicaCount: 3`, `api.autoscaling.enabled: true`, `db.persistence.size: 5Gi`.
   Écris un `deploy.sh acme preprod|prod` qui empile les fichiers dans le bon ordre et lance `helm upgrade --install`.

4. **Rends les deux environnements et compare.**
   ```bash
   ./deploy.sh acme preprod --template > /tmp/preprod.yaml     # ajoute un mode --template à ton script
   ./deploy.sh acme prod    --template > /tmp/prod.yaml
   diff <(yq -P 'sort_keys(..)' /tmp/preprod.yaml) <(yq -P 'sort_keys(..)' /tmp/prod.yaml)
   ```
   Tu dois voir exactement : replicas, la taille du PVC, la présence de l'HPA — et **rien d'autre**. Tout diff inattendu est un bug de values.

5. **La limite « sous-chart sans global ».** `helm template platform ./platform -f values/base/0.1.yaml` seul (sans la brique kind ni le client). Selon ce que tu as mis en `required`, ça échoue sur `db` ou rend un ingress sans classe. Observe, et retiens : rendre = rendre avec la pile complète.

6. **Installe preprod, puis diff vers prod.**
   ```bash
   ./deploy.sh acme preprod
   helm plugin install https://github.com/databus23/helm-diff 2>/dev/null
   ./deploy.sh acme prod --diff             # helm diff upgrade … ; lis les + et les -
   ```
   Puis passe `db.enabled: false` dans un fichier expérimental daté et refais `--diff` : le StatefulSet apparaît en `-`. `helm template` ne t'aurait rien dit.

7. **`--set` sur une liste.** Avec `api.tolerations` à deux éléments dans `base/0.1.yaml`, tente `--set 'api.tolerations[0].key=spot'` puis `--set 'api.tolerations[2].key=x'` et regarde le rendu. Refais-le proprement par fichier.

8. **`null` pour effacer.** Dans `prod.yaml`, ajoute `api.ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-body-size: null` pour retirer une annotation posée par `common.yaml`. Vérifie au rendu.

9. **Registre OCI local, miroir, sondage.**
   ```bash
   docker run -d -p 5000:5000 --name reg registry:2
   helm package ./platform && helm push platform-0.1.0.tgz oci://localhost:5000/charts
   # bump version 0.1.1 et 0.2.0, package, push
   crane ls localhost:5000/charts/platform                    # listing autorisé ici
   for v in 0.1.0 0.1.1 0.1.2 0.2.0; do helm show chart oci://localhost:5000/charts/platform --version $v >/dev/null 2>&1 && echo "OK $v" || echo "-- $v"; done
   # miroir d'images
   helm template platform ./platform -f (pile preprod) | yq -N '… .image' | sort -u > images.txt   # requête de 8.8
   while read img; do crane copy "$img" "localhost:5000/mirror/${img#*/}" --insecure; done < images.txt
   crane ls localhost:5000/mirror/library/nginx --insecure
   ```
   Passe `global.imageRegistry: localhost:5000/mirror` et rends : chaque `image:` doit commencer par le miroir. Celles qui ne le font pas sont tes sous-charts qui ignorent `global`.

10. **Un flag de trop.** `helm upgrade --install platform ./platform (pile) --no-hooks` : le Job de migration de `api` ne tourne pas. Puis `rm -rf platform/charts && helm upgrade --install … ` : lis l'erreur de dépendance manquante et note à quoi elle ressemble — c'est celle que `--skip-deps` produit dans helmfile.

11. **Nettoie** : `helm uninstall platform`, `kubectl get pvc` (les PVC de `db` sont restés — étape 5), `kubectl delete namespace lab8`, `docker rm -f reg`.

---

## Validé si…

- Tu sais dessiner l'arbre des values d'un parapluie et dire quelle clé chaque sous-chart voit.
- Tu sais donner l'ordre de précédence, expliquer fusion profonde vs remplacement de liste, et effacer une clé avec `null`.
- Tu sais organiser des values en socle / briques / clients / expérimental et justifier chaque fichier.
- Tu sais pourquoi `--set` sur une liste est interdit, et pourquoi `helm template` peut échouer ou mentir sur un parapluie.
- Tu sais sonder les versions d'un chart OCI sans listing, et distinguer miroir pull-through et copie explicite.
- Tu sais nommer trois flags de contournement et ce qu'ils désactivent en plus.

**Étape suivante** : `etape-09-crds-operateurs-versions.md` — CRDs, opérateurs, `crds/` non mis à jour, server-side apply, et le couplage entre version d'outillage et version de chart.
