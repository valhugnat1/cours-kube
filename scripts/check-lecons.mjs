#!/usr/bin/env node
// Contrôle qualité des leçons, lancé par `npm run check` et par la CI.
// Le schéma des champs est déjà vérifié par Astro (src/content.config.ts) ;
// ici on vérifie ce qui fait une bonne leçon de 5 minutes lue sur téléphone.
//
// Usage : node scripts/check-lecons.mjs [dossier-etape ...]   (par défaut : toutes)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse } from 'yaml';
import { JSDOM } from 'jsdom';

// mermaid a besoin d'un DOM pour valider la syntaxe des schémas.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false });
const { lireScenes } = await import('../src/scripts/scenes-syntaxe.js');
const aValider = []; // [chemin, source]

const RACINE = 'src/content/lecons';
const DOSSIERS = Object.fromEntries(
  [...readFileSync('src/data/etapes.ts', 'utf8').matchAll(/n: (\d+), partie: '\w', titre: '[^']*', dossier: '([^']+)'/g)]
    .map((m) => [m[2], Number(m[1])]),
);

const LIMITES = { motsMin: 180, motsMax: 550, schemasMin: 1, codeLignesMax: 16, blocsCodeMax: 2, noeudsMax: 10 };
// Le récap de fin d'étape : un grand schéma animé, peu de prose, pas de quiz.
const RECAP = { motsMin: 120, motsMax: 700, noeudsMax: 24, scenesMin: 5, scenesMax: 14 };
const SCENES = { min: 3, max: 14, texteMax: 260 };

const erreurs = [];
const avertissements = [];
const err = (f, m) => erreurs.push(`${f} : ${m}`);
const avert = (f, m) => avertissements.push(`${f} : ${m}`);

const cibles = process.argv.slice(2).length
  ? process.argv.slice(2)
  : existsSync(RACINE) ? readdirSync(RACINE).filter((d) => statSync(join(RACINE, d)).isDirectory()) : [];

let nbLecons = 0;
for (const dossier of cibles) {
  const d = join(RACINE, basename(dossier));
  if (!(basename(dossier) in DOSSIERS)) { err(d, `dossier inconnu (voir src/data/etapes.ts)`); continue; }
  if (!existsSync(d)) { err(d, 'dossier absent'); continue; }
  const fichiers = readdirSync(d).filter((f) => f.endsWith('.mdx')).sort();
  const ordres = new Set();
  let nbL = 0, nbLab = 0, nbRecap = 0;

  for (const f of fichiers) {
    const chemin = join(d, f);
    const m = f.match(/^(\d{2})-[a-z0-9]+(-[a-z0-9]+)*\.mdx$/);
    if (!m) { err(chemin, 'nom attendu : NN-slug-en-minuscules.mdx'); continue; }
    const brut = readFileSync(chemin, 'utf8');
    const fm = brut.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fm) { err(chemin, 'frontmatter manquant'); continue; }
    let data;
    try { data = parse(fm[1]); } catch (e) { err(chemin, `YAML invalide : ${e.message.split('\n')[0]}`); continue; }
    const corps = fm[2];

    if (data.etape !== DOSSIERS[basename(d)]) err(chemin, `etape: ${data.etape} ne correspond pas au dossier (${DOSSIERS[basename(d)]})`);
    if (data.ordre !== Number(m[1])) err(chemin, `ordre: ${data.ordre} ne correspond pas au préfixe du fichier (${Number(m[1])})`);
    if (ordres.has(data.ordre)) err(chemin, `ordre ${data.ordre} en double`);
    ordres.add(data.ordre);

    const blocs = [...corps.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
    const schemas = blocs.filter((b) => b[1] === 'mermaid');
    const codes = blocs.filter((b) => b[1] !== 'mermaid');

    const type = data.type ?? 'lecon';
    const noeudsMax = type === 'recap' ? RECAP.noeudsMax : LIMITES.noeudsMax;
    for (const s of schemas) {
      const src = s[2];
      aValider.push([chemin, src]);
      if (/^\s*(flowchart|graph)\s+(LR|RL)/m.test(src)) err(chemin, 'schéma horizontal (LR) : utiliser TD, l\'écran est étroit');
      const noeuds = new Set([...src.matchAll(/^\s*([A-Za-z0-9_]+)\s*[\[\(\{>]/gm)].map((x) => x[1]));
      for (const x of src.matchAll(/-->\|?[^|]*\|?\s*([A-Za-z0-9_]+)\s*[\[\(\{]/g)) noeuds.add(x[1]);
      if (noeuds.size > noeudsMax) avert(chemin, `schéma de ${noeuds.size} nœuds : au-delà de ${noeudsMax}, découpe-le`);
      if (/classDef|style\s+\w+\s+fill/.test(src)) avert(chemin, 'couleurs en dur dans un schéma : le thème du site gère clair/sombre');
    }
    const animes = schemas.filter((s) => lireScenes(s[2]).length);

    if (type === 'recap') {
      nbRecap++;
      if (data.quiz?.length) avert(chemin, 'un récap n\'a pas de quiz (le contrôle de partie s\'en charge)');
      const mots = motsDe(corps);
      if (mots < RECAP.motsMin || mots > RECAP.motsMax) avert(chemin, `${mots} mots : un récap vise ${RECAP.motsMin}-${RECAP.motsMax} mots, le schéma porte l'essentiel`);
      if (!animes.length) err(chemin, 'un récap a besoin d\'un grand schéma animé (lignes « %% scene: »)');
      const n = animes.length ? lireScenes(animes[0][2]).length : 0;
      if (n && (n < RECAP.scenesMin || n > RECAP.scenesMax)) avert(chemin, `grand schéma de ${n} scènes (visé ${RECAP.scenesMin}-${RECAP.scenesMax})`);
      if ((corps.match(/<Retenir>/g) ?? []).length !== 1) err(chemin, 'un récap a un seul encadré <Retenir>');
      if (!/^\d{2}-recap(-[a-z0-9]+)*\.mdx$/.test(f)) err(chemin, 'nom attendu : NN-recap-<slug>.mdx');
      continue;
    }

    if ((data.type ?? 'lecon') === 'lab') {
      nbLab++;
      if (data.quiz?.length) avert(chemin, 'un lab n\'a pas de quiz (le quiz est dans les leçons)');
      continue;
    }
    nbL++;
    nbLecons++;

    const mots = motsDe(corps);
    if (mots < LIMITES.motsMin) avert(chemin, `${mots} mots : court pour 5 min, quiz compris (visé ${LIMITES.motsMin}-${LIMITES.motsMax})`);
    if (mots > LIMITES.motsMax) err(chemin, `${mots} mots : trop long pour 5 min, découpe en deux leçons (max ${LIMITES.motsMax})`);

    if (schemas.length < LIMITES.schemasMin) err(chemin, 'aucun schéma mermaid : au moins un par leçon');
    if (codes.length > LIMITES.blocsCodeMax) err(chemin, `${codes.length} blocs de code : les commandes vont dans le frontmatter « commandes », les exercices dans le lab`);
    for (const c of codes) {
      const n = c[2].trimEnd().split('\n').length;
      if (n > LIMITES.codeLignesMax) err(chemin, `bloc de code de ${n} lignes (max ${LIMITES.codeLignesMax})`);
      if (c[1] === 'bash' || c[1] === 'sh') avert(chemin, 'bloc bash dans une leçon : préfère le champ « commandes » (copiable, agrégé dans la page Commandes)');
    }
    if (!/<Retenir>/.test(corps)) err(chemin, 'encadré <Retenir> manquant');
    if ((corps.match(/<Retenir>/g) ?? []).length > 1) err(chemin, 'un seul <Retenir> par leçon');
    if (/^#\s/m.test(corps)) err(chemin, 'pas de titre de niveau 1 dans le corps (le titre vient du frontmatter)');

    const quiz = data.quiz ?? [];
    if (quiz.length < 3 || quiz.length > 4) err(chemin, `${quiz.length} questions : il en faut 3 ou 4`);
    quiz.forEach((q, i) => {
      if (!Array.isArray(q.choix) || q.bonne >= q.choix.length) err(chemin, `question ${i + 1} : « bonne » hors des choix`);
      if (new Set(q.choix).size !== q.choix?.length) err(chemin, `question ${i + 1} : choix en double`);
      if (q.choix?.some((c) => /toutes les réponses|aucune des réponses/i.test(c))) err(chemin, `question ${i + 1} : pas de « toutes/aucune des réponses » (les choix sont mélangés)`);
    });
    const bonnes = quiz.map((q) => q.bonne);
    if (quiz.length >= 3 && new Set(bonnes).size === 1) avert(chemin, 'toutes les bonnes réponses ont le même index : varie (même si l\'affichage mélange)');
    if ((data.commandes ?? []).length > 5) err(chemin, 'plus de 5 commandes');
  }

  if (fichiers.length && nbL < 2) avert(d, `seulement ${nbL} leçon(s) : une étape fait en général 4 à 10 leçons`);
  if (fichiers.length && nbLab !== 1) avert(d, `${nbLab} lab(s) : un lab par étape est attendu (ordre 90)`);
  if (fichiers.length && nbRecap !== 1) avert(d, `${nbRecap} récap(s) : un récap animé par étape est attendu (ordre 80)`);
}

for (const [chemin, src] of aValider) {
  try { await mermaid.parse(src); }
  catch (e) { err(chemin, `schéma mermaid invalide : ${String(e.message).split('\n').slice(0, 3).join(' ')}`); continue; }
  const scenes = lireScenes(src);
  if (scenes.length) await verifierScenes(chemin, src, scenes);
}

// Chaque scène doit citer des nœuds, subgraphs et flèches qui existent dans le schéma.
async function verifierScenes(chemin, src, scenes) {
  if (scenes.length < SCENES.min || scenes.length > SCENES.max) avert(chemin, `schéma animé de ${scenes.length} scènes (visé ${SCENES.min}-${SCENES.max})`);
  const { db } = await mermaid.mermaidAPI.getDiagramFromText(src);
  const ids = new Set([...db.getVertices().keys(), ...db.getSubGraphs().map((g) => g.id)]);
  const aretes = new Set(db.getEdges().filter((a) => a.stroke !== 'invisible').flatMap((a) => [`${a.start}>${a.end}`, `${a.end}>${a.start}`]));
  scenes.forEach((s, i) => {
    const ou = `scène ${i + 1} (« ${s.titre} »)`;
    if (!s.titre || !s.texte) err(chemin, `${ou} : il faut « titre :: texte :: éléments »`);
    if (s.texte.length > SCENES.texteMax) avert(chemin, `${ou} : texte de ${s.texte.length} caractères, la légende doit tenir en 2-3 lignes (max ${SCENES.texteMax})`);
    if (!s.elements.length) err(chemin, `${ou} : aucun élément à allumer`);
    for (const el of s.elements) {
      if (el.type === 'noeud' && !ids.has(el.id)) err(chemin, `${ou} : nœud « ${el.id} » absent du schéma`);
      if (el.type === 'arete' && !aretes.has(`${el.de}>${el.vers}`)) err(chemin, `${ou} : pas de flèche entre « ${el.de} » et « ${el.vers} »`);
    }
  });
}

// Mots de prose : sans blocs de code, sans balises.
function motsDe(corps) {
  const texte = corps.replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]+>/g, ' ').replace(/[|#*`>-]/g, ' ');
  return texte.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
}

for (const a of avertissements) console.warn(`⚠  ${a}`);
for (const e of erreurs) console.error(`✗  ${e}`);
console.log(`\n${nbLecons} leçon(s) vérifiée(s), ${erreurs.length} erreur(s), ${avertissements.length} avertissement(s).`);
process.exit(erreurs.length ? 1 : 0);
