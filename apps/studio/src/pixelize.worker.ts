/// <reference lib="webworker" />
import type { PixelImage } from '@kinetome/core';
import {
  assessResult, findLoops, pixelize, prepareSheet,
  type PixelizeOptions, type PixelizeResult, type QualityReport,
} from '@kinetome/pixel';

export interface Prepared { count: number; rows: number[][]; sheet: boolean; dropped: number; thumbs: PixelImage[] }

export type WorkerIn =
  | { type: 'load'; frames: PixelImage[] }
  /** Split a single image into poses (sheet) or pass decoded frames through. */
  | { type: 'prepare'; id: number; split: boolean; opts: PixelizeOptions }
  | { type: 'run'; id: number; order: number[]; variants: PixelizeOptions[]; maxColors: number }
  | { type: 'loops'; id: number; order: number[]; opts: PixelizeOptions; range?: [number, number] };

export type WorkerOut =
  | { type: 'prepared'; id: number; prepared: Prepared }
  | { type: 'result'; id: number; results: PixelizeResult[]; quality: QualityReport[] }
  | { type: 'loops'; id: number; loops: ReturnType<typeof findLoops> }
  | { type: 'error'; id: number; message: string };

let source: PixelImage[] = [];
let working: PixelImage[] = [];
let workingIsSheet = false;
const post = (m: WorkerOut) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

/** Small preview of a working frame for the frame strip. */
function thumb(f: PixelImage, size = 56): PixelImage {
  const s = Math.max(1, Math.max(f.width, f.height) / size);
  const w = Math.max(1, Math.round(f.width / s)), h = Math.max(1, Math.round(f.height / s));
  const out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (Math.floor(y * s) * f.width + Math.floor(x * s)) * 4;
    out.data.set(f.data.subarray(i, i + 4), (y * w + x) * 4);
  }
  return out;
}

/** Sheets already had their backdrop removed during splitting. */
const effective = (o: PixelizeOptions): PixelizeOptions => (workingIsSheet ? { ...o, background: 'none' } : o);

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (m.type === 'load') { source = m.frames; working = source; workingIsSheet = false; return; }
  try {
    if (m.type === 'prepare') {
      if (m.split && source.length === 1) {
        const p = prepareSheet(source[0], m.opts);
        workingIsSheet = true;
        working = p.frames;
        post({ type: 'prepared', id: m.id, prepared: { count: p.frames.length, rows: p.rows, sheet: p.frames.length > 1, dropped: p.dropped, thumbs: p.frames.map(f => thumb(f)) } });
      } else {
        workingIsSheet = false;
        working = source;
        post({ type: 'prepared', id: m.id, prepared: { count: source.length, rows: [source.map((_, i) => i)], sheet: false, dropped: 0, thumbs: source.length <= 128 ? source.map(f => thumb(f)) : [] } });
      }
    } else if (m.type === 'run') {
      const frames = m.order.map(i => working[i]).filter(Boolean);
      const results = m.variants.map(v => pixelize(frames, effective(v)));
      post({ type: 'result', id: m.id, results, quality: results.map(r => assessResult(r, m.maxColors)) });
    } else if (m.type === 'loops') {
      // Compare cleaned, anchored frames: drift and background noise would hide real loops.
      // Loop search only compares silhouettes and shading: a small size with no palette, clean-up
      // or finish is several times faster and finds the same loops.
      const clean = pixelize(m.order.map(i => working[i]), {
        ...effective(m.opts), outline: null, palette: 'fixed', fixedPalette: [], cleanup: false, crisp: false,
        targetHeight: Math.min(m.opts.targetHeight, 48),
      }).frames;
      post({ type: 'loops', id: m.id, loops: findLoops(clean, m.range?.[0] ?? 4, 5, m.range?.[1] ?? Infinity) });
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
