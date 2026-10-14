# Étape 19 — k9s et ses équivalents kubectl

**Objectif** : à la fin de cette étape, tu navigues dans un cluster de plusieurs dizaines de pods avec k9s aussi vite qu'avec une souris. Tu sais répondre à « pourquoi ça rame » en moins d'une minute. Pour chaque action, tu connais la commande `kubectl` équivalente, pour le jour où k9s n'est pas disponible (bastion, CI, client qui refuse l'outil).

**Notions couvertes** : §12 (k9s et exploration interactive d'un cluster).

**Prérequis** : partie A (statuts de pod, ownership), partie C (cartographie de la plateforme). Le cluster kind `lab` de l'étape 0 et le parapluie des étapes 8 et 10 déployé dessus.

---

## 19.1 Le modèle mental : k9s est `kubectl get -w` avec un clavier

k9s n'a aucun pouvoir particulier. Il utilise **ton kubeconfig, ton contexte et tes droits RBAC**, exactement comme `kubectl`. Trois conséquences :

- Ce que tu ne peux pas faire en `kubectl` (`auth can-i` = `no`), tu ne peux pas le faire en k9s non plus. Une vue vide ne signifie pas forcément l'absence de ressources : c'est peut-être un `forbidden` silencieux. Le message d'erreur s'affiche en bas de l'écran pendant quelques secondes.
- Une suppression faite dans k9s est **une vraie suppression**, avec la même cascade et le même contrôleur qui recrée derrière (étape 2).
- Il interroge l'API en continu (rafraîchissement toutes les 2 secondes par défaut). Sur un cluster client à l'API server fragile, ou avec des milliers d'objets, reste dans un namespace plutôt qu'en vue `all`.

La structure de l'écran :

```
┌ en-tête : contexte, cluster, user, versions K8s/k9s, CPU/MEM du cluster ┐
│ raccourcis disponibles dans CETTE vue (ils changent d'une vue à l'autre) │
├ Pods(platform)[42] <─ ressource(namespace)[nombre] ─ filtre actif ───────┤
│ tableau, rafraîchi en continu ; couleurs = état                          │
└ fil d'Ariane : <pods> <containers> <logs>                                ┘
```

**Couleurs par défaut** : les lignes rouges signalent un pod en erreur, les lignes orange un pod en transition ou incomplet, et le bleu indique une ressource en cours de suppression. Ce code sert au tri visuel, pas à établir un diagnostic.

**Réflexe numéro un : lire l'en-tête avant de toucher une touche.** Le contexte affiché est-il le bon cluster ? C'est le piège de l'étape 1, en plus dangereux, parce que `Ctrl-d` est plus rapide à taper que `kubectl delete`.

---

## 19.2 Lancer k9s proprement

```bash
k9s                                   # contexte courant, dernier namespace utilisé
k9s --context client-x-prod -n platform
k9s --readonly                        # désactive delete/edit/kill/shell : À UTILISER chez un client
k9s --headless                        # sans l'en-tête (écran étroit, partage)
k9s --logoless
k9s info                              # où sont la config, les logs, les skins
```

`--readonly` est le mode par défaut à adopter quand tu explores un environnement de production ou que tu partages ton écran. Tu quittes et relances sans ce flag le jour où tu dois réellement agir, ce qui constitue une étape consciente et bienvenue.

Tu peux aussi le rendre permanent pour un contexte dans la configuration de k9s (`k9s info` indique le fichier) :

```yaml
k9s:
  readOnly: true
```

---

## 19.3 Navigation

| Touche | Effet |
|---|---|
| `:` puis nom | Aller à une ressource : `:pods`, `:deploy`, `:svc`, `:ing`, `:pvc`, `:events`, `:ns`, `:ctx`, `:crd`, `:helm` … (alias courts acceptés : `:po`, `:dp`, `:sts`) |
| `:` puis nom d'une CRD | Toute CRD fonctionne : `:certificates`, `:clusters.postgresql.cnpg.io`, `:externalsecrets` |
| `Entrée` | Descendre : Deployment → Pods → conteneurs ; Namespace → ses pods |
| `Échap` | Remonter d'un niveau, ou annuler un filtre |
| `/` | Filtrer (regex) la vue courante ; `/!motif` inverse le filtre ; `/-l app=api` filtre par label |
| `?` | Aide contextuelle, qui liste les raccourcis de la vue |
| `Ctrl-a` | Liste de tous les alias et ressources connues |
| `0` … `9` | Namespaces favoris ; `0` = tous les namespaces |
| `u` (vue `:ns`) | Utiliser ce namespace |
| `:ctx` puis `Entrée` | Changer de contexte ⚠️ relis l'en-tête |
| `[` / `]` | Historique des vues précédente et suivante |
| `:q` ou `Ctrl-c` | Quitter |

**Équivalents kubectl**

```bash
kubectl get pods -n platform -w
kubectl get pods -A
kubectl get pods -n platform -l app=api
kubectl get pods -n platform | grep -v Running          # ≈ /!Running
kubectl api-resources                                   # ≈ Ctrl-a
kubectl config use-context X ; kubens platform          # ≈ :ctx, u
```

---

## 19.4 Les actions sur une ressource

Sélectionne une ligne avec les flèches, puis :

| Touche | Action k9s | Équivalent kubectl |
|---|---|---|
| `d` | Describe (le plus utile : lire les Events en bas) | `kubectl describe pod X` |
| `y` | YAML complet (spec **et** status) | `kubectl get pod X -o yaml` |
| `e` | Edit dans `$EDITOR` ⚠️ correctif ponctuel | `kubectl edit pod X` |
| `l` | Logs du conteneur | `kubectl logs X -c C -f` |
| `p` | Logs **précédents** (conteneur mort) | `kubectl logs X -c C --previous` |
| `s` | Shell dans le conteneur | `kubectl exec -it X -c C -- sh` |
| `a` | Attach | `kubectl attach -it X` |
| `Shift-f` | Port-forward (demande les ports) | `kubectl port-forward pod/X 8080:8000` |
| `f` (vue `:pf`) | Liste des port-forwards actifs | processus en arrière-plan à suivre toi-même |
| `Ctrl-k` | Kill : suppression immédiate, sans grâce | `kubectl delete pod X --grace-period=0 --force` |
| `Ctrl-d` | Delete (propose la cascade) | `kubectl delete pod X` |
| `Espace` | Marquer plusieurs lignes, puis agir sur la sélection | `kubectl delete pod A B C` |
| `r` (deploy/sts) | Rollout restart | `kubectl rollout restart deploy/X` |
| `s` (deploy/sts) | Scale ⚠️ HPA (étape 2) | `kubectl scale deploy/X --replicas=N` |
| `x` (secret) | **Décoder le secret en clair** ⚠️ | `kubectl get secret X -o json \| jq '.data \| map_values(@base64d)'` |
| `o` (pod) | Afficher le nœud du pod | `kubectl get pod X -o wide` |
| `c` (vue YAML/describe) | Copier dans le presse-papier | `… \| pbcopy` |

Points de vigilance :

- **`s` sur un Deployment désigne le scale, pas le shell.** Le même raccourci n'a pas le même sens selon la vue. Lis toujours la barre du haut.
- **`Ctrl-k` n'est pas un redémarrage propre.** Le processus ne reçoit pas le temps d'arrêt gracieux, les connexions en cours sont coupées, et sur un pod de StatefulSet avec volume RWO, un force-delete peut laisser le volume attaché ailleurs. Pour redémarrer, utilise `r` sur le Deployment.
- **`e` produit une modification non versionnée.** Au prochain `helm upgrade`, le three-way merge l'écrasera ou entrera en conflit avec elle (étape 8). Si tu l'utilises, dis-le et reporte la modification dans les values.
- **`s` (shell) échoue sur une image distroless** (`exec: "sh": not found`). Cette erreur est normale : l'équivalent consiste à passer par un conteneur éphémère.
  ```bash
  kubectl debug -it pod/X --image=nicolaka/netshoot --target=api
  ```

---

## 19.5 La vue logs

`l` sur un pod ouvre les logs du conteneur principal. Sur un pod multi-conteneurs, fais `Entrée` pour lister les conteneurs, puis `l` sur le bon, **init containers compris**. C'est là que se trouvent les migrations bloquées de l'étape 21.

| Touche | Effet |
|---|---|
| `0` | Tail (dernières lignes) ; `1` à `5` = fenêtres de temps (1 min, 5 min, 15 min, 30 min, 1 h) |
| `s` | Activer ou suspendre l'autoscroll (le suspendre pour lire) |
| `w` | Retour à la ligne |
| `t` | Afficher les horodatages |
| `f` | Plein écran |
| `/` | Filtrer les lignes (`/error`, `/(?i)timeout`) |
| `Ctrl-s` | Sauvegarder dans un fichier (le chemin s'affiche) |
| `c` | Copier |
| `p` | Basculer vers les logs précédents |

**Logs agrégés** : `l` sur un **Deployment** mélange les logs de tous ses pods. C'est pratique pour voir si l'erreur se produit partout, mais cela **ne permet pas de savoir quelle instance** a produit quelle ligne. La méthode de l'étape 20 exige « les logs de la bonne instance » : une fois le motif repéré, redescends au pod.

**Équivalents**

```bash
kubectl logs deploy/api -n platform --all-containers --prefix -f --since=15m
kubectl logs -l app=api -n platform --prefix --timestamps --tail=200
kubectl logs X -c migrate -n platform            # init container
kubectl logs X --previous | tail -50             # la cause du crash est souvent en dernier
stern -n platform 'api-.*' --since 15m           # multi-pods avec couleur par pod, si installé
```

Piège : les logs précédents n'existent que pour **le dernier** redémarrage. Si le pod a été supprimé puis recréé (et pas seulement redémarré), ils ont disparu. Il faut alors passer par l'observabilité (étape 18).

---

## 19.6 Trier et repérer

Dans la vue pods :

| Touche | Tri |
|---|---|
| `Shift-c` | CPU |
| `Shift-m` | Mémoire |
| `Shift-a` | Âge |
| `Shift-s` | Statut |
| `Shift-r` | Ready |
| `Shift-t` | Redémarrages |
| `Shift-n` | Nom |
| `Shift-o` | Nœud |
| même touche une 2ᵉ fois | ordre inverse |
| `Ctrl-w` | Colonnes larges (IP, nœud, QoS…) |
| `Ctrl-z` | Afficher uniquement les pods en défaut |

Les colonnes à lire :

- **`%CPU/R`, `%MEM/R`** : consommation rapportée aux **requests**. Une valeur supérieure à 100 % signifie que le pod consomme plus que ce qui a été réservé pour lui, et que le scheduler s'est donc basé sur une fausse hypothèse.
- **`%CPU/L`, `%MEM/L`** : consommation rapportée aux **limits**. `%MEM/L` proche de 100 % annonce un `OOMKilled` ; `%CPU/L` proche de 100 % annonce du **throttling** (lenteur sans erreur).
- **`RESTARTS`** trié décroissant : les pods qui meurent en boucle remontent en haut.
- **`AGE`** trié croissant : ce qui vient de redémarrer ou d'être recréé. Un pod plus jeune que ses voisins est suspect.

⚠️ **Les colonnes CPU/MEM restent vides (`n/a`) sans metrics-server.** C'est le cas sur kind par défaut, et sur certains clusters on-prem. Ce n'est pas un bug de k9s. Vérifie :

```bash
kubectl top pods -n platform        # "Metrics API not available" → pas de metrics-server
kubectl get apiservice v1beta1.metrics.k8s.io
```

**Équivalents**

```bash
kubectl top pods -n platform --sort-by=memory
kubectl top pods -n platform --containers --sort-by=cpu
kubectl top nodes
kubectl get pods -n platform --sort-by=.metadata.creationTimestamp
kubectl get pods -A --sort-by='.status.containerStatuses[0].restartCount' | tail -15
kubectl get pods -A --field-selector=status.phase!=Running
```

---

## 19.7 L'arbre de propriété et les vues globales

**`:xray`** affiche l'arbre de propriété qu'on a appris à l'étape 2, en direct :

```
:xray deploy platform
Deployment api
 └─ ReplicaSet api-7d9f…
     ├─ Pod api-7d9f…-abcde
     │   ├─ Container api
     │   ├─ ConfigMap api-config
     │   ├─ Secret api-db
     │   └─ ServiceAccount api
     └─ Pod api-7d9f…-fghij
```

`:xray` accepte aussi `sts`, `ds`, `svc`, `job`, `pod`, `sa`… Les éléments en rouge ou orange signalent le maillon cassé : un Secret référencé mais absent apparaît directement sur l'arbre.

**Équivalents**

```bash
kubectl get pod X -o jsonpath='{.metadata.ownerReferences[*].kind}/{.metadata.ownerReferences[*].name}'
kubectl tree deploy api -n platform     # plugin krew "tree", si disponible
kubectl get rs -n platform -l app=api   # anciennes RS après un rollout
```

**`:pulses`** (ou `:pu`) est un tableau de bord global qui résume l'état des pods, déploiements, services, événements, CPU et mémoire du cluster. Il répond en un coup d'œil à la question « est-ce que le cluster va bien, globalement ? ». Il est utile en ouvrant une session, moins pour diagnostiquer.

**`:events`** avec `Shift-a` (âge) regroupe les derniers événements, qui constituent la chronologie de l'incident.

```bash
kubectl get events -n platform --sort-by=.lastTimestamp | tail -30
kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp
```

**`:helm`** liste les releases. `Entrée` affiche les values, `d` le manifeste.

```bash
helm list -A ; helm get values platform -n platform ; helm history platform -n platform
```

**`:nodes`** : trie par CPU et mémoire, puis `Entrée` sur un nœud pour voir ses pods, ce qui aide à repérer un nœud saturé ou un voisin bruyant.

```bash
kubectl describe node N | sed -n '/Allocated resources/,/Events/p'
kubectl get pods -A --field-selector spec.nodeName=N -o wide
```

---

## 19.8 Répondre à « pourquoi ça rame » en moins d'une minute

Une séquence à dérouler toujours dans le même ordre :

```
1. En-tête          → bon contexte ? CPU/MEM cluster saturé ?                      (5 s)
2. :pods, 0         → Ctrl-z : des pods en défaut ?                                (5 s)
3. Shift-t          → des redémarrages récents ? (OOM, liveness)                   (5 s)
4. Shift-a          → des pods très jeunes ? (recréés, évictions)                  (5 s)
5. Shift-c/Shift-m  → qui consomme ? %CPU/L ≈ 100 → throttling ; %MEM/L ≈ 100 → OOM (10 s)
6. :nodes           → un nœud saturé ? des pods qui s'y concentrent ?              (10 s)
7. :events, Shift-a → Warning récents : évictions, FailedScheduling, probes        (10 s)
8. d sur le suspect → Last State, Reason, Events                                   (10 s)
```

À la fin, tu dois pouvoir formuler **une** phrase qui s'appuie sur ce que tu as vu, pas sur ce que tu crois (étape 23) :

- « Le pod `api-…-x` redémarre toutes les 3 minutes, `Last State: OOMKilled`, sa limite est à 512 Mi. »
- « `inference` est à 98 % de sa limite CPU, donc throttlé. Rien ne plante, les requêtes s'accumulent. »
- « Tout est vert côté cluster. La lenteur n'est pas au niveau des pods, il faut descendre dans les traces (étape 18) ou remonter au plan d'entrée (étape 12). »

La troisième réponse est aussi une bonne réponse. Écarter l'hypothèse « c'est Kubernetes » en une minute est précieux.

**La même séquence en kubectl**, dans le cas où k9s n'est pas disponible :

```bash
kubectl config current-context
kubectl get pods -A | grep -vE 'Running|Completed'
kubectl get pods -A --sort-by='.status.containerStatuses[0].restartCount' | tail -10
kubectl get pods -A --sort-by=.metadata.creationTimestamp | tail -10
kubectl top pods -A --sort-by=cpu | head -10 ; kubectl top pods -A --sort-by=memory | head -10
kubectl top nodes
kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp | tail -20
kubectl describe pod <suspect> -n <ns> | grep -A5 'Last State'
```

⚠️ `kubectl top` et k9s donnent une consommation **instantanée**. Un pic de 2 secondes qui provoque un OOM peut ne jamais apparaître. Pour ce type d'incident, `Last State: OOMKilled` fait foi, pas le graphique.

---

## 19.9 Mises en garde de terrain

**Mauvais contexte.** Plusieurs terminaux ouverts sur plusieurs clusters, avec k9s dans l'un d'eux : c'est la situation classique de l'incident. Parades :

- une couleur ou un skin différent par contexte de production (k9s permet une skin par contexte) ;
- `--readonly` sur tout ce qui n'est pas ton cluster de travail ;
- des noms de contexte explicites (`client-x-PROD`) plutôt que le nom généré par `gcloud` (`gke_projet_zone_cluster`).

**Secrets en partage d'écran.** `x` sur un Secret, `y` sur un Secret (base64 visible, qui se décode en une seconde), `e` sur un Secret, ou la vue `d` d'un pod dont les variables d'environnement contiennent un mot de passe en clair. Avant tout partage d'écran avec un client ou en visio :

- `--readonly` ne masque **pas** les secrets : il empêche seulement de modifier ;
- évite la vue `:secrets` ; si nécessaire, montre les noms uniquement ;
- l'enregistrement de la visio et le transcript d'un agent IA conservent ce qui a été affiché.

**Port-forwards orphelins.** Un `Shift-f` reste actif tant que k9s tourne. En quittant k9s, il se ferme. Un `kubectl port-forward &` oublié dans un autre terminal, lui, ne se ferme pas. Vérifie avec `:pf` dans k9s, ou `lsof -i :8080` côté shell.

**Suppressions en masse.** `Espace` pour marquer, puis `Ctrl-d` : très efficace, et aussi très efficace pour supprimer 30 pods de production. La règle de l'étape 2 s'applique : agir sur le propriétaire (`r` sur le Deployment), pas sur ses enfants.

**Charge sur l'API.** Sur un cluster client déjà fragile, une vue `0` (tous les namespaces) sur `:events` ou `:pods` avec des milliers d'objets et un rafraîchissement de 2 secondes ajoute une charge réelle. Reste dans un namespace, ou relance avec `k9s --refresh 5`.

**Ce que k9s ne te dit pas.** Il montre l'état Kubernetes. Il ne montre ni le LB cloud, ni le DNS externe, ni la base managée hors cluster, ni la latence réseau entre deux zones. « Tout est vert dans k9s » ne veut pas dire « la plateforme fonctionne ».

---

## 19.10 Aide-mémoire compact

```
LIRE             d describe · y yaml · l logs · p logs précédents · :events · :xray deploy
TRIER            Shift-c CPU · Shift-m MEM · Shift-t restarts · Shift-a âge · Ctrl-z défauts
NAVIGUER         : ressource · / filtre · Entrée descendre · Échap remonter · 0 tous ns · ? aide
AGIR (⚠️)        r restart · s scale/shell · Shift-f port-forward · e edit · Ctrl-d delete · Ctrl-k kill
DANGER ÉCRAN     x décode un secret · y/e sur un secret
SÉCURITÉ         k9s --readonly --context X -n Y · lire l'en-tête d'abord
```

---

## 19.11 Exercice — à faire clavier en main

Sur le cluster kind `lab`, avec ton parapluie déployé dans le namespace `platform`.

**0. Préparation**

```bash
# metrics-server sur kind (TLS kubelet non signé → --kubelet-insecure-tls, LAB UNIQUEMENT)
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system \
  --set 'args={--kubelet-insecure-tls}'
kubectl top nodes      # attendre ~1 min que ça réponde
```

**1. Premier tour, en lecture seule** : `k9s --readonly -n platform`.

- Lis l'en-tête et note le contexte et la version.
- `:xray deploy`, puis identifie un Deployment, sa RS et ses pods.
- Tente `Ctrl-d` sur un pod et observe le refus.
- Quitte.

**2. Prépare trois problèmes cachés.** Demande à quelqu'un de le faire, ou fais-le toi-même puis attends 10 minutes et oublie lequel est où :

```bash
# a) un pod qui consomme du CPU jusqu'à sa limite (throttling)
kubectl -n platform run burner --image=busybox --restart=Always \
  --requests=cpu=50m --limits=cpu=100m -- sh -c 'while :; do :; done'

# b) un pod qui fait un OOM en boucle
kubectl -n platform run leaker --image=polinux/stress --restart=Always \
  --limits=memory=64Mi -- stress --vm 1 --vm-bytes 128M --vm-hang 1

# c) un Deployment qui ne démarre jamais
kubectl -n platform create deploy ghost --image=nginx:n-existe-pas
```

Sur les versions récentes de `kubectl`, `--requests` et `--limits` ont été retirés de `kubectl run`. Si c'est le cas, écris un petit manifeste avec un bloc `resources`. Noter l'écart fait partie de l'exercice (étape 0).

**3. Chronomètre, puis déroule la séquence 19.8 dans k9s (sans `--readonly`).** Objectif : moins d'une minute pour produire les trois phrases d'observation, du type « X fait Y, preuve Z ».

**4. Refais la même chose en kubectl pur**, avec k9s fermé. Chronomètre. Note où tu as perdu du temps : c'est ta liste de commandes à mémoriser.

**5. Actions**, toujours dans k9s :

- `ghost` : `d`, trouve la ligne d'Events qui explique le problème, puis `Ctrl-d` sur le **Deployment**, pas sur le pod.
- `leaker` : `p` pour les logs précédents, `d` pour `Last State`. Supprime-le.
- `burner` : `Shift-f` n'a pas de sens ici ; supprime-le.
- Sur un vrai composant du parapluie : `Shift-f` vers son port, puis `curl -i localhost:<port>/health` dans un autre terminal ; ferme via `:pf`.
- `r` sur un Deployment du parapluie : observe dans la vue pods le rolling update et l'ancienne RS dans `:xray`.

**6. Hygiène** : ouvre `:secrets` en `--readonly` et repère les touches qui exposeraient une valeur. N'appuie pas dessus. Configure une skin différente pour un contexte fictif `prod`.

---

## Validé si…

Tu peux, sans support :

- expliquer pourquoi `--readonly` ne protège pas un partage d'écran ;
- donner la commande kubectl équivalente de `l`, `p`, `s`, `Shift-f`, `r`, `x` et `:xray` ;
- dire ce que signifient `%CPU/L` à 100 % et `%MEM/R` à 250 %, et quelle colonne annonce un OOM ;
- expliquer pourquoi les colonnes CPU/MEM sont vides sur un cluster neuf ;
- dérouler la séquence « pourquoi ça rame » en moins d'une minute dans k9s, et en moins de trois minutes en kubectl pur ;
- dire pourquoi `Ctrl-k` n'est pas un redémarrage et ce qu'il faut utiliser à la place.

**Étape suivante** : `etape-20-methode-debug.md` — la méthode de debug en cinq temps.
