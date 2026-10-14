// Progression : stockée localement (marche hors ligne) et synchronisée avec /api/progression
// (Cloudflare Pages Function + D1, identité fournie par Cloudflare Access).
// Fusion par clé, la date la plus récente gagne : tél et PC peuvent écrire sans se marcher dessus.

export type Etat = {
  v: 1;
  lues: Record<string, number>;                         // id leçon -> date de lecture (négative : remise en non lue à cette date)
  reponses: Record<string, { ok: boolean; t: number }>; // id question -> dernier résultat
  controles: Record<string, { score: number; total: number; t: number }>;
};

const CLE = 'ck:progression';
const vide = (): Etat => ({ v: 1, lues: {}, reponses: {}, controles: {} });

// Lecture (> 0) ou retrait (< 0) : le plus récent gagne, pour qu'un « non lue » se propage aussi.
const plusRecente = (x = 0, y = 0) => (Math.abs(x) >= Math.abs(y) ? x : y);

export function fusionner(a: Etat, b: Etat): Etat {
  const out = vide();
  for (const k of new Set([...Object.keys(a.lues), ...Object.keys(b.lues)])) {
    out.lues[k] = plusRecente(a.lues[k], b.lues[k]);
  }
  for (const champ of ['reponses', 'controles'] as const) {
    const ka = a[champ] as Record<string, { t: number }>;
    const kb = b[champ] as Record<string, { t: number }>;
    for (const k of new Set([...Object.keys(ka), ...Object.keys(kb)])) {
      const x = ka[k], y = kb[k];
      (out[champ] as Record<string, unknown>)[k] = !x ? y : !y ? x : x.t >= y.t ? x : y;
    }
  }
  return out;
}

export function lire(): Etat {
  try {
    const brut = localStorage.getItem(CLE);
    if (!brut) return vide();
    const e = JSON.parse(brut);
    return { ...vide(), ...e };
  } catch {
    return vide();
  }
}

function ecrire(e: Etat) {
  try { localStorage.setItem(CLE, JSON.stringify(e)); } catch { /* stockage indisponible */ }
  document.dispatchEvent(new CustomEvent('progression', { detail: e }));
}

let envoiPrevu: ReturnType<typeof setTimeout> | undefined;
let enAttente = false;
function envoyer() {
  clearTimeout(envoiPrevu);
  enAttente = true;
  envoiPrevu = setTimeout(pousser, 400);
}

async function pousser() {
  clearTimeout(envoiPrevu);
  enAttente = false;
  try {
    const r = await fetch('/api/progression', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lire()),
      keepalive: true,
    });
    if (r.ok) ecrire(fusionner(lire(), await r.json()));
    statutSynchro(r.ok ? 'ok' : 'hors-ligne');
  } catch {
    statutSynchro('hors-ligne');
  }
}

// Page quittée ou app mise en arrière-plan avant la fin du délai : on envoie tout de suite.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && enAttente) pousser();
});

function statutSynchro(s: 'ok' | 'hors-ligne') {
  document.documentElement.dataset.synchro = s;
}

/** À appeler au chargement de chaque page : récupère l'état serveur et fusionne. */
export async function synchroniser() {
  try {
    const r = await fetch('/api/progression', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const serveur = (await r.json()) as Etat;
    const local = lire();
    const fusion = fusionner(local, { ...vide(), ...serveur });
    ecrire(fusion);
    statutSynchro('ok');
    if (JSON.stringify(fusion) !== JSON.stringify(serveur)) envoyer();
  } catch {
    statutSynchro('hors-ligne');
    ecrire(lire());
  }
}

export const estLue = (e: Etat, id: string) => (e.lues[id] ?? 0) > 0;

// Toujours plus récent que l'état remplacé, même si l'horloge de cet appareil retarde un peu.
const apres = (e: Etat, id: string) => Math.max(Date.now(), Math.abs(e.lues[id] ?? 0) + 1);

export function marquerLue(id: string) {
  const e = lire();
  if (!estLue(e, id)) { e.lues[id] = apres(e, id); ecrire(e); envoyer(); }
}

export function marquerNonLue(id: string) {
  const e = lire();
  if (estLue(e, id)) { e.lues[id] = -apres(e, id); ecrire(e); envoyer(); }
}

export function enregistrerReponse(qid: string, ok: boolean) {
  const e = lire();
  e.reponses[qid] = { ok, t: Date.now() };
  ecrire(e);
  envoyer();
}

export function enregistrerControle(partie: string, score: number, total: number) {
  const e = lire();
  e.controles[partie] = { score, total, t: Date.now() };
  ecrire(e);
  envoyer();
}

/** Questions dont la dernière réponse était fausse. */
export const aRevoir = (e: Etat) => Object.entries(e.reponses).filter(([, r]) => !r.ok).map(([k]) => k);
