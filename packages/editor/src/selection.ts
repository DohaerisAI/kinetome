import type { PixelImage } from '@kinetome/core';
import { blank } from './doc.ts';
import { flip, rotate90 } from './raster.ts';

/**
 * A selection is a canvas-sized mask. Floating content (after cut/copy/move) is a small
 * image with an offset that is stamped back ("committed") into the cel.
 */
export interface Selection { mask: Uint8Array; width: number; height: number }
export interface Floating { img: PixelImage; x: number; y: number }
export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

export function emptySelection(width: number, height: number): Selection {
  return { mask: new Uint8Array(width * height), width, height };
}

export function isEmpty(s: Selection | null | undefined): boolean {
  return !s || !s.mask.some(v => v);
}

export function combine(base: Selection | null, add: Uint8Array, mode: SelectMode, width: number, height: number): Selection {
  const out = new Uint8Array(width * height);
  const b = base?.mask;
  for (let i = 0; i < out.length; i++) {
    const a = b ? b[i] : 0, n = add[i];
    out[i] = mode === 'replace' ? n : mode === 'add' ? (a | n) : mode === 'subtract' ? (a && !n ? 1 : 0) : (a && n ? 1 : 0);
  }
  return { mask: out, width, height };
}

export function rectMask(width: number, height: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const m = new Uint8Array(width * height);
  const [ax, bx] = [Math.max(0, Math.min(x0, x1)), Math.min(width - 1, Math.max(x0, x1))];
  const [ay, by] = [Math.max(0, Math.min(y0, y1)), Math.min(height - 1, Math.max(y0, y1))];
  for (let y = ay; y <= by; y++) m.fill(1, y * width + ax, y * width + bx + 1);
  return m;
}

/** Polygon (lasso) mask using pixel centres. */
export function polyMask(width: number, height: number, pts: [number, number][]): Uint8Array {
  const m = new Uint8Array(width * height);
  if (pts.length < 3) return m;
  for (let y = 0; y < height; y++) {
    const sy = y + 0.5, xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(width - 1, Math.floor(xs[k + 1] - 0.5)); x++) m[y * width + x] = 1;
  }
  return m;
}

export function invert(s: Selection): Selection {
  return { ...s, mask: s.mask.map(v => (v ? 0 : 1)) };
}

export function maskBounds(s: Selection): { x: number; y: number; w: number; h: number } | null {
  let x0 = s.width, y0 = s.height, x1 = -1, y1 = -1;
  for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) if (s.mask[y * s.width + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Copies the selected pixels of `img` into a floating image (cropped to the selection bounds). */
export function extract(img: PixelImage, s: Selection): Floating | null {
  const b = maskBounds(s);
  if (!b) return null;
  const out = blank(b.w, b.h);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
    const sx = b.x + x, sy = b.y + y;
    if (!s.mask[sy * s.width + sx]) continue;
    out.data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * b.w + x) * 4);
  }
  return { img: out, x: b.x, y: b.y };
}

/** Clears the selected pixels (returns a new image). */
export function clearSelected(img: PixelImage, s: Selection): PixelImage {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  for (let p = 0; p < s.mask.length; p++) if (s.mask[p]) out.data[p * 4 + 3] = 0, out.data[p * 4] = out.data[p * 4 + 1] = out.data[p * 4 + 2] = 0;
  return out;
}

/** Stamps floating content onto `img` (opaque pixels overwrite). */
export function stampFloating(img: PixelImage, f: Floating): PixelImage {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  for (let y = 0; y < f.img.height; y++) for (let x = 0; x < f.img.width; x++) {
    const tx = f.x + x, ty = f.y + y;
    if (tx < 0 || ty < 0 || tx >= img.width || ty >= img.height) continue;
    const s = (y * f.img.width + x) * 4;
    if (f.img.data[s + 3] === 0) continue;
    out.data.set(f.img.data.subarray(s, s + 4), (ty * img.width + tx) * 4);
  }
  return out;
}

/** Selection mask covering the floating content's opaque pixels. */
export function floatingMask(f: Floating, width: number, height: number): Selection {
  const m = new Uint8Array(width * height);
  for (let y = 0; y < f.img.height; y++) for (let x = 0; x < f.img.width; x++) {
    const tx = f.x + x, ty = f.y + y;
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
    if (f.img.data[(y * f.img.width + x) * 4 + 3] > 0) m[ty * width + tx] = 1;
  }
  return { mask: m, width, height };
}

export function transformFloating(f: Floating, op: 'flip-h' | 'flip-v' | 'rot-cw' | 'rot-ccw'): Floating {
  if (op === 'flip-h' || op === 'flip-v') return { ...f, img: flip(f.img, op === 'flip-h' ? 'h' : 'v') };
  const img = rotate90(f.img, op === 'rot-cw');
  // rotate around the centre of the floating block
  const cx = f.x + f.img.width / 2, cy = f.y + f.img.height / 2;
  return { img, x: Math.round(cx - img.width / 2), y: Math.round(cy - img.height / 2) };
}
