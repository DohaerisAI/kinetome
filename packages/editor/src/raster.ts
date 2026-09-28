import type { PixelImage } from '@kinetome/core';
import { blank, cloneImage } from './doc.ts';

export type RGBA = [number, number, number, number];
export const TRANSPARENT: RGBA = [0, 0, 0, 0];

export function hexToRgba(hex: string): RGBA {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}
export function rgbaToHex([r, g, b]: RGBA): string {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export function getPixel(img: PixelImage, x: number, y: number): RGBA {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return TRANSPARENT;
  const i = (y * img.width + x) * 4, d = img.data;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

/** Writes one pixel (mask = optional selection: only pixels inside it change). */
export function setPixel(img: PixelImage, x: number, y: number, c: RGBA, mask?: Uint8Array | null): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  if (mask && !mask[y * img.width + x]) return;
  const i = (y * img.width + x) * 4, d = img.data;
  d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
}

/** Square brush of `size` px centered on (x, y) (even sizes lean up-left, like Aseprite). */
export function stamp(img: PixelImage, x: number, y: number, c: RGBA, size = 1, mask?: Uint8Array | null): void {
  const o = Math.floor((size - 1) / 2);
  for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) setPixel(img, x - o + xx, y - o + yy, c, mask);
}

/** All points of a Bresenham line, endpoints included. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const pts: [number, number][] = [];
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return pts;
}

/**
 * "Pixel perfect" filter for 1px strokes: removes the corner pixel of every L-shaped
 * step, so freehand lines stay one pixel thin with no doubled corners.
 */
export function pixelPerfect(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1][0] === p[0] && out[out.length - 1][1] === p[1]) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const lShape = (a[0] === b[0] || a[1] === b[1]) && (b[0] === c[0] || b[1] === c[1]) && a[0] !== c[0] && a[1] !== c[1];
      if (lShape) out.splice(out.length - 2, 1); else break;
    }
  }
  return out;
}

export function drawLine(img: PixelImage, x0: number, y0: number, x1: number, y1: number, c: RGBA, size = 1, mask?: Uint8Array | null): void {
  for (const [x, y] of linePoints(x0, y0, x1, y1)) stamp(img, x, y, c, size, mask);
}

export function drawRect(img: PixelImage, x0: number, y0: number, x1: number, y1: number, c: RGBA, fill: boolean, size = 1, mask?: Uint8Array | null): void {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  if (fill) { for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) setPixel(img, x, y, c, mask); return; }
  drawLine(img, ax, ay, bx, ay, c, size, mask); drawLine(img, ax, by, bx, by, c, size, mask);
  drawLine(img, ax, ay, ax, by, c, size, mask); drawLine(img, bx, ay, bx, by, c, size, mask);
}

/** Ellipse inscribed in the box (x0,y0)-(x1,y1); outline is a clean 1px (or brush) ring. */
export function drawEllipse(img: PixelImage, x0: number, y0: number, x1: number, y1: number, c: RGBA, fill: boolean, size = 1, mask?: Uint8Array | null): void {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const cx = (ax + bx) / 2, cy = (ay + by) / 2, rx = (bx - ax) / 2 + 0.5, ry = (by - ay) / 2 + 0.5;
  const inside = (x: number, y: number) => ((x + 0.5 - cx - 0.5) / rx) ** 2 + ((y + 0.5 - cy - 0.5) / ry) ** 2 <= 1;
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    if (!inside(x, y)) continue;
    if (fill) { setPixel(img, x, y, c, mask); continue; }
    if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) stamp(img, x, y, c, size, mask);
  }
}

const close = (a: RGBA, b: RGBA, tol: number) => {
  if (a[3] === 0 && b[3] === 0) return true;
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]) <= tol * 4;
};

/**
 * Pixels matching the color at (x, y): contiguous (4-connected flood) or everywhere
 * (global). Returns a mask. Used by the bucket and the magic wand.
 */
export function matchRegion(img: PixelImage, x: number, y: number, tolerance = 0, contiguous = true): Uint8Array {
  const { width: W, height: H } = img;
  const mask = new Uint8Array(W * H);
  if (x < 0 || y < 0 || x >= W || y >= H) return mask;
  const target = getPixel(img, x, y);
  if (!contiguous) {
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) if (close(getPixel(img, xx, yy), target, tolerance)) mask[yy * W + xx] = 1;
    return mask;
  }
  const stack = [y * W + x];
  mask[y * W + x] = 1;
  while (stack.length) {
    const p = stack.pop()!, px = p % W, py = (p - px) / W;
    for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (mask[q] || !close(getPixel(img, nx, ny), target, tolerance)) continue;
      mask[q] = 1; stack.push(q);
    }
  }
  return mask;
}

export function fillMask(img: PixelImage, region: Uint8Array, c: RGBA, clip?: Uint8Array | null): void {
  for (let p = 0; p < region.length; p++) {
    if (!region[p] || (clip && !clip[p])) continue;
    const i = p * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = c[3];
  }
}

/** Replaces every pixel of color `from` with `to` (optionally within a mask). */
export function replaceColor(img: PixelImage, from: RGBA, to: RGBA, tolerance = 0, mask?: Uint8Array | null): PixelImage {
  const out = cloneImage(img);
  for (let p = 0; p < img.width * img.height; p++) {
    if (mask && !mask[p]) continue;
    const i = p * 4;
    const c: RGBA = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
    if (c[3] === 0 && from[3] !== 0) continue;
    if (close(c, from, tolerance)) out.data.set(to, i);
  }
  return out;
}

// ---------- whole-image transforms ----------

export function flip(img: PixelImage, axis: 'h' | 'v'): PixelImage {
  const out = blank(img.width, img.height);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const sx = axis === 'h' ? img.width - 1 - x : x, sy = axis === 'v' ? img.height - 1 - y : y;
    out.data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * img.width + x) * 4);
  }
  return out;
}

/** Moves content by (dx, dy); `wrap` scrolls it around the edges instead of clipping. */
export function shift(img: PixelImage, dx: number, dy: number, wrap = false): PixelImage {
  const out = blank(img.width, img.height), W = img.width, H = img.height;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let tx = x + dx, ty = y + dy;
    if (wrap) { tx = ((tx % W) + W) % W; ty = ((ty % H) + H) % H; }
    else if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    out.data.set(img.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (ty * W + tx) * 4);
  }
  return out;
}

/** New canvas size; content placed at (ox, oy) in the new canvas. */
export function resizeCanvas(img: PixelImage, w: number, h: number, ox: number, oy: number): PixelImage {
  const out = blank(w, h);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const tx = x + ox, ty = y + oy;
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
    out.data.set(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4), (ty * w + tx) * 4);
  }
  return out;
}

/** Nearest-neighbour scale by a factor (e.g. 2 = double, 0.5 = half). */
export function scaleNearest(img: PixelImage, w: number, h: number): PixelImage {
  const out = blank(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.floor((x * img.width) / w), sy = Math.floor((y * img.height) / h);
    out.data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
  }
  return out;
}

/** 90-degree rotation of a region (returns new image of swapped size). */
export function rotate90(img: PixelImage, clockwise = true): PixelImage {
  const out = blank(img.height, img.width);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const tx = clockwise ? img.height - 1 - y : y, ty = clockwise ? x : img.width - 1 - x;
    out.data.set(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4), (ty * out.width + tx) * 4);
  }
  return out;
}

/** Bounding box of opaque pixels, or null. */
export function opaqueBounds(img: PixelImage): { x: number; y: number; w: number; h: number } | null {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++)
    if (img.data[(y * img.width + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
