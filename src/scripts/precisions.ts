// Précisions à la demande, côté leçon.
// 1. Hugo sélectionne un passage de la leçon : une pastille « Pas compris ? » apparaît
//    (en bas de l'écran au doigt, au-dessus de la sélection à la souris).
// 2. Il choisit le type d'explication dans une feuille : pars de zéro, plus de détails, un exemple, autrement.
// 3. Une carte se glisse sous le passage et suit le robot en direct : étapes, activité, chrono, estimation.
// 4. La précision arrive dans la carte, avec de quoi relancer (plus simple, plus de détails) ou supprimer.
// API : worker/precisions.ts.

import { markdownEnHtml } from './markdown-mini';
import { rendreSchemas } from './schemas';

type Niveau = 'zero' | 'details' | 'exemple' | 'autrement';
type Statut = 'envoyee' | 'demarree' | 'redaction' | 'prete' | 'erreur';
type Precision = {
  id: string; lecon: string; bloc: number; passage: string; niveau: Niveau; question: string; precedente: string | null;
  statut: Statut; activite: string; reponse: string; erreur: string; run_url: string;
  cree: number; maj: number; demarree: number | null; finie: number | null;
};

const NIVEAUX: Record<Niveau, { titre: string; sous: string }> = {
  zero: { titre: 'Je ne connais pas du tout', sous: 'On repart de zéro, avec une image simple' },
  details: { titre: 'Donne-moi plus de détails', sous: 'Le mécanisme : qui fait quoi, dans quel ordre' },
  exemple: { titre: 'Montre-moi un exemple', sous: 'Un cas concret chez un client' },
  autrement: { titre: 'Explique autrement', sous: 'Un autre angle, un schéma' },
};
const ETAPES: { statut: Statut; nom: string }[] = [
  { statut: 'envoyee', nom: 'Envoyée' },
  { statut: 'demarree', nom: 'Robot réveillé' },
  { statut: 'redaction', nom: 'Claude rédige' },
  { statut: 'prete', nom: 'Prête' },
];
const actif = (p: Precision) => p.statut === 'envoyee' || p.statut === 'demarree' || p.statut === 'redaction';

const echapper = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const normaliser = (s: string) => s.replace(/\s+/g, ' ').trim();
const court = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const chrono = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function initPrecisions() {
  const racine = document.querySelector<HTMLElement>('[data-precisions]');
  const article = document.querySelector<HTMLElement>('article.contenu');
  if (!racine || !article) return;
  const lecon = racine.dataset.lecon!;
  const pastille = racine.querySelector<HTMLButtonElement>('.pc-pastille')!;
  const feuille = racine.querySelector<HTMLDialogElement>('.pc-feuille')!;
  const toast = racine.querySelector<HTMLButtonElement>('.pc-toast')!;
  const toucher = matchMedia('(pointer: coarse)');

  let precisions: Precision[] = [];
  let estimation = 120_000;
  let decalage = 0; // horloge serveur - horloge locale
  let prochain: ReturnType<typeof setTimeout> | undefined;
  let tic: ReturnType<typeof setInterval> | undefined;
  const pretesNonVues = new Set<string>();
  const replies = new Set<string>(JSON.parse(stockLire('ck:precisions-repliees') ?? '[]'));

  // ------------------------------------------------------------ Blocs de la leçon
  const blocs = () => Array.from(article.children).filter((e) => !e.classList.contains('precision')) as HTMLElement[];
  const blocDe = (n: Node | null): HTMLElement | null => {
    let e = n instanceof Element ? n : n?.parentElement ?? null;
    while (e && e.parentElement !== article) e = e.parentElement;
    return e && !e.classList.contains('precision') ? (e as HTMLElement) : null;
  };
  /** Le bloc où placer une précision : celui qui contient encore le passage, sinon le même rang. */
  const ancre = (p: Precision) => {
    const bs = blocs();
    const cible = normaliser(p.passage).toLowerCase();
    const contient = (b?: HTMLElement) => !!b && normaliser(b.textContent ?? '').toLowerCase().includes(cible);
    if (contient(bs[p.bloc])) return bs[p.bloc];
    return bs.find(contient) ?? bs[Math.min(p.bloc, bs.length - 1)];
  };

  // ------------------------------------------------------------ Sélection -> pastille
  let selection: { passage: string; contexte: string; bloc: number } | null = null;
  let attente: ReturnType<typeof setTimeout> | undefined;
  let masquage: ReturnType<typeof setTimeout> | undefined;

  document.addEventListener('selectionchange', () => {
    clearTimeout(attente);
    attente = setTimeout(lireSelection, toucher.matches ? 350 : 150);
  });

  function lireSelection() {
    const sel = document.getSelection();
    const texte = normaliser(sel?.toString() ?? '');
    const el = sel && sel.rangeCount ? blocDe(sel.getRangeAt(0).commonAncestorContainer) : null;
    if (!sel || sel.isCollapsed || texte.length < 2 || !el) {
      clearTimeout(masquage);
      masquage = setTimeout(() => { if (!feuille.open) cacherPastille(); }, 400);
      return;
    }
    clearTimeout(masquage);
    selection = { passage: court(texte, 600), contexte: court(normaliser(el.textContent ?? ''), 2000), bloc: blocs().indexOf(el) };
    pastille.querySelector('.pc-pastille-texte')!.textContent = `« ${court(texte, 34)} »`;
    pastille.hidden = false;
    placerPastille(sel.getRangeAt(0));
  }

  function placerPastille(r: Range) {
    if (toucher.matches) { pastille.classList.add('en-bas'); pastille.style.removeProperty('top'); pastille.style.removeProperty('left'); return; }
    pastille.classList.remove('en-bas');
    const rect = r.getBoundingClientRect();
    const larg = pastille.offsetWidth || 220;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - larg / 2), innerWidth - larg - 8);
    const top = rect.top - 52 > 64 ? rect.top - 52 : rect.bottom + 12;
    pastille.style.left = `${left}px`;
    pastille.style.top = `${top}px`;
  }
  const cacherPastille = () => { pastille.hidden = true; };
  addEventListener('scroll', () => { if (!pastille.hidden && !toucher.matches) cacherPastille(); }, { passive: true });

  // Garder la sélection visible pendant l'appui sur la pastille.
  pastille.addEventListener('pointerdown', (e) => e.preventDefault());
  pastille.addEventListener('click', () => { if (selection) ouvrirFeuille(); });

  // ------------------------------------------------------------ Feuille de choix
  const champQuestion = feuille.querySelector<HTMLTextAreaElement>('textarea')!;
  const erreurFeuille = feuille.querySelector<HTMLElement>('.pc-feuille-erreur')!;

  function ouvrirFeuille() {
    if (!selection) return;
    feuille.querySelector('.pc-feuille-passage')!.textContent = court(selection.passage, 220);
    champQuestion.value = '';
    erreurFeuille.hidden = true;
    cacherPastille();
    feuille.showModal();
    // Au doigt, ne pas ouvrir le clavier d'office : on veut voir les quatre choix.
    if (!toucher.matches) feuille.querySelector<HTMLButtonElement>('.pc-choix button')?.focus();
  }
  feuille.addEventListener('click', (e) => { if (e.target === feuille) feuille.close(); });
  feuille.querySelector('.pc-fermer')!.addEventListener('click', () => feuille.close());
  feuille.querySelectorAll<HTMLButtonElement>('.pc-choix button').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!selection) return;
      const s = selection;
      feuille.querySelectorAll<HTMLButtonElement>('.pc-choix button').forEach((x) => (x.disabled = true));
      const ok = await demander({ passage: s.passage, contexte: s.contexte, bloc: s.bloc, niveau: b.dataset.niveau as Niveau, question: champQuestion.value });
      feuille.querySelectorAll<HTMLButtonElement>('.pc-choix button').forEach((x) => (x.disabled = false));
      if (ok === true) {
        feuille.close();
        document.getSelection()?.removeAllRanges();
        selection = null;
      } else {
        erreurFeuille.textContent = ok;
        erreurFeuille.hidden = false;
      }
    });
  });

  // ------------------------------------------------------------ API
  async function demander(d: { passage: string; contexte: string; bloc: number; niveau: Niveau; question: string; precedente?: string }): Promise<true | string> {
    try {
      const r = await fetch('/api/precisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lecon, ...d }) });
      const corps = await r.json().catch(() => null);
      if (!corps || (!r.ok && !corps.id)) return corps?.erreur ?? `Le site a répondu HTTP ${r.status}.`;
      precisions.push(corps as Precision);
      afficher();
      document.querySelector(`.precision[data-id="${corps.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      planifier(800);
      return true;
    } catch {
      return 'Impossible de joindre le site. En aperçu local (npm run dev), l’API n’existe pas : lance wrangler dev.';
    }
  }

  async function rafraichir() {
    try {
      const r = await fetch(`/api/precisions?lecon=${encodeURIComponent(lecon)}`, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      decalage = d.maintenant - Date.now();
      estimation = d.estimation_ms;
      const avant = new Map(precisions.map((p) => [p.id, p.statut]));
      precisions = d.precisions;
      for (const p of precisions) {
        const a = avant.get(p.id);
        if (a && a !== 'prete' && p.statut === 'prete') signalerPrete(p);
      }
      afficher();
    } catch { /* hors ligne : on réessaiera */ } finally {
      planifier();
    }
  }

  function planifier(delai?: number) {
    clearTimeout(prochain);
    if (!precisions.some(actif) && delai === undefined) return;
    prochain = setTimeout(rafraichir, delai ?? (document.visibilityState === 'visible' ? 3000 : 15000));
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && precisions.some(actif)) rafraichir(); });

  async function supprimer(id: string) {
    precisions = precisions.filter((p) => p.id !== id);
    afficher();
    await fetch(`/api/precisions/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  // ------------------------------------------------------------ Cartes
  function afficher() {
    const vus = new Set<string>();
    for (const p of precisions) {
      vus.add(p.id);
      let carte = article.querySelector<HTMLElement>(`.precision[data-id="${p.id}"]`);
      if (!carte) {
        carte = document.createElement('section');
        carte.className = 'precision encart px';
        carte.dataset.id = p.id;
        carte.setAttribute('aria-live', 'polite');
        const a = ancre(p);
        // Plusieurs précisions sur le même bloc : dans l'ordre d'arrivée, à la suite.
        let apres: Element | undefined = a;
        while (apres?.nextElementSibling?.classList.contains('precision')) apres = apres.nextElementSibling;
        if (apres) apres.after(carte); else article.append(carte);
      }
      if (carte.dataset.statut !== p.statut || carte.dataset.activite !== p.activite || carte.dataset.lien !== p.run_url) {
        carte.dataset.statut = p.statut;
        carte.dataset.activite = p.activite;
        carte.dataset.lien = p.run_url;
        remplir(carte, p);
      }
    }
    article.querySelectorAll<HTMLElement>('.precision').forEach((c) => { if (!vus.has(c.dataset.id!)) c.remove(); });
    clearInterval(tic);
    if (precisions.some(actif)) tic = setInterval(battre, 1000);
    battre();
  }

  function remplir(carte: HTMLElement, p: Precision) {
    const n = NIVEAUX[p.niveau];
    const tete = `<p class="encart-titre">Précision · ${echapper(n.titre)}</p>
      <p class="pc-cite">« ${echapper(court(p.passage, 160))} »${p.question ? `<br/><span class="pc-question">Ta question : ${echapper(court(p.question, 200))}</span>` : ''}</p>`;
    const lien = p.run_url ? `<a class="pc-lien" href="${echapper(p.run_url)}" target="_blank" rel="noopener">Voir le robot sur GitHub ↗</a>` : '';

    if (actif(p)) {
      const rang = ETAPES.findIndex((e) => e.statut === p.statut);
      carte.innerHTML = `${tete}
        <ol class="pc-etapes">${ETAPES.map((e, i) => `<li class="${i < rang ? 'faite' : i === rang ? 'courante' : ''}"><i></i>${e.nom}</li>`).join('')}</ol>
        <p class="pc-activite">${echapper(p.activite || 'En attente du robot')}</p>
        <div class="pc-chrono"><span class="pc-temps" data-depuis="${p.cree}">0:00</span><span class="pc-estim"></span></div>
        <div class="cases pc-barre" aria-hidden="true">${'<i></i>'.repeat(20)}</div>
        <div class="pc-actions">${lien}<button type="button" class="pc-mini" data-action="supprimer">Annuler</button></div>`;
    } else if (p.statut === 'erreur') {
      carte.innerHTML = `${tete}
        <p class="pc-erreur">✘ ${echapper(p.erreur || 'Le robot a échoué.')}</p>
        <div class="pc-actions">${lien}<button type="button" class="pc-mini" data-action="relancer" data-niveau="${p.niveau}">Réessayer</button><button type="button" class="pc-mini" data-action="supprimer">Supprimer</button></div>`;
    } else {
      const repliee = replies.has(p.id);
      carte.innerHTML = `${tete}
        <div class="pc-reponse"${repliee ? ' hidden' : ''}>${markdownEnHtml(p.reponse)}</div>
        <div class="pc-actions">
          <button type="button" class="pc-mini" data-action="replier">${repliee ? 'Déplier' : 'Replier'}</button>
          ${p.niveau !== 'zero' ? '<button type="button" class="pc-mini" data-action="relancer" data-niveau="zero">Encore plus simple</button>' : '<button type="button" class="pc-mini" data-action="relancer" data-niveau="autrement">Autrement</button>'}
          ${p.niveau !== 'details' ? '<button type="button" class="pc-mini" data-action="relancer" data-niveau="details">Plus de détails</button>' : '<button type="button" class="pc-mini" data-action="relancer" data-niveau="exemple">Un exemple</button>'}
          <button type="button" class="pc-mini" data-action="supprimer">Supprimer</button>
        </div>`;
      carte.classList.toggle('repliee', repliee);
      rendreSchemas(carte);
    }
    carte.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => b.addEventListener('click', () => agir(p, b)));
  }

  async function agir(p: Precision, b: HTMLButtonElement) {
    const action = b.dataset.action;
    if (action === 'supprimer') return supprimer(p.id);
    if (action === 'replier') {
      if (replies.has(p.id)) replies.delete(p.id); else replies.add(p.id);
      stockEcrire('ck:precisions-repliees', JSON.stringify([...replies]));
      const carte = b.closest<HTMLElement>('.precision')!;
      delete carte.dataset.statut;
      afficher();
      return;
    }
    if (action === 'relancer') {
      b.disabled = true;
      const relance = p.statut === 'erreur';
      if (relance) await supprimer(p.id);
      const ok = await demander({
        passage: p.passage, contexte: '', bloc: p.bloc, niveau: b.dataset.niveau as Niveau, question: p.question,
        precedente: relance ? undefined : p.id,
      });
      if (ok !== true) { b.disabled = false; montrerToast(ok, null); }
    }
  }

  // ------------------------------------------------------------ Chrono, barre, toast
  function battre() {
    const maintenant = Date.now() + decalage;
    for (const p of precisions.filter(actif)) {
      const carte = article.querySelector<HTMLElement>(`.precision[data-id="${p.id}"]`);
      if (!carte) continue;
      const ecoule = maintenant - p.cree;
      carte.querySelector('.pc-temps')!.textContent = chrono(ecoule);
      const reste = estimation - ecoule;
      carte.querySelector('.pc-estim')!.textContent = reste > 5000
        ? `≈ encore ${chrono(reste)} (d’habitude ${chrono(estimation)})`
        : ecoule < estimation * 2 ? 'presque… un peu plus long que d’habitude' : 'plus long que d’habitude, le robot travaille encore';
      // Barre : avance avec le temps, sans jamais se remplir avant l'arrivée de la réponse.
      const plein = Math.min(19, Math.floor((ecoule / estimation) * 18) + ETAPES.findIndex((e) => e.statut === p.statut));
      carte.querySelectorAll('.pc-barre i').forEach((c, i) => c.classList.toggle('pleine', i < plein));
    }
    majToast();
  }

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 60 && r.top < innerHeight;
  };

  function majToast() {
    const enCours = precisions.filter(actif);
    const pretes = precisions.filter((p) => pretesNonVues.has(p.id));
    for (const p of pretes) {
      const c = article.querySelector(`.precision[data-id="${p.id}"]`);
      if (c && visible(c)) pretesNonVues.delete(p.id);
    }
    const prete = precisions.find((p) => pretesNonVues.has(p.id));
    if (prete) return montrerToast('✓ Ta précision est prête · voir', prete.id, true);
    const suivie = enCours.find((p) => { const c = article.querySelector(`.precision[data-id="${p.id}"]`); return c && !visible(c); });
    if (suivie) return montrerToast(`Précision en cours · ${chrono(Date.now() + decalage - suivie.cree)} · voir`, suivie.id);
    if (!toast.classList.contains('message')) toast.hidden = true;
  }

  let toastMessage: ReturnType<typeof setTimeout> | undefined;
  function montrerToast(texte: string, id: string | null, prete = false) {
    toast.textContent = texte;
    toast.dataset.id = id ?? '';
    toast.classList.toggle('prete', prete);
    toast.hidden = false;
    if (!id) {
      toast.classList.add('message');
      clearTimeout(toastMessage);
      toastMessage = setTimeout(() => { toast.classList.remove('message'); toast.hidden = true; }, 5000);
    }
  }
  toast.addEventListener('click', () => {
    const id = toast.dataset.id;
    if (!id) { toast.hidden = true; return; }
    article.querySelector(`.precision[data-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  addEventListener('scroll', () => { if (precisions.length) majToast(); }, { passive: true });

  const titreOrigine = document.title;
  function signalerPrete(p: Precision) {
    const c = article.querySelector(`.precision[data-id="${p.id}"]`);
    if (!c || !visible(c) || document.visibilityState !== 'visible') pretesNonVues.add(p.id);
    navigator.vibrate?.(80);
    if (document.visibilityState !== 'visible') {
      document.title = `✓ Précision prête — ${titreOrigine}`;
      document.addEventListener('visibilitychange', () => { document.title = titreOrigine; }, { once: true });
    }
  }

  rafraichir();
}

function stockLire(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function stockEcrire(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* indisponible */ } }
