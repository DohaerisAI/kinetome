import { useEffect, useRef } from 'react';
import type { Rect } from '@sprite/core';

/** Renders one frame of a sheet, integer-scaled to fit a square box. */
export function FrameThumb({ img, rect, size, className }: { img: HTMLImageElement | null; rect: Rect | undefined; size: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    if (!img || !rect) return;
    const z = Math.max(1, Math.floor(Math.min(size / rect.w, size / rect.h)));
    const w = rect.w * z, h = rect.h * z;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, Math.floor((size - w) / 2), Math.floor((size - h) / 2), w, h);
  }, [img, rect, size]);
  return <canvas ref={ref} width={size} height={size} className={className} style={{ width: size, height: size }} />;
}
