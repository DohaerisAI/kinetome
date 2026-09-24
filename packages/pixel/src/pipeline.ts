import { countColors, hardenAlpha, snapToPalette, type PixelImage } from '@sprite/core';
import { anchorFrames, type Anchor } from './anchor.ts';
import { estimateBackground, removeBackground, type RGB } from './background.ts';
import { addOutline, removeOrphans } from './cleanup.ts';
import { contentBounds, pad } from './image.ts';
import { mapPaletteTo, sharedPalette } from './palette.ts';
import { detectPixelScale, gridAt, resize, sampleGrid, type GridGuess } from './scale.ts';

export type PixelizeMode = 'auto' | 'illustration' | 'grid' | 'native';
export type PaletteMode = 'bible' | 'auto' | 'auto-bible' | 'none';

export interface PixelizeOptions {
  /** auto: detect fake pixel art (grid), real pixel art (native), else illustration. */
  mode: PixelizeMode;
  /** Grid mode: block size in source pixels; 0 = auto-detect. */
  gridScale: number;
  /** Illustration mode: output sprite height in px (usually the Style Bible unit height). */
  targetHeight: number;
  resample: 'smooth' | 'sharp';
  palette: PaletteMode;
  /** Color count for 'auto' / 'auto-bible'. */
  colors: number;
  bible: string[];
  background: 'auto' | 'none' | 'color';
  bgColor?: RGB;
  tolerance: number;
  anchor: Anchor;
  outline: string | null;
  cleanup: boolean;
}

export interface PixelizeResult {
  frames: PixelImage[];
  pivot: { x: number; y: number };
  palette: string[];
  mode: Exclude<PixelizeMode, 'auto'>;
  grid: GridGuess | null;
  background: RGB | null;
}

export const DEFAULT_PIXELIZE: Omit<PixelizeOptions, 'bible' | 'targetHeight'> = {
  mode: 'auto', gridScale: 0, resample: 'smooth', palette: 'auto-bible', colors: 16,
  background: 'auto', tolerance: 0.09, anchor: 'feet', outline: null, cleanup: true,
};

/** Headroom around every result so idle motions (hover, stretch) never clip. */
const MARGIN = 2;

/**
 * Converts one or more source frames into clean, consistent pixel-art frames.
 * Every decision (background, crop, scale, palette) is made ONCE for all frames and
 * applied to each, which is what keeps converted animations from jittering or flickering.
 */
export function pixelize(input: PixelImage[], o: PixelizeOptions): PixelizeResult {
  if (!input.length) throw new Error('no frames');

  // 1. background (shared color, estimated from the first frame)
  const bg: RGB | null = o.background === 'none' ? null : o.background === 'color' ? (o.bgColor ?? null) : estimateBackground(input[0]);
  let frames = bg ? input.map(f => removeBackground(f, bg, o.tolerance)) : input;

  // 2. decide the mode
  let mode: PixelizeResult['mode'];
  let grid: GridGuess | null = null;
  if (o.mode === 'grid' && o.gridScale >= 2) grid = gridAt(frames[0], o.gridScale);
  else if (o.mode === 'auto' || o.mode === 'grid') grid = detectPixelScale(frames[0]);
  if (o.mode === 'auto') {
    const b = contentBounds(frames[0], 128);
    const small = !!b && b.h <= o.targetHeight * 1.5;
    mode = grid && grid.scale >= 2 ? 'grid' : small && countColors(frames[0]).size <= 64 ? 'native' : 'illustration';
  } else mode = o.mode;
  if (mode === 'grid' && !grid) mode = 'illustration';

  // 3. true pixels from a detected grid (same grid for every frame)
  if (mode === 'grid') frames = frames.map(f => sampleGrid(f, grid!));

  // 4. shared crop + anchoring at the current resolution
  const anchored = anchorFrames(frames, o.anchor);
  frames = anchored.frames;
  let pivot = anchored.pivot;

  // 5. illustration: one scale factor for all frames, from the tallest content
  if (mode === 'illustration') {
    const h = frames[0].height;
    const s = h / Math.max(4, o.targetHeight);
    if (s > 1) {
      const tw = Math.max(1, Math.round(frames[0].width / s)), th = Math.max(1, Math.round(h / s));
      frames = frames.map(f => resize(f, tw, th, o.resample));
      pivot = { x: Math.min(tw - 1, Math.round(pivot.x / s)), y: th - 1 };
    }
  }

  // 6. alpha, then one palette for all frames
  frames = frames.map(f => hardenAlpha(f));
  let palette: string[] = [];
  if (o.palette === 'bible') palette = o.bible;
  else if (o.palette === 'auto') palette = sharedPalette(frames, o.colors);
  else if (o.palette === 'auto-bible') palette = mapPaletteTo(sharedPalette(frames, o.colors), o.bible);
  if (palette.length >= 2) frames = frames.map(f => snapToPalette(f, palette));

  // 7. cleanup, margin, outline
  if (o.cleanup) frames = frames.map(f => removeOrphans(f));
  frames = frames.map(f => pad(f, MARGIN));
  pivot = { x: pivot.x + MARGIN, y: pivot.y + MARGIN };
  if (o.outline) frames = frames.map(f => addOutline(f, o.outline!));

  if (!palette.length) palette = [...countColors(frames[0]).keys()];
  return { frames, pivot, palette, mode, grid, background: bg };
}
