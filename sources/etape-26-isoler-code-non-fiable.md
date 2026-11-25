# Étape 26 — Isoler du code non fiable : sandboxes, gVisor, Kata

**Objectif** : à la fin de cette étape, tu sais expliquer pourquoi le code exécuté par un agent IA ne tourne pas dans un conteneur ordinaire, ce qu'isole vraiment un conteneur et ce qu'il n'isole pas, comment on branche un autre runtime (gVisor, Kata Containers) dans un cluster, comment on le choisit pod par pod avec une RuntimeClass, quels garde-fous Kubernetes viennent autour, quelles questions poser au client avant d'installer, et comment diagnostiquer une sandbox qui ne démarre pas ou démarre trop lentement.

**Prérequis** : étapes 1 (kubelet, containerd), 4 (NetworkPolicy), 6 (RBAC, ServiceAccount, Pod Security), 10 (multi-environnement clients). L'étape 16 situe l'exécution de code parmi les fonctionnalités produit.

Pourquoi ça compte pour toi : une plateforme LLM qui fait tourner des agents leur donne souvent un outil « exécuter du code » (analyse de fichiers, graphiques, scripts). Ce code est écrit par un modèle, à partir d'un texte qui peut venir de n'importe où : il est **non fiable par définition**. Le faire tourner sur les mêmes nœuds que le reste de la plateforme sans isolation forte, c'est laisser un inconnu entrer dans l'immeuble. Et chez un client, l'isolation forte dépend de ses nœuds, de ses droits et de son réseau : c'est exactement le genre de prérequis qui bloque une installation si on le découvre le jour J.

Sources de cette étape : documentation Kubernetes (`kubernetes.io/docs` : RuntimeClass, Pod Security Admission, NetworkPolicy, ResourceQuota, LimitRange, Linux kernel security constraints), documentation gVisor (`gvisor.dev/docs`), documentation Kata Containers (`github.com/kata-containers/kata-containers/docs`, `kata-deploy`), documentation GKE Sandbox (`cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods`), projet `kubernetes-sigs/agent-sandbox`. Versions à l'écriture (novembre 2026). Ce qui dépend d'une version ou de ton produit est marqué « à vérifier ».

---

## 26.1 Une sandbox, c'est quoi et pourquoi

Une **sandbox** est un environnement **jetable** dans lequel on exécute du code auquel on ne fait pas confiance. Trois propriétés la définissent :

| Propriété | Ce que ça veut dire |
|---|---|
| **Isolation** | Le code ne voit et ne touche que ce qu'on lui donne : pas le nœud, pas les autres sandboxes, pas le réseau interne. |
| **Limites de ressources** | CPU, mémoire, disque, nombre de processus plafonnés : une boucle infinie ne fait tomber que sa sandbox. |
| **Durée de vie courte** | Créée pour une tâche ou une session, détruite après. Rien ne s'accumule, rien ne persiste par accident. |

Pourquoi le code d'un agent est non fiable **par définition** : le modèle écrit le code à partir de son contexte, et ce contexte contient des textes externes (un fichier envoyé, une page web lue, un e-mail). Un texte peut contenir des instructions cachées que le modèle suit : c'est la **prompt injection**. On ne peut donc jamais garantir que le code exécuté est celui que l'utilisateur voulait. On ne cherche pas à filtrer le code ; on suppose qu'il est hostile et on **contient** ce qu'il peut faire.

Ce qu'il faut protéger, dans l'ordre :

1. **Le serveur** (le nœud) : si le code sort de sa sandbox, il atteint tous les pods du nœud, leurs secrets, et souvent les identifiants du nœud.
2. **Les autres tenants** : une sandbox ne doit ni lire ni gêner celle d'un autre client ou d'un autre utilisateur.
3. **Le réseau** : la sandbox ne doit joindre ni les services internes (bases, API d'administration, endpoint de metadata du cloud) ni Internet sans contrôle.

Particularité d'exploitation : les sandboxes sont créées et détruites **en grand nombre**, parfois des milliers par jour. Tout ce qui coûte à la création (scheduling, pull d'image, démarrage du runtime) se paie à chaque fois (26.10).

---

## 26.2 Un conteneur n'est pas une VM

Un conteneur est un **processus Linux ordinaire** du nœud, auquel le noyau applique des restrictions. Quatre mécanismes :

| Mécanisme | Ce qu'il règle | Exemple |
|---|---|---|
| **Namespaces** | Ce que le processus **voit** : ses processus, son réseau, ses montages, son nom d'hôte, ses utilisateurs | `ps` dans le conteneur ne montre que ses processus |
| **cgroups** | Ce qu'il **consomme** : CPU, mémoire, nombre de processus | Dépasser la limite mémoire : `OOMKilled` |
| **seccomp** | Quels **appels système** il a le droit de faire au noyau | Le profil `RuntimeDefault` bloque des appels rares et dangereux |
| **Capabilities** | Quels **privilèges root** il garde (une trentaine, découpés) | `CAP_SYS_ADMIN` (montages, beaucoup d'autres choses) retiré par défaut |

Et un point qui n'est pas un mécanisme mais une conséquence : **un seul noyau**, celui du nœud, est partagé par tous les conteneurs du nœud. Chaque appel système d'un conteneur est traité par ce noyau.

| Ce qu'un conteneur isole | |
|---|---|
| La vue des processus, du réseau, des fichiers | ✔ namespaces |
| La consommation de CPU et de mémoire | ✔ cgroups |
| Une partie des appels système dangereux | ✔ seccomp, capabilities |
| **Le noyau** : une faille du noyau exploitable par un appel système autorisé | ✘ partagé |
| **Une faille du runtime** (`runc`) | ✘ exemples réels : CVE-2019-5736 (réécriture du binaire `runc` du nœud), CVE-2024-21626 (« Leaky Vessels », accès au système de fichiers du nœud) |
| Une configuration permissive (privilégié, montage du nœud) | ✘ elle annule les protections (26.3) |

Une **machine virtuelle**, elle, a **son propre noyau** : le code invité parle à son noyau, et ce noyau parle à un hyperviseur par une interface beaucoup plus étroite que les plusieurs centaines d'appels système de Linux.

Piège : croire qu'un `docker run` (ou un pod) est aussi étanche qu'une VM. C'est vrai pour une application qu'on a écrite et qu'on fait confiance ; c'est faux pour du code qu'un attaquant peut choisir. Une faille du noyau touche **tous** les conteneurs du nœud.

---

## 26.3 Le mode privilégié et FUSE

`securityContext.privileged: true` désactive presque toutes les protections de 26.2 :

- toutes les **capabilities**, dont `CAP_SYS_ADMIN` ;
- l'accès aux **devices** du nœud (`/dev` complet : disques, etc.) ;
- le droit de faire des **montages**, seccomp et AppArmor/SELinux relâchés.

Un conteneur privilégié peut en pratique monter le disque du nœud et en prendre le contrôle : c'est **presque un accès root au nœud**.

**FUSE** (Filesystem in Userspace) permet à un programme de fournir un système de fichiers : par exemple, monter un bucket ou un espace de fichiers distant comme un dossier de la sandbox. Il a besoin du device `/dev/fuse` et du droit de monter, donc en général du mode privilégié ou de `CAP_SYS_ADMIN` plus le device. C'est pour ça que les produits qui montent les fichiers de l'utilisateur dans la sandbox par FUSE demandent souvent `privileged: true`.

L'alternative : **synchroniser les fichiers** (les copier dans la sandbox au démarrage, et rapatrier les résultats à la fin ou par intervalles). Plus lent, surtout pour de gros volumes, mais **aucun privilège** n'est requis.

| Option | Privilège | Vitesse d'accès aux fichiers |
|---|---|---|
| Montage FUSE | ✘ privilégié ou `CAP_SYS_ADMIN` + `/dev/fuse` | ✔ fichiers disponibles tout de suite, à la demande |
| Synchronisation | ✔ aucun | ✘ copie au démarrage, plus lente |

Avec gVisor ou Kata, le mode privilégié s'applique à l'intérieur du mur (le noyau de gVisor ou celui de la VM), pas au noyau du nœud : le risque change de nature. Le comportement exact (FUSE pris en charge ou non, à quelles conditions) dépend du runtime et de sa version : à vérifier.

Sur le terrain : l'équipe sécurité du client refuse presque toujours le mode privilégié pour du code non fiable, et Pod Security Admission au niveau `baseline` ou `restricted` le bloque de toute façon. Si ton produit en a besoin, c'est un **compromis à faire valider par écrit**, avec l'alternative sans privilège en face.

---

## 26.4 La chaîne qui lance un conteneur

Quand un pod arrive sur un nœud, voici qui fait quoi :

1. **kubelet** voit le pod assigné à son nœud et demande au runtime de conteneurs de le créer, par l'interface **CRI** (Container Runtime Interface, gRPC).
2. **containerd** (ou CRI-O) reçoit la demande, tire l'image, prépare les fichiers.
3. Pour chaque pod, containerd lance un **shim** : un petit processus qui fait le lien entre containerd et le runtime bas niveau, et qui survit à un redémarrage de containerd.
4. Le shim appelle le **runtime bas niveau**, celui qui crée vraiment l'isolation :
   - `runc` : conteneur classique (namespaces, cgroups) ;
   - `runsc` : gVisor ;
   - Kata : une micro-VM.

Le shim est **la prise** sur laquelle on branche un autre runtime. Dans containerd, chaque runtime disponible est déclaré dans `config.toml`, avec un nom (le **handler**) et un type de shim :

```toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"     # cherche containerd-shim-runsc-v1
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
  runtime_type = "io.containerd.kata.v2"      # cherche containerd-shim-kata-v2
```

(Avec containerd 2.x et le format de configuration `version = 3`, le chemin devient `plugins."io.containerd.cri.v1.runtime".containerd.runtimes.<nom>`.)

Conséquence : **changer de runtime, c'est modifier le nœud**. Il faut, sur chaque nœud concerné, installer les binaires (runtime et shim), ajouter le bloc dans `config.toml`, redémarrer containerd. Sur un cluster qu'on ne gère pas à la main, ça se fait avec un **DaemonSet privilégié** qui écrit sur le système de fichiers du nœud (c'est ce que fait `kata-deploy` pour Kata), ou par l'image de nœud du fournisseur (GKE Sandbox pour gVisor).

Piège : croire que changer de runtime se fait seulement dans le YAML du pod. Le YAML (26.6) choisit un runtime **parmi ceux que le nœud connaît déjà**. Si le nœud ne le connaît pas, le pod ne démarre pas.

Commandes pour constater : `crictl info` sur le nœud (la section des runtimes déclarés), `kubectl get runtimeclass` côté cluster.

---

## 26.5 gVisor et Kata : deux murs différents

**gVisor** (`runsc`, projet Google) intercale un **noyau écrit en espace utilisateur**, le **Sentry** : les appels système du code sont traités par le Sentry, qui n'en transmet qu'un petit nombre, filtré, au vrai noyau. Les accès aux fichiers passent par un composant séparé (le Gofer, ou un mécanisme équivalent selon la version). Conséquences :

- aucun prérequis matériel : pas besoin de KVM, ça marche dans une VM cloud ordinaire ;
- intégré à GKE (**GKE Sandbox** : un node pool dédié créé avec le sandbox activé, pas le node pool par défaut, et `runtimeClassName: gvisor` dans le pod) ;
- coût : les appels système et les **I/O** (fichiers, réseau) sont plus lents ; certaines applications qui utilisent des appels système rares ne fonctionnent pas ;
- GPU : pris en charge pour une partie des GPU NVIDIA et des versions de pilote (CUDA) ; à vérifier pour le modèle et la version.

**Kata Containers** lance **une micro-VM par pod**, avec son propre noyau, gérée par un hyperviseur : QEMU, Cloud Hypervisor ou Firecracker. Les conteneurs du pod tournent dans cette VM. Conséquences :

- l'isolation la plus forte des trois : la frontière est celle de la virtualisation matérielle ;
- il faut **KVM** sur le nœud : un serveur bare metal, ou une VM cloud avec la **virtualisation imbriquée** activée (selon le cloud et le type d'instance) ;
- chaque VM consomme de la **mémoire** et un peu de CPU en plus du conteneur (son noyau, son agent) : c'est l'overhead (26.6) ;
- démarrage plus long qu'un conteneur classique, de l'ordre de la seconde selon l'hyperviseur ;
- GPU possible par passthrough (VFIO), mais à configurer spécifiquement ; à vérifier.

| | runc | gVisor | Kata |
|---|---|---|---|
| Isolation | Namespaces, noyau partagé | Noyau en espace utilisateur | Micro-VM, noyau dédié |
| Démarrage | Le plus rapide | Proche de runc | Plus lent (VM) |
| Prérequis nœud | Aucun | Binaires `runsc` + shim | KVM (bare metal ou imbriqué) + binaires |
| Coût en ressources | Aucun | Faible, mais I/O plus lentes | Mémoire par pod (la VM) |
| FUSE | Avec privilèges | Selon version, à vérifier | Dans la VM, à vérifier |
| GPU | ✔ | Partiel (NVIDIA, CUDA) | Passthrough, complexe |

À retenir : gVisor est le **choix facile par défaut** (pas de matériel spécial, disponible sur GKE). Kata est **le plus fort**, mais il a besoin de nœuds compatibles.

---

## 26.6 RuntimeClass : choisir le mur, pod par pod

Une **RuntimeClass** est un objet de cluster (`node.k8s.io/v1`) qui donne un nom Kubernetes à un handler du nœud :

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: { name: gvisor }
handler: runsc                 # le nom déclaré dans config.toml
overhead:
  podFixed: { memory: 64Mi, cpu: 100m }
scheduling:
  nodeSelector: { sandbox: gvisor }
  tolerations:
    - { key: sandbox, operator: Equal, value: gvisor, effect: NoSchedule }
```

- **`handler`** : le nom du runtime dans la configuration de containerd. Ne se modifie pas après création.
- **`overhead`** : ce que le runtime consomme en plus des conteneurs (la VM de Kata, le Sentry de gVisor). Il est ajouté aux requests du pod pour le scheduling et compté dans les quotas.
- **`scheduling`** : `nodeSelector` et `tolerations` ajoutés automatiquement aux pods qui utilisent la classe, pour qu'ils aillent **seulement** sur les nœuds où le runtime est installé.

Le pod choisit sa classe avec un seul champ : `spec.runtimeClassName: gvisor`. Sans ce champ, c'est le runtime par défaut du nœud (`runc`).

Le schéma classique : un **node pool dédié aux sandboxes**, avec un label (`sandbox: gvisor`) et un taint (`NoSchedule`). Le taint empêche les autres pods d'y atterrir ; le `scheduling` de la RuntimeClass fait atterrir les sandboxes et seulement elles.

Piège : une RuntimeClass qui pointe vers des nœuds où le runtime n'est pas installé (ou sans `scheduling`, sur un cluster où seuls certains nœuds l'ont). Symptômes : pod bloqué en `ContainerCreating` ou en erreur au démarrage, event `FailedCreatePodSandBox` avec un message du type `no runtime for "runsc" is configured`. Un `runtimeClassName` qui ne correspond à aucune RuntimeClass ne démarre pas non plus (message `RuntimeClass ... not found`).

Commandes : `kubectl get runtimeclass`, `kubectl describe pod` (lire les events), `kubectl get nodes -L sandbox` (quels nœuds portent le label).

---

## 26.7 Multi-tenant : control plane, data plane, tenants

Un service de sandboxes se découpe en deux plans :

- le **control plane** : une API (et son contrôleur) qui reçoit les demandes (« crée une sandbox pour ce tenant, de cette taille ») et crée les pods ;
- le **data plane** : un ou plusieurs clusters où tournent les pods sandbox, avec **un namespace par tenant**.

Vocabulaire courant (les noms exacts dépendent du produit, à vérifier pour le tien) :

| Mot | Ce que c'est |
|---|---|
| **Tenant** | Le client ou l'organisation qui possède les sandboxes ; une frontière d'isolation et de facturation |
| **Région** | Où tournent les sandboxes : un cluster de data plane et un namespace dedans |
| **Instance type** | Un preset de taille : CPU, mémoire, disque (« small », « large ») |

Deux placements :

| Placement | Pour | Contre |
|---|---|---|
| Sandboxes **dans le cluster de l'application** | Simple, un seul cluster à opérer | Les sandboxes partagent l'API server, les nœuds système, les quotas ; une rafale de créations met l'application sous pression |
| Sandboxes dans un **cluster séparé** | Isolation forte du reste de la plateforme, dimensionnement à part | Un cluster de plus, et une connexion réseau à ouvrir vers lui |

Le projet `kubernetes-sigs/agent-sandbox` propose un exemple de contrôleur générique : une ressource `Sandbox`, un modèle (`SandboxTemplate`), une demande (`SandboxClaim`) et un pool de sandboxes prêtes (`SandboxWarmPool`), en s'appuyant sur une RuntimeClass pour l'isolation. Ton produit peut avoir son propre contrôleur : le principe est le même.

**Trois questions à ne pas confondre** :

1. La sandbox est-elle **isolée du nœud** ? → le runtime (gVisor, Kata).
2. Les sandboxes sont-elles **isolées entre elles** ? → namespaces Kubernetes, RBAC, NetworkPolicy, quotas (26.8).
3. **Qui a le droit d'appeler l'API** qui les crée ? → authentification et autorisation du control plane (étape 13).

Une isolation forte du runtime ne répond qu'à la question 1. Si n'importe qui peut appeler l'API et demander une sandbox dans le namespace d'un autre tenant, Kata ne sert à rien.

---

## 26.8 Les garde-fous Kubernetes

Autour du runtime, le cluster de data plane a besoin de cinq garde-fous, par namespace de tenant :

| Garde-fou | Ce qu'il empêche |
|---|---|
| **RBAC limité au namespace** | Le contrôleur (ou le compte d'un tenant) ne crée des pods que dans son namespace ; les pods sandbox n'ont pas de token d'API utile (`automountServiceAccountToken: false`) |
| **ResourceQuota** | Un tenant qui remplit le cluster : plafond de CPU, mémoire, nombre de pods par namespace |
| **LimitRange** | Un pod sans limites, ou trop gros : valeurs par défaut et maximum par pod |
| **NetworkPolicy** « tout bloqué par défaut » | Une sandbox qui joint les services internes, les autres tenants ou Internet ; on n'ouvre que le nécessaire (son proxy, son DNS) |
| **Pod Security Admission** | Un pod privilégié, qui monte le nœud ou utilise le réseau du nœud : le niveau `restricted` (ou `baseline`) sur le namespace le refuse |

Le point le plus souvent oublié : l'**egress**. Une NetworkPolicy qui ne bloque que l'entrée laisse la sandbox sortir. Il faut une politique `Egress` par défaut, qui bloque y compris l'**endpoint de metadata du cloud** (`169.254.169.254`), d'où un pod peut sinon obtenir les identifiants du nœud ou de son compte de service. Rappel de l'étape 4 : une NetworkPolicy ne fait rien si le CNI ne l'applique pas.

Commandes : `kubectl get netpol,resourcequota -n <ns>`, `kubectl auth can-i create pods -n <ns> --as=system:serviceaccount:<ns>:<sa>`.

---

## 26.9 Avant d'installer : les questions au client

| Question | Ce qui casse sinon |
|---|---|
| Les nœuds ont-ils **KVM** (pour Kata) ou **gVisor** est-il installable ou fourni (GKE Sandbox) ? | La RuntimeClass est inutilisable : pods bloqués en `ContainerCreating` |
| Peut-on déployer un **DaemonSet privilégié** (ou le client configure-t-il ses nœuds lui-même) ? | Impossible de configurer containerd sur les nœuds |
| Le **mode privilégié** ou **FUSE** est-il accepté pour les sandboxes ? | Repli sur la synchronisation des fichiers, plus lente |
| Quel **registry** et quel **secret de pull** ? | `ImagePullBackOff` |
| **Toutes** les images sont-elles copiées dans le registry interne, y compris celles ajoutées au moment de l'exécution (images de sandbox choisies par l'utilisateur ou le produit) ? | Le client air-gapped est bloqué à la première image non copiée |
| Quelle **politique d'egress** ? Par où passe la sandbox pour sortir (proxy) ? | La sandbox ne joint pas son proxy, ou au contraire elle joint Internet |
| Les sandboxes vont-elles dans un **cluster dédié** ? | Elles mettent sous pression le cluster applicatif |

Piège : `imagePullPolicy: Always`. Pour un service classique, c'est un détail. Pour des sandboxes créées des milliers de fois, c'est une requête au registry **à chaque création** : démarrage plus lent, registry sollicité, et chaque sandbox échoue si le registry est indisponible. Préférer une image à tag fixe (ou digest) avec `IfNotPresent`.

À retenir : vérifier **les nœuds, les droits, les images et le réseau** avant d'installer quoi que ce soit.

---

## 26.10 Le démarrage, et diagnostiquer

Le **démarrage à froid** d'une sandbox se décompose :

1. **Scheduling** : trouver un nœud qui a la place et le runtime (nodeSelector, taints, quotas).
2. **Pull de l'image** : si elle n'est pas déjà sur le nœud, souvent l'étape la plus longue.
3. **Runtime** : créer le conteneur (runc), démarrer le Sentry (gVisor) ou la VM (Kata).
4. **Initialisation** : le processus de la sandbox démarre, prêt à recevoir du code.
5. **Synchronisation des fichiers** : si on copie les fichiers de l'utilisateur plutôt que de les monter (26.3).

Une sandbox éphémère paie ce coût **à chaque fois**. Les leviers :

| Levier | Ce qu'il retire |
|---|---|
| **Pool de sandboxes prêtes** (warm pool) | Les étapes 1 à 4 : la sandbox est déjà démarrée, on l'attribue |
| **Images pré-téléchargées** sur les nœuds (DaemonSet de pré-pull, image de nœud) | L'étape 2 |
| **Snapshots** (restaurer une sandbox ou une VM depuis un état sauvegardé, selon le runtime) | Une partie des étapes 3 et 4 ; à vérifier selon le runtime |

« Jetable » et « rapide » s'opposent : une sandbox neuve à chaque tâche est plus sûre mais plus lente. Le pool de sandboxes prêtes est le compromis : des sandboxes neuves, jamais réutilisées, mais créées **à l'avance**. Il coûte des ressources réservées en permanence.

**Diagnostiquer** une sandbox qui ne démarre pas, dans cet ordre :

1. **Les events du pod** : `kubectl describe pod`. `FailedScheduling` (pas de nœud compatible, quota), `ImagePullBackOff`, `FailedCreatePodSandBox` (runtime absent ou en erreur).
2. **Les logs du contrôleur** qui crée les sandboxes : la demande est-elle arrivée, a-t-il créé le pod, a-t-il été refusé (RBAC, quota, Pod Security) ?
3. **Le nœud** : `crictl pods`, `crictl ps -a`, `crictl info` (runtimes déclarés), et les logs de containerd (`journalctl -u containerd`) pour les erreurs du shim ou du runtime.

À retenir : « jetable » et « rapide » s'opposent. Le pool de sandboxes prêtes est le compromis.

---

## 26.11 Exercice — clavier en main

Sur le cluster kind `lab`. Environ 45 minutes.

1. **Le noyau partagé.** Compare `uname -r` dans un pod et sur le nœud kind (`docker exec lab-control-plane uname -r`) : même noyau.
2. **La chaîne.** Sur le nœud, lis les runtimes déclarés (`crictl info`, `config.toml`). `kubectl get runtimeclass` : aucune.
3. **Le privilégié.** Compare le contenu de `/dev` dans un pod normal et dans un pod privilégié. Pose Pod Security `restricted` sur un namespace et vérifie que le pod privilégié est refusé.
4. **La RuntimeClass orpheline.** Crée une RuntimeClass `gvisor` (handler `runsc`) avant d'avoir installé gVisor, et un pod qui l'utilise : `ContainerCreating`, event `FailedCreatePodSandBox`.
5. **Installer gVisor à la main** sur le nœud (ce que ferait le DaemonSet) : binaires, bloc dans `config.toml`, redémarrage de containerd. Le même pod démarre ; `uname -r` et `dmesg` montrent le noyau de gVisor.
6. **Les garde-fous.** Un namespace de tenant avec ResourceQuota, NetworkPolicy egress par défaut, `auth can-i`.
7. **Le démarrage.** Lis les events d'une création de sandbox et repère où passe le temps ; compare avec l'image déjà présente.
8. **Nettoyer** : pods, namespaces, RuntimeClass ; le nœud kind garde gVisor jusqu'à sa suppression.

---

## Validé si…

- Tu sais dire ce qu'est une sandbox (isolation, limites, durée de vie courte) et pourquoi le code d'un agent est non fiable par définition.
- Tu sais nommer ce que règlent namespaces, cgroups, seccomp et capabilities, et pourquoi le noyau partagé est la limite d'un conteneur.
- Tu sais ce qu'ouvre le mode privilégié, pourquoi FUSE le demande souvent, et l'alternative sans privilège.
- Tu sais tracer la chaîne kubelet → CRI → containerd → shim → runtime, et pourquoi changer de runtime modifie les nœuds.
- Tu sais comparer runc, gVisor et Kata (isolation, démarrage, prérequis, coût) et dire lequel proposer par défaut.
- Tu sais lire une RuntimeClass (handler, overhead, scheduling) et reconnaître le pod bloqué par un runtime absent.
- Tu sais distinguer les trois questions : isolé du nœud, isolé des autres, qui appelle l'API.
- Tu sais citer les garde-fous Kubernetes d'un namespace de tenant, egress et endpoint de metadata compris.
- Tu sais lister les questions à poser au client avant d'installer, et ce qui casse sans réponse.
- Tu sais décomposer le démarrage à froid, citer les leviers, et diagnostiquer dans l'ordre pod, contrôleur, nœud.

**Étape suivante** : aucune, c'est un cas pratique. Les étapes 6 (accès), 13 (identité) et 20 (méthode de debug) donnent le cadre général.
