import { hexToRgb, type PixelImage } from '@kinetome/core';
import { createImage } from './image.ts';

/** A generated VFX animation. `anchor` is where it attaches to the character (impact point, feet, ...). */
export interface EffectAnimation {
  frames: PixelImage[];
  fps: number;
  loop: boolean;
  anchor: { x: number; y: number };
}

export interface EffectOptions {
  /** Square canvas size in pixels. */
  size: number;
  frames?: number;
  /** Ramp from darkest to lightest; every drawn pixel uses exactly one of these. */
  colors?: string[];
  seed?: number;
}

export interface SlashOptions extends EffectOptions {
  /** Max crescent thickness in pixels (at the leading edge). */
  thickness?: number;
  direction?: 'right' | 'left';
  /** Degrees swept by the blade. */
  arc?: number;
}

export interface LeafOptions extends EffectOptions { count?: number }

type RGB = [number, number, number];

/** Deterministic PRNG so the same seed always yields the same effect. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless per-pixel noise in [0,1), used for dissolve patterns that must not depend on draw order. */
function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (t: number) => 1 - (1 - t) ** 2;

function put(img: PixelImage, x: number, y: number, c: RGB): void {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
}

/** Palette as RGB, padded/trimmed to exactly `n` entries (dark → light). */
function ramp(colors: string[], n: number): RGB[] {
  const rgb = colors.map(hexToRgb);
  if (!rgb.length) throw new Error('effect needs at least one color');
  return Array.from({ length: n }, (_, i) => rgb[Math.round((i * (rgb.length - 1)) / Math.max(1, n - 1))]);
}

/** Progress of frame t in [0,1]; a single frame counts as the start. */
const prog = (t: number, n: number) => (n > 1 ? t / (n - 1) : 0);

function flipX(img: PixelImage): PixelImage {
  const out = createImage(img.width, img.height);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4, d = (y * img.width + (img.width - 1 - x)) * 4;
      for (let k = 0; k < 4; k++) out.data[d + k] = img.data[s + k];
    }
  return out;
}

/**
 * Crescent sword/kick slash. The blade's leading edge sweeps along the arc while a trailing
 * edge follows behind, so early frames show a growing smear and late frames a thinning
 * sliver. The outer rim is fixed at radius R and the inner edge moves inward with thickness,
 * which gives the classic crescent: thick at the head, tapering to a point at the tail.
 */
export function slashArc(o: SlashOptions): EffectAnimation {
  const S = o.size, n = Math.max(1, o.frames ?? 5), arc = Math.min(350, Math.max(20, o.arc ?? 150));
  const [dark, mid, light] = ramp(o.colors ?? SLASH_DEFAULTS.colors, 3);
  const thick = Math.max(1, o.thickness ?? Math.max(2, Math.round(S / 8)));
  const cx = S / 2, cy = S / 2, R = S / 2 - 1;
  const a0 = -arc / 2; // centered on "pointing right"; left is a mirror
  const sweep = Math.max(1, Math.ceil(n * 0.6)), lag = Math.min(n - 1, Math.ceil(n * 0.4));
  const frames: PixelImage[] = [];
  for (let t = 0; t < n; t++) {
    const img = createImage(S, S);
    const head = arc * easeOut(clamp01((t + 1) / sweep));
    const tail = arc * 0.92 * clamp01((t + 1 - lag) / Math.max(1, n - lag));
    const span = Math.max(1e-6, head - tail);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy);
        if (r > R) continue;
        const rel = (((Math.atan2(dy, dx) * 180) / Math.PI - a0) % 360 + 360) % 360;
        if (rel < tail || rel > head) continue;
        const u = (rel - tail) / span; // 0 at the tail, 1 at the head
        const w = thick * (0.35 + 0.65 * u) * Math.min(1, (1 - u) * 5 + 0.5);
        const depth = R - r;
        if (depth >= w) continue;
        put(img, x, y, depth < 1 ? light : depth >= w - 1 ? dark : u > 0.5 ? mid : dark);
      }
    frames.push(o.direction === 'left' ? flipX(img) : img);
  }
  const midA = ((a0 + arc / 2) * Math.PI) / 180;
  const ax = Math.round(cx + Math.cos(midA) * R);
  return {
    frames, fps: 18, loop: false,
    anchor: { x: o.direction === 'left' ? S - 1 - ax : ax, y: Math.round(cy + Math.sin(midA) * R) },
  };
}

/**
 * Ground dust: seeded clumps spread outward along the floor and rise a little, swelling then
 * shrinking; in the second half each clump erodes with stable per-pixel noise so it
 * dissipates as scattered pixels instead of blinking out.
 */
export function dustPuff(o: EffectOptions): EffectAnimation {
  const S = o.size, n = Math.max(1, o.frames ?? 6);
  const [dark, mid, light] = ramp(o.colors ?? DUST_DEFAULTS.colors, 3);
  const rand = mulberry32(o.seed ?? 1);
  const ground = S - 1, cx = S / 2;
  const clumps = Array.from({ length: 6 }, (_, i) => ({
    dir: (i % 2 ? 1 : -1) * (0.25 + rand() * 0.75),
    rise: 0.3 + rand() * 0.7,
    r: S * (0.1 + rand() * 0.08),
  }));
  const seed = o.seed ?? 1;
  const frames: PixelImage[] = [];
  for (let t = 0; t < n; t++) {
    const p = prog(t, n), img = createImage(S, S);
    const erode = 0.92 * clamp01((p - 0.45) / 0.55);
    for (const c of clumps) {
      const r = Math.max(0.8, c.r * (p < 0.35 ? 0.55 + (p / 0.35) * 0.45 : 1 - (p - 0.35) * 0.55));
      const px = cx + c.dir * S * 0.42 * (0.25 + 0.75 * easeOut(p));
      const py = ground - r - c.rise * p * S * 0.2;
      for (let y = Math.floor(py - r); y <= Math.ceil(py + r); y++)
        for (let x = Math.floor(px - r); x <= Math.ceil(px + r); x++) {
          const dx = x + 0.5 - px, dy = y + 0.5 - py;
          if (dx * dx + dy * dy > r * r || y > ground) continue;
          if (hash(x, y, seed) < erode) continue;
          put(img, x, y, dy < -r * 0.35 ? light : dy > r * 0.35 ? dark : mid);
        }
    }
    frames.push(img);
  }
  return { frames, fps: 12, loop: false, anchor: { x: Math.floor(cx), y: ground } };
}

/** Draws a 1px line from polar radius r0 to r1 along angle `a`, coloring by distance along it. */
function ray(img: PixelImage, cx: number, cy: number, a: number, r0: number, r1: number, pick: (f: number) => RGB): void {
  const steps = Math.ceil((r1 - r0) * 2);
  for (let s = 0; s <= steps; s++) {
    const r = r0 + ((r1 - r0) * s) / Math.max(1, steps);
    put(img, cx + Math.cos(a) * r, cy + Math.sin(a) * r, pick(steps ? s / steps : 1));
  }
}

/**
 * Impact star: a bright core flashes, seeded rays shoot out, then detach from the center
 * (inner radius grows faster than the outer) so the last frames are flying fragments.
 */
export function hitSpark(o: EffectOptions): EffectAnimation {
  const S = o.size, n = Math.max(1, o.frames ?? 4);
  const [dark, mid, light] = ramp(o.colors ?? SPARK_DEFAULTS.colors, 3);
  const rand = mulberry32(o.seed ?? 1);
  const count = 8, base = rand() * Math.PI * 2;
  const rays = Array.from({ length: count }, (_, i) => ({
    a: base + (i * Math.PI * 2) / count + (rand() - 0.5) * 0.35,
    len: i % 2 ? 0.55 + rand() * 0.2 : 0.85 + rand() * 0.15,
  }));
  const cx = Math.floor(S / 2) + 0.5, cy = cx, maxR = S / 2 - 1;
  const frames: PixelImage[] = [];
  for (let t = 0; t < n; t++) {
    const p = prog(t, n), img = createImage(S, S);
    const core = Math.round(S * 0.12 * (1 - p * 1.4));
    for (let dy = -core; dy <= core; dy++)
      for (let dx = -core; dx <= core; dx++)
        if (Math.abs(dx) + Math.abs(dy) <= core) put(img, cx + dx, cy + dy, Math.abs(dx) + Math.abs(dy) === core && core > 1 ? mid : light);
    for (const r of rays) {
      const r1 = maxR * r.len * (0.45 + 0.55 * easeOut(clamp01(p * 1.6)));
      const r0 = Math.min(r1 - 1, maxR * r.len * clamp01(p * 1.2 - 0.15));
      ray(img, cx, cy, r.a, Math.max(0, r0), r1, f => (p > 0.7 ? (f > 0.5 ? dark : mid) : f < 0.45 ? light : f < 0.8 ? mid : dark));
    }
    frames.push(img);
  }
  return { frames, fps: 20, loop: false, anchor: { x: Math.floor(cx), y: Math.floor(cy) } };
}

/** Tiny leaf stamps (3–4 px) for four orientations, picked from the leaf's orbit angle. */
const LEAF_SHAPES: [number, number][][] = [
  [[0, 0], [1, 0], [2, 0], [1, -1]],
  [[0, 0], [1, -1], [2, -2], [1, 0]],
  [[0, 0], [0, -1], [0, -2], [1, -1]],
  [[0, -2], [1, -1], [2, 0], [1, -2]],
];

/**
 * Leaves orbit a vertical axis while climbing: each has its own phase and start height, the
 * orbit widens as they rise (tornado funnel), and leaves on the far side of the orbit use the
 * dark shade so the swirl reads as 3D. Rising is monotonic, so it plays once rather than loops.
 */
export function leafSwirl(o: LeafOptions): EffectAnimation {
  const S = o.size, n = Math.max(1, o.frames ?? 10), count = Math.max(1, o.count ?? 10);
  const [dark, mid, light] = ramp(o.colors ?? LEAF_DEFAULTS.colors, 3);
  const rand = mulberry32(o.seed ?? 1);
  const leaves = Array.from({ length: count }, () => ({ phase: rand() * Math.PI * 2, h: rand(), spin: 1.2 + rand() * 0.8 }));
  const cx = S / 2, bottom = S - 2;
  const frames: PixelImage[] = [];
  for (let t = 0; t < n; t++) {
    const p = prog(t, n), img = createImage(S, S);
    const placed = leaves.map(l => {
      const up = l.h * 0.3 + p * 0.6;
      const a = l.phase + p * Math.PI * 2 * l.spin;
      return { up, a, x: cx + Math.cos(a) * S * (0.1 + 0.3 * up), y: bottom - up * (S - 5) };
    });
    // Far-side leaves first so near-side ones overlap them.
    placed.sort((a, b) => Math.sin(a.a) - Math.sin(b.a));
    for (const l of placed) {
      const front = Math.sin(l.a) >= 0;
      const k = Math.floor((((l.a % Math.PI) + Math.PI) % Math.PI) / (Math.PI / 4)) % 4;
      LEAF_SHAPES[k].forEach(([dx, dy], i) => put(img, l.x + dx - 1, l.y + dy + 1, !front ? dark : i === 0 ? light : mid));
    }
    frames.push(img);
  }
  return { frames, fps: 12, loop: false, anchor: { x: Math.floor(cx), y: bottom } };
}

/**
 * Magic burst: center flash, then a ring that expands (easing out) and thins from 2px to 1px
 * while darkening; seeded sparkles twinkle around the ring as plus-shapes, shrinking to dots.
 */
export function magicBurst(o: EffectOptions): EffectAnimation {
  const S = o.size, n = Math.max(1, o.frames ?? 8);
  const [dark, mid, light] = ramp(o.colors ?? MAGIC_DEFAULTS.colors, 3);
  const rand = mulberry32(o.seed ?? 1);
  const seed = o.seed ?? 1;
  const sparks = Array.from({ length: 10 }, () => ({ a: rand() * Math.PI * 2, k: 0.5 + rand() * 0.7 }));
  const cx = S / 2, cy = S / 2, maxR = S / 2 - 1.5;
  const frames: PixelImage[] = [];
  for (let t = 0; t < n; t++) {
    const p = prog(t, n), img = createImage(S, S);
    const r = Math.max(1, maxR * easeOut(Math.min(1, 0.15 + p)));
    const w = p < 0.6 ? 2 : 1;
    const ringC = p < 0.35 ? light : p < 0.7 ? mid : dark;
    const flash = p < 0.25 ? S * 0.14 * (1 - p * 3) : 0;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d < flash) put(img, x, y, light);
        else if (Math.abs(d - r) < w / 2) put(img, x, y, ringC);
      }
    sparks.forEach((s, i) => {
      if (hash(i, t, seed) < 0.3) return; // twinkle
      const sr = Math.min(maxR, r * s.k), x = cx + Math.cos(s.a) * sr, y = cy + Math.sin(s.a) * sr;
      put(img, x, y, light);
      if (p < 0.6) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(img, x + dx, y + dy, mid);
    });
    frames.push(img);
  }
  return { frames, fps: 14, loop: false, anchor: { x: Math.floor(cx), y: Math.floor(cy) } };
}

const SLASH_DEFAULTS = { size: 48, frames: 5, colors: ['#3a6ea5', '#9ad0f5', '#ffffff'], thickness: 6, direction: 'right' as const, arc: 150, seed: 1 };
const DUST_DEFAULTS = { size: 32, frames: 6, colors: ['#6b5a4a', '#a89078', '#d8c8b0'], seed: 1 };
const SPARK_DEFAULTS = { size: 32, frames: 4, colors: ['#c0392b', '#f5a623', '#fff6c8'], seed: 1 };
const LEAF_DEFAULTS = { size: 48, frames: 10, colors: ['#2e5e2a', '#5fa33a', '#b5e36b'], count: 10, seed: 1 };
const MAGIC_DEFAULTS = { size: 40, frames: 8, colors: ['#5b2a86', '#a45ee5', '#f3d9ff'], seed: 1 };

export interface EffectDef {
  id: string;
  name: string;
  defaults: Record<string, unknown>;
  /** Builds the effect; missing options fall back to `defaults`. */
  make(opts?: Record<string, unknown>): EffectAnimation;
}

/** Registry for the UI: every effect with its label and default options. */
export const EFFECTS: EffectDef[] = [
  { id: 'slash', name: 'Slash arc', defaults: SLASH_DEFAULTS, make: o => slashArc({ ...SLASH_DEFAULTS, ...o } as SlashOptions) },
  { id: 'dust', name: 'Dust puff', defaults: DUST_DEFAULTS, make: o => dustPuff({ ...DUST_DEFAULTS, ...o } as EffectOptions) },
  { id: 'spark', name: 'Hit spark', defaults: SPARK_DEFAULTS, make: o => hitSpark({ ...SPARK_DEFAULTS, ...o } as EffectOptions) },
  { id: 'leaves', name: 'Leaf swirl', defaults: LEAF_DEFAULTS, make: o => leafSwirl({ ...LEAF_DEFAULTS, ...o } as LeafOptions) },
  { id: 'magic', name: 'Magic burst', defaults: MAGIC_DEFAULTS, make: o => magicBurst({ ...MAGIC_DEFAULTS, ...o } as EffectOptions) },
];
