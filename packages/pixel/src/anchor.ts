import type { PixelImage, Rect } from '@sprite/core';
import { blit, contentBounds, createImage } from './image.ts';

export type Anchor = 'feet' | 'center' | 'none';

/** Horizontal center of mass of the lowest 15% of the sprite: where the feet are. */
function feetX(img: PixelImage, b: Rect): number {
  const band = Math.max(1, Math.round(b.h * 0.15));
  let sum = 0, n = 0;
  for (let y = b.y + b.h - band; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++)
      if (img.data[(y * img.width + x) * 4 + 3] >= 128) { sum += x; n++; }
  return n ? sum / n : b.x + b.w / 2;
}

/**
 * Puts every frame on one shared canvas, tightly cropped.
 * - 'feet':   feet aligned (x) and ground line aligned (y). Turns a character walking
 *             across a GIF into a walk-in-place cycle and removes camera drift.
 * - 'center': bounding-box centers aligned (flying things, effects).
 * - 'none':   original positions kept, cropped to the union of all frames.
 * Returns the frames and the pivot (feet point) in the new canvas.
 */
export function anchorFrames(frames: PixelImage[], mode: Anchor): { frames: PixelImage[]; pivot: { x: number; y: number } } {
  const bounds = frames.map(f => contentBounds(f, 128));
  const valid = bounds.filter((b): b is Rect => !!b);
  if (!valid.length) return { frames, pivot: { x: Math.floor(frames[0].width / 2), y: frames[0].height - 1 } };

  if (mode === 'none') {
    const x0 = Math.min(...valid.map(b => b.x)), y0 = Math.min(...valid.map(b => b.y));
    const x1 = Math.max(...valid.map(b => b.x + b.w)), y1 = Math.max(...valid.map(b => b.y + b.h));
    const out = frames.map(f => { const c = createImage(x1 - x0, y1 - y0); blit(c, f, -x0, -y0); return c; });
    return { frames: out, pivot: { x: Math.floor((x1 - x0) / 2), y: y1 - y0 - 1 } };
  }

  const ax = frames.map((f, i) => {
    const b = bounds[i];
    if (!b) return 0;
    return mode === 'feet' ? feetX(f, b) : b.x + b.w / 2;
  });
  let left = 0, right = 0, up = 0, down = 0;
  frames.forEach((_, i) => {
    const b = bounds[i];
    if (!b) return;
    left = Math.max(left, Math.ceil(ax[i] - b.x));
    right = Math.max(right, Math.ceil(b.x + b.w - ax[i]));
    if (mode === 'feet') up = Math.max(up, b.h);
    else { up = Math.max(up, Math.ceil(b.h / 2)); down = Math.max(down, Math.ceil(b.h / 2)); }
  });
  const W = left + right, H = up + down;
  const out = frames.map((f, i) => {
    const c = createImage(W, H);
    const b = bounds[i];
    if (!b) return c;
    const dx = Math.round(left - ax[i]);
    const dy = mode === 'feet' ? H - (b.y + b.h) : Math.round(up - (b.y + b.h / 2));
    blit(c, f, dx, dy);
    return c;
  });
  return { frames: out, pivot: { x: left, y: H - 1 } };
}
