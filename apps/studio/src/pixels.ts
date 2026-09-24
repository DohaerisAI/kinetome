import { useEffect, useMemo, useState } from 'react';
import { packGrid, type PixelImage, type Rect, type SourceFrame } from '@kinetome/core';

const cache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = src.startsWith('blob:') ? undefined : cache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { cache.delete(src); reject(new Error(`failed to load ${src}`)); };
      img.src = src;
    });
    if (!src.startsWith('blob:')) cache.set(src, p);
  }
  return p;
}

export function useImage(src: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let live = true;
    setImg(null);
    if (src) loadImage(src).then(i => live && setImg(i), () => {});
    return () => { live = false; };
  }, [src]);
  return img;
}

export function toPixels(img: HTMLImageElement | HTMLCanvasElement): ImageData {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export function usePixels(img: HTMLImageElement | null): ImageData | null {
  return useMemo(() => (img ? toPixels(img) : null), [img]);
}

export function pixelsToCanvas(p: PixelImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = p.width; c.height = p.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  return c;
}

export function canvasToPng(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'));
}

/** Copies source frames into a clean uniform grid sheet (the canonical layout). */
export function repack(src: CanvasImageSource, frames: SourceFrame[], cellW: number, cellH: number): { canvas: HTMLCanvasElement; rects: Rect[] } {
  const layout = packGrid(frames.length, cellW, cellH);
  const c = document.createElement('canvas');
  c.width = layout.width; c.height = layout.height;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  frames.forEach((f, i) => {
    const d = layout.rects[i];
    ctx.drawImage(src, f.rect.x, f.rect.y, f.rect.w, f.rect.h, d.x + f.offsetX, d.y + f.offsetY, f.rect.w, f.rect.h);
  });
  return { canvas: c, rects: layout.rects };
}

export function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Draws a checkerboard (transparency backdrop) into ctx. */
export function drawChecker(ctx: CanvasRenderingContext2D, w: number, h: number, size = 8) {
  ctx.fillStyle = '#2a2a36';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#32323f';
  for (let y = 0; y < h; y += size)
    for (let x = (y / size) % 2 ? size : 0; x < w; x += size * 2) ctx.fillRect(x, y, size, size);
}

/** Slices a packed sheet (data URL + rects) back into frames. */
export async function unpackFrames(sheetUrl: string, rects: Rect[]): Promise<PixelImage[]> {
  const img = await loadImage(sheetUrl);
  const px = toPixels(img);
  return rects.map(r => {
    const out = { width: r.w, height: r.h, data: new Uint8ClampedArray(r.w * r.h * 4) };
    for (let y = 0; y < r.h; y++) out.data.set(px.data.subarray(((r.y + y) * px.width + r.x) * 4, ((r.y + y) * px.width + r.x + r.w) * 4), y * r.w * 4);
    return out;
  });
}

export async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}
