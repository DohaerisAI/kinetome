import type { PixelImage } from './color.ts';
import type { Rect } from './schema.ts';

const alphaAt = (img: PixelImage, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];

export function isEmptyRect(img: PixelImage, r: Rect): boolean {
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++)
      if (alphaAt(img, x, y) > 0) return false;
  return true;
}

/** Cuts the image into a uniform grid, row-major. Empty cells are dropped when `img` is given. */
export function sliceGrid(width: number, height: number, fw: number, fh: number, img?: PixelImage): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y + fh <= height; y += fh)
    for (let x = 0; x + fw <= width; x += fw) {
      const r = { x, y, w: fw, h: fh };
      if (!img || !isEmptyRect(img, r)) out.push(r);
    }
  return out;
}

function emptyLines(img: PixelImage, axis: 'x' | 'y'): boolean[] {
  const n = axis === 'x' ? img.width : img.height;
  const m = axis === 'x' ? img.height : img.width;
  const out = new Array<boolean>(n).fill(true);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      if ((axis === 'x' ? alphaAt(img, i, j) : alphaAt(img, j, i)) > 0) { out[i] = false; break; }
  return out;
}

/**
 * Guesses the cell size of a grid sheet: the smallest divisor of each dimension whose
 * every cell boundary falls on a fully transparent line. Returns null when sprites touch
 * their cell edges (the user then enters the size by hand).
 */
export function detectGrid(img: PixelImage): { frameWidth: number; frameHeight: number } | null {
  const pick = (size: number, empty: boolean[]) => {
    for (let c = 8; c <= size; c++) {
      if (size % c !== 0) continue;
      if (c === size) return size;
      let ok = true;
      for (let b = c; b < size && ok; b += c) ok = empty[b] || empty[b - 1];
      if (ok) return c;
    }
    return null;
  };
  const fw = pick(img.width, emptyLines(img, 'x'));
  const fh = pick(img.height, emptyLines(img, 'y'));
  if (fw === null || fh === null) return null;
  if (fw === img.width && fh === img.height) return null;
  return { frameWidth: fw, frameHeight: fh };
}

/**
 * Finds sprites on a packed or irregular sheet by alpha connectivity. Boxes closer than
 * `mergeDistance` are merged so detached bits (a sword, a spark) stay with their body.
 * Result is ordered in reading order (rows top to bottom, then left to right).
 */
export function sliceIslands(img: PixelImage, mergeDistance = 2): Rect[] {
  const { width: W, height: H } = img;
  const seen = new Uint8Array(W * H);
  const boxes: Rect[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || img.data[start * 4 + 3] === 0) continue;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (!seen[q] && img.data[q * 4 + 3] > 0) { seen[q] = 1; stack.push(q); }
      }
    }
    boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  // merge nearby boxes until stable
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
        const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
        if (gapX <= mergeDistance && gapY <= mergeDistance) {
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          boxes[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
  }
  // reading order: group into rows by vertical overlap
  boxes.sort((a, b) => a.y - b.y);
  const rows: Rect[][] = [];
  for (const b of boxes) {
    const row = rows.find(r => r.some(o => b.y < o.y + o.h && o.y < b.y + b.h));
    if (row) row.push(b); else rows.push([b]);
  }
  return rows.flatMap(r => r.sort((a, b) => a.x - b.x));
}

/** A frame as found in a source file, plus where it sits inside its logical cell. */
export interface SourceFrame {
  rect: Rect;
  /** Offset of rect within the uniform cell (for trimmed sheets). */
  offsetX: number;
  offsetY: number;
}

/**
 * Lays out source frames into uniform cells. Islands of different sizes get bottom-center
 * alignment so feet line up and a single pivot works for every frame.
 */
export function normalizeFrames(rects: Rect[]): { cellW: number; cellH: number; frames: SourceFrame[] } {
  const cellW = Math.max(...rects.map(r => r.w));
  const cellH = Math.max(...rects.map(r => r.h));
  return {
    cellW, cellH,
    frames: rects.map(rect => ({ rect, offsetX: Math.floor((cellW - rect.w) / 2), offsetY: cellH - rect.h })),
  };
}

/** Destination rects for `count` cells packed into a sheet at most `maxCols` wide. */
export function packGrid(count: number, cellW: number, cellH: number, maxCols = 16): { width: number; height: number; rects: Rect[] } {
  const cols = Math.max(1, Math.min(count, maxCols));
  const rows = Math.max(1, Math.ceil(count / cols));
  const rects: Rect[] = [];
  for (let i = 0; i < count; i++) rects.push({ x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH, w: cellW, h: cellH });
  return { width: cols * cellW, height: rows * cellH, rects };
}
