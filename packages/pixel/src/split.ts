import { sliceIslands, type PixelImage, type Rect } from '@kinetome/core';

export interface SheetSplit {
  /** Frames in reading order. */
  rects: Rect[];
  /** Rows of frame indices (top to bottom); a sheet row is usually one animation. */
  rows: number[][];
  /** Islands dropped as labels/specks. */
  dropped: number;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function columnCounts(img: PixelImage, r: Rect): Int32Array {
  const out = new Int32Array(r.w);
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++)
      if (img.data[(y * img.width + x) * 4 + 3] >= 128) out[x - r.x]++;
  return out;
}

/** Tightens a rect to the opaque pixels inside it. */
function tighten(img: PixelImage, r: Rect): Rect | null {
  let x0 = r.x + r.w, y0 = r.y + r.h, x1 = -1, y1 = -1;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++)
      if (img.data[(y * img.width + x) * 4 + 3] >= 128) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Cuts an island that holds several touching poses: k cuts at the emptiest columns near
 * the expected boundaries.
 */
function splitWide(img: PixelImage, r: Rect, k: number): Rect[] {
  const cols = columnCounts(img, r);
  const cuts: number[] = [];
  for (let i = 1; i < k; i++) {
    const center = Math.round((r.w * i) / k), win = Math.round(r.w / k / 3);
    let best = center, bestV = Infinity;
    for (let x = Math.max(1, center - win); x < Math.min(r.w - 1, center + win); x++) {
      const v = cols[x] + Math.abs(x - center) * 0.01; // prefer emptier, then closer
      if (v < bestV) { bestV = v; best = x; }
    }
    cuts.push(best);
  }
  const edges = [0, ...cuts, r.w];
  const out: Rect[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const t = tighten(img, { x: r.x + edges[i], y: r.y, w: edges[i + 1] - edges[i], h: r.h });
    if (t) out.push(t);
  }
  return out;
}

/**
 * Finds the individual poses in a sprite-sheet image (background already removed).
 * Handles what AI generators produce: uneven spacing, detached bits (weapons, sparks),
 * text labels and specks, poses that touch each other, several rows.
 */
export function splitSheet(img: PixelImage): SheetSplit {
  const merge = Math.max(2, Math.round(Math.max(img.width, img.height) * 0.008));
  let rects = sliceIslands(img, merge);
  if (!rects.length) return { rects: [], rows: [], dropped: 0 };

  // Reference size from the substantial islands.
  const big = rects.filter(r => r.h >= Math.max(...rects.map(q => q.h)) * 0.3);
  const mh = median(big.map(r => r.h)), mw = median(big.map(r => r.w));

  // Drop labels and specks: small in both directions compared with a pose.
  const kept = rects.filter(r => !(r.h < mh * 0.35 && r.w < mw * 0.8) && !(r.h < mh * 0.2));
  const dropped = rects.length - kept.length;

  // Split islands that are clearly several poses wide.
  rects = kept.flatMap(r => (r.w > mw * 1.6 && r.h > mh * 0.6 ? splitWide(img, r, Math.round(r.w / mw)) : [r]));

  // Rows by vertical overlap of the middle band (tolerant to tall/short poses).
  const sorted = rects.map((r, i) => ({ r, i })).sort((a, b) => (a.r.y + a.r.h / 2) - (b.r.y + b.r.h / 2));
  const rowsR: Rect[][] = [];
  for (const { r } of sorted) {
    const cy = r.y + r.h / 2;
    const row = rowsR.find(row => row.some(o => cy > o.y && cy < o.y + o.h));
    if (row) row.push(r); else rowsR.push([r]);
  }
  rowsR.sort((a, b) => Math.min(...a.map(r => r.y)) - Math.min(...b.map(r => r.y)));
  const ordered: Rect[] = [];
  const rows: number[][] = [];
  for (const row of rowsR) {
    row.sort((a, b) => a.x - b.x);
    rows.push(row.map((_, k) => ordered.length + k));
    ordered.push(...row);
  }
  return { rects: ordered, rows, dropped };
}
