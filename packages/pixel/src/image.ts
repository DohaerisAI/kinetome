import { rgbToOklab, type PixelImage, type Rect } from '@kinetome/core';

export function createImage(width: number, height: number): PixelImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneImage(img: PixelImage): PixelImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** Copies `src` into `dst` at (dx, dy), clipping at the edges. Opaque pixels overwrite. */
export function blit(dst: PixelImage, src: PixelImage, dx: number, dy: number, sr?: Rect): void {
  const r = sr ?? { x: 0, y: 0, w: src.width, h: src.height };
  for (let y = 0; y < r.h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < r.w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = ((r.y + y) * src.width + (r.x + x)) * 4;
      if (src.data[s + 3] === 0) continue;
      const d = (ty * dst.width + tx) * 4;
      dst.data[d] = src.data[s]; dst.data[d + 1] = src.data[s + 1]; dst.data[d + 2] = src.data[s + 2]; dst.data[d + 3] = src.data[s + 3];
    }
  }
}

export function crop(img: PixelImage, r: Rect): PixelImage {
  const out = createImage(r.w, r.h);
  blit(out, img, 0, 0, r);
  return out;
}

export function pad(img: PixelImage, n: number): PixelImage {
  const out = createImage(img.width + n * 2, img.height + n * 2);
  blit(out, img, n, n);
  return out;
}

/** Bounding box of pixels with alpha >= alphaMin, or null if empty. */
export function contentBounds(img: PixelImage, alphaMin = 1): Rect | null {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3] >= alphaMin) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Memoized Oklab lookup keyed by packed RGB; images repeat colors heavily. */
export class LabCache {
  private map = new Map<number, [number, number, number]>();
  get(r: number, g: number, b: number): [number, number, number] {
    const k = (r << 16) | (g << 8) | b;
    let v = this.map.get(k);
    if (!v) { v = rgbToOklab(r, g, b); if (this.map.size < 200_000) this.map.set(k, v); }
    return v;
  }
}

export const labDist = (a: [number, number, number], b: [number, number, number]) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

/**
 * Height of the character's BODY: the span of rows that are substantially filled. Thin
 * protrusions (a raised sword, a staff, a hair strand) don't count, so a pose holding a
 * weapon overhead isn't mistaken for a character drawn at a bigger scale.
 */
export function bodyHeight(img: PixelImage): number {
  const counts: number[] = [];
  for (let y = 0; y < img.height; y++) {
    let n = 0;
    for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3] >= 128) n++;
    counts.push(n);
  }
  const filled = counts.filter(c => c > 0).sort((a, b) => a - b);
  if (!filled.length) return 0;
  const typical = filled[Math.floor(filled.length / 2)];
  const min = Math.max(2, typical * 0.3);
  let top = -1, bottom = -1;
  counts.forEach((c, y) => { if (c >= min) { if (top < 0) top = y; bottom = y; } });
  return top < 0 ? 0 : bottom - top + 1;
}
