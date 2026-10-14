# Étape 4 — Réseau Kubernetes

**Objectif** : à la fin de cette étape, tu sais suivre une requête depuis l'extérieur du cluster jusqu'au conteneur, et à l'inverse depuis un pod vers un autre. Tu sais lire un Service, un Ingress, une NetworkPolicy, et tu as les cinq commandes qui diagnostiquent 90 % des « c'est injoignable ».

**Prérequis** : étape 3 faite.

Pourquoi ça compte pour toi : dans une plateforme LLM, presque tous les incidents visibles par un client sont réseau en apparence — « la console ne répond pas », « l'API renvoie 502 », « le crawler n'arrive pas à sortir ». La plupart ne sont pas des problèmes réseau, mais tu dois pouvoir le prouver en remontant la chaîne. L'étape 12 (plan d'entrée) reprendra tout ceci au niveau de la plateforme.

---

## 4.1 Le modèle réseau : plat, sans NAT

Kubernetes impose trois règles au réseau, et laisse le **CNI** (Container Network Interface, un plugin) les réaliser :

1. Chaque pod a sa propre IP, unique dans le cluster.
2. Tout pod peut joindre tout pod, sur n'importe quel nœud, **sans NAT** — l'IP source vue par le destinataire est l'IP réelle du pod.
3. Les agents d'un nœud (kubelet) peuvent joindre tous les pods du nœud.

C'est un réseau *plat* : pas de ports à mapper comme avec `docker run -p`, pas de traduction d'adresses entre pods. Les IPs des pods viennent d'une plage réservée (le **pod CIDR**, ex. `10.244.0.0/16`), les IPs des Services d'une autre (le **service CIDR**, ex. `10.96.0.0/12`). Ces plages sont fixées à la création du cluster et **diffèrent chez chaque client** — un chart qui coderait une IP en dur est cassé par construction.

**Le CNI** est ce qui varie le plus entre environnements :

| CNI | Où tu le verras | Particularités |
|---|---|---|
| kindnet | kind (ton lab) | Minimal, **n'applique pas les NetworkPolicy** |
| Calico | on-prem, RKE2, beaucoup de clusters kubeadm | NetworkPolicy complètes, BGP possible |
| Cilium | GKE Dataplane V2, clusters modernes, on-prem exigeants | Basé sur eBPF, remplace kube-proxy, observabilité réseau (Hubble), policies L7 |
| Flannel | k3s par défaut, clusters simples | Pas de NetworkPolicy seul |
| OpenShift SDN / OVN-Kubernetes | OpenShift | Ses propres objets réseau en plus |

Ce que ça change pour toi : une NetworkPolicy dans ton chart sera **appliquée ou ignorée** selon le CNI du client. Il faut le savoir avant de dire à un client « les composants sont isolés ».

---

## 4.2 Services : une IP stable devant des pods mortels

Un pod meurt, son IP disparaît. Le **Service** est l'objet qui donne une adresse et un nom stables à un groupe de pods. Il ne fait rien lui-même : c'est kube-proxy (ou Cilium) qui, sur chaque nœud, installe des règles réseau redirigeant l'IP du Service vers les IPs des pods sélectionnés.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  type: ClusterIP          # défaut
  selector:
    app: api
  ports:
    - name: http
      port: 8080           # le port du Service
      targetPort: 8000     # le port DU CONTENEUR (nombre ou nom de port nommé)
      protocol: TCP
```

### Les endpoints : la liste réelle des cibles
Le Service ne cible que les pods **sélectionnés par label ET `Ready`**. La liste effective est dans un objet séparé :

```bash
kubectl get endpoints api          # ou : kubectl get endpointslices -l kubernetes.io/service-name=api
NAME   ENDPOINTS                          AGE
api    10.244.0.12:8000,10.244.0.13:8000  3m
```

**C'est la commande n° 1 du diagnostic réseau.** Un Service avec `ENDPOINTS <none>` a exactement trois causes possibles : le selector ne correspond à aucun label de pod (faute de frappe, chart mal rendu), aucun pod n'est `Ready` (readiness en échec, étape 3), ou le Service n'a pas de selector du tout (Service « manuel » dont on gère les endpoints à la main, cas des services externes).

### Les types de Service

| Type | Ce qu'il fait | Joignable depuis | Usage |
|---|---|---|---|
| **ClusterIP** | IP virtuelle interne | L'intérieur du cluster uniquement | Le défaut : toute communication entre composants |
| **NodePort** | ClusterIP **+** un port (30000-32767) ouvert sur **chaque** nœud | `IP-de-n'importe-quel-nœud:port` | Rare en prod ; base du LoadBalancer ; utile en lab ou on-prem sans LB |
| **LoadBalancer** | NodePort **+** demande au cloud-controller-manager un équilibreur externe | Une IP publique/privée fournie par le cloud | L'entrée du cluster sur GKE/AWS/Azure ; on-prem il faut MetalLB ou équivalent, sinon l'IP reste `<pending>` pour toujours |
| **Headless** (`clusterIP: None`) | Pas d'IP virtuelle : le DNS renvoie directement les IPs des pods | L'intérieur | StatefulSets (`db-0.db.ns.svc…`), clients qui font leur propre équilibrage (drivers Kafka, gRPC) |
| **ExternalName** | Un alias DNS (CNAME) vers un nom externe | L'intérieur | Pointer `postgres` vers une base managée hors cluster sans changer la config applicative |

Le LoadBalancer en `<pending>` est un classique on-prem : le chart demande un `type: LoadBalancer`, le cluster n'a personne pour le fournir. Solutions : MetalLB, un NodePort + LB externe géré par le client, ou une valeur de chart qui bascule le type.

### Ce que kube-proxy fait vraiment
Il ne « proxifie » rien au sens applicatif : il écrit des règles iptables (ou IPVS) qui réécrivent l'adresse de destination des paquets. Conséquences : l'équilibrage est **par connexion**, pas par requête (une connexion HTTP keep-alive ou gRPC reste collée au même pod — surprise fréquente sur les services d'inférence) ; et il n'y a pas de retry ni de circuit breaker. Pour ça, il faut un proxy applicatif (ingress, gateway, mesh).

---

## 4.3 DNS : comment un pod trouve un Service

**CoreDNS** tourne dans `kube-system` et répond pour la zone `cluster.local`. Chaque Service obtient un nom :

```
<service>.<namespace>.svc.cluster.local
api.platform.svc.cluster.local
```

Depuis un pod, on peut abréger grâce aux domaines de recherche injectés dans `/etc/resolv.conf` :

```
search platform.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

- `api` → résolu si `api` est dans le **même** namespace ;
- `api.platform` → depuis n'importe quel namespace ;
- `api.platform.svc.cluster.local` → toujours, et c'est la forme à utiliser dans une configuration (pas d'ambiguïté).

Les pods d'un StatefulSet derrière un Service headless ont chacun un nom : `db-0.db.platform.svc.cluster.local`.

**Le piège `ndots:5`** : avec cette option, tout nom contenant moins de 5 points (`api.mistral.ai` en a 2) est **d'abord** essayé avec chaque domaine de recherche (`api.mistral.ai.platform.svc.cluster.local`, puis `…svc.cluster.local`, …) avant d'être résolu tel quel. Résultat : 3 à 4 requêtes DNS inutiles par appel externe, des latences, et des logs CoreDNS pleins de NXDOMAIN. Remède : un point final (`api.mistral.ai.`) ou `dnsConfig.options: [{name: ndots, value: "2"}]` sur les pods qui appellent beaucoup l'extérieur.

Diagnostic :
```bash
kubectl exec -it <pod> -- cat /etc/resolv.conf
kubectl exec -it <pod> -- nslookup api.platform
kubectl -n kube-system logs deploy/coredns --tail=50
```

Une image `distroless` ou `scratch` n'a ni `nslookup` ni `sh` : lance un pod outil à côté :
```bash
kubectl run -it --rm netshoot --image=nicolaka/netshoot -- bash
# dedans : nslookup, dig, curl, tcpdump, nc, traceroute…
```

---

## 4.4 Ingress : entrer dans le cluster en HTTP

Un Service LoadBalancer par application coûterait une IP et un équilibreur cloud par composant. L'**Ingress** mutualise : **un** point d'entrée HTTP(S) qui route par nom d'hôte et par chemin vers des Services internes.

Deux objets, à ne pas confondre :

- La ressource **Ingress** : des règles de routage déclaratives. Elle ne fait rien seule.
- L'**ingress controller** : un proxy (nginx, Traefik, HAProxy, Envoy, ou celui du cloud comme GKE Ingress) qui lit les Ingress et se configure. Il est lui-même exposé par un Service LoadBalancer (ou NodePort). **Sans controller, un Ingress est un objet inerte** — piège classique sur un cluster fraîchement créé.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: platform
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: 50m    # spécifique au controller
spec:
  ingressClassName: nginx            # QUEL controller doit traiter cet Ingress
  tls:
    - hosts: [chat.client.example]
      secretName: chat-tls           # Secret de type kubernetes.io/tls (cert + clé)
  rules:
    - host: chat.client.example
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service: { name: api, port: { number: 8080 } }
          - path: /
            pathType: Prefix
            backend:
              service: { name: ui, port: { number: 80 } }
```

Ce qu'il faut retenir :

- **`ingressClassName`** : sur un cluster client, il peut y avoir plusieurs controllers, ou un seul avec un nom inattendu (`nginx`, `nginx-internal`, `traefik`, `gce`, `openshift-default`). Un Ingress sans classe, ou avec une classe inexistante, n'est traité par personne — pas d'erreur, juste rien. `kubectl get ingressclass` le dit. C'est **la** valeur de chart à surcharger chez chaque client.
- **Les annotations** sont propres à chaque controller (timeouts, taille des uploads, réécriture de chemin, IP source autorisées). Un chart écrit pour nginx-ingress ne porte pas ses réglages sur Traefik. Ce point revient à l'étape 12 avec le durcissement de gateway.
- **TLS** : le certificat est un Secret ; cert-manager (étape 9) peut le générer et le renouveler via ACME. La terminaison se fait au controller ; derrière, HTTP clair (étape 0.3).
- **OpenShift** n'utilise pas Ingress par défaut mais des **Routes** (un objet maison). Les Ingress y sont convertis automatiquement dans la plupart des cas, mais pas les annotations.

### Gateway API : le successeur
Ingress est figé ; **Gateway API** le remplace progressivement avec trois objets : `GatewayClass` (l'implémentation), `Gateway` (un point d'entrée, ses ports, ses certificats — géré par l'équipe infra) et `HTTPRoute` / `GRPCRoute` (les règles de routage — gérées par les équipes applicatives). Il standardise ce qui était des annotations : réécriture, en-têtes, pondération pour du canari, gRPC. Sur GKE et avec Cilium/Envoy Gateway c'est déjà le défaut. Ton chart devra probablement rendre l'un ou l'autre selon le client.

### Ingress vs « API gateway »
Ne confonds pas l'ingress controller (routage L7 générique) avec l'**API gateway** d'une plateforme (Kong, Envoy, Tyk… ou un composant maison) : elle ajoute l'authentification, les quotas, le rate limiting, la transformation. Dans la plateforme, la chaîne est typiquement : LB → ingress controller → API gateway → services (§4, §6). Les deux existent souvent en même temps.

---

## 4.5 La chaîne complète, dans les deux sens

**De l'extérieur vers un pod :**

```
navigateur ─▶ DNS public (chat.client.example → IP du LB)
           ─▶ LoadBalancer cloud / MetalLB
           ─▶ NodePort sur un nœud (Service du ingress controller)
           ─▶ pod du ingress controller (termine TLS, lit les Ingress)
           ─▶ Service ClusterIP « api » (règles kube-proxy)
           ─▶ un pod api « Ready » (endpoint), port 8000
```

**D'un pod vers l'extérieur (egress) :** le pod utilise l'IP du nœud en sortie (SNAT), sauf configuration particulière. Un client exigeant impose un **proxy de sortie** obligatoire (variables `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` dans les pods, ou interception transparente) avec liste blanche de destinations. Deux conséquences immédiates : `NO_PROXY` doit contenir les plages internes du cluster (sinon les appels entre services partent vers le proxy et échouent), et le composant qui fait des appels sortants pilotés par l'utilisateur (crawler, connecteurs, exécution de code) doit être bloqué vers les plages privées — c'est la protection **SSRF** du §4, on la détaille à l'étape 12.

Chaque maillon est un endroit où ça peut casser, et chaque maillon a sa commande de vérification (4.7).

---

## 4.6 NetworkPolicy : le pare-feu entre pods

Par défaut, **tout pod peut parler à tout pod** (règle 2 du modèle). Une **NetworkPolicy** restreint ça, pour les pods qu'elle sélectionne :

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-only-from-api
  namespace: platform
spec:
  podSelector:
    matchLabels: { app: db }          # les pods PROTÉGÉS
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: api } # seuls ces pods peuvent entrer
      ports:
        - port: 5432
  egress:
    - to:
        - namespaceSelector: {}       # tous les namespaces…
          podSelector:
            matchLabels: { k8s-app: kube-dns }   # …mais seulement CoreDNS
      ports:
        - port: 53
          protocol: UDP
```

Les règles de lecture :

- Dès qu'**une** policy sélectionne un pod pour un type (Ingress ou Egress), **tout ce qui n'est pas explicitement autorisé est refusé** pour ce type. Un pod sélectionné par aucune policy reste totalement ouvert.
- Les policies sont **additives** : plusieurs policies sur le même pod, on prend l'union des autorisations. Il n'y a pas de règle « deny ».
- `namespaceSelector` et `podSelector` dans le **même** élément de liste = ET ; dans deux éléments = OU. Cette différence d'indentation a causé des heures de debug à beaucoup de monde.
- Le pattern « default deny » d'un namespace : une policy avec `podSelector: {}` et `policyTypes: [Ingress, Egress]` sans aucune règle. Ensuite on ouvre au cas par cas. **N'oublie jamais DNS en egress**, sinon plus rien ne résout et tout semble cassé.
- Une NetworkPolicy sans CNI qui l'applique est **acceptée par l'API et ignorée** — aucune erreur, aucune alerte. Sur kind avec kindnet, c'est exactement ce qui se passe.

Les policies sont L3/L4 (IP, port). Pour du L7 (par chemin HTTP, par méthode), il faut Cilium ou un service mesh.

### Service mesh, en une minute
Istio, Linkerd, Cilium mesh : un proxy à côté de chaque pod (ou dans le noyau pour Cilium) qui prend en charge mTLS entre services, retries, timeouts, circuit breaking, métriques et traces uniformes, routage fin. Ça résout les limites de kube-proxy vues plus haut, au prix d'une complexité réelle. Tu le croiseras chez des clients qui l'imposent (souvent avec OpenShift Service Mesh ou Istio) : le symptôme typique est un sidecar injecté dans tes pods qui change les comportements réseau (un Job qui ne finit plus, un port non déclaré qui ne passe plus).

---

## 4.7 La boîte à outils du diagnostic réseau

Dans l'ordre où les utiliser sur un « service injoignable » :

```bash
# 1. Le Service existe-t-il et a-t-il des cibles ?
kubectl get svc api -o wide
kubectl get endpoints api                    # <none> → selector ou readiness

# 2. Le selector correspond-il aux labels des pods ?
kubectl get pods -l app=api --show-labels    # rien → faute dans le selector ou le chart

# 3. Le pod écoute-t-il vraiment sur le targetPort ?
kubectl exec <pod api> -- ss -ltnp           # ou netstat -ltnp ; cherche 0.0.0.0:8000 (pas 127.0.0.1)

# 4. Joignable depuis l'intérieur du cluster ?
kubectl run -it --rm t --image=nicolaka/netshoot -- curl -sv http://api.platform:8080/healthz
#   ça marche → le problème est en amont (ingress, LB, DNS externe)
#   ça échoue → Service/pod/NetworkPolicy

# 5. Court-circuiter tout le réseau du cluster :
kubectl port-forward pod/<pod api> 8000:8000 ; curl -v localhost:8000/healthz
#   ça marche → l'application est saine, le problème est entre les deux

# 6. Côté Ingress
kubectl get ingress -A                       # ADDRESS vide → aucun controller ne l'a pris
kubectl get ingressclass
kubectl -n ingress-nginx logs deploy/ingress-nginx-controller --tail=100   # 404 ? 502 ? 503 ?

# 7. NetworkPolicy en cause ?
kubectl get networkpolicy -A
kubectl describe networkpolicy <nom>
```

Les codes que renvoie un ingress controller sont une carte (§13) : **404** = aucune règle ne matche cet hôte/chemin (souvent `host` mal écrit ou classe absente) ; **502** = le controller a joint un endpoint mais la connexion a échoué (pod qui n'écoute pas, mauvais targetPort) ; **503** = pas d'endpoint du tout (readiness, selector) ; **504** = le backend n'a pas répondu à temps (timeout du controller, à ajuster par annotation pour les requêtes d'inférence longues).

---

## 4.8 Exercice — clavier en main

```bash
kubectl config current-context && kubectl create namespace lab4 && kubens lab4
```

1. **Deux applis, deux Services.** Déploie `api` (image `hashicorp/http-echo`, `args: ["-text=api", "-listen=:8000"]`, 2 réplicas, Service port 8080 → targetPort 8000) et `ui` (`nginx:1.27`, Service port 80). Vérifie :
   ```bash
   kubectl get svc,endpoints
   ```

2. **DNS depuis un pod.** Lance netshoot et explore :
   ```bash
   kubectl run -it --rm t --image=nicolaka/netshoot -- bash
   cat /etc/resolv.conf
   nslookup api ; nslookup api.lab4 ; nslookup api.lab4.svc.cluster.local
   nslookup ui.default          # échoue : ui n'existe pas dans default
   curl -s http://api:8080 ; curl -s http://api:8080 ; curl -s http://api:8080   # même réponse, pods différents ? ajoute -v et regarde
   exit
   ```

3. **Casse le selector.** Modifie le Service `api` avec `selector: {app: apii}`. `kubectl get endpoints api` → `<none>`. Depuis netshoot, `curl http://api:8080` → échec de connexion. Répare.

4. **Casse le targetPort.** Mets `targetPort: 8001`. Les endpoints existent (le port n'est pas vérifié), mais `curl` échoue : `ss -ltnp` dans le pod montre que rien n'écoute sur 8001. Répare. Retiens la différence de symptôme avec l'étape 3.

5. **Readiness et endpoints.** Ajoute à `api` une readiness `httpGet` sur `/`, port 8000, puis change-la vers le port 9999. Les pods restent `Running 0/2`, les endpoints se vident. Répare.

6. **NodePort.** Passe `ui` en `type: NodePort`, note le port, et joins-le depuis ta machine via l'IP du nœud kind :
   ```bash
   kubectl get svc ui
   docker inspect lab-control-plane -f '{{.NetworkSettings.Networks.kind.IPAddress}}'
   curl http://<ip>:<nodeport>          # (sur macOS, l'IP du conteneur Docker n'est pas routable : passe par kubectl port-forward svc/ui 8081:80 et retiens juste le principe)
   ```

7. **Ingress.** Installe le controller nginx (manifeste officiel pour kind), puis un Ingress qui route `/api` → `api:8080` et `/` → `ui:80` pour l'hôte `lab.local` :
   ```bash
   kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
   kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller
   kubectl get ingressclass                      # note le nom
   # écris ingress.yaml avec ingressClassName correspondant, applique
   kubectl get ingress                           # ADDRESS doit se remplir
   kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8443:443 8080:80
   curl -H 'Host: lab.local' http://localhost:8080/api      # api
   curl -H 'Host: lab.local' http://localhost:8080/         # page nginx
   curl -i -H 'Host: autre.local' http://localhost:8080/    # 404 : aucune règle
   ```
   Provoque ensuite un **503** (readiness cassée sur `api`) et un **502** (targetPort faux), et lis le log du controller pour chacun :
   ```bash
   kubectl -n ingress-nginx logs deploy/ingress-nginx-controller --tail=5
   ```

8. **Ingress ignoré.** Mets `ingressClassName: nexistepas`. Observe qu'il n'y a aucune erreur, que `ADDRESS` se vide, et que le controller renvoie 404. C'est le piège silencieux.

9. **NetworkPolicy (et la preuve qu'elle est ignorée).** Applique une policy « default deny » sur le namespace, puis `curl http://api:8080` depuis netshoot : **ça passe encore**. kindnet ne l'applique pas. Vérifie que l'objet existe pourtant (`kubectl get netpol`). Note cette observation dans ta liste de « choses à vérifier chez un client » : *quel CNI, et applique-t-il les policies ?*

10. **Bonus, si tu as 20 minutes : un cluster avec un vrai CNI.** Crée un second cluster sans CNI par défaut et installe Cilium :
    ```bash
    cat <<EOF > kind-cilium.yaml
    kind: Cluster
    apiVersion: kind.x-k8s.io/v1alpha4
    networking:
      disableDefaultCNI: true
      kubeProxyMode: none
    EOF
    kind create cluster --name labnet --config kind-cilium.yaml
    helm repo add cilium https://helm.cilium.io && helm repo update
    helm install cilium cilium/cilium -n kube-system --set kubeProxyReplacement=true \
      --set k8sServiceHost=labnet-control-plane --set k8sServicePort=6443
    kubectl -n kube-system rollout status ds/cilium
    ```
    Rejoue les points 1 et 9 : cette fois le default deny bloque, et tu dois ajouter une policy autorisant DNS puis `api` pour que ça repasse. `kubectl -n kube-system exec ds/cilium -- cilium monitor --type drop` te montre les paquets refusés en direct. Supprime ce cluster ensuite (`kind delete cluster --name labnet`) ou garde-le pour l'étape 12.

11. **Nettoie** : `kubectl delete namespace lab4`. Garde ingress-nginx, il resservira.

---

## Validé si…

- Tu sais dire pourquoi `kubectl get endpoints` est la première commande sur un service injoignable, et quelles sont les trois causes d'un `<none>`.
- Tu sais écrire le nom DNS complet d'un Service et expliquer le problème `ndots`.
- Tu sais expliquer la différence entre un Ingress et un ingress controller, et ce qui se passe quand `ingressClassName` est faux.
- Tu sais lire un 404 / 502 / 503 / 504 renvoyé par un ingress controller et dire où regarder.
- Tu sais pourquoi une NetworkPolicy peut être présente et sans effet, et quoi vérifier chez un client.

**Étape suivante** : `etape-05-stockage.md` — PV, PVC, StorageClass, CSI, et ce qui change d'un client à l'autre.
