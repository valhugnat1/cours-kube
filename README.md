# Cours Kube

Le cours Kubernetes / Helm d'Hugo, découpé en leçons de 5 minutes lisibles sur téléphone, avec schémas, quiz, pile « À revoir », contrôles de partie, page « Commandes » et progression synchronisée entre appareils.

- **Contenu** : `sources/` (le cours complet) → `src/content/lecons/` (les micro-leçons, générées par Claude Code avec `/lecon`).
- **Site** : Astro, statique, hébergé sur Cloudflare Pages.
- **Progression** : une Pages Function + une base D1, l'utilisateur étant identifié par Cloudflare Access.

## Mise en place (une fois, ~15 min)

### 1. La base D1

Cloudflare → **Storage & Databases → D1 → Create database**, nom `cours-kube`.
Ouvre-la → **Console**, colle le contenu de `schema.sql`, exécute.
Copie le **Database ID** et remplace `A_REMPLIR` dans `wrangler.toml` (édition directe sur GitHub, commit sur `main`).

### 2. Le site

Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → ce dépôt.

- Framework preset : **Astro**
- Build command : `npm run build`
- Output directory : `dist`
- Variable d'environnement : `NODE_VERSION` = `22`

Le binding D1 est lu dans `wrangler.toml` : rien à configurer côté dashboard. Chaque branche poussée obtient son URL d'aperçu.

### 3. L'accès privé

Le contenu reprend des notions internes : le site ne doit être lisible que par toi.

1. Projet Pages → **Settings → General → Enable access policy** (protège les aperçus `*.cours-kube.pages.dev`).
2. **Manage Access policy** → dans l'application créée, **Configure**, retire le `*` du hostname pour couvrir aussi `cours-kube.pages.dev`, enregistre ; puis réactive **Enable access policy** côté Pages pour que les aperçus restent protégés.
3. Politique : **Allow**, règle *Emails* = ton adresse.
4. Zero Trust → **Settings → Authentication** : active **One-time PIN**.
5. Dans l'application Access, passe la **durée de session** à 1 mois pour ne pas te reconnecter tous les jours.

Vérifie en navigation privée : la page de connexion Cloudflare doit apparaître, et `/api/progression` ne doit rien renvoyer sans connexion.

### 4. Sur ton téléphone

Ouvre `https://cours-kube.pages.dev`, connecte-toi avec le code reçu par email, puis **Partager → Sur l'écran d'accueil**. Le point en haut à droite indique la synchro : vert = synchronisé, orange = hors ligne (la progression est gardée localement et repart à la connexion suivante).

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
npm run build && npx wrangler pages dev dist
```
