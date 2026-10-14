# Étape 0 — Environnement de travail et prérequis

**Objectif** : à la fin de cette étape, tu as un cluster Kubernetes local qui tourne, tous les outils installés proprement, et tu comprends assez Docker, le réseau et YAML pour que rien de ce qui suit ne te semble magique.

**Notions couvertes** : §17 (environnement de travail et outillage CLI), prérequis Docker / réseau / YAML.

---

## 0.1 Ce qu'est vraiment un conteneur

Un conteneur n'est **pas** une petite machine virtuelle. C'est un processus Linux tout à fait normal, qui tourne sur le noyau de la machine hôte, avec deux mécanismes du noyau autour :

- **Namespaces** : ce que le processus *voit*. Il a son propre arbre de processus (il se croit PID 1), sa propre interface réseau, son propre système de fichiers (l'image), ses propres utilisateurs. Il ne voit pas le reste de la machine.
- **cgroups** : ce que le processus *peut consommer*. CPU, mémoire, I/O. Si le cgroup mémoire est dépassé, le noyau tue le processus.

Pourquoi c'est important pour toi : dans Kubernetes, `resources.limits.memory` est un cgroup. Un pod `OOMKilled` n'est rien d'autre qu'un processus tué par le noyau parce qu'il a dépassé son cgroup. Et le processus PID 1 du conteneur (celui de ton `ENTRYPOINT`) est celui qui reçoit les signaux d'arrêt — s'il ne les gère pas, Kubernetes attend puis tue brutalement.

Pour le voir de tes yeux :

```bash
docker run -d --name test nginx
ps aux | grep nginx        # le processus est visible sur l'hôte
docker exec test ps aux    # depuis l'intérieur, nginx se croit seul au monde
docker rm -f test
```

---

## 0.2 Images, couches et registries

Une **image** est une pile de couches en lecture seule. Chaque instruction du Dockerfile (`RUN`, `COPY`…) crée une couche. Quand un conteneur démarre, Docker ajoute une fine couche en écriture par-dessus, jetée à la suppression du conteneur. Conséquences pratiques :

- Les couches sont mises en cache : mets les instructions qui changent rarement (installation des dépendances) avant celles qui changent souvent (copie du code).
- Deux images qui partagent des couches ne les téléchargent qu'une fois — ça compte énormément quand tu déploies des dizaines de pods chez un client.

**Tag vs digest** : `nginx:1.27` est une étiquette *mobile* — le contenu derrière peut changer. `nginx@sha256:abc…` est un digest, *immuable*. Pour des déploiements clients reproductibles (et en air-gapped), on finit toujours par raisonner en digests.

**Registry** : le nom complet d'une image est `registre/espace/nom:tag`. Quand tu écris `nginx`, Docker complète en `docker.io/library/nginx:latest`. Chez les clients, les images viendront d'un registre privé (le leur, ou un miroir), qui demande une authentification — c'est ce que Kubernetes appelle un `imagePullSecret`, on y reviendra à l'étape 6.

**ENTRYPOINT vs CMD** : `ENTRYPOINT` est le programme, `CMD` ses arguments par défaut. Kubernetes les surcharge respectivement avec `command:` et `args:` — retiens la correspondance, elle piège tout le monde.

**Multi-stage build** : on compile dans une image lourde, on copie le résultat dans une image légère.

```dockerfile
FROM python:3.12 AS build
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv sync --frozen --no-dev
COPY . .

FROM python:3.12-slim
WORKDIR /app
COPY --from=build /app /app
ENTRYPOINT ["/app/.venv/bin/uvicorn"]
CMD ["main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Note le `--host 0.0.0.0` : c'est le point suivant.

---

## 0.3 Réseau : le minimum vital

**IP et port.** Un service écoute sur une adresse et un port. `127.0.0.1` (localhost) n'est joignable que depuis l'intérieur du conteneur ; `0.0.0.0` signifie « toutes les interfaces ». Le bug numéro un du débutant : une app qui écoute sur `127.0.0.1` dans un conteneur, injoignable depuis l'extérieur, alors que « ça marche en local ».

**DNS.** Traduit un nom en adresse IP. Dans Kubernetes, un service interne s'appelle par exemple `postgres.data.svc.cluster.local` et c'est CoreDNS qui répond. Deux commandes à connaître : `dig nom` (détaillé) et `nslookup nom` (disponible partout).

**TLS.** Un certificat, c'est une identité (le nom de domaine) liée à une clé publique, signée par une autorité (CA) en qui ton client fait confiance. Trois idées suffisent pour l'instant :

- La *chaîne de confiance* : certificat → CA intermédiaire → CA racine. Un maillon manquant = erreur « unknown authority ».
- La *terminaison TLS* : l'endroit où le chiffrement s'arrête. Chez un client, c'est souvent la gateway d'entrée ; derrière, les pods se parlent en HTTP clair. C'est pour ça que certains avertissements « contexte non sécurisé » sont des faux positifs (étape 22).
- `curl -v https://…` te montre toute la négociation ; `openssl s_client -connect hôte:443 -servername hôte` te montre le certificat servi.

**Codes HTTP.** `curl -i` affiche le code de statut. Un diagnostic commence toujours par un code, jamais par « ça marche pas » (étape 20).

---

## 0.4 YAML sans se faire piéger

Tu vas écrire et lire du YAML toute la journée. Les règles, et les pièges :

- Indentation en **espaces**, jamais en tabulations. Deux espaces par niveau par convention.
- Une liste se note avec `-` ; un dictionnaire avec `clé: valeur`. Une liste d'objets mélange les deux :
  ```yaml
  env:
    - name: LOG_LEVEL
      value: info
  ```
- **Le piège des types.** `yes`, `no`, `on`, `off`, `true`, `false` deviennent des booléens ; `1.10` devient le nombre `1.1` ; `012` peut devenir de l'octal. Une valeur qui doit rester une chaîne se met entre guillemets : `value: "1.10"`, `tag: "latest"`. Dans un ConfigMap, **toutes** les valeurs doivent être des chaînes.
- Texte multi-lignes : `|` conserve les retours à la ligne (scripts, certificats), `>` les replie en une seule ligne.
- `---` sépare plusieurs documents dans un même fichier — un manifeste Kubernetes en contient souvent des dizaines.
- Pour valider sans rien appliquer : `kubectl apply --dry-run=client -f fichier.yaml`. Pour lire ou requêter : `yq '.spec.template' fichier.yaml`.

Go templating (Helm) viendra à l'étape 7 ; inutile de l'aborder avant d'être à l'aise avec le YAML brut.

---

## 0.5 Installer l'outillage

Les outils, et à quoi ils servent :

| Outil | Rôle |
|---|---|
| `kubectl` | parler à l'API Kubernetes |
| `helm` | installer et gérer des charts |
| `k9s` | interface texte pour explorer un cluster (étape 19) |
| `kind` | créer un cluster Kubernetes local dans Docker |
| `gcloud` + plugin d'auth GKE | accéder aux clusters GCP |
| `uv` | gérer Python et ses dépendances sans casser le système |
| `yq`, `jq` | lire/transformer du YAML et du JSON |
| `kubectx` / `kubens` | changer de cluster / de namespace sans se tromper |

Sur macOS avec Homebrew (sur Linux : mêmes noms via `brew`, ou les binaires GitHub de chaque projet) :

```bash
brew install kubectl helm k9s kind yq jq kubectx uv
brew install --cask google-cloud-sdk
gcloud components install gke-gcloud-auth-plugin
```

**Règle de base avant de toucher à ton shell : regarde ce qui existe déjà.**

```bash
echo $PATH | tr ':' '\n'   # un chemin par ligne, lisible
type -a kubectl            # toutes les versions trouvées, dans l'ordre
```

Si `type -a` renvoie deux `kubectl` (un de Homebrew, un de Docker Desktop, un de gcloud…), tu as un doublon et c'est le *premier* qui gagne. Résous ça avant d'ajouter une ligne `export PATH=…` dans `.zshrc` — empiler des lignes à l'aveugle est la source de la moitié des « ça marchait hier ».

**Versions.** `kubectl` doit être à ±1 version mineure du cluster (`kubectl version` affiche les deux). Helm 3 uniquement — si tu croises une doc qui parle de Tiller, elle est de l'ère Helm 2, ignore-la.

---

## 0.6 Les pièges d'environnement du terrain

Ce sont des cas réels, à reconnaître plutôt qu'à subir.

**Outils sensibles au répertoire courant.** Certains scripts internes cherchent leur config à partir du dossier courant ou d'une variable de racine de dépôt (`REPO_ROOT`, `PROJECT_DIR`…). Réflexe : les lancer depuis la racine du dépôt, et vérifier la variable avec `echo $REPO_ROOT` avant de conclure que « l'outil est cassé ».

**Variables d'environnement parasites.** Les harnais d'agents IA (Claude Code, Cursor…) posent des variables comme `AGENT=1` dans le shell qu'ils ouvrent. Si un outil valide sa configuration en lisant toutes les variables commençant par un préfixe, cette variable inattendue fait échouer la validation avec un message sans rapport. Réflexe : `env | sort` quand un outil se comporte bizarrement depuis un terminal d'agent mais pas depuis ton terminal normal, puis `env -u AGENT commande` pour tester sans.

**`$HOME` non inscriptible.** Dans un conteneur qui tourne avec un utilisateur arbitraire (OpenShift le fait par défaut), `$HOME` pointe vers un dossier en lecture seule, et Helm ou kubectl refusent de démarrer parce qu'ils veulent écrire leur cache. Contournement : `HOME=/tmp helm …`, ou plus propre, `HELM_CACHE_HOME`, `HELM_CONFIG_HOME` et `KUBECONFIG` pointant vers un dossier inscriptible.

**Versions d'interpréteur et réinstallation.** Un outil Python interne exige souvent une version précise (`requires-python` dans `pyproject.toml`). Avec `uv`, `uv sync` respecte cette contrainte et crée l'environnement. Après avoir mis à jour le code de l'outil (`git pull`), un `uv sync --reinstall` évite les erreurs fantômes dues à une ancienne version installée en mode éditable.

**Documentation interne périmée.** Quand la doc dit « lance `outil deploy --env X` » et que l'outil installé n'a plus l'option `--env`, ne force pas. Note l'écart explicitement (« doc : version N, installé : version N+3, l'option a été remplacée par… »), fais fonctionner avec la version réelle, et propose le correctif de doc. Signaler un écart est un signe de sérieux, pas d'incompétence.

---

## 0.7 Exercice — à faire clavier en main

1. **Vérifie la toolchain** :
   ```bash
   kubectl version --client && helm version && k9s version && kind version && uv --version
   type -a kubectl helm   # aucun doublon
   ```

2. **Crée un cluster local** (Docker doit tourner) :
   ```bash
   kind create cluster --name lab
   kubectl cluster-info
   kubectl get nodes        # un nœud Ready
   kubectl get pods -A      # les composants système, tous Running
   ```

3. **Déploie quelque chose avec Helm** — un chart généré, sans dépendre d'un registre externe :
   ```bash
   helm create demo
   helm install demo ./demo
   kubectl get pods         # un pod demo-… Running
   ```

4. **Ouvre k9s**, tape `:pods` puis Entrée, sélectionne le pod, appuie sur `l` pour les logs, `Échap` pour revenir, `:q` pour quitter. Rien de plus pour l'instant.

5. **Fais-le échouer volontairement** : dans `demo/values.yaml`, remplace `tag: ""` par `tag: "n-existe-pas"`, puis `helm upgrade demo ./demo`. Observe `kubectl get pods` : le statut doit passer à `ImagePullBackOff`. Lis `kubectl describe pod <nom>` jusqu'à trouver la ligne qui l'explique. Remets le tag et re-upgrade.

6. **Nettoie** : `helm uninstall demo` (garde le cluster, on le réutilise).

---

## Validé si…

Tu peux expliquer à voix haute :

- pourquoi un conteneur qui écoute sur `127.0.0.1` est injoignable ;
- pourquoi `"1.10"` a besoin de guillemets ;
- ce qu'est un `OOMKilled` ;
- où tu vas regarder quand un outil marche dans ton terminal mais pas dans celui de Claude Code.

**Étape suivante** : `etape-01-architecture-modele-declaratif.md` — architecture et modèle déclaratif.
