# Cours Kubernetes / Helm pour le déploiement d'une plateforme LLM — Plan

**Contexte** : déployer une plateforme LLM via des Helm charts parapluie (des dizaines de pods) sur des environnements clients hétérogènes (on-prem, GCP, private cloud, air-gapped).

**Point de départ** : notions de Docker et principes généraux de Kubernetes.

**Méthode** : un guide pas à pas, une étape = un fichier. Chaque étape a un objectif et un exercice clavier en main. On ne passe à l'étape suivante qu'une fois l'exercice fait.

**Ordre de priorité pour les premières semaines** : A (0-3, 6) → B (7-9) → C (11, 12, 17) → D (19, 20) → E (23), le reste en fil rouge.

Les repères §n renvoient aux 20 sections du document de notions de référence.

---

## Partie A — Socle Kubernetes

### Étape 0 · Environnement de travail et prérequis (§17)
- Docker : images, layers, registries, multi-stage ; ce qu'est vraiment un conteneur (cgroups/namespaces)
- Réseau de base : IP, DNS, ports, TLS ; YAML propre
- Installer kubectl, helm, k9s, CLI cloud, gestionnaire Python ; vérifier le PATH avant de toucher au shell ; outils sensibles au répertoire courant / variables d'env parasites (`AGENT=1`) / `$HOME` non inscriptible ; documentation interne périmée → noter les écarts
- *Exercice : cluster kind local + toolchain installée et vérifiée*

### Étape 1 · Architecture et modèle déclaratif
- Control plane (API server, etcd, scheduler, controller manager) vs nœuds (kubelet, kube-proxy, runtime)
- État désiré, boucles de réconciliation, controllers
- Objets de base : Pod, ReplicaSet, Deployment, Service, Namespace, ConfigMap, Secret, labels/selectors
- `kubectl` : get / describe / logs / exec / apply / diff / explain, contexts, `-o yaml`
- *Exercice : déployer une app, la casser, la regarder se réparer*

### Étape 2 · Contrôleurs, ownership et actions destructives (§14)
- `ownerReference` + `controller: true` → agir sur le propriétaire, pas l'objet
- Un contrôleur recrée ce qu'on supprime ; HPA `minReplicas: 1` qui annule un `scale --replicas=0`
- Suppression en cascade ; correction ponctuelle vs durable (config versionnée) ; marquer le non-vérifié
- *Exercice : supprimer un pod d'un Deployment, scaler à 0 avec un HPA actif, observer*

### Étape 3 · Workloads avancés
- StatefulSet / DaemonSet / Job / CronJob
- Cycle de vie du Pod : init containers, probes (liveness/readiness/startup), hooks, restartPolicy
- Requests/limits, QoS, OOMKilled, éviction ; scheduling (nodeSelector, affinity, taints, topology spread, priorité)
- PDB, HPA/VPA, stratégies de rolling update
- *Exercice : une app avec init container bloquant + probes, provoquer un CrashLoopBackOff et un Pending*

### Étape 4 · Réseau Kubernetes
- CNI (Calico, Cilium) ; Services ClusterIP/NodePort/LoadBalancer/headless ; CoreDNS
- Ingress, ingress controllers, Gateway API ; NetworkPolicy ; service mesh en survol
- *Exercice : exposer une app via Ingress, la joindre par DNS interne depuis un autre pod*

### Étape 5 · Stockage
- PV/PVC/StorageClass, modes d'accès, provisioning dynamique, CSI
- Ce qui change par environnement (GCE PD vs NFS/Ceph/Longhorn)
- *Exercice : StatefulSet avec PVC, supprimer le pod, vérifier la persistance*

### Étape 6 · Configuration, secrets et accès (§16)
- ConfigMap/Secret en env vs fichier ; External Secrets, Sealed Secrets, Vault
- RBAC (Role/ClusterRole/Binding, ServiceAccount), Pod Security, securityContext, admission (Kyverno/OPA), image pull secrets
- Hygiène : jamais de secret dans le terminal (scrollback, historique, transcript d'agent), `--password-stdin`, presse-papier, tester ses accès avant de demander des droits, session utilisateur vs application default credentials, reconnaître un warning inoffensif
- *Exercice : ServiceAccount minimal + RBAC, récupérer un secret sans l'afficher*

---

## Partie B — Helm et packaging

### Étape 7 · Helm fondamentaux
- Anatomie d'un chart, Go templates + Sprig, `include`/`tpl`/named templates, `_helpers.tpl`
- install / upgrade / rollback / uninstall, releases, hooks, `helm test`, `values.schema.json`, semver, OCI
- *Exercice : écrire un chart from scratch pour l'app de l'étape 3*

### Étape 8 · Chart parapluie et gestion des values (§2)
- Dépendances, conditions/tags, `global.*`, alias, library charts
- Empilement de fichiers `-f`, ordre de précédence ; convention socle versionné / briques réutilisables / fichiers expérimentaux
- `--set` sur une liste remplace, ne fusionne pas → fichier
- `helm template` / `--dry-run --debug` / `helm diff` et leurs limites (sous-charts sans valeurs globales) ; effet de bord des flags raccourcis (`--skip-deps`)
- Sonder les versions d'un registre OCI sans listing de tags
- *Exercice : parapluie de 3 sous-charts, 2 environnements avec values empilées, diff entre les deux*

### Étape 9 · CRDs, opérateurs et couplage de versions (§2, §3)
- Pattern operator ; opérateurs devant préexister vs embarqués (secrets externes, certificats, bases, analytique, workflows)
- `crds/` non réappliqué à l'upgrade → extraction + `kubectl apply --server-side` ; conflits de field ownership
- Outil de génération à HEAD vs chart épinglé : une cause racine, plusieurs symptômes sans rapport ; méthode de remontée ; correctif par version et briques à supprimer en montant
- *Exercice : installer cert-manager, upgrader un chart avec CRD modifiée, résoudre le conflit*

### Étape 10 · Multi-environnement clients
- GKE (node pools, Workload Identity, LB GCP, Autopilot vs Standard) ; on-prem / private cloud (kubeadm, RKE2, OpenShift avec SCC/Routes, Tanzu, Nutanix) ; k3s
- Air-gapped : miroir pull-through de charts et d'images vers un registre interne, `imagePullSecrets`, packaging offline
- Compatibilité : versions K8s, dépréciations d'API, CRDs requis, ingress/StorageClass par défaut
- Frontière de responsabilité (§1) : le chart déploie des workloads, il ne fabrique pas cluster/nœuds/réseau/LB/StorageClass/GPU
- *Exercice : rendre ton parapluie sur kind et sur une simulation OpenShift-like (SCC restrictif)*

---

## Partie C — La plateforme LLM, plan par plan

### Étape 11 · Architecture d'une plateforme LLM (§1)
- Modèle vs plateforme ; les quatre plans (edge, identité, applicatif, données) et la règle « descendre d'un plan »
- Familles de composants ; cartographie
- *Exercice : cartographier la plateforme de mémoire, puis comparer avec k9s*

### Étape 12 · Plan d'entrée (§4)
- DNS → LB → gateway/Ingress → TLS → routage host+path
- DNS automatique et enregistrements orphelins ; certificats ACME/EAB ; restriction par IP source
- Accès au control plane via overlay/VPN ; proxy egress obligatoire (liste blanche de ports, blocage des plages privées → anti-SSRF, metadata services)
- Domaine parent distinct pour le contenu généré (same-origin, cookies) ; durcissement gateway (pas d'exposition des métriques)
- *Exercice : suivre sa propre requête du DNS jusqu'au pod*

### Étape 13 · Identité, authentification, autorisation (§5)
- Chemin humain (OIDC, authorization code + PKCE, session) vs machine (clé API, cycle de vie, rattachement à une org)
- Realms/tenants et le piège des deux realms ; identity brokering vers l'IdP client (OIDC/SAML) ; comptes locaux = artefact de démo
- Rôles IdP vs permissions fines ReBAC (Zanzibar)
- Diagnostic sans navigateur (password grant, code HTTP) ; onglet de login périmé ; marqueurs serveur (`user_not_found`, corrélation par session)
- *Exercice : provoquer un 401 et un 403, les distinguer dans les logs*

### Étape 14 · Gouvernance de l'usage (§6)
- Quotas et rate limiting en amont de l'inférence, compteurs en cache clé-valeur
- Vérifier la table de routage réelle plutôt que supposer que toutes les routes passent par le quota ; consommation/facturation par organisation
- *Exercice : déclencher un 429 et remonter au compteur*

### Étape 15 · Inférence, routage de modèles et GPU (§7)
- Routeur de modèles, API interne standardisée ; inférence déportée vs locale (GPU, souveraineté des prompts, usage démo vs prod) ; honnêteté sur ce qui tourne localement
- Configuration déclarative des modèles ; liste des modèles activés via init container et levier de désactivation ; modèles spécialisés (complétion, embeddings, OCR, transcription, modération, annotation, classification) ; API compatible OpenAI
- GPU : device plugin / GPU Operator, `nvidia.com/gpu`, MIG, time-slicing, labels/taints, versions drivers/CUDA ; chargement des poids (PVC, init container, objet), startup probes longues, `shm`, vLLM
- *Exercice : basculer un modèle de déporté à local et lister ce qui change*

### Étape 16 · Fonctionnalités produit autour du modèle (§8)
- UI conversationnelle, console admin, gestionnaire de configuration ; canvas et son isolation
- RAG : bibliothèque, ingestion, crawler (worker, fetcher, fetcher headless) ; connecteurs, gateway, callbacks OAuth
- Agents, conversations, deep research ; sandboxes de code ; workflows durables et tâches planifiées ; registres de prompts/skills ; audio
- *Exercice : ingérer un document et suivre le chemin crawler → worker → base*

### Étape 17 · Plan de données, sauvegarde et continuité (§9, §10)
- Une base par application (isolation vs coût) ; pooler et le faux « too many connections » ; cache KV ; bus de messages ; moteur de workflows (namespaces par app) ; base analytique colonnaire ; stockage objet S3 ; etcd
- Pour chaque brique : ce qui casse si elle tombe ; services managés externes à qualifier
- Preview vs production ; backup continu + PITR vers objet via plugin d'opérateur ; ne jamais affirmer une sauvegarde sans vérifier ; HA : instances par composant, preview vs topologie cible
- *Exercice : couper le cache, puis le pooler, et noter le symptôme applicatif de chacun*

### Étape 18 · Observabilité (§11)
- Infra (collecteurs, agents, pipelines, ingestion OTLP branchable chez le client) vs produit (traces de conversations, évaluations, consommation)
- Endpoints d'ingestion logs/métriques/traces ; Prometheus/Grafana, kube-state-metrics, Loki
- *Exercice : retrouver une requête dans les traces à partir de son code HTTP*

---

## Partie D — Exploitation et diagnostic

### Étape 19 · k9s et ses équivalents kubectl (§12)
- Modèle mental, navigation, vues utiles, actions (logs, logs précédents, describe, YAML, shell, port-forward, kill, delete), vue logs, tri CPU/mémoire/âge/statut, arbre Deployment → RS → Pod → conteneur, dashboard global
- Mises en garde : contexte, secrets en partage d'écran ; équivalent kubectl de chaque action
- *Exercice : répondre à « pourquoi ça rame » en moins d'une minute*

### Étape 20 · Méthode de debug (§13)
- Les cinq temps : objectiver (code HTTP) → situer dans le chemin → santé/âge du pod → logs de la bonne instance, premier message d'erreur → descendre d'un plan
- Arbres par symptôme : injoignable, échec de connexion, erreur d'API, CrashLoopBackOff, Pending
- Codes HTTP comme carte (401/403/429/404/500/504) ; vérifier l'heure, faux positifs connus, produit vs exemple ; lire une stack trace en remontant ; en-tête `server`, erreurs de décodage trompeuses, chemin du fichier source ; falsifier la première hypothèse
- *Exercice : casser un composant du plan de données, diagnostiquer seul depuis le symptôme applicatif*

### Étape 21 · Environnements éphémères (§15)
- Clusters virtuels de preview, TTL, coût ; idempotence ; provisionnement asynchrone (pending → provisioning → running)
- Timeline réaliste : Pending massifs, migrations qui bloquent les init containers ; distinguer « long » de « cassé » ; composants optionnels légitimement en erreur
- Hygiène des ressources partagées, suppression en partant, vérification de destruction, ressources cloud orphelines ; ne rien supprimer sans droits
- *Exercice : créer, observer la timeline, détruire, vérifier*

### Étape 22 · Faux positifs récurrents (§18)
- Contexte non sécurisé (TLS terminé en amont), rafales d'erreurs base au failover, 404 des règles de sécurité sur endpoints internes
- Constituer sa propre liste des bruits normaux
- *Exercice : trier un log réel entre bruit et erreur*

---

## Partie E — Restitution client et pratique

### Étape 23 · Communication technique avec un client (§19)
- Constat vs croyance ; jamais de bluff sur un chiffre ; une commande plutôt qu'une affirmation
- Les onze questions récurrentes (données, on-site, dimensionnement, bases, sauvegardes, HA, mise à jour, API standard, air-gapped, monitoring, anti-SSRF) et une réponse de 30 secondes pour chacune
- Annoncer ses aspérités ; table ❌/✅ ; marquer le « à vérifier », ne pas s'engager seul
- *Exercice : session de questions client simulée*

### Étape 24 · GitOps, opérations et certification
- ArgoCD/Flux, upgrades de cluster, Velero ; CKAD puis CKA
- *Exercice final : refaire de mémoire les étapes 11, 20 et 23 sur un environnement vivant*

---

## Fichiers du cours

| Étape | Fichier |
|---|---|
| Plan | `00-plan-roadmap.md` |
| 0 | `etape-00-environnement-prerequis.md` |
| 1 | `etape-01-architecture-modele-declaratif.md` |
| … | un fichier par étape |
| Résumé A | `partie-A-resume.md` — take-aways et aide-mémoire des étapes 0 à 6 |
| Résumé B, C, D, E | un fichier de résumé à la fin de chaque partie |
