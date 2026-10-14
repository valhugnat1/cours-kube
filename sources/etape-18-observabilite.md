# Étape 18 — Observabilité

**Objectif** : à la fin de cette étape, tu sais distinguer l'observabilité de l'infrastructure (pods, nœuds, GPU, bases) de l'observabilité du produit (conversations, agents, évaluations, consommation), dire où partent les logs, les métriques et les traces d'une installation, comment les brancher sur les outils du client, et surtout **retrouver une requête précise** à partir d'un simple code HTTP. Tu sais aussi ce qui ne doit **pas** finir dans la télémétrie.

**Notions couvertes** : §11 (observabilité infra vs produit, collecteurs, agents, pipelines, ingestion OTLP branchable chez le client, endpoints d'ingestion logs/métriques/traces, Prometheus/Grafana, kube-state-metrics, Loki).

**Prérequis** : étape 1 (`kubectl logs`), étape 11 (carte), étapes 12 à 17 (les chemins à observer ; identifiant de corrélation de l'étape 16).

---

## 18.1 Deux observabilités, deux publics

| | **Observabilité infra** | **Observabilité produit** |
|---|---|---|
| Question | « La plateforme fonctionne-t-elle ? » | « Que fait la plateforme pour ses utilisateurs, et est-ce bien fait ? » |
| Public | Toi, l'équipe d'exploitation du client, l'astreinte | Admins de la plateforme, équipes métier, responsables IA, facturation |
| Sujets | Pods, nœuds, GPU, latence, erreurs HTTP, bases, files, disques | Conversations, tours d'agent, appels d'outils, passages RAG utilisés, qualité des réponses, évaluations, tokens par organisation |
| Données | Logs techniques, métriques, traces distribuées | Traces de conversations, scores, retours utilisateurs (pouces), consommation |
| Outils typiques | Prometheus, Grafana, Loki, Tempo/Jaeger, OpenTelemetry, outils du client (Datadog, Splunk, Elastic, Dynatrace) | Fonctionnalités intégrées au produit (console), base analytique (étape 17), outils d'observabilité LLM |
| Sensibilité | Faible à moyenne (sauf fuites, 18.7) | **Élevée** : contient le contenu des conversations |
| Qui la stocke | Souvent **le client**, dans ses outils | La **plateforme**, dans son plan de données |

Deux erreurs symétriques à éviter :

- chercher « pourquoi l'agent a donné une mauvaise réponse » dans Grafana : l'infra dira que tout était vert ;
- chercher « pourquoi l'API renvoie des 504 » dans les traces de conversations : elles ne contiennent pas les timeouts de l'Ingress.

Elles se rejoignent par **un identifiant commun** (identifiant de requête / trace ID), que tu dois savoir suivre de l'une à l'autre (18.6).

---

## 18.2 Les trois signaux

| Signal | Ce que c'est | Bon pour | Mauvais pour | Coût |
|---|---|---|---|---|
| **Métriques** | Séries numériques agrégées dans le temps (compteurs, jauges, histogrammes) | Tendances, alertes, « combien », « depuis quand » | Expliquer **une** requête | Faible, **sauf cardinalité** |
| **Logs** | Événements horodatés, texte ou JSON | Le détail d'une erreur, le premier message (étape 20) | Agréger, voir une tendance | Moyen à élevé (volume) |
| **Traces** | L'arbre des opérations d'**une** requête à travers les services, avec durées | « Où a-t-elle passé son temps ? », « quel service a échoué en premier ? » | Vue d'ensemble statistique | Élevé → échantillonnage |

Le parcours normal d'une investigation les enchaîne : **métrique** (« le taux de 504 monte depuis 14 h 10 ») → **trace** (« une requête lente : 58 s passées dans le routeur à attendre le moteur ») → **logs** du bon pod, au bon moment (« file d'attente pleine »). Les liens entre les trois (18.6) évitent de faire ce chemin à la main.

### Cardinalité : le piège des métriques

Une série = un nom de métrique × **une combinaison unique de labels**. `http_requests_total{route="/v1/chat", status="200"}` est une série. Ajouter un label `user_id` ou `request_id` crée une série **par utilisateur** ou **par requête** : des millions de séries, Prometheus qui explose en mémoire, et une facture énorme chez un fournisseur SaaS.

Règle : **les labels de métriques ont un nombre de valeurs borné et petit** (route normalisée, code HTTP, modèle, namespace). Les identifiants uniques vont dans les **logs** et les **traces**, jamais dans les labels. Même règle pour les labels de **Loki** (18.4).

---

## 18.3 Métriques : Prometheus, kube-state-metrics, Grafana

### Le modèle de Prometheus

Prometheus **tire** (*pull*) : il appelle périodiquement (*scrape*, souvent toutes les 15 à 30 s) un endpoint HTTP `/metrics` exposé par chaque cible, et stocke les séries.

```
pods applicatifs  /metrics ─┐
node-exporter     /metrics ─┤
kubelet / cAdvisor /metrics ─┼─◀── Prometheus (scrape) ──▶ stockage TSDB ──▶ Grafana (PromQL)
kube-state-metrics /metrics ─┤                                           └─▶ Alertmanager
DCGM exporter     /metrics ─┤
exporters (Postgres, Redis, pooler…) ┘
```

Dans Kubernetes, on installe presque toujours la pile via **prometheus-operator** (souvent le chart `kube-prometheus-stack`), qui ajoute des CRDs pour déclarer quoi scraper **à côté** des applications, sans éditer la configuration de Prometheus :

- **`ServiceMonitor`** : scrape les endpoints d'un Service sélectionné par labels ;
- **`PodMonitor`** : scrape directement des pods ;
- **`PrometheusRule`** : règles d'alerte et d'enregistrement.

Pièges d'installation, tous vécus :

- **`ServiceMonitor` ignoré** : Prometheus ne sélectionne que les monitors portant **les labels** qu'il attend (souvent `release: <nom-de-la-release>`) et dans les namespaces qu'il surveille. Le chart de la plateforme crée ses `ServiceMonitor`, rien n'est scrapé, aucune erreur. Vérifier `serviceMonitorSelector` et `serviceMonitorNamespaceSelector` de l'objet `Prometheus`.
- **CRDs absentes** : le chart de la plateforme veut créer des `ServiceMonitor` sur un cluster sans prometheus-operator → `no matches for kind ServiceMonitor` (étape 9). Désactiver dans les values (`serviceMonitor.enabled: false`) si le client n'utilise pas Prometheus.
- **Port de métriques** : nommé différemment dans le Service et le `ServiceMonitor` → cible absente ou `down`.
- **NetworkPolicy** qui interdit à Prometheus (autre namespace) de joindre les pods.
- **Métriques exposées publiquement** par l'Ingress (étape 12) : les métriques se scrapent **à l'intérieur** du cluster, sur un port non routé.

Vérifier ce qui est réellement scrapé : interface de Prometheus (`port-forward`), page **Targets** (état `up`/`down` et dernière erreur), ou la requête `up{namespace="platform"}`.

### Les sources de métriques de base

| Source | Ce qu'elle mesure | Exemples de questions |
|---|---|---|
| **kubelet / cAdvisor** | Consommation **réelle** des conteneurs : CPU, mémoire, réseau, système de fichiers | « Ce pod approche-t-il sa limite mémoire ? » |
| **kube-state-metrics** | L'**état des objets** Kubernetes, lu depuis l'API : réplicas désirés/disponibles, phase des pods, redémarrages, raisons de terminaison, requests/limits déclarés, PVC, Jobs | « Combien de pods en `CrashLoopBackOff` ? », « Ce Deployment a-t-il tous ses réplicas ? », « Quelle est la dernière raison de terminaison ? » |
| **node-exporter** | Le **nœud** : CPU, mémoire, disque, système de fichiers, réseau | « Le disque du nœud va-t-il être plein ? » |
| **DCGM exporter** | Les **GPU** : utilisation, mémoire, température, erreurs (étape 15) | « Les GPU sont-ils vraiment utilisés ? » |
| **Exporters de briques** | PostgreSQL, pooler, Redis, bus, moteur de workflows, base analytique, ingress controller | « Connexions, lag, taux de hits, files » |
| **Applications** | Métriques métier et techniques propres : requêtes par route, latence, erreurs, tokens, file du moteur d'inférence, cache KV | « TTFT par modèle », « 429 par organisation » (attention à la cardinalité) |

La différence entre **cAdvisor** et **kube-state-metrics** est fondamentale et piège souvent : cAdvisor dit ce qu'un conteneur **consomme** ; kube-state-metrics dit ce que les objets **déclarent** et dans quel **état** ils sont. « Un pod a été `OOMKilled` » vient de kube-state-metrics (`kube_pod_container_status_last_terminated_reason`) ; « il utilisait 1,9 Go juste avant » vient de cAdvisor (`container_memory_working_set_bytes`).

### Quelques requêtes PromQL à savoir écrire

```promql
# Taux d'erreurs 5xx par route, sur 5 minutes (métrique de l'ingress controller ou de l'app)
sum by (route) (rate(http_requests_total{namespace="platform", status=~"5.."}[5m]))

# Latence p95 par route (histogramme)
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{namespace="platform"}[5m])))

# Pods qui redémarrent
increase(kube_pod_container_status_restarts_total{namespace="platform"}[1h]) > 0

# Derniers OOMKilled
kube_pod_container_status_last_terminated_reason{namespace="platform", reason="OOMKilled"} == 1

# Mémoire utilisée / limite, par conteneur
sum by (pod, container) (container_memory_working_set_bytes{namespace="platform", container!=""})
  / sum by (pod, container) (kube_pod_container_resource_limits{namespace="platform", resource="memory"})

# Deployments sans tous leurs réplicas
kube_deployment_status_replicas_available{namespace="platform"} < kube_deployment_spec_replicas{namespace="platform"}

# PVC bientôt pleins (métriques kubelet)
kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes > 0.85
```

Les **noms exacts** des métriques applicatives dépendent de chaque composant et de sa version : lis `/metrics` (en `port-forward`) plutôt que de supposer.

### Grafana et les alertes

**Grafana** interroge Prometheus (et Loki, Tempo…) et affiche des tableaux de bord. Deux conseils :

- des tableaux de bord **par plan** (entrée, identité, applicatif, inférence, données) reprenant la carte de l'étape 11 rendent le « descendre d'un plan » visuel ;
- les tableaux de bord **ne remplacent pas les alertes** : personne ne regarde un écran à 3 h du matin.

Alertes utiles, **sur des symptômes** plutôt que des causes : taux de 5xx, latence p95 au-delà de l'objectif, pods indisponibles depuis N minutes, PVC > 85 %, archivage WAL en échec (étape 17), lag du bus qui croît, certificat qui expire dans 14 jours (étape 12), cibles de scrape `down`. Et une alerte « **plus aucune donnée** » (`absent()`) : une plateforme qui n'envoie plus de métriques ne déclenche aucune autre alerte.

---

## 18.4 Logs : de `kubectl logs` à Loki

### Où sont les logs

Un conteneur écrit sur `stdout`/`stderr` ; le runtime les écrit dans des fichiers **sur le nœud** (`/var/log/pods/…`) ; `kubectl logs` les lit via le kubelet. Limites, qui justifient une collecte :

- **rotation** : seuls les derniers Mo sont conservés ;
- **`--previous`** ne remonte qu'**un** redémarrage (étape 1) ;
- pod supprimé ou nœud remplacé → **logs perdus** ;
- pas de recherche transverse sur 40 pods et 3 heures.

### La chaîne de collecte

```
conteneurs (stdout) → fichiers sur le nœud
  → AGENT de collecte en DaemonSet sur chaque nœud (Grafana Alloy, Fluent Bit, Vector, OpenTelemetry Collector…)
      ajoute les métadonnées Kubernetes (namespace, pod, conteneur, labels)
  → PIPELINE (filtrage, parsing JSON, masquage, routage, échantillonnage)
  → stockage : Loki, Elasticsearch/OpenSearch, Splunk, Datadog, Cloud Logging…
```

(Promtail, l'ancien agent historique de Loki, a été remplacé par Grafana Alloy : si tu le rencontres dans une documentation, vérifie la date.)

### Loki

**Loki** indexe **uniquement des labels** (namespace, app, conteneur…) et stocke le texte des logs compressé, sans index plein texte. Conséquences :

- **peu coûteux** en stockage et en index ;
- une requête doit d'abord **sélectionner des flux par labels**, puis filtrer le texte :

```logql
{namespace="platform", app="api"} |= "error"
{namespace="platform", app="api"} | json | status >= 500 | line_format "{{.request_id}} {{.route}} {{.msg}}"
{namespace="platform"} |= "4bf92f3577b34da6a3ce929d0e0e4736"      # un trace ID, sur tout le namespace
sum by (app) (count_over_time({namespace="platform"} |= "too many connections" [5m]))
```

- **même règle de cardinalité** que Prometheus : un label `request_id` ou `user_id` crée un flux par valeur et dégrade tout. L'identifiant reste **dans la ligne**, on le cherche avec `|=`.

### Des logs exploitables

Ce qui fait gagner des heures, et que tu peux demander aux équipes produit ou vérifier à l'installation :

- **JSON structuré** (un objet par ligne), avec au minimum : horodatage **UTC ISO 8601**, niveau, composant, message, **identifiant de requête**, **trace ID**, organisation (identifiant, pas nom), route, code HTTP, durée.
- **Les erreurs sur une ligne** : une stack trace sur 60 lignes devient 60 entrées séparées si l'agent ne gère pas le multi-lignes ; en JSON, la stack trace est un champ.
- **Niveau configurable** par composant sans reconstruire l'image (value `logLevel`).
- **Pas de secrets, de jetons, de contenu de conversation** (18.7).
- **Fuseau horaire** : tout en UTC. La moitié des « il n'y a rien dans les logs » sont des recherches sur la mauvaise heure (étape 13).

---

## 18.5 Traces distribuées et OpenTelemetry

### Le principe

Une **trace** représente une requête ; elle est composée de **spans** (une opération : requête HTTP entrante, appel au routeur, requête SQL, appel au modèle), chacun avec un début, une durée, un statut, des attributs et un parent.

```
trace 4bf92f35…   POST /v1/chat/completions   58,3 s   ERROR 504
├─ ingress                                    58,3 s
│  └─ api: handle_chat                        58,2 s
│     ├─ auth: verify_token                    0,004 s
│     ├─ governance: check_quota               0,002 s  (redis INCRBY)
│     ├─ rag: search                           0,31 s
│     │  ├─ router: embeddings                 0,12 s
│     │  └─ postgres: SELECT … ORDER BY embedding <-> …  0,17 s
│     └─ router: chat completion              57,8 s   ERROR timeout
│        └─ vllm-large: queue_wait            57,6 s   ← la cause
```

La trace répond en un coup d'œil à ce que dix fichiers de logs rendraient laborieux : **où** le temps a été passé et **quel** service a échoué en premier.

### La propagation du contexte

Pour que les spans de services différents appartiennent à la même trace, chaque service transmet le contexte au suivant dans un en-tête standard **W3C Trace Context** :

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  └── trace ID (32 hex) ─────────┘ └─ span parent ─┘ └ flags (échantillonné)
```

Ce qui casse la propagation, et produit des traces **coupées en morceaux** :

- un composant **non instrumenté** au milieu (proxy maison, worker) ;
- un **proxy** ou une gateway qui ne relaie pas l'en-tête ;
- les **passages asynchrones** : un message sur le bus ou un workflow ne transporte pas le contexte automatiquement — il faut le mettre dans le message (étape 16). Sinon, la trace de la requête d'upload s'arrête à « événement publié », et le traitement du worker est une trace séparée sans lien ;
- des formats différents (anciens en-têtes B3 de Zipkin vs W3C) entre composants.

### OpenTelemetry

**OpenTelemetry** (OTel) est le standard ouvert pour produire et transporter la télémétrie (traces, métriques, logs) :

- **SDK / instrumentation** dans les applications (auto-instrumentation de FastAPI, des clients HTTP, des drivers SQL, de Redis…) ;
- **OTLP** : le protocole de transport, en **gRPC (port 4317)** ou **HTTP (port 4318)** ;
- **OpenTelemetry Collector** : un service qui **reçoit**, **traite** (ajout d'attributs Kubernetes, filtrage, masquage, échantillonnage, regroupement) et **exporte** vers un ou plusieurs backends.

```
apps (SDK OTel) ──OTLP──▶ Collector "agent" (DaemonSet, par nœud) ──OTLP──▶ Collector "gateway" (Deployment)
                                                                              ├─▶ Tempo / Jaeger (traces)
                                                                              ├─▶ Prometheus (métriques)
                                                                              ├─▶ Loki (logs)
                                                                              └─▶ endpoint OTLP du CLIENT
```

Configuration minimale côté application (variables standard) :

```yaml
env:
  - name: OTEL_SERVICE_NAME
    value: api
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://otel-collector.observability.svc:4318
  - name: OTEL_TRACES_SAMPLER
    value: parentbased_traceidratio
  - name: OTEL_TRACES_SAMPLER_ARG
    value: "0.1"
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: deployment.environment=preprod
```

### Échantillonnage

Tracer **toutes** les requêtes coûte cher. Deux stratégies :

- **Head sampling** : on décide **au début** de la requête (par exemple 10 %), et la décision se propage (flag du `traceparent`). Simple, mais la requête en erreur qui t'intéresse a 90 % de chances de ne pas avoir été tracée.
- **Tail sampling** : le Collector **attend la fin** de la trace et garde **toutes** les traces en erreur ou lentes, plus un échantillon des autres. Bien plus utile pour le diagnostic, plus coûteux en mémoire au Collector (il doit tenir les traces en cours).

Conséquence pour l'exercice et le terrain : « je ne trouve pas la trace de cette requête » peut simplement vouloir dire **qu'elle n'a pas été échantillonnée**. Vérifier la politique avant de conclure que la propagation est cassée.

### Les liens entre signaux

- **Trace ID dans chaque ligne de log** : de la trace, on saute aux logs exacts de chaque service (Grafana relie Tempo et Loki sur ce champ).
- **Exemplars** : une métrique d'histogramme porte, pour certains points, le trace ID d'une requête représentative : du pic de latence dans le graphique, un clic mène à une trace de ce pic.
- **Identifiant de requête renvoyé au client** (en-tête de réponse, corps d'erreur) : l'utilisateur ou le développeur client peut te le transmettre, et tout le reste en découle (18.8).

---

## 18.6 Endpoints d'ingestion et branchement chez le client

Chez un client, tu déploies rarement ta propre pile d'observabilité en production : **il a déjà la sienne** (Datadog, Splunk, Elastic, Dynatrace, Grafana Cloud, Cloud Logging, une pile Prometheus interne) et une équipe qui la surveille. Le rôle du chart est d'**émettre proprement** et de se **brancher**.

### Ce que la plateforme doit offrir

| Signal | Mode d'exposition | Branchement typique chez le client |
|---|---|---|
| Métriques | `/metrics` au format Prometheus + `ServiceMonitor` optionnels ; ou export OTLP | Leur Prometheus scrape ; ou leur agent (Datadog, etc.) lit le format Prometheus ; ou OTLP vers leur collecteur |
| Logs | `stdout` en JSON | **Leur** agent en DaemonSet collecte déjà tous les pods du cluster : il n'y a souvent **rien à faire**, sauf vérifier le parsing JSON et le masquage |
| Traces | OTLP vers un Collector | Endpoint OTLP de leur backend, ou leur Collector |

La notion clé : **ingestion OTLP branchable**. Les values du chart exposent un point unique :

```yaml
observability:
  otlp:
    enabled: true
    endpoint: https://otel.client.internal:4318     # leur collecteur ou leur backend
    protocol: http/protobuf                         # ou grpc
    headers:
      existingSecret: otlp-auth                     # clé d'API / jeton de leur backend, jamais en clair
    tls:
      caSecret: client-ca                           # CA d'entreprise (étape 12)
    sampling:
      ratio: 0.1
  serviceMonitor:
    enabled: false                                  # pas de prometheus-operator chez ce client
```

Un bon schéma d'installation : **un Collector de la plateforme** dans le cluster, qui reçoit tout des applications, enrichit, **masque** (18.7), échantillonne, et exporte **vers l'endpoint du client** (et/ou vers une pile locale). Avantages : les applications ne connaissent qu'une adresse ; le client change de backend sans toucher aux applications ; le masquage est appliqué **avant** que les données ne sortent.

### Checklist de branchement (à envoyer au client)

- Quels signaux veulent-ils (métriques, logs, traces) et dans quel outil ?
- **Endpoint** : URL, protocole (OTLP gRPC ou HTTP, format Prometheus, API propriétaire), port.
- **Authentification** : en-tête, jeton, mTLS ; où sera stocké le secret.
- **TLS** : CA à monter.
- **Réseau** : l'endpoint est-il joignable depuis le cluster ? Via le proxy egress ? (`NO_PROXY`, étape 12.) Pour un **scrape** entrant par leur Prometheus externe, faut-il ouvrir un accès **vers** le cluster (à éviter : préférer un agent dans le cluster ou un *remote write* sortant) ?
- **Volume** et **coûts** : beaucoup de backends facturent au volume ingéré ou au nombre de séries → cardinalité, échantillonnage, niveau de log.
- **Données sensibles** : quelles données ont le droit de sortir vers leur outil (et leur outil est-il lui-même un SaaS hors du périmètre souverain ?).
- **Rétention** chez eux.
- **Alertes** : qui les reçoit ? Leur astreinte, la tienne, les deux ?

### Vérifier que ça arrive

```bash
# Le Collector reçoit-il ? exporte-t-il ? (ses propres métriques et logs)
kubectl logs -n observability deploy/otel-collector --since=10m | grep -iE 'error|dropped|refused|x509|401|403|429'
kubectl port-forward -n observability deploy/otel-collector 8888:8888 &
curl -s localhost:8888/metrics | grep -E 'otelcol_(receiver_accepted|exporter_sent|exporter_send_failed)_spans'

# Depuis un pod applicatif : l'endpoint est-il joignable ?
kubectl exec -n platform deploy/api -- sh -c 'curl -s -o /dev/null -w "%{http_code}\n" "$OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces" -X POST -H "Content-Type: application/json" -d "{}"'
```

Un `send_failed` qui grimpe dans le Collector, avec `x509`, `401` ou `429` dans ses logs, et **aucune erreur côté applications** : c'est normal — la perte de télémétrie est **silencieuse** pour les applications (elles ne doivent pas échouer parce que l'observabilité est en panne). D'où, encore, l'alerte « plus aucune donnée ».

---

## 18.7 Ce qui ne doit pas finir dans la télémétrie

Une plateforme LLM est **particulièrement** exposée : son contenu naturel (prompts, documents, réponses) est sensible, et l'auto-instrumentation capture volontiers les corps de requêtes, les en-têtes et les paramètres SQL.

À ne jamais laisser partir vers l'observabilité infra, **a fortiori** vers un outil tiers du client :

- **en-têtes d'authentification** (`Authorization`, cookies, jetons OIDC, clés API) ;
- **corps de requêtes et de réponses** de l'API de chat (prompts, réponses, passages RAG) ;
- **contenu de documents** ingérés, résultats de crawler, sorties de sandbox ;
- **paramètres de requêtes SQL** (l'instrumentation des drivers peut les inclure) ;
- **jetons de connecteurs**, secrets, chaînes de connexion ;
- **URL avec paramètres sensibles** (callbacks OAuth avec `code=…`) ;
- **données personnelles** au-delà du strict nécessaire (préférer des identifiants opaques aux emails).

Défenses :

1. **À la source** : configurer l'instrumentation pour ne pas capturer corps et en-têtes ; logs applicatifs relus pour ces champs.
2. **Au Collector** : processeurs de filtrage et de masquage (suppression d'attributs, remplacement par motif) **avant** export — c'est l'intérêt d'un Collector de la plateforme en frontière.
3. **Vérification empirique** : chercher dans les backends un jeton de test, un prompt de test (« canari ») envoyé volontairement. S'il apparaît, c'est une fuite.

Le contenu des conversations appartient à l'**observabilité produit** (18.8), stockée dans le plan de données de la plateforme, avec ses contrôles d'accès (ReBAC), sa rétention et ses suppressions (étape 16) — pas dans les logs techniques conservés 90 jours dans un outil que 200 personnes consultent.

---

## 18.8 Observabilité produit

### Traces de conversations et d'agents

Pour chaque conversation ou exécution d'agent, le produit enregistre ce qui s'est passé **du point de vue métier** :

- messages, modèle utilisé, paramètres ;
- prompt système **et sa version** (registre, étape 16) ;
- passages RAG récupérés, avec leur score et leur source ;
- chaque tour d'agent : outil choisi, arguments, résultat, erreur, durée ;
- tokens d'entrée et de sortie, latence (TTFT, total) ;
- retour de l'utilisateur (pouce, commentaire) ;
- identifiant de requête / trace ID **technique** correspondant.

Ce dernier champ est le pont : depuis une conversation signalée par un utilisateur (« la réponse était fausse et a mis une minute »), on obtient la trace technique (où est passée la minute), et depuis une trace technique en erreur, on retrouve la conversation (avec les droits nécessaires).

Usages : comprendre une mauvaise réponse (mauvais passages RAG ? mauvais outil ? prompt modifié ?), déboguer un agent, auditer.

Contraintes : ce sont **des données utilisateurs** — accès restreint (rôles d'admin, ReBAC), journalisation des consultations, **rétention** alignée sur celle des conversations, **suppression** propagée (base analytique, étape 17).

### Évaluations

Mesurer la **qualité**, pas seulement la santé :

- **hors ligne** : jeux de questions de référence rejoués sur une nouvelle version de modèle, de prompt ou de chaîne RAG, avec des scores (exactitude, fidélité aux sources, pertinence, format) — souvent notés par un modèle « juge » ;
- **en ligne** : échantillon de conversations réelles évaluées automatiquement, retours utilisateurs, taux de réponses sans source, taux d'échecs d'outils.

Pour l'exploitation, retiens : les évaluations **consomment** du modèle (annotation, étape 15) et doivent être imputées (étape 14) ; elles sont le seul moyen de savoir si la bascule **déporté → local** (étape 15) ou un changement de **modèle d'embeddings** (étape 16) a dégradé la qualité. « Tout est vert dans Grafana » ne dit rien de la qualité des réponses.

### Consommation

Rappel de l'étape 14, vu d'ici : tokens et requêtes par organisation, projet, clé, modèle, jour ; alimentés par le bus vers la base analytique (étape 17) ; affichés dans la console d'admin et exportables. Deux signaux d'exploitation à surveiller comme n'importe quelle métrique : **lag** du pipeline de metering et **trous** dans les séries (panne silencieuse).

---

## 18.9 Retrouver une requête à partir de son code HTTP : la méthode

C'est la compétence de l'étape, et l'ouverture vers la méthode de debug de l'étape 20. Tu disposes au départ, au mieux, de : un code HTTP, une heure approximative, parfois une route, parfois un identifiant de requête renvoyé au client.

### 1. Récupérer le maximum depuis la réponse

```bash
curl -s -D headers.txt -o body.json -w '%{http_code} %{time_total}\n' … 
grep -iE '^(x-request-id|traceparent|x-trace-id|server|date|retry-after)' headers.txt
jq . body.json      # souvent un request_id dans le corps d'erreur
```

- **identifiant de requête / trace ID** : s'il est là, passer directement à l'étape 3 ;
- **`date:`** : l'heure exacte **du serveur**, en GMT — plus fiable que l'horloge de l'utilisateur ;
- **`server:`** et forme du corps : **qui** a répondu (controller, application, fournisseur amont — étapes 12 et 14) ; une 504 **du controller** n'aura aucune trace dans l'application si la requête n'a jamais atteint le pod… ou en aura une qui continue après le timeout.

### 2. Sans identifiant : trouver la requête par le code et l'heure

D'abord **les logs de l'émetteur** (souvent l'ingress controller, qui voit tout) sur une fenêtre de quelques minutes :

```logql
{namespace="ingress-nginx"} | json | status = 504 | host = "api.client.com"
```

Les logs d'accès du controller contiennent en général la route, la durée, l'upstream (pod) et, s'il est configuré, **l'identifiant de requête** qu'il a généré et transmis. Sinon, par la métrique pour situer puis les logs de l'application :

```promql
sum by (route) (increase(http_requests_total{namespace="platform", status="504"}[10m]))
```

```logql
{namespace="platform", app="api"} | json | status = 504
```

### 3. Avec l'identifiant : la trace

- chercher le **trace ID** dans le backend de traces (Tempo, Jaeger, outil du client) ;
- lire l'arbre : **le span le plus profond en erreur**, ou **le span qui porte l'essentiel de la durée** (étape 20 : premier message d'erreur, descendre d'un plan) ;
- trace introuvable → **échantillonnage** d'abord, puis propagation cassée (un morceau de trace commence au service suivant ?), puis export du Collector en échec.

### 4. Descendre dans les logs du bon pod

Depuis le span fautif : service, **pod** (attribut `k8s.pod.name` ajouté par le Collector), heure exacte.

```logql
{namespace="platform"} |= "4bf92f3577b34da6a3ce929d0e0e4736"
```

ou, sans pile de logs, directement :

```bash
kubectl logs -n platform <pod-exact> --since-time=2026-09-17T14:10:00Z | grep 4bf92f3577b34da6a3ce929d0e0e4736
kubectl logs -n platform <pod-exact> --previous | grep …     # si le pod a redémarré depuis
```

### 5. Si besoin, remonter au produit

Depuis le trace ID, la conversation ou l'exécution d'agent correspondante dans l'observabilité produit (avec les droits adéquats) : quel modèle, quels passages, quel outil, quelle version de prompt.

### Ce qu'on écrit à la fin

Une phrase de constat, pas de croyance (étape 23) : « La requête `4bf92f35…` de 14:10:22 UTC a reçu une 504 du controller après 60 s ; la trace montre 57,6 s d'attente dans la file de `vllm-large` ; les logs du pod `vllm-large-…-x7k2` montrent la file pleine à partir de 14:08 ; cause probable : pic de charge d'une ingestion (embeddings sur le même GPU ?) — **à vérifier**. »

---

## 18.10 Pièges

- **Chercher la qualité dans l'infra**, ou les timeouts dans l'observabilité produit.
- **Labels à forte cardinalité** (`user_id`, `request_id`) dans Prometheus ou Loki.
- **`ServiceMonitor` sans le bon label** : rien n'est scrapé, aucune erreur.
- **CRDs de prometheus-operator absentes** chez le client.
- **Métriques publiques** via l'Ingress.
- **Confondre cAdvisor (consommation) et kube-state-metrics (état déclaré).**
- **Tableaux de bord sans alertes** ; pas d'alerte sur l'**absence** de données.
- **Logs non structurés**, stack traces multi-lignes éclatées, heure locale, niveau non configurable.
- **Compter sur `kubectl logs`** pour un pod supprimé ou un crash d'il y a deux redémarrages.
- **Promtail** dans une documentation récente (remplacé par Alloy).
- **Propagation coupée** par un proxy, un worker non instrumenté ou un passage par le bus.
- **Head sampling à 10 %** et conclure que la trace « n'existe pas ».
- **Tail sampling** sans mémoire suffisante au Collector.
- **Ports OTLP** confondus (4317 gRPC / 4318 HTTP), chemin `/v1/traces` oublié.
- **Collector qui échoue à exporter** (x509, 401, 429) sans que personne ne le voie.
- **Installer une pile d'observabilité complète** chez un client qui a déjà la sienne.
- **Scrape entrant** depuis l'extérieur du cluster au lieu d'un envoi sortant.
- **Jetons, prompts, documents, paramètres SQL** dans les logs ou les traces ; export vers un SaaS hors périmètre souverain.
- **Traces de conversations** accessibles trop largement ou conservées plus longtemps que les conversations.
- **Évaluations non imputées** ; changement de modèle sans évaluation.
- **Chercher sur la mauvaise heure** (fuseau, horloge de l'utilisateur au lieu de l'en-tête `date`).

---

## 18.11 Exercice — retrouver une requête dans les traces à partir de son code HTTP

Sur ton cluster kind, en réutilisant les composants des étapes 14 (gouvernance), 15 (routeur + moteur local) et 16 (ingestion).

### Partie 1 — Monter la pile

1. Installe `kube-prometheus-stack` dans un namespace `observability` (Prometheus, Alertmanager, Grafana, kube-state-metrics, node-exporter).
2. Installe **Loki** (mode monolithique) et un agent de collecte en DaemonSet (Grafana Alloy) qui envoie les logs de tous les pods, avec les labels namespace/app/pod/container — **et rien de plus en labels**.
3. Installe **Tempo** (mode monolithique).
4. Installe un **OpenTelemetry Collector** en Deployment (« gateway ») : réception OTLP gRPC et HTTP ; processeur d'attributs Kubernetes ; **processeur de masquage** qui supprime `http.request.header.authorization` et tout attribut contenant `prompt` ou `body` ; **tail sampling** qui garde 100 % des traces en erreur ou de plus de 5 s et 10 % des autres ; export vers Tempo.
5. Dans Grafana : sources Prometheus, Loki, Tempo ; lien **Tempo → Loki** sur le trace ID.

### Partie 2 — Instrumenter

1. Instrumente avec le SDK OpenTelemetry (auto-instrumentation FastAPI, httpx/requests, SQLAlchemy/psycopg, Redis) : **gouvernance**, **routeur**, **API d'ingestion**, **worker**.
2. Chaque log est en **JSON**, en UTC, avec `trace_id`, `span_id`, `request_id`, `org_id`, `route`, `status`, `duration_ms`.
3. Chaque réponse HTTP renvoie `x-request-id` et, en cas d'erreur, un corps JSON contenant `request_id`.
4. **Propagation à travers le bus** : l'API d'ingestion injecte le contexte (`traceparent`) dans l'événement ; le worker l'extrait et crée ses spans **dans la même trace**. Fais-le d'abord **sans** propagation, observe deux traces séparées, puis ajoute-la.
5. Crée des `ServiceMonitor` pour tes services. Vérifie dans **Targets** qu'ils sont `up`. Retire le label attendu par Prometheus sur l'un d'eux : observe qu'il disparaît sans erreur. Remets-le.
6. Ajoute au moteur d'inférence local une latence réglable et une file limitée, et à la gouvernance la limite de l'étape 14.

### Partie 3 — Provoquer, puis retrouver

Pour chaque cas, **une autre personne** (ou toi, en notant tout avant de l'oublier) déclenche la requête et ne te transmet **que** : le code HTTP et l'heure approximative à 5 minutes près. Tu dois retrouver la requête et produire la phrase de constat de 18.9.

| # | Provocation | Code attendu |
|---|---|---|
| 1 | Requête sans jeton | 401 |
| 2 | Organisation au-delà de son rate limit | 429 (gouvernance) |
| 3 | Moteur d'inférence avec latence de 90 s, Ingress en timeout 60 s | 504 (controller) |
| 4 | Redis coupé, gouvernance en fail-closed | selon ta conception |
| 5 | Pooler coupé (étape 17) | 500 |
| 6 | Upload de 20 Mo | 413 (controller) |
| 7 | Ingestion d'un document corrompu : l'API répond 202, le worker échoue | 202 puis statut `failed` — **retrouver l'échec du worker depuis la requête 202** |

Pour chacun, relève :

- ce que donnent les en-têtes et le corps (`x-request-id`, `date`, `server`) ;
- la requête **PromQL** qui situe l'événement ;
- la requête **LogQL** qui trouve la ligne de l'émetteur ;
- la **trace** (ou la raison de son absence : controller seul, échantillonnage, requête rejetée avant instrumentation) ;
- le **span fautif** et le **pod** exact ;
- les **logs** du pod ;
- la **phrase de constat**.

Refais le cas 3 avec un **head sampling à 10 %** au lieu du tail sampling : combien d'essais avant de trouver une trace ? Conclusion à écrire.

### Partie 4 — Vérifier les fuites

1. Envoie une requête de chat avec un prompt contenant un marqueur unique (`CANARI-<date>`) et une clé API de test identifiable.
2. Cherche le marqueur et la clé **dans Loki et dans Tempo**. S'ils apparaissent : trouve la source (log applicatif, attribut d'auto-instrumentation, paramètre SQL), corrige, recommence.
3. Coupe l'export du Collector vers Tempo (mauvais port) : les applications signalent-elles quelque chose ? Où le vois-tu ? Écris une règle d'alerte (`PrometheusRule`) sur les échecs d'export **et** une sur l'absence de données.

### Partie 5 — Branchement client (simulation)

1. Considère que « le client » est un second Collector dans un namespace `client-observability`, en OTLP **HTTPS** avec certificat de ta CA de l'étape 12 et un jeton d'authentification exigé.
2. Configure le Collector de la plateforme pour exporter vers lui **en plus** de Tempo, via les values (endpoint, secret d'en-tête, CA).
3. Provoque : CA non montée (`x509`), jeton faux (`401`), endpoint injoignable. Relève pour chacun le message et l'endroit où il apparaît.
4. Rédige la **checklist de branchement** de 18.6 remplie pour ce « client ».

### Partie 6 — Sur l'environnement de preview (lecture seule)

1. Quelle pile d'observabilité est en place : métriques, logs, traces, où ?
2. Les applications émettent-elles en OTLP ? Vers quel Collector ? Avec quel échantillonnage ? Quels masquages ?
3. Les logs sont-ils structurés, en UTC, avec trace ID ?
4. La propagation traverse-t-elle le bus et les workflows ? (Trouve une ingestion et regarde si sa trace est complète.)
5. Quelle observabilité produit existe (traces de conversations, évaluations, consommation), qui y a accès, quelle rétention ?
6. Prends une erreur réelle récente (un 4xx ou 5xx dans les métriques) et applique la méthode de 18.9 jusqu'à la phrase de constat — sans lire de contenu de conversation.

**Livrable** : section « Observabilité » de `carte-plateforme-<version>.md` : signaux par composant, pile en place, Collector et export, échantillonnage, masquage, liens entre signaux, alertes existantes et manquantes, observabilité produit et ses accès, checklist de branchement client, et **la procédure « code HTTP → trace → logs » en commandes**, testée.

---

## Validé si…

Tu peux expliquer à voix haute :

- la différence entre observabilité infra et produit, leur public, leurs données, et ce qui les relie ;
- les trois signaux, à quoi sert chacun, et l'ordre dans lequel on les enchaîne ;
- ce qu'est la cardinalité et pourquoi un identifiant de requête ne va jamais dans un label ;
- le modèle pull de Prometheus, le rôle d'un `ServiceMonitor`, et pourquoi il peut être ignoré sans erreur ;
- la différence entre cAdvisor et kube-state-metrics, avec un exemple ;
- cinq requêtes PromQL utiles ;
- la chaîne de collecte des logs et le fonctionnement par labels de Loki ;
- ce qui rend un log exploitable ;
- ce que sont une trace, un span et `traceparent`, et trois causes de traces coupées ;
- le rôle d'OpenTelemetry, d'OTLP et du Collector, et les deux ports ;
- head vs tail sampling, et pourquoi une trace absente ne prouve rien ;
- pourquoi on émet vers les outils du client plutôt qu'installer une pile complète, et huit points de la checklist de branchement ;
- sept types de données qui ne doivent jamais finir dans la télémétrie, et trois défenses ;
- ce que contiennent les traces de conversations, pourquoi elles sont sensibles, et à quoi servent les évaluations ;
- les cinq étapes pour passer d'un code HTTP à la cause, et la phrase de constat qui les conclut.

**Partie suivante** : `partie-C-resume.md` — résumé et take-aways de la partie C, puis `etape-19-k9s-equivalents-kubectl.md`.
