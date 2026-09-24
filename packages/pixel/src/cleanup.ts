import { hexToRgb, type PixelImage } from '@sprite/core';
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
