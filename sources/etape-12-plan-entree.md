# Étape 12 — Plan d'entrée

**Objectif** : à la fin de cette étape, tu sais suivre une requête depuis le nom de domaine tapé par l'utilisateur jusqu'au conteneur qui la traite, dire à chaque saut ce qui peut casser et avec quel symptôme, et tu connais l'autre sens du trafic : ce qui **sort** du cluster. Tu sais aussi quelles portes ne doivent jamais être ouvertes.

**Notions couvertes** : §4 (DNS, load balancer, gateway/Ingress, TLS, routage, certificats, restriction d'accès, accès au control plane, egress, isolation du contenu généré, durcissement).

**Prérequis** : étape 4 (Services, Ingress, CoreDNS), étape 9 (cert-manager), étape 11 (la carte).

---

## 12.1 La chaîne d'entrée, saut par saut

```
utilisateur tape https://chat.client.com/api/v1/chat
 │
 ① DNS           chat.client.com → 203.0.113.10          (résolveur public ou DNS d'entreprise)
 │
 ② Load balancer 203.0.113.10:443 → nœuds / pods du controller   (L4 ou L7, cloud ou MetalLB/F5)
 │
 ③ Gateway       ingress controller / Gateway API            (nginx, Envoy, Traefik, gce, Route OpenShift)
 │   ├─ TLS      terminaison : certificat choisi par SNI
 │   └─ routage  host = chat.client.com, path = /api → Service api:8080
 │
 ④ Service       ClusterIP → endpoints Ready (kube-proxy / eBPF)
 │
 ⑤ Pod           conteneur qui écoute sur 0.0.0.0:8080
```

Chaque saut a **une** responsabilité et **une** famille de pannes. Le diagnostic consiste à trouver le premier saut qui ne fait pas son travail.

| Saut | Question | Commande de vérification | Symptôme s'il casse |
|---|---|---|---|
| ① DNS | Le nom résout-il vers la bonne IP ? | `dig +short chat.client.com` | `Could not resolve host`, ou IP d'un ancien environnement |
| ② LB | L'IP accepte-t-elle la connexion ? | `nc -vz 203.0.113.10 443`, `kubectl get svc -n ingress` | Timeout (rien ne répond) |
| ③ TLS | Le bon certificat est-il servi, valide, chaîne complète ? | `openssl s_client -connect IP:443 -servername chat.client.com` | Erreur de certificat, `unknown authority`, cert par défaut « Fake Certificate » |
| ③ Routage | Une règle matche-t-elle host + path ? | `kubectl get ingress -A`, logs du controller | 404 servi par le controller |
| ④ Service | Y a-t-il des endpoints Ready ? | `kubectl get endpoints api` | 503 |
| ⑤ Pod | Le pod accepte-t-il et répond-il à temps ? | `kubectl port-forward` + `curl` | 502 (refus), 504 (lenteur) |

Deux distinctions à maîtriser :

- **Timeout vs refus.** Un timeout (la connexion pend) = rien n'écoute, ou un pare-feu *jette* les paquets : c'est ① ou ②, ou un réseau client. Un refus immédiat (`Connection refused`) = une machine a répondu « pas ici » : tu es arrivé quelque part.
- **Qui a répondu ?** Une 404 peut venir du controller (aucune règle) ou de l'application (route inconnue). Regarde l'en-tête `server:` et le corps : page HTML générique de nginx vs JSON de l'API. On y revient à l'étape 20.

---

## 12.2 DNS : automatique, et ses fantômes

Chez un client, deux modes :

**DNS manuel.** Le client crée l'enregistrement dans son DNS d'entreprise. Tu fournis la liste des hosts et l'IP (ou le nom) du LB. Piège : un host oublié dans la liste (le domaine du contenu généré, celui de la console admin, celui des callbacks OAuth). Réflexe : extraire la liste du rendu plutôt que de mémoire :

```bash
helm get manifest platform -n platform | yq -N 'select(.kind=="Ingress") | .spec.rules[].host' | sort -u
```

**DNS automatique (`external-dns`).** Un contrôleur lit les Ingress/Services/Gateway et crée les enregistrements dans le fournisseur DNS (Cloud DNS, Route53, …). Ce qu'il faut savoir :

- Il a besoin d'une **identité cloud** avec des droits sur la zone (Workload Identity sur GKE). Un DNS qui n'apparaît pas = regarder ses logs d'abord (`permission denied`, zone non trouvée, `domainFilters` trop restrictif).
- Il pose des **enregistrements TXT de propriété** (`txtOwnerId`) pour ne supprimer que ce qu'il a créé. Deux environnements avec le même `txtOwnerId` dans la même zone se volent leurs enregistrements.
- **Enregistrements orphelins** : si le cluster est détruit avant que `external-dns` ait vu la suppression des Ingress (ou si sa `policy` est `upsert-only`), les enregistrements restent. Un nom qui pointe vers une IP libérée peut être **réattribuée à quelqu'un d'autre** chez le fournisseur cloud : c'est une vulnérabilité (subdomain takeover), pas juste du désordre. Réflexe à la destruction d'un environnement (étape 21) : supprimer les releases *avant* le cluster, puis vérifier la zone.

**TTL.** Un changement DNS n'est pas instantané. `dig` interroge ton résolveur, qui peut avoir un cache. Pour contourner pendant un diagnostic :

```bash
dig +short chat.client.com @8.8.8.8                 # résolveur public
dig +short chat.client.com @<serveur autoritaire>   # la vérité
curl --resolve chat.client.com:443:203.0.113.10 https://chat.client.com/   # court-circuite le DNS
```

`curl --resolve` est l'outil clé : il permet de tester toute la chaîne ②→⑤ **avec le bon SNI et le bon Host**, sans attendre la propagation DNS. Si ça marche avec `--resolve` et pas sans, le problème est ①, et seulement ①.

---

## 12.3 Load balancer

Rappel étape 10 : le LB est **sous la frontière de responsabilité**. Le chart crée un Service `type: LoadBalancer` ; c'est l'infrastructure qui le matérialise.

- **Cloud** : une IP apparaît dans `EXTERNAL-IP` en une à quelques minutes. Interne ou externe selon une annotation.
- **On-prem** : sans MetalLB, kube-vip, ou un F5/NSX intégré, `EXTERNAL-IP` reste `<pending>` pour toujours, sans erreur. Alternatives : `NodePort` derrière le LB matériel du client, ou `hostNetwork` sur le controller.

Points qui piègent :

- **IP source.** Par défaut, un LB L4 + `externalTrafficPolicy: Cluster` fait un rebond via un nœud, et le pod voit l'IP du nœud, pas celle du client. Conséquence : la restriction par IP (12.5) et les logs d'audit sont faux. Solutions : `externalTrafficPolicy: Local` (préserve l'IP, mais seuls les nœuds hébergeant un pod du controller reçoivent du trafic), ou le **PROXY protocol** / `X-Forwarded-For` si le LB est L7 ou le supporte — à activer **des deux côtés**, sinon tout casse (le controller lit des octets de protocole comme du HTTP).
- **Health checks** du LB : sur `externalTrafficPolicy: Local`, les nœuds sans pod controller sont marqués *unhealthy*. C'est normal.
- **Timeouts d'inactivité** : beaucoup de LB coupent une connexion inactive au bout de 60 s. Une réponse LLM en streaming qui met du temps à produire son premier token, ou une WebSocket sans ping, se fait couper **par le LB**, pas par l'app. Symptôme : réponse tronquée de façon régulière, à durée fixe. Chercher ce chiffre dans la config du LB avant d'accuser le modèle.

---

## 12.4 Gateway : TLS et routage

### Terminaison TLS

Trois architectures possibles, à identifier dès l'arrivée :

| Où s'arrête le TLS | Qui détient le certificat | Conséquence |
|---|---|---|
| Au LB (L7 cloud, F5, WAF) | Le client / le LB | Le controller reçoit du HTTP ; il faut lui faire confiance pour `X-Forwarded-Proto`, sinon redirections en boucle ou URL générées en `http://` |
| À l'ingress controller | Un Secret TLS dans le cluster | Cas le plus courant ; cert-manager ou certificat fourni |
| De bout en bout / mTLS jusqu'au pod | Chaque service ou un mesh | Rare hors mesh ; plus de certificats à gérer |

Derrière la terminaison, les pods se parlent souvent en HTTP. D'où les avertissements « contexte non sécurisé » ou cookies `Secure` qui ne se posent pas si l'app ne sait pas qu'elle est derrière un proxy HTTPS (étape 22).

**Le symptôme « Kubernetes Ingress Controller Fake Certificate »** : nginx sert son certificat par défaut parce qu'aucun Secret TLS ne correspond au SNI demandé. Causes : Secret absent, dans le mauvais namespace, pas encore émis par cert-manager, ou host mal orthographié dans `tls.hosts`.

**SNI** : sur une même IP, le controller choisit le certificat d'après le nom demandé dans le handshake. Tester avec l'IP nue (`curl https://203.0.113.10`) donne toujours le mauvais certificat : utilise `--resolve` ou `-servername`.

### Routage host + path

- Le **host** est la clé principale ; ensuite le **path** (`Prefix` vs `Exact` ; le plus long gagne en général, mais le comportement exact dépend du controller — le vérifier plutôt que le supposer).
- **Réécriture de chemin** (`rewrite-target` sur nginx, filtres `URLRewrite` en Gateway API) : l'app reçoit-elle `/api/v1/chat` ou `/v1/chat` ? Une 404 *applicative* juste après une migration de controller vient souvent de là.
- **Annotations spécifiques au controller** : timeouts, taille max de body, buffering. Pour une plateforme LLM, trois réglages comptent presque toujours :
  - **taille de body** (uploads de documents RAG) — nginx refuse par défaut au-delà de 1 Mo avec une **413** ;
  - **timeouts de lecture** (générations longues) — **504** au bout de 60 s par défaut ;
  - **buffering désactivé** pour le streaming (SSE) — sinon l'utilisateur reçoit toute la réponse d'un bloc à la fin, ce qui ressemble à « c'est lent ».
- Ces annotations **ne sont pas portables** : passées sur une Route OpenShift ou un Ingress `gce`, elles sont ignorées sans erreur (étape 10).

**Gateway API** (`Gateway`, `HTTPRoute`) remplace progressivement Ingress : même logique, mais séparation des rôles (l'infra possède la `Gateway`, l'app ses `HTTPRoute`) et plus de fonctionnalités standard sans annotations. Vérifie `status.parents[].conditions` d'une `HTTPRoute` : `Accepted: False` explique pourquoi elle est inerte.

---

## 12.5 Certificats : ACME, EAB, et alternatives

**ACME** (Let's Encrypt, ZeroSSL, CA d'entreprise compatible) : cert-manager prouve que tu contrôles le domaine, la CA signe.

| Challenge | Principe | Quand ça ne marche pas |
|---|---|---|
| **HTTP-01** | La CA appelle `http://host/.well-known/acme-challenge/…` | Cluster non joignable depuis internet (privé, restriction IP, air-gapped), port 80 fermé, redirection HTTPS forcée qui casse le challenge |
| **DNS-01** | cert-manager crée un TXT dans la zone | Pas de droits sur la zone ; seul choix pour un **wildcard** ou un cluster privé |

**EAB (External Account Binding)** : certaines CA ACME (commerciales, ou CA d'entreprise) exigent qu'on lie le compte ACME à un compte existant via un identifiant et une clé HMAC. Dans cert-manager, c'est un bloc `externalAccountBinding` dans l'`Issuer`, dont la clé est dans un **Secret** (jamais dans les values en clair).

Diagnostic cert-manager, dans l'ordre des objets qu'il crée :

```bash
kubectl get certificate -A                       # READY False ?
kubectl describe certificate <nom> -n <ns>       # événements
kubectl get certificaterequest,order,challenge -A
kubectl describe challenge <nom> -n <ns>         # la raison concrète : DNS, HTTP 404, timeout…
kubectl logs -n cert-manager deploy/cert-manager
```

La chaîne `Certificate → CertificateRequest → Order → Challenge` : le premier objet en échec porte le message utile.

Pièges :

- **Rate limits** de Let's Encrypt : réinstaller dix fois un environnement de test avec l'issuer de production bloque le domaine pour une semaine. Utilise l'issuer *staging* pour les tests.
- **Certificat fourni par le client** (CA interne) : pas de cert-manager, un Secret `kubernetes.io/tls` créé par eux. Demande **la chaîne complète** (feuille + intermédiaires), et **la date d'expiration** — personne ne la surveille, et dans un an c'est ton téléphone qui sonne.
- **CA interne non reconnue par les pods** : le navigateur de l'utilisateur fait confiance à la CA de l'entreprise, mais un pod qui appelle un autre host de la plateforme *par son URL publique* (callback OIDC, par exemple) échoue en `x509: certificate signed by unknown authority`. Il faut monter le bundle CA dans les pods concernés (étape 13).

---

## 12.6 Restreindre l'accès : IP source et accès au control plane

### Restriction par IP source

Beaucoup de clients veulent une plateforme joignable uniquement depuis leurs réseaux. Trois endroits possibles, du plus en amont au plus en aval :

1. **Pare-feu / règles du LB** (`loadBalancerSourceRanges`, Cloud Armor, security groups) — le plus robuste, le trafic interdit n'atteint jamais le cluster.
2. **Ingress controller** (annotation `whitelist-source-range` / `allowlist`) — dépend de l'IP source réelle (12.3) ; si le controller voit l'IP du nœud, soit tout passe, soit rien.
3. **Application** — dernier recours.

Pièges :

- Oublier les **plages qui doivent passer** : la CA pour HTTP-01, les callbacks de l'IdP du client s'ils viennent d'un SaaS, les webhooks de connecteurs externes, les sondes de monitoring.
- Restreindre par IP **ne remplace pas** l'authentification.

### Accès au control plane

L'API server du cluster (celui que `kubectl` appelle) ne doit **pas** être exposé publiquement en production. Configurations courantes :

- **Cluster privé** (GKE private endpoint) + accès via un bastion, un VPN, ou un réseau **overlay** (Tailscale/WireGuard, Cloudflare Tunnel, Teleport).
- **Authorized networks** : endpoint public restreint à quelques IP.

Conséquences pour toi :

- Ton `kubectl` passe par l'overlay : s'il ne répond pas, **vérifie l'overlay avant le cluster** (`tailscale status`, route vers l'IP du control plane). Un timeout sur `kubectl get pods` n'est presque jamais une panne du cluster.
- Les outils qui tournent **ailleurs** (CI, ArgoCD externe) ont besoin du même chemin.
- Pendant une intervention client, tu travailles souvent **depuis leur bastion**, avec leurs versions d'outils : retour aux pièges d'environnement de l'étape 0.

---

## 12.7 L'autre sens : l'egress

Tout ce qui **sort** du cluster est aussi important que ce qui entre, pour deux raisons : la fonctionnalité (beaucoup de composants appellent l'extérieur) et la sécurité (une plateforme LLM est une machine à faire des requêtes pour le compte d'utilisateurs).

### Qui sort, et vers où

| Composant | Destination |
|---|---|
| Inférence déportée | API du fournisseur de modèles |
| Crawler / fetcher (RAG, recherche web) | **N'importe quelle URL fournie par un utilisateur** |
| Connecteurs | APIs SaaS (Drive, SharePoint, Jira…) |
| Identité | IdP du client (discovery OIDC, JWKS) |
| cert-manager | CA ACME ; API DNS |
| external-dns | API DNS du fournisseur |
| Pull d'images | Registre (sauf miroir interne) |
| Observabilité | Endpoint OTLP du client |

Cette table est aussi celle que tu donnes au client pour ouvrir son pare-feu. Vérifie-la sur l'installation réelle, ne la recopie pas d'un autre client.

### Proxy egress obligatoire

En environnement d'entreprise, la sortie passe souvent par un **proxy HTTP(S)** imposé. Conséquences :

- Chaque composant qui sort doit connaître `HTTP_PROXY` / `HTTPS_PROXY`… et surtout **`NO_PROXY`**, qui doit contenir : `localhost`, `127.0.0.1`, le domaine du cluster (`.svc`, `.cluster.local`), **les CIDR pods et services**, l'IP du control plane, les domaines internes du client. Un `NO_PROXY` incomplet envoie les appels **internes** au proxy, qui les refuse → erreurs de connexion entre services, très déroutantes (piège étape 4).
- Les bibliothèques ne lisent pas `NO_PROXY` de la même manière (majuscules/minuscules, support des CIDR, du `.` initial). Tester depuis le pod, avec le vrai client HTTP de l'application si possible.
- Proxy qui **inspecte le TLS** (MITM d'entreprise) : il re-signe les certificats avec la CA de l'entreprise → `x509` dans les pods jusqu'à ce que cette CA soit montée.

```bash
kubectl run -it --rm egress-test --image=nicolaka/netshoot -n platform -- sh
  env | grep -i proxy
  curl -sv https://api.fournisseur.example/ -o /dev/null 2>&1 | grep -E 'Connected|issuer|HTTP/'
  curl -s -o /dev/null -w '%{http_code}\n' http://api.platform.svc.cluster.local:8080/health
```

### Anti-SSRF

**SSRF** (Server-Side Request Forgery) : un utilisateur fait appeler par le serveur une URL qu'il ne pourrait pas joindre lui-même. Sur une plateforme LLM, les points d'entrée sont nombreux : « résume cette page », crawler, import par URL, outil web d'un agent, webhook configurable, et même le modèle qui génère une URL à appeler.

Cibles typiques d'un attaquant :

- **Services internes du cluster** : `http://postgres.data.svc:5432`, API d'admin, métriques, API server Kubernetes.
- **Metadata service du cloud** : `http://169.254.169.254/` (et `metadata.google.internal`) — renvoie des **jetons d'identité cloud** du nœud ou du pod. C'est la cible numéro un.
- **Réseau interne du client** : `10.x`, `172.16.x`, `192.168.x`, intranet.

Défenses, en profondeur :

1. **Le crawler/fetcher sort par un proxy egress dédié** qui :
   - bloque les **plages privées et spéciales** : `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `100.64.0.0/10`, `::1`, `fc00::/7`, `fe80::/10` ;
   - n'autorise qu'une **liste blanche de ports** (80, 443) ;
   - vérifie l'IP **après résolution DNS**, à chaque connexion (sinon *DNS rebinding* : le nom résout vers une IP publique au contrôle puis vers `127.0.0.1` à la connexion) ;
   - suit les **redirections** en revérifiant chaque saut (`https://site-malveillant/` → `302 http://169.254.169.254/`).
2. **NetworkPolicy** : les pods de fetch n'ont le droit de parler qu'au proxy egress (et au DNS). Rappel : seulement si le CNI les applique.
3. **Metadata service bloqué ou filtré** : Workload Identity sur GKE masque le metadata du nœud ; ailleurs, NetworkPolicy qui refuse `169.254.169.254/32`.
4. Les composants qui appellent des URL utilisateurs **ne portent pas** d'identité cloud privilégiée.

Test minimal à faire depuis un pod de fetch (sur un environnement de test) :

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://169.254.169.254/        # doit échouer
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://kubernetes.default.svc/  # doit échouer
curl -s -m 5 -o /dev/null -w '%{http_code}\n' https://example.com/            # doit passer
```

Et le vrai test : demander à la **fonctionnalité produit** (import par URL) de récupérer `http://169.254.169.254/…`. C'est ce que fera un auditeur.

---

## 12.8 Isoler le contenu généré : un domaine parent distinct

Une plateforme LLM affiche du contenu **généré ou fourni par des utilisateurs** et parfois **exécutable** : HTML/JS produit par le modèle (canvas, artefacts, aperçus), fichiers uploadés, rendus de code.

Le problème : le navigateur applique la **same-origin policy** et les cookies selon le domaine. Si ce contenu est servi depuis `chat.client.com` ou même `canvas.chat.client.com` :

- un script généré s'exécute dans l'origine de l'application et peut appeler l'API **avec la session de l'utilisateur** ;
- les cookies posés pour `.chat.client.com` (ou `.client.com`) sont **envoyés au sous-domaine** et parfois lisibles.

La défense : servir le contenu non fiable depuis un **domaine parent différent**, enregistré séparément (ex. `client-usercontent.com`, pas un sous-domaine de `client.com`). C'est ce que font les grands hébergeurs de contenu utilisateur. Plus, en complément : iframe `sandbox`, en-têtes CSP stricts, pas de cookies de session sur ce domaine.

Conséquences opérationnelles, souvent découvertes trop tard :

- un **host de plus** dans l'Ingress, le DNS, le certificat, la restriction IP ;
- chez un client, **acheter/obtenir un deuxième domaine** peut prendre des semaines : à demander dès le cadrage ;
- si le client impose un sous-domaine faute de mieux, c'est un **écart de sécurité à documenter**, pas un détail de configuration.

---

## 12.9 Durcir la gateway

Ce qui ne doit **pas** être joignable depuis l'extérieur, et qui l'est souvent par accident :

| Exposition accidentelle | Pourquoi c'est grave | Correctif |
|---|---|---|
| `/metrics` (Prometheus) des apps ou du controller | Noms internes, versions, volumétrie, parfois labels avec des identifiants | Port séparé non routé par l'Ingress ; ou règle de refus sur le path |
| Endpoints d'admin / debug (`/admin`, `/debug/pprof`, actuators) | Contrôle ou fuite mémoire | Non exposés ; ingress distinct restreint |
| Console de l'IdP (`/admin` de Keycloak…) | Prise de contrôle des identités | Host séparé réservé au réseau d'admin |
| Tableau de bord d'un composant de données (UI de bus, de workflows, de base analytique) | Lecture/écriture des données | Jamais d'Ingress ; `port-forward` pour l'usage ponctuel |
| Page de statut du controller, `server-snippet` autorisés | Injection de config nginx | Désactiver les snippets (`allow-snippet-annotations: false`) |
| En-tête `server:` avec version | Aide à cibler une CVE | Masquer la version |

Autres réglages de base :

- redirection HTTP → HTTPS (en préservant le challenge HTTP-01 si utilisé) ;
- **HSTS** une fois le TLS stable (attention, c'est collant pour les navigateurs) ;
- TLS 1.2 minimum ;
- limites de taille et de débit cohérentes avec 12.4 : on veut 50 Mo pour un upload de document, pas pour toutes les routes ;
- une règle claire : **un Ingress = une exposition délibérée**. `kubectl get ingress -A` doit être une liste que tu peux justifier ligne par ligne.

Audit rapide :

```bash
kubectl get ingress,httproute -A -o wide
for h in $(kubectl get ingress -A -o jsonpath='{.items[*].spec.rules[*].host}'); do
  for p in /metrics /admin /debug/pprof/ /actuator /healthz; do
    printf '%-40s %-15s %s\n' "$h" "$p" "$(curl -sk -m 5 -o /dev/null -w '%{http_code}' https://$h$p)"
  done
done
```

Un `200` sur `/metrics` ou `/admin` depuis l'extérieur = à corriger. Un `401/403` = mieux, mais la question « pourquoi est-ce routé ? » reste valable.

---

## 12.10 Pièges

- **Tester avec l'IP** au lieu du nom → mauvais certificat, mauvaise règle ; utiliser `--resolve`.
- **Diagnostiquer avec un cache DNS** : le changement est fait, ton poste ne le voit pas.
- **LB `<pending>`** on-prem pris pour un problème du chart.
- **IP source perdue** : la restriction IP laisse tout passer ou bloque tout.
- **Timeout du LB à 60 s** qui tronque les réponses en streaming, attribué au modèle.
- **Buffering du proxy** qui transforme le streaming en « tout d'un coup à la fin ».
- **413** sur l'upload d'un gros document, **504** sur une génération longue : annotations par défaut du controller.
- **Annotations nginx** sur un controller qui n'est pas nginx : ignorées en silence.
- **Issuer de production Let's Encrypt** en test : rate limit sur le domaine.
- **HTTP-01 sur un cluster privé** : ne peut pas marcher, passer en DNS-01 ou certificat fourni.
- **Certificat fourni sans date d'expiration notée.**
- **CA d'entreprise non montée** dans les pods qui appellent des URL publiques de la plateforme ou passent par un proxy MITM.
- **`NO_PROXY` sans les CIDR du cluster.**
- **Crawler sans proxy anti-SSRF** qui atteint le metadata service.
- **Contenu généré servi sur un sous-domaine** de l'application.
- **Enregistrements DNS orphelins** après destruction d'un environnement.
- **`/metrics` routé publiquement** par un Ingress en `Prefix: /`.
- **`kubectl` qui timeout** : c'est l'overlay/VPN, pas le cluster, neuf fois sur dix.

---

## 12.11 Exercice — suivre sa propre requête du DNS jusqu'au pod

Sur ton cluster kind (partie 1) puis sur un environnement de preview (partie 2).

### Partie 1 — Monter la chaîne sur kind

1. Installe un ingress controller nginx adapté à kind et cert-manager.
2. Déploie ton chart de l'étape 7 avec un Ingress sur `app.lab.local`, TLS via un `ClusterIssuer` auto-signé (`selfSigned` → CA → `ca` issuer).
3. Sans toucher à `/etc/hosts`, fais répondre l'app :
   ```bash
   curl -v --resolve app.lab.local:443:127.0.0.1 --cacert ca.crt https://app.lab.local/
   ```
   (extrais `ca.crt` du Secret de la CA **sans l'afficher dans le terminal** : redirection vers un fichier.)
4. Ajoute une route `/stream` servie par un petit endpoint qui envoie un événement toutes les 2 s pendant 90 s (SSE). Observe :
   - la coupure à 60 s (timeout par défaut) → corrige par annotation ;
   - la réponse qui arrive d'un bloc → désactive le buffering.
5. Uploade un fichier de 5 Mo → observe la 413 → corrige.

### Partie 2 — Casser un saut à la fois

Pour chaque panne, note **la commande qui la révèle** et **le message exact** :

| Panne à provoquer | Saut |
|---|---|
| Mauvaise IP dans `--resolve` | ① |
| Service du controller supprimé/scalé à 0 (en désactivant ce qui le recrée) | ② |
| `tls.hosts` avec une faute de frappe | ③ TLS |
| `ingressClassName` inexistant | ③ routage |
| Selector du Service faux | ④ |
| App qui écoute sur `127.0.0.1` | ⑤ (502) |
| App qui dort 120 s avant de répondre | ⑤ (504) |

### Partie 3 — Egress et SSRF

1. Depuis un pod de test, vérifie : DNS interne, un Service interne, `https://example.com`, `http://169.254.169.254/`.
2. Applique une NetworkPolicy qui n'autorise ce pod qu'à sortir sur 443 vers l'extérieur et refuse les plages privées et `169.254.0.0/16`. Rappel : **kindnet n'applique pas les NetworkPolicy** — recrée un cluster kind avec Calico ou Cilium, sinon ton test « réussit » sans rien prouver.
3. Refais les tests. Écris ce qui est bloqué et **par quoi** (timeout = paquet jeté par la policy).

### Partie 4 — Sur l'environnement de preview (lecture seule)

1. Prends une URL réelle de la plateforme. Parcours les cinq sauts avec les commandes de 12.1 et écris la réponse de chacun : IP, type de LB, controller, certificat (émetteur, expiration), règle qui matche, Service, pod qui a servi la requête (retrouve ta requête dans ses logs).
2. Liste tous les hosts exposés et justifie chacun. Lance l'audit de 12.9.
3. Identifie : quel composant fait les appels sortants vers des URL utilisateurs ? Passe-t-il par un proxy ? Où est configuré `NO_PROXY` ?
4. Le contenu généré est-il servi sur un domaine parent distinct ?

**Livrable** : ajoute à `carte-plateforme-<version>.md` une section « Plan d'entrée » : hosts, controller, terminaison TLS, émetteur de certificats, restriction IP, chemin d'accès au control plane, table egress, domaine du contenu généré, et les écarts relevés.

---

## Validé si…

Tu peux expliquer à voix haute :

- les cinq sauts d'une requête entrante et la commande qui vérifie chacun ;
- la différence entre un timeout et un refus, et entre une 404 du controller et une 404 de l'app ;
- pourquoi `curl --resolve` isole un problème DNS ;
- trois raisons pour lesquelles une réponse en streaming arrive tronquée ou d'un bloc ;
- quand HTTP-01 ne peut pas fonctionner, et ce qu'est EAB ;
- pourquoi la restriction par IP peut laisser tout passer ;
- ce qu'est une SSRF, pourquoi `169.254.169.254` est la cible numéro un, et les quatre défenses ;
- ce que doit contenir `NO_PROXY` ;
- pourquoi le contenu généré doit vivre sur un domaine parent distinct, et pourquoi ça se demande dès le cadrage ;
- trois choses qui ne doivent jamais être routées depuis l'extérieur.

**Étape suivante** : `etape-13-identite-authentification-autorisation.md` — identité, authentification, autorisation.
