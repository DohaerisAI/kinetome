import { useEffect, useRef } from 'react';
import type { Rect } from '@sprite/core';

const bboxCache = new WeakMap<HTMLImageElement, Map<string, Rect>>();

/** Opaque bounds of one frame, so wide cells (room for effects) don't shrink the sprite to a speck. */
function contentRect(img: HTMLImageElement, r: Rect): Rect {
  const key = `${r.x},${r.y},${r.w},${r.h}`;
  let m = bboxCache.get(img);
  if (!m) { m = new Map(); bboxCache.set(img, m); }
  const hit = m.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = r.w; c.height = r.h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const d = ctx.getImageData(0, 0, r.w, r.h).data;
  let x0 = r.w, y0 = r.h, x1 = -1, y1 = -1;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (d[(y * r.w + x) * 4 + 3] > 0) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const out = x1 < 0 ? r : { x: r.x + x0, y: r.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  m.set(key, out);
  return out;
}

/** Renders one frame of a sheet, cropped to the sprite and integer-scaled to fit a square box. */
export function FrameThumb({ img, rect, size, className, crop = true }: { img: HTMLImageElement | null; rect: Rect | undefined; size: number; className?: string; crop?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    if (!img || !rect) return;
    const r = crop ? contentRect(img, rect) : rect;
    const fit = Math.min(size / r.w, size / r.h);
    const z = fit >= 1 ? Math.floor(fit) : fit;
    const w = r.w * z, h = r.h * z;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, r.x, r.y, r.w, r.h, Math.floor((size - w) / 2), Math.floor((size - h) / 2), w, h);
  }, [img, rect, size, crop]);
  return <canvas ref={ref} width={size} height={size} className={className} style={{ width: size, height: size }} />;
}
