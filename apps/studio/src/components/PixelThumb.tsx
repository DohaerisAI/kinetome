import { useEffect, useRef } from 'react';
import type { PixelImage } from '@kinetome/core';

/** A frame drawn into a square box: integer zoom when it fits, nearest-neighbour always. */
export function PixelThumb({ img, size }: { img: PixelImage | undefined; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    if (!img) return;
    const tmp = document.createElement('canvas');
    tmp.width = img.width; tmp.height = img.height;
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const fit = Math.min(size / img.width, size / img.height);
    const z = fit >= 1 ? Math.floor(fit) : fit;
    const w = img.width * z, h = img.height * z;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, Math.floor((size - w) / 2), Math.floor((size - h) / 2), w, h);
  }, [img, size]);
  return <canvas ref={ref} width={size} height={size} style={{ width: size, height: size, imageRendering: 'pixelated' }} />;
}
