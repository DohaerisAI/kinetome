/// <reference lib="webworker" />
import type { PixelImage } from '@sprite/core';
import { findLoops, pixelize, type PixelizeOptions } from '@sprite/pixel';

export type WorkerIn =
  | { type: 'load'; frames: PixelImage[] }
  | { type: 'run'; id: number; indices: number[]; variants: PixelizeOptions[] }
  | { type: 'loops'; id: number; indices: number[]; opts: PixelizeOptions };

export type WorkerOut =
  | { type: 'result'; id: number; results: ReturnType<typeof pixelize>[] }
  | { type: 'loops'; id: number; loops: ReturnType<typeof findLoops> }
  | { type: 'error'; id: number; message: string };

let source: PixelImage[] = [];
const post = (m: WorkerOut) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (m.type === 'load') { source = m.frames; return; }
  try {
    if (m.type === 'run') {
      const frames = m.indices.map(i => source[i]).filter(Boolean);
      post({ type: 'result', id: m.id, results: m.variants.map(v => pixelize(frames, v)) });
    } else if (m.type === 'loops') {
      // Compare cleaned, anchored frames: drift and background noise would hide real loops.
      const clean = pixelize(m.indices.map(i => source[i]), { ...m.opts, outline: null }).frames;
      const at = (k: number) => (k < m.indices.length ? m.indices[k] : m.indices[m.indices.length - 1] + 1);
      const loops = findLoops(clean, 4, 5).map(l => ({ ...l, start: at(l.start), end: at(l.end) }));
      post({ type: 'loops', id: m.id, loops });
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
