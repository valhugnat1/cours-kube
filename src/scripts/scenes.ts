// Schémas animés : un schéma mermaid qui contient des lignes « %% scene: » devient un pas à pas.
// Chaque scène allume quelques nœuds, estompe le reste, et fait circuler des jetons le long des flèches.
// Syntaxe : src/scripts/scenes-syntaxe.js.

import { lireScenes } from './scenes-syntaxe.js';

type Scene = ReturnType<typeof lireScenes>[number];
const SVG = 'http://www.w3.org/2000/svg';
const calme = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Échappe le texte, puis `code` et **gras**. */
const enLigne = (s: string) =>
  s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

export function animer(figure: HTMLElement, source: string) {
  const scenes = lireScenes(source);
  const svg = figure.querySelector('svg');
  if (!scenes.length || !svg) return;

  // Index des éléments du SVG rendu par mermaid.
  const noeuds = new Map<string, Element>();
  svg.querySelectorAll('g.node').forEach((g) => {
    const m = g.id.match(/-flowchart-(.+)-\d+$/);
    if (m) noeuds.set(m[1], g);
  });
  svg.querySelectorAll('g.cluster').forEach((g) => {
    const id = g.getAttribute('data-id') ?? g.id.replace(/^schema-\d+-/, '');
    noeuds.set(id, g);
  });
  const chemins = Array.from(svg.querySelectorAll<SVGPathElement>('path.flowchart-link'));
  const etiquettes = Array.from(svg.querySelectorAll('g.edgeLabel'));
  const cheminsEntre = (a: string, b: string) => {
    const re = new RegExp(`^L_${a}_${b}_\\d+$`);
    return chemins.filter((p) => re.test(p.dataset.id ?? '') && !p.classList.contains('edge-thickness-invisible'));
  };

  // Habillage : le schéma, puis une barre collante avec la légende et les commandes.
  const bloc = document.createElement('div');
  bloc.className = 'scenes';
  figure.replaceWith(bloc);
  bloc.append(figure);
  figure.classList.add('anime');
  const barre = document.createElement('div');
  barre.className = 'scene-barre';
  barre.setAttribute('role', 'group');
  barre.setAttribute('aria-label', 'Schéma pas à pas');
  barre.innerHTML = `
    <p class="scene-texte" aria-live="polite"></p>
    <div class="scene-commandes">
      <button type="button" class="scene-prec" aria-label="Étape précédente">‹</button>
      <ol class="scene-points">${scenes.map((_, i) => `<li><button type="button" aria-label="Étape ${i + 1}"></button></li>`).join('')}</ol>
      <button type="button" class="scene-lecture" aria-label="Lecture automatique">▶</button>
      <button type="button" class="scene-suiv" aria-label="Étape suivante">›</button>
    </div>`;
  bloc.append(barre);

  const texte = barre.querySelector<HTMLElement>('.scene-texte')!;
  const prec = barre.querySelector<HTMLButtonElement>('.scene-prec')!;
  const suiv = barre.querySelector<HTMLButtonElement>('.scene-suiv')!;
  const lecture = barre.querySelector<HTMLButtonElement>('.scene-lecture')!;
  const points = Array.from(barre.querySelectorAll<HTMLButtonElement>('.scene-points button'));

  let courante = 0; // 0 = vue d'ensemble, 1..n = scènes
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  let jetons: Element[] = [];

  function allumer(s: Scene) {
    for (const el of s.elements) {
      if (el.type === 'noeud') {
        const n = noeuds.get(el.id);
        if (!n) continue;
        n.classList.add('actif');
        if (el.alerte) n.classList.add('alerte');
        continue;
      }
      let sens = 1;
      let ps = cheminsEntre(el.de, el.vers);
      if (!ps.length) { ps = cheminsEntre(el.vers, el.de); sens = -1; }
      for (const p of ps) {
        p.classList.add('actif');
        if (el.alerte) p.classList.add('alerte');
        etiquettes
          .filter((e) => e.querySelector(`[data-id="${p.dataset.id}"]`))
          .forEach((e) => e.classList.add('actif'));
        if (!calme()) jetons.push(...lancerJetons(p, sens, el.alerte));
      }
    }
  }

  function lancerJetons(p: SVGPathElement, sens: number, alerte: boolean) {
    if (!p.id) return [];
    const duree = Math.min(2.4, Math.max(1.1, p.getTotalLength() / 110));
    return [0, 0.5].map((decalage) => {
      const c = document.createElementNS(SVG, 'circle');
      c.setAttribute('r', '5');
      c.setAttribute('class', alerte ? 'jeton alerte' : 'jeton');
      const a = document.createElementNS(SVG, 'animateMotion');
      a.setAttribute('dur', `${duree}s`);
      a.setAttribute('repeatCount', 'indefinite');
      a.setAttribute('begin', `${-decalage * duree}s`);
      if (sens < 0) {
        a.setAttribute('keyPoints', '1;0');
        a.setAttribute('keyTimes', '0;1');
        a.setAttribute('calcMode', 'linear');
      }
      const mp = document.createElementNS(SVG, 'mpath');
      mp.setAttribute('href', `#${p.id}`);
      a.append(mp);
      c.append(a);
      p.parentNode!.append(c);
      return c;
    });
  }

  function montrer(i: number, defiler = true) {
    courante = i;
    jetons.forEach((j) => j.remove());
    jetons = [];
    svg!.querySelectorAll('.actif, .alerte').forEach((e) => e.classList.remove('actif', 'alerte'));
    const s = scenes[i - 1];
    svg!.classList.toggle('scene-en-cours', !!s);
    if (s) allumer(s);

    texte.innerHTML = s
      ? `<span class="scene-num">${i}/${scenes.length}</span> <strong>${enLigne(s.titre)}</strong> ${enLigne(s.texte)}`
      : `<span class="scene-num">Vue d'ensemble</span> Touche ▶ ou › pour suivre le fonctionnement pas à pas.`;
    points.forEach((b, k) => b.classList.toggle('vu', k < i));
    points.forEach((b, k) => b.setAttribute('aria-current', String(k + 1 === i)));
    prec.disabled = i === 0;
    suiv.disabled = i === scenes.length;
    if (s && defiler) cadrer();
  }

  // Fait défiler la page pour que la zone allumée soit visible au-dessus de la barre.
  function cadrer() {
    const els = Array.from(svg!.querySelectorAll('.actif'));
    if (!els.length) return;
    const r = els.map((e) => e.getBoundingClientRect());
    const haut = Math.min(...r.map((x) => x.top));
    const bas = Math.max(...r.map((x) => x.bottom));
    const entete = document.querySelector('.barre')?.getBoundingClientRect().height ?? 0;
    const zoneHaut = entete + 12;
    const zoneBas = innerHeight - barre.getBoundingClientRect().height - 12;
    if (haut >= zoneHaut && bas <= zoneBas) return;
    const delta = bas - haut > zoneBas - zoneHaut ? haut - zoneHaut : (haut + bas) / 2 - (zoneHaut + zoneBas) / 2;
    scrollBy({ top: delta, behavior: calme() ? 'auto' : 'smooth' });
  }

  function arreter() {
    clearTimeout(minuteur);
    minuteur = undefined;
    lecture.textContent = '▶';
    lecture.setAttribute('aria-label', 'Lecture automatique');
  }

  function avancer() {
    if (courante >= scenes.length) return arreter();
    montrer(courante + 1);
    const s = scenes[courante - 1];
    const duree = Math.min(9000, Math.max(4000, 2500 + 45 * (s.titre.length + s.texte.length)));
    minuteur = setTimeout(courante < scenes.length ? avancer : arreter, duree);
  }

  lecture.addEventListener('click', () => {
    if (minuteur) return arreter();
    lecture.textContent = '❚❚';
    lecture.setAttribute('aria-label', 'Pause');
    if (courante >= scenes.length) courante = 0;
    avancer();
  });
  prec.addEventListener('click', () => { arreter(); montrer(Math.max(0, courante - 1)); });
  suiv.addEventListener('click', () => { arreter(); montrer(Math.min(scenes.length, courante + 1)); });
  points.forEach((b, k) => b.addEventListener('click', () => { arreter(); montrer(k + 1); }));

  montrer(0, false);
}
