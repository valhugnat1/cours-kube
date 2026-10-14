# Étape 20 — Méthode de debug

**Objectif** : à la fin de cette étape, tu pars d'un symptôme vague (« ça marche pas », « c'est lent », « j'ai une page blanche ») et tu arrives à une cause établie par une preuve, en suivant une méthode fixe plutôt que ton intuition du moment. Tu sais aussi dire honnêtement « je ne sais pas encore, voici ce que j'ai éliminé ».

**Notions couvertes** : §13 (méthode de diagnostic).

**Prérequis** : partie A (statuts de pod, endpoints), partie C (les quatre plans et le chemin d'une requête), étape 19 (k9s et la séquence « pourquoi ça rame »).

---

## 20.1 Pourquoi une méthode

Sur une plateforme de plusieurs dizaines de pods, **tout a l'air suspect**. Tu trouveras toujours un pod qui a redémarré il y a trois jours, un log `ERROR` sans conséquence, un warning TLS. Sans méthode, on suit le premier indice visible, on « corrige » quelque chose qui n'était pas cassé, et le vrai problème reste en place.

Trois biais à connaître, parce qu'ils te toucheront :

- **L'ancrage** : la première hypothèse devient la seule, et tout ce qu'on voit ensuite est lu comme une confirmation.
- **Le lampadaire** : on cherche là où c'est facile à regarder (les logs du pod qu'on connaît), pas là où est le problème.
- **La corrélation temporelle** : « ça a cassé après mon upgrade » est parfois vrai, parfois une coïncidence. C'est une hypothèse à tester, pas une conclusion.

La méthode ci-dessous sert à contrer ces trois biais.

---

## 20.2 Les cinq temps

```
1. OBJECTIVER        un code HTTP, un message exact, une heure, un utilisateur, un chemin
2. SITUER            où dans le chemin de la requête ? quel plan ? quel composant ?
3. SANTÉ DU POD      statut, READY, RESTARTS, AGE du composant situé
4. LOGS              de la BONNE instance, au BON moment, le PREMIER message d'erreur
5. DESCENDRE D'UN PLAN   si le composant est sain, la cause est dans sa dépendance
```

On boucle entre 2 et 5 jusqu'à trouver une cause **qui explique tous les symptômes observés**.

### Temps 1 — Objectiver

« Ça marche pas » ne se diagnostique pas. Avant de toucher au cluster, obtiens :

| Question | Pourquoi |
|---|---|
| Quel code HTTP exact ? | Il indique quel composant a répondu (voir 20.4) |
| Quelle URL, quelle méthode ? | Il situe la route et le composant |
| À quelle heure, avec quel fuseau ? | Il permet de chercher au bon endroit dans les logs |
| Pour qui ? Tout le monde ou un utilisateur, une organisation ? | Tout le monde = infra ; un seul = identité, quota, données |
| Depuis quand ? Qu'est-ce qui a changé ? | Déploiement, rotation de certificat, expiration de secret |
| Reproductible ? | Oui = tu peux tester tes hypothèses ; non = il faut des traces |

Si l'utilisateur ne peut pas te donner le code, obtiens-le toi-même :

```bash
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' https://chat.client.example/api/health
curl -i https://chat.client.example/api/v1/models -H "Authorization: Bearer $(cat ~/.token)"
```

Dans un navigateur : outils développeur, onglet Réseau, première requête **en rouge**, pas la dernière.

**Vérifie l'heure.** Les logs sont souvent en UTC et l'utilisateur parle en heure locale. Un décalage de 2 heures te fera lire les logs d'une période où tout allait bien.

### Temps 2 — Situer dans le chemin

Reprends le chemin de la partie C :

```
DNS → LB → gateway/Ingress (TLS) → auth → quota → service applicatif → routeur de modèles → inférence
                                                     ↘ base / cache / bus / objet
```

Le code HTTP et l'URL te placent sur ce chemin. Écris l'hypothèse de position : « la requête passe l'ingress (on a une réponse HTTP), elle est refusée avant l'application (403 avec en-tête de la gateway) ».

**L'en-tête `server` et le format du corps** trahissent qui a répondu :

- une page HTML `nginx` générique = l'ingress controller a répondu, l'app n'a jamais vu la requête ;
- un JSON avec la structure d'erreur de ton application = l'app a répondu ;
- `server: envoy`, `server: istio-envoy` = un proxy de mesh ou de gateway ;
- `server: Google Frontend`, `via: 1.1 google` = le LB GCP.

```bash
curl -sI https://chat.client.example/api/x | grep -iE '^(server|via|x-request-id|www-authenticate)'
```

### Temps 3 — Santé du pod situé

Pour le composant identifié uniquement :

```bash
kubectl get pods -n platform -l app.kubernetes.io/name=api -o wide
kubectl describe pod <pod> -n platform | sed -n '/Containers:/,/Conditions:/p;/Events:/,$p'
```

Lis, dans cet ordre : `READY` (0/1 = hors du Service), `RESTARTS` et `Last State`, `AGE` (redémarré au moment de l'incident ?), Events.

**Un pod vert n'innocente pas le composant** (il peut répondre 500 en étant Ready). **Un pod rouge n'est pas forcément la cause** (il peut être la victime d'une dépendance tombée).

### Temps 4 — Les logs de la bonne instance

Trois pièges cumulés :

1. **La mauvaise instance.** Avec 3 réplicas, la requête en échec est passée par l'un d'entre eux. L'identifiant de requête (`x-request-id`, trace ID) permet de le retrouver.
   ```bash
   kubectl logs -n platform -l app.kubernetes.io/name=api --prefix --since=30m | grep <request-id>
   ```
2. **Le mauvais moment.** `--since`, `--since-time=2026-09-17T14:02:00Z`, ou les traces (étape 18) si le pod a été recréé.
3. **Le mauvais message.** Une erreur en cascade produit 200 lignes. **La cause est la première erreur, pas la dernière.** Remonte jusqu'au premier message anormal dans la fenêtre de l'incident.

```bash
kubectl logs <pod> -n platform --since=30m --timestamps | grep -nE 'ERROR|Exception|Traceback|panic|FATAL' | head -5
kubectl logs <pod> -n platform --previous --timestamps | tail -80
```

**Lire une stack trace en remontant.** En Python, la ligne la plus utile est la **dernière** (le type d'exception et le message), puis la dernière frame **de ton code** (pas celle de la bibliothèque). En Java/Go, c'est souvent l'inverse : l'exception en haut, puis `Caused by:` qu'il faut suivre jusqu'au bout. Le **chemin du fichier source** dans la frame te dit si l'erreur vient du code produit, d'une bibliothèque, ou d'un plugin/exemple chargé par erreur.

### Temps 5 — Descendre d'un plan

Si le composant est sain et que ses logs disent « timeout vers X », « connection refused », « 401 from upstream », la cause est **en dessous** : tu refais les temps 2 à 4 sur la dépendance. C'est la règle « descendre d'un plan » de l'étape 11.

```
UI (500) → api (log: "upstream 503 from model-router")
         → model-router (log: "no healthy backend for mistral-large")
         → inference (Pending: 0/1 nodes available: insufficient nvidia.com/gpu)
         → nœud GPU (NotReady : driver)
```

La cause racine est au fond. Les quatre composants au-dessus ne sont que des messagers. Les « réparer » (redémarrer l'API, augmenter un timeout) ne change rien, ou masque le problème.

Tu t'arrêtes quand la cause trouvée **explique tous les symptômes**, et quand la corriger **ferait disparaître le symptôme initial**.

---

## 20.3 Falsifier la première hypothèse

Avant d'agir, formule ton hypothèse de manière testable et cherche **ce qui la contredirait** :

| Hypothèse | Test qui pourrait la réfuter |
|---|---|
| « C'est la base qui est lente » | Une requête qui ne touche pas la base est-elle aussi lente ? |
| « C'est mon upgrade » | Le symptôme existait-il avant ? (logs, traces, autre environnement à l'ancienne version) |
| « C'est le réseau entre deux pods » | `curl` depuis un pod de debug dans le même namespace fonctionne-t-il ? |
| « C'est le quota » | La route passe-t-elle réellement par le quota ? (table de routage réelle, étape 14) |
| « C'est un problème de certificat » | `openssl s_client` montre-t-il un certificat valide et une chaîne complète ? |
| « Ça touche tout le monde » | Un autre utilisateur, une autre organisation, reproduit-il ? |

Si le test ne réfute pas l'hypothèse, elle devient plus solide. S'il la réfute, tu as gagné du temps. Dans les deux cas, **écris ce que tu as éliminé** : c'est aussi précieux que la cause pour la personne qui reprendra le sujet.

---

## 20.4 Les codes HTTP comme carte

| Code | Qui répond typiquement | Sens | Où regarder en premier |
|---|---|---|---|
| **000 / pas de réponse** | personne | DNS, LB, firewall, TLS | `dig`, `curl -v` (où la connexion s'arrête ?) |
| **301/302 en boucle** | ingress ou app | TLS terminé en amont, l'app croit être en HTTP | `X-Forwarded-Proto`, config de l'app |
| **400** | app ou gateway | requête mal formée, en-tête trop gros | taille des cookies/JWT, `large-client-header-buffers` |
| **401** | auth / app | **non authentifié** : pas de jeton, jeton expiré, mauvais realm | `www-authenticate`, logs IdP, `iss` du JWT |
| **403** | auth / gateway / WAF | **authentifié mais refusé** : rôle, permission, IP source | logs d'autorisation, liste blanche IP, NetworkPolicy ≠ 403 |
| **404** | ingress **ou** app | aucune règle ne matche, ou ressource absente | page nginx = ingress ; JSON = app ; aussi : règle de sécurité qui masque un endpoint interne |
| **413** | ingress | corps trop gros (upload de document RAG) | `proxy-body-size` |
| **429** | quota / gateway / fournisseur de modèle | limite atteinte | compteur dans le cache KV (étape 14), en-têtes `retry-after` |
| **500** | app | exception non gérée | logs de l'app, première stack trace |
| **502** | ingress | backend joint mais réponse invalide, connexion refusée ou pod mort pendant la requête | targetPort, écoute sur 127.0.0.1, OOM pendant la requête |
| **503** | ingress / app | aucun endpoint Ready, ou app qui se déclare indisponible | `kubectl get endpoints`, readiness |
| **504** | ingress / LB | backend trop lent | timeouts à **chaque** étage (LB, ingress, app, client HTTP interne) |

Deux nuances qui piègent :

- **Le code final n'est pas toujours le code d'origine.** Une API qui reçoit un 429 du routeur de modèles peut le transformer en 500, ou pire en 200 avec un message d'erreur dans le corps. Lis le corps.
- **Les timeouts s'emboîtent.** Si le LB coupe à 30 s et l'ingress à 60 s, le client voit un 504 du LB alors que l'app aurait répondu à 45 s. Le plus court des timeouts de la chaîne gagne.

---

## 20.5 Arbres par symptôme

### A. « L'application est injoignable »

```
curl -v https://host
├─ "Could not resolve host"            → DNS : dig host ; enregistrement créé ? propagation ? DNS interne vs externe
├─ connexion qui pend / timeout         → LB ou firewall : kubectl get svc -n ingress (EXTERNAL-IP <pending> ?)
│                                          IP source autorisée ? proxy d'entreprise côté utilisateur ?
├─ "connection refused"                 → LB joint, rien n'écoute : pods de l'ingress controller Running ?
├─ erreur TLS                           → cert : openssl s_client -servername host ; SNI ; chaîne ; expiration
│                                          cert-manager : kubectl get certificate,certificaterequest,order,challenge
└─ réponse HTTP                         → ce n'est plus « injoignable » : aller à l'arbre C avec le code
```

### B. « Échec de connexion » (login)

```
Où échoue le flux ?
├─ redirection vers l'IdP qui n'arrive pas   → URL de l'IdP joignable depuis le navigateur ? redirect_uri enregistrée ?
├─ erreur affichée par l'IdP                  → logs IdP : user_not_found, invalid_client, invalid_redirect_uri
│   └─ user_not_found alors que l'utilisateur existe → piège des deux realms (étape 13)
├─ retour dans l'app puis 401                 → échange du code : secret client, horloge (JWT nbf/exp), iss attendu
├─ boucle de redirection                      → cookie non posé : SameSite, Secure en HTTP, domaine du cookie
└─ « ça marche en navigation privée »          → onglet de login périmé, cookie ancien : ce n'est pas un bug serveur
```

Diagnostic sans navigateur : obtenir un jeton en direct pour séparer « l'IdP fonctionne » de « le flux navigateur est cassé ».

```bash
curl -s -X POST "$IDP/realms/$REALM/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=$CLIENT -d username=test --data-urlencode password@- <<< "$(cat ~/.pw)" \
  | jq -r '.access_token // .error_description'
```

(Uniquement sur un compte de test et si le client autorise ce flux. Jamais le mot de passe en argument.)

### C. « Erreur d'API » (code HTTP connu)

```
Code ?
├─ 4xx  → problème de la requête ou de l'appelant : identité, droits, quota, routage
│         vérifier d'abord avec une requête minimale connue bonne (curl + jeton frais)
│         └─ la requête minimale marche → c'est la requête de l'utilisateur (payload, modèle demandé, org)
└─ 5xx  → problème du serveur
          ├─ 502/503/504 → temps 3 : santé des pods, endpoints, timeouts
          └─ 500         → temps 4 : logs, première stack trace → temps 5 : dépendance nommée dans l'erreur
```

### D. `CrashLoopBackOff`

```
kubectl logs <pod> --previous  (et -c <init> si Init:CrashLoopBackOff)
├─ logs vides                               → le binaire ne démarre pas : command/args, image, arch (exec format error)
├─ erreur de config (clé manquante, parse)  → ConfigMap/values ; variable parasite ; secret mal formé
├─ "connection refused" vers base/cache     → la dépendance est-elle Ready ? DNS du service ? NetworkPolicy ?
│                                             (le crash est ici un SYMPTÔME → descendre d'un plan)
├─ migration en échec                        → logs de l'init/Job de migration ; base à la bonne version ?
├─ Last State: OOMKilled, exit 137           → limite mémoire ; chargement de modèle trop gros
└─ exit 0 en boucle                          → le processus se termine « normalement » : pas un serveur, mauvais CMD
                                              liveness qui tue : "Liveness probe failed" dans Events
```

Codes de sortie à connaître : **1** erreur applicative, **126/127** commande non exécutable ou introuvable, **137** SIGKILL (OOM ou kill forcé), **139** segfault, **143** SIGTERM (arrêt demandé).

### E. `Pending`

```
kubectl describe pod → Events
├─ "0/N nodes are available: … Insufficient cpu/memory"   → requests trop hautes ou cluster plein (describe node)
├─ "… Insufficient nvidia.com/gpu"                          → pas de nœud GPU, device plugin absent, GPU déjà pris
├─ "… had untolerated taint"                                → tolerations manquantes (nœuds GPU, nœuds dédiés)
├─ "… didn't match Pod's node affinity/selector"            → nodeSelector sur un label inexistant chez ce client
├─ "… didn't match pod anti-affinity rules"                 → anti-affinité required > nombre de nœuds
├─ "pod has unbound immediate PersistentVolumeClaims"      → PVC Pending : StorageClass, zone, quota disque
├─ "… volume node affinity conflict"                        → PV dans une zone, nœuds disponibles dans une autre
└─ aucun Event                                              → scheduler absent/bloqué, ou priorité/ResourceQuota
                                                              kubectl get events -n <ns> ; describe resourcequota
```

Pendant une installation (étape 21), des Pending massifs pendant quelques minutes sont **normaux** (autoscaler de nœuds, PVC en création). Un Pending est inquiétant quand l'Event ne change pas.

---

## 20.6 Pièges de lecture

**Faux positifs connus.** Chaque plateforme a ses messages d'erreur qui n'en sont pas : warning « contexte non sécurisé » derrière une terminaison TLS, rafale d'erreurs base pendant un failover normal, 404 attendus sur des endpoints internes masqués (liste à l'étape 22). Avant de creuser un message, demande-toi s'il était déjà là hier.

```bash
# Le message apparaît-il aussi en dehors de la fenêtre de l'incident ?
kubectl logs <pod> --since=24h | grep -c "le message"
```

**Produit vs exemple.** Un chart ou une image peut contenir des composants de démonstration, des exemples de configuration, des comptes locaux. Une erreur venant d'un fichier `examples/`, `demo/`, `sample_` n'est pas un bug du produit : c'est une configuration de démo restée active. Le chemin du fichier dans la stack trace le révèle.

**Erreurs de décodage trompeuses.** `JSONDecodeError: Expecting value: line 1 column 1` ne signifie presque jamais « le JSON est mal formé ». Il signifie : **la réponse n'était pas du JSON** — une page HTML d'erreur d'un proxy, un corps vide d'un 502, une page de login d'un SSO d'entreprise. Réflexe : afficher le corps brut et le code avant de chercher un bug de parsing.

```bash
curl -s -i http://model-router.platform.svc:8080/v1/models | head -20
```

Même famille : `unexpected EOF`, `invalid character '<' looking for beginning of value` (Go reçoit du HTML), `certificate signed by unknown authority` sur un appel qui passe en réalité par un proxy d'inspection TLS du client.

**Le « too many connections » qui n'en est pas un.** Avec un pooler (étape 17), l'erreur peut venir du pooler (limite par utilisateur/base) et non de Postgres. Regarde quel composant émet le message.

**L'horloge.** JWT « pas encore valide » ou « expiré » alors qu'il vient d'être émis : décalage d'horloge entre nœuds ou avec l'IdP.

```bash
kubectl debug node/<n> -it --image=busybox -- date -u ; date -u
```

---

## 20.7 Agir, puis prouver

Une fois la cause identifiée :

1. **Écris la cause en une phrase avec sa preuve** avant de corriger : « `inference` est Pending car aucun nœud n'a de GPU disponible (Event `Insufficient nvidia.com/gpu`) ; le nœud GPU est NotReady depuis 13:58 (driver). »
2. **Choisis la correction au bon échelon** (étape 2) : values versionnées plutôt que `kubectl edit`. Si tu fais un correctif ponctuel pour débloquer, **dis-le** et crée la correction durable.
3. **Vérifie par le symptôme initial**, pas par le composant : le même `curl` qui renvoyait 500 renvoie maintenant 200. « Le pod est Running » ne suffit pas.
4. **Marque ce qui reste non vérifié** : « corrigé sur l'environnement de preview, non testé en prod », « cause plausible, non reproduite ».

---

## 20.8 Le compte rendu de diagnostic

À écrire pendant, pas après. Même court, il sert à toi dans 30 minutes, à un collègue, et au client.

```markdown
## Incident — <titre factuel> — 2026-09-17 14:02 UTC

**Symptôme** : POST /api/v1/chat/completions → 500 pour toutes les organisations depuis ~14:00 UTC.
**Chemin** : ingress OK (réponse JSON de l'app) → api → model-router → inference.
**Constaté** :
- api : log `upstream 503 from model-router` (request-id 7f3a…), 14:01:12
- model-router : `no healthy backend for mistral-small`
- inference-small-0 : Pending, Event `0/3 nodes available: 3 Insufficient nvidia.com/gpu`
- nœud gpu-pool-1 : NotReady depuis 13:58, kubelet : `nvidia driver not loaded`
**Éliminé** : quota (routes hors quota touchées aussi), certificat (valide jusqu'au 2026-12-01), base (requêtes sans base en échec aussi).
**Cause** : nœud GPU NotReady (driver) → pas de backend d'inférence.
**Action** : cordon + remplacement du nœud par le client (hors responsabilité du chart).
**Vérification** : même requête → 200 à 14:41 UTC.
**Non vérifié** : pourquoi le driver n'a pas chargé (côté client).
```

---

## 20.9 Aide-mémoire

```
1 OBJECTIVER     code HTTP · URL · heure UTC · qui · depuis quand · reproductible ?
2 SITUER         en-tête server/via · HTML vs JSON · plan (edge/identité/app/données)
3 SANTÉ          READY · RESTARTS + Last State · AGE · Events
4 LOGS           bonne instance (request-id) · bonne fenêtre · PREMIÈRE erreur · --previous
5 DESCENDRE      l'erreur nomme une dépendance → recommencer 2-4 dessus
ENSUITE          falsifier · écrire cause + preuve · corriger au bon échelon · re-tester le symptôme initial
```

---

## 20.10 Exercice — à faire clavier en main

Sur le cluster kind `lab`, avec le parapluie déployé. Le principe : **quelqu'un d'autre casse, toi tu diagnostiques depuis le symptôme applicatif uniquement**. Si tu es seul, écris les pannes dans un script, lance-en une au hasard sans regarder laquelle.

**Préparation** : un script de pannes sur les composants du plan de données de ton parapluie. Adapte les noms aux tiens.

```bash
#!/usr/bin/env bash
# break.sh — tire une panne au hasard, n'affiche rien
set -euo pipefail
NS=platform
case $((RANDOM % 5)) in
  0) kubectl -n $NS scale sts/cache --replicas=0 ;;                                     # cache coupé
  1) kubectl -n $NS set env deploy/api DATABASE_HOST=postgres-nope ;;                   # mauvaise config
  2) kubectl -n $NS patch deploy/api -p '{"spec":{"template":{"spec":{"containers":[{"name":"api","resources":{"limits":{"memory":"32Mi"}}}]}}}}' ;;  # OOM
  3) kubectl -n $NS apply -f - <<'EOF'                                                  # NetworkPolicy qui isole la base
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: deny-db }
spec: { podSelector: { matchLabels: { app.kubernetes.io/name: postgres } }, policyTypes: [Ingress] }
EOF
  ;;
  4) kubectl -n $NS patch deploy/api --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/nope"}]' ;;
esac
echo "$(date -u +%H:%M:%S) panne injectée"
```

Note pour la panne 3 : `kindnet` (CNI par défaut de kind) **n'applique pas** les NetworkPolicy. Soit tu recrées le cluster avec Calico/Cilium, soit tu constates que cette panne ne produit aucun symptôme. C'est d'ailleurs un bon rappel de l'étape 4.

**Déroulé**, cinq fois (une par panne) :

1. Lance `./break.sh`. Attends 2 minutes.
2. Démarre un chronomètre et un fichier `diag-N.md` avec le modèle 20.8.
3. **Seul point d'entrée autorisé** : `curl` sur l'URL publique de l'application (via port-forward de l'ingress si pas de LB). Pas de k9s, pas de `get pods -A` avant d'avoir un code HTTP et une hypothèse de position.
4. Déroule les cinq temps. Remplis « Constaté » et « Éliminé » au fur et à mesure.
5. Écris la cause en une phrase **avant** de corriger.
6. Corrige (ici, `helm upgrade` avec tes values pour revenir à l'état versionné : c'est le bon échelon), puis rejoue le `curl` initial.
7. Note le temps, et le moment où tu t'es trompé de piste.

**Bonus** : refais une panne en te forçant à **réfuter** ta première hypothèse avant de continuer (20.3). Compare le temps.

**Nettoyage** :

```bash
kubectl -n platform delete networkpolicy deny-db --ignore-not-found
helm upgrade platform ./platform -n platform -f <ta pile de values>
```

---

## Validé si…

Tu peux, sans support :

- réciter les cinq temps et dire à quoi sert chacun ;
- distinguer 401 et 403, 502, 503 et 504 en une phrase chacun, avec le premier endroit où regarder ;
- expliquer pourquoi la première erreur d'un log compte plus que la dernière ;
- expliquer ce que signifie réellement `JSONDecodeError: Expecting value: line 1 column 1` ;
- dérouler l'arbre `Pending` et l'arbre `CrashLoopBackOff` de mémoire ;
- donner un exemple où un pod en `CrashLoopBackOff` n'est pas la cause du problème ;
- diagnostiquer les pannes de l'exercice depuis le seul `curl`, avec un compte rendu qui contient une ligne « Éliminé ».

**Étape suivante** : `etape-21-environnements-ephemeres.md` — environnements éphémères.
