# Partie C — La plateforme LLM, plan par plan : résumé et take-aways

Récap des étapes 11 à 18. À relire avant un cadrage client, une installation, ou quand un symptôme applicatif ne dit pas d'où il vient.

---

## Les 10 idées à garder en tête

1. **Le modèle, c'est une poignée de pods ; la plateforme, c'est tout le reste.** La majorité des incidents viennent de la plateforme (réseau, identité, données, configuration), pas du moteur d'inférence.
2. **Quatre plans : entrée, identité, applicatif, données.** Un symptôme apparaît dans un plan, sa cause est souvent dans le plan du dessous : **descendre, jamais remonter**. Le chart s'arrête à la frontière : cluster, nœuds, LB, StorageClass, GPU, IdP du client sont des prérequis.
3. **Une requête entrante traverse cinq sauts** (DNS → LB → gateway/TLS → Service → pod) ; trouver le premier qui ne fait pas son travail. `curl --resolve` isole le DNS ; timeout ≠ refus ; une 404 du controller ≠ une 404 de l'app.
4. **Ce qui sort compte autant que ce qui entre.** Egress par proxy, `NO_PROXY` avec les CIDR du cluster, CA d'entreprise dans les pods ; crawler et fetchers derrière un proxy **anti-SSRF** (plages privées, `169.254.169.254`, redirections) ; contenu généré sur un **domaine parent distinct**.
5. **401 = qui es-tu ; 403 = as-tu le droit.** Le chemin machine (clé API) ne passe pas par l'IdP. Deux appels OIDC partent **du pod** (échange du code, JWKS). L'issuer se compare au caractère près ; le piège des deux realms se révèle en comparant l'issuer attendu au `iss` d'un vrai jeton. Comptes locaux = artefact de démo.
6. **Rate limit, quota, concurrence et metering sont quatre choses différentes.** La gouvernance décide après l'authentification et avant l'inférence, avec des compteurs dans un cache partagé ; savoir s'il est fail-open ou fail-closed. Un 429 a cinq émetteurs possibles. **Vérifier la table de routage réelle** : des routes échappent toujours à la gouvernance.
7. **Déporté ou local, modèle par modèle, prouvé par une commande.** En déporté, les prompts et les extraits RAG sortent. Le routeur et l'API standardisée permettent de basculer sans toucher l'amont ; la bascule change des dizaines de choses (GPU, poids, probes, `shm`, egress, secrets, capacité, comportement). « Combien de GPU ? » se termine par un test de charge, jamais par un chiffre bluffé.
8. **Les fonctionnalités produit sont asynchrones, appellent le modèle de l'intérieur, et touchent l'extérieur ou du non-fiable.** On suit une **tâche** (statut, workflow, worker), pas un code HTTP. Permissions filtrées **au moment** de la recherche RAG ; changer de modèle d'embeddings impose de réindexer ; agents avec les droits de l'utilisateur ; sandboxes isolées (RuntimeClass, pas de réseau, pas de jeton).
9. **La HA protège le RTO, la sauvegarde protège le RPO, et aucune ne remplace l'autre.** Une base par application ; le pooler est un point de défaillance et l'émetteur fréquent du faux « too many connections ». **« C'est sauvegardé » exige une preuve datée ; « c'est restaurable » en exige une autre.** La preview n'est pas représentative de la production.
10. **Observabilité infra et produit ne répondent pas aux mêmes questions** et se rejoignent par un identifiant de trace. Émettre proprement (JSON, UTC, trace ID, OTLP branchable) vers les outils du client plutôt qu'installer sa pile ; masquer au Collector ; **ni jetons ni prompts dans la télémétrie**. Du code HTTP à la cause en cinq étapes.

---

## La carte, en une page

```
┌─ PLAN D'ENTRÉE ──────────────────────────────────────────────────────────────┐
│ DNS (external-dns) · LB · ingress/gateway · TLS (cert-manager) · proxy egress │
├─ PLAN D'IDENTITÉ ────────────────────────────────────────────────────────────┤
│ IdP (realms, brokering OIDC/SAML) · clés API · moteur d'autorisation (ReBAC)  │
├─ PLAN APPLICATIF ────────────────────────────────────────────────────────────┤
│ UI · console admin · config · API publique · GOUVERNANCE · ROUTEUR DE MODÈLES │
│ moteurs d'inférence (GPU) · RAG (ingestion, workers, embeddings)              │
│ crawler (worker, fetcher, headless) · connecteurs · agents · deep research    │
│ sandboxes · workflows · registres prompts/skills · audio                      │
├─ PLAN DE DONNÉES ────────────────────────────────────────────────────────────┤
│ PostgreSQL (une base/app) · pooler · cache KV · bus · moteur de workflows     │
│ base analytique · base vectorielle · stockage objet (+ sauvegardes) · etcd    │
├─ TRANSVERSE ─────────────────────────────────────────────────────────────────┤
│ observabilité infra (métriques, logs, traces, Collector) · observabilité produit│
└──────────────────────────────────────────────────────────────────────────────┘
  sous la ligne (prérequis client) : cluster, nœuds, CNI, LB, StorageClass,
  drivers GPU, opérateurs cluster-wide, IdP du client, DNS, stockage objet externe
```

---

## Symptôme → plan → premier suspect

| Symptôme utilisateur | Plan où il apparaît | Premier suspect (en descendant) |
|---|---|---|
| Timeout, rien ne répond | Entrée | DNS, LB `<pending>`, pare-feu, overlay/VPN |
| Erreur de certificat | Entrée | Secret TLS absent, SNI, chaîne incomplète, challenge ACME |
| 404 page générique | Entrée | Aucune règle host/path, `ingressClassName` |
| 413 / 504 / réponse coupée / tout d'un coup | Entrée | Body size, timeout de lecture, timeout LB, buffering |
| Boucle de login, erreur après l'IdP | Identité | Appel pod → IdP : CA, proxy, issuer, `client_secret`, onglet périmé |
| 401 avec jeton frais | Identité | Issuer / realm / audience / horloge |
| 403 inattendu, ressource invisible | Identité | Rôle dans le jeton non rafraîchi, relation ReBAC absente, rattachement à l'organisation |
| 429 | Applicatif | Émetteur : gateway / gouvernance / GPU saturé / fournisseur déporté / API tierce |
| Modèle absent de la liste | Applicatif | `enabled`, liste calculée au démarrage par init container |
| Réponse lente, GPU peu chargés | Applicatif → données | Cache KV lent, gouvernance, RAG, pooler |
| Pod d'inférence `CrashLoopBackOff` sans erreur | Applicatif | Liveness sans startup probe pendant le chargement ; `shm` ; CUDA/driver |
| Pod d'inférence `Pending` | Socle | `nvidia.com/gpu` absent d'`allocatable`, toleration, `maxSurge` sans GPU libre |
| Document « en cours » indéfiniment | Applicatif → données | Worker à 0 / mauvaise file, bus, moteur de workflows, embeddings |
| Réponse sans source alors que le document est indexé | Applicatif | Permissions, bibliothèque, modèle d'embeddings changé |
| Import d'URL en échec, uploads OK | Entrée (egress) | Proxy, `NO_PROXY`, SSRF qui bloque (peut-être à raison) |
| Connecteur ne se connecte pas | Identité (tiers) | Application OAuth, `redirect_uri`, scopes, secret expiré, `state` |
| Tout le monde déconnecté | Données | Cache KV redémarré / vidé |
| 500 massifs, erreurs de connexion partout | Données | Pooler (1 réplica ?), puis PostgreSQL, puis disque |
| « too many connections » | Données | Émetteur : PostgreSQL / pooler clients / pooler pool / ORM |
| Rafale d'erreurs de quelques secondes | Données | Bascule du primaire (faux positif connu) |
| Tableaux de bord de consommation vides | Données | Base analytique, lag du bus — le produit marche |
| Base arrêtée, disque plein | Données | WAL non archivés ← stockage objet en panne des heures plus tôt |
| « Il a répondu différemment depuis hier » | Applicatif | Version de prompt dans le registre, modèle basculé, quantification |

---

## Ce qui sort du cluster (table egress à tenir par installation)

| Composant | Destination | Notes |
|---|---|---|
| Inférence déportée | API du fournisseur | Prompts + extraits RAG sortent |
| Crawler / fetchers | Toute URL utilisateur | **Via proxy anti-SSRF uniquement** |
| Connecteurs | APIs SaaS | Échange de code + appels d'API depuis le pod |
| Identité | IdP du client | Discovery, token, JWKS |
| cert-manager | CA ACME, API DNS | HTTP-01 impossible si privé |
| external-dns | API DNS | Enregistrements orphelins à la destruction |
| Images, charts | Registre | Sauf miroir air-gapped |
| Sauvegardes | Stockage objet | Hors du cluster, CA dans les pods de sauvegarde |
| Observabilité | Endpoint OTLP / backend client | Masquage avant export |

---

## Commandes de lecture d'une plateforme installée

```bash
# Entrée
kubectl get ingress,httproute -A -o wide
helm get manifest platform -n platform | yq -N 'select(.kind=="Ingress") | .spec.rules[].host' | sort -u
curl -sv --resolve <host>:443:<ip> https://<host>/ -o /dev/null 2>&1 | grep -E 'subject|issuer|expire|HTTP/'
kubectl get certificate,certificaterequest,order,challenge -A

# Identité
helm get values platform -n platform -a | grep -iE 'issuer|realm|oidc'
curl -s <issuer>/.well-known/openid-configuration | jq -r .issuer
kubectl exec -n platform deploy/api -- sh -c 'curl -s -o /dev/null -w "%{http_code}\n" "$OIDC_ISSUER/.well-known/openid-configuration"'

# Gouvernance
curl -s -D - -o /dev/null … | grep -iE 'retry-after|x-ratelimit|x-request-id|server'
redis-cli --scan --pattern '<préfixe>*'           # jamais KEYS *, jamais de modification en prod

# Modèles et GPU
curl -s -H @<(printf 'Authorization: Bearer %s\n' "$PLT_KEY") https://<api>/v1/models | jq -r '.data[].id'
kubectl get nodes -o custom-columns=NAME:.metadata.name,GPU:.status.allocatable.nvidia\\.com/gpu,PRODUCT:.metadata.labels.nvidia\\.com/gpu\\.product
kubectl get pods -n platform -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,GPU:.spec.containers[*].resources.limits.nvidia\\.com/gpu
kubectl get runtimeclass

# Données
kubectl get clusters.postgresql.cnpg.io,scheduledbackups,backups -A
kubectl cnpg status <cluster> -n <ns>
kubectl get pods -n platform -o wide --sort-by=.spec.nodeName     # placement réel des réplicas
kubectl get pdb -A ; kubectl get pvc -A

# Observabilité
kubectl get servicemonitor,podmonitor,prometheusrule -A
kubectl logs -n observability deploy/otel-collector --since=10m | grep -iE 'error|dropped|x509|401|429'
```

---

## Questions à poser au client pendant le cadrage (partie C)

**Entrée** : liste des hosts (y compris console admin, callbacks, **domaine parent distinct pour le contenu généré**) ; DNS manuel ou automatique ; certificats (ACME, EAB, CA interne, dates d'expiration) ; LB disponible ; restriction par IP ; accès au control plane ; proxy egress et inspection TLS ; destinations autorisées.

**Identité** : IdP (OIDC/SAML), metadata, redirect URI à déclarer, identifiant stable, groupes, qui a accès, joignabilité depuis le cluster, rotation des certificats SAML, contact capable de modifier l'application SSO.

**Usage** : organisations/équipes, limites souhaitées, refacturation interne, fuseau des agrégations.

**Inférence** : déporté ou local, par modèle ; exigences de souveraineté ; GPU disponibles (modèle, nombre, driver) ; utilisateurs simultanés, contexte, latence cible ; poids et licences ; air-gapped ?

**Fonctionnalités** : connecteurs voulus et création des applications OAuth ; indexation d'intranet (liste blanche) ; exécution de code (RuntimeClass possible ?) ; audio temps réel (WebSocket/WebRTC).

**Données** : services managés ou embarqués (grille de qualification) ; RPO/RTO ; où vont les sauvegardes ; qui teste les restaurations ; rétention des conversations ; topologie cible (nœuds, zones).

**Observabilité** : outils en place, endpoints, authentification, volumes et coûts, données autorisées à sortir, qui reçoit les alertes.

---

## Pièges vécus, par étape

- **11** — confondre modèle et plateforme ; composant désactivé compté comme présent ; remonter au lieu de descendre ; carte d'une autre version ; oublier Jobs et CronJobs.
- **12** — tester par IP ; cache DNS ; LB `<pending>` on-prem ; IP source perdue ; timeout LB à 60 s sur le streaming ; buffering ; 413/504 par défaut ; annotations nginx ignorées ; issuer Let's Encrypt de prod en test ; HTTP-01 sur cluster privé ; CA d'entreprise absente des pods ; `NO_PROXY` incomplet ; crawler sans anti-SSRF ; contenu généré sur un sous-domaine ; DNS orphelins ; `/metrics` routé ; `kubectl` qui timeout à cause de l'overlay.
- **13** — 401/403 confondus ; test depuis le poste seulement ; issuer au caractère près ; deux realms ; `client_secret` désynchronisé ; redirect URI interne ; horloges ; email comme identifiant stable ; mapping de groupes perdu ; comptes locaux en prod ; clé API rattachée à une personne ; révocation retardée par un cache ; rôle non rafraîchi ; ReBAC en fail-open ; jeton trop gros ; password grant laissé actif ; onglet de login périmé.
- **14** — mauvais émetteur du 429 ; quota de clé relevé au lieu de l'organisation ; compteurs en mémoire par pod ; fail-open/closed ignoré ; sémaphore fuité ; `KEYS *` ; compteur modifié à la main ; cache de configuration ; routes non gouvernées ; somme des quotas > capacité ; metering en panne silencieuse ; double comptage ; retries sans jitter.
- **15** — « on-prem » alors que le chat est déporté ; démo déportée prise pour la prod ; « compatible OpenAI » pris pour identique ; liste des modèles non recalculée ; init container bloqué par un modèle optionnel ; modèle désactivé encore utilisé par défaut ; embeddings changés sans réindexer ; `allocatable` sans GPU ; toleration oubliée ; label GPU recopié ; time-slicing en prod ; CUDA > driver ; poids dans l'image ou en `latest` ; liveness sans startup probe ; `--timeout` Helm trop court ; `shm` à 64 Mo ; `max-model-len` au maximum ; HPA sur CPU ; `maxSurge` sans GPU libre ; chiffre de débit sans test ; egress et clé fournisseur oubliés après bascule.
- **16** — asynchrone diagnostiqué par code HTTP ; config runtime du frontend ; réglage de console écrasé ; feature flag pris pour une panne ; domaine du canvas oublié ; filtrage RAG après recherche ; permissions des sources non synchronisées ; ingestion qui sature les embeddings ; fetcher headless privilégié ou sans `shm` ; intranet ouvert en levant l'anti-SSRF ; application OAuth en retard ; secret OAuth expiré ; webhooks entrants sur plateforme privée ; agent avec un compte de service ; injection de prompt indirecte + egress ouvert ; deep research hors workflow ; sandbox sans isolation ; bibliothèques absentes en air-gapped ; workers sur la mauvaise file ; workflow non déterministe ; fuseau des tâches planifiées ; prompt modifié pris pour une régression.
- **17** — HA prise pour une sauvegarde ; RPO/RTO supposés ; rollback après migration ; migration bloquée par une transaction ; voisin bruyant PostgreSQL ; « too many connections » mal attribué ; contournement du pooler ; mode transaction et prepared statements ; pooler à 1 réplica ; Redis partagé vidé ; `limits` ≤ `maxmemory` ; consommateurs non idempotents ; base du moteur de workflows pleine ; analytique non sauvegardée ; S3 sans path-style ; WAL non archivés → base arrêtée ; sauvegardes dans le même cluster ; cycle de vie incohérent ; IdP/ReBAC/workflows non sauvegardés ; « c'est sauvegardé » sans preuve ; service managé non qualifié ; données réelles en preview ; réplicas sur un même nœud ; PDB bloquant ; quorum à 2.
- **18** — qualité cherchée dans l'infra ; cardinalité ; `ServiceMonitor` ignoré ; CRDs absentes ; cAdvisor vs kube-state-metrics ; pas d'alerte d'absence ; logs non structurés ; propagation coupée par le bus ; head sampling et trace « introuvable » ; ports OTLP ; export en échec silencieux ; pile installée en doublon chez le client ; jetons et prompts dans la télémétrie ; traces de conversations trop accessibles ; mauvaise heure.

---

## Auto-évaluation express

Réponds à voix haute, sans support :

1. Les quatre plans, la question de chacun, et la règle « descendre d'un plan » avec un exemple.
2. Les cinq sauts d'une requête entrante et la commande qui vérifie chacun. À quoi sert `curl --resolve` ?
3. Trois raisons pour lesquelles une réponse en streaming est tronquée ou arrive d'un bloc.
4. Qu'est-ce qu'une SSRF, quelle est la cible numéro un, et quelles sont les quatre défenses ?
5. Le login humain échoue, l'API par clé répond : où cherches-tu, et quelles sont les trois causes les plus probables ?
6. Le piège des deux realms : symptômes et comparaison qui le révèle.
7. Cinq émetteurs possibles d'un 429, et comment les distinguer.
8. Pourquoi une route peut échapper à la gouvernance, et comment le prouver.
9. Qu'est-ce qui sort du cluster en inférence déportée ? Comment prouves-tu ce qui tourne localement ?
10. Dix choses qui changent quand on bascule un modèle de déporté à local.
11. Pourquoi un pod vLLM est en `CrashLoopBackOff` sans erreur dans ses logs ? Et `Pending` ?
12. Où se fait le filtrage des permissions dans le RAG, et pourquoi c'est là ?
13. Comment répondre à « on veut indexer notre intranet » ?
14. Six garde-fous d'une sandbox de code.
15. Quatre émetteurs de « too many connections » et comment identifier le bon.
16. Comment une panne du stockage objet peut arrêter PostgreSQL des heures plus tard ?
17. Sept raisons pour lesquelles une sauvegarde configurée n'existe pas ; la phrase honnête selon ce que tu as vérifié.
18. Quatre pièges qui donnent l'illusion de la haute disponibilité.
19. Head vs tail sampling : conséquence pour le diagnostic.
20. Du code HTTP à la cause : les cinq étapes et la phrase de constat.

Si une réponse hésite, rouvre l'étape et refais son exercice.
