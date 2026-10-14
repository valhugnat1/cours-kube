// Worker du site : sert les pages statiques (dist/) et l'API de progression.
//
// GET  /api/progression -> état de progression de l'utilisateur connecté
// PUT  /api/progression -> fusionne l'état envoyé avec celui stocké, renvoie le résultat
//
// Les fichiers statiques sont servis avant le Worker : seules les URL qui ne
// correspondent à aucun fichier arrivent ici.
// L'utilisateur est identifié par Cloudflare Access (en-tête Cf-Access-Authenticated-User-Email).
// Sans Access (dev local), tout le monde partage l'identité "local".

interface Env { DB: D1Database; ASSETS: Fetcher }

type Etat = {
  v: 1;
  lues: Record<string, number>; // date de lecture, négative si remise en non lue
  reponses: Record<string, { ok: boolean; t: number }>;
  controles: Record<string, { score: number; total: number; t: number }>;
};

const vide = (): Etat => ({ v: 1, lues: {}, reponses: {}, controles: {} });

// Même règle que src/scripts/progression.ts : lecture (> 0) ou retrait (< 0), le plus récent gagne.
const plusRecente = (x = 0, y = 0) => (Math.abs(x) >= Math.abs(y) ? x : y);

function fusionner(a: Etat, b: Etat): Etat {
  const out = vide();
  for (const k of new Set([...Object.keys(a.lues ?? {}), ...Object.keys(b.lues ?? {})])) {
    out.lues[k] = plusRecente(a.lues?.[k], b.lues?.[k]);
  }
  for (const champ of ['reponses', 'controles'] as const) {
    const ka = (a[champ] ?? {}) as Record<string, { t: number }>;
    const kb = (b[champ] ?? {}) as Record<string, { t: number }>;
    for (const k of new Set([...Object.keys(ka), ...Object.keys(kb)])) {
      const x = ka[k], y = kb[k];
      (out[champ] as Record<string, unknown>)[k] = !x ? y : !y ? x : x.t >= y.t ? x : y;
    }
  }
  return out;
}

const qui = (req: Request) =>
  (req.headers.get('cf-access-authenticated-user-email') ?? 'local').toLowerCase();

async function charger(env: Env, email: string): Promise<Etat> {
  const ligne = await env.DB.prepare('SELECT data FROM progression WHERE email = ?')
    .bind(email)
    .first<{ data: string }>();
  return ligne ? { ...vide(), ...JSON.parse(ligne.data) } : vide();
}

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function lireProgression(request: Request, env: Env) {
  return json(await charger(env, qui(request)));
}

async function ecrireProgression(request: Request, env: Env) {
  const corps = await request.text();
  if (corps.length > 500_000) return json({ erreur: 'état trop volumineux' }, 413);
  let recu: Etat;
  try { recu = JSON.parse(corps); } catch { return json({ erreur: 'JSON invalide' }, 400); }
  const email = qui(request);
  const fusion = fusionner(await charger(env, email), recu);
  await env.DB.prepare(
    `INSERT INTO progression (email, data, maj) VALUES (?1, ?2, ?3)
     ON CONFLICT(email) DO UPDATE SET data = ?2, maj = ?3`,
  ).bind(email, JSON.stringify(fusion), Date.now()).run();
  return json(fusion);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/progression') {
      if (request.method === 'GET') return lireProgression(request, env);
      if (request.method === 'PUT') return ecrireProgression(request, env);
      return json({ erreur: 'méthode non autorisée' }, 405);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
