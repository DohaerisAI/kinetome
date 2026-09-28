import type { PixelImage } from '@kinetome/core';
import { cloneImage } from './doc.ts';
import { hexToRgba, type RGBA } from './raster.ts';

/**
 * Painting modifiers layered on top of the basic tools: ordered dithering (any tool can
 * paint through a Bayer pattern) and shading ink (step a pixel along a color ramp).
 */

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Dither density in percent: 0 = off (solid), 25 / 50 / 75 = pattern coverage. */
export type Dither = 0 | 25 | 50 | 75;

/** True where a pattern of `level`% coverage paints pixel (x, y). 50% is a checkerboard. */
export function ditherAllows(x: number, y: number, level: Dither): boolean {
  if (!level) return true;
  return BAYER4[y & 3][x & 3] < (level / 100) * 16;
}

/**
 * Restores every changed pixel that falls outside the dither pattern, so a stroke, shape
 * or fill painted solid becomes a patterned one (works for every tool the same way).
 */
export function applyDither(base: PixelImage, work: PixelImage, level: Dither): PixelImage {
  if (!level) return work;
  const out = cloneImage(work), W = work.width;
  for (let p = 0; p < W * work.height; p++) {
    const i = p * 4;
    if (base.data[i] === work.data[i] && base.data[i + 1] === work.data[i + 1] && base.data[i + 2] === work.data[i + 2] && base.data[i + 3] === work.data[i + 3]) continue;
    const x = p % W, y = (p - x) / W;
    if (!ditherAllows(x, y, level)) out.data.set(base.data.subarray(i, i + 4), i);
  }
  return out;
}

// ---------- shading ----------

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function hsv(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [((h * 60) + 360) % 360, max ? d / max : 0, max];
}
function fromHsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * One step lighter (dir 1) or darker (dir -1). With a palette: the nearest palette color
 * that is lighter/darker and closest in hue (so skin shades to skin shadow, not to the
 * outline). Without one: a hue-shifted step, warm toward highlights and cool toward
 * shadows, the way pixel artists build ramps.
 */
export function shadeColor(c: RGBA, dir: 1 | -1, palette: string[] = []): RGBA {
  if (c[3] === 0) return c;
  const L = lum(c[0], c[1], c[2]);
  const [h, s, v] = hsv(c[0], c[1], c[2]);
  if (palette.length >= 2) {
    let best: RGBA | null = null, bestScore = Infinity;
    for (const hex of palette) {
      const p = hexToRgba(hex);
      const dl = (lum(p[0], p[1], p[2]) - L) * dir;
      if (dl <= 2) continue; // must actually move in that direction
      const [ph, ps] = hsv(p[0], p[1], p[2]);
      const hue = s < 0.08 || ps < 0.08 ? Math.abs(s - ps) * 120 : hueGap(h, ph);
      const score = hue * 2 + dl;
      if (score < bestScore) { bestScore = score; best = [p[0], p[1], p[2], c[3]]; }
    }
    return best ?? c;
  }
  const shiftHue = (target: number) => { const d = ((target - h + 540) % 360) - 180; return (h + Math.sign(d) * Math.min(Math.abs(d), 10) + 360) % 360; };
  const next = dir > 0
    ? fromHsv(s > 0.05 ? shiftHue(60) : h, Math.max(0, s - 0.06), Math.min(1, v + 0.12))
    : fromHsv(s > 0.05 ? shiftHue(250) : h, Math.min(1, s + 0.08), Math.max(0, v - 0.14));
  return [next[0], next[1], next[2], c[3]];
}

/**
 * Shades every opaque pixel under the points (brush-sized, clipped to `mask`), each at
 * most once per stroke: dragging over the same pixel twice doesn't keep darkening it.
 */
export function shadeStroke(base: PixelImage, points: [number, number][], size: number, dir: 1 | -1, palette: string[], mask?: Uint8Array | null): PixelImage {
  const out = cloneImage(base), W = base.width, H = base.height;
  const done = new Uint8Array(W * H);
  const o = Math.floor((size - 1) / 2);
  const cache = new Map<number, RGBA>();
  for (const [cx, cy] of points) for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
    const x = cx - o + xx, y = cy - o + yy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = y * W + x;
    if (done[p] || (mask && !mask[p])) continue;
    done[p] = 1;
    const i = p * 4;
    if (!base.data[i + 3]) continue;
    const key = (base.data[i] << 16) | (base.data[i + 1] << 8) | base.data[i + 2];
    let n = cache.get(key);
    if (!n) { n = shadeColor([base.data[i], base.data[i + 1], base.data[i + 2], 255], dir, palette); cache.set(key, n); }
    out.data[i] = n[0]; out.data[i + 1] = n[1]; out.data[i + 2] = n[2];
  }
  return out;
}
