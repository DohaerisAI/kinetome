import { countColors, hardenAlpha, snapToPalette, type PixelImage, type Rect } from '@kinetome/core';
import { anchorFrames, type Anchor } from './anchor.ts';
import { estimateBackground, isChroma, removeBackground, type Background, type RGB } from './background.ts';
import { addOutline, hasOutline, keepMainFigure, removeOrphans } from './cleanup.ts';
import { bodyHeight, contentBounds, crop, pad } from './image.ts';
import { mapPaletteTo, sharedPalette } from './palette.ts';
import { detectPixelScale, gridAt, resize, sampleGrid, type GridGuess } from './scale.ts';
import { splitSheet } from './split.ts';

export type PixelizeMode = 'auto' | 'illustration' | 'grid' | 'native';
export type PaletteMode = 'bible' | 'auto' | 'auto-bible' | 'fixed' | 'none';

export interface PixelizeOptions {
  /** auto: detect fake pixel art (grid), real pixel art (native), else illustration. */
  mode: PixelizeMode;
  /** Grid mode: block size in source pixels; 0 = auto-detect per frame. */
  gridScale: number;
  /** Illustration mode: output sprite height in px (usually the Style Bible unit height). */
  targetHeight: number;
  resample: 'smooth' | 'sharp';
  palette: PaletteMode;
  /** Color count for 'auto' / 'auto-bible'. */
  colors: number;
  bible: string[];
  /** 'fixed': exact colors to use (e.g. an existing character's palette). */
  fixedPalette: string[];
  background: 'auto' | 'none';
  tolerance: number;
  /** Remove enclosed backdrop pockets. 'auto' = only for chroma/checker backdrops. */
  holes: 'auto' | 'on' | 'off';
  anchor: Anchor;
  /** Rescale frames whose size drifts from the others (AI draws some poses bigger). */
  normalizeSize: boolean;
  outline: string | null;
  cleanup: boolean;
  /**
   * Crisp finish for smooth sources (video, painted art): a small contrast/saturation lift and
   * every edge pixel darkened, so the downscale reads as pixel art instead of a blurry photo.
   */
  crisp?: boolean;
  /** Drop marks far from the character (generator watermarks, captions). */
  isolate?: boolean;
}

export interface PixelizeResult {
  frames: PixelImage[];
  pivot: { x: number; y: number };
  palette: string[];
  mode: Exclude<PixelizeMode, 'auto'>;
  /** Grid per frame (grid mode). */
  grids: (GridGuess | null)[];
}

export const DEFAULT_PIXELIZE: Omit<PixelizeOptions, 'bible' | 'targetHeight'> = {
  mode: 'auto', gridScale: 0, resample: 'smooth', palette: 'auto-bible', colors: 16, fixedPalette: [],
  background: 'auto', tolerance: 0.09, holes: 'auto', anchor: 'feet', normalizeSize: true, outline: null, cleanup: true,
};

/** Headroom around every result so idle motions (hover, stretch) never clip. */
const MARGIN = 2;

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function useHoles(o: Pick<PixelizeOptions, 'holes'>, bg: Background | null): boolean {
  if (!bg || o.holes === 'off') return false;
  return o.holes === 'on' || bg.kind === 'checker' || bg.colors.every(isChroma);
}

export interface PreparedSheet {
  frames: PixelImage[];
  rects: Rect[];
  rows: number[][];
  background: Background | null;
  dropped: number;
}

/**
 * One image holding many poses (the usual AI "sprite sheet") -> separate frames, backdrop
 * already removed. Returns a single frame when the image holds one pose.
 */
export function prepareSheet(img: PixelImage, o: Pick<PixelizeOptions, 'background' | 'tolerance' | 'holes'>): PreparedSheet {
  const bg = o.background === 'none' ? null : estimateBackground(img);
  const clean = bg ? removeBackground(img, bg, o.tolerance, useHoles(o, bg)) : img;
  const split = splitSheet(clean);
  if (split.rects.length <= 1) {
    const b = contentBounds(clean, 128) ?? { x: 0, y: 0, w: img.width, h: img.height };
    return { frames: [crop(clean, b)], rects: [b], rows: [[0]], background: bg, dropped: split.dropped };
  }
  return { frames: split.rects.map(r => crop(clean, r)), rects: split.rects, rows: split.rows, background: bg, dropped: split.dropped };
}

/** Contrast and saturation lift, then a darkened inner edge (the outline a downscale erases). */
export function crispen(img: PixelImage, contrast = 1.08, saturation = 1.15, edge = 0.5): PixelImage {
  const { width: W, height: H } = img, d = new Uint8ClampedArray(img.data);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    for (let c = 0; c < 3; c++) d[i + c] = ((l + (d[i + c] - l) * saturation) - 128) * contrast + 128;
  }
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && img.data[(y * W + x) * 4 + 3] >= 128;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!opaque(x, y) || (opaque(x - 1, y) && opaque(x + 1, y) && opaque(x, y - 1) && opaque(x, y + 1))) continue;
    const i = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) d[i + c] *= edge;
  }
  return { width: W, height: H, data: d };
}

/** Colors that show up in only a few frames and barely: the flicker AI conversions leave behind. */
function pruneFlickerColors(frames: PixelImage[], palette: string[]): string[] {
  if (frames.length < 4 || palette.length <= 2) return palette;
  const inFrames = new Map<string, number>(), total = new Map<string, number>();
  let pixels = 0;
  for (const f of frames) {
    for (const [hex, n] of countColors(f)) { inFrames.set(hex, (inFrames.get(hex) ?? 0) + 1); total.set(hex, (total.get(hex) ?? 0) + n); pixels += n; }
  }
  const keep = palette.filter(h => !((inFrames.get(h) ?? 0) < frames.length * 0.25 && (total.get(h) ?? 0) < pixels * 0.005));
  return keep.length >= 2 ? keep : palette;
}

/**
 * Converts source frames into clean, consistent pixel-art frames. Every decision
 * (background, scale, palette, anchoring) is made for all frames together, which is what
 * keeps animations from jittering or flickering.
 */
export function pixelize(input: PixelImage[], o: PixelizeOptions): PixelizeResult {
  if (!input.length) throw new Error('no frames');

  // 1. background (one backdrop for all frames, estimated from the first)
  const bg = o.background === 'none' ? null : estimateBackground(input[0]);
  let frames = bg ? input.map(f => removeBackground(f, bg, o.tolerance, useHoles(o, bg))) : input;
  if (o.isolate) frames = frames.map(f => keepMainFigure(f));

  // 2. mode + grids. AI sheets can draw poses at slightly different block sizes, so each
  //    frame gets its own grid when detection is confident and close to the consensus.
  let mode: PixelizeResult['mode'];
  let grids: (GridGuess | null)[] = frames.map(() => null);
  if (o.mode === 'grid' && o.gridScale >= 2) grids = frames.map(f => gridAt(f, o.gridScale));
  else if (o.mode === 'auto' || o.mode === 'grid') {
    const probe = frames.map((f, i) => (i < 24 ? detectPixelScale(f) : null));
    const scales = probe.filter((g): g is GridGuess => !!g).map(g => g.scale);
    const consensus = scales.length >= Math.max(1, Math.ceil(Math.min(frames.length, 24) * 0.4)) ? median(scales) : 0;
    if (consensus >= 2) {
      grids = frames.map((f, i) => {
        const g = probe[i];
        return g && Math.abs(g.scale / consensus - 1) < 0.25 ? g : gridAt(f, consensus);
      });
    }
  }
  if (o.mode === 'auto') {
    const b = contentBounds(frames[0], 128);
    const small = !!b && b.h <= o.targetHeight * 1.5;
    mode = grids[0] ? 'grid' : small && countColors(frames[0]).size <= 64 ? 'native' : 'illustration';
  } else mode = o.mode;
  if (mode === 'grid' && !grids[0]) mode = 'illustration';

  // Size drift is judged on BODY height (weapons/hair ignored). Under 6% is natural motion
  // (walk bob); over 20% is intentional (crouch, jump); in between the generator drew the
  // character at the wrong size and it gets corrected.
  const drift = (r: number) => Math.abs(r - 1) >= 0.06 && Math.abs(r - 1) <= 0.2;

  // 3. true pixels from each frame's grid; off-size frames are re-sampled from the source
  //    at a corrected block size (cleaner than scaling finished pixel art)
  if (mode === 'grid') {
    const sources = frames;
    frames = frames.map((f, i) => sampleGrid(f, grids[i]!));
    if (o.normalizeSize && frames.length > 2) {
      const hs = frames.map(bodyHeight), mh = median(hs.filter(h => h > 0));
      frames = frames.map((f, i) => {
        const r = hs[i] / mh;
        if (!hs[i] || !drift(r)) return f;
        grids[i] = gridAt(sources[i], grids[i]!.scale * r);
        return sampleGrid(sources[i], grids[i]!);
      });
    }
  }

  // 4. illustration: rescale off-size frames to the median body height
  if (o.normalizeSize && mode === 'illustration' && frames.length > 2) {
    const hs = frames.map(bodyHeight), mh = median(hs.filter(h => h > 0));
    frames = frames.map((f, i) => {
      const r = hs[i] ? mh / hs[i] : 1;
      if (!drift(1 / r)) return f;
      const b = contentBounds(f, 128)!;
      return resize(crop(f, b), Math.max(1, Math.round(b.w * r)), Math.max(1, Math.round(b.h * r)), o.resample);
    });
  }

  // 5. shared crop + anchoring
  const anchored = anchorFrames(frames, o.anchor);
  frames = anchored.frames;
  let pivot = anchored.pivot;

  // 6. illustration: one scale factor for all frames, from the tallest content
  if (mode === 'illustration') {
    const h = frames[0].height;
    const s = h / Math.max(4, o.targetHeight);
    if (s > 1) {
      const tw = Math.max(1, Math.round(frames[0].width / s)), th = Math.max(1, Math.round(h / s));
      frames = frames.map(f => resize(f, tw, th, o.resample));
      pivot = { x: Math.min(tw - 1, Math.round(pivot.x / s)), y: th - 1 };
    }
  }

  // 7. alpha, then one palette for all frames
  frames = frames.map(f => hardenAlpha(f));
  if (o.crisp && mode === 'illustration') frames = frames.map(f => crispen(f));
  let palette: string[] = [];
  if (o.palette === 'bible') palette = o.bible;
  else if (o.palette === 'fixed') palette = o.fixedPalette;
  else if (o.palette === 'auto') palette = sharedPalette(frames, o.colors);
  else if (o.palette === 'auto-bible') palette = mapPaletteTo(sharedPalette(frames, o.colors), o.bible);
  if (palette.length >= 2) {
    frames = frames.map(f => snapToPalette(f, palette));
    const pruned = pruneFlickerColors(frames, palette);
    if (pruned.length < palette.length) { palette = pruned; frames = frames.map(f => snapToPalette(f, palette)); }
  }

  // 8. cleanup, margin, outline
  if (o.cleanup) frames = frames.map(f => removeOrphans(f));
  frames = frames.map(f => pad(f, MARGIN));
  pivot = { x: pivot.x + MARGIN, y: pivot.y + MARGIN };
  // "Outline" means ensure one: art that already has a dark outline is left alone.
  const outlined = frames.filter(hasOutline).length > frames.length / 2;
  if (o.outline && !outlined) frames = frames.map(f => addOutline(f, o.outline!));

  const used = new Set<string>();
  for (const f of frames) for (const h of countColors(f).keys()) used.add(h);
  return { frames, pivot, palette: palette.length ? palette.filter(h => used.has(h)) : [...used], mode, grids };
}

export type { RGB };
