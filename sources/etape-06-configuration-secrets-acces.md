# Étape 6 — Configuration, secrets et accès

**Objectif** : à la fin de cette étape, tu sais faire arriver une configuration et un secret dans un pod sans surprise, expliquer pourquoi un Secret Kubernetes n'est pas secret, comprendre comment les clients injectent leurs secrets (Vault, External Secrets, Sealed Secrets), lire et écrire du RBAC, comprendre pourquoi un pod est refusé par une politique de sécurité — et manipuler des secrets sans jamais les laisser traîner.

**Notions couvertes** : §16 (hygiène des secrets et des accès), ConfigMap/Secret, RBAC, Pod Security, admission.

**Prérequis** : étapes 1 à 5.

---

## 6.1 ConfigMap et Secret : faire entrer la configuration

Les deux objets ont la même forme ; le Secret a des types et un encodage en plus.

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: api-config }
data:
  LOG_LEVEL: "info"                 # toujours des chaînes (étape 0.4)
  config.yaml: |                    # un fichier entier comme valeur
    server:
      port: 8000
---
apiVersion: v1
kind: Secret
metadata: { name: api-secrets }
type: Opaque
stringData:                         # en clair à l'écriture, encodé par l'API
  DB_PASSWORD: "s3cr3t"
# data: { DB_PASSWORD: czNjcjN0 }   # équivalent, base64
```

### Deux façons de les consommer

**En variables d'environnement** — lues **une fois au démarrage** du conteneur :
```yaml
env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef: { name: api-secrets, key: DB_PASSWORD }
envFrom:
  - configMapRef: { name: api-config }     # toutes les clés d'un coup
```

**En fichiers montés** — mis à jour automatiquement quand l'objet change (délai de quelques dizaines de secondes, cycle de synchronisation du kubelet) :
```yaml
volumes:
  - name: config
    configMap: { name: api-config }
volumeMounts:
  - { name: config, mountPath: /etc/api, readOnly: true }
```

Le comportement à la mise à jour est **le** point à connaître :

| Mode | Après `kubectl apply` d'un ConfigMap modifié |
|---|---|
| Variable d'environnement | **Rien.** Le pod garde l'ancienne valeur jusqu'à son redémarrage |
| Fichier monté (répertoire entier) | Mis à jour en place, sous une minute (par lien symbolique atomique) — encore faut-il que l'application relise le fichier |
| Fichier monté avec `subPath` | **Rien.** `subPath` monte une copie, jamais rafraîchie |

Un chart bien écrit force donc le redémarrage des pods quand leur configuration change, avec l'annotation *checksum* : `checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}` dans le template du pod. Le hash change → le template du pod change → le Deployment fait un rolling update. Sans ça, un `helm upgrade` qui ne modifie qu'un ConfigMap ne redémarre rien, et le client croit que la nouvelle config est active. Tu le retrouveras à l'étape 7.

Deux détails utiles : `immutable: true` interdit toute modification (et allège le kubelet sur les gros clusters) ; un ConfigMap est limité à 1 Mio.

### Les types de Secret

| `type` | Contenu | Où tu le verras |
|---|---|---|
| `Opaque` | Libre | Défaut |
| `kubernetes.io/tls` | `tls.crt` + `tls.key` | Ingress TLS, cert-manager |
| `kubernetes.io/dockerconfigjson` | `.dockerconfigjson` (identifiants de registre) | `imagePullSecrets` |
| `kubernetes.io/basic-auth` | `username` + `password` | Bases de données (certains opérateurs) |
| `kubernetes.io/service-account-token` | Token d'un ServiceAccount | Ancien mécanisme, remplacé par les tokens projetés |

### Un Secret n'est pas secret
base64 est un **encodage**, pas un chiffrement : `echo czNjcjN0 | base64 -d` le lit. Ce qui protège un Secret, c'est :
1. le **RBAC** (qui a le droit de lire `secrets` dans ce namespace — 6.4) ;
2. le **chiffrement au repos** dans etcd, optionnel, à activer par l'admin du cluster (activé par défaut sur GKE, à vérifier on-prem) ;
3. le fait de **ne pas l'écrire dans git**, ce qui pose immédiatement le problème du 6.3.

Le RBAC est la seule barrière côté cluster : quiconque a `get secrets` sur un namespace a tous les mots de passe de la plateforme dans ce namespace.

### imagePullSecrets
Chez un client, les images viennent d'un registre privé (le sien, ou un miroir du tien — étape 10). Il faut un Secret de type `dockerconfigjson` et le référencer, soit dans chaque pod, soit — mieux — sur le ServiceAccount, qui l'injecte dans tous ses pods :

```bash
kubectl create secret docker-registry regcred \
  --docker-server=registry.client.example --docker-username=svc-mistral \
  --docker-password-stdin < /dev/stdin          # jamais --docker-password=… (6.6)
kubectl patch serviceaccount default -p '{"imagePullSecrets":[{"name":"regcred"}]}'
```

Le symptôme d'un pull secret manquant ou faux est un `ImagePullBackOff` dont `describe` dit `unauthorized` ou `authentication required` — à distinguer de `not found` (mauvais nom/tag) et de `x509` (CA du registre inconnue du nœud, cas air-gapped classique).

---

## 6.2 D'où viennent les secrets chez un client

Écrire `DB_PASSWORD: s3cr3t` dans un `values.yaml` versionné est interdit partout. Trois familles de solutions, à reconnaître parce que tu ne choisiras pas — le client impose la sienne :

**External Secrets Operator (ESO)** — le plus répandu. Un opérateur (étape 9) qui **lit** un coffre externe (HashiCorp Vault, GCP Secret Manager, AWS Secrets Manager, Azure Key Vault, 1Password…) et **écrit** des Secrets Kubernetes ordinaires. Ton chart ne voit que des Secrets ; ce qui change, c'est qui les crée.
```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: { name: api-secrets }
spec:
  refreshInterval: 1h
  secretStoreRef: { name: vault-client, kind: ClusterSecretStore }   # fourni par le client
  target: { name: api-secrets }
  data:
    - secretKey: DB_PASSWORD
      remoteRef: { key: platform/db, property: password }
```
Ce que ça implique pour un chart : pouvoir dire « ne crée pas ce Secret, il existe déjà sous ce nom » (`existingSecret: api-secrets`, une convention que tu verras dans tous les charts sérieux), et un ordre de démarrage : si l'ExternalSecret n'est pas synchronisé, les pods restent en `CreateContainerConfigError` (secret introuvable). `kubectl get externalsecret` montre `SecretSynced` ou l'erreur d'accès au coffre.

**Sealed Secrets** — pour ceux qui veulent tout dans git. Un contrôleur dans le cluster détient une clé privée ; `kubeseal` chiffre un Secret avec la clé publique en un `SealedSecret` qu'on peut committer ; le contrôleur le déchiffre en Secret. Simple, mais la clé est liée au cluster : un SealedSecret n'est pas portable d'un environnement à l'autre, et perdre la clé du contrôleur perd tout.

**Vault en direct** — Vault Agent Injector (un sidecar qui écrit les secrets dans un fichier du pod) ou le **Secrets Store CSI Driver** (le secret arrive comme un volume, sans jamais exister en Secret Kubernetes). Plus sûr, plus intrusif : ça modifie les pods, et une application qui attend une variable d'environnement doit être adaptée.

Le mot-clé à retenir : chez un client, **demande comment les secrets arrivent** avant de demander les secrets eux-mêmes.

---

## 6.3 Authentification : qui es-tu ?

Kubernetes **n'a pas d'objet utilisateur**. L'identité humaine vient de l'extérieur, présentée à l'API server sous forme de :
- **certificat client** (kubeadm, kind : c'est ce qu'il y a dans ton `~/.kube/config`) ;
- **token OIDC** émis par un fournisseur d'identité (Keycloak, Google, Entra) — le cas d'entreprise ;
- **identité cloud** : sur GKE, `gcloud` obtient un token à partir de ta session Google, via le plugin `gke-gcloud-auth-plugin` de l'étape 0.

Pour les **machines** (les pods), l'identité est un **ServiceAccount** : un objet namespacé dont le token est projeté automatiquement dans chaque pod sous `/var/run/secrets/kubernetes.io/serviceaccount/token`. Chaque namespace a un ServiceAccount `default` ; un pod qui n'en précise pas l'utilise. Deux bonnes pratiques que les charts sérieux appliquent : un ServiceAccount **dédié par composant**, et `automountServiceAccountToken: false` pour les composants qui n'ont rien à demander à l'API (la plupart).

Sur un cloud, une **seconde** couche d'identité s'ajoute pour parler aux services du cloud (bucket, base managée, KMS) : sur GKE, **Workload Identity** lie un ServiceAccount Kubernetes à un compte de service Google. Ce sera à l'étape 10 ; retiens juste qu'un pod peut avoir deux identités, une pour Kubernetes, une pour le cloud.

---

## 6.4 Autorisation : RBAC

Une fois identifié, ce que tu as le droit de faire est décidé par le **RBAC**. Quatre objets :

| Objet | Portée | Contient |
|---|---|---|
| **Role** | Un namespace | Des règles : `apiGroups` + `resources` + `verbs` |
| **ClusterRole** | Tout le cluster | Idem, plus les ressources non namespacées (nodes, PV, CRD…) |
| **RoleBinding** | Un namespace | Relie un Role **ou un ClusterRole** à des sujets, dans ce namespace |
| **ClusterRoleBinding** | Tout le cluster | Relie un ClusterRole à des sujets, partout |

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: config-reader, namespace: platform }
rules:
  - apiGroups: [""]                       # "" = groupe core (pods, services, configmaps…)
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: api-config-reader, namespace: platform }
subjects:
  - kind: ServiceAccount
    name: api
    namespace: platform
roleRef:
  kind: Role
  name: config-reader
  apiGroup: rbac.authorization.k8s.io
```

Ce qu'il faut savoir lire :
- **Tout est refusé par défaut** ; il n'y a que des autorisations, pas d'interdictions. Plusieurs bindings s'additionnent.
- Les **verbs** : `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`, `deletecollection`. `list` sur `secrets` donne le contenu de tous les secrets — c'est aussi sensible que `get`.
- Un ClusterRole peut être lié par un **RoleBinding** : la règle s'applique alors seulement dans ce namespace. C'est le pattern pour réutiliser les rôles prédéfinis (`view`, `edit`, `admin`, `cluster-admin`) sans donner le cluster entier.
- Les **opérateurs** ont besoin de ClusterRoles larges (ils regardent leurs CRD dans tous les namespaces). Un client qui refuse de donner des ClusterRoles t'obligera à un mode d'installation restreint à un namespace — question à poser tôt.
- `kubectl auth can-i` répond à « ai-je le droit ? » et `--as` permet de tester **l'identité d'un autre** (si tu as le droit d'impersonation) :
  ```bash
  kubectl auth can-i create deployments -n platform
  kubectl auth can-i --list -n platform                                 # tout ce que je peux faire ici
  kubectl auth can-i get secrets -n platform --as=system:serviceaccount:platform:api
  ```

Sur GKE et les clouds, l'IAM du cloud se superpose : un rôle IAM `container.developer` se traduit en droits RBAC via des ClusterRoleBindings gérés par Google. `kubectl auth can-i` reste la vérité finale.

---

## 6.5 Ce qu'un pod a le droit d'être : Pod Security et admission

Le RBAC contrôle *qui peut créer* un pod ; l'**admission** contrôle *à quoi un pod a le droit de ressembler*. Chaque objet créé passe par des **admission controllers** qui peuvent le refuser ou le modifier avant qu'il n'entre dans etcd.

### Pod Security Standards
Trois niveaux définis par Kubernetes :
- **privileged** : aucune restriction (composants système, CNI, CSI, GPU) ;
- **baseline** : interdit le pire (mode privilégié, hostPath, hostNetwork, capabilities dangereuses) ;
- **restricted** : la posture durcie — non-root obligatoire, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`.

Ils sont appliqués par **Pod Security Admission**, activé par des labels sur le namespace :
```bash
kubectl label namespace platform pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted pod-security.kubernetes.io/audit=restricted
```
`enforce` refuse, `warn` avertit dans la sortie de `kubectl`, `audit` note dans les logs d'audit. Un chart destiné aux clients doit passer **restricted** partout où c'est possible, ce qui veut dire ce `securityContext` sur chaque conteneur :

```yaml
securityContext:                    # niveau pod
  runAsNonRoot: true
  seccompProfile: { type: RuntimeDefault }
  fsGroup: 1000                     # sauf OpenShift, voir étape 5
containers:
  - name: api
    securityContext:                # niveau conteneur
      allowPrivilegeEscalation: false
      capabilities: { drop: [ALL] }
      readOnlyRootFilesystem: true  # exige des emptyDir pour /tmp et les caches
      runAsUser: 1000
```

Le symptôme d'un refus est immédiat et lisible : le Deployment est créé, mais **aucun pod n'apparaît** ; `kubectl describe replicaset` ou `kubectl get events` montre `FailedCreate … violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false …`. Quand un client dit « rien ne démarre » et que les Deployments sont à `0/1` sans pod, c'est le premier réflexe.

**OpenShift** a son mécanisme antérieur, les **SecurityContextConstraints** (SCC) : la SCC `restricted-v2` par défaut impose un UID **arbitraire** dans une plage propre au namespace. Un chart qui fixe `runAsUser: 1000` est refusé ; il faut laisser l'UID vide et s'assurer que l'image fonctionne avec n'importe quel UID du groupe 0. Étape 10.

### Kyverno, OPA Gatekeeper et les webhooks du client
Au-delà des standards, les clients imposent leurs propres règles via des **admission webhooks** (Kyverno, Gatekeeper, ou maison) : tag `latest` interdit, `resources.limits` obligatoires, labels imposés, registres d'images autorisés, pas de `LoadBalancer`, etc. Le refus se manifeste comme une erreur au `kubectl apply` / `helm install` avec le message du webhook, ou comme un `FailedCreate` sur le ReplicaSet. Deux commandes pour savoir à quoi tu as affaire :
```bash
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations
kubectl get clusterpolicy            # Kyverno ; ou : kubectl get constraints (Gatekeeper)
```
Les webhooks **mutants** modifient tes objets silencieusement (injection d'un sidecar, ajout de tolerations, réécriture du registre d'image) : quand ce qui tourne ne ressemble pas à ce que ton chart a rendu, c'est le suspect n° 1 — compare `helm template` et `kubectl get -o yaml`.

---

## 6.6 Hygiène des secrets et des accès

Ce qui suit est le §16 de ton document, et ce sont des habitudes, pas des connaissances. Elles se prennent maintenant, en lab, ou jamais.

**Un secret ne passe jamais par le terminal.** Ce que tu affiches finit dans le scrollback, dans `~/.zsh_history`, dans la transcription de ton agent IA, dans la capture d'écran du ticket. Les trois gestes :
```bash
# ❌ affiche le mot de passe
kubectl get secret db -o jsonpath='{.data.password}' | base64 -d

# ✅ presse-papier (macOS : pbcopy ; Linux : xclip -selection clipboard / wl-copy)
kubectl get secret db -o jsonpath='{.data.password}' | base64 -d | pbcopy

# ✅ directement dans la commande qui en a besoin, sans passer par une variable ni l'écran
kubectl get secret db -o jsonpath='{.data.password}' | base64 -d | psql -h localhost -U app -W 2>/dev/null   # ou via PGPASSWORD dans un sous-shell
```
Et **jamais en partage d'écran** ni en session avec un client, même « juste pour vérifier » (§12).

**Un secret ne passe jamais en argument de ligne de commande.** `helm install --set db.password=xxx`, `docker login -p xxx`, `psql "password=xxx"` sont visibles par tous les utilisateurs de la machine via `ps`, et enregistrés dans l'historique. Toujours par **stdin** ou par **fichier** :
```bash
docker login registry.client.example -u svc --password-stdin < /path/to/token
helm install platform ./chart -f values.yaml -f secrets.values.yaml       # fichier hors git, permissions 600
```
Et pour l'historique du shell : `HISTCONTROL=ignorespace` (bash) / `setopt HIST_IGNORE_SPACE` (zsh), puis un espace devant la commande sensible — ou `set +o history` le temps de la manipulation.

**Teste tes accès avant de demander des droits.** Un « je n'ai pas accès » sans preuve fait perdre un aller-retour à tout le monde :
```bash
kubectl auth can-i --list -n platform
kubectl auth can-i get secrets -n platform            # no → tu sais QUOI demander précisément
gcloud projects get-iam-policy $PROJECT --flatten=bindings --filter="bindings.members:$(gcloud config get account)"
```

**Deux authentifications cloud, toutes deux nécessaires.** Sur GCP :
- `gcloud auth login` → **ta session utilisateur**, utilisée par `gcloud` et `kubectl` (via le plugin) ;
- `gcloud auth application-default login` → les **Application Default Credentials**, un fichier lu par les SDK, Terraform, les outils Python internes et tout ce qui « parle à Google » sans passer par `gcloud`.
Elles sont indépendantes : `gcloud` qui marche ne prouve pas que l'outil interne va marcher, et l'erreur ADC (`could not find default credentials`) est fréquente au premier jour. Même logique chez AWS (`aws sso login` vs profil) et Azure.

**Reconnaître un warning inoffensif.** Le classique GCP : `WARNING: … quota project … Application Default Credentials without a quota project` — ça n'empêche rien, ça dit juste à quel projet imputer les appels d'API ; `gcloud auth application-default set-quota-project $PROJECT` le fait taire. Corriger ce qui n'est pas cassé est une perte de temps, et parfois une casse.

**Le kubeconfig est un secret.** Il contient de quoi agir sur le cluster d'un client. Permissions 600, jamais dans un dépôt, jamais dans un message, et de préférence un fichier par client (`KUBECONFIG=~/.kube/client-x.yaml`) pour qu'un mauvais contexte soit impossible plutôt qu'improbable (étape 1.7).

---

## 6.7 Exercice — clavier en main

```bash
kubectl config current-context && kubectl create namespace lab6 && kubens lab6
```

1. **Env vs fichier.** ConfigMap `cfg` avec `GREETING=bonjour` et un fichier `app.conf` contenant `mode=a`. Un Deployment `app` (busybox, `sh -c 'while true; do echo "$GREETING / $(cat /etc/app/app.conf)"; sleep 5; done'`) qui consomme `GREETING` en env et `app.conf` monté sur `/etc/app`. Suis les logs, puis modifie les deux valeurs dans le ConfigMap et applique. Constate : le fichier change en moins d'une minute, l'env jamais. `kubectl rollout restart deploy/app` : l'env suit. Remonte ensuite le fichier avec `subPath: app.conf` et refais la modification : plus rien ne change.

2. **Secret consommé, secret lu proprement.** Crée `dbsec` avec `stringData: { password: "lab-p4ss" }`. Vérifie que `kubectl get secret dbsec -o yaml` montre du base64. Copie la valeur dans ton presse-papier **sans l'afficher** et colle-la dans un fichier temporaire pour vérifier — puis supprime le fichier. Regarde `history | tail -3` : si le mot de passe y apparaît, refais l'exercice avec `HIST_IGNORE_SPACE`.

3. **Secret manquant.** Déploie un pod qui référence `secretKeyRef: { name: nexistepas, key: x }`. Observe `CreateContainerConfigError` et le message de `describe`. C'est ce que produit un ExternalSecret non synchronisé.

4. **Pull secret.** Déploie un pod avec `image: ghcr.io/nexistepas-org/prive:1`. Lis dans `describe` si le registre répond `not found`, `unauthorized` ou `denied` — c'est la ligne qu'il faut savoir lire chez un client. Crée un Secret `docker-registry` avec des identifiants bidons via `--password-stdin`, attache-le au ServiceAccount `default`, redéploie : le message d'erreur change-t-il ? Note ce que tu constates.

5. **ServiceAccount minimal + RBAC.** Crée un ServiceAccount `reader`, un Role autorisant `get, list` sur `configmaps` seulement, et le RoleBinding. Puis, depuis un pod tournant sous ce ServiceAccount (`serviceAccountName: reader`, image `bitnami/kubectl` ou `alpine/k8s`) :
   ```bash
   kubectl exec -it <pod> -- kubectl get configmaps        # OK
   kubectl exec -it <pod> -- kubectl get secrets           # Forbidden
   kubectl exec -it <pod> -- kubectl get pods -n default   # Forbidden : le Role est namespacé
   ```
   Fais la même vérification **sans pod**, par impersonation : `kubectl auth can-i get secrets --as=system:serviceaccount:lab6:reader`. Puis `--list`.

6. **Le token dans le pod.** Dans le même pod : `cat /var/run/secrets/kubernetes.io/serviceaccount/token | cut -c1-20` (le début suffit) et `ls /var/run/secrets/kubernetes.io/serviceaccount/`. Remets `automountServiceAccountToken: false` sur le pod : le répertoire n'existe plus, `kubectl` dedans échoue. C'est le réglage à appliquer à tout composant qui ne parle pas à l'API.

7. **Pod Security.** Labelle `lab6` en `enforce=restricted` + `warn=restricted`. Réapplique le Deployment `app` du point 1 : `kubectl get deploy` montre `0/1`, `kubectl get events` explique champ par champ ce qui manque. Ajoute le `securityContext` complet de 6.5 (busybox tourne bien en UID 1000 avec `readOnlyRootFilesystem: true` puisqu'il n'écrit rien). Le pod démarre. Tente ensuite un pod avec `hostPath` ou `privileged: true` : refusé net à l'`apply`.

8. **Webhook mutant, version lab.** Regarde ce que le cluster a déjà : `kubectl get mutatingwebhookconfigurations` (kind en a peu ; sur un cluster client, cette liste te dira qui modifie tes pods). Pas d'exercice au-delà — mais note la commande.

9. **Accès cloud, si tu as un projet GCP sous la main.** Compare `gcloud auth list` et `gcloud auth application-default print-access-token | cut -c1-10` ; révoque les ADC (`gcloud auth application-default revoke`) et vérifie que `gcloud` fonctionne encore. Refais le login ADC. Tu viens de voir que ce sont deux choses.

10. **Nettoie** : `kubectl delete namespace lab6`, et vide ton presse-papier (`pbcopy < /dev/null`).

---

## Validé si…

- Tu sais dire dans quels cas un ConfigMap modifié est pris en compte sans redémarrage, et à quoi sert l'annotation checksum d'un chart.
- Tu sais expliquer à un client pourquoi un Secret Kubernetes n'est pas chiffré, et ce qui le protège vraiment.
- Tu sais nommer les trois familles d'injection de secrets et la question à poser au client avant de demander un mot de passe.
- Tu sais lire un Role/RoleBinding, écrire le `kubectl auth can-i` correspondant, et expliquer la différence entre un ClusterRole lié par RoleBinding et par ClusterRoleBinding.
- Tu sais reconnaître un refus Pod Security à ses symptômes, et écrire un `securityContext` qui passe `restricted`.
- Tu n'as affiché aucun secret dans ton terminal pendant tout l'exercice.

**Étape suivante** : `etape-07-helm-fondamentaux.md` — anatomie d'un chart, templating, cycle de vie d'une release.
