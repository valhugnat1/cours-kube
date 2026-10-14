# Partie D — Exploitation et diagnostic : résumé et take-aways

Récap des étapes 19 à 22. À relire avant une astreinte, une session de debug chez un client, ou quand un symptôme te laisse sans idée.

---

## Les 10 idées à garder en tête

1. **k9s n'a aucun pouvoir particulier.** Même kubeconfig, même contexte, même RBAC que `kubectl`. Une vue vide peut être un `forbidden` silencieux, une suppression est une vraie suppression, et le contexte affiché en en-tête est la première chose à lire avant de toucher une touche.
2. **Le même raccourci ne veut pas dire la même chose selon la vue.** `s` = shell sur un pod, scale sur un Deployment. Lis la barre du haut. Et `Ctrl-k` n'est pas un redémarrage : pour redémarrer, `r` sur le propriétaire (étape 2).
3. **`--readonly` protège le cluster, pas l'écran.** Il empêche de modifier ; il n'empêche ni `x` de décoder un Secret, ni `y` d'afficher du base64, ni `d` de montrer un mot de passe en variable d'environnement. Avant un partage d'écran : pas de vue `:secrets`.
4. **`%MEM/L` proche de 100 % annonce un OOM ; `%CPU/L` proche de 100 % annonce du throttling** — de la lenteur sans aucune erreur. Colonnes vides = pas de metrics-server, pas un bug. Et `top` est un instantané : `Last State: OOMKilled` fait foi, pas le graphique.
5. **Un diagnostic commence par un code HTTP, jamais par « ça marche pas ».** Objectiver → situer dans le chemin → santé du pod → logs de la bonne instance → descendre d'un plan. Toujours dans cet ordre, parce que l'ancrage, le lampadaire et la corrélation temporelle te piègent sinon.
6. **La cause est la première erreur du log, pas la dernière.** Et pas celle du composant qui crie le plus fort : un pod en CrashLoop peut être la victime d'une dépendance tombée. On s'arrête quand la cause explique **tous** les symptômes.
7. **401 ≠ 403, 502 ≠ 503 ≠ 504.** Le code dit qui a répondu et où regarder. L'en-tête `server` et le format du corps (HTML nginx vs JSON applicatif) disent si la requête a seulement atteint l'ingress ou bien l'application.
8. **`helm install` qui retourne 0 ne veut pas dire que c'est prêt.** Le provisionnement est asynchrone : `kubectl wait --for=condition`, jamais `sleep`. Et `--wait --atomic` avec un `--timeout` plus long que ta migration la plus lente.
9. **« Long » ou « cassé » se décide sur le mouvement, pas sur la durée.** Event qui change ou logs d'init qui avancent = long. Statut figé depuis 10 min, ou `RESTARTS` qui monte = cassé. Les Pending massifs des trois premières minutes sont normaux.
10. **Le bruit normal se connaît, il ne s'ignore pas.** « Je sais pourquoi ce message apparaît » est une connaissance ; « je l'ignore d'habitude » est un angle mort. Le même message peut être du bruit en preview et une vraie alerte en production.

---

## La séquence « pourquoi ça rame » en une minute

```
1. En-tête k9s      → bon contexte ? CPU/MEM cluster saturé ?                      (5 s)
2. :pods, 0, Ctrl-z → des pods en défaut ?                                          (5 s)
3. Shift-t          → des redémarrages récents ? (OOM, liveness)                    (5 s)
4. Shift-a          → des pods très jeunes ? (recréés, évictions)                   (5 s)
5. Shift-c/Shift-m  → %CPU/L ≈ 100 → throttling ; %MEM/L ≈ 100 → OOM imminent      (10 s)
6. :nodes           → un nœud saturé ? des pods qui s'y concentrent ?               (10 s)
7. :events, Shift-a → Warning récents : évictions, FailedScheduling, probes         (10 s)
8. d sur le suspect → Last State, Reason, Events                                    (10 s)
```

Conclusion attendue : **une phrase appuyée sur ce que tu as vu**. « Tout est vert côté pods, la lenteur n'est pas là » est aussi une bonne conclusion.

En kubectl pur :

```bash
kubectl config current-context
kubectl get pods -A | grep -vE 'Running|Completed'
kubectl get pods -A --sort-by='.status.containerStatuses[0].restartCount' | tail -10
kubectl get pods -A --sort-by=.metadata.creationTimestamp | tail -10
kubectl top pods -A --sort-by=cpu | head ; kubectl top pods -A --sort-by=memory | head
kubectl top nodes
kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp | tail -20
kubectl describe pod <suspect> -n <ns> | grep -A5 'Last State'
```

---

## k9s ↔ kubectl, la table à connaître

| k9s | kubectl |
|---|---|
| `d` | `describe pod X` |
| `y` | `get pod X -o yaml` |
| `l` / `p` | `logs X -c C -f` / `logs X -c C --previous` |
| `s` (pod) | `exec -it X -c C -- sh` |
| `s` (deploy) | `scale deploy/X --replicas=N` |
| `r` | `rollout restart deploy/X` |
| `Shift-f` | `port-forward pod/X 8080:8000` |
| `Ctrl-d` / `Ctrl-k` | `delete pod X` / `delete pod X --force --grace-period=0` |
| `x` (secret) | `get secret X -o json \| jq '.data \| map_values(@base64d)'` |
| `:xray deploy` | `tree deploy X` (krew) ou `ownerReferences` |
| `:events` | `get events --sort-by=.lastTimestamp` |
| `:helm` | `helm list -A` / `helm get values` |
| `Ctrl-z` | `get pods -A --field-selector=status.phase!=Running` |
| tri `Shift-c/m` | `top pods --sort-by=cpu\|memory` |

Sur image distroless, `s` échoue (`sh: not found`) → `kubectl debug -it pod/X --image=nicolaka/netshoot --target=<conteneur>`.

---

## Codes HTTP : qui répond, où regarder

| Code | Qui | Première chose à regarder |
|---|---|---|
| pas de réponse | personne | DNS, LB, firewall, TLS (`curl -v` : où ça s'arrête) |
| 400 | app / gateway | taille des cookies et JWT, buffers d'en-têtes |
| **401** | auth | **non authentifié** : jeton absent ou expiré, `iss`, horloge |
| **403** | auth / gateway / WAF | **authentifié, refusé** : rôle, permission, IP source |
| 404 | ingress **ou** app | HTML nginx = aucune règle ne matche ; JSON = ressource absente ; ou endpoint masqué volontairement |
| 413 | ingress | `proxy-body-size` (upload RAG) |
| 429 | quota / fournisseur | compteur en cache KV, `retry-after` |
| 500 | app | première stack trace |
| 502 | ingress | targetPort, écoute sur 127.0.0.1, pod mort pendant la requête |
| 503 | ingress / app | `get endpoints`, readiness |
| 504 | ingress / LB | timeouts à chaque étage — **le plus court gagne** |

Le code final n'est pas toujours le code d'origine : un 429 interne peut ressortir en 500, voire en 200 avec l'erreur dans le corps. Lis le corps.

---

## Arbres par symptôme, en condensé

**Injoignable** → `curl -v` : resolve (DNS) · pend (LB/firewall) · refused (rien n'écoute) · TLS (chaîne, SNI, cert-manager) · réponse HTTP (ce n'est plus « injoignable »).

**Login** → redirection absente (redirect_uri) · erreur IdP (`user_not_found` = piège des deux realms) · 401 au retour (secret client, horloge, `iss`) · boucle (cookie : SameSite, Secure, domaine) · « ça marche en navigation privée » (onglet périmé, pas un bug serveur).

**CrashLoopBackOff** → `logs --previous` : vide (binaire, arch, command) · config (ConfigMap, parse) · refused vers une dépendance (**symptôme, descendre d'un plan**) · migration en échec · exit 137 OOM · exit 0 en boucle (mauvais CMD) · liveness qui tue.

**Pending** → Events : `Insufficient cpu/memory` · `Insufficient nvidia.com/gpu` · `untolerated taint` · `node affinity/selector` · `anti-affinity` · `unbound PVC` · `volume node affinity conflict` · aucun Event (scheduler, ResourceQuota).

Codes de sortie : **1** applicatif · **126/127** commande introuvable · **137** SIGKILL/OOM · **139** segfault · **143** SIGTERM.

---

## Environnements éphémères : les réflexes

```bash
# créer, idempotent et daté
kubectl create ns $NS --dry-run=client -o yaml | kubectl apply -f -
kubectl label ns $NS --overwrite owner=hugo ttl=24h expires-at=... purpose=...
helm upgrade --install ... --atomic --timeout 20m

# attendre
until kubectl get deploy/api -n $NS >/dev/null 2>&1; do sleep 5; done
kubectl wait --for=condition=Available deploy --all -n $NS --timeout=20m

# observer le mouvement
watch -n 10 'kubectl get pods -n '"$NS"' | awk "{print \$3}" | sort | uniq -c'

# détruire, dans l'ordre, puis vérifier
helm uninstall platform -n $NS
kubectl delete pvc --all -n $NS
kubectl delete ns $NS
kubectl get pv | grep $NS ; kubectl get crd | grep <opérateur>
# + hors cluster : disques détachés, IP réservées, LB, enregistrements DNS
```

Ce qui survit à `delete ns` : les PV en `Retain`, les CRDs, les ClusterRoles/Bindings, les webhooks, et tout ce qui vit chez le fournisseur cloud (disques, IP, LB, DNS).

Avant d'installer sur un cluster partagé : `kubectl get crd | grep -E 'cert-manager|external-secrets|nvidia'`, `helm list -A`, `kubectl auth can-i create crd`. Si l'opérateur est là, `enabled: false` dans tes values.

Namespace en `Terminating` : comprendre le finalizer **avant** de forcer, sinon tu laisses des ressources cloud facturées sans plus rien dans le cluster pour te les rappeler.

---

## Faux positifs : le test, et les deux listes

**Le test en trois questions** : déjà là avant l'incident ? conséquence observable ? corrélé dans le temps ?
→ oui / non / non = **bruit**. non / oui / oui = **piste**.

**Faux amis (rouge mais normal)** : contexte non sécurisé (TLS terminé en amont) · rafale d'erreurs base au failover (< 1 min) · 404 sur endpoints masqués et scans Internet · sondes en échec pendant le démarrage · avertissements de dépréciation d'API · composants optionnels sans dépendance externe · Events Kubernetes isolés et non répétés.

**Vrais amis (discret mais grave)** : `falling back to` · `retrying (3/5)` qui finit OK · `slow query` · `truncating input` · `certificate expires in N days` · `disk usage 86%` · `OOMKilled` sur un **init** container · un `_errors_total` qui monte doucement.

**Critère commun** : isolé = bruit ; périodique ou croissant = piste.

**L'outil** : une ligne de base capturée sur un environnement sain, avec normalisation avant regroupement.

```bash
kubectl logs -n $NS <pod> --all-containers --since=1h | grep -iE 'error|warn|fail' \
  | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]*//; s/[0-9a-f]{8,}/<id>/g; s/[0-9]+/<n>/g' \
  | sort | uniq -c | sort -rn
```

Ta liste doit avoir les colonnes **« pourquoi c'est attendu »** et **« devient une alerte si »**. Sans elles, ce n'est pas une liste de faux positifs, c'est une liste d'angles morts. Elle se reprend à chaque version majeure.

---

## Le compte rendu de diagnostic

À écrire pendant, pas après.

```markdown
## Incident — <titre factuel> — <date, heure UTC>
**Symptôme** : <code HTTP, route, périmètre, depuis quand>
**Chemin** : <où ça passe et jusqu'où ça va>
**Constaté** : <observations horodatées, avec la preuve de chacune>
**Éliminé** : <hypothèses réfutées, et comment>
**Cause** : <une phrase, qui explique tous les symptômes>
**Action** : <au bon échelon : values versionnées, pas kubectl edit>
**Vérification** : <le symptôme initial, re-testé>
**Non vérifié** : <ce qui reste supposé>
```

La ligne **« Éliminé »** vaut autant que la cause pour celui qui reprendra le sujet. La ligne **« Non vérifié »** est ce qui te distingue de quelqu'un qui bluffe (étape 23).

---

## Pièges vécus, par étape

- **19** — mauvais contexte dans k9s (plus rapide à supprimer qu'en kubectl) ; `s` qui scale au lieu d'ouvrir un shell ; `Ctrl-k` pris pour un redémarrage ; secret décodé en partage d'écran ; colonnes CPU vides prises pour un bug ; logs agrégés d'un Deployment sans savoir quelle instance a parlé ; `--previous` perdu après recréation du pod ; vue `0` sur un gros cluster qui charge l'API.
- **20** — diagnostiquer sans code HTTP ; lire les logs en heure locale alors qu'ils sont en UTC ; s'ancrer sur la première hypothèse ; corriger le messager (redémarrer l'API) au lieu de la cause ; lire la dernière ligne d'erreur au lieu de la première ; prendre `JSONDecodeError` pour un JSON mal formé alors que la réponse était du HTML ; confondre une erreur venant d'`examples/` avec un bug produit ; « ça a cassé après mon upgrade » pris pour une conclusion.
- **21** — `helm install` retourné 0 pris pour « c'est prêt » ; `sleep` au lieu de `wait` ; `kubectl wait` sur un objet pas encore créé ; paniquer sur les Pending des trois premières minutes ; chercher dans les logs du conteneur principal d'un pod en `Init` ; installer cert-manager sur un cluster partagé qui l'avait déjà ; namespace sans label `owner` ; forcer un finalizer et laisser un disque facturé ; PVC oubliés après `helm uninstall` ; enregistrement DNS orphelin qui pointe vers une IP recyclée.
- **22** — annoncer « une erreur grave » sur un message présent depuis l'installation ; ignorer en bloc une famille de messages et rater la vraie ; prendre un 404 de scan pour une attaque et un 404 de Prometheus pour du scan ; traiter en preview et en prod la même erreur de la même façon ; baisser un niveau de log pour faire joli chez un client ; dire « c'est normal » sans cause ni conséquence.

---

## Auto-évaluation express

Réponds à voix haute, sans support :

1. Pourquoi `--readonly` ne protège pas un partage d'écran, et que fais-tu à la place ?
2. Équivalent kubectl de `l`, `p`, `r`, `x` et `:xray`.
3. `%CPU/L` à 100 % : quel symptôme utilisateur, et quelle erreur dans les logs ?
4. Les cinq temps de la méthode de debug, et ce que chacun apporte.
5. 401 vs 403, et 502 vs 503 vs 504 : une phrase chacun, avec le premier endroit où regarder.
6. Pourquoi la première erreur d'un log compte plus que la dernière ?
7. Que signifie réellement `JSONDecodeError: Expecting value: line 1 column 1` ?
8. Un pod en CrashLoopBackOff qui n'est pas la cause du problème : donne un exemple complet.
9. Le critère qui sépare « long » de « cassé », et trois statuts qui sont cassés d'emblée.
10. Quatre choses qui survivent à `kubectl delete ns`.
11. Les trois questions du test de faux positif, et la combinaison qui conclut au bruit.
12. Pourquoi le même message peut être du bruit en preview et une alerte en production ?

Si une réponse hésite, rouvre l'étape et refais son exercice.

---

## Ce qui reste à faire avant la partie E

La partie D ne se valide pas en lisant. Avant d'attaquer l'étape 23 :

- la séquence « pourquoi ça rame » en moins d'une minute dans k9s, et moins de trois en kubectl ;
- les cinq pannes de l'étape 20 diagnostiquées depuis un seul `curl`, avec une ligne « Éliminé » à chaque fois ;
- un environnement créé, observé, détruit et **vérifié** (y compris hors cluster) ;
- ta liste de faux positifs, au moins huit entrées, colonnes « pourquoi » et « devient une alerte si » remplies.

Ces quatre livrables sont exactement la matière de la partie E : en restitution client, tu ne racontes pas ce que tu sais, tu montres ce que tu as constaté.

**Étape suivante** : `etape-23-communication-technique-client.md` — communication technique avec un client.
