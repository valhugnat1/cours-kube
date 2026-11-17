// Les paysages, portés de Limiter App (core/pixel/Scenes.kt et ScenesNature.kt) presque ligne à ligne.
// Seules les scènes utilisées par le site sont portées.

import { Toile, type Touche, bayer, hasard, r, sin, cos, abs, floor, max, min, sqrt, PI, clamp, crete } from './toile';

type Dessin = (tl: Toile, t: number, touches: Touche[]) => void;
export type NomScene = 'mer' | 'prairie' | 'lucioles' | 'pluie' | 'montagne' | 'foret' | 'aube' | 'aurore';

// ------------------------------------------------------------------ Mer

const mer: Dessin = (tl, t, touches) => {
  const { w, h, u } = tl;
  const horizon = r(h * 0.42), rivage = h * 0.74, ts = t;

  tl.degrade(0, horizon, [0xa9d8e2, 0xc3e4e6, 0xe2efe3, 0xf8edd5]);
  const sx = w * 0.62, sy = horizon * 0.5, sr = u * 0.1;
  for (let y = 0; y < horizon; y++)
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - sx, dy = y + 0.5 - sy, d = sqrt(dx * dx + dy * dy);
      if (d < sr) tl.pt(x, y, 0xfff6da);
      else if (d < sr * 2.4) {
        const p = (1 - (d - sr) / (sr * 1.4)) * 0.75;
        if (p > bayer(x, y)) tl.pt(x, y, 0xfbf2dd);
      }
    }
  for (let i = 0; i <= 2; i++) {
    const bx = ((hasard(i) * w + ts * (1.5 + i)) % (w + 12)) - 6;
    const by = horizon * (0.18 + 0.3 * hasard(i + 7)) + sin(ts * 0.8 + i);
    tl.oiseau(r(bx), r(by), Math.trunc(ts * 3 + i) % 2 === 0, 0x5e6b7a);
  }

  const mers = [0x5baebb, 0x6dbfc3, 0x86cec8, 0xa4dcd1];
  const vague = sin(ts * 0.9) * 2;
  const bord = Array.from({ length: w }, (_, x) => r(rivage + sin(x * 0.08 + ts * 0.6) * 1.5 + vague));
  for (let y = horizon; y < h; y++) {
    const f = clamp((y - horizon) / (rivage - horizon), 0, 1);
    const fi = f * (mers.length - 1);
    const i0 = min(floor(fi), mers.length - 2);
    for (let x = 0; x < w; x++) {
      if (y >= bord[x]) continue;
      let c = fi - i0 > bayer(x, y) ? mers[i0 + 1] : mers[i0];
      const v = sin((x * 0.35) / (0.3 + f) + ts * 1.2 + y * 1.7) + sin(x * 0.13 - ts * 0.7 + y * 0.9);
      if (v > 1.35) c = 0xd8f2ec;
      else if (v > 1.1 && f > 0.3) c = 0xbde7e0;
      if (f < 0.7 && abs(x - sx) < 1 + f * 3 && hasard(x * 31 + y * 17 + Math.trunc(ts * 3)) > 0.8 + f * 0.25) c = 0xf4f1de;
      tl.pt(x, y, c);
    }
  }
  tl.ronds(touches, t, 0xe6f7f2, (x, y) => y > horizon && x >= 0 && x < w && y < bord[x] - 1);

  // Petit voilier qui se balance (Helm, c'est la barre du bateau).
  const vx = r(w * 0.27 + sin(ts * 0.1) * 3);
  const vy = r(horizon + (rivage - horizon) * 0.2 + sin(ts * 1.5) * 0.6);
  const m = max(1, r(u * 0.02));
  tl.rect(vx - 4 * m, vy - m, 9 * m, m, 0xa65d47);
  tl.rect(vx - 3 * m, vy, 7 * m, m, 0x844636);
  tl.rect(vx, vy - 8 * m, m, 7 * m, 0x6b4a3a);
  for (let k = 0; k < 6; k++) tl.rect(vx + m, vy - 7 * m + k * m, (k + 1) * m, m, k === 5 ? 0xe6e0d4 : 0xffffff);
  tl.rect(vx, vy - 9 * m, 2 * m, m, 0xe05a4a);

  for (let x = 0; x < w; x++) {
    const b = bord[x];
    const mouille = r(3 + sin(ts * 0.9) * 2);
    for (let y = b; y < h; y++) {
      let c: number;
      if (y < b + 2) c = hasard(x * 13 + y + Math.trunc(ts * 2)) > 0.88 ? mers[mers.length - 1] : 0xfaf7ee;
      else if (y < b + 2 + mouille) c = 0xe6c89e;
      else if ((x % 5 === 0 && y % 4 === 0) || ((x + 2) % 5 === 0 && (y + 2) % 4 === 0)) c = 0xe4c391;
      else c = 0xf2d8ae;
      tl.pt(x, y, c);
    }
  }
};

// ------------------------------------------------------------------ Prairie

const prairie: Dessin = (tl, t, touches) => {
  const { w, h, u } = tl;
  const ts = t, horizon = r(h * 0.45);

  tl.degrade(0, horizon + 6, [0xa6d4ee, 0xc1e2f1, 0xdceff2, 0xeff7eb]);
  tl.nuage(((ts * 1.2) % (w + u * 0.6)) - u * 0.4, h * 0.15, u * 0.12);
  tl.nuage(((ts * 0.6 + w * 0.6) % (w + u * 0.4)) - u * 0.25, h * 0.27, u * 0.06);

  let rafale = 0;
  for (const tc of touches) {
    const a = t - tc.t;
    if (a >= 0 && a <= 3) rafale += (1 - a / 3) * 3;
  }

  const loin = Array.from({ length: w }, (_, x) => r(horizon + sin(x * 0.07 + 1) * 3 + sin(x * 0.023) * 4));
  const pres = Array.from({ length: w }, (_, x) => r(horizon + h * 0.13 + sin(x * 0.04 + 2) * 4));
  for (let x = 0; x < w; x++)
    for (let y = loin[x]; y < h; y++) {
      let c: number;
      if (y < pres[x]) {
        const bande = floor((x * 0.8 + (y - loin[x]) * 1.6) / 7);
        c = y < loin[x] + 2 ? 0xc6e2a0 : bande % 2 === 0 ? 0xb2d785 : 0xa6cf78;
      } else {
        const prof = y - pres[x];
        const bande = floor((x * 0.8 - prof * 1.4) / (7 + prof * 0.18));
        c = bande % 2 === 0 ? 0x9bca66 : 0x8cbd58;
      }
      tl.pt(x, y, c);
    }
  const fleurs = [0xf5a3b5, 0xfff1a8, 0xffffff];
  for (let i = 0; i < Math.trunc((w * h) / 220); i++) {
    const fx = Math.trunc(hasard(i) * w);
    const p = pres[clamp(fx, 0, w - 1)];
    tl.pt(fx, Math.trunc(p + hasard(i + 100) * (h - p)), fleurs[i % 3]);
  }
  for (let x = 0; x < w; x += 2) {
    const haut = 3 + r(hasard(x + 300) * u * 0.07);
    const plie = sin(ts * 1.8 + x * 0.15) * (1.2 + rafale);
    for (let k = 0; k < haut; k++) tl.pt(x + r((plie * k) / haut), h - 1 - k, x % 4 === 0 ? 0x6ea046 : 0x7db252);
  }
  const petales = [0xf7b8c6, 0xffffff];
  for (let i = 0; i < 12; i++) {
    const px = (hasard(i + 40) * w + ts * (4 + hasard(i + 5) * 4) * (1 + rafale * 0.5)) % w;
    const py = h * 0.3 + hasard(i + 9) * h * 0.6 + sin(ts * 1.3 + i) * 3;
    tl.pt(r(px), r(py), petales[i % 2]);
  }
  for (const tc of touches) {
    const a = t - tc.t;
    if (a < 0 || a > 3) continue;
    for (let j = 0; j < 12; j++) {
      const px = tc.x * w + a * (10 + hasard(j) * 16);
      const py = tc.y * h + sin(a * 3 + j) * 3 - a * hasard(j + 3) * 6;
      if (hasard(j * 7 + 1) > a / 3) tl.pt(r(px), r(py), petales[j % 2]);
    }
  }
};

// ------------------------------------------------------------------ Lucioles

const lucioles: Dessin = (tl, t, touches) => {
  const { w, h, u } = tl;
  const ts = t, horizon = r(h * 0.62);

  tl.degrade(0, horizon, [0x141b33, 0x1e2a4a, 0x2a3a60, 0x3b4c75]);
  tl.etoiles(ts, Math.trunc(horizon * 0.9), 110 * 0.9);
  const lx = w * 0.76, ly = h * 0.13, lr = u * 0.075;
  tl.disque(lx, ly, lr * 1.8, 0x27355a, (x, y) => bayer(x, y) < 0.35);
  tl.disque(lx, ly, lr, 0xf3efcf, (x, y) => {
    const dx = x + 0.5 - (lx + lr * 0.45), dy = y + 0.5 - (ly - lr * 0.25);
    return dx * dx + dy * dy > lr * lr * 0.8;
  });
  for (let x = 0; x < w; x++) {
    const c = min(r(horizon - u * 0.05 + sin(x * 0.05) * 3), horizon);
    for (let y = c; y < h; y++) tl.pt(x, y, 0x22304a);
  }
  for (let i = 0; i < Math.trunc(w / 6) + 2; i++) {
    const px = r(i * 6 + hasard(i) * 4 - 2);
    const base = r(horizon + 2 + hasard(i + 50) * 4);
    const haut = r(u * 0.13 + hasard(i + 20) * u * 0.1);
    tl.sapin(px, base, haut, 0x10202a);
  }
  for (let y = horizon + 4; y < h; y++)
    for (let x = 0; x < w; x++) tl.pt(x, y, hasard(x * 7919 + y * 104729) < 0.08 ? 0x1a3330 : 0x10201f);
  for (let x = 0; x < w; x += 2) {
    if (hasard(x + 77) < 0.5) continue;
    const haut = 1 + r(hasard(x + 78) * 3);
    for (let k = 0; k < haut; k++) tl.pt(x, h - 1 - k, 0x1d3b33);
  }
  const mareY = r(horizon + (h - horizon) * 0.55), mareL = r(u * 0.35);
  for (let dy = 0; dy <= 2; dy++) {
    const demi = Math.trunc(mareL / 2) - dy * 2;
    for (let dx = -demi; dx <= demi; dx++) tl.pt(r(lx + dx), mareY + dy, 0x1c2b47);
  }
  for (let dy = 0; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) if (sin(ts * 2 + dx + dy * 2) > -0.3) tl.pt(r(lx + dx), mareY + dy, 0xc9c59f);
  const luciole = (x: number, y: number, eclat: number) => {
    if (eclat < 0.25) return;
    const xi = r(x), yi = r(y);
    if (eclat > 0.6) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) tl.pt(xi + dx, yi + dy, 0x9db257);
    tl.pt(xi, yi, 0xf9f7a1);
  };
  for (let i = 0; i < 16; i++) {
    const x = hasard(i) * w + sin(ts * 0.4 * (1 + hasard(i + 60)) + i) * 6;
    const y = horizon - h * 0.12 + hasard(i + 30) * h * 0.35 + cos(ts * 0.3 * (1 + hasard(i + 70)) + i * 2) * 4;
    luciole(x, y, 0.5 + 0.5 * sin(ts * (1.5 + hasard(i + 80) * 2) + i * 3));
  }
  for (const tc of touches) {
    const a = t - tc.t;
    if (a < 0 || a > 6) continue;
    for (let j = 0; j < 8; j++) {
      const ang = (j * PI) / 4 + hasard(j) * 0.5;
      const rr = a * 3 + 1;
      const eclat = (0.5 + 0.5 * sin(a * 4 + j)) * (1 - a / 6) * 1.4;
      luciole(tc.x * w + cos(ang) * rr, tc.y * h + sin(ang) * rr * 0.7 - a, eclat);
    }
  }
};

// ------------------------------------------------------------------ Pluie sur le lac

const pluie: Dessin = (tl, t, touches) => {
  const { w, h, u } = tl;
  const ts = t, horizon = r(h * 0.55), rive = r(h * 0.82);

  tl.degrade(0, horizon, [0x9dadc2, 0xb3bfce, 0xc8d1dc, 0xd9dfe6]);
  const loin = Array.from({ length: w }, (_, x) => r(horizon - u * 0.1 - abs(sin(x * 0.06 + 0.5)) * u * 0.14 - abs(sin(x * 0.17)) * u * 0.03));
  const pres = Array.from({ length: w }, (_, x) => r(horizon - u * 0.03 - abs(sin(x * 0.09 + 2)) * u * 0.08));
  const cime = min(...loin);
  for (let x = 0; x < w; x++) {
    for (let y = loin[x]; y < horizon; y++) tl.pt(x, y, y < loin[x] + 3 && loin[x] < cime + u * 0.05 ? 0xeef2f6 : 0x9aa9bc);
    for (let y = pres[x]; y < horizon; y++) tl.pt(x, y, bayer(x, y) < 0.2 ? 0x8394aa : 0x7b8ca2);
  }
  tl.degrade(horizon, rive, [0x90a4b8, 0x8099ae, 0x6f879e]);
  for (let y = horizon; y < rive; y++)
    for (let x = 0; x < w; x++) {
      const miroir = 2 * horizon - y;
      if (miroir >= pres[x] && bayer(x, y) < 0.5) tl.pt(x, y, 0x71869d);
      if (sin(x * 0.5 + ts * 2 + y * 3) > 0.96) tl.pt(x, y, 0xaabbcb);
    }
  for (let i = 0; i < 10; i++) {
    const periode = 1.6;
    const cycle = floor((ts + hasard(i) * periode) / periode);
    const age = (ts + hasard(i) * periode) % periode;
    const cx = hasard(i * 13 + cycle * 7) * w;
    const cy = horizon + 2 + hasard(i * 17 + cycle * 3) * (rive - horizon - 4);
    const rr = age * 3;
    for (let k = 0; k < 10; k++) {
      const ang = (2 * PI * k) / 10;
      if (age < 1.2) tl.pt(r(cx + cos(ang) * rr), r(cy + sin(ang) * rr * 0.35), 0xb8c7d5);
    }
  }
  tl.ronds(touches, t, 0xd5e0ea, (x, y) => y >= horizon + 1 && y < rive - 1 && x >= 0 && x < w);
  for (let y = rive; y < h; y++) for (let x = 0; x < w; x++) tl.pt(x, y, bayer(x, y) < 0.3 ? 0x536e52 : 0x5e7a5c);
  for (let x = 1; x < w; x += 3) {
    if (hasard(x + 900) < 0.35) continue;
    const haut = r(u * 0.05 + hasard(x) * u * 0.08);
    const plie = sin(ts * 1.2 + x);
    for (let k = 0; k < haut; k++) tl.pt(x + r((plie * k) / haut), rive + 2 - k, 0x3f5a43);
    if (hasard(x + 5) > 0.5) tl.rect(x + r(plie), rive + 2 - haut - 1, 1, 2, 0x6b4a35);
  }
  for (let i = 0; i < Math.trunc((w * h) / 130); i++) {
    const vitesse = h * 0.9 * (0.8 + hasard(i + 2) * 0.4);
    const y = ((hasard(i + 1) * h + ts * vitesse) % (h + 8)) - 4;
    const x = hasard(i) * (w + h * 0.25) - y * 0.25;
    for (let k = 0; k <= 2; k++) tl.pt(r(x + k * 0.25), r(y - k), y > horizon ? 0xc3cfda : 0xedf1f5);
  }
};

// ------------------------------------------------------------------ Lac de montagne

const montagne: Dessin = (tl, t, touches) => {
  const { w, h, u } = tl;
  const ts = t, horizon = r(h * 0.6), rive = horizon + 2, finLac = r(h * 0.86);

  tl.degrade(0, horizon, [0x8cc8ec, 0xa9d6f0, 0xc9e6f5, 0xe4f3f8]);
  tl.nuage(((ts * 0.8) % (w + u * 0.6)) - u * 0.3, h * 0.1, u * 0.07);
  const massif = (pic: number, sommet: number, largeur: number, roche: number, ombre: number, neige: number, neigeOmbre: number) => {
    const pente = (horizon - sommet) / largeur;
    for (let x = 0; x < w; x++) {
      const haut = r(sommet + abs(x - pic) * pente + sin(x * 0.45) * 1.2 + abs(sin(x * 0.13)) * u * 0.03);
      for (let y = max(0, haut); y < horizon; y++) {
        const aDroite = x > pic + sin(y * 0.5) * 1.5;
        const enNeige = y < sommet + u * 0.11 + sin(x * 0.6) * 1.5;
        tl.pt(x, y, enNeige ? (aDroite ? neigeOmbre : neige) : aDroite ? ombre : roche);
      }
    }
  };
  massif(w * 0.18, h * 0.3, w * 0.32, 0x9aa8bc, 0x8796ac, 0xf4f7fb, 0xd9e2ee);
  massif(w * 0.58, h * 0.15, w * 0.5, 0x7d8ca3, 0x6a7891, 0xffffff, 0xdde6f0);
  for (let i = 0; i < Math.trunc(w / 4) + 2; i++) {
    const x = r(i * 4 + hasard(i + 40) * 3);
    tl.sapin(x, horizon, r(u * 0.05 + hasard(i) * u * 0.06), i % 3 === 0 ? 0x2a5240 : 0x2f5b46);
  }
  for (let y = horizon; y < rive; y++) for (let x = 0; x < w; x++) tl.pt(x, y, 0x6fa35a);
  tl.reflet(rive, finLac, ts, 0x4f93bc);
  for (let y = rive; y < finLac; y++)
    for (let x = 0; x < w; x++)
      if (sin(x * 0.4 + ts * 1.5) * sin(y * 1.3 + ts) > 0.93 && bayer(x, y) < 0.5) tl.pt(x, y, 0xcfe8f2);
  tl.ronds(touches, t, 0xddf0f8, (x, y) => y >= rive + 1 && y < finLac - 1 && x >= 0 && x < w);
  for (let y = finLac; y < h; y++) for (let x = 0; x < w; x++) tl.pt(x, y, bayer(x, y) < 0.25 ? 0x5f9a4e : 0x6fa85a);
  for (let i = 0; i < Math.trunc(w / 6); i++) {
    const x = Math.trunc(hasard(i + 300) * w);
    const y = finLac + 1 + Math.trunc(hasard(i + 301) * (h - finLac - 2));
    if (i % 3 === 0) tl.rect(x, y, 2, 1, 0x9aa3a8);
    else tl.pt(x, y, i % 2 === 0 ? 0xfff1a8 : 0xffffff);
  }
};

// ------------------------------------------------------------------ Clairière en forêt

const foret: Dessin = (tl, t, touches) => {
  const { w, h, u } = tl;
  const ts = t, sol = r(h * 0.8);

  tl.degrade(0, h, [0xe9f1cc, 0xbcd89d, 0x8dbb76, 0x67985e]);
  for (let i = 0; i < Math.trunc(w / 5) + 1; i++) {
    const x = Math.trunc(hasard(i + 10) * w);
    tl.rect(x, 0, 1 + Math.trunc(hasard(i + 11) * 2), sol, 0xa7bc8e);
  }
  for (let y = 0; y < sol; y++)
    for (let x = 0; x < w; x++) {
      const b = (((x + y * 0.6 + ts * 1.5) % 26) + 26) % 26;
      if (b < 4 && bayer(x, y) < 0.2 * (1 - y / sol)) tl.pt(x, y, 0xf6f8da);
    }
  for (let i = 0; i < 5; i++) {
    const x = r(w * (0.08 + i * 0.21) + (hasard(i + 20) - 0.5) * w * 0.08);
    const l = max(2, r(u * 0.04 + hasard(i + 21) * u * 0.03));
    tl.rect(x, 0, l, sol + 2, 0x5e4a38);
    tl.rect(x + l - 1, 0, 1, sol + 2, 0x46372a);
    for (let k = 0; k < sol; k += 7) tl.pt(x + 1, k + Math.trunc(hasard(i * 9 + k) * 4), 0x725a44);
  }
  for (let x = 0; x < w; x++) {
    const bas = r(h * 0.12 + sin(x * 0.3) * 3 + sin(x * 0.11 + 1) * 4 + hasard(x) * 2);
    for (let y = 0; y < bas; y++) tl.pt(x, y, bayer(x, y) < 0.4 ? 0x3e6e3e : 0x4f8a4b);
    if (hasard(x + 70) < 0.4) tl.pt(x, bas, 0x4f8a4b);
  }
  for (let x = 0; x < w; x++) {
    const haut = r(sol + sin(x * 0.1) * 2);
    for (let y = haut; y < h; y++) tl.pt(x, y, bayer(x, y) < 0.3 ? 0x5e8e46 : 0x6e9e52);
  }
  for (let i = 0; i < Math.trunc(w / 7); i++) {
    const x = r(hasard(i + 500) * w);
    const y = sol + 1 + r(hasard(i + 501) * (h - sol - 3));
    for (let k = 0; k <= 2; k++) {
      tl.pt(x - k, y - k, 0x4e7e3e);
      tl.pt(x + k, y - k, 0x4e7e3e);
    }
    tl.pt(x, y - 3, 0x4e7e3e);
  }
  for (let i = 0; i < 14; i++) {
    const x = (hasard(i + 80) * w + sin(ts * 0.3 + i) * 5 + ts * 0.8) % w;
    const y = (hasard(i + 81) * sol + cos(ts * 0.25 + i * 2) * 4 - ts * 0.6) % sol;
    if (sin(ts * 1.5 + i) > -0.3) tl.pt(r(x), r((y + sol) % sol), 0xfffbd8);
  }
  const couleurs = [0xe8a04a, 0xf2c75c, 0x8dbf5a, 0xd9714a];
  for (const tc of touches) {
    const a = t - tc.t;
    if (a < 0 || a > 5) continue;
    for (let j = 0; j < 10; j++) {
      const x = tc.x * w + (hasard(j + 1) - 0.5) * 14 + sin(a * 2 + j) * 4;
      const y = tc.y * h + a * h * 0.1 * (0.6 + hasard(j + 2)) - 2;
      if (y < h - 1) tl.pt(r(x), r(y), couleurs[j % 4]);
    }
  }
};

// ------------------------------------------------------------------ Aube sur les crêtes

const aube: Dessin = (tl, t, touches) => {
  const { w, h, u } = tl;
  const ts = t;

  tl.degrade(0, r(h * 0.66), [0x8fa3d4, 0xb7b2d8, 0xe3bcc4, 0xf7d3b4, 0xfce6c0]);
  const sx = w * 0.62, sy = h * 0.43 - ((ts * 0.05) % (u * 0.05));
  tl.disque(sx, sy, u * 0.16, 0xfbe3c6, (x, y) => bayer(x, y) < 0.45);
  tl.disque(sx, sy, u * 0.07, 0xfff1d0);
  tl.oiseaux(ts, 3, h * 0.35, 0x6a5e7e, 11);

  const couche = (base: number, amp: number, f: number, ph: number, c: number) => {
    for (let x = 0; x < w; x++) for (let y = max(0, crete(x, base, amp, f, ph)); y < h; y++) tl.pt(x, y, c);
  };
  const brume = (y0: number, y1: number, c: number, force: number) => {
    for (let y = r(y0); y < r(y1); y++)
      for (let x = 0; x < w; x++) if (bayer(x, y) < force + 0.12 * sin(x * 0.08 + ts * 0.3 + y)) tl.pt(x, y, c);
  };
  couche(h * 0.54, u * 0.14, 0.05, 1, 0xb6a6c8);
  brume(h * 0.5, h * 0.56, 0xf2e2e6, 0.3);
  couche(h * 0.65, u * 0.12, 0.07, 2.5, 0x8d7fa9);
  brume(h * 0.62, h * 0.67, 0xd9cbdc, 0.25);
  couche(h * 0.78, u * 0.08, 0.09, 4, 0x5e5a80);
  for (let i = 0; i < Math.trunc(w / 5); i++) {
    const x = r(i * 5 + hasard(i + 60) * 3);
    tl.sapin(x, crete(x, h * 0.78, u * 0.08, 0.09, 4) + 2, r(u * 0.04 + hasard(i + 61) * u * 0.05), 0x45426a);
  }
  for (const tc of touches) {
    const a = t - tc.t;
    if (a < 0 || a > 4) continue;
    for (let j = 0; j < 6; j++) {
      const x = tc.x * w + a * (8 + j * 2.5) + (hasard(j) - 0.5) * 6;
      const y = tc.y * h - a * (5 + j * 1.5) + sin(a * 6 + j);
      tl.oiseau(r(x), r(y), Math.trunc(a * 6 + j) % 2 === 0, 0x5a4e70);
    }
  }
};

// ------------------------------------------------------------------ Aurore boréale

const aurore: Dessin = (tl, t, touches) => {
  const { w, h, u } = tl;
  const ts = t, horizon = r(h * 0.68);

  tl.degrade(0, horizon, [0x0b1028, 0x121b3e, 0x1a2a55, 0x22386a]);
  tl.etoiles(ts, horizon);
  for (let x = 0; x < w; x++) {
    const c0 = h * 0.3 + sin(x * 0.07 + ts * 0.4) * h * 0.05 + sin(x * 0.023 - ts * 0.25) * h * 0.04;
    const l = h * 0.16 * (0.55 + 0.45 * sin(x * 0.13 + ts * 0.7));
    for (let y = max(0, r(c0 - l)); y < min(horizon, r(c0 + 2)); y++) {
      const f = clamp((c0 - y) / l, 0, 1);
      const force = (1 - f) * 0.85 * (0.6 + 0.4 * sin(x * 0.5 + ts * 2 + y * 0.1));
      if (force > bayer(x, y)) tl.pt(x, y, f < 0.35 ? 0x7cf5b8 : f < 0.7 ? 0x4fd1a0 : 0x8c6fe0);
    }
  }
  for (let x = 0; x < w; x++) {
    const haut = crete(x, horizon, u * 0.1, 0.06, 0.7);
    for (let y = haut; y < horizon; y++) tl.pt(x, y, y < haut + 2 ? 0xc9d6ea : 0x2b3b5e);
  }
  for (let y = horizon; y < h; y++) for (let x = 0; x < w; x++) tl.pt(x, y, bayer(x, y) < 0.2 ? 0xb4c3dc : 0xd5e0f0);
  for (let i = 0; i < Math.trunc(w / 6) + 1; i++) {
    const x = r(i * 6 + hasard(i + 120) * 4);
    tl.sapin(x, horizon + 2 + r(hasard(i + 121) * 3), r(u * 0.05 + hasard(i + 122) * u * 0.06), 0x13203a);
  }
  tl.filantes(touches, t);
};

// touche : où « toucher » la scène pour fêter une leçon validée (ronds dans l'eau, étoile filante…).
export type InfoScene = { titre: string; invite: string; sombre: boolean; dessin: Dessin; touche: [number, number] };

export const SCENES: Record<NomScene, InfoScene> = {
  mer: { titre: 'Matin au bord de mer', invite: 'touche l’eau pour faire des ronds', sombre: false, dessin: mer, touche: [0.62, 0.6] },
  prairie: { titre: 'Brise sur la prairie', invite: 'touche l’herbe pour faire souffler le vent', sombre: false, dessin: prairie, touche: [0.25, 0.72] },
  pluie: { titre: 'Pluie sur le lac', invite: 'touche le lac pour faire des ronds', sombre: false, dessin: pluie, touche: [0.5, 0.7] },
  montagne: { titre: 'Lac de montagne', invite: 'touche le lac pour faire des ronds', sombre: false, dessin: montagne, touche: [0.5, 0.74] },
  foret: { titre: 'Clairière en forêt', invite: 'touche la forêt pour faire tomber des feuilles', sombre: false, dessin: foret, touche: [0.5, 0.25] },
  aube: { titre: 'Aube sur les crêtes', invite: 'touche le ciel pour faire s’envoler les oiseaux', sombre: false, dessin: aube, touche: [0.35, 0.35] },
  lucioles: { titre: 'Nuit des lucioles', invite: 'touche la nuit pour réveiller les lucioles', sombre: true, dessin: lucioles, touche: [0.5, 0.6] },
  aurore: { titre: 'Aurore boréale', invite: 'touche le ciel pour une étoile filante', sombre: true, dessin: aurore, touche: [0.75, 0.15] },
};
