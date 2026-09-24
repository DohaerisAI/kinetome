import type { PixelImage } from '@sprite/core';
import { blit, cloneImage, contentBounds, createImage } from './image.ts';

export type MotionPreset = 'breathe' | 'hover' | 'squash' | 'hurt-flash' | 'hurt-shake';

export interface MotionResult { frames: PixelImage[]; fps: number; loop: boolean; name: string }

export const MOTION_PRESETS: { id: MotionPreset; label: string; hint: string }[] = [
  { id: 'breathe', label: 'Breathe (idle)', hint: 'Upper body dips 1px: the classic pixel idle' },
  { id: 'hover', label: 'Hover (idle)', hint: 'Whole sprite floats up and down: ghosts, fairies, pickups' },
  { id: 'squash', label: 'Squash & stretch', hint: 'Bouncy idle for slimes and blobs' },
  { id: 'hurt-flash', label: 'Hurt: flash', hint: 'White flash for hit feedback' },
  { id: 'hurt-shake', label: 'Hurt: shake', hint: 'Horizontal jitter for hit feedback' },
];

/** Shifts rows above `split` down by `dy`, leaving the feet planted. */
function shiftUpper(img: PixelImage, split: number, dy: number): PixelImage {
  const out = createImage(img.width, img.height);
  blit(out, img, 0, split, { x: 0, y: split, w: img.width, h: img.height - split });
  blit(out, img, 0, dy, { x: 0, y: 0, w: img.width, h: split });
  return out;
}

/** Nearest-neighbour rescale anchored bottom-center (feet stay put). */
function squashTo(img: PixelImage, w: number, h: number): PixelImage {
  const b = contentBounds(img, 128)!;
  const out = createImage(img.width, img.height);
  const ox = Math.round(b.x + b.w / 2 - w / 2), oy = b.y + b.h - h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = b.x + Math.floor((x * b.w) / w), sy = b.y + Math.floor((y * b.h) / h);
      const s = (sy * img.width + sx) * 4, tx = ox + x, ty = oy + y;
      if (img.data[s + 3] === 0 || tx < 0 || ty < 0 || tx >= img.width || ty >= img.height) continue;
      out.data.set(img.data.subarray(s, s + 4), (ty * img.width + tx) * 4);
    }
  return out;
}

/**
 * Procedural animation for a single still sprite. No AI: pixel-exact transforms that keep
 * the palette and silhouette intact. Expects a sprite with at least 2px of headroom
 * (the pipeline pads results) so hover/stretch never clip.
 */
export function generateMotion(img: PixelImage, preset: MotionPreset): MotionResult {
  const b = contentBounds(img, 128);
  if (!b) return { frames: [img], fps: 8, loop: true, name: 'idle' };
  switch (preset) {
    case 'breathe': {
      const split = b.y + Math.round(b.h * 0.6); // roughly the waist
      const down = shiftUpper(img, split, 1);
      return { frames: [img, img, down, down], fps: 4, loop: true, name: 'idle' };
    }
    case 'hover': {
      const at = (dy: number) => { const o = createImage(img.width, img.height); blit(o, img, 0, dy); return o; };
      return { frames: [at(0), at(-1), at(-2), at(-1)], fps: 6, loop: true, name: 'idle' };
    }
    case 'squash': {
      const wide = squashTo(img, b.w + 2, Math.max(1, b.h - 2));
      const tall = squashTo(img, Math.max(1, b.w - 2), b.h + 1);
      return { frames: [img, wide, img, tall], fps: 6, loop: true, name: 'idle' };
    }
    case 'hurt-flash': {
      const white = cloneImage(img);
      for (let i = 0; i < white.data.length; i += 4) if (white.data[i + 3] >= 128) white.data.set([255, 255, 255], i);
      return { frames: [white, img, white, img], fps: 12, loop: false, name: 'hurt' };
    }
    case 'hurt-shake': {
      const at = (dx: number) => { const o = createImage(img.width, img.height); blit(o, img, dx, 0); return o; };
      return { frames: [at(2), at(-2), at(1), at(-1), at(0)], fps: 15, loop: false, name: 'hurt' };
    }
  }
}
