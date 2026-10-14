// Quiz : QCM interactif, une question à la fois, réponse immédiate avec explication.
// Utilisé en fin de leçon, dans « À revoir » et dans les contrôles de partie.
//
// Deux modes :
// - score (contrôles, « À revoir ») : chaque question une fois, on compte les bonnes réponses ;
// - maîtrise (fin de leçon) : les questions ratées reviennent en fin de série jusqu'au sans-faute.
// Seule la première réponse à une question est enregistrée : une erreur corrigée dans la foulée
// reste dans « À revoir ».

import { enregistrerReponse } from './progression';

export type Question = {
  id: string;
  q: string;
  choix: string[];
  bonne: number;
  explication: string;
  titre?: string;
  url?: string;
};

type Options = {
  afficherSource?: boolean;          // lien vers la leçon d'origine (révisions, contrôles)
  melanger?: boolean;
  maitrise?: boolean;                // les ratées reviennent jusqu'au sans-faute
  // Dernière question répondue (sans-faute atteint en mode maîtrise), avant l'écran final.
  // score = bonnes réponses du premier coup.
  onTermine?: (score: number, total: number) => void;
  onFini?: (score: number, total: number) => void;
};

type EtatQuestion = 'a-faire' | 'juste' | 'ratee' | 'a-reprendre';

const LETTRES = ['A', 'B', 'C', 'D'];

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
// `code` dans les textes de quiz
const md = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const doux = (): ScrollBehavior =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

function melanger<T>(t: T[]): T[] {
  const a = [...t];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function monterQuiz(racine: HTMLElement, questions: Question[], opts: Options = {}) {
  const qs = opts.melanger ? melanger(questions) : questions;
  const n = qs.length;
  const etats: EtatQuestion[] = qs.map(() => 'a-faire');
  const file = qs.map((_, k) => k);   // questions restant à poser, dans l'ordre
  const vues = new Set<number>();
  let score = 0;
  let posees = 0;
  let cur = -1;
  let repondu = false;

  const rail = () =>
    `<ol class="quiz-rail" aria-hidden="true">${etats
      .map((e, k) => `<li class="${e}${k === cur ? ' courante' : ''}"></li>`)
      .join('')}</ol>`;

  // Garde le haut du quiz visible quand son contenu change (téléphone).
  const remonter = () => {
    if (racine.getBoundingClientRect().top < 56) racine.scrollIntoView({ block: 'start', behavior: doux() });
  };

  const poser = () => {
    if (!file.length) return fin();
    cur = file.shift()!;
    repondu = false;
    const q = qs[cur];
    const reprise = vues.has(cur);
    if (!reprise) posees++;
    const restantes = etats.filter((e) => e === 'a-reprendre').length;
    const compteur = reprise
      ? `On reprend · ${restantes === 1 ? 'dernière question à corriger' : `${restantes} questions à corriger`}`
      : `Question ${posees} sur ${n}`;
    // Choix mélangés à l'affichage pour ne pas apprendre « c'est toujours la B ».
    const ordre = melanger(q.choix.map((_, k) => k));
    racine.innerHTML = `
      ${rail()}
      <p class="quiz-compteur">${compteur}</p>
      <p class="quiz-question">${md(q.q)}</p>
      ${opts.afficherSource && q.url ? `<p class="quiz-source">Leçon : <a href="${q.url}">${esc(q.titre ?? '')}</a></p>` : ''}
      <div class="quiz-choix" role="group" aria-label="Choix de réponse">
        ${ordre
          .map(
            (k, i) => `<button type="button" class="quiz-option" data-k="${k}" style="--i:${i}">
              <span class="quiz-lettre" aria-hidden="true">${LETTRES[i]}</span>
              <span class="quiz-texte">${md(q.choix[k])}</span>
            </button>`,
          )
          .join('')}
      </div>
      <div class="quiz-retour" aria-live="polite"></div>`;
    racine.querySelectorAll<HTMLButtonElement>('.quiz-option').forEach((b) =>
      b.addEventListener('click', () => repondre(Number(b.dataset.k))),
    );
    remonter();
  };

  const repondre = (k: number) => {
    if (repondu) return;
    repondu = true;
    const q = qs[cur];
    const ok = k === q.bonne;
    const premiere = !vues.has(cur);
    vues.add(cur);
    if (premiere) {
      enregistrerReponse(q.id, ok);
      if (ok) score++;
    }
    etats[cur] = ok ? 'juste' : opts.maitrise ? 'a-reprendre' : 'ratee';
    if (!ok && opts.maitrise) file.push(cur);

    racine.querySelectorAll<HTMLButtonElement>('.quiz-option').forEach((b) => {
      b.disabled = true;
      const kb = Number(b.dataset.k);
      const lettre = b.querySelector('.quiz-lettre')!;
      if (kb === q.bonne) { b.classList.add('juste'); lettre.textContent = '✓'; }
      else if (kb === k) { b.classList.add('faux'); lettre.textContent = '✗'; }
    });
    racine.querySelector('.quiz-rail')!.outerHTML = rail();

    const termine = file.length === 0;
    const retour = racine.querySelector<HTMLElement>('.quiz-retour')!;
    retour.innerHTML = `
      <div class="quiz-verdict ${ok ? 'juste' : 'faux'}">
        <p class="quiz-verdict-titre">${ok ? (premiere ? 'Juste.' : 'Juste, cette fois.') : 'Pas tout à fait.'}</p>
        <p>${md(q.explication)}</p>
        ${!ok && opts.maitrise ? '<p class="quiz-reprise">Elle reviendra en fin de série.</p>' : ''}
      </div>
      <button type="button" class="bouton">${termine ? 'Voir le résultat' : 'Question suivante'}</button>`;
    const suite = retour.querySelector('button')!;
    suite.addEventListener('click', poser);
    suite.focus({ preventScroll: true });
    retour.scrollIntoView({ block: 'nearest', behavior: doux() });
    if (termine) opts.onTermine?.(score, n);
  };

  const fin = () => {
    cur = -1;
    racine.innerHTML = opts.maitrise
      ? `<div class="quiz-fin">
          <div class="quiz-tampon" aria-hidden="true"><b>✓</b><span>Validée</span></div>
          <p class="quiz-fin-titre">Leçon validée</p>
          <p>${score === n ? 'Sans-faute du premier coup.' : `${score} sur ${n} du premier coup. Les ratées t’attendent aussi dans «\u00a0À revoir\u00a0».`}</p>
        </div>`
      : `<div class="quiz-fin">
          <div class="quiz-anneau">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle class="fond" cx="60" cy="60" r="52" />
              ${score ? `<circle class="valeur" cx="60" cy="60" r="52" pathLength="100" style="--pct:${(100 * score) / n}" />` : ''}
            </svg>
            <p class="quiz-score"><strong>${score}</strong><span>sur ${n}</span></p>
          </div>
          <p>${score === n ? 'Tout juste.' : 'Les questions ratées sont dans «\u00a0À revoir\u00a0».'}</p>
        </div>`;
    remonter();
    opts.onFini?.(score, n);
  };

  // Sur PC : touches A à D (ou 1 à 4) pour répondre, quand le quiz est à l'écran.
  const touche = (ev: KeyboardEvent) => {
    if (!racine.isConnected) return document.removeEventListener('keydown', touche);
    if (repondu || cur < 0 || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if ((ev.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return;
    const r = racine.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const i = Math.max('abcd'.indexOf(ev.key.toLowerCase()), '1234'.indexOf(ev.key));
    const b = racine.querySelectorAll<HTMLButtonElement>('.quiz-option')[i];
    if (ev.key.length === 1 && b) { ev.preventDefault(); b.click(); }
  };
  document.addEventListener('keydown', touche);

  poser();
}
