# Étape 5 — Stockage

**Objectif** : à la fin de cette étape, tu sais ce qui survit à la mort d'un pod et ce qui ne survit pas, comment un disque est demandé, fourni et attaché, pourquoi un PVC reste `Pending`, et ce qui change entre GKE, OpenShift et un cluster on-prem. Tu connais aussi les deux ou trois erreurs de stockage qui bloquent réellement des déploiements de plateforme.

**Prérequis** : étape 3 (StatefulSet) et étape 2 (finalizers).

Pourquoi ça compte pour toi : le plan de données d'une plateforme LLM (§9) — bases relationnelles, cache, bus, base analytique, stockage objet — repose entièrement sur des volumes persistants. Le stockage est **le** point où l'infrastructure du client rencontre ton chart : tu ne fabriques pas les StorageClasses (§1, frontière de responsabilité), mais ton chart doit fonctionner avec celles qui existent. Et c'est aussi là que se jouent les sauvegardes (§10).

---

## 5.1 Ce qu'un pod perd quand il meurt

Le système de fichiers d'un conteneur est la couche d'écriture au-dessus de l'image (étape 0.2). Elle disparaît avec le conteneur. Tout ce qui doit survivre — à un redémarrage, à un redéploiement, à un déplacement sur un autre nœud — doit être dans un **volume**.

Un volume est déclaré au niveau du **pod** (`spec.volumes`), puis **monté** dans un ou plusieurs conteneurs (`volumeMounts`). Le même volume peut être partagé entre les conteneurs d'un pod : c'est ainsi qu'un init container télécharge un modèle que le conteneur principal lira.

```yaml
spec:
  volumes:
    - name: cache
      emptyDir: {}
    - name: config
      configMap: { name: api-config }
    - name: data
      persistentVolumeClaim: { claimName: data-api }
  containers:
    - name: api
      volumeMounts:
        - { name: cache,  mountPath: /tmp/cache }
        - { name: config, mountPath: /etc/api, readOnly: true }
        - { name: data,   mountPath: /var/lib/api }
```

Les types de volume que tu verras tout le temps :

| Type | Durée de vie | Usage |
|---|---|---|
| **emptyDir** | Celle du **pod** (survit à un redémarrage de conteneur, pas à un rescheduling) | Cache, scratch, partage entre init container et conteneur principal |
| **emptyDir** `medium: Memory` | Idem, mais en RAM (tmpfs) | `/dev/shm` pour les serveurs d'inférence : PyTorch/vLLM ont besoin d'une mémoire partagée bien plus grande que les 64 Mo par défaut ; compte dans la limite mémoire du pod |
| **configMap / secret** | Celle de l'objet source ; mis à jour automatiquement (avec délai) sauf si monté via `subPath` | Fichiers de configuration, certificats |
| **projected** | Idem | Combiner plusieurs sources dans un seul répertoire ; c'est aussi comme ça qu'arrive le token de ServiceAccount |
| **hostPath** | Celle du nœud | Accès au système de fichiers du nœud. Réservé aux DaemonSets système (collecteurs de logs, CSI, GPU). Dans un chart applicatif, c'est un signal d'alarme : non portable, refusé par les Pod Security Standards |
| **persistentVolumeClaim** | Indépendante du pod | Tout ce qui est vraiment persistant — c'est le sujet de cette étape |
| **ephemeral** (generic ephemeral volume) | Celle du pod, mais provisionné comme un PVC | Un disque temporaire de grande taille (téléchargement de modèle) sans polluer le nœud |

---

## 5.2 Les trois objets : PVC, PV, StorageClass

Kubernetes sépare **la demande** de **la fourniture** de stockage, exactement comme un pod ne choisit pas son nœud.

- **PersistentVolumeClaim (PVC)** — *la demande*, écrite par l'application (ou son chart) : « je veux 20 Gi, en lecture-écriture par un seul nœud, de la classe `fast` ». Objet **namespacé**.
- **PersistentVolume (PV)** — *le disque réel*, tel que Kubernetes le connaît : un disque GCE, un volume Ceph, un export NFS, un répertoire local. Objet **cluster** (pas de namespace).
- **StorageClass (SC)** — *le catalogue* : « voici comment fabriquer un PV quand un PVC le demande » : quel driver, quels paramètres (type de disque, réplication, système de fichiers), quelle politique de récupération. Objet cluster, fourni par l'admin ou le cloud.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-db
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fast          # omis → la StorageClass PAR DÉFAUT du cluster
  resources:
    requests:
      storage: 20Gi
```

### Le cycle : Pending → Bound
1. Le PVC est créé, statut `Pending`.
2. **Provisioning dynamique** (le cas normal) : le provisioner de la StorageClass crée un disque et un PV correspondant. **Provisioning statique** (on-prem ancien, NFS manuel) : un admin a créé des PV à l'avance et Kubernetes en choisit un compatible (taille ≥ demandée, mode d'accès, classe).
3. Le PVC et le PV sont **liés** (`Bound`), un pour un, définitivement.
4. Le pod qui référence le PVC peut démarrer ; le kubelet attache et monte le volume.

Ce que ça donne à l'écran :

```bash
kubectl get pvc
NAME      STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS
data-db   Bound    pvc-9c1e…                                  20Gi       RWO            fast

kubectl get pv
NAME        CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM             STORAGECLASS
pvc-9c1e…   20Gi       RWO            Delete           Bound    platform/data-db  fast

kubectl get storageclass
NAME             PROVISIONER          RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION
fast (default)   pd.csi.storage.gke.io  Delete        WaitForFirstConsumer   true
```

Ces trois commandes, plus `kubectl describe pvc`, sont tout le diagnostic de base.

### Les paramètres qui comptent

**accessModes** — ce que le stockage *sait faire*, pas ce que le pod veut :

| Mode | Abrégé | Signification | Qui le fournit |
|---|---|---|---|
| ReadWriteOnce | RWO | Un seul **nœud** peut monter en écriture (plusieurs pods du même nœud, si) | Tous les disques bloc : GCE PD, EBS, Ceph RBD, Longhorn, local |
| ReadWriteOncePod | RWOP | Un seul **pod** | CSI récents ; verrou strict pour les bases |
| ReadOnlyMany | ROX | Plusieurs nœuds, lecture seule | Disques bloc en lecture, NFS |
| ReadWriteMany | RWX | Plusieurs nœuds en écriture | **Uniquement les systèmes de fichiers partagés** : NFS, CephFS, Filestore (GCP), EFS (AWS), Azure Files |

**RWX est le premier point à vérifier chez un client.** Un composant qui a besoin d'un volume partagé entre plusieurs réplicas (fichiers uploadés, poids de modèles partagés, cache commun) demande du RWX, et sur GKE une StorageClass par défaut de type disque persistant **ne le fournit pas** : le PVC reste `Pending`. Il faut Filestore, ou remplacer le volume partagé par du stockage objet, ce que fait la plateforme pour les fichiers (§9).

**reclaimPolicy** — ce qui arrive au PV (et au disque) quand le PVC est supprimé :
- `Delete` (défaut des classes cloud) : le disque est détruit. Les données avec.
- `Retain` : le PV passe en `Released`, le disque reste, les données aussi — mais le PV n'est **pas** réutilisable tel quel (il garde la référence à l'ancien PVC ; il faut retirer `spec.claimRef` à la main). C'est la politique à exiger pour les bases de données de production.

**volumeBindingMode** :
- `Immediate` : le PV est créé dès que le PVC existe, sans savoir où ira le pod. Sur un cloud multi-zones, le disque peut être créé en zone A et le pod planifié en zone B → le pod reste `Pending` avec `volume node affinity conflict`.
- `WaitForFirstConsumer` : le PV est créé au moment où le pod est planifié, dans la bonne zone. C'est le bon réglage et le défaut des classes modernes ; conséquence visible : un PVC seul reste `Pending` avec le message `waiting for first consumer to be created before binding` — **ce n'est pas une erreur**.

**allowVolumeExpansion** : si `true`, on peut augmenter `resources.requests.storage` d'un PVC existant (jamais le réduire). L'extension du système de fichiers se fait au prochain montage ou en ligne selon le driver. Un chart qui monte de version en augmentant la taille d'un PVC échouera net sur une classe qui ne le permet pas.

**StorageClass par défaut** : un PVC sans `storageClassName` utilise la classe annotée `storageclass.kubernetes.io/is-default-class: "true"`. **S'il n'y en a pas** (fréquent sur un cluster kubeadm nu), le PVC reste `Pending` pour toujours, sans message clair. Si un chart écrit `storageClassName: ""` (chaîne vide), il demande explicitement *aucune* classe = provisioning statique uniquement. La différence entre « absent » et « vide » est un piège de templating Helm connu.

---

## 5.3 CSI : qui fabrique et attache les disques

Le **Container Storage Interface** est le standard que tous les drivers de stockage implémentent. Un driver CSI installé sur le cluster, c'est typiquement :

- un **controller** (Deployment) qui crée/supprime les volumes chez le fournisseur et les attache aux nœuds ;
- un **node plugin** (DaemonSet) sur chaque nœud, qui formate et monte le volume dans le pod.

Tu le vois avec `kubectl get csidrivers` et `kubectl get pods -A | grep csi`. Sur GKE le driver PD est préinstallé ; sur on-prem, c'est le client qui l'a installé (vSphere CSI, Ceph CSI via Rook, Longhorn, NFS CSI…) — ou pas, et dans ce cas rien ne se provisionne.

Deux objets CSI utiles :
- **VolumeAttachment** (cluster) : la trace « ce volume est attaché à ce nœud ». À regarder quand un pod reste `ContainerCreating` avec `Multi-Attach error` : le volume est encore attaché à un nœud qui est tombé.
- **VolumeSnapshot / VolumeSnapshotClass** : des instantanés de disque déclaratifs, base des sauvegardes (Velero, plugins d'opérateurs de bases — §10). Pas tous les drivers les supportent.

---

## 5.4 Ce qui change d'un environnement à l'autre

C'est le tableau à avoir en tête avant chaque déploiement client.

| Environnement | StorageClass typique | RWO | RWX | Snapshots | Pièges |
|---|---|---|---|---|---|
| **GKE** | `standard-rwo`, `premium-rwo` (PD balanced/SSD, CSI) | Oui | **Non** (il faut Filestore : `standard-rwx`, coûteux, min 1 Ti) | Oui | Disques **zonaux** : WaitForFirstConsumer obligatoire ; un node pool d'une seule zone limite où le pod peut revenir |
| **OpenShift** | OpenShift Data Foundation (Ceph) : `ocs-storagecluster-ceph-rbd` (RWO), `-cephfs` (RWX) ; ou le CSI du sous-jacent | Oui | Oui via CephFS | Oui | SCC et `fsGroup` : les pods tournent avec un UID arbitraire, les fichiers doivent être accessibles au groupe |
| **On-prem VMware** | vSphere CSI | Oui | Non (sauf vSAN file services) | Partiel | Datastore plein = PVC Pending sans message parlant |
| **On-prem Ceph / Rook** | `rook-ceph-block`, `rook-cephfs` | Oui | Oui | Oui | Performances très variables ; Ceph en état `HEALTH_WARN` = tout ralentit |
| **Longhorn** (RKE2, k3s) | `longhorn` | Oui | Oui (via NFS interne, moins performant) | Oui | Réplication 3 par défaut : un cluster à 2 nœuds dégrade tous les volumes |
| **NFS** | `nfs-client` ou NFS CSI | Oui | Oui | Non | Verrouillage de fichiers douteux : **jamais pour une base de données** ; permissions root squash |
| **k3s / kind** | `local-path` | Oui (nœud-local !) | Non | Non | Le volume est **collé au nœud** : le pod ne peut jamais être replanifié ailleurs ; pas d'expansion |

Les questions à poser (ou à vérifier soi-même avec `kubectl get sc`) avant de dire « ça va s'installer » :
1. Y a-t-il une StorageClass par défaut, et laquelle ?
2. Une classe RWX existe-t-elle ? Sinon, quels composants du chart en ont besoin, et y a-t-il une alternative (stockage objet) ?
3. Les snapshots sont-ils supportés ? (sauvegardes)
4. Quelle capacité reste-t-il réellement ? (Ceph, vSphere)
5. Les disques sont-ils zonaux, et les nœuds répartis sur plusieurs zones ?

---

## 5.5 Stockage et StatefulSet, Helm, mises à jour

### volumeClaimTemplates
Un StatefulSet ne référence pas un PVC : il porte un **modèle** de PVC, et en crée un par pod, nommé `<template>-<statefulset>-<index>` (`data-db-0`, `data-db-1`). Le PVC suit l'index : si `db-1` est recréé sur un autre nœud, il retrouve `data-db-1` (si le stockage n'est pas nœud-local).

Deux règles de survie :
- **Les PVC d'un StatefulSet ne sont pas supprimés avec lui.** `kubectl delete sts db` laisse `data-db-0` et `data-db-1` en place. C'est une protection : on ne perd pas une base par un `delete` malheureux. Depuis Kubernetes 1.27 on peut changer ça avec `persistentVolumeClaimRetentionPolicy: { whenDeleted: Delete, whenScaled: Delete }`.
- **Le template est immuable.** Impossible de changer la taille ou la classe dans `volumeClaimTemplates` d'un StatefulSet existant : l'API refuse. Pour agrandir, on agrandit chaque PVC individuellement (`kubectl edit pvc data-db-0`), et on met à jour le template en recréant le StatefulSet avec `--cascade=orphan` (étape 2). Une montée de version de chart qui augmente une taille de volume échoue donc systématiquement si le chart ne prévoit rien.

### Helm et les PVC
`helm uninstall` supprime les objets de la release, **y compris les PVC déclarés directement** dans le chart (pas ceux des `volumeClaimTemplates`, qui appartiennent aux StatefulSets et suivent la règle ci-dessus). Certains charts protègent leurs PVC avec l'annotation `helm.sh/resource-policy: keep`. Avant un `uninstall` sur un environnement qui compte, liste ce qui va disparaître et ce qui va rester : `kubectl get pvc -l app.kubernetes.io/instance=<release>`.

### RWO et rolling update
Un Deployment à 1 réplica avec un volume RWO et la stratégie `RollingUpdate` (défaut) se bloque à la mise à jour : le nouveau pod ne peut pas monter le volume tant que l'ancien le tient (`Multi-Attach error for volume`), et l'ancien ne s'arrête pas tant que le nouveau n'est pas prêt. Solutions : `strategy: Recreate`, ou du RWX, ou un StatefulSet. C'est un bug de chart classique qui ne se voit qu'à la **deuxième** installation.

### Permissions
Un conteneur qui tourne sous un utilisateur non-root (règle chez tout client sérieux, et par défaut sur OpenShift) ne peut pas écrire sur un volume dont la racine appartient à root. La solution standard est `securityContext.fsGroup: <gid>` au niveau du pod : le kubelet donne le volume à ce groupe au montage. Le symptôme sans ça : `permission denied` dans les logs au démarrage, souvent dans un init container de migration. Sur OpenShift, ne fixe **pas** de `fsGroup` en dur : le SCC en attribue un dans la plage du namespace (étape 6, étape 10).

---

## 5.6 Diagnostic

| Symptôme | Commande | Causes fréquentes |
|---|---|---|
| PVC `Pending` | `kubectl describe pvc` → Events | Pas de StorageClass par défaut ; classe inexistante ; `WaitForFirstConsumer` sans pod (normal) ; RWX demandé sur une classe RWO ; quota ou capacité épuisée ; driver CSI absent |
| Pod `Pending` avec volume `Bound` | `describe pod` | `volume node affinity conflict` (zone), nœud-local sans le nœud |
| Pod `ContainerCreating` longtemps | `describe pod` ; `kubectl get volumeattachment` | `Multi-Attach error` (RWO tenu ailleurs), `FailedMount` (driver, NFS injoignable, `fsGroup` sur un gros volume qui prend des minutes) |
| `permission denied` au démarrage | `logs -c <init>` | `fsGroup` absent, UID arbitraire OpenShift, root squash NFS |
| Disque plein | `kubectl exec <pod> -- df -h /chemin` | Logs, WAL de base, cache de modèles ; agrandir le PVC si la classe le permet |
| PVC ou PV bloqué en `Terminating` | `-o yaml \| yq .metadata.finalizers` | `kubernetes.io/pvc-protection` : un pod l'utilise encore ; sinon étape 2 |
| PV `Released` inutilisable | `kubectl get pv` | Reclaim `Retain` : retirer `spec.claimRef` pour le réattribuer, après vérification des données |

---

## 5.7 Exercice — clavier en main

```bash
kubectl config current-context && kubectl create namespace lab5 && kubens lab5
kubectl get storageclass          # kind fournit « standard » (local-path), défaut
```

1. **PVC seul.** Crée un PVC `test` de 1Gi sans classe explicite. `kubectl get pvc` → `Pending`, et `describe` explique : `waiting for first consumer`. Ce n'est pas une erreur. Lance un pod busybox qui le monte sur `/data` : le PVC passe `Bound`, un PV apparaît. Lis `kubectl get pv -o yaml | yq '.items[0].spec'` : repère `nodeAffinity` (volume collé au nœud), `persistentVolumeReclaimPolicy`, `claimRef`.

2. **Persistance à travers la mort du pod.** Dans le pod : `echo hello > /data/f`. Supprime le pod, relances-en un autre montant le même PVC : `cat /data/f` → `hello`. Le PVC a survécu ; le pod non.

3. **emptyDir vs PVC.** Ajoute au même pod un `emptyDir` sur `/scratch`, écris dedans, supprime le pod, relance : `/scratch` est vide, `/data` non. Ajoute un `emptyDir` `medium: Memory, sizeLimit: 256Mi` sur `/dev/shm` et vérifie avec `df -h /dev/shm` que c'est un tmpfs de 256 Mo — c'est exactement le réglage d'un pod d'inférence.

4. **Classe inexistante.** PVC `bad` avec `storageClassName: fast`. `Pending`, et cette fois `describe` dit `storageclass.storage.k8s.io "fast" not found`. Compare avec le point 1 : même statut, cause différente, seul `describe` les distingue. Supprime-le.

5. **RWX sur une classe qui ne sait pas.** PVC `shared` avec `accessModes: [ReadWriteMany]`, monté par un pod. Observe ce que local-path fait (selon la version, il refuse ou provisionne un volume qui n'est RWX que de nom — note ce que **tu** constates, avec la version du provisioner : `kubectl -n local-path-storage get deploy -o yaml | yq '.items[0].spec.template.spec.containers[0].image'`).

6. **Expansion.** Passe le PVC `test` à 2Gi avec `kubectl edit pvc test`. Lis l'erreur ou l'événement : local-path n'a pas `allowVolumeExpansion`. C'est ce qu'un client avec une classe ancienne te renverra.

7. **StatefulSet et ses PVC.** Déploie un StatefulSet `db` (`postgres:16`, `POSTGRES_PASSWORD=lab`, 2 réplicas, `volumeClaimTemplates` de 1Gi monté sur `/var/lib/postgresql/data`, Service headless). Attends `db-0` et `db-1` `Running`. Puis :
   ```bash
   kubectl exec db-0 -- psql -U postgres -c "create table t(x int); insert into t values (42);"
   kubectl delete pod db-0 && kubectl get pods -w        # db-0 revient, même nom
   kubectl exec db-0 -- psql -U postgres -c "select * from t;"   # 42 : même disque
   kubectl delete sts db
   kubectl get pvc                                        # data-db-0 et data-db-1 sont TOUJOURS là
   ```
   Recrée le StatefulSet à l'identique : `db-0` retrouve sa table. Puis tente de changer la taille dans `volumeClaimTemplates` et applique : lis le refus de l'API.

8. **Reclaim policy.** Passe le PV de `data-db-1` en `Retain` :
   ```bash
   PV=$(kubectl get pvc data-db-1 -o jsonpath='{.spec.volumeName}')
   kubectl patch pv $PV -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
   kubectl delete sts db --cascade=orphan ; kubectl delete pod db-1 ; kubectl delete pvc data-db-1
   kubectl get pv                                         # $PV est Released, pas supprimé
   ```
   Tente de recréer le PVC `data-db-1` : il ne se lie **pas** au PV `Released`. Retire le `claimRef` (`kubectl patch pv $PV --type=json -p '[{"op":"remove","path":"/spec/claimRef"}]'`) et observe le nouveau `Bound`. Voilà la manipulation qu'on fait pour récupérer une base après un `helm uninstall` sur un PV en `Retain`.

9. **pvc-protection.** Avec un pod qui monte encore `data-db-0`, lance `kubectl delete pvc data-db-0 --wait=false` : le PVC reste `Terminating`. Lis son finalizer. Supprime le pod : le PVC disparaît seul. Tu viens de voir le mécanisme de l'étape 2 en situation réelle — et pourquoi il ne faut **pas** retirer ce finalizer à la main.

10. **fsGroup.** Un pod `nginx` avec `securityContext: { runAsUser: 1000, runAsNonRoot: true }` et un PVC monté sur `/data`, commande `sh -c 'touch /data/ok && sleep 3600'`. Selon le provisioner, il échoue avec `permission denied` ou passe (local-path crée souvent le répertoire en 777 — note ce que tu constates). Ajoute `fsGroup: 1000` et compare `ls -ln /data` dans les deux cas.

11. **Nettoie** : `kubectl delete namespace lab5`, puis `kubectl get pv` : le PV en `Retain` est resté. Supprime-le à la main. Un PV oublié sur un cloud, c'est un disque facturé (§15).

---

## Validé si…

- Tu sais expliquer la différence PVC / PV / StorageClass avec une analogie en une phrase, et pourquoi le PVC est namespacé et le PV non.
- Tu sais donner les quatre causes d'un PVC `Pending` et la commande qui les distingue.
- Tu sais pourquoi RWX est la première question à poser sur GKE, et quelle alternative propose la plateforme.
- Tu sais ce qui arrive aux données après `kubectl delete sts`, après `helm uninstall`, et selon la reclaim policy.
- Tu sais pourquoi un Deployment RWO se bloque en rolling update et comment l'éviter.
- Tu sais quel réglage de sécurité règle un `permission denied` sur un volume, et pourquoi il ne faut pas le coder en dur pour OpenShift.

**Étape suivante** : `etape-06-configuration-secrets-acces.md` — ConfigMap/Secret en pratique, secrets externes, RBAC, Pod Security, et l'hygiène des secrets et des accès.
