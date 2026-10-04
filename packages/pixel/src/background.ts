import type { PixelImage } from '@kinetome/core';
import { cloneImage, LabCache, labDist } from './image.ts';

export type RGB = [number, number, number];

/**
 * A backdrop to remove. `checker` is the fake "transparency" pattern AI generators love to
 * paint into images: two alternating light greys that must both go.
 */
export interface Background { kind: 'solid' | 'checker'; colors: RGB[] }

/** Chroma-key style colors (saturated green/magenta/blue) never appear as eye whites or teeth. */
export function isChroma([r, g, b]: RGB): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) > 110;
}

/**
 * Guesses the backdrop from the image border. Returns null when the border is already
 * transparent or too varied to be a flat backdrop (e.g. a photo).
 */
export function estimateBackground(img: PixelImage): Background | null {
  const { width: W, height: H, data } = img;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0, transparent = 0;
  const visit = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    total++;
    if (data[i + 3] < 128) { transparent++; return; }
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
    bins.set(key, b);
  };
  // two rings deep so a thin frame line doesn't fool us
  for (const inset of [0, 2]) {
    for (let x = inset; x < W - inset; x++) { visit(x, inset); visit(x, H - 1 - inset); }
    for (let y = inset + 1; y < H - 1 - inset; y++) { visit(inset, y); visit(W - 1 - inset, y); }
  }
  const opaque = total - transparent;
  if (transparent / total > 0.5 || opaque === 0) return null;
  const top = [...bins.values()].sort((a, b) => b.n - a.n);
  const avg = (b: { n: number; r: number; g: number; b: number }): RGB => [Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n)];
  const [a, b] = top;
  if (a && b) {
    const ca = avg(a), cb = avg(b);
    const grey = (c: RGB) => Math.max(...c) - Math.min(...c) < 24;
    const differ = Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2]) > 12;
    if ((a.n + b.n) / opaque > 0.8 && b.n / opaque > 0.2 && grey(ca) && grey(cb) && differ) return { kind: 'checker', colors: [ca, cb] };
  }
  if (!a || a.n / opaque < 0.45) return null;
  return { kind: 'solid', colors: [avg(a)] };
}

/**
 * Removes the backdrop: flood-fill from the border through pixels close to any backdrop
 * color, then a defringe ring for the JPEG/antialias halo. With `holes`, enclosed pockets
 * of backdrop (the gap between an arm and the body) go too. That is safe for chroma and
 * checker backdrops, risky for white (it would eat eye whites), hence optional.
 */
export function removeBackground(img: PixelImage, bg: Background, tolerance = 0.09, holes = false): PixelImage {
  const out = cloneImage(img);
  const { width: W, height: H, data } = out;
  const lab = new LabCache();
  const bgLab = bg.colors.map(c => lab.get(c[0], c[1], c[2]));
  const dist = (p: number) => {
    const i = p * 4;
    if (data[i + 3] < 16) return 0;
    const l = lab.get(data[i], data[i + 1], data[i + 2]);
    let d = Infinity;
    for (const b of bgLab) d = Math.min(d, labDist(l, b));
    return d;
  };
  const removed = new Uint8Array(W * H);
  const stack: number[] = [];
  const seed = (p: number) => { if (!removed[p] && dist(p) <= tolerance) { removed[p] = 1; stack.push(p); } };
  const flood = () => {
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p - x) / W;
      if (x > 0) seed(p - 1);
      if (x < W - 1) seed(p + 1);
      if (y > 0) seed(p - W);
      if (y < H - 1) seed(p + W);
    }
  };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  flood();

  if (holes) {
    // enclosed backdrop pockets bigger than a few px (tiny ones may be real highlights)
    const minArea = Math.max(12, Math.round(W * H * 0.00015));
    const seen = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) {
      if (removed[p] || seen[p] || dist(p) > tolerance) continue;
      const comp: number[] = [p];
      seen[p] = 1;
      for (let k = 0; k < comp.length; k++) {
        const q = comp[k], x = q % W, y = (q - x) / W;
        for (const n of [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, y > 0 ? q - W : -1, y < H - 1 ? q + W : -1]) {
          if (n < 0 || seen[n] || removed[n] || dist(n) > tolerance) continue;
          seen[n] = 1; comp.push(n);
        }
      }
      if (comp.length >= minArea) for (const q of comp) removed[q] = 1;
    }
  }

  // defringe: one ring of looser matching along every cut
  const fringe: number[] = [];
  for (let p = 0; p < W * H; p++) {
    if (removed[p]) continue;
    const x = p % W, y = (p - x) / W;
    const touches = (x > 0 && removed[p - 1]) || (x < W - 1 && removed[p + 1]) || (y > 0 && removed[p - W]) || (y < H - 1 && removed[p + W]);
    if (touches && dist(p) <= tolerance * 2) fringe.push(p);
  }
  for (const p of fringe) removed[p] = 1;

  // Spill: on chroma backdrops, edge pixels that share the backdrop's HUE (any brightness:
  // JPEG and resampling mix green into dark outlines) are backdrop too. Two rings deep.
  if (bg.colors.every(isChroma)) {
    const [, ba, bb] = bgLab[0];
    const bgAng = Math.atan2(bb, ba);
    const spill = (p: number) => {
      const i = p * 4;
      const [, a, b] = lab.get(data[i], data[i + 1], data[i + 2]);
      const c = Math.hypot(a, b);
      if (c < 0.06) return false;
      let d = Math.abs(Math.atan2(b, a) - bgAng);
      if (d > Math.PI) d = 2 * Math.PI - d;
      return d < (22 * Math.PI) / 180;
    };
    for (let ring = 0; ring < 2; ring++) {
      const eat: number[] = [];
      for (let p = 0; p < W * H; p++) {
        if (removed[p]) continue;
        const x = p % W, y = (p - x) / W;
        const touches = (x > 0 && removed[p - 1]) || (x < W - 1 && removed[p + 1]) || (y > 0 && removed[p - W]) || (y < H - 1 && removed[p + W]);
        if (touches && spill(p)) eat.push(p);
      }
      for (const p of eat) removed[p] = 1;
    }
  }
  // Ground shadow: video models paint a darker patch of the backdrop under the feet. It
  // shares the backdrop's hue, so on chroma backdrops the flood continues through pixels of
  // that hue with real colour in them. Only from the outside: an enclosed purple scarf stays.
  if (bg.colors.every(isChroma)) {
    const [, ba, bb] = bgLab[0];
    const bgAng = Math.atan2(bb, ba), bgChroma = Math.hypot(ba, bb);
    const shadow = (p: number) => {
      if (removed[p]) return false;
      const i = p * 4;
      const [, a, b] = lab.get(data[i], data[i + 1], data[i + 2]);
      if (Math.hypot(a, b) < bgChroma * 0.3) return false;
      let d = Math.abs(Math.atan2(b, a) - bgAng);
      if (d > Math.PI) d = 2 * Math.PI - d;
      return d < (14 * Math.PI) / 180;
    };
    for (let p = 0; p < W * H; p++) {
      if (!removed[p]) continue;
      const x = p % W, y = (p - x) / W;
      for (const n of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1])
        if (n >= 0 && shadow(n)) { removed[n] = 1; stack.push(n); }
    }
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p - x) / W;
      for (const n of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1])
        if (n >= 0 && shadow(n)) { removed[n] = 1; stack.push(n); }
    }
  }
  for (let p = 0; p < W * H; p++) if (removed[p]) data[p * 4 + 3] = 0;
  return out;
}
