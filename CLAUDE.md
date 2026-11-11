# Cours Kube

Site perso d'Hugo pour apprendre Kubernetes/Helm appliqués au déploiement d'une plateforme LLM chez des clients (on-prem, GCP, private cloud, air-gapped). Il le lit **surtout sur téléphone**, par sessions de 5 minutes, et suit sa progression entre téléphone et PC.

Tout est en français. Tutoiement.

## Ce qu'il y a ici

| Chemin | Rôle |
|---|---|
| `sources/` | Le cours complet en Markdown, une étape par fichier. **Source de vérité du contenu.** Ne pas modifier sans demande explicite. |
| `sources/00-plan-roadmap.md` | Le plan : 25 étapes (0 à 24) en 5 parties A à E. |
| `src/content/lecons/<NN-etape>/` | Les micro-leçons générées à partir des sources (MDX). |
| `src/data/etapes.ts` | Liste des étapes et nom du dossier de chacune. |
| `src/content.config.ts` | Schéma du frontmatter des leçons (validé au build). |
| `scripts/check-lecons.mjs` | Contrôle qualité : longueur, schémas, quiz, syntaxe mermaid, scènes animées. |
| `src/components/` | Encadrés des leçons : `Idee`, `Analogie`, `Terrain`, `Piege`, `Retenir`, `Compare` + `Cas`. |
| `src/scripts/scenes.ts` | Schémas animés pas à pas : lignes `%% scene:` dans un bloc mermaid (syntaxe dans `scenes-syntaxe.js`). |
| `worker/index.ts` | Worker Cloudflare : sert le site et l'API de progression (D1). |

## Générer des leçons

Utilise le skill **`/lecon`** (`.claude/skills/lecon/SKILL.md`) : `/lecon etape-05` ou `/lecon 5`. Il découpe l'étape source en leçons de 5 minutes, écrit les quiz, le récap animé et le lab, vérifie, et pousse une branche.

Règles non négociables, détaillées dans le skill :

- Une leçon = une idée, 180 à 550 mots de prose, au moins un schéma mermaid **vertical** (`flowchart TD`), un seul encadré `<Retenir>`, 3 ou 4 questions de quiz.
- **Méthode pédagogique** (Hugo apprend par l'image) : chaque leçon s'ouvre par `<Idee>` (l'idée en une phrase simple), puis `<Analogie>` (un seul univers d'analogie par étape, filé de leçon en leçon), puis le schéma. Schémas avec **une couleur par rôle** (`:::ext`, `:::regle`, `:::moteur`, `:::cible`, `:::ko`), noms concrets, ✔ et ✘. Tableaux d'exemples « cas, résultat », face-à-face `<Compare>`, ancrage `<Terrain>`. La première leçon d'une étape donne la carte de l'étape ; le récap finit par le glossaire « Les mots de l'étape ». Exigé par le contrôle qualité à partir de l'étape 4 ; l'étape 4 est la référence.
- Les commandes vont dans le champ `commandes` du frontmatter (5 max), pas dans des blocs bash. Les exercices clavier vont dans **un lab** par étape (`90-lab-….mdx`, `type: lab`).
- Chaque étape finit par **un récap** (`80-recap-….mdx`, `type: recap`) : un grand schéma animé de toute l'étape (lignes `%% scene:`), sans quiz.
- Fidélité aux sources : on reformule et on découpe, on n'invente pas de faits techniques. Un ajout hors source doit être vérifié (doc officielle) et rester marginal.
- Chaînes YAML du frontmatter **toujours entre guillemets doubles** (les `:` et les backticks cassent le YAML sinon).
- Dans le corps MDX : pas d'accolades `{ }` ni de `<mot>` hors code (MDX les interprète). Mets-les entre backticks.

## Commandes

```bash
npm install
npm run check        # contrôle qualité + build complet : doit passer avant tout commit
npm run dev          # aperçu local (sans synchro de progression)
```

## Git

- Une branche par étape générée : `lecons/etape-NN`. Une PR par branche.
- Chaque push déclenche un aperçu Cloudflare (URL dans la PR) ; Hugo relit sur son téléphone puis merge.
- Ne pas toucher à `worker/`, `wrangler.jsonc` ni au design (`src/styles`, `src/components`) dans une PR de contenu.
