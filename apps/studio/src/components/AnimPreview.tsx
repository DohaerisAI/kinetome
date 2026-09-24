import { useEffect, useRef, useState } from 'react';
import type { PixelImage } from '@kinetome/core';
import { drawChecker } from '../pixels.ts';

function toCanvas(f: PixelImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = f.width; c.height = f.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
  return c;
}

/**
 * Plays frames in a fixed box. `pixel` = integer zoom + nearest sampling (results);
 * otherwise smooth fit (source footage).
 */
export function AnimPreview({ frames, fps, width, height, pixel = true, playing = true, onFrame }: {
  frames: PixelImage[]; fps: number; width: number; height: number; pixel?: boolean; playing?: boolean; onFrame?: (i: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [cache, setCache] = useState<HTMLCanvasElement[]>([]);
  const [i, setI] = useState(0);

  useEffect(() => { setCache(frames.map(toCanvas)); setI(0); }, [frames]);

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const t = setInterval(() => setI(n => (n + 1) % frames.length), 1000 / Math.max(1, fps));
    return () => clearInterval(t);
  }, [playing, frames.length, fps]);

  useEffect(() => { onFrame?.(i); }, [i, onFrame]);

  useEffect(() => {
    const c = ref.current, f = cache[i % Math.max(1, cache.length)];
    if (!c) return;
    const ctx = c.getContext('2d')!;
    drawChecker(ctx, width, height, 8);
    if (!f) return;
    const fit = Math.min(width / f.width, height / f.height);
    const z = pixel ? Math.max(1, Math.floor(fit)) : fit;
    const w = f.width * z, h = f.height * z;
    ctx.imageSmoothingEnabled = !pixel;
    ctx.drawImage(f, Math.floor((width - w) / 2), Math.floor((height - h) / 2), w, h);
  }, [cache, i, width, height, pixel]);

  return <canvas ref={ref} width={width} height={height} style={{ width, height, imageRendering: pixel ? 'pixelated' : 'auto', borderRadius: 6 }} />;
}
