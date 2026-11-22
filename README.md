# Cours Kube

Le cours Kubernetes / Helm d'Hugo, découpé en leçons de 5 minutes lisibles sur téléphone, avec schémas, quiz, pile « À revoir », contrôles de partie, page « Commandes » et progression synchronisée entre appareils.

- **Contenu** : `sources/` (le cours complet) → `src/content/lecons/` (les micro-leçons, générées par Claude Code avec `/lecon`).
- **Site** : Astro, statique, hébergé sur Cloudflare Workers (fichiers statiques).
- **Progression** : un Worker (`worker/index.ts`) + une base D1, l'utilisateur étant identifié par Cloudflare Access.

## Mise en place (une fois, ~15 min)

### 1. La base D1

Cloudflare → **Storage & Databases → D1 → Create database**, nom `cours-kube`.
Ouvre-la → **Console**, colle le contenu de `schema.sql`, exécute.
Copie le **Database ID** et remplace `A_REMPLIR` dans `wrangler.jsonc` (édition directe sur GitHub, commit sur `main`).

### 2. Le site

Cloudflare → **Workers & Pages → Create → Import a repository** → ce dépôt.

- Build command : `npm run build`
- Deploy command : `npx wrangler deploy`
- Preview command : `npx wrangler preview`
- **Enable Preview builds** : activé (une URL d'aperçu par branche poussée)
- **Protect with Cloudflare Access** : activé

Le binding D1 et le dossier statique (`dist`) sont lus dans `wrangler.jsonc` : rien d'autre à configurer côté dashboard. Les aperçus de branche (`wrangler preview`) utilisent la même base D1 que la prod (bloc `previews`) : ce que tu lis sur un aperçu compte dans ta progression.

### 3. L'accès privé

Le contenu reprend des notions internes : le site ne doit être lisible que par toi.

1. Dans l'application Access créée par le toggle (Zero Trust → **Access → Applications**), vérifie que la politique est **Allow** avec la règle *Emails* = ton adresse, et que les URL d'aperçu sont couvertes.
2. Zero Trust → **Settings → Authentication** : active **One-time PIN**.
3. Dans l'application Access, passe la **durée de session** à 1 mois pour ne pas te reconnecter tous les jours.

Vérifie en navigation privée : la page de connexion Cloudflare doit apparaître, et `/api/progression` ne doit rien renvoyer sans connexion.

### 4. Sur ton téléphone

Ouvre l'URL du Worker (`https://cours-kube.<ton-sous-domaine>.workers.dev`), connecte-toi avec le code reçu par email, puis **Partager → Sur l'écran d'accueil**. Le point en haut à droite indique la synchro : vert = synchronisé, orange = hors ligne (la progression est gardée localement et repart à la connexion suivante).

## Précisions à la demande

Sur une leçon, sélectionne un mot ou une phrase que tu ne comprends pas. Une pastille **« ? Pas compris »** apparaît : en bas de l'écran sur téléphone, au-dessus de la sélection sur PC. Tu choisis ensuite le type d'explication (*je ne connais pas du tout*, *plus de détails*, *un exemple*, *explique autrement*), avec ta question si tu veux. Une carte se glisse sous le passage et suit le robot en direct : étapes, ce que Claude est en train de lire, chrono et estimation. La précision arrive dans la carte au bout d'1 à 3 minutes.

Comment ça marche : le Worker enregistre la demande dans D1 et réveille une GitHub Action (`repository_dispatch`). L'Action lance **Claude Code sur ton abonnement** (pas de facturation au token), en lecture seule sur `sources/` et la leçon, puis renvoie la réponse au Worker. Chaque précision compte dans tes limites d'usage Claude, comme une petite session. Le Worker plafonne à 3 précisions en parallèle et 40 par jour.

### Mise en place (une fois, ~10 min)

1. **Le jeton Claude.** Sur ton PC : `claude setup-token`, connecte-toi avec ton compte Claude et copie le jeton. GitHub → ce dépôt → **Settings → Secrets and variables → Actions → New repository secret** : `CLAUDE_CODE_OAUTH_TOKEN`.
2. **Le secret partagé robot ↔ site.** Génère une chaîne aléatoire (`openssl rand -hex 32`). Ajoute-la sous le nom `ROBOT_SECRET` à deux endroits : dans les secrets GitHub du dépôt, et dans Cloudflare → Worker `cours-kube` → **Settings → Variables and Secrets** (type *Secret*).
3. **Le jeton GitHub du Worker** (pour réveiller l'Action). GitHub → **Settings → Developer settings → Fine-grained tokens** : accès à ce seul dépôt, permission **Contents : Read and write**. Ajoute-le au Worker comme secret `GITHUB_TOKEN`.
4. **Laisser passer le robot à travers Cloudflare Access.** Zero Trust → **Access → Service credentials → Service Tokens → Create** (nom `robot-precisions`, durée sans expiration). Copie le *Client ID* et le *Client Secret* dans les secrets GitHub `CF_ACCESS_CLIENT_ID` et `CF_ACCESS_CLIENT_SECRET`. Puis dans l'application Access du site, **ajoute une politique** : action **Service Auth**, règle *Service Token* = `robot-precisions`.
5. **L'adresse du site.** GitHub → **Settings → Secrets and variables → Actions → Variables** : `SITE_URL` = `https://cours-kube.<ton-sous-domaine>.workers.dev`. Le robot n'envoie son secret qu'à cette adresse et à ses aperçus de branche.
6. Optionnel : variable `PRECISION_MODELE` (`sonnet` par défaut, `opus` pour des explications plus fouillées mais plus lentes).

Le workflow ne se déclenche qu'une fois `.github/workflows/precision.yml` présent sur `main` (règle GitHub pour `repository_dispatch`). La table D1 `precisions` se crée toute seule au premier appel.

En cas de souci, la carte affiche l'erreur et un lien **« Voir le robot sur GitHub »** vers le run (logs complets, consigne envoyée à Claude, réponse brute).

## Générer les leçons suivantes

Depuis l'app Claude (onglet **Code**) ou claude.ai/code, sur ce dépôt (l'app GitHub Claude doit y être installée) :

```
/lecon 2
```

Claude lit `sources/etape-02-…`, découpe en leçons, écrit quiz et lab, lance `npm run check`, pousse `lecons/etape-02` et ouvre la PR. Relis l'aperçu Cloudflare sur ton téléphone, puis merge. Les étapes 23 et 24 n'ont pas encore de source : le skill l'écrit d'abord et le signale dans la PR.

## Développement local

```bash
npm install
npm run dev                         # le site, sans synchro
npm run check                       # contrôle qualité des leçons + build

# Avec la synchro (D1 locale) :
npx wrangler d1 execute cours-kube --local --file schema.sql
npm run build && npx wrangler dev
```
