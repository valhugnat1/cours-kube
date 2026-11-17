// Moteur des paysages pixel, porté de Limiter App (core/pixel/Toile.kt et les outils communs).
// Une petite image (environ 90 px de large) qu'on agrandit sans lissage : c'est l'effet pixel art.
// Les couleurs sont des entiers 0xRRGGBB.

export type Touche = { x: number; y: number; t: number };

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Seuil de trame entre 0 et 1 pour le pixel (x, y). */
export const bayer = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

/** Pseudo-aléatoire stable : le même n donne toujours le même nombre entre 0 et 1. */
export function hasard(n: number): number {
  let x = (Math.imul(n | 0, 374761393) + 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) & 0xffffff) / 16777216;
}

/** Arrondi comme roundToInt() en Kotlin. */
export const r = Math.round;
export const { sin, cos, abs, floor, ceil, min, max, sqrt, PI } = Math;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Mélange deux couleurs (f = part de b). */
export function melange(a: number, b: number, f: number): number {
  const c = (d: number) => clamp(Math.trunc(((a >> d) & 255) * (1 - f) + ((b >> d) & 255) * f), 0, 255);
  return (c(16) << 16) | (c(8) << 8) | c(0);
}

export class Toile {
  readonly px: Int32Array;
  constructor(readonly w: number, readonly h: number) {
    this.px = new Int32Array(w * h);
  }

  pt(x: number, y: number, c: number) {
    if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.px[y * this.w + x] = c;
  }

  lire(x: number, y: number) {
    return x >= 0 && x < this.w && y >= 0 && y < this.h ? this.px[y * this.w + x] : 0;
  }

  rect(x: number, y: number, lw: number, lh: number, c: number) {
    for (let j = max(0, y); j < min(this.h, y + lh); j++)
      for (let i = max(0, x); i < min(this.w, x + lw); i++) this.px[j * this.w + i] = c;
  }

  /** Disque plein ; garde permet de ne peindre que certains pixels. */
  disque(cx: number, cy: number, rr: number, c: number, garde: (x: number, y: number) => boolean = () => true) {
    for (let j = floor(cy - rr); j <= ceil(cy + rr); j++)
      for (let i = floor(cx - rr); i <= ceil(cx + rr); i++) {
        const dx = i + 0.5 - cx, dy = j + 0.5 - cy;
        if (dx * dx + dy * dy <= rr * rr && garde(i, j)) this.pt(i, j, c);
      }
  }

  /** Dégradé vertical tramé (trame de Bayer, comme sur les vieilles consoles). */
  degrade(y0: number, y1: number, couleurs: number[]) {
    const n = couleurs.length - 1;
    for (let y = max(0, y0); y < min(this.h, y1); y++) {
      const f = ((y - y0) / max(1, y1 - y0 - 1)) * n;
      const i = max(0, min(n - 1, floor(f)));
      const frac = f - i;
      for (let x = 0; x < this.w; x++) this.px[y * this.w + x] = frac > bayer(x, y) ? couleurs[min(n, i + 1)] : couleurs[i];
    }
  }

  /** Unité de taille des objets : suit la plus petite dimension utile. */
  get u() {
    return min(this.w, this.h * 0.6);
  }

  /** Anneaux qui s'élargissent depuis les appuis, limités à une zone (l'eau). */
  ronds(touches: Touche[], t: number, couleur: number, dansZone: (x: number, y: number) => boolean) {
    for (const tc of touches) {
      const age = t - tc.t;
      if (age < 0 || age > 2.5) continue;
      const cx = tc.x * this.w, cy = tc.y * this.h;
      for (let anneau = 0; anneau <= 1; anneau++) {
        const a = age - anneau * 0.45;
        if (a <= 0) continue;
        const rx = 1.5 + a * this.u * 0.12, ry = rx * 0.38;
        const pas = max(8, Math.trunc(rx * 7));
        for (let k = 0; k < pas; k++) {
          const ang = (2 * PI * k) / pas;
          const x = r(cx + cos(ang) * rx), y = r(cy + sin(ang) * ry);
          if (dansZone(x, y) && hasard(k * 31 + anneau * 7 + Math.trunc(tc.t * 10)) > a / 2.5) this.pt(x, y, couleur);
        }
      }
    }
  }

  nuage(cx: number, cy: number, s: number) {
    const ronds = [[0, 0, 1], [1.1, -0.45, 1.25], [2.3, 0, 1], [1.1, 0.35, 1]];
    for (let j = r(cy - 2 * s); j <= r(cy + 1.5 * s); j++)
      for (let i = r(cx - s); i <= r(cx + 3.4 * s); i++) {
        const dedans = ronds.some(([ox, oy, rr]) => {
          const dx = i + 0.5 - (cx + ox * s), dy = j + 0.5 - (cy + oy * s);
          return dx * dx + dy * dy <= rr * s * (rr * s);
        });
        if (dedans) this.pt(i, j, j > cy + s * 0.45 ? 0xe4ecf2 : 0xffffff);
      }
  }

  etoiles(ts: number, yMax: number, diviseur = 110) {
    for (let i = 0; i < Math.trunc((this.w * yMax) / diviseur); i++) {
      const ex = Math.trunc(hasard(i * 3) * this.w), ey = Math.trunc(hasard(i * 3 + 1) * yMax);
      const sc = sin(ts * (0.8 + hasard(i * 3 + 2) * 2) + i);
      if (sc > -0.2) this.pt(ex, ey, sc > 0.7 ? 0xffffff : 0x8e9ac0);
    }
  }

  /** Une étoile filante par appui, qui file vers le bas à gauche. */
  filantes(touches: Touche[], t: number) {
    for (const tc of touches) {
      const a = t - tc.t;
      if (a < 0 || a > 1.4) continue;
      const hx = tc.x * this.w - a * this.w * 0.5, hy = tc.y * this.h + a * this.h * 0.18;
      for (let k = 0; k < 9; k++) {
        const c = k === 0 ? 0xffffff : k < 3 ? 0xfff3c4 : 0x9fa8d8;
        if (k < 3 || hasard(k * 5 + Math.trunc(a * 20)) > 0.35) this.pt(r(hx + k * 1.6), r(hy - k * 0.6), c);
      }
    }
  }

  sapin(cx: number, base: number, haut: number, c: number, neige?: number) {
    for (let k = 0; k <= haut; k++) {
      const demi = r(k * 0.33) - (k % 4 === 0 && k > 0 ? 1 : 0);
      for (let dx = -demi; dx <= demi; dx++) {
        const blanc = neige !== undefined && k % 4 === 1 && dx <= 0;
        this.pt(cx + dx, base - haut + k, blanc ? neige! : c);
      }
    }
  }

  oiseau(x: number, y: number, haut: boolean, c: number) {
    const pts = haut ? [[-2, 0], [-1, -1], [0, 0], [1, -1], [2, 0]] : [[-2, -1], [-1, 0], [0, 0], [1, 0], [2, -1]];
    for (const [dx, dy] of pts) this.pt(x + dx, y + dy, c);
  }

  oiseaux(ts: number, n: number, yMax: number, c: number, graine = 0) {
    for (let i = 0; i < n; i++) {
      const bx = ((hasard(i + graine) * this.w + ts * (1.5 + i * 0.7)) % (this.w + 12)) - 6;
      const by = yMax * (0.2 + 0.6 * hasard(i + 7 + graine)) + sin(ts * 0.8 + i);
      this.oiseau(r(bx), r(by), Math.trunc(ts * 3 + i) % 2 === 0, c);
    }
  }

  /** Reflet dans l'eau : recopie les lignes au-dessus de axe, ondulées et teintées. */
  reflet(axe: number, y1: number, ts: number, teinte: number) {
    for (let y = axe; y < min(y1, this.h); y++) {
      const src = 2 * axe - y - 1;
      if (src < 0) continue;
      const ondule = r(sin(y * 0.9 + ts * 2) * 1.2);
      for (let x = 0; x < this.w; x++) {
        const c = this.lire(clamp(x + ondule, 0, this.w - 1), src);
        this.pt(x, y, melange(c, teinte, bayer(x, y) < 0.5 ? 0.5 : 0.3));
      }
    }
  }
}

/** Ligne de crête : creux et bosses à partir de base, amplitude amp. */
export const crete = (x: number, base: number, amp: number, f: number, ph: number) =>
  r(base - abs(sin(x * f + ph)) * amp - abs(sin(x * f * 2.3 + ph * 2)) * amp * 0.35);
