import type { PixelImage } from '@sprite/core';
import { cloneImage, LabCache, labDist } from './image.ts';

export type RGB = [number, number, number];

/**
 * Guesses a solid background from the image border. Returns null when the border is
 * already transparent or too varied to be a flat backdrop (e.g. a photo).
 */
export function estimateBackground(img: PixelImage): RGB | null {
  const { width: W, height: H, data } = img;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0, transparent = 0;
  const visit = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    total++;
    if (data[i + 3] < 128) { transparent++; return; }
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
    bins.set(key, b);
  };
  for (let x = 0; x < W; x++) { visit(x, 0); visit(x, H - 1); }
  for (let y = 1; y < H - 1; y++) { visit(0, y); visit(W - 1, y); }
  if (transparent / total > 0.5) return null;
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const b of bins.values()) if (!best || b.n > best.n) best = b;
  if (!best || best.n / (total - transparent) < 0.45) return null;
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

/**
 * Removes the background by flood-filling from the border through pixels close to `bg`
 * (Oklab distance <= tolerance). Interior regions of the same color survive, unlike a
 * global chroma key. A defringe pass eats the JPEG/antialias halo along the cut.
 */
export function removeBackground(img: PixelImage, bg: RGB, tolerance = 0.09): PixelImage {
  const out = cloneImage(img);
  const { width: W, height: H, data } = out;
  const lab = new LabCache();
  const bgLab = lab.get(bg[0], bg[1], bg[2]);
  const near = (p: number, tol: number) => {
    const i = p * 4;
    return data[i + 3] < 16 || labDist(lab.get(data[i], data[i + 1], data[i + 2]), bgLab) <= tol;
  };
  const removed = new Uint8Array(W * H);
  const stack: number[] = [];
  const seed = (p: number) => { if (!removed[p] && near(p, tolerance)) { removed[p] = 1; stack.push(p); } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % W, y = (p - x) / W;
    if (x > 0) seed(p - 1);
    if (x < W - 1) seed(p + 1);
    if (y > 0) seed(p - W);
    if (y < H - 1) seed(p + W);
  }
  // defringe: one ring of looser matching along the cut
  const fringe: number[] = [];
  for (let p = 0; p < W * H; p++) {
    if (removed[p]) continue;
    const x = p % W, y = (p - x) / W;
    const touches = (x > 0 && removed[p - 1]) || (x < W - 1 && removed[p + 1]) || (y > 0 && removed[p - W]) || (y < H - 1 && removed[p + W]);
    if (touches && near(p, tolerance * 2)) fringe.push(p);
  }
  for (const p of fringe) removed[p] = 1;
  for (let p = 0; p < W * H; p++) if (removed[p]) data[p * 4 + 3] = 0;
  return out;
}
