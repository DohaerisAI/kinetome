import { hexToRgb, type PixelImage } from '@kinetome/core';
import { cloneImage } from './image.ts';

/**
 * Removes "orphan" pixels: a lone opaque pixel surrounded by transparency disappears, and
 * a pixel whose color matches none of its 8 neighbours takes the majority neighbour color
 * (when at least 5 agree). Kills the speckle left by downscaling and JPEG noise.
 */
export function removeOrphans(img: PixelImage): PixelImage {
  const out = cloneImage(img);
  const { width: W, height: H, data: src } = img;
  const key = (i: number) => (src[i + 3] < 128 ? -1 : (src[i] << 16) | (src[i + 1] << 8) | src[i + 2]);
  const counts = new Map<number, number>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const me = key(i);
      if (me === -1) continue;
      counts.clear();
      let same = 0, opaque = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        const k = nx < 0 || ny < 0 || nx >= W || ny >= H ? -1 : key((ny * W + nx) * 4);
        if (k === me) same++;
        if (k !== -1) opaque++;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      if (same > 0) continue;
      if (opaque === 0) { out.data[i + 3] = 0; continue; }
      let best = -2, bn = 0;
      for (const [k, n] of counts) if (n > bn) { bn = n; best = k; }
      if (bn < 5) continue;
      if (best === -1) out.data[i + 3] = 0;
      else { out.data[i] = (best >> 16) & 255; out.data[i + 1] = (best >> 8) & 255; out.data[i + 2] = best & 255; }
    }
  }
  return out;
}

/** Adds a 1px outline (4-connected) around the silhouette. Pad the image first so it fits. */
export function addOutline(img: PixelImage, hex: string): PixelImage {
  const out = cloneImage(img);
  const [r, g, b] = hexToRgb(hex);
  const { width: W, height: H, data } = img;
  const op = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] >= 128;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (op(x, y)) continue;
      if (op(x - 1, y) || op(x + 1, y) || op(x, y - 1) || op(x, y + 1)) {
        const i = (y * W + x) * 4;
        out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255;
      }
    }
  return out;
}

/**
 * True when the silhouette is already outlined: most edge pixels are among the darkest
 * colors of the sprite. Used so "add outline" never doubles an existing one.
 */
export function hasOutline(img: PixelImage): boolean {
  const { width: W, height: H, data } = img;
  const lum = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const op = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] >= 128;
  const all: number[] = [], edge: number[] = [], inner: number[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!op(x, y)) continue;
      const l = lum((y * W + x) * 4);
      all.push(l);
      if (!op(x - 1, y) || !op(x + 1, y) || !op(x, y - 1) || !op(x, y + 1)) edge.push(l); else inner.push(l);
    }
  if (all.length < 16 || !edge.length || !inner.length) return false;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean(edge) > mean(inner) - 25) return false; // the rim must be clearly darker than the body
  all.sort((a, b) => a - b);
  const dark = all[Math.floor(all.length * 0.3)];
  return edge.filter(l => l <= dark).length / edge.length >= 0.6;
}

/**
 * Keeps the character and drops far-away marks: watermarks, logos and captions that video
 * and image generators stamp in a corner. The biggest blob is the character; other blobs stay
 * when they are big (a detached weapon or effect) or close to it (a hand, a flying strand).
 */
export function keepMainFigure(img: PixelImage, nearFraction = 0.08): PixelImage {
  const { width: W, height: H, data } = img;
  const lab = new Int32Array(W * H).fill(-1);
  const blobs: { n: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let p = 0; p < W * H; p++) {
    if (lab[p] >= 0 || data[p * 4 + 3] < 128) continue;
    const id = blobs.length, b = { n: 0, x0: W, y0: H, x1: 0, y1: 0 };
    const stack = [p]; lab[p] = id;
    while (stack.length) {
      const q = stack.pop()!, x = q % W, y = (q - x) / W;
      b.n++; b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, k = ny * W + nx;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && lab[k] < 0 && data[k * 4 + 3] >= 128) { lab[k] = id; stack.push(k); }
      }
    }
    blobs.push(b);
  }
  if (blobs.length <= 1) return img;
  const main = blobs.reduce((a, b) => (b.n > a.n ? b : a));
  const near = Math.max(4, Math.round(Math.max(W, H) * nearFraction));
  const keep = blobs.map(b => b === main || b.n >= main.n * 0.2 ||
    (b.x1 >= main.x0 - near && b.x0 <= main.x1 + near && b.y1 >= main.y0 - near && b.y0 <= main.y1 + near));
  const out = { width: W, height: H, data: new Uint8ClampedArray(data) };
  for (let p = 0; p < W * H; p++) if (lab[p] >= 0 && !keep[lab[p]]) out.data[p * 4 + 3] = 0;
  return out;
}
