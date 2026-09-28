import { hexToRgb, oklabToRgb, rampFor, rgbToOklab, type PixelImage } from './color.ts';

/** One color ramp swap: `from[i]` becomes `to[i]` (shadow→shadow, base→base, light→light). */
export interface RampMapping { from: string[]; to: string[] }

export type TintKind = 'hurt' | 'frozen' | 'poison' | 'shadow' | 'gold' | 'ghost';

const pack = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
const packHex = (hex: string) => pack(...hexToRgb(hex));

function copy(img: PixelImage): PixelImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/**
 * Exact-color swaps for palette variants (alt costumes, team colors). Only pixels whose RGB
 * exactly matches a `from` color change; everything else, and every alpha value, is untouched.
 * Later mappings win if two map the same source color.
 */
export function recolorByRamps(img: PixelImage, mapping: RampMapping[]): PixelImage {
  const swap = new Map<number, [number, number, number]>();
  for (const m of mapping)
    for (let i = 0; i < Math.min(m.from.length, m.to.length); i++) swap.set(packHex(m.from[i]), hexToRgb(m.to[i]));
  const out = copy(img), d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const to = swap.get(pack(d[i], d[i + 1], d[i + 2]));
    if (to) { d[i] = to[0]; d[i + 1] = to[1]; d[i + 2] = to[2]; }
  }
  return out;
}

/** The [shadow, base, light] swap that recolors a design part from `fromHex` to `toHex`. */
export function rampSwap(fromHex: string, toHex: string): RampMapping {
  const a = rampFor(fromHex), b = rampFor(toHex);
  return { from: [a.shadow, a.base, a.light], to: [b.shadow, b.base, b.light] };
}

/** 4-color ramps (dark → light) used by the luminance-remapped tints. */
export const TINT_RAMPS = {
  frozen: ['#1b3b6f', '#3f7cc4', '#8fd3f0', '#e8fbff'],
  poison: ['#1d3b12', '#3f7a1e', '#7cc242', '#c8f07a'],
  gold: ['#5a3a0a', '#a86a12', '#e8b030', '#fff0a0'],
} as const;

const SHADOW = '#1a1026';
const HURT = '#ffffff';
/** Ghost alpha: exactly half, so engines can alpha-blend it; this variant is intentionally not binary. */
export const GHOST_ALPHA = 128;

/** Outline pixels: the darkest opaque color, where it touches transparency or the image edge. */
function outlineMask(img: PixelImage): Uint8Array {
  const { width: W, height: H, data: d } = img;
  const mask = new Uint8Array(W * H);
  let darkest = -1, minL = Infinity;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const L = rgbToOklab(d[i], d[i + 1], d[i + 2])[0];
    if (L < minL) { minL = L; darkest = pack(d[i], d[i + 1], d[i + 2]); }
  }
  const clear = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H || d[(y * W + x) * 4 + 3] === 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] === 0 || pack(d[i], d[i + 1], d[i + 2]) !== darkest) continue;
      if (clear(x - 1, y) || clear(x + 1, y) || clear(x, y - 1) || clear(x, y + 1)) mask[y * W + x] = 1;
    }
  return mask;
}

/**
 * Classic game-state variants:
 * - hurt: white flash silhouette; the outline (darkest color on the silhouette edge) is kept.
 * - frozen / poison / gold: each color is remapped by its lightness, normalized over the
 *   sprite's own darkest..lightest range, into a 4-color ramp (TINT_RAMPS) so shading survives.
 * - shadow: flat dark silhouette.
 * - ghost: greyscale by lightness with alpha set to exactly GHOST_ALPHA (128) on every visible
 *   pixel; no dithering, so it is the one non-binary-alpha variant.
 */
export function tintVariant(img: PixelImage, kind: TintKind): PixelImage {
  const out = copy(img), d = out.data;
  const set = (i: number, [r, g, b]: [number, number, number]) => { d[i] = r; d[i + 1] = g; d[i + 2] = b; };
  if (kind === 'hurt') {
    const mask = outlineMask(img), white = hexToRgb(HURT);
    for (let p = 0; p < mask.length; p++) if (d[p * 4 + 3] && !mask[p]) set(p * 4, white);
    return out;
  }
  if (kind === 'shadow') {
    const c = hexToRgb(SHADOW);
    for (let i = 0; i < d.length; i += 4) if (d[i + 3]) set(i, c);
    return out;
  }
  const L = new Float64Array(d.length / 4);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const l = (L[i / 4] = rgbToOklab(d[i], d[i + 1], d[i + 2])[0]);
    if (l < lo) lo = l; if (l > hi) hi = l;
  }
  if (kind === 'ghost') {
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      set(i, oklabToRgb(L[i / 4], 0, 0));
      d[i + 3] = GHOST_ALPHA;
    }
    return out;
  }
  const ramp = TINT_RAMPS[kind].map(hexToRgb);
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const t = hi > lo ? (L[i / 4] - lo) / (hi - lo) : 0.5;
    set(i, ramp[Math.max(0, Math.min(ramp.length - 1, Math.floor(t * ramp.length)))]);
  }
  return out;
}

/**
 * Rotates every color's hue by `degrees` in Oklab (lightness and chroma kept, so shading reads
 * the same). Colors in `protect` (skin, outline...) and near-greys are left exactly as they are.
 */
export function hueShiftVariant(img: PixelImage, degrees: number, opts: { protect?: string[] } = {}): PixelImage {
  const out = copy(img), d = out.data;
  if (degrees % 360 === 0) return out;
  const keep = new Set((opts.protect ?? []).map(packHex));
  const rad = (degrees * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const cache = new Map<number, [number, number, number] | null>();
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const k = pack(d[i], d[i + 1], d[i + 2]);
    let to = cache.get(k);
    if (to === undefined) {
      const [l, a, b] = rgbToOklab(d[i], d[i + 1], d[i + 2]);
      to = keep.has(k) || Math.hypot(a, b) < 0.01 ? null : oklabToRgb(l, a * cos - b * sin, a * sin + b * cos);
      cache.set(k, to);
    }
    if (to) { d[i] = to[0]; d[i + 1] = to[1]; d[i + 2] = to[2]; }
  }
  return out;
}
