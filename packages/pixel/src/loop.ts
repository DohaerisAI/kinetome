import type { PixelImage } from '@sprite/core';

/** Tiny luminance+alpha thumbnail used to compare frames cheaply. */
export function signature(img: PixelImage, size = 24): Float32Array {
  const out = new Float32Array(size * size * 2);
  const sx = img.width / size, sy = img.height / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (Math.floor(y * sy) * img.width + Math.floor(x * sx)) * 4;
      const a = img.data[i + 3] / 255;
      out[(y * size + x) * 2] = a * (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]) / 255;
      out[(y * size + x) * 2 + 1] = a;
    }
  return out;
}

const diff = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s / a.length;
};

export interface LoopCandidate { start: number; end: number; score: number }

/**
 * Finds seamless loops: ranges [start, end) where frame `end` looks like frame `start`,
 * so playing start..end-1 on repeat has no visible jump. Lower score = better.
 *
 * Feed it cleaned, anchored frames (see pixelize): raw footage drifts, so it never repeats.
 * Scoring:
 *  - seam relative to the loop's own average step (a seam that looks like a normal step is invisible)
 *  - penalty for loops covering little of the clip's motion (a blinking gem during a hold is
 *    technically seamless but useless)
 *  - penalty for dead-still stretches inside the loop
 */
export function findLoops(frames: PixelImage[], minLen = 4, limit = 5): LoopCandidate[] {
  const n = frames.length;
  if (n < minLen + 1) return [];
  const sigs = frames.map(f => signature(f, 32));
  const D = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[i][j] = D[j][i] = diff(sigs[i], sigs[j]);
  const prefix = new Float64Array(n); // prefix[i] = sum of steps 0..i-1
  for (let i = 1; i < n; i++) prefix[i] = prefix[i - 1] + D[i - 1][i];
  let maxVariety = 0;
  const raw: { start: number; end: number; ratio: number; variety: number; still: number }[] = [];
  for (let s = 0; s < n; s++) {
    let variety = 0, still = 0;
    for (let e = s + 1; e < n; e++) {
      variety = Math.max(variety, D[s][e - 1]);
      if (e - s < minLen) continue;
      const motion = (prefix[e] - prefix[s]) / (e - s);
      if (motion < 1e-6) continue;
      still = 0;
      for (let i = s; i < e; i++) if (D[i][i + 1] < motion * 0.05) still++;
      const next = e + 1 < n ? D[s + 1][e + 1] : D[s][e];
      raw.push({ start: s, end: e, ratio: (D[s][e] * 0.7 + next * 0.3) / motion, variety, still: still / (e - s) });
      maxVariety = Math.max(maxVariety, variety);
    }
  }
  const out = raw.map(c => ({
    start: c.start, end: c.end,
    score: c.ratio + 0.6 * (1 - c.variety / (maxVariety || 1)) + 0.3 * c.still,
  }));
  out.sort((a, b) => a.score - b.score || (a.end - a.start) - (b.end - b.start)); // ties: shortest cycle
  const picked: LoopCandidate[] = [];
  for (const c of out) {
    if (picked.some(p => Math.abs(p.start - c.start) <= 1 && Math.abs(p.end - c.end) <= 1)) continue;
    picked.push(c);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** Picks `n` indices spread evenly over [start, end). */
export function pickEvenly(start: number, end: number, n: number): number[] {
  const len = end - start;
  if (n >= len) return Array.from({ length: len }, (_, i) => start + i);
  return Array.from({ length: n }, (_, i) => start + Math.floor((i * len) / n));
}
