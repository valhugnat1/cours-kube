// Précisions à la demande : Hugo sélectionne un passage d'une leçon, choisit le type d'explication,
// et un robot (GitHub Action + Claude Code sur l'abonnement) rédige une précision affichée sous le passage.
//
// Côté lecteur (identifié par Cloudflare Access) :
//   GET    /api/precisions?lecon=ID   -> précisions de la leçon + estimation de durée
//   POST   /api/precisions            -> nouvelle demande, déclenche le robot (repository_dispatch)
//   DELETE /api/precisions/:id        -> supprime (et annule si en cours)
//
// Côté robot (en-tête Authorization: Bearer ROBOT_SECRET) :
//   GET    /api/robot/precisions/:id  -> la demande à traiter
//   POST   /api/robot/precisions/:id  -> avancement (statut, activité, réponse, erreur, lien du run)

export interface EnvPrecisions {
  DB: D1Database;
  /** Jeton GitHub (fine-grained, Contents: read & write sur le dépôt) pour déclencher le robot. */
  GITHUB_TOKEN?: string;
  /** Dépôt qui porte le workflow du robot, owner/nom. */
  GITHUB_REPO?: string;
  /** Secret partagé avec la GitHub Action. */
  ROBOT_SECRET?: string;
}

export const NIVEAUX = ['zero', 'details', 'exemple', 'autrement'] as const;
type Niveau = (typeof NIVEAUX)[number];
type Statut = 'envoyee' | 'demarree' | 'redaction' | 'prete' | 'erreur';
const ACTIFS: Statut[] = ['envoyee', 'demarree', 'redaction'];

const DEPOT_PAR_DEFAUT = 'valhugnat1/cours-kube';
const MAX_ACTIVES = 3;
const MAX_PAR_JOUR = 40;
const SILENCE_MAX_MS = 12 * 60_000; // sans nouvelles du robot depuis ce délai : erreur
const ESTIMATION_PAR_DEFAUT_MS = 120_000;

type Ligne = {
  id: string; email: string; lecon: string; bloc: number; passage: string; contexte: string;
  niveau: Niveau; question: string; precedente: string | null; statut: Statut; activite: string;
  reponse: string; erreur: string; run_url: string; cree: number; maj: number; demarree: number | null; finie: number | null;
};

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

let tablePrete = false;
async function table(env: EnvPrecisions) {
  if (tablePrete) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS precisions (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, lecon TEXT NOT NULL, bloc INTEGER NOT NULL DEFAULT 0,
      passage TEXT NOT NULL, contexte TEXT NOT NULL DEFAULT '', niveau TEXT NOT NULL, question TEXT NOT NULL DEFAULT '',
      precedente TEXT, statut TEXT NOT NULL, activite TEXT NOT NULL DEFAULT '', reponse TEXT NOT NULL DEFAULT '',
      erreur TEXT NOT NULL DEFAULT '', run_url TEXT NOT NULL DEFAULT '',
      cree INTEGER NOT NULL, maj INTEGER NOT NULL, demarree INTEGER, finie INTEGER)`,
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS precisions_lecon ON precisions (email, lecon)').run();
  tablePrete = true;
}

/** Ce que le navigateur voit d'une précision. */
const publique = (l: Ligne) => ({
  id: l.id, lecon: l.lecon, bloc: l.bloc, passage: l.passage, niveau: l.niveau, question: l.question,
  precedente: l.precedente, statut: l.statut, activite: l.activite, reponse: l.reponse, erreur: l.erreur,
  run_url: l.run_url, cree: l.cree, maj: l.maj, demarree: l.demarree, finie: l.finie,
});

const texte = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------------------------------------------------------------- Lecteur

export async function routePrecisions(request: Request, env: EnvPrecisions, email: string, pathname: string) {
  await table(env);
  const m = pathname.match(/^\/api\/precisions(?:\/([\w-]+))?\/?$/);
  if (!m) return json({ erreur: 'introuvable' }, 404);
  const id = m[1];
  if (!id && request.method === 'GET') return lister(request, env, email);
  if (!id && request.method === 'POST') return creer(request, env, email);
  if (id && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM precisions WHERE id = ? AND email = ?').bind(id, email).run();
    return json({ ok: true });
  }
  return json({ erreur: 'méthode non autorisée' }, 405);
}

async function lister(request: Request, env: EnvPrecisions, email: string) {
  const lecon = new URL(request.url).searchParams.get('lecon') ?? '';
  const maintenant = Date.now();
  // Le robot ne donne plus signe de vie : on le dit plutôt que de laisser tourner le compteur.
  await env.DB.prepare(
    `UPDATE precisions SET statut = 'erreur', erreur = ?1, maj = ?2, finie = ?2
     WHERE email = ?3 AND statut IN ('envoyee','demarree','redaction') AND maj < ?4`,
  ).bind('Le robot n’a pas donné de nouvelles depuis 12 min. Réessaie, ou regarde le run sur GitHub.', maintenant, email, maintenant - SILENCE_MAX_MS).run();

  const { results } = await env.DB.prepare('SELECT * FROM precisions WHERE email = ? AND lecon = ? ORDER BY cree')
    .bind(email, lecon).all<Ligne>();
  const durees = await env.DB.prepare(
    `SELECT finie - cree AS d FROM precisions WHERE email = ? AND statut = 'prete' AND finie IS NOT NULL ORDER BY finie DESC LIMIT 8`,
  ).bind(email).all<{ d: number }>();
  const ds = durees.results.map((r) => r.d).filter((d) => d > 0);
  const estimation = ds.length ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) : ESTIMATION_PAR_DEFAUT_MS;
  return json({ precisions: results.map(publique), estimation_ms: estimation, base_estimation: ds.length, maintenant });
}

async function creer(request: Request, env: EnvPrecisions, email: string) {
  let corps: Record<string, unknown>;
  try { corps = await request.json(); } catch { return json({ erreur: 'JSON invalide' }, 400); }
  const lecon = texte(corps.lecon, 200);
  const passage = texte(corps.passage, 600);
  const niveau = corps.niveau as Niveau;
  if (!/^[\w-]+\/[\w-]+$/.test(lecon)) return json({ erreur: 'leçon invalide' }, 400);
  if (passage.length < 2) return json({ erreur: 'passage trop court' }, 400);
  if (!NIVEAUX.includes(niveau)) return json({ erreur: 'type d’explication inconnu' }, 400);

  const maintenant = Date.now();
  const compte = await env.DB.prepare(
    `SELECT SUM(statut IN ('envoyee','demarree','redaction')) AS actives, SUM(cree > ?2) AS jour
     FROM precisions WHERE email = ?1`,
  ).bind(email, maintenant - 86_400_000).first<{ actives: number | null; jour: number | null }>();
  if ((compte?.actives ?? 0) >= MAX_ACTIVES)
    return json({ erreur: `Déjà ${MAX_ACTIVES} précisions en cours : attends qu’une arrive.` }, 429);
  if ((compte?.jour ?? 0) >= MAX_PAR_JOUR)
    return json({ erreur: `Limite de ${MAX_PAR_JOUR} précisions par jour atteinte (elle protège ton quota Claude).` }, 429);

  const precedente = texte(corps.precedente, 40) || null;
  const ligne: Ligne = {
    id: crypto.randomUUID(), email, lecon, bloc: Math.max(0, Math.min(999, Number(corps.bloc) || 0)), passage,
    contexte: texte(corps.contexte, 2000), niveau, question: texte(corps.question, 500), precedente,
    statut: 'envoyee', activite: 'Demande envoyée, on réveille le robot sur GitHub', reponse: '', erreur: '', run_url: '',
    cree: maintenant, maj: maintenant, demarree: null, finie: null,
  };

  const depart = await declencher(env, ligne.id, new URL(request.url).origin);
  if (!depart.ok) { ligne.statut = 'erreur'; ligne.erreur = depart.erreur; ligne.finie = maintenant; ligne.activite = ''; }

  await env.DB.prepare(
    `INSERT INTO precisions (id, email, lecon, bloc, passage, contexte, niveau, question, precedente, statut, activite,
       reponse, erreur, run_url, cree, maj, demarree, finie)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '', ?12, '', ?13, ?13, NULL, ?14)`,
  ).bind(ligne.id, email, lecon, ligne.bloc, passage, ligne.contexte, niveau, ligne.question, precedente,
    ligne.statut, ligne.activite, ligne.erreur, maintenant, ligne.finie).run();
  return json(publique(ligne), depart.ok ? 201 : 502);
}

async function declencher(env: EnvPrecisions, id: string, origine: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
  if (!env.GITHUB_TOKEN) return { ok: false, erreur: 'Le Worker n’a pas de secret GITHUB_TOKEN : le robot ne peut pas être réveillé (voir README, « Précisions à la demande »).' };
  if (!env.ROBOT_SECRET) return { ok: false, erreur: 'Le Worker n’a pas de secret ROBOT_SECRET (voir README, « Précisions à la demande »).' };
  try {
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO || DEPOT_PAR_DEFAUT}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cours-kube-worker',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'precision', client_payload: { id, origine } }),
    });
    if (r.status === 204) return { ok: true };
    return { ok: false, erreur: `GitHub a refusé de lancer le robot (HTTP ${r.status}). Vérifie le jeton GITHUB_TOKEN du Worker.` };
  } catch {
    return { ok: false, erreur: 'GitHub injoignable depuis le Worker. Réessaie dans un instant.' };
  }
}

// ---------------------------------------------------------------- Robot

function robotAutorise(request: Request, env: EnvPrecisions) {
  const attendu = env.ROBOT_SECRET;
  const recu = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!attendu || recu.length !== attendu.length) return false;
  let diff = 0;
  for (let i = 0; i < attendu.length; i++) diff |= attendu.charCodeAt(i) ^ recu.charCodeAt(i);
  return diff === 0;
}

export async function routeRobot(request: Request, env: EnvPrecisions, pathname: string) {
  if (!robotAutorise(request, env)) return json({ erreur: 'non autorisé' }, 401);
  await table(env);
  const id = pathname.match(/^\/api\/robot\/precisions\/([\w-]+)\/?$/)?.[1];
  if (!id) return json({ erreur: 'introuvable' }, 404);
  const ligne = await env.DB.prepare('SELECT * FROM precisions WHERE id = ?').bind(id).first<Ligne>();
  // Supprimée par Hugo entre-temps : le robot s'arrête.
  if (!ligne) return json({ erreur: 'annulée' }, 410);

  if (request.method === 'GET') {
    const prec = ligne.precedente
      ? await env.DB.prepare('SELECT niveau, reponse FROM precisions WHERE id = ? AND email = ?')
        .bind(ligne.precedente, ligne.email).first<{ niveau: string; reponse: string }>()
      : null;
    const autres = await env.DB.prepare(
      `SELECT passage, niveau FROM precisions WHERE email = ? AND lecon = ? AND statut = 'prete' AND id != ? ORDER BY cree DESC LIMIT 5`,
    ).bind(ligne.email, ligne.lecon, id).all<{ passage: string; niveau: string }>();
    return json({
      id, lecon: ligne.lecon, passage: ligne.passage, contexte: ligne.contexte, niveau: ligne.niveau,
      question: ligne.question, statut: ligne.statut, precedente: prec, deja_demande: autres.results,
    });
  }

  if (request.method === 'POST') {
    if (!ACTIFS.includes(ligne.statut)) return json({ erreur: 'déjà terminée' }, 409);
    let c: Record<string, unknown>;
    try { c = await request.json(); } catch { return json({ erreur: 'JSON invalide' }, 400); }
    const statut = c.statut as Statut | undefined;
    if (statut && ![...ACTIFS, 'prete', 'erreur'].includes(statut)) return json({ erreur: 'statut inconnu' }, 400);
    const maintenant = Date.now();
    const maj: Partial<Ligne> = { maj: maintenant };
    // Le statut n'avance que vers l'avant : un message en retard ne fait pas reculer le compteur.
    if (statut && (statut === 'prete' || statut === 'erreur' || ACTIFS.indexOf(statut) >= ACTIFS.indexOf(ligne.statut))) maj.statut = statut;
    if (typeof c.activite === 'string') maj.activite = texte(c.activite, 200);
    if (typeof c.run_url === 'string' && /^https:\/\/github\.com\//.test(c.run_url)) maj.run_url = texte(c.run_url, 300);
    if (maj.statut === 'demarree' && !ligne.demarree) maj.demarree = maintenant;
    if (maj.statut === 'prete') {
      const reponse = texte(c.reponse, 12_000);
      if (!reponse) return json({ erreur: 'réponse vide' }, 400);
      Object.assign(maj, { reponse, finie: maintenant, activite: '' });
    }
    if (maj.statut === 'erreur') Object.assign(maj, { erreur: texte(c.erreur, 500) || 'Le robot a échoué.', finie: maintenant, activite: '' });

    const champs = Object.keys(maj) as (keyof Ligne)[];
    await env.DB.prepare(`UPDATE precisions SET ${champs.map((k, i) => `${k} = ?${i + 2}`).join(', ')} WHERE id = ?1`)
      .bind(id, ...champs.map((k) => maj[k] ?? null)).run();
    return json({ ok: true });
  }
  return json({ erreur: 'méthode non autorisée' }, 405);
}
