# Étape 10 — Multi-environnement clients

**Objectif** : à la fin de cette étape, tu sais ce qui change réellement entre GKE, OpenShift, un cluster on-prem et un environnement air-gapped, tu as la liste des questions à poser avant de promettre une installation, tu sais quelle brique de values correspond à quelle différence, et tu sais dire clairement ce que le chart fait et ne fait pas.

**Notions couvertes** : §1 (frontière de responsabilité), §2 (miroir, packaging offline — rappel), et la partie multi-environnement du plan.

**Prérequis** : partie A, étapes 7 à 9.

---

## 10.1 La frontière de responsabilité, dite une fois pour toutes

Un chart applicatif **déploie des workloads** sur un cluster qui existe. Il ne fabrique **pas** l'infrastructure. Concrètement :

| Le chart fait | Le chart ne fait pas — c'est le client (ou une étape « prérequis » séparée) |
|---|---|
| Deployments, StatefulSets, Jobs, Services, ConfigMaps, Secrets applicatifs, Ingress/Routes, PVC, HPA, PDB, NetworkPolicy, ServiceAccounts + RBAC namespacés, CR pour les opérateurs applicatifs | Le cluster lui-même, sa version, ses nœuds (CPU/mémoire/GPU), son autoscaler |
| Demande une StorageClass, une classe d'ingress, un LoadBalancer | Fournit la StorageClass, l'ingress controller, l'implémentation LoadBalancer (cloud, MetalLB), le CNI |
| Référence un registre d'images | Le registre, sa CA sur les nœuds, l'accès réseau des nœuds vers lui |
| Demande `nvidia.com/gpu` | Les drivers, le GPU Operator, les taints/labels des nœuds GPU |
| Consomme des Secrets | Le coffre, ESO/Vault, les identifiants |
| Crée des CR `Certificate`, `ExternalSecret`, `Cluster` | cert-manager, ESO, l'opérateur PostgreSQL s'ils sont cluster-wide (étape 9.3) |
| Expose des métriques et logs | Prometheus, Loki/Elastic, la rétention, les alertes (sauf si embarqué en option) |
| Déclare des `resources` | Les quotas de namespace, les LimitRanges, la capacité réelle |
| Fonctionne derrière un proxy egress si configuré | Le proxy, sa liste blanche, la résolution DNS externe |

Quand un client dit « ça ne marche pas », la première question mentale est : **de quel côté de cette ligne est le problème ?** Un PVC `Pending` faute de StorageClass, un LoadBalancer `<pending>`, un `x509` sur le registre, un pod `Pending` faute de GPU : quatre problèmes du côté droit, qu'on **signale** avec la commande qui le prouve, et qu'on ne « contourne » pas dans les values.

---

## 10.2 GKE

Le cas cloud de référence. Ce qui est fourni, ce qui piège.

**Deux modes.** *Standard* : tu gères les node pools (machine type, GPU, taints, autoscaling min/max). *Autopilot* : Google gère les nœuds ; les pods sont facturés à la ressource, et une liste d'interdits s'applique — pas de `privileged`, pas de `hostPath`, pas de DaemonSet arbitraire, des `resources` ajustées automatiquement (requests minimum imposées, limits alignées sur requests), GPU via `nodeSelector: cloud.google.com/gke-accelerator`. Un chart qui embarque un DaemonSet système ou un composant privilégié ne s'installe pas sur Autopilot : à savoir avant de dire oui.

**Accès.** `gcloud container clusters get-credentials <cluster> --region <r> --project <p>` écrit le contexte ; l'auth passe par le plugin de l'étape 0. Un cluster **privé** (control plane sans IP publique) n'est joignable que depuis le VPC : bastion, VPN, ou un réseau overlay (Tailscale avec exit node — §4) ; quand cet overlay est absent, `kubectl` fait `i/o timeout` et **rien** d'autre n'est cassé.

**Identité.** *Workload Identity* lie un ServiceAccount Kubernetes à un compte de service Google par annotation `iam.gke.io/gcp-service-account: <gsa>@<project>.iam.gserviceaccount.com` + un binding IAM `roles/iam.workloadIdentityUser`. C'est ainsi qu'un pod écrit dans un bucket GCS ou lit Secret Manager sans clé JSON. Le chart doit donc permettre d'annoter ses ServiceAccounts (`serviceAccount.annotations`), et le binding IAM est côté client.

**Réseau.** *Dataplane V2* (Cilium) est le défaut : NetworkPolicy appliquées, pas de kube-proxy. L'ingress natif (`ingressClassName: gce`) crée un LB Google HTTP(S) — puissant, mais avec ses objets (`BackendConfig`, `FrontendConfig`, `ManagedCertificate`), ses délais (plusieurs minutes), ses exigences (Service `NEG`, readiness qui répond 200 sur le port du Service) et **aucune** des annotations nginx. Beaucoup de déploiements préfèrent installer ingress-nginx derrière un LB L4 pour garder un comportement identique partout ; c'est une décision par client, à mettre dans `gke.yaml`. Un LB **interne** demande l'annotation `networking.gke.io/load-balancer-type: Internal`. Gateway API est disponible nativement (`gke-l7-*` GatewayClasses). Le DNS est Cloud DNS ; external-dns sait y écrire (étape 12, avec le problème des enregistrements orphelins).

**Stockage.** `standard-rwo` / `premium-rwo` (PD via CSI, RWO, zonaux, expansion et snapshots OK), pas de RWX sans Filestore (`standard-rwx`, cher, minimum 1 Ti) — étape 5. Nœuds multi-zones + disques zonaux → `WaitForFirstConsumer` indispensable, et un pod avec PVC ne peut revenir que dans sa zone.

**Images.** Artifact Registry (`<region>-docker.pkg.dev/<project>/<repo>/image`), accès des nœuds via le compte de service du node pool (pas de pull secret si le dépôt est dans le même projet et le scope est là) ; les *remote repositories* d'Artifact Registry font le pull-through de docker.io / ghcr (étape 8.8).

**GPU.** Node pool GPU avec le driver installé par GKE (`gpu-driver-version: latest/default`) — pas de GPU Operator à installer ; taint automatique `nvidia.com/gpu=present:NoSchedule` ; quotas GPU par région à demander à Google **à l'avance** (jours). Étape 15.

**Version.** Release channels (rapid/regular/stable) avec mises à jour **automatiques** du control plane : un client GKE change de version mineure sans te prévenir — d'où les dépréciations d'API à surveiller (étape 9.6).

---

## 10.3 OpenShift

Ce n'est pas « Kubernetes avec une UI » : c'est une distribution avec ses objets, ses défauts de sécurité et son outillage, et le chart doit s'y plier.

**Sécurité : SCC.** Les *SecurityContextConstraints* remplacent Pod Security. La SCC par défaut `restricted-v2` impose : UID **arbitraire** attribué dans une plage propre au namespace (annotation `openshift.io/sa.scc.uid-range`), `fsGroup` et `seccomp` idem, pas de capabilities, pas de privilège. Conséquences directes :
- **ne pas fixer `runAsUser`, `runAsGroup`, `fsGroup`** dans les values pour OpenShift (les mettre à `null` dans `openshift.yaml`) ;
- les images doivent tourner sous **n'importe quel UID**, avec les fichiers accessibles au **groupe 0** (`chgrp -R 0 /app && chmod -R g=u /app` dans le Dockerfile) ;
- un composant qui a *besoin* de root ou de capabilities (rare : certains collecteurs, certains device plugins) exige une SCC dédiée accordée par l'admin : `oc adm policy add-scc-to-user privileged -z <serviceaccount> -n <ns>`. Ça se demande, ça se documente, ça ne se contourne pas.

**Réseau : Routes.** L'*OpenShift Router* (HAProxy) sert des objets `Route`. Un `Ingress` est converti automatiquement en Route **si** `ingressClassName: openshift-default` (ou absent avec la classe par défaut) ; les annotations nginx sont perdues, et certains réglages (timeouts, passthrough TLS, sticky sessions) n'existent qu'en annotations `haproxy.router.openshift.io/*` sur la Route. Un chart sérieux propose `ingress.enabled` **ou** `route.enabled` et rend l'objet natif. Le CNI est OVN-Kubernetes ; NetworkPolicy appliquées ; par défaut les namespaces sont isolés selon la configuration du cluster (à vérifier : `oc get netnamespace` / policies par défaut du projet).

**Stockage.** OpenShift Data Foundation (Ceph) quand il est là : `ocs-storagecluster-ceph-rbd` (RWO), `ocs-storagecluster-cephfs` (RWX), snapshots OK. Sinon, le CSI du sous-jacent (vSphere, bare metal + LVM). Toujours `kubectl get sc`.

**Opérateurs : OLM.** Les clients OpenShift installent cert-manager, ESO, Strimzi… via **OperatorHub / OLM** (`Subscription`, `CSV`), pas via Helm. Même opérateur, **versions et CRDs différentes** de celles du chart Helm upstream (le « cert-manager Operator for Red Hat OpenShift » a son propre calendrier). C'est un cas d'école du décalage de version de l'étape 9.6 : vérifie `oc get csv -A`.

**Divers.** `oc` = `kubectl` + des commandes en plus (`oc new-project`, `oc get route`, `oc adm`) ; un *project* = un namespace + annotations ; registre interne (`image-registry.openshift-image-registry.svc:5000`) avec ImageStreams optionnels ; les labels Pod Security sont synchronisés automatiquement à partir des SCC (ne pas les poser à la main) ; la console web montre les mêmes objets que `oc`. Versions : OpenShift 4.x ↔ Kubernetes 1.2x (4.17 = 1.30, 4.18 = 1.31 — vérifie la table Red Hat pour le client).

---

## 10.4 On-prem et private cloud : la famille des « rien n'est fourni »

Ce que chaque distribution apporte de base, et donc ce qu'il faut demander pour le reste :

| Distribution | CNI | Ingress fourni | LoadBalancer | StorageClass par défaut | Particularités |
|---|---|---|---|---|---|
| **kubeadm** nu | à installer (souvent Calico) | non | non | non | Tout est à fournir : MetalLB, ingress-nginx, un CSI. Le cas le plus « sec » |
| **RKE2 / Rancher** | Canal (Calico+Flannel) ou Cilium | ingress-nginx **intégré** (classe `nginx`) | non (MetalLB ou kube-vip à ajouter) | non (Longhorn souvent ajouté) | Rancher pose ses propres projets/policies ; RKE2 durci CIS par défaut (PSA restricted possible) |
| **k3s** | Flannel | Traefik (classe `traefik`) | ServiceLB (klipper) : LB = ports sur les nœuds | `local-path` (nœud-local) | Léger, fréquent en edge/POC ; local-path interdit tout déplacement de pod avec PVC |
| **VMware Tanzu (TKG)** | Antrea ou Calico | Contour (classe `contour`) selon packages | NSX ALB / Avi | vSphere CSI (RWO ; RWX si vSAN file) | Packages Tanzu (`kapp`) pour les add-ons ; datastore plein = PVC Pending muet |
| **Nutanix NKP** | Calico/Cilium | Traefik | MetalLB intégré | Nutanix CSI (RWO, RWX via Files) | — |
| **Talos** | Cilium souvent | non | non | non | Pas de SSH, tout par API ; très propre, très nu |

Les points communs de l'on-prem :
- **LoadBalancer `<pending>`** si personne ne l'implémente : prévoir `service.type: NodePort` ou un LB externe du client, dans `onprem-*.yaml`.
- **Pas de StorageClass par défaut** : la moitié des `Pending` de première installation (étape 5).
- **CA d'entreprise partout** : registre, IdP, proxy — sur les nœuds (containerd) **et** dans les pods qui appellent ces services (montage d'un bundle CA : `global.caBundle`/`extraCaCerts` dans le chart, ou injection par le client).
- **Proxy egress** avec `HTTP_PROXY`/`NO_PROXY` — `NO_PROXY` doit inclure les CIDR pods/services, `.svc`, `.cluster.local`, le registre, l'IdP (étape 4.5).
- **Peu de nœuds** : anti-affinité `required` impossible, HA « sur le papier » (§10) ; il faut le dire.
- **DNS de cluster pas toujours `cluster.local`** : certains clusters sont créés avec un autre domaine ; les FQDN codés en dur cassent. Vérifier `kubectl -n kube-system get cm coredns -o yaml`.
- **Pas d'autoscaler de nœuds** : un `Pending` faute de ressources ne se résorbe jamais seul, contrairement à GKE (§15).

---

## 10.5 Air-gapped

Le cas extrême : aucun flux sortant, parfois aucun flux entrant hors VPN. Tout ce qui « va chercher quelque chose » doit avoir une réponse locale.

| Ce qui a besoin d'Internet | Réponse en air-gapped |
|---|---|
| Images | Miroir interne alimenté par copie (étape 8.8) — par **digest**, avec la liste extraite du rendu **et** complétée des images des opérateurs et des init containers de téléchargement |
| Charts | `helm pull` → transfert → `helm push` sur le registre OCI interne, ou installation depuis le `.tgz` |
| Certificats ACME (Let's Encrypt) | Impossible : CA interne du client via `Issuer` de type CA, ou certificats fournis en Secrets `kubernetes.io/tls` ; EAB inutile |
| Inférence déportée vers une API tierce (§7) | **Impossible** : inférence locale obligatoire → GPU obligatoires → dimensionnement à faire (§19) |
| Téléchargement de modèles (Hugging Face, bucket public) | Poids fournis sur le stockage objet interne ou un PVC pré-rempli ; init container pointé vers l'interne (étape 15) |
| Crawler, connecteurs SaaS, callbacks OAuth externes | Désactivés ou limités à l'intranet ; à dire explicitement au client |
| Télémétrie, vérification de licence, mises à jour automatiques | Désactivées par values (`telemetry.enabled: false`…) — vérifier qu'il n'en reste aucune en observant les logs de connexion refusée |
| Temps (NTP) | Serveur de temps interne — un décalage d'horloge casse TLS, OIDC et les logs (§13, « vérifier l'heure ») |
| DNS externe | Zone interne uniquement ; external-dns vers un DNS interne ou entrées manuelles |

Le packaging offline se prépare sur une machine connectée : un répertoire avec les images en tar (`crane pull … image.tar`, ou un tar par image avec `skopeo copy … dir:`), les charts `.tgz`, les CRDs extraites, les binaires (`helm`, `kubectl`, `crane`, `k9s`), un `SHA256SUMS`, et un script d'import qui pousse tout sur le registre interne et vérifie. **La vérification finale est toujours la même** : après installation, `kubectl get pods -A -o jsonpath=…image` (étape 8.8) et zéro image hors miroir ; `kubectl get events -A | grep -i pull` vide.

---

## 10.6 Compatibilité : la liste de contrôle

Ce qu'il faut savoir d'un cluster avant d'y installer quoi que ce soit — et la commande qui le dit :

| Question | Commande | Pourquoi |
|---|---|---|
| Version de Kubernetes ? | `kubectl version` | Matrice de compatibilité du chart ; dépréciations (`pluto detect-helm`) |
| Distribution ? | `kubectl get nodes -o wide` (OS, runtime), `kubectl get ns` (`openshift-*`, `cattle-*`, `kube-public`) | Détermine la brique de values |
| Combien de nœuds, quelles zones, quelles tailles, quels GPU ? | `kubectl get nodes -L topology.kubernetes.io/zone,nvidia.com/gpu.product`, `kubectl describe nodes \| grep -A5 Allocatable` | HA réelle, anti-affinité, dimensionnement |
| CNI, NetworkPolicy appliquées ? | `kubectl -n kube-system get ds` | Isolation promise ou non |
| Ingress controller et classe ? | `kubectl get ingressclass` | `global.ingressClassName` ; Routes sur OpenShift |
| LoadBalancer disponible ? | créer un Service LB de test et regarder `EXTERNAL-IP` 2 minutes | NodePort sinon |
| StorageClass par défaut, RWX, expansion, snapshots ? | `kubectl get sc`, `kubectl get volumesnapshotclass` | Étape 5 |
| CRDs / opérateurs présents et versions ? | `kubectl get crd`, `kubectl get deploy -A \| grep -iE 'operator\|manager'`, `oc get csv -A` | Étape 9.3 et 9.6 |
| Pod Security / SCC / webhooks du client ? | `kubectl get ns --show-labels`, `kubectl get validatingwebhookconfigurations`, `kubectl get clusterpolicy` | Ce que le chart doit respecter |
| Quotas et LimitRanges sur le namespace cible ? | `kubectl get resourcequota,limitrange -n <ns>` | Pods refusés ou `resources` modifiées à ton insu |
| Mes droits ? | `kubectl auth can-i --list -n <ns>`, `kubectl auth can-i create clusterrole` | Installation cluster-wide possible ? |
| Domaine DNS du cluster ? | `kubectl -n kube-system get cm coredns -o yaml \| grep kubernetes` | FQDN dans les configs |
| Sortie réseau des pods ? proxy ? | `kubectl run -it --rm t --image=nicolaka/netshoot -- curl -sI https://registry-1.docker.io`, `env \| grep -i proxy` | Miroir, `NO_PROXY`, air-gapped |
| CA d'entreprise ? | `kubectl run … -- curl -v https://<registre-interne>` → `x509` ? | Bundle CA à monter |
| Horloge ? | `date` sur un nœud vs `date -u` local | TLS/OIDC |
| Architecture des nœuds ? | `kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.architecture}'` | Images arm64 disponibles ? |

Ce tableau **est** le questionnaire de découverte d'un client. Ce que les commandes ne peuvent pas dire (politique de sécurité, procédure de changement, qui a les droits, fenêtres de maintenance), on le demande.

---

## 10.7 Une brique de values par différence

Ce que contient concrètement chaque brique de l'étape 8.4, pour qu'elle reste une réponse à *une* dimension :

```yaml
# platform/gke.yaml — ce qui découle de GKE et de rien d'autre
global:
  ingressClassName: nginx            # ou gce, décision par client
  storageClass: premium-rwo
api:
  serviceAccount:
    annotations:
      iam.gke.io/gcp-service-account: platform-api@PROJECT.iam.gserviceaccount.com   # PROJECT via tpl/global
  ingress:
    annotations:
      cloud.google.com/neg: '{"ingress": true}'   # seulement si classe gce
ingress-nginx:
  controller:
    service:
      annotations:
        networking.gke.io/load-balancer-type: Internal
```

```yaml
# platform/openshift.yaml — SCC, Routes, ODF
global:
  ingressClassName: openshift-default
  storageClass: ocs-storagecluster-ceph-rbd
  podSecurityContext:
    runAsUser: null
    runAsGroup: null
    fsGroup: null
    seccompProfile: null              # attribué par la SCC
api:
  securityContext:
    runAsUser: null
  route:
    enabled: true
  ingress:
    enabled: false
db:
  persistence:
    storageClass: ocs-storagecluster-ceph-rbd
```

```yaml
# platform/airgap.yaml — tout ce qui sort est réorienté ou coupé
global:
  imageRegistry: registry.client.example/mirror
  imagePullSecrets: [regcred]
  caBundleSecret: corp-ca                      # monté dans tous les pods qui appellent l'intranet
  proxy: { http: "", https: "", noProxy: "" }  # ou renseigné si proxy
inference:
  mode: local                                  # jamais remote
models:
  source: s3://internal-models/                # pas Hugging Face
crawler:
  enabled: false
telemetry:
  enabled: false
cert-manager:
  issuer:
    type: ca                                   # pas acme
```

```yaml
# platform/gpu-nvidia.yaml — placement GPU uniquement
inference:
  nodeSelector: { nvidia.com/gpu.present: "true" }
  tolerations:
    - { key: nvidia.com/gpu, operator: Exists, effect: NoSchedule }
  resources:
    limits: { nvidia.com/gpu: 1 }
```

Le test d'une brique bien découpée : on peut la combiner avec n'importe quelle autre sans conflit de clés. `gke.yaml` + `gpu-nvidia.yaml` + `airgap.yaml` doit avoir un sens (un client GKE fermé avec GPU existe).

---

## 10.8 Exercice — le même parapluie sur trois « clients »

Reprends le parapluie de l'étape 8 (`lab8/platform`).

1. **Le questionnaire, sur ton propre cluster.** Exécute chaque commande de 10.6 sur `kind-lab` et remplis le tableau. Note ce qui manque (LoadBalancer, RWX, snapshots, GPU) : c'est exactement ce que tu constaterais sur un kubeadm nu.

2. **Client A — « kind » (on-prem minimal).** Écris `values/platform/onprem-minimal.yaml` : `service.type: NodePort`, `global.ingressClassName: nginx`, `global.storageClass: standard`, anti-affinité en `preferred`, `worker.enabled: false`. Installe `acme preprod` avec cette brique et vérifie : aucun `Pending`, ingress avec ADDRESS, PVC `Bound`.

3. **Client B — « OpenShift-like ».** Simule la SCC avec ce que tu as :
   ```bash
   kubectl create namespace globex && kubectl label ns globex pod-security.kubernetes.io/enforce=restricted
   helm repo add kyverno https://kyverno.github.io/kyverno && helm install kyverno kyverno/kyverno -n kyverno --create-namespace --wait
   ```
   Écris une `ClusterPolicy` Kyverno **validate** qui refuse tout pod de `globex` ayant `runAsUser` ou `fsGroup` explicites (message : « OpenShift assigns UIDs; do not set runAsUser/fsGroup »), et une seconde qui refuse tout Ingress dont `ingressClassName` n'est pas `openshift-default`. Installe le parapluie tel quel dans `globex` : lis les refus. Écris `values/platform/openshift-like.yaml` (10.7, adapté : `runAsUser: null`, `fsGroup: null`, classe `openshift-default`) et réinstalle : ça passe. Vérifie avec `kubectl get pod -o yaml | yq '.items[0].spec.securityContext'` que les champs sont bien absents et pas juste vides. Sur un vrai OpenShift, remplace `kubectl` par `oc` et regarde `oc get route`.

4. **Client C — air-gapped, avec un vrai pull-through.** Crée un registre miroir proxy et un cluster kind qui l'utilise comme miroir de docker.io au niveau de containerd :
   ```bash
   docker run -d --name mirror --net kind -p 5001:5000 \
     -e REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io registry:2
   cat > kind-airgap.yaml <<EOF
   kind: Cluster
   apiVersion: kind.x-k8s.io/v1alpha4
   containerdConfigPatches:
     - |-
       [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
         endpoint = ["http://mirror:5000"]
   EOF
   kind create cluster --name airgap --config kind-airgap.yaml
   kubectl run t --image=nginx:1.27 && sleep 20 && kubectl get pod t
   curl -s http://localhost:5001/v2/_catalog          # library/nginx est apparu : le nœud a tiré via le miroir
   ```
   Puis coupe l'accès amont (`docker network disconnect bridge mirror` ou stoppe ton réseau) et lance un pod avec une image **déjà** dans le cache et une autre non : l'une démarre, l'autre `ImagePullBackOff`. C'est la vie en air-gapped : ce qui n'a pas été mis en cache ou copié n'existe pas. Rends ensuite ton parapluie avec `airgap.yaml` (`global.imageRegistry` vide ici puisque le miroir est transparent — mais `crawler.enabled: false`, etc.) et vérifie que la liste d'images extraite (étape 8.8) correspond au catalogue du miroir après installation.

5. **Quotas et LimitRanges.** Sur `globex`, pose un `LimitRange` avec `default.cpu: 100m` et un `ResourceQuota` `pods: 5`. Installe le parapluie : lis quel objet est refusé et pourquoi, et compare les `resources` d'un pod à ce que ton chart a rendu (`helm get manifest` vs `kubectl get pod -o yaml`) : le LimitRange a modifié le pod. C'est un des « webhooks » les plus fréquents chez les clients, et il n'est même pas un webhook.

6. **Dépréciations.** `pluto detect-helm -A` sur ton cluster, et `helm template … --kube-version 1.34.0 | pluto detect-files -f -`. Rien ne doit remonter sur ton propre chart.

7. **Le compte rendu de découverte.** Pour chacun des trois « clients », écris en cinq lignes : distribution, ce qui est fourni, ce qui manque, la brique utilisée, ce qui reste **à vérifier** (marqué comme tel). C'est le format que tu produiras pour de vrai (§19).

8. **Nettoie** : `kind delete cluster --name airgap`, `docker rm -f mirror`, `helm uninstall kyverno -n kyverno`, `kubectl delete ns globex kyverno`.

---

## Validé si…

- Tu sais tracer la frontière chart / infrastructure sur dix exemples sans hésiter, et formuler un problème « côté client » avec la commande qui le prouve.
- Tu sais citer pour GKE : Autopilot vs Standard, Workload Identity, ingress gce vs nginx, RWX, disques zonaux, GPU sans operator, release channels.
- Tu sais citer pour OpenShift : SCC et UID arbitraire, Routes, ODF, OLM et le décalage de versions, `oc`.
- Tu sais ce que chaque distribution on-prem fournit ou non, et les six points communs de l'on-prem.
- Tu sais lister ce qui a besoin d'Internet dans une plateforme LLM et sa réponse en air-gapped — y compris « inférence déportée impossible ».
- Tu as un questionnaire de découverte exécutable en commandes, et une brique de values par dimension.

**Étape suivante** : `etape-11-architecture-plateforme-llm.md` — modèle vs plateforme, les quatre plans, les familles de composants, et la règle « descendre d'un plan ». Début de la partie C.
