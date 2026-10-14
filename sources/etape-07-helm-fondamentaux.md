# Étape 7 — Helm fondamentaux

**Objectif** : à la fin de cette étape, tu sais lire n'importe quel chart, écrire un chart propre pour une application, comprendre exactement ce que font `install`, `upgrade`, `rollback` et un hook, et diagnostiquer un rendu qui ne fait pas ce que tu attends. C'est le socle pour les charts parapluie de l'étape 8.

**Prérequis** : étapes 1 à 6. Tu as déjà lancé `helm create` à l'étape 0.

---

## 7.1 Ce qu'est Helm, en quatre mots

- Un **chart** est un paquet : des templates de manifestes Kubernetes + des valeurs par défaut + des métadonnées. C'est un répertoire (ou une archive `.tgz`).
- Une **release** est une instance installée d'un chart, avec un nom, dans un namespace. Le même chart installé deux fois donne deux releases.
- Les **values** sont les paramètres : le chart les rend en manifestes.
- Un **repository** (ou un registre OCI) distribue des charts versionnés.

Helm 3 est un **client pur** : pas de composant dans le cluster. Une release est mémorisée dans un **Secret** du namespace (`sh.helm.release.v1.<nom>.v<révision>`, type `helm.sh/release.v1`) qui contient le manifeste rendu, les values et le statut. C'est pourquoi `helm list` dépend du namespace, et pourquoi un client qui refuse l'accès aux Secrets t'empêche d'utiliser Helm.

Et rappel de l'étape 2 : Helm ne réconcilie pas. Il applique au moment où tu le lances, puis ne regarde plus rien.

---

## 7.2 Anatomie d'un chart

```
api/
├── Chart.yaml            # métadonnées, version, dépendances
├── values.yaml           # valeurs par défaut — c'est la DOCUMENTATION du chart
├── values.schema.json    # (optionnel) validation des values
├── templates/
│   ├── _helpers.tpl      # templates nommés réutilisables, ne produit rien seul
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── configmap.yaml
│   ├── ingress.yaml
│   ├── hpa.yaml
│   ├── serviceaccount.yaml
│   ├── NOTES.txt         # texte affiché après install (rendu aussi)
│   └── tests/
│       └── test-connection.yaml
├── charts/               # sous-charts (dépendances) empaquetés
├── crds/                 # CRDs installées avant tout, jamais templatées, jamais mises à jour (étape 9)
└── .helmignore
```

```yaml
# Chart.yaml
apiVersion: v2              # Helm 3
name: api
description: API de la plateforme
type: application           # ou library (étape 8)
version: 1.4.2              # version DU CHART (semver) — bump à chaque modification du chart
appVersion: "2.11.0"        # version DE L'APPLICATION — informatif, souvent utilisé comme tag d'image par défaut
kubeVersion: ">=1.27.0-0"   # contrainte sur le cluster
dependencies: []            # étape 8
```

La distinction `version` / `appVersion` compte : le chart peut changer (nouveau paramètre) sans que l'application change, et inversement. Convention courante : `image.tag` vide → le template utilise `.Chart.AppVersion`.

---

## 7.3 Le templating

Les templates sont du **Go template** enrichi des fonctions **Sprig** et de quelques fonctions Helm. Le rendu produit du YAML qui est ensuite envoyé à l'API. Deux conséquences : Helm ne comprend pas le YAML qu'il rend (c'est du texte), et **l'indentation est ton problème**.

### Les objets accessibles

| Objet | Contient |
|---|---|
| `.Values` | Le résultat de la fusion `values.yaml` + fichiers `-f` + `--set` |
| `.Release` | `.Name`, `.Namespace`, `.IsInstall`, `.IsUpgrade`, `.Revision` |
| `.Chart` | Le contenu de `Chart.yaml` : `.Name`, `.Version`, `.AppVersion` |
| `.Capabilities` | Ce que le cluster sait faire : `.KubeVersion`, `.APIVersions.Has "networking.k8s.io/v1/Ingress"` |
| `.Template` | `.Name` (chemin du template courant), `.BasePath` |
| `.Files` | Lire des fichiers du chart (`.Files.Get "config/app.conf"`) |

### La syntaxe minimale

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "api.fullname" . }}
  labels:
    {{- include "api.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "api.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
      labels:
        {{- include "api.selectorLabels" . | nindent 8 }}
    spec:
      serviceAccountName: {{ include "api.serviceAccountName" . }}
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          env:
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.db.existingSecret | default (printf "%s-db" (include "api.fullname" .)) }}
                  key: password
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
```

Ce qu'il faut comprendre ligne par ligne :

- **`{{- ` et ` -}}`** : le tiret avale les espaces et retours à la ligne du côté où il est. Sans lui, chaque `{{ if }}` laisse une ligne vide ou décale l'indentation. Règle pratique : `{{-` à gauche presque toujours, `-}}` à droite presque jamais (il mange le retour à la ligne qui suit et colle deux lignes YAML).
- **`toYaml . | nindent N`** : le pattern universel pour injecter un bloc de values (resources, tolerations, affinity, env) tel quel. `nindent` ajoute un retour à la ligne puis indente chaque ligne de N espaces ; `indent` n'ajoute pas le retour à la ligne. Avec `{{-` devant, `nindent` est presque toujours le bon.
- **`with`** : change le contexte (`.` devient la valeur) **et** ne rend rien si la valeur est vide. C'est ce qui permet `nodeSelector` optionnel sans `if`.
- **`include "nom" .`** rend un template nommé en chaîne, qu'on peut piper ; `template "nom" .` l'écrit directement et ne se pipe pas. **Toujours `include`.**
- **`default`** : `{{ .Values.image.tag | default .Chart.AppVersion }}`. Attention : `default` considère `0`, `false` et `""` comme vides — pour un booléen qui peut être `false`, utiliser `{{ if hasKey .Values "x" }}` ou `ternary`.
- **`$`** : la racine du contexte, à utiliser à l'intérieur d'un `with` ou d'un `range` où `.` a changé. `print $.Template.BasePath …` en est l'exemple.
- **`printf`**, **`quote`**, **`upper`**, **`trunc 63`**, **`trimSuffix "-"`**, **`b64enc`**, **`sha256sum`**, **`toYaml`/`fromYaml`**, **`dict`/`list`/`merge`**, **`ternary`**, **`required "message" .Values.x`**, **`empty`**, **`hasKey`**, **`coalesce`** — les fonctions Sprig que tu verras dans tous les charts. `required` fait échouer le rendu avec ton message si la valeur manque : c'est ce qu'il faut pour un hostname d'ingress ou un mot de passe.

### `_helpers.tpl` : les templates nommés

```yaml
{{/*
Nom complet, tronqué à 63 caractères (limite DNS des noms Kubernetes).
*/}}
{{- define "api.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "api.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "api.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{ include "api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
```

Les noms de templates sont **globaux** à toute la hiérarchie de charts : d'où le préfixe `api.` — sans lui, deux sous-charts définissant `fullname` s'écrasent (étape 8). La séparation `selectorLabels` (immuables : un selector de Deployment ne peut pas changer) / `labels` (tout le reste, dont la version qui change) est la convention standard — et une erreur de débutant classique est de mettre la version dans le selector, ce qui casse le premier `upgrade`.

### `tpl` : rendre une value qui contient un template
Un client veut écrire `host: "chat.{{ .Values.global.domain }}"` dans ses values. `{{ .Values.ingress.host }}` sortirait la chaîne brute ; `{{ tpl .Values.ingress.host . }}` la rend. Les charts parapluie en font un usage intensif.

### `lookup` : lire le cluster pendant le rendu
`{{ (lookup "v1" "Secret" .Release.Namespace "api-db").data.password }}` permet de réutiliser un secret existant (mot de passe généré une fois et conservé). **Mais** `lookup` renvoie vide en `helm template` et en `--dry-run` (client) : un chart qui en dépend se rend différemment hors cluster. Retiens-le pour l'étape 8, c'est une des limites de `helm template`.

### `.Capabilities` : s'adapter au cluster
```yaml
{{- if .Capabilities.APIVersions.Has "autoscaling/v2" }}
apiVersion: autoscaling/v2
{{- else }}
apiVersion: autoscaling/v2beta2
{{- end }}
```
Utile pour les clusters clients de versions variées ; même limite que `lookup` en `helm template` (il faut passer `--api-versions` ou `--kube-version`).

---

## 7.4 Le cycle de vie d'une release

```bash
helm install api ./api -n platform --create-namespace -f values-prod.yaml
helm upgrade api ./api -n platform -f values-prod.yaml
helm upgrade --install api ./api -n platform -f values-prod.yaml    # idempotent : le réflexe en CI
helm rollback api 3 -n platform                                    # revenir à la révision 3
helm uninstall api -n platform                                     # --keep-history pour pouvoir rollback après
helm list -n platform ; helm list -A
helm history api -n platform
helm status api -n platform
helm get values api -n platform            # les values FOURNIES (pas les défauts) ; --all pour tout
helm get manifest api -n platform          # ce qui a été rendu et appliqué
```

### Ce que fait un `upgrade`
1. Rend les templates avec les nouvelles values.
2. Compare avec **trois** choses : l'ancien manifeste (révision précédente), le nouveau, et **l'état réel dans le cluster** — c'est le « three-way merge » de Helm 3. Conséquence : une modification manuelle sur un champ que le chart ne touche pas est **conservée** ; sur un champ que le chart définit, elle est **écrasée**. C'est plus subtil que « Helm écrase tout » (étape 2) et ça explique des surprises dans les deux sens.
3. Applique les différences, crée une nouvelle révision.

Options qui changent tout :
- `--wait` : attend que les pods soient `Ready` (et les Services aient un LB…) avant de déclarer le succès, dans la limite de `--timeout` (5 min par défaut). Sans lui, `helm upgrade` réussit dès que l'API a accepté les objets, même si tout crashe ensuite.
- `--atomic` : `--wait` + rollback automatique en cas d'échec. Le réflexe en production. Attention : un `--timeout` trop court sur une plateforme dont les migrations prennent 8 minutes provoque un rollback d'un déploiement qui allait réussir (§15).
- `--force` : supprime et recrée les objets au lieu de les patcher. Ça règle certains conflits d'immuabilité (selector d'un Deployment, template d'un StatefulSet) et ça **coupe le service** ; à ne pas mettre dans un script.
- `--reuse-values` / `--reset-values` : par défaut, un `upgrade` avec `-f` repart des valeurs par défaut du chart + tes fichiers. `--reuse-values` reprend celles de la révision précédente et y superpose `--set` — pratique pour un `--set image.tag=` rapide, dangereux quand on a oublié qu'on l'a fait.

### Les états d'une release
`deployed`, `failed`, `pending-install` / `pending-upgrade` (une opération est en cours **ou a été interrompue** — Ctrl-C, timeout de CI), `superseded`. Une release bloquée en `pending-upgrade` refuse tout nouvel upgrade : `helm rollback` vers la dernière révision `deployed` la débloque. C'est le premier réflexe sur `another operation (install/upgrade/rollback) is in progress`.

---

## 7.5 Hooks : exécuter quelque chose à un moment précis

Un objet annoté `helm.sh/hook` n'est pas déployé avec le reste, mais à un moment du cycle :

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "api.fullname" . }}-migrate
  annotations:
    "helm.sh/hook": pre-upgrade,pre-install
    "helm.sh/hook-weight": "-5"                     # ordre entre hooks (croissant)
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          command: ["alembic", "upgrade", "head"]
```

Points de vigilance, tous vécus :
- Un hook `pre-*` qui échoue **bloque** l'install/upgrade. Un Job qui atteint `backoffLimit` = release `failed`. Ses pods restent là pour être lus (`kubectl logs job/api-migrate`).
- Un Job est **immuable** : sans `before-hook-creation`, le second `upgrade` échoue sur « Job already exists ». Toujours cette delete-policy.
- Les objets de hook **ne sont pas gérés par la release** : `helm uninstall` ne les supprime pas (sauf policy `hook-succeeded`/`hook-failed`), `helm get manifest` ne les montre pas. Un ConfigMap de hook oublié survit à tout.
- Le hook tourne avec les **nouvelles** values et la **nouvelle** image, mais avant que les pods applicatifs ne soient mis à jour : une migration incompatible avec l'ancienne version de l'app crée une fenêtre d'erreurs le temps du rolling update.
- `helm test` exécute les objets annotés `helm.sh/hook: test` (un pod qui `curl` le Service et sort 0). C'est la validation post-install la plus simple qui existe, et presque personne ne l'utilise.

Les hooks disponibles : `pre-install`, `post-install`, `pre-delete`, `post-delete`, `pre-upgrade`, `post-upgrade`, `pre-rollback`, `post-rollback`, `test`.

---

## 7.6 Valider et distribuer

**`values.schema.json`** : un JSON Schema appliqué aux values à chaque `install`/`upgrade`/`lint`. Il transforme « ingress.host: 42 » en erreur claire plutôt qu'en manifeste bizarre, et documente les types. Sur un chart destiné à des clients, c'est ce qui évite la moitié des tickets.

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "replicaCount": { "type": "integer", "minimum": 1 },
    "image": {
      "type": "object",
      "properties": { "repository": { "type": "string" }, "tag": { "type": "string" } },
      "required": ["repository"]
    }
  }
}
```

**`helm lint ./api`** : erreurs de syntaxe, valeurs requises, conventions. À lancer avant chaque commit.

**Versionner** : bump `version` à chaque changement du chart (semver : patch = correction, minor = nouvelle value compatible, major = value renommée ou comportement changé). Un client verrouille une version de chart (étape 9) ; ce qui change entre deux versions doit se lire dans un changelog.

**Empaqueter et distribuer** :
```bash
helm package ./api                                     # api-1.4.2.tgz
# Dépôt classique (index.yaml servi en HTTP)
helm repo add mistral https://charts.example.com && helm repo update
helm search repo mistral/ --versions
# Registre OCI (le standard actuel : même registre que les images)
helm push api-1.4.2.tgz oci://registry.example.com/charts
helm install api oci://registry.example.com/charts/api --version 1.4.2
helm pull oci://registry.example.com/charts/api --version 1.4.2 --untar   # récupérer et lire un chart
helm show values oci://registry.example.com/charts/api --version 1.4.2    # les défauts sans télécharger
helm show chart …                                                          # le Chart.yaml
```

`helm pull --untar` puis lire `values.yaml` et `templates/` est **la** façon de comprendre un chart tiers. Sur un chart parapluie de plusieurs dizaines de sous-charts, c'est un après-midi bien investi.

---

## 7.7 Diagnostiquer un rendu

```bash
helm template api ./api -f values.yaml                           # rend sans cluster ; erreurs de template
helm template api ./api -f values.yaml --show-only templates/deployment.yaml
helm template api ./api -f values.yaml --debug                   # + les values fusionnées en tête
helm install api ./api -f values.yaml --dry-run --debug          # rend ET valide côté serveur (--dry-run=server)
helm upgrade api ./api -f values.yaml --dry-run                  # ce qui SERAIT appliqué
helm diff upgrade api ./api -f values.yaml                       # plugin : le diff avec le déployé (helm plugin install https://github.com/databus23/helm-diff)
helm get manifest api | kubectl diff -f -                        # dérive entre ce que Helm croit et le cluster
```

Les erreurs de rendu qu'on rencontre tout le temps :

| Message | Cause | Remède |
|---|---|---|
| `error converting YAML to JSON: … mapping values are not allowed` | Indentation cassée par un `nindent` / `indent` faux ou un `-}}` de trop | `helm template --show-only` et lire le YAML produit ligne à ligne |
| `nil pointer evaluating interface {}.foo` | `.Values.a.b.c` alors que `.Values.a` est absent | `with`, `default`, ou `dig "a" "b" "c" "" .Values` |
| `template "x" not defined` | Faute de frappe, ou template dans un sous-chart non chargé | `grep define` dans tout le chart |
| `wrong type for value; expected string; got float64` | Un nombre là où une chaîne est attendue (`--set tag=1.10`) | `quote`, ou `--set-string` |
| `execution error at … : … is required` | Un `required` non satisfait | Lire le message, fournir la value |
| `Error: UPGRADE FAILED: … field is immutable` | Selector, volumeClaimTemplates, Job | Voir 7.4 `--force` et étape 5 |

---

## 7.8 Exercice — écrire un chart complet

Tu vas écrire le chart de l'application `api` de l'étape 3, **sans partir de `helm create`** (tu le referas après pour comparer). Objectif : un chart que tu serais prêt à livrer.

```bash
mkdir -p lab7/api/templates && cd lab7
kubectl create namespace lab7 && kubens lab7
```

1. **Le squelette.** `Chart.yaml` (`apiVersion: v2`, `version: 0.1.0`, `appVersion: "1.27"`), `values.yaml` avec exactement ces clés, documentées par un commentaire chacune :
   `replicaCount`, `image.{repository,tag,pullPolicy}`, `imagePullSecrets`, `serviceAccount.{create,name}`, `podSecurityContext`, `securityContext`, `resources`, `nodeSelector`, `tolerations`, `affinity`, `service.{type,port}`, `ingress.{enabled,className,host,annotations,tls}`, `autoscaling.{enabled,minReplicas,maxReplicas,targetCPU}`, `config.logLevel`, `db.{host,existingSecret}`, `migration.enabled`, `probes.startup.failureThreshold`.

2. **`_helpers.tpl`** avec `api.name`, `api.fullname`, `api.labels`, `api.selectorLabels`, `api.serviceAccountName` (section 7.3).

3. **Les templates** : `serviceaccount.yaml` (si `create`), `configmap.yaml` (`LOG_LEVEL`, `DB_HOST`), `secret.yaml` (**seulement si** `db.existingSecret` est vide — génère un mot de passe avec `randAlphaNum 16`, et note ce qui se passera à l'upgrade), `deployment.yaml` (image nginx, init container `wait-db` de l'étape 3, les trois probes avec `startup.failureThreshold` paramétré, `envFrom` le ConfigMap, `DB_PASSWORD` depuis le secret, annotation checksum, resources/nodeSelector/tolerations/affinity via `toYaml`, `replicas` absent si autoscaling), `service.yaml`, `ingress.yaml` (si `enabled`, host via `tpl`, `required` sur le host), `hpa.yaml` (si `enabled`, avec `.Capabilities` pour l'apiVersion), `migration-job.yaml` (hook `pre-install,pre-upgrade`, busybox qui `sleep 5`, delete-policy complète, si `migration.enabled`), `tests/test-connection.yaml`, `NOTES.txt` qui affiche l'URL selon `ingress.enabled`.

4. **Rends avant d'installer.**
   ```bash
   helm lint ./api
   helm template api ./api | less                        # lis TOUT le YAML produit
   helm template api ./api --set ingress.enabled=true    # doit échouer : host requis
   helm template api ./api --set ingress.enabled=true --set ingress.host=lab.local --show-only templates/ingress.yaml
   helm template api ./api --set autoscaling.enabled=true --show-only templates/deployment.yaml | grep -c replicas   # 0
   ```

5. **Installe, avec une base à côté.** Déploie d'abord le Service/Deployment `db` de l'étape 3 (hors chart). Puis :
   ```bash
   helm install api ./api --wait --timeout 3m
   helm list ; helm history api ; kubectl get secret -l owner=helm   # la release stockée
   helm test api
   kubectl get job                                       # le hook a disparu (delete-policy)
   ```

6. **Upgrade, checksum, rollback.**
   ```bash
   helm upgrade api ./api --set config.logLevel=debug --wait
   kubectl get pods -w                                   # les pods ont redémarré grâce au checksum
   helm upgrade api ./api --set image.tag=1.27-nexistepas --atomic --timeout 90s
   helm history api                                      # révision failed, puis rollback automatique
   helm get values api                                   # que reste-t-il des --set ? explique-le avec --reuse-values / --reset-values
   ```

7. **Le secret généré.** `helm upgrade api ./api` deux fois de suite, et compare le mot de passe (`kubectl get secret … -o jsonpath | base64 -d | shasum` — un hash, pas la valeur). Il change à chaque upgrade : c'est le bug du `randAlphaNum`. Corrige avec `lookup` (réutiliser la valeur existante si le Secret existe), puis constate que `helm template` ne rend plus la même chose que `helm install --dry-run=server`. Note cette limite.

8. **Immutabilité.** Change `api.selectorLabels` pour y ajouter un label, `helm upgrade` : `field is immutable`. Reviens en arrière. Tu sais maintenant pourquoi les selectorLabels sont à part.

9. **Schéma.** Écris `values.schema.json` pour `replicaCount` (entier ≥ 1), `image.repository` (requis), `service.port` (entier 1-65535), `ingress.host` (chaîne). `helm lint --set replicaCount=abc` doit échouer.

10. **Empaquète et compare.** `helm package ./api`, puis `helm create ref` et compare son `templates/deployment.yaml` et son `_helpers.tpl` aux tiens. Note ce que le squelette officiel fait que tu n'as pas fait, et inversement.

11. **Sur un cluster durci.** Labelle `lab7` en `enforce=restricted` (étape 6) et vérifie que ton chart s'installe encore avec les `securityContext` par défaut de tes values. Sinon, corrige les values par défaut — un chart livrable passe `restricted` sans surcharge.

12. **Nettoie** : `helm uninstall api`, puis `kubectl get all,secret,configmap,job` — reste-t-il quelque chose ? (le Secret de release disparaît, un hook mal configuré resterait). `kubectl delete namespace lab7`.

---

## Validé si…

- Tu sais lire un template avec `with`, `range`, `include`, `toYaml | nindent`, `tpl`, `required` et expliquer chaque `{{-`.
- Tu sais expliquer pourquoi les selectorLabels sont séparés des labels, et ce qu'est le three-way merge.
- Tu sais ce que font `--wait`, `--atomic`, `--force`, `--reuse-values`, et débloquer une release en `pending-upgrade`.
- Tu sais écrire un hook de migration qui survit à un second upgrade et ne laisse rien après `uninstall`.
- Tu sais pourquoi `helm template` peut mentir (`lookup`, `.Capabilities`) et quelle commande utiliser à la place.
- Tu as un chart qui passe `helm lint`, `restricted`, et qui s'installe, s'upgrade et se rollback proprement.

**Étape suivante** : `etape-08-chart-parapluie-values.md` — dépendances, charts parapluie, `global`, empilement de values par environnement, et les pièges de `--set` et de `helm template` sur un gros chart.
