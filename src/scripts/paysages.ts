// Monte les paysages pixel animés : tout élément [data-paysage="mer"] reçoit un <canvas>.
// Environ 11 images par seconde, en pause quand le paysage n'est pas à l'écran.
// prefers-reduced-motion : image fixe ; seul un appui anime la scène quelques secondes.

import { Toile, type Touche } from './pixel/toile';
import { SCENES, type NomScene } from './pixel/scenes';

const PERIODE = 90; // ms entre deux images
const calme = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

type Monte = { el: HTMLElement; visible: boolean; tick: () => void };
const montes = new Set<Monte>();

function monter(el: HTMLElement) {
  if (el.dataset.paysageMonte) return;
  const nom = el.dataset.paysage as NomScene;
  const scene = SCENES[nom];
  if (!scene) return;
  el.dataset.paysageMonte = '1';

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  el.prepend(canvas);
  const ctx = canvas.getContext('2d')!;
  const largeur = Number(el.dataset.largeur) || 90;
  let toile: Toile | null = null;
  let image: ImageData | null = null;

  const debut = performance.now() / 1000 - 20 - Math.random() * 40;
  const temps = () => performance.now() / 1000 - debut;
  const touches: Touche[] = [];
  let dernier = 0;
  let animeJusqua = 0;

  const dimensionner = () => {
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;
    const h = Math.max(1, Math.round((largeur * height) / width));
    if (toile && toile.w === largeur && toile.h === h) return;
    toile = new Toile(largeur, h);
    canvas.width = largeur;
    canvas.height = h;
    image = ctx.createImageData(largeur, h);
    dessiner();
  };

  const dessiner = () => {
    if (!toile || !image) return;
    const t = temps();
    for (let i = touches.length - 1; i >= 0; i--) if (t - touches[i].t > 7) touches.splice(i, 1);
    scene.dessin(toile, t, touches);
    const d = image.data, px = toile.px;
    for (let i = 0; i < px.length; i++) {
      const c = px[i], k = i * 4;
      d[k] = (c >> 16) & 255; d[k + 1] = (c >> 8) & 255; d[k + 2] = c & 255; d[k + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  };

  const m: Monte = {
    el,
    visible: false,
    tick: () => {
      const maintenant = performance.now();
      if (maintenant - dernier < PERIODE) return;
      if (calme() && maintenant > animeJusqua) return;
      dernier = maintenant;
      dessiner();
    },
  };
  montes.add(m);

  new ResizeObserver(dimensionner).observe(el);
  new IntersectionObserver(([e]) => { m.visible = e.isIntersecting; boucle(); }).observe(el);

  const toucher = (x: number, y: number) => {
    touches.push({ x, y, t: temps() });
    animeJusqua = performance.now() + 6000;
    boucle();
  };
  if (el.dataset.interactif !== 'non') {
    el.addEventListener('pointerdown', (ev) => {
      const b = canvas.getBoundingClientRect();
      toucher((ev.clientX - b.left) / b.width, (ev.clientY - b.top) / b.height);
    });
  }
  // Fête : la scène se « touche » toute seule (leçon validée).
  if (el.dataset.fete !== undefined) {
    const [x, y] = scene.touche;
    setTimeout(() => toucher(x, y), 350);
    setTimeout(() => toucher(x + 0.12, y + 0.04), 1300);
  }
  dimensionner();
}

let enCours = false;
function boucle() {
  if (enCours) return;
  enCours = true;
  const pas = () => {
    let actifs = 0;
    if (!document.hidden)
      for (const m of montes) {
        if (!m.el.isConnected) { montes.delete(m); continue; }
        if (m.visible) { m.tick(); actifs++; }
      }
    if (actifs) requestAnimationFrame(pas);
    else enCours = false;
  };
  requestAnimationFrame(pas);
}
document.addEventListener('visibilitychange', boucle);

/** Monte tous les paysages sous racine (la page entière par défaut). */
export function monterPaysages(racine: ParentNode = document) {
  racine.querySelectorAll<HTMLElement>('[data-paysage]').forEach(monter);
}

// ------------------------------------------------------------------ Le paysage suit le soleil

/** Lever et coucher du soleil à Paris, en minutes locales (formules NOAA, comme dans l'appli). */
function leverCoucher(d: Date): [number, number] {
  const debutAn = new Date(d.getFullYear(), 0, 1);
  const jour = Math.floor((d.getTime() - debutAn.getTime()) / 864e5) + 1;
  const g = ((2 * Math.PI) / 365) * (jour - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const phi = (48.85 * Math.PI) / 180, lon = 2.35;
  const cosH = Math.cos((90.833 * Math.PI) / 180) / (Math.cos(phi) * Math.cos(decl)) - Math.tan(phi) * Math.tan(decl);
  const h = (Math.acos(Math.max(-1, Math.min(1, cosH))) * 180) / Math.PI;
  const midi = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  const decalage = -midi.getTimezoneOffset();
  return [Math.round(720 - 4 * (lon + h) - eq + decalage), Math.round(720 - 4 * (lon - h) - eq + decalage)];
}

export type Moment = 'jour' | 'crepuscule' | 'nuit';
export function momentDuJour(d = new Date()): Moment {
  const [lever, coucher] = leverCoucher(d);
  const min = d.getHours() * 60 + d.getMinutes();
  if (Math.abs(min - lever) <= 45 || Math.abs(min - coucher) <= 45) return 'crepuscule';
  return min > lever && min < coucher ? 'jour' : 'nuit';
}

/** Choisit la scène de l'accueil : celle de la partie en cours le jour, l'aube au crépuscule, la nuit sinon. */
export function sceneDuMoment(sceneDuJour: NomScene): NomScene {
  const m = momentDuJour();
  if (m === 'jour') return sceneDuJour;
  if (m === 'crepuscule') return 'aube';
  return new Date().getDate() % 2 ? 'lucioles' : 'aurore';
}

export { SCENES };
