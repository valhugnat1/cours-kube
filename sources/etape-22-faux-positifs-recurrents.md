# Étape 22 — Faux positifs récurrents

**Objectif** : à la fin de cette étape, tu sais trier un log de plateforme entre le bruit normal et l'erreur réelle, tu connais les faux positifs classiques d'une plateforme LLM, et tu as commencé **ta propre liste** — celle qui t'évitera de perdre 40 minutes sur un message rouge qui était déjà là la semaine dernière.

**Notions couvertes** : §18 (faux positifs récurrents, bruit normal).

**Prérequis** : partie C (les quatre plans), étape 20 (méthode de debug), étape 21 (composants légitimement en erreur).

---

## 22.1 Pourquoi ça compte vraiment

Une plateforme de plusieurs dizaines de pods produit en permanence des messages `WARN` et `ERROR` qui n'indiquent aucun problème. Si tu ne sais pas les reconnaître, trois choses arrivent :

1. **Tu perds du temps** à diagnostiquer un composant qui va bien, pendant que le vrai problème continue.
2. **Tu perds en crédibilité** devant un client : annoncer « j'ai trouvé une erreur grave dans vos logs » sur un message présent depuis l'installation, c'est l'aveu qu'on ne connaît pas le produit.
3. **Tu rates les vraies erreurs**, noyées dans un flot que tu as appris à ignorer en bloc — le symétrique du premier travers, et le plus dangereux.

L'objectif n'est donc pas d'ignorer les erreurs. C'est de **savoir lesquelles sont attendues, et pourquoi** — la nuance étant que « je sais pourquoi ce message apparaît » est une connaissance, alors que « je l'ignore d'habitude » n'en est pas une.

---

## 22.2 Le test en trois questions

Devant un message rouge, avant de creuser :

| Question | Comment y répondre | Ce que ça veut dire |
|---|---|---|
| **1. Était-il déjà là avant l'incident ?** | `kubectl logs <pod> --since=24h \| grep -c "<motif>"` | Présent en continu = bruit de fond, pas la cause |
| **2. Y a-t-il une conséquence observable ?** | Le pod a-t-il redémarré ? Une requête a-t-elle échoué ? Un compteur a-t-il bougé ? | Un `ERROR` sans conséquence est un problème de niveau de log, pas un incident |
| **3. Est-il corrélé dans le temps au symptôme ?** | Comparer l'horodatage avec l'heure objectivée à l'étape 20 | Même minute = piste ; plusieurs heures d'écart = coïncidence |

Un message qui répond « oui, non, non » est du bruit. Un message qui répond « non, oui, oui » est ta piste. Les cas intermédiaires demandent l'étape 20.

La commande qui répond à la question 1 en une ligne — le message apparaît-il aussi en dehors de la fenêtre d'incident ?

```bash
# fréquence par heure sur 24 h : un bruit de fond est régulier, une erreur réelle fait un pic
kubectl logs deploy/api -n platform --since=24h --timestamps \
  | grep "<motif>" | cut -c1-13 | uniq -c
```

Un histogramme plat = bruit. Un pic à l'heure de l'incident = piste.

---

## 22.3 Les faux positifs classiques d'une plateforme LLM

### A. « Contexte non sécurisé » / « insecure context » / avertissements TLS internes

**Le message** : une application se plaint de tourner en HTTP, un SDK avertit que la connexion n'est pas chiffrée, un navigateur signale un contexte non sécurisé pour une fonctionnalité interne.

**Pourquoi c'est normal** : le TLS est **terminé en amont** (étape 12), sur le LB ou la gateway d'entrée. Derrière, les pods se parlent en HTTP clair à l'intérieur du cluster — c'est l'architecture voulue, sauf mesh avec mTLS. L'application, elle, ne voit que du HTTP et le signale.

**Quand ce n'en est PAS un** : si le message apparaît **côté navigateur de l'utilisateur** sur l'URL publique, le TLS public est réellement cassé. Et si l'application génère des URL absolues en `http://` (boucle de redirection, mixed content), il manque la prise en compte de `X-Forwarded-Proto` : c'est un vrai bug de configuration.

### B. Rafales d'erreurs base de données pendant un failover

**Le message** : dizaines de `connection refused`, `server closed the connection unexpectedly`, `terminating connection due to administrator command`, `could not receive data from server`, en quelques secondes, sur plusieurs pods à la fois.

**Pourquoi c'est normal** : un failover Postgres (bascule primaire → réplique, déclenchée par l'opérateur, une mise à jour, un redémarrage de nœud) coupe toutes les connexions en cours. Chaque application reconnecte. La rafale **dure quelques secondes à une minute, puis s'arrête**.

**Quand ce n'en est PAS un** : si la rafale ne s'arrête pas, si elle revient toutes les 10 minutes (bascule en boucle — quorum, sonde, disque), ou si un seul composant n'a pas reconnecté (pool de connexions qui ne se régénère pas : c'est un vrai bug applicatif).

```bash
kubectl logs deploy/api -n platform --since=2h --timestamps | grep -i 'closed the connection' | cut -c1-16 | uniq -c
# un seul bloc de 30 s → failover normal. Un bloc toutes les 10 min → problème.
kubectl get events -n platform --field-selector reason=Killing --sort-by=.lastTimestamp
```

### C. 404 et 403 des règles de sécurité sur des endpoints internes

**Le message** : des 404 en série sur `/metrics`, `/actuator`, `/debug/pprof`, `/admin`, `/.env`, `/api/internal/...`.

**Pourquoi c'est normal** : deux causes se ressemblent.

- **Le durcissement voulu** (étape 12) : la gateway **masque** délibérément les endpoints internes en renvoyant 404 plutôt que 403 — ne pas révéler l'existence de ce qui est protégé. Le 404 est donc la preuve que la protection fonctionne.
- **Le scan de fond** : toute IP publique reçoit en permanence des requêtes automatisées sur `/.env`, `/wp-login.php`, `/.git/config`. Les 404 correspondants sont le fonctionnement normal d'Internet.

**Quand ce n'en est PAS un** : si un composant **interne** (Prometheus qui scrape `/metrics`) reçoit ces 404, la collecte est cassée — ton observabilité est aveugle sans le dire. Et un 404 sur une route **produit** légitime, depuis l'UI, est un vrai problème de routage (étape 12).

Le discriminant est **l'IP source** et le `User-Agent` : un scan vient de l'extérieur, une adresse de pod vient de l'intérieur.

### D. Erreurs de sonde au démarrage

**Le message** : `Readiness probe failed: connection refused`, `Startup probe failed: HTTP 503`, dans les Events d'un pod qui vient de démarrer.

**Pourquoi c'est normal** : la sonde commence avant que l'application n'écoute. Sur un serveur d'inférence qui charge des poids de plusieurs dizaines de Go, c'est **attendu pendant plusieurs minutes** (étape 15).

**Quand ce n'en est PAS un** : si les échecs continuent au-delà de la durée de démarrage attendue, si c'est une **liveness** (elle redémarre le pod : le compteur `RESTARTS` monte), ou si le pod oscille `Ready` / `NotReady` en régime établi — dans ce cas, la sonde est mal calibrée et retire un pod sain du Service, ce qui provoque des 503 intermittents difficiles à attribuer.

### E. Les avertissements de dépréciation d'API

**Le message** : `Warning: policy/v1beta1 PodDisruptionBudget is deprecated in v1.21+`, au moment d'un `helm upgrade`.

**Pourquoi c'est normal** : c'est un avertissement, l'objet est créé. Il annonce un travail futur, pas un échec présent.

**Quand ce n'en est PAS un** : quand le cluster client est plus récent que ton chart et que l'API a été **supprimée**, pas seulement dépréciée. Le message devient alors `no matches for kind` (partie B) — une vraie erreur bloquante.

### F. Les erreurs des composants optionnels non configurés

**Le message** : le connecteur vers l'IdP client qui boucle, l'exporteur OTLP qui n'a pas de collecteur en face, le job de backup qui échoue faute de bucket, un composant GPU sur un environnement sans GPU.

**Pourquoi c'est normal** : c'est exactement la liste de l'étape 21 — un composant activé sans sa dépendance externe. Sur un environnement de preview, c'est attendu.

**Quand ce n'en est PAS un** : **en production chez le client**. Là, un exporteur de métriques qui n'a pas de collecteur signifie que le client n'a pas d'observabilité sur la plateforme, même si tout est vert par ailleurs. Le même message est du bruit en preview et une vraie alerte en production — c'est pourquoi la liste des rouges normaux doit être **par environnement**.

### G. Le bruit de Kubernetes lui-même

À reconnaître pour ne pas les remonter au client :

| Message | Lecture |
|---|---|
| `Back-off restarting failed container` seul, sans redémarrage récent | Event ancien, encore affiché dans `describe` (rétention ~1 h) |
| `FailedScheduling` qui disparaît en 1 à 3 min | Autoscaler qui ajoute un nœud : normal (étape 21) |
| `Unable to attach or mount volumes`, résolu seul | Détachement du volume depuis l'ancien nœud, lors d'un déplacement de pod |
| `node.kubernetes.io/unreachable` bref | Blip du kubelet ou du réseau |
| `Liveness probe failed` **une seule fois** puis plus rien | Pic de latence ponctuel absorbé par `failureThreshold` |
| `context deadline exceeded` isolé sur un webhook | Opérateur qui redémarrait au même instant |
| `TLS handshake error from 10.x.x.x` sur un ingress | Sonde de santé du LB qui teste en TCP, ou un scan |

Le critère commun : **isolé et non répété = bruit ; périodique ou croissant = piste.**

---

## 22.4 Ce qui ressemble à du bruit et n'en est pas

L'inverse mérite autant d'attention. Ces messages passent inaperçus parce qu'ils sont discrets :

| Message discret | Ce qu'il cache |
|---|---|
| `WARN: falling back to <X>` | Un mécanisme dégradé silencieux : cache désactivé, modèle de repli, authentification contournée |
| `retrying (3/5)` qui finit en succès | La dépendance est instable ; la latence utilisateur explose sans aucune erreur |
| `slow query: 4.2s` isolé | Le début d'une dérive de la base ; regarde la tendance, pas l'occurrence |
| `truncating input to N tokens` | Des réponses de mauvaise qualité sans aucune erreur remontée |
| `certificate expires in 13 days` | Une panne totale programmée à date fixe |
| `disk usage 86%` | Idem, avec en prime une éviction de pods à la clé |
| `OOMKilled` sur un **init** container | Le pod redémarre en boucle sans jamais atteindre le conteneur principal |
| Un compteur `_errors_total` qui monte doucement | Une erreur qui ne se voit que dans les métriques, jamais dans les logs lus à la main |

Règle : **une dégradation silencieuse est plus dangereuse qu'une erreur bruyante**, parce que personne ne la signale avant que le client ne s'en plaigne.

---

## 22.5 Constituer ta propre liste

C'est le livrable de cette étape, et un des documents les plus utiles que tu produiras cette année. Un fichier versionné, à côté de tes values.

Format proposé, une ligne par entrée :

```markdown
| Composant | Motif (regex) | Fréquence normale | Pourquoi c'est attendu | Devient une alerte si | Env |
|---|---|---|---|---|---|
| api | `insecure context` | continu | TLS terminé à la gateway (étape 12) | visible côté navigateur sur l'URL publique | tous |
| api | `server closed the connection` | rafale < 1 min au failover | bascule Postgres, reconnexion auto | rafale > 2 min, ou périodique | tous |
| ingress | `404 /\.env\|/wp-login` | continu | scans Internet | source = IP de pod interne | prod |
| otel-export | `connection refused :4317` | continu | pas de collecteur en preview | présent en prod = pas d'observabilité | preview seulement |
| inference | `Startup probe failed` | 3-8 min au démarrage | chargement des poids | au-delà de 15 min, ou RESTARTS > 0 | tous |
```

Les colonnes qui font la valeur du document sont **« pourquoi c'est attendu »** et **« devient une alerte si »**. Sans elles, tu as écrit une liste d'exclusions, c'est-à-dire un angle mort.

**Comment la remplir** : sur un environnement fraîchement installé et sain (étape 21), capture une ligne de base. Tout ce qui apparaît là est, par construction, du bruit de fond.

```bash
NS=platform
# 1. la ligne de base, environnement sain, 1 h après stabilisation
kubectl get pods -n $NS -o name | while read p; do
  echo "=== $p"
  kubectl logs -n $NS "$p" --all-containers --since=1h 2>/dev/null \
    | grep -iE 'error|warn|fail|exception' | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]*//; s/[0-9a-f]{8,}/<id>/g; s/[0-9]+/<n>/g' \
    | sort | uniq -c | sort -rn | head -10
done | tee baseline-$(date +%F).txt
```

La normalisation (horodatages, identifiants et nombres remplacés) est ce qui permet de **regrouper** les messages : sans elle, chaque ligne est unique et `uniq -c` ne sert à rien.

Ensuite, pendant un incident, tu compares :

```bash
kubectl logs -n $NS <pod> --since=30m | grep -iE 'error|warn|fail' \
  | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]*//; s/[0-9a-f]{8,}/<id>/g; s/[0-9]+/<n>/g' \
  | sort | uniq -c | sort -rn > incident.txt
diff <(sort -k2 baseline-*.txt) <(sort -k2 incident.txt) | grep '^>'
```

Ce qui apparaît dans `incident.txt` sans être dans la ligne de base est **nouveau**. C'est là que tu commences.

**Entretien** : la liste se périme à chaque montée de version. Une entrée qui n'apparaît plus est à retirer (le bruit a peut-être été corrigé) ; un message nouveau est à qualifier avant de l'ajouter. Reprends une ligne de base à chaque nouvelle version majeure.

---

## 22.6 Comment en parler à un client

C'est le lien direct avec l'étape 23.

**Ne dis jamais** « c'est normal » tout court. Ça sonne comme une excuse et ne s'appuie sur rien.

**Dis** : le constat, la cause, et la conséquence réelle.

> « Ces `connection refused` sur `api` sont regroupés sur 40 secondes à 14:03, au moment de la bascule Postgres visible dans les événements de l'opérateur. Les applications ont reconnecté ensuite, aucun redémarrage de pod. Sur cette fenêtre, une poignée de requêtes ont pu échouer côté utilisateur. Le message est attendu ; ce qui ne le serait pas, c'est qu'il revienne périodiquement — je vais vérifier sur les dernières 24 h. »

Trois choses à ne pas faire :

- **affirmer sans avoir vérifié** que c'est le faux positif connu : les messages se ressemblent, les causes non ;
- **balayer une inquiétude du client** : s'il a ouvert les logs, c'est qu'il cherche à se rassurer ; explique plutôt que de minimiser ;
- **promettre de faire disparaître le message** : baisser un niveau de log pour faire joli supprime aussi une information utile. Si le bruit gêne vraiment, c'est un point produit à remonter, pas un correctif à improviser chez le client.

Et quand tu ne sais pas : « je ne connais pas ce message, je vérifie s'il est présent en dehors de l'incident avant de conclure » est une réponse professionnelle. Le bluff sur un log est le plus facile à démasquer, parce que le client a le même fichier sous les yeux.

---

## 22.7 Aide-mémoire

```
TEST         déjà là avant ? · conséquence observable ? · corrélé dans le temps ?
             oui/non/non → bruit · non/oui/oui → piste
FAUX AMIS    contexte non sécurisé (TLS terminé) · rafale base au failover · 404 des endpoints masqués
             sonde en échec au démarrage · dépréciation d'API · composant optionnel non configuré
VRAIS AMIS   fallback · retry qui finit OK · truncating · expire in N days · disk 86% · _errors_total qui monte
CRITÈRE      isolé = bruit · périodique ou croissant = piste
OUTIL        ligne de base sur env sain + normalisation + uniq -c ; diff pendant l'incident
CLIENT       constat + cause + conséquence, jamais « c'est normal » seul
```

---

## 22.8 Exercice — à faire clavier en main

**1. Capture ta ligne de base.** Sur le parapluie de l'étape 21, une fois stabilisé, lance le script de 22.5. Lis les dix motifs les plus fréquents et, pour **chacun**, écris une phrase expliquant pourquoi il apparaît. Si tu ne sais pas pour l'un d'eux, c'est celui qu'il faut creuser en premier : un message fréquent que tu ne t'expliques pas est soit une dégradation silencieuse, soit une connaissance qui te manque.

**2. Fabrique du bruit et de la vraie erreur, mélangés.** Sur ton lab :

```bash
NS=platform
# bruit : failover de la base (ou redémarrage brutal du pod primaire)
kubectl -n $NS delete pod <primaire-postgres>

# bruit : scans 404 sur l'ingress
for p in /.env /wp-login.php /admin /.git/config; do curl -s -o /dev/null http://localhost:8080$p; done

# vraie erreur discrète : réduire la limite mémoire d'un init container jusqu'à l'OOM
# vraie erreur discrète : couper le cache et vérifier si l'app bascule en "fallback" sans le dire
kubectl -n $NS scale sts/cache --replicas=0
```

Attends 10 minutes, puis **trie** les logs des 10 dernières minutes en trois colonnes : bruit / à qualifier / erreur réelle. Justifie chaque classement par une des trois questions de 22.2.

**3. Mesure-toi sur le diff.** Refais un `incident.txt` et compare-le à ta ligne de base avec la commande de 22.5. Le diff a-t-il fait ressortir les vraies erreurs ? A-t-il produit du faux positif (un message normal qui apparaît comme nouveau parce que la normalisation était insuffisante) ? Améliore le `sed`.

**4. Écris ta liste.** Remplis le tableau de 22.5 avec au moins huit entrées issues de ton lab, colonnes « pourquoi » et « devient une alerte si » comprises. Range le fichier à côté de tes values, sous contrôle de version.

**5. Entraîne-toi à l'oral.** Prends les trois entrées les plus techniques de ta liste et formule pour chacune la réponse de 30 secondes au client, dans le format constat / cause / conséquence. C'est exactement l'exercice de l'étape 23 ; autant commencer ici.

---

## Validé si…

Tu peux, sans support :

- énoncer les trois questions du test et dire quelle combinaison de réponses conclut au bruit ;
- expliquer le faux positif « contexte non sécurisé » et dire dans quel cas il redevient une vraie erreur ;
- dire pourquoi une rafale d'erreurs base de données peut être normale, et à quoi tu vois qu'elle ne l'est pas ;
- expliquer pourquoi une gateway renvoie 404 plutôt que 403 sur un endpoint interne, et quand ce 404 est un vrai problème ;
- citer quatre messages discrets qui cachent une vraie dégradation ;
- dire pourquoi le même message peut être du bruit en preview et une alerte en production ;
- expliquer à quoi sert la normalisation avant `uniq -c` ;
- formuler à un client une explication de faux positif en constat / cause / conséquence, sans dire « c'est normal ».

**Étape suivante** : `partie-D-resume.md` — résumé et take-aways des étapes 19 à 22, puis la partie E (restitution client).
