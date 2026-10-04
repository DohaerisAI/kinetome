import type { PixelImage } from '@kinetome/core';
import { contentBounds, createImage, crop } from './image.ts';
import { resize } from './scale.ts';

/**
 * First frame for an image-to-video model: the sprite scaled up by a whole number
 * (nearest neighbour, so the pixels stay square) on a square key-colour canvas, about 58% of
 * its height with the feet at 82%. The headroom keeps a raised weapon or a jump inside the
 * clip; a figure that fills the frame gets its attack clipped. Art bigger than that is shrunk.
 */
export function videoFirstFrame(sprite: PixelImage, key: [number, number, number], size = 960): PixelImage {
  let b = contentBounds(sprite, 128);
  // big painted art (a Gemini redraw) is shrunk smoothly to the target height instead
  if (b && b.h > size * 0.58) {
    const s = (size * 0.58) / b.h;
    sprite = resize(crop(sprite, b), Math.max(1, Math.round(b.w * s)), Math.max(1, Math.round(b.h * s)), 'smooth');
    b = contentBounds(sprite, 128);
  }
  const out = createImage(size, size);
  for (let i = 0; i < out.data.length; i += 4) out.data.set([key[0], key[1], key[2], 255], i);
  if (!b) return out;
  const k = Math.max(1, Math.floor((size * 0.58) / b.h));
  const ox = Math.round(size / 2 - (b.w * k) / 2), oy = Math.round(size * 0.82 - b.h * k);
  for (let y = 0; y < b.h * k; y++)
    for (let x = 0; x < b.w * k; x++) {
      const tx = ox + x, ty = oy + y;
      if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
      const i = ((b.y + Math.floor(y / k)) * sprite.width + b.x + Math.floor(x / k)) * 4;
      if (sprite.data[i + 3] < 128) continue;
      out.data.set([sprite.data[i], sprite.data[i + 1], sprite.data[i + 2], 255], (ty * size + tx) * 4);
    }
  return out;
}
