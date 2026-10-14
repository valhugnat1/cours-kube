# Étape 15 — Inférence, routage de modèles et GPU

**Objectif** : à la fin de cette étape, tu sais expliquer comment la plateforme choisit et appelle un modèle, ce qui change réellement entre un modèle appelé à distance et un modèle servi sur les GPU du client, comment Kubernetes expose et partage un GPU, et pourquoi un pod d'inférence met des minutes à démarrer. Tu sais surtout dire **honnêtement** ce qui tourne où.

**Notions couvertes** : §7 (routeur de modèles, API interne standardisée, inférence déportée vs locale, souveraineté des prompts, configuration déclarative des modèles, activation/désactivation, modèles spécialisés, API compatible OpenAI, GPU dans Kubernetes, chargement des poids, probes, `shm`, vLLM).

**Prérequis** : étape 3 (probes, requests/limits, scheduling, taints), étape 5 (PVC), étape 10 (GKE, air-gapped), étape 12 (egress), étape 14 (gouvernance).

---

## 15.1 Le routeur de modèles

Dans la carte de l'étape 11, le routeur est **le dernier composant applicatif avant l'inférence**. Son rôle :

```
UI, API publique, agents, RAG, workflows…
        │  une seule API interne : "modèle X, ces messages, ces paramètres"
        ▼
   ROUTEUR DE MODÈLES
        │  résout "X" → un backend concret, adapte le format, applique timeouts/retries
        ├──▶ moteur local A (vLLM sur GPU du cluster)
        ├──▶ moteur local B (embeddings, OCR…)
        └──▶ fournisseur déporté (API HTTPS via egress)
```

Pourquoi un routeur plutôt que chaque composant appelant directement un moteur :

- **Une API interne standardisée.** Tous les composants parlent le même format (en pratique très souvent le format « chat completions » compatible OpenAI). Changer de moteur, de version, ou passer de déporté à local ne touche **aucun** composant amont.
- **Un nom logique, pas une adresse.** Les composants demandent `chat-large`, pas `http://vllm-large-7d9f.platform.svc:8000`. Le routeur maintient la correspondance.
- **Un point unique** pour les timeouts, les retries, le repli (fallback) vers un autre backend, la répartition entre réplicas, la collecte des tokens consommés (étape 14), les traces (étape 18).
- **Une liste unique des modèles disponibles**, exposée à l'UI et à l'API (`GET /v1/models`).

Ce que le routeur **n'est pas** : il ne fait pas l'inférence, et il ne rend pas un modèle plus rapide. Un routeur saturé (CPU, connexions) ajoute de la latence à tout ; un routeur sain devant un moteur saturé répercute des timeouts ou des `429`/`503`.

### Le format compatible OpenAI

L'API `POST /v1/chat/completions` (plus `/v1/embeddings`, `/v1/models`, parfois `/v1/audio/…`) est devenue un standard de fait. Conséquences :

- les moteurs de serving (vLLM, TGI, llama.cpp server, Ollama…) l'exposent nativement ;
- les SDK et outils du client (LangChain, LangGraph, LlamaIndex, SDK OpenAI) fonctionnent en changeant `base_url` et la clé ;
- **« compatible » ne veut pas dire « identique »** : paramètres non supportés (ignorés silencieusement ou refusés), appels d'outils (*tool calls*) au format légèrement différent, streaming SSE avec des événements en plus ou en moins, `usage` absent en streaming sauf option. Face à un client qui dit « notre code marche avec OpenAI mais pas avec vous », chercher ces écarts d'abord.

Question client récurrente (étape 23) : « Votre API est-elle standard ? » → réponse honnête : compatible sur les endpoints X, Y, Z ; écarts connus sur tel paramètre ; voici un exemple avec le SDK officiel.

---

## 15.2 Inférence déportée vs locale

C'est **la** décision structurante d'une installation, et la source de la plupart des malentendus.

| | **Déportée** | **Locale** |
|---|---|---|
| Où tournent les poids | Chez un fournisseur (ou un autre datacenter) | Sur les GPU du cluster du client |
| Ce qui sort du cluster | **Les prompts, les documents injectés par le RAG, les réponses** | Rien pour l'inférence (sauf si d'autres composants sortent) |
| Prérequis cluster | Egress vers l'API, clé du fournisseur | GPU, drivers, device plugin, stockage des poids, beaucoup de mémoire |
| Coût | À l'usage (tokens) | Capex/location GPU, qu'on s'en serve ou non |
| Latence | Réseau + file d'attente du fournisseur | Dépend du dimensionnement local |
| Capacité | Limites du compte fournisseur (étape 14) | Nombre de GPU, fixe |
| Choix des modèles | Catalogue du fournisseur | Modèles dont on a les poids et la licence, qui tiennent en mémoire |
| Mises à jour du modèle | Faites par le fournisseur | Faites par toi (nouvelles images, nouveaux poids) |
| Air-gapped | **Impossible** | Obligatoire |
| Démarrage d'un environnement | Immédiat | Minutes (chargement des poids, 15.6) |

### Souveraineté des prompts

Pour beaucoup de clients (secteur public, défense, santé, banque, industrie), la question n'est pas technique mais juridique : **où vont les données saisies par les employés ?** En inférence déportée, le contenu des conversations et les extraits de documents du RAG transitent par le réseau et sont traités ailleurs, même si tout le reste de la plateforme (conversations stockées, bibliothèques, identité) est chez le client.

Conséquence : « la plateforme est installée chez vous » **ne signifie pas** « vos données ne sortent pas ». Il faut dire lesquelles sortent, vers où, et dans quelles conditions.

### Démo vs production

Configuration fréquente et légitime :

- **démo / preview / pilote** : plateforme complète dans le cluster, inférence **déportée** — pas de GPU à provisionner, environnement prêt en minutes ;
- **production** : inférence **locale** (ou déportée vers un endpoint qualifié par le client).

Le risque : que le client évalue la qualité, la latence et le coût sur la démo, et découvre en production un comportement différent (modèles disponibles, vitesse, taille de contexte, capacité simultanée).

### Honnêteté sur ce qui tourne localement

Règle non négociable, qui rejoint l'étape 23 (constat vs croyance) :

> **Tu dois pouvoir dire, modèle par modèle, s'il tourne dans le cluster ou ailleurs — et le prouver par une commande.**

Ne jamais laisser croire, par omission, qu'une démo est « 100 % on-prem » si le chat part vers une API externe. Et ne pas confondre non plus :

- l'**UI et la plateforme** hébergées localement,
- le **modèle de chat** local,
- les **modèles auxiliaires** (embeddings, OCR, transcription, modération) — qui peuvent être, eux, déportés alors que le chat est local, ou l'inverse.

Preuve rapide :

```bash
# la configuration du routeur : quel nom logique → quel backend
kubectl get cm -n platform -l app.kubernetes.io/component=model-router -o yaml | yq '.items[].data'
# y a-t-il des moteurs d'inférence qui tournent, et sur des GPU ?
kubectl get pods -n platform -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,GPU:.spec.containers[*].resources.limits.nvidia\\.com/gpu
# le routeur sort-il vers l'extérieur ? (proxy egress / NetworkPolicy / logs)
kubectl logs -n platform deploy/<model-router> --since=5m | grep -iE 'upstream|backend|https://'
```

Formulation type : « Sur cet environnement de démonstration, l'interface, les conversations et vos documents sont stockés dans ce cluster. Le modèle de chat est appelé à distance : le texte de vos questions et les extraits de documents sélectionnés sortent. En production, ce modèle tournera sur vos GPU ; voici ce que ça demande. »

---

## 15.3 Configuration déclarative des modèles

Les modèles sont décrits **dans la configuration versionnée** (values du chart), pas ajoutés à la main. Une entrée typique contient :

```yaml
models:
  - name: chat-large            # nom logique exposé par l'API
    type: chat                  # chat | embeddings | ocr | transcription | moderation | …
    enabled: true
    backend: local              # local | remote
    local:
      image: registry/vllm-openai@sha256:…
      weights: { source: pvc, claim: weights-chat-large, path: /models/chat-large }
      gpu: { count: 2, product: H100 }
      args: ["--tensor-parallel-size=2", "--max-model-len=32768", "--gpu-memory-utilization=0.90"]
      replicas: 1
    remote:
      baseUrl: https://api.fournisseur.example/v1
      upstreamModel: provider-large-latest
      apiKeySecret: { name: provider-key, key: api-key }
    limits: { contextWindow: 32768, maxOutputTokens: 4096 }
  - name: embed
    type: embeddings
    enabled: true
    backend: local
    …
```

(La structure exacte dépend de la plateforme ; les **idées** sont stables.)

À partir de cette déclaration, le chart produit :

- pour chaque modèle **local** activé : un Deployment/StatefulSet de moteur, son Service, ses PVC ou sa source de poids, ses requests GPU, tolerations, nodeSelector ;
- pour le **routeur** : la table nom logique → backend (ConfigMap, ou fichier monté) ;
- pour les **consommateurs** (UI, agents, RAG) : les noms des modèles à utiliser par défaut.

### La liste des modèles activés, via init container

Motif fréquent : un **init container** du routeur (ou d'un autre composant) lit la configuration déclarée, interroge éventuellement les backends, et **écrit la liste effective** des modèles disponibles dans un volume partagé avant le démarrage du conteneur principal. Conséquences à connaître :

- la liste est calculée **au démarrage du pod** : modifier la configuration sans redémarrer le routeur ne change rien (même famille de piège que le ConfigMap en variable d'environnement, étape 6) ;
- si l'init container **attend** qu'un backend réponde, le routeur reste en `Init:0/1` tant qu'un moteur local charge ses poids — **souvent normal** au premier démarrage (étape 21), mais cela peut bloquer toute la plateforme si un seul modèle optionnel ne démarre jamais ;
- les logs de l'init container (`kubectl logs <pod> -c <init>`) disent quels modèles ont été retenus ou écartés, et pourquoi.

### Le levier de désactivation

`enabled: false` (ou équivalent) sur un modèle doit :

1. le retirer de la liste exposée (`/v1/models`, sélecteur de l'UI) ;
2. supprimer ou ne pas créer ses workloads locaux (libérant les GPU) ;
3. le retirer de la table du routeur ;
4. ne pas casser les composants qui l'utilisaient **par défaut** — c'est le point qui échoue le plus souvent : l'agent ou le RAG configuré pour utiliser `embed`, qu'on vient de désactiver.

C'est **le** geste à faire quand un modèle pose problème en production (moteur qui crashe, GPU manquant, poids indisponibles) : désactiver dans la configuration versionnée et redéployer, plutôt que scaler le Deployment à 0 (recréé ou remis par le chart au prochain upgrade, étape 2).

Vérifier ce qui est réellement exposé, pas ce qui est déclaré :

```bash
curl -s -H @<(printf 'Authorization: Bearer %s\n' "$PLT_KEY") https://api.client.com/v1/models | jq -r '.data[].id'
```

---

## 15.4 Les modèles spécialisés

Une plateforme ne sert pas qu'un modèle de chat. Chaque famille a un profil de charge et des pièges différents :

| Famille | Utilisée par | Profil | À savoir |
|---|---|---|---|
| **Chat / génération** | UI, API, agents | GPU lourd, requêtes longues, streaming | Dimensionnement dominé par la mémoire du cache KV (15.7) |
| **Complétion de code** | IDE, assistants de code | Requêtes très fréquentes, très courtes, latence critique | Petit modèle rapide, souvent dédié |
| **Embeddings** | RAG (ingestion **et** requêtes), recherche | Débit élevé en rafales à l'ingestion | **Changer de modèle d'embeddings impose de réindexer toutes les bibliothèques** : les vecteurs ne sont pas comparables d'un modèle à l'autre |
| **Reranking** | RAG | Court, par lots | Souvent oublié dans le dimensionnement |
| **OCR / compréhension de documents** | Ingestion | Lourd, asynchrone, par page | Engorge l'ingestion sans toucher le chat |
| **Transcription (audio → texte)** | Audio, réunions | Durée proportionnelle à l'audio | Taille des fichiers → limites de body (étape 12) |
| **Modération / classification** | Garde-fous en amont/aval du chat | Petit, sur **chaque** requête | Ajoute de la latence à tout ; s'il tombe, fail-open ou fail-closed ? (même question qu'à l'étape 14) |
| **Annotation** | Évaluations, analyse des conversations | Batch, asynchrone | Consomme sans utilisateur visible, à imputer (étape 14) |

Deux conséquences d'architecture :

- **Déporté et local peuvent coexister** : chat local sur les GPU, OCR déporté (ou l'inverse). La phrase « l'inférence est locale » doit toujours préciser **quels modèles**.
- **Les dépendances cachées** : un chat « qui marche » avec une recherche documentaire qui renvoie des résultats absurdes = souvent le modèle d'embeddings qui a changé, ou qui n'est pas celui utilisé à l'indexation.

---

## 15.5 Les GPU dans Kubernetes

Par défaut, Kubernetes ne sait rien des GPU. Il faut empiler plusieurs couches, **toutes sous la frontière de responsabilité** (étape 11) sauf la dernière :

```
┌ Pod d'inférence : resources.limits: nvidia.com/gpu: 2          ← le chart
├ Device plugin : annonce "ce nœud a 8 nvidia.com/gpu"            ┐
├ Container toolkit : injecte le GPU et les bibliothèques          │ GPU Operator
│   dans le conteneur au démarrage                                 │ (ou équivalent
├ Driver NVIDIA sur le nœud (module noyau)                         │  fourni par le
└ GPU physique                                                     ┘  cloud / l'OS)
```

### GPU Operator

Le **NVIDIA GPU Operator** installe et gère ces couches sous forme de DaemonSets : driver (conteneurisé ou préinstallé), container toolkit, device plugin, **GPU Feature Discovery** (labels de nœuds), **DCGM exporter** (métriques GPU pour Prometheus), MIG manager, validateurs.

Selon l'environnement (étape 10) :

- **GKE** : drivers installés par Google sur les node pools GPU (selon l'option choisie), device plugin géré ; les nœuds GPU portent automatiquement un **taint** `nvidia.com/gpu=present:NoSchedule`. Le GPU Operator est facultatif, voire à éviter en doublon.
- **OpenShift** : GPU Operator via OLM, avec le Node Feature Discovery Operator.
- **On-prem** : GPU Operator via Helm, prérequis cluster-wide installé par le client ou avec son accord.

Commande de base pour savoir si un cluster est prêt :

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,GPU:.status.allocatable.nvidia\\.com/gpu,PRODUCT:.metadata.labels.nvidia\\.com/gpu\\.product,TAINTS:.spec.taints[*].key
kubectl get pods -n gpu-operator      # (ou le namespace utilisé) tout doit être Running/Completed
kubectl describe node <noeud-gpu> | grep -A5 -E 'Capacity|Allocatable'
```

Si `allocatable` n'affiche pas `nvidia.com/gpu`, **aucun** pod GPU ne sera jamais planifié, et il affichera `Pending` avec `Insufficient nvidia.com/gpu` — le chart n'y peut rien.

### Demander un GPU

```yaml
resources:
  limits:
    nvidia.com/gpu: 2        # requests = limits pour les ressources étendues ; entier uniquement
tolerations:
  - key: nvidia.com/gpu
    operator: Exists
    effect: NoSchedule
nodeSelector:
  nvidia.com/gpu.product: NVIDIA-H100-80GB     # valeur exacte : lire le label sur le nœud
```

Règles :

- **Un GPU n'est pas fractionnable** par cette ressource : `nvidia.com/gpu: 0.5` est invalide. Le partage passe par MIG ou time-slicing.
- **Le label `gpu.product` n'a pas le même format partout** (GPU Feature Discovery, labels GKE `cloud.google.com/gke-accelerator`, labels posés à la main par le client). Le `nodeSelector` d'un client ne se recopie pas chez un autre : c'est une valeur de la brique « GPU » de l'étape 8.
- **Taint oublié côté pod** → `Pending` avec `untolerated taint`. **Taint absent côté nœud** → des pods sans GPU (API, bases) se placent sur les nœuds GPU coûteux et prennent leur CPU et leur mémoire.

### Partager un GPU : MIG et time-slicing

| | **MIG** (Multi-Instance GPU) | **Time-slicing** |
|---|---|---|
| Principe | Découpe matérielle du GPU en instances isolées (mémoire, calcul) | Plusieurs conteneurs se partagent le même GPU à tour de rôle |
| GPU compatibles | Gammes datacenter récentes (A100, H100…) | Tous |
| Isolation mémoire | **Oui** | **Non** : un processus peut consommer la mémoire des autres, un OOM GPU peut toucher les voisins |
| Ressource annoncée | `nvidia.com/mig-1g.10gb`, etc. (stratégie *mixed*) ou `nvidia.com/gpu` (*single*) | `nvidia.com/gpu` multiplié (un GPU annoncé comme 4) |
| Usage adapté | Petits modèles en production (embeddings, modération, reranking) | Dev, démos, charges légères non critiques |
| Piège | Reconfigurer MIG demande de vider le nœud ; profils imposés | Kubernetes croit avoir 4 GPU ; les performances et la mémoire ne suivent pas |

Un grand modèle de chat n'utilise **ni l'un ni l'autre** : il prend un ou plusieurs GPU entiers.

### Versions : driver, CUDA, image

Chaîne de compatibilité à respecter :

```
image du moteur (compilée pour CUDA N)  ≤  version CUDA supportée par le driver du nœud
```

Une image récente de vLLM sur un nœud au driver ancien → erreurs au démarrage du type `CUDA driver version is insufficient` ou `no CUDA-capable device is detected` (ce second message a aussi d'autres causes : toolkit non injecté, runtime non configuré). Toujours relever **en une passe** (idée 10 de la partie B) : modèle de GPU, version du driver (`nvidia-smi` sur le nœud ou dans un pod de test), version CUDA de l'image, version du moteur.

```bash
kubectl run -it --rm gpu-test -n platform --image=nvidia/cuda:<tag-compatible>-base-ubuntu22.04 \
  --overrides='{"spec":{"tolerations":[{"key":"nvidia.com/gpu","operator":"Exists"}],"containers":[{"name":"gpu-test","image":"nvidia/cuda:<tag-compatible>-base-ubuntu22.04","command":["nvidia-smi"],"resources":{"limits":{"nvidia.com/gpu":"1"}}}]}}'
```

En air-gapped, cette image de test doit être dans le miroir, comme toutes les autres.

---

## 15.6 Charger les poids

Un modèle, ce sont des fichiers de poids de plusieurs Go à plusieurs centaines de Go. **Les mettre dans l'image de conteneur est presque toujours une mauvaise idée** (images énormes, pull de plusieurs dizaines de minutes sur chaque nœud, registre saturé, couche invalidée à chaque changement de moteur). Trois approches :

| Approche | Principe | Pour | Contre |
|---|---|---|---|
| **PVC** | Poids déposés une fois sur un volume, monté en lecture par les pods | Démarrage rapide après le premier dépôt ; adapté à l'air-gapped | RWO : un seul nœud à la fois (étape 5), donc RWX/lecture multiple ou un PVC par réplica ; stockage lent = démarrage lent |
| **Init container** | Télécharge les poids (depuis un stockage objet, un registre de modèles, un hub interne) vers un volume (`emptyDir` ou PVC) avant le moteur | Simple, versionné, découplé | Télécharge à **chaque** démarrage sur `emptyDir` ; `emptyDir` sur disque du nœud → éviction si le disque est plein |
| **Stockage objet en direct / cache nœud** | Le moteur lit en streaming depuis S3-compatible, ou un cache local au nœud (hostPath, DaemonSet de pré-chargement) | Pas de volume à gérer par pod | Plus complexe ; dépend du débit réseau ; droits d'accès objet par pod |

Points communs à surveiller :

- **Débit du stockage** : 140 Go à 100 Mo/s = plus de 20 minutes avant même de charger en mémoire GPU.
- **Intégrité** : un téléchargement interrompu laisse des fichiers partiels ; le moteur échoue avec une erreur de format sans rapport apparent. Vérifier des sommes de contrôle.
- **Licence et provenance** : quels poids, quelle version exacte, sous quelle licence, qui les a déposés. En air-gapped, ils arrivent par un canal de transfert contrôlé.
- **Droits d'accès** : secret du hub ou du stockage objet (jamais dans les values en clair, étape 6).
- **Identifier les poids par une version immuable** (hash, révision), comme une image par digest : « `latest` » sur des poids est aussi dangereux que sur une image.

### Les startup probes longues

Le démarrage d'un moteur d'inférence se décompose en : pull de l'image (images CUDA de plusieurs Go) → obtention des poids → chargement en mémoire GPU → compilation/optimisation (graphes CUDA, profilage de la mémoire) → prêt. **Plusieurs minutes, parfois plus de dix.**

Avec une liveness probe classique (vérification toutes les 10 s, échec au bout de 3), le kubelet tue le conteneur **pendant qu'il charge**, il redémarre, recharge, se refait tuer : `CrashLoopBackOff` sans aucune erreur dans les logs de l'application. Piège déjà cité à l'étape 3, qui prend ici toute son ampleur.

```yaml
startupProbe:
  httpGet: { path: /health, port: 8000 }
  periodSeconds: 10
  failureThreshold: 90          # jusqu'à 15 minutes pour démarrer
livenessProbe:
  httpGet: { path: /health, port: 8000 }
  periodSeconds: 15
  failureThreshold: 4
readinessProbe:
  httpGet: { path: /health, port: 8000 }   # ou un endpoint qui vérifie que le modèle répond
  periodSeconds: 5
```

La startup probe **suspend** liveness et readiness jusqu'à son premier succès. Dimensionne `failureThreshold × periodSeconds` sur le **pire cas mesuré** (premier démarrage, cache froid, stockage lent), pas sur ta démo.

Et côté Helm (partie B) : un `helm upgrade --atomic --timeout 5m` qui redémarre un moteur de 12 minutes **échoue et fait un rollback**, qui redémarre à nouveau le moteur. Adapter `--timeout`.

### `/dev/shm`

Par défaut, un conteneur dispose d'un `/dev/shm` (mémoire partagée) de **64 Mo**. Les moteurs qui répartissent un modèle sur plusieurs GPU (parallélisme de tenseurs) ou utilisent plusieurs processus s'en servent pour communiquer. Symptôme d'un `shm` trop petit : crash au démarrage ou pendant les premières requêtes avec des erreurs de bus, de NCCL, ou `No space left on device` — alors que le disque est vide.

```yaml
volumes:
  - name: dshm
    emptyDir: { medium: Memory, sizeLimit: 16Gi }
containers:
  - volumeMounts:
      - { name: dshm, mountPath: /dev/shm }
```

`medium: Memory` compte dans la **mémoire du pod** : l'inclure dans les `limits.memory`, sinon `OOMKilled` (étape 0).

---

## 15.7 vLLM et le dimensionnement

**vLLM** est un moteur de serving open source très répandu, exposant une API compatible OpenAI. Sans chercher à tout couvrir, les notions à connaître pour lire une configuration et répondre au client.

### Où va la mémoire GPU

```
mémoire GPU = poids du modèle + cache KV + marge (activations, graphes CUDA, fragmentation)
```

- **Poids** : ≈ nombre de paramètres × octets par paramètre. En 16 bits (fp16/bf16), 2 octets : un modèle de 7 milliards de paramètres ≈ 14 Go ; 70 milliards ≈ 140 Go (donc plusieurs GPU de 80 Go). En 8 bits, 1 octet ; en 4 bits, environ un demi. **La quantification réduit la mémoire au prix d'un peu de qualité**, variable selon le modèle et la méthode.
- **Cache KV** : pour chaque token de chaque requête en cours, le moteur conserve des tenseurs intermédiaires. Il **croît avec la longueur du contexte et le nombre de requêtes simultanées**. C'est lui qui détermine combien d'utilisateurs peuvent être servis à la fois.

Les paramètres qui pilotent cet équilibre :

| Paramètre vLLM | Effet |
|---|---|
| `--tensor-parallel-size N` | Répartit le modèle sur N GPU **du même nœud** (liens rapides) ; nécessaire quand les poids ne tiennent pas sur un seul GPU |
| `--gpu-memory-utilization` | Fraction de la mémoire GPU que vLLM s'autorise (le reste = marge). Trop haut → OOM GPU ; partage de GPU → à baisser |
| `--max-model-len` | Longueur maximale de contexte. **Plus elle est grande, moins de requêtes simultanées tiennent dans le cache KV** ; si elle excède ce que la mémoire permet, le moteur refuse de démarrer avec un message explicite |
| `--max-num-seqs` | Nombre maximal de séquences traitées en même temps |
| `--quantization` / poids quantifiés | Réduit la mémoire des poids |

vLLM regroupe dynamiquement les requêtes en cours (*continuous batching*) : le débit total augmente avec la charge, mais la latence par requête aussi. Deux métriques distinctes à ne jamais mélanger :

- **TTFT** (*time to first token*) : ressenti « ça commence à répondre » — dominé par la file d'attente et le traitement du prompt ;
- **débit de sortie** (tokens/s par requête) : ressenti « vitesse d'écriture ».

### Répondre à « combien de GPU faut-il ? »

Honnêtement : **ça dépend, et voici de quoi.** Les entrées indispensables :

1. quels modèles, en quelle précision ;
2. longueur de contexte réellement nécessaire (RAG avec beaucoup d'extraits = long) ;
3. nombre d'utilisateurs **simultanés** à l'heure de pointe (pas d'inscrits) et longueur typique des requêtes et réponses ;
4. objectifs de latence (TTFT, tokens/s) ;
5. modèles auxiliaires (embeddings, OCR, modération) et volume d'ingestion ;
6. besoin de redondance (un réplica par modèle = pas de haute disponibilité, étape 17).

Puis : une estimation mémoire pour savoir **combien de GPU par réplica**, et un **test de charge** sur le matériel cible pour savoir **combien de réplicas**. Jamais un chiffre de débit annoncé sans mesure sur ce GPU, ce modèle, ce contexte (étape 23 : pas de bluff sur un chiffre).

### Répartition et mise à l'échelle

- **Plusieurs réplicas** d'un même modèle derrière un Service : la répartition par défaut (kube-proxy, connexions) est aveugle à la charge réelle ; les connexions HTTP persistantes du routeur peuvent coller à un réplica (piège keep-alive, étape 4). Un routeur ou une couche de répartition consciente de la charge (longueur de file, cache KV) fait mieux.
- **HPA sur le CPU : inutile** pour un moteur GPU. Mettre à l'échelle, si on le fait, sur des métriques du moteur (requêtes en attente, utilisation du cache KV) exposées à Prometheus ; et se rappeler qu'un nouveau réplica met des minutes à être prêt, et qu'il faut des GPU libres pour l'accueillir.
- **Rolling update** : un Deployment en `RollingUpdate` avec `maxSurge: 1` a besoin d'**un jeu de GPU libre en plus** pendant la mise à jour. Sans GPU libre, le nouveau pod reste `Pending` et la mise à jour ne progresse jamais. Selon la capacité : `maxSurge: 0, maxUnavailable: 1` (coupure de capacité assumée) ou `Recreate` (coupure totale courte) — à annoncer.
- **PDB** : un PDB qui interdit toute indisponibilité d'un modèle à un seul réplica bloque le drain du nœud GPU (étape 3).

---

## 15.8 Ce qui change quand on bascule un modèle de déporté à local

C'est l'objet de l'exercice. La liste de référence, à confronter à ta propre plateforme :

| Domaine | Déporté | Local |
|---|---|---|
| Values | `backend: remote`, URL, nom amont, secret de clé | `backend: local`, image, poids, GPU, args, réplicas |
| Workloads | Aucun moteur | Deployment/StatefulSet de moteur, Service, PVC ou init container de poids |
| Nœuds | Aucun prérequis | Nœuds GPU, drivers, device plugin, taints/labels |
| Scheduling | — | Tolerations, nodeSelector/affinity, stratégie de rolling update compatible avec les GPU libres |
| Stockage | — | Volume de poids, `shm` en mémoire, stockage rapide |
| Images | Aucune image de moteur | Image CUDA de plusieurs Go à mettre en miroir (air-gapped) ; compatibilité driver |
| Démarrage | Immédiat | Minutes : startup probe, `--timeout` Helm, init container de la liste des modèles |
| Egress | Vers le fournisseur : **à garder ouvert** | Plus nécessaire pour ce modèle : **à fermer** si plus rien ne l'utilise |
| Secrets | Clé du fournisseur | Plus nécessaire (à révoquer) ; éventuellement accès au dépôt de poids |
| Souveraineté | Prompts et extraits sortent | Restent dans le cluster (pour ce modèle) |
| Capacité | Limites du compte fournisseur | Nombre de GPU × dimensionnement |
| Gouvernance | Protège la facture | Protège la capacité GPU — les limites deviennent critiques (étape 14) |
| Metering | Tokens facturés par le fournisseur | Tokens comptés par le moteur (tokenizer différent → chiffres différents) |
| Comportement | Modèle du fournisseur, sa version | Modèle déployé, **potentiellement différent** (version, quantification, contexte) → réponses différentes |
| Observabilité | Latence réseau, erreurs amont | Métriques GPU (DCGM), métriques du moteur (file, cache KV, TTFT) |
| Pannes typiques | Timeout / 429 / 5xx du fournisseur, proxy | `Pending` GPU, OOM GPU, `CrashLoopBackOff` pendant le chargement, `shm`, CUDA |
| Mises à jour | Le fournisseur | Toi : nouvelle image + nouveaux poids + test |
| Coût | Au token | GPU réservés, utilisés ou non |

---

## 15.9 Pièges

- **« C'est on-prem »** alors que le chat (ou l'OCR, ou les embeddings) part vers une API externe.
- **Évaluer la qualité ou la latence sur une démo déportée** et promettre la même chose en local.
- **« Compatible OpenAI »** pris pour « identique » : paramètres ignorés, tool calls, `usage` en streaming.
- **Modifier la liste des modèles** sans redémarrer ce qui la calcule au démarrage.
- **Init container qui attend un modèle optionnel** qui ne démarrera jamais → plateforme bloquée en `Init`.
- **Désactiver un modèle** encore utilisé par défaut par l'agent ou le RAG.
- **Scaler un moteur à 0** au lieu de le désactiver dans la configuration.
- **Changer de modèle d'embeddings** sans réindexer.
- **Pas de `nvidia.com/gpu` dans `allocatable`** → `Pending` éternel, attribué au chart.
- **Tolerations oubliées** ; **taint absent** sur les nœuds GPU.
- **`nodeSelector` GPU recopié** d'un autre client (format de label différent).
- **Time-slicing en production** : aucune isolation mémoire.
- **Image CUDA plus récente que le driver** du nœud.
- **Poids dans l'image** ; **poids en `latest`** ; téléchargement partiel non vérifié.
- **`emptyDir` de poids** sur un disque de nœud trop petit → éviction.
- **Liveness sans startup probe** → `CrashLoopBackOff` silencieux pendant le chargement.
- **`--timeout` Helm trop court** avec `--atomic` → rollback en boucle.
- **`/dev/shm` de 64 Mo** avec le parallélisme de tenseurs ; `shm` en mémoire non compté dans les limits.
- **`--max-model-len` au maximum** « pour être tranquille » → quelques utilisateurs simultanés seulement.
- **HPA sur le CPU** d'un moteur GPU.
- **RollingUpdate avec `maxSurge`** sans GPU libre → mise à jour bloquée.
- **Un chiffre de débit annoncé** sans test de charge sur le matériel cible.
- **Oublier de fermer l'egress** et de révoquer la clé du fournisseur après passage en local.

---

## 15.10 Exercice — basculer un modèle de déporté à local et lister ce qui change

Kind n'a pas de GPU : la partie 1 simule l'architecture sur CPU avec un tout petit modèle, la partie 3 fait la lecture sur un vrai environnement GPU.

### Partie 1 — Monter le routage sur kind

1. **Backend « déporté »** : une API compatible OpenAI **hors du cluster** — soit un fournisseur réel avec une clé de test à faible plafond (dans un Secret, jamais en clair), soit un serveur léger lancé sur ton poste (llama.cpp server ou Ollama avec un modèle de très petite taille) joignable depuis kind.
2. **Routeur** : déploie un proxy de routage compatible OpenAI (par exemple LiteLLM), ou écris un petit routeur FastAPI qui mappe un nom logique `chat` vers un `base_url` + un nom de modèle amont, relaie `chat/completions` (streaming compris) et `models`.
3. Branche ta gouvernance de l'étape 14 **devant** le routeur.
4. Appelle `chat` via l'API, en streaming. Note : latence avant le premier token, présence de `usage`, trafic sortant visible dans les logs.

### Partie 2 — Basculer en local

1. Déploie le **même type de modèle** dans le cluster : serveur compatible OpenAI sur CPU (llama.cpp server ou Ollama), avec un tout petit modèle.
   - Poids : **pas dans l'image**. Mets-les sur un PVC, déposés par un Job ou un init container qui télécharge **et vérifie une somme de contrôle**.
   - Startup probe **volontairement trop courte** d'abord : observe le `CrashLoopBackOff` pendant le chargement, puis corrige.
   - `resources` réalistes ; ajoute un volume `/dev/shm` en mémoire pour prendre le réflexe, et compte-le dans les limits.
2. Simule un nœud « GPU » : ajoute à un nœud kind (cluster multi-nœuds) un label `accelerator=fake` et un taint `accelerator=fake:NoSchedule`. Place le moteur dessus avec toleration + nodeSelector. Retire la toleration : observe le `Pending` et le message exact.
3. Change **uniquement la configuration du routeur** (`chat` → Service local). Redéploie. L'application appelante n'a pas changé : vérifie-le.
4. Ajoute une entrée `enabled: false` sur un deuxième modèle (`embed`) utilisé par défaut par un composant factice : observe ce qui casse, corrige la dépendance.
5. Fais un `helm upgrade --atomic --timeout 1m` qui redémarre le moteur local : observe le rollback. Ajuste.
6. Mets à jour l'image du moteur en `RollingUpdate` avec `maxSurge: 1` en ayant réservé toutes les ressources du nœud « GPU » (requests élevées) : observe le blocage, puis passe en `maxSurge: 0`.
7. Ferme l'egress vers le backend déporté (NetworkPolicy avec un CNI qui l'applique), révoque la clé de test. Vérifie que tout marche encore **et que plus rien ne sort**.

### Partie 3 — La liste des changements

Remplis, **à partir de ce que tu as réellement modifié et observé**, le tableau de 15.8 pour ton exercice : values, objets Kubernetes créés/supprimés (`helm diff` avant/après), secrets, egress, temps de démarrage mesuré, réponses différentes pour un même prompt, `usage` comparé, pannes rencontrées. Ajoute une colonne « preuve » (commande ou observation) à chaque ligne.

### Partie 4 — Sur l'environnement de preview ou un cluster GPU (lecture seule)

1. Pour **chaque** modèle exposé par `/v1/models` : type, local ou déporté, backend concret, preuve par commande.
2. Pour les modèles locaux : nœuds, modèle de GPU, nombre, MIG/time-slicing, version du driver, image et version CUDA, paramètres du moteur (parallélisme, contexte, utilisation mémoire), source des poids, startup probe, `shm`, stratégie de mise à jour, nombre de réplicas.
3. Pour les modèles déportés : fournisseur, chemin egress, secret, ce qui sort.
4. Où est calculée la liste des modèles activés, et comment désactive-t-on un modèle proprement ?
5. Mesure le temps de démarrage d'un moteur local (événements du pod : planification → pull → démarrage → Ready), si tu as le droit de le redémarrer sur cet environnement.
6. Rédige la phrase « ce qui tourne où » de 15.2 pour cet environnement.

**Livrable** : section « Inférence et modèles » de `carte-plateforme-<version>.md` : tableau des modèles (type, local/déporté, backend, GPU, source des poids), routeur et sa configuration, prérequis GPU vérifiés, temps de démarrage mesuré, levier de désactivation, et le tableau déporté → local rempli avec preuves.

---

## Validé si…

Tu peux expliquer à voix haute :

- le rôle du routeur de modèles, et ce que l'API interne standardisée permet de changer sans toucher au reste ;
- ce que « compatible OpenAI » garantit et ne garantit pas ;
- les différences entre inférence déportée et locale, et ce qui sort du cluster dans le premier cas ;
- pourquoi une démo déportée peut induire le client en erreur, et comment le dire honnêtement ;
- comment les modèles sont déclarés, comment la liste effective est calculée, et comment désactiver un modèle proprement ;
- pourquoi changer de modèle d'embeddings impose une réindexation ;
- les couches nécessaires pour qu'un pod obtienne un GPU, et la commande qui prouve qu'un nœud en offre ;
- la différence entre MIG et time-slicing, et quand utiliser chacun ;
- la chaîne de compatibilité driver / CUDA / image ;
- trois façons de charger des poids et leurs inconvénients ;
- pourquoi un moteur a besoin d'une startup probe longue et d'un `/dev/shm` agrandi ;
- où va la mémoire GPU, et pourquoi `--max-model-len` limite le nombre d'utilisateurs simultanés ;
- les six informations nécessaires pour répondre à « combien de GPU ? », et pourquoi on termine par un test de charge ;
- pourquoi un RollingUpdate peut bloquer sur un moteur GPU ;
- au moins dix lignes du tableau « déporté → local ».

**Étape suivante** : `etape-16-fonctionnalites-produit.md` — fonctionnalités produit autour du modèle.
