import { hardenAlpha, snapToPalette, type PixelImage } from '@kinetome/core';
import { addOutline, estimateBackground, removeBackground, removeOrphans, useHoles, type Background } from '@kinetome/pixel';
import { blank, cloneImage, composite, getCel, mapBoxes, withCel, type EditorDoc } from './doc.ts';
import { opaqueBounds, replaceColor, resizeCanvas, scaleNearest, shift, type RGBA } from './raster.ts';

/**
 * Batch operations over many frames at once: the clean-up passes that make an imported
 * or generated sheet game-ready. Each takes the frame indexes to touch and a layer.
 */

type CelFn = (img: PixelImage, frameIndex: number) => PixelImage;

export function mapCels(doc: EditorDoc, layerId: string, frames: number[], fn: CelFn): EditorDoc {
  let next = doc;
  for (const i of frames) {
    const f = doc.frames[i];
    if (!f) continue;
    const cel = getCel(doc, layerId, f.id);
    if (!cel) continue;
    next = withCel(next, layerId, f.id, fn(cel, i));
  }
  return next;
}

/**
 * Removes a flat backdrop (solid, chroma or painted checkerboard) from every chosen frame.
 * The backdrop is estimated once from the first frame so every frame is cut the same way.
 */
export function removeBackgroundFrames(doc: EditorDoc, layerId: string, frames: number[], opts: { tolerance?: number; holes?: 'auto' | 'on' | 'off'; color?: RGBA | null } = {}): { doc: EditorDoc; background: Background | null } {
  const first = frames.map(i => getCel(doc, layerId, doc.frames[i]?.id ?? '')).find(Boolean);
  if (!first) return { doc, background: null };
  // judge the backdrop at the edge of the CONTENT: frames often carry a transparent margin
  // around an opaque backdrop (padding added by slicing or pixel rebuilding)
  const b = opaqueBounds(first);
  const probe = b ? cropImage(first, b) : first;
  const bg: Background | null = opts.color ? { kind: 'solid', colors: [[opts.color[0], opts.color[1], opts.color[2]]] } : estimateBackground(probe);
  if (!bg) return { doc, background: null };
  const holes = useHoles({ holes: opts.holes ?? 'auto' }, bg);
  return { doc: mapCels(doc, layerId, frames, img => removeBackground(img, bg, opts.tolerance ?? 0.09, holes)), background: bg };
}

export const cleanupFrames = (doc: EditorDoc, layerId: string, frames: number[]) => mapCels(doc, layerId, frames, img => removeOrphans(img));
export const hardenFrames = (doc: EditorDoc, layerId: string, frames: number[]) => mapCels(doc, layerId, frames, img => hardenAlpha(img));
export const snapFrames = (doc: EditorDoc, layerId: string, frames: number[], palette: string[]) =>
  palette.length >= 2 ? mapCels(doc, layerId, frames, img => snapToPalette(img, palette)) : doc;
export const replaceColorFrames = (doc: EditorDoc, layerId: string, frames: number[], from: RGBA, to: RGBA, tolerance = 0) =>
  mapCels(doc, layerId, frames, img => replaceColor(img, from, to, tolerance));

function cropImage(img: PixelImage, r: { x: number; y: number; w: number; h: number }): PixelImage {
  const out = blank(r.w, r.h);
  for (let y = 0; y < r.h; y++) out.data.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4);
  return out;
}

/** 1px outline around every chosen frame (grows into transparent pixels only). */
export function outlineFrames(doc: EditorDoc, layerId: string, frames: number[], color: string): EditorDoc {
  return mapCels(doc, layerId, frames, img => addOutline(img, color));
}

/** Horizontal centre of mass of the lowest 15% of opaque pixels: where the feet are. */
function feet(img: PixelImage): { x: number; bottom: number } | null {
  const b = opaqueBounds(img);
  if (!b) return null;
  const band = Math.max(1, Math.round(b.h * 0.15));
  let sum = 0, n = 0;
  for (let y = b.y + b.h - band; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++)
    if (img.data[(y * img.width + x) * 4 + 3] >= 128) { sum += x; n++; }
  return { x: n ? sum / n : b.x + b.w / 2, bottom: b.y + b.h - 1 };
}

/**
 * Aligns frames so the character stands on the pivot: 'feet' puts the feet centre on
 * pivot.x and the lowest pixel on pivot.y; 'center' centres the bounding box. Offsets
 * come from the flattened frame and move every layer together.
 */
export function alignFrames(doc: EditorDoc, frames: number[], mode: 'feet' | 'center'): EditorDoc {
  let next = doc;
  for (const i of frames) {
    const flat = composite(doc, i);
    let dx = 0, dy = 0;
    if (mode === 'feet') {
      const f = feet(flat);
      if (!f) continue;
      dx = Math.round(doc.pivot.x - f.x); dy = doc.pivot.y - f.bottom;
    } else {
      const b = opaqueBounds(flat);
      if (!b) continue;
      dx = Math.round(doc.width / 2 - (b.x + b.w / 2)); dy = Math.round(doc.height / 2 - (b.y + b.h / 2));
    }
    if (!dx && !dy) continue;
    for (const l of doc.layers) {
      const cel = getCel(doc, l.id, doc.frames[i].id);
      if (cel) next = withCel(next, l.id, doc.frames[i].id, shift(cel, dx, dy));
    }
    next = mapBoxes(next, b => ({ ...b, x: b.x + dx, y: b.y + dy }), new Set([i]));
  }
  return next;
}

/** Applies `fn` to every cel of every layer (used for canvas-wide changes). */
function mapAll(doc: EditorDoc, fn: (img: PixelImage) => PixelImage, width: number, height: number): EditorDoc {
  const cels: EditorDoc['cels'] = {};
  for (const [k, v] of Object.entries(doc.cels)) cels[k] = fn(v);
  return { ...doc, cels, width, height };
}

/** Crops the canvas to the union of all content across all frames and layers (+ margin). */
export function trimCanvas(doc: EditorDoc, margin = 1): EditorDoc {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const c of Object.values(doc.cels)) {
    const b = opaqueBounds(c);
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w - 1); y1 = Math.max(y1, b.y + b.h - 1);
  }
  if (x1 < 0) return doc;
  x0 = Math.max(0, x0 - margin); y0 = Math.max(0, y0 - margin);
  x1 = Math.min(doc.width - 1, x1 + margin); y1 = Math.min(doc.height - 1, y1 + margin);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const next = mapBoxes(mapAll(doc, img => resizeCanvas(img, w, h, -x0, -y0), w, h), b => ({ ...b, x: b.x - x0, y: b.y - y0 }));
  return { ...next, pivot: { x: Math.max(0, Math.min(w - 1, doc.pivot.x - x0)), y: Math.max(0, Math.min(h - 1, doc.pivot.y - y0)) } };
}

export type Anchor9 = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';

/** Canvas size change with a 9-way anchor (like every image editor's canvas size dialog). */
export function resizeDoc(doc: EditorDoc, w: number, h: number, anchor: Anchor9 = 'b'): EditorDoc {
  const fx = anchor.endsWith('l') ? 0 : anchor.endsWith('r') ? 1 : 0.5;
  const fy = anchor.startsWith('t') ? 0 : anchor.startsWith('b') ? 1 : 0.5;
  const ox = Math.round((w - doc.width) * fx), oy = Math.round((h - doc.height) * fy);
  const next = mapBoxes(mapAll(doc, img => resizeCanvas(img, w, h, ox, oy), w, h), b => ({ ...b, x: b.x + ox, y: b.y + oy }));
  return { ...next, pivot: { x: Math.max(0, Math.min(w - 1, doc.pivot.x + ox)), y: Math.max(0, Math.min(h - 1, doc.pivot.y + oy)) } };
}

/** Integer-friendly nearest-neighbour scale of the whole document. */
export function scaleDoc(doc: EditorDoc, factor: number): EditorDoc {
  const w = Math.max(1, Math.round(doc.width * factor)), h = Math.max(1, Math.round(doc.height * factor));
  const sx = w / doc.width, sy = h / doc.height;
  const next = mapBoxes(mapAll(doc, img => scaleNearest(img, w, h), w, h), b => ({ x: Math.round(b.x * sx), y: Math.round(b.y * sy), w: Math.max(1, Math.round(b.w * sx)), h: Math.max(1, Math.round(b.h * sy)) }));
  return { ...next, pivot: { x: Math.min(w - 1, Math.round(doc.pivot.x * factor)), y: Math.min(h - 1, Math.round((doc.pivot.y + 1) * factor) - 1) } };
}

/**
 * "Apply this fix to other frames": copies what changed between `before` and `after` of a
 * cel (inside `rect`) onto other frames. 'same' stamps at the same position; 'feet' shifts
 * by the difference in feet position between frames, so a fix to a hat follows the
 * character as it bobs or moves.
 */
export function propagateEdit(doc: EditorDoc, layerId: string, sourceFrame: number, before: PixelImage, after: PixelImage, targets: number[], follow: 'same' | 'feet' = 'same'): EditorDoc {
  const W = doc.width, H = doc.height;
  const changed: number[] = [];
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    if (before.data[i] !== after.data[i] || before.data[i + 1] !== after.data[i + 1] || before.data[i + 2] !== after.data[i + 2] || before.data[i + 3] !== after.data[i + 3]) changed.push(p);
  }
  if (!changed.length) return doc;
  const srcFeet = follow === 'feet' ? feet(composite(doc, sourceFrame)) : null;
  let next = doc;
  for (const t of targets) {
    if (t === sourceFrame || !doc.frames[t]) continue;
    let dx = 0, dy = 0;
    if (srcFeet) {
      const f = feet(composite(doc, t));
      if (f) { dx = Math.round(f.x - srcFeet.x); dy = f.bottom - srcFeet.bottom; }
    }
    const cel = getCel(next, layerId, doc.frames[t].id);
    const img = cel ? cloneImage(cel) : blank(W, H);
    for (const p of changed) {
      const x = (p % W) + dx, y = Math.floor(p / W) + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      img.data.set(after.data.subarray(p * 4, p * 4 + 4), (y * W + x) * 4);
    }
    next = withCel(next, layerId, doc.frames[t].id, img);
  }
  return next;
}

/** Colors used across the document (for building a palette from imported art). */
export function usedColors(doc: EditorDoc, limit = 256): string[] {
  const counts = new Map<number, number>();
  for (const c of Object.values(doc.cels))
    for (let i = 0; i < c.data.length; i += 4) {
      if (c.data[i + 3] < 128) continue;
      const k = (c.data[i] << 16) | (c.data[i + 1] << 8) | c.data[i + 2];
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => '#' + ((1 << 24) | k).toString(16).slice(1));
}
