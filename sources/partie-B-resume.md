# Partie B — Helm et packaging : résumé et take-aways

Récap des étapes 7 à 10. À relire avant une installation client ou une montée de version.

---

## Les 10 idées à garder en tête

1. **Helm est un client sans contrôleur.** Une release = un Secret dans le namespace avec le manifeste rendu et les values. Helm applique quand tu le lances et ne regarde plus rien ensuite ; ArgoCD, lui, réconcilie.
2. **Un template rend du texte, pas du YAML.** L'indentation est ton problème : `{{-` presque toujours à gauche, `toYaml | nindent N` pour injecter un bloc, `include` (jamais `template`), `$` pour revenir à la racine dans un `with`/`range`.
3. **selectorLabels ≠ labels.** Le selector d'un Deployment est immuable : la version n'y va jamais. Un checksum de ConfigMap en annotation du pod force le redémarrage à chaque changement de config.
4. **`upgrade` = three-way merge** (ancien rendu, nouveau rendu, état réel). `--atomic` en prod, `--timeout` adapté aux migrations longues, `--force` jamais dans un script, `--reuse-values` seulement en connaissance de cause. Une release `pending-*` se débloque par `rollback`.
5. **Dans un parapluie, chaque sous-chart ne voit que sa sous-clé de values, plus `global`.** Un sous-chart tiers qui ignore `global.imageRegistry` se surcharge clé par clé. Les templates nommés sont globaux : préfixe par chart obligatoire.
6. **Précédence : défauts du sous-chart < values du parent < `-f` dans l'ordre < `--set`.** Fusion profonde pour les dictionnaires, **remplacement pour les listes**. `null` efface une clé. `--set` sur une liste est interdit.
7. **Socle versionné / briques par dimension / fichiers client / expérimental daté**, empilés du général au particulier, dans un script versionné. Une brique = une dimension ; un fichier client ne contient que ce qui diffère.
8. **`helm template` ment quand il manque des `global`, sur `lookup`, sur `.Capabilities`, sur les webhooks mutants et sur ce qui va être supprimé.** Rendre avec la pile complète ; `--dry-run=server` ; `helm diff` pour voir les `-`.
9. **Helm installe les CRDs de `crds/` une fois et ne les touche plus jamais.** Avant tout upgrade qui change des CRDs : extraire (`helm show crds`), `kubectl apply --server-side`, puis `helm upgrade`. Les opérateurs cluster-wide (cert-manager, ESO, GPU) sont des prérequis hors chart.
10. **Plusieurs erreurs de forme simultanées = un désaccord de version.** Relever toutes les versions en une passe (chart, outil, opérateurs, CRDs, K8s, Helm) avant de corriger quoi que ce soit ; écrire la cause, pas les symptômes ; retirer les contournements en montant de version.

---

## L'appel de déploiement type

```bash
helm upgrade --install platform oci://registry/charts/platform --version 3.8.0 -n platform --create-namespace \
  -f values/base/3.8.yaml \
  -f values/platform/<cloud>.yaml \
  -f values/platform/<gpu|nogpu>.yaml \
  -f values/platform/<airgap>.yaml \
  -f values/clients/<client>/common.yaml \
  -f values/clients/<client>/<env>.yaml \
  -f <secrets hors git> \
  --atomic --timeout 15m
```

Avant : `helm show crds … | kubectl apply --server-side -f -` si la version change ; `helm diff upgrade …` pour lire les `+`/`-`. Après : `helm test`, `kubectl get pods -A -o jsonpath=…image | sort -u` en air-gapped.

---

## Commandes de compréhension d'un chart

```bash
helm pull oci://… --version X --untar          # lire un chart : values.yaml, templates/, charts/
helm show values oci://… --version X            # les défauts
helm show crds oci://… --version X              # les CRDs
helm template rel ./chart -f … --debug          # values fusionnées + rendu
helm template rel ./chart -f … --show-only charts/api/templates/deployment.yaml
helm template … | yq -N 'select(.kind=="Deployment") | .spec.template.spec.containers[].image' | sort -u
helm upgrade --install … --dry-run=server --debug   # validé par l'API, sans écrire
helm diff upgrade rel ./chart -f …              # ce qui changera, suppressions comprises
helm get values rel ; helm get manifest rel ; helm history rel
for v in …; do helm show chart oci://…/chart --version $v >/dev/null 2>&1 && echo OK $v; done   # sonder sans listing
```

---

## Erreurs Helm fréquentes et leur lecture

| Message | Cause probable |
|---|---|
| `mapping values are not allowed` / `did not find expected key` | Indentation cassée par `nindent`/`indent`/`-}}` → `--show-only` et lire |
| `nil pointer evaluating` | Clé absente dans les values → `with`, `default`, `dig` |
| `… is required` | `required` non satisfait — souvent un `global` manquant sur un sous-chart |
| `field is immutable` | Selector, `volumeClaimTemplates`, Job sans delete-policy |
| `another operation … is in progress` | Release en `pending-*` → `helm rollback` |
| `no matches for kind X in version Y` | CRD absente (opérateur/`--skip-crds`) ou API dépréciée sur ce cluster |
| `unknown field` sur une CR, ou champ disparu après `apply` | CRD pas mise à jour (rejet ou pruning) |
| `Too long: must have at most 262144 bytes` | `apply` client-side sur une grosse CRD → `--server-side` |
| `Apply failed with N conflict(s)` | Champ possédé par un autre manager (HPA, opérateur, autre outil) |
| `failed calling webhook` | Opérateur pas encore prêt (course install), ou webhook du client |
| `additionalProperty … not allowed` (schema) | Value inconnue de cette version du chart → décalage de version |
| `Job already exists` | Hook sans `before-hook-creation` |

---

## Ce qui change par environnement (l'essentiel de l'étape 10)

| | GKE | OpenShift | On-prem (kubeadm/RKE2/k3s) | Air-gapped |
|---|---|---|---|---|
| Ingress | `gce` (objets propres, lent) ou nginx derrière LB L4 | Routes ; `openshift-default` ; annotations nginx perdues | Fourni par RKE2/k3s, absent sur kubeadm | idem sous-jacent |
| LoadBalancer | Oui (interne via annotation) | Oui si NSX/MetalLB | Souvent non → NodePort/MetalLB | idem |
| Stockage | PD RWO zonal ; RWX = Filestore | ODF : rbd (RWO), cephfs (RWX) | À installer ; local-path nœud-local | idem |
| Sécurité pods | PSA ; Autopilot très restrictif | **SCC** : pas de `runAsUser`/`fsGroup` | PSA selon durcissement | idem |
| Identité cloud | Workload Identity (annotation SA + IAM) | — | — | — |
| GPU | Node pool GPU, driver géré, quota à demander | GPU Operator via OLM | GPU Operator | GPU obligatoires (pas d'inférence déportée) |
| Opérateurs | Helm | **OLM** (versions ≠ upstream) | Helm | Miroir des charts |
| Images | Artifact Registry (+ remote repos) | Registre interne + CA | Registre d'entreprise + CA sur les nœuds | Miroir par digest, liste extraite du rendu |
| Version K8s | Auto-upgrade par channel | 4.x ↔ 1.2x | Figée, souvent ancienne | Figée |

---

## Les questions de la première heure chez un client

```bash
kubectl version ; kubectl get nodes -o wide -L topology.kubernetes.io/zone,nvidia.com/gpu.product
kubectl -n kube-system get ds                                # CNI
kubectl get ingressclass ; kubectl get sc ; kubectl get volumesnapshotclass
kubectl get crd | grep -E 'cert-manager|external-secrets|postgresql|nvidia|kyverno|gatekeeper'
kubectl get deploy -A | grep -iE 'operator|manager' ; oc get csv -A 2>/dev/null
kubectl get ns --show-labels | grep pod-security
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations
kubectl get resourcequota,limitrange -n <ns>
kubectl auth can-i --list -n <ns> ; kubectl auth can-i create clusterrole
kubectl -n kube-system get cm coredns -o yaml | grep kubernetes    # domaine du cluster
kubectl run -it --rm t --image=nicolaka/netshoot -- sh -c 'env | grep -i proxy; curl -sI https://registry-1.docker.io | head -1'
```

Et à demander : comment arrivent les secrets, comment on pousse sur le registre, qui a les droits cluster-admin, fenêtres de changement, procédure d'approbation.

---

## Pièges vécus, par étape

- **7** — `template` au lieu de `include` ; version dans le selector ; `randAlphaNum` régénéré à chaque upgrade ; hook Job sans delete-policy ; `--timeout` trop court avec `--atomic` ; oublier que `helm uninstall` ne retire pas les hooks.
- **8** — `--set` sur une liste ; brique qui mélange deux dimensions ; fichier expérimental sans date qui reste en CI ; rendu sans les `global` ; `helm template` qui ne montre pas les suppressions ; tag mobile copié dans un miroir ; sous-chart tiers qui ignore `global.imageRegistry` ; `--skip-deps` (helmfile) qui saute aussi `repo update`.
- **9** — CRD élaguée silencieusement ; `apply` client-side sur une grosse CRD ; opérateur + CR dans une même release ; cert-manager embarqué alors que le client l'a déjà ; `--force-conflicts` en ping-pong avec un HPA ; corriger cinq symptômes d'un décalage de version un par un.
- **10** — Autopilot et DaemonSet privilégié ; `runAsUser` en dur sur OpenShift ; annotations nginx sur une Route ; LB `<pending>` on-prem ; `NO_PROXY` sans les CIDR du cluster ; domaine de cluster ≠ `cluster.local` ; LimitRange qui modifie les `resources` à ton insu ; image d'un init container oubliée du miroir.

---

## Auto-évaluation express

1. Pourquoi `include` plutôt que `template`, et pourquoi préfixer les templates nommés ?
2. Que fait `--atomic` exactement, et quel est son risque avec une migration longue ?
3. Dans un parapluie, où doit vivre `imagePullSecrets` pour que tous les sous-charts le voient ? Et si l'un l'ignore ?
4. Deux fichiers `-f` définissent `tolerations` : que contient le résultat ?
5. Cite trois cas où `helm template` ne montre pas ce qui va se passer.
6. Procédure complète pour monter un chart dont une CRD a changé.
7. Tu lis `conflict with "hpa-controller" … .spec.replicas` : que fais-tu ?
8. Quatre erreurs différentes apparaissent en même temps sur quatre composants : première action ?
9. Trois choses à retirer des values quand on monte de version.
10. Ce qui rend une installation impossible sur Autopilot, sur OpenShift sans SCC, en air-gapped sans GPU.

Si une réponse hésite, rouvre l'étape et refais son exercice.
