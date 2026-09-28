import { normalizeFrames, packGrid, type Animation, type PixelImage, type Rect, type SpriteAsset } from '@kinetome/core';
import { blank, composite, docFromFrames, type EditorDoc, type Tag } from './doc.ts';

/**
 * Slicing a sheet into frames (the Aseprite "Import Sprite Sheet" dialog and more):
 * even grids by cell size or by rows x columns, with offset and padding, or any list of
 * uneven rectangles (auto-detected or drawn by hand) normalised onto one canvas.
 */

export interface GridSpec {
  frameW: number;
  frameH: number;
  offsetX?: number;
  offsetY?: number;
  /** Gap between cells. */
  padX?: number;
  padY?: number;
  order?: 'rows' | 'cols';
  /** Stop after this many cells (0 = all). */
  count?: number;
}

export function gridRects(imgW: number, imgH: number, g: GridSpec): Rect[] {
  const ox = g.offsetX ?? 0, oy = g.offsetY ?? 0, px = g.padX ?? 0, py = g.padY ?? 0;
  if (g.frameW < 1 || g.frameH < 1) return [];
  const cols = Math.max(0, Math.floor((imgW - ox + px) / (g.frameW + px)));
  const rows = Math.max(0, Math.floor((imgH - oy + py) / (g.frameH + py)));
  const out: Rect[] = [];
  const at = (c: number, r: number) => out.push({ x: ox + c * (g.frameW + px), y: oy + r * (g.frameH + py), w: g.frameW, h: g.frameH });
  if (g.order === 'cols') { for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) at(c, r); }
  else { for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) at(c, r); }
  return g.count ? out.slice(0, g.count) : out;
}

/** Even split by number of columns and rows (cell size derived from the sheet size). */
export function countRects(imgW: number, imgH: number, cols: number, rows: number, opts: Omit<GridSpec, 'frameW' | 'frameH'> = {}): Rect[] {
  const ox = opts.offsetX ?? 0, oy = opts.offsetY ?? 0, px = opts.padX ?? 0, py = opts.padY ?? 0;
  const frameW = Math.floor((imgW - ox - px * (cols - 1)) / Math.max(1, cols));
  const frameH = Math.floor((imgH - oy - py * (rows - 1)) / Math.max(1, rows));
  return gridRects(imgW, imgH, { ...opts, frameW, frameH });
}

export function isBlank(img: PixelImage, r: Rect): boolean {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++)
    if (x >= 0 && y >= 0 && x < img.width && y < img.height && img.data[(y * img.width + x) * 4 + 3] > 0) return false;
  return true;
}

export type Align = 'bottom' | 'center' | 'top-left';

/**
 * Cuts rectangles out of a sheet into same-size frames. Uneven rects are placed on one
 * shared canvas: 'bottom' = bottom-centre (feet line up), 'center', or 'top-left' (as-is).
 */
export function framesFromRects(sheet: PixelImage, rects: Rect[], align: Align = 'bottom'): { frames: PixelImage[]; pivot: { x: number; y: number } } {
  if (!rects.length) return { frames: [], pivot: { x: 0, y: 0 } };
  const norm = normalizeFrames(rects);
  const W = norm.cellW, H = norm.cellH;
  const frames = rects.map((r, i) => {
    const out = blank(W, H);
    const ox = align === 'top-left' ? 0 : align === 'center' ? Math.floor((W - r.w) / 2) : norm.frames[i].offsetX;
    const oy = align === 'top-left' ? 0 : align === 'center' ? Math.floor((H - r.h) / 2) : norm.frames[i].offsetY;
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const sx = r.x + x, sy = r.y + y;
      if (sx < 0 || sy < 0 || sx >= sheet.width || sy >= sheet.height) continue;
      out.data.set(sheet.data.subarray((sy * sheet.width + sx) * 4, (sy * sheet.width + sx) * 4 + 4), ((oy + y) * W + ox + x) * 4);
    }
    return out;
  });
  return { frames, pivot: { x: Math.floor(W / 2), y: H - 1 } };
}

/** Opens a library asset: one layer, one frame per used sheet frame, tags from its animations. */
export function docFromAsset(sheet: PixelImage, asset: Pick<SpriteAsset, 'name' | 'frames' | 'animations' | 'pivot' | 'frameWidth' | 'frameHeight'>, palette: string[] = []): EditorDoc {
  const order: number[] = [];
  const tags: Omit<Tag, 'id' | 'color'>[] = [];
  const durations: number[] = [];
  for (const a of asset.animations) {
    const from = order.length;
    for (const f of a.frames) { order.push(f); durations.push(Math.round(1000 / a.fps)); }
    tags.push({ name: a.name, from, to: order.length - 1, loop: a.loop });
  }
  if (!order.length) asset.frames.forEach((_, i) => { order.push(i); durations.push(100); });
  const frames = order.map(i => {
    const r = asset.frames[i];
    const out = blank(asset.frameWidth, asset.frameHeight);
    for (let y = 0; y < r.h; y++) out.data.set(sheet.data.subarray(((r.y + y) * sheet.width + r.x) * 4, ((r.y + y) * sheet.width + r.x + r.w) * 4), y * asset.frameWidth * 4);
    return out;
  });
  const doc = docFromFrames(frames, { name: asset.name, pivot: asset.pivot, tags, palette });
  return { ...doc, frames: doc.frames.map((f, i) => ({ ...f, duration: durations[i] ?? 100 })) };
}

export interface SheetExport {
  sheet: PixelImage;
  rects: Rect[];
  frameWidth: number;
  frameHeight: number;
  pivot: { x: number; y: number };
  animations: Animation[];
}

/**
 * Flattens the document into a library sheet: every frame composited, packed in a grid,
 * tags become animations (fps from the average frame duration). Untagged frames become
 * "default" when there are no tags at all.
 */
export function docToSheet(doc: EditorDoc): SheetExport {
  const flat = doc.frames.map((_, i) => composite(doc, i));
  const layout = packGrid(flat.length, doc.width, doc.height, 16);
  const sheet = blank(layout.width, layout.height);
  flat.forEach((f, i) => {
    const r = layout.rects[i];
    for (let y = 0; y < f.height; y++) sheet.data.set(f.data.subarray(y * f.width * 4, (y + 1) * f.width * 4), ((r.y + y) * sheet.width + r.x) * 4);
  });
  const fps = (from: number, to: number) => {
    const ds = doc.frames.slice(from, to + 1).map(f => f.duration);
    return Math.max(1, Math.min(60, Math.round(1000 / (ds.reduce((a, b) => a + b, 0) / Math.max(1, ds.length)))));
  };
  const slug = (n: string) => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'anim';
  const animations: Animation[] = [];
  const used = new Set<string>();
  for (const t of doc.tags) {
    let name = slug(t.name), k = 2;
    while (used.has(name)) name = `${slug(t.name)}-${k++}`;
    used.add(name);
    animations.push({ name, frames: Array.from({ length: t.to - t.from + 1 }, (_, j) => t.from + j), fps: fps(t.from, t.to), loop: t.loop });
  }
  // frames outside every tag are kept as their own animation, never silently dropped
  const untagged = flat.map((_, i) => i).filter(i => !doc.tags.some(t => i >= t.from && i <= t.to));
  if (untagged.length) {
    let name = 'default', k = 2;
    while (used.has(name)) name = `default-${k++}`;
    animations.push({ name, frames: untagged, fps: Math.round(untagged.reduce((s, i) => s + 1000 / doc.frames[i].duration, 0) / untagged.length) || 10, loop: true });
  }
  return { sheet, rects: layout.rects, frameWidth: doc.width, frameHeight: doc.height, pivot: doc.pivot, animations };
}
