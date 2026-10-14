// Quiz : une question à la fois, réponse immédiate avec explication.
// Utilisé en fin de leçon, dans « À revoir » et dans les contrôles de partie.

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
  onFini?: (score: number, total: number) => void;
  libelleFin?: string;
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
// `code` dans les textes de quiz
const md = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

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
  let i = 0;
  let score = 0;

  const rendre = () => {
    if (i >= qs.length) return fin();
    const q = qs[i];
    // Choix mélangés à l'affichage pour ne pas apprendre « c'est toujours la B ».
    const ordre = melanger(q.choix.map((_, k) => k));
    racine.innerHTML = `
      <p class="quiz-compteur">Question ${i + 1} sur ${qs.length}</p>
      <p class="quiz-question">${md(q.q)}</p>
      ${opts.afficherSource && q.url ? `<p class="discret">Leçon : <a href="${q.url}">${esc(q.titre ?? '')}</a></p>` : ''}
      <div class="quiz-choix" role="group" aria-label="Choix de réponse">
        ${ordre.map((k) => `<button type="button" class="quiz-option" data-k="${k}">${md(q.choix[k])}</button>`).join('')}
      </div>
      <div class="quiz-retour" aria-live="polite"></div>`;
    racine.querySelectorAll<HTMLButtonElement>('.quiz-option').forEach((b) =>
      b.addEventListener('click', () => repondre(Number(b.dataset.k))),
    );
  };

  const repondre = (k: number) => {
    const q = qs[i];
    const ok = k === q.bonne;
    if (ok) score++;
    enregistrerReponse(q.id, ok);
    racine.querySelectorAll<HTMLButtonElement>('.quiz-option').forEach((b) => {
      b.disabled = true;
      const kb = Number(b.dataset.k);
      if (kb === q.bonne) b.classList.add('juste');
      else if (kb === k) b.classList.add('faux');
    });
    const retour = racine.querySelector('.quiz-retour')!;
    retour.innerHTML = `
      <p class="quiz-verdict ${ok ? 'juste' : 'faux'}">${ok ? 'Juste.' : 'Pas tout à fait.'}</p>
      <p>${md(q.explication)}</p>
      <button type="button" class="bouton">${i + 1 < qs.length ? 'Question suivante' : 'Voir le résultat'}</button>`;
    retour.querySelector('button')!.addEventListener('click', () => { i++; rendre(); });
  };

  const fin = () => {
    racine.innerHTML = `
      <p class="quiz-question">${score} / ${qs.length}</p>
      <p>${score === qs.length ? 'Tout juste.' : 'Les questions ratées sont dans « À revoir ».'}</p>`;
    opts.onFini?.(score, qs.length);
  };

  rendre();
}
