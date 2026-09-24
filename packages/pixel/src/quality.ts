import { countColors, type PixelImage } from '@kinetome/core';
import { bodyHeight, contentBounds } from './image.ts';
import { signature } from './loop.ts';
import type { PixelizeResult } from './pipeline.ts';

export interface QualityIssue {
  severity: 'error' | 'warn' | 'info';
  message: string;
  /** Positions (in the result's frame list) this applies to. */
  frames?: number[];
}

export interface QualityReport { score: number; issues: QualityIssue[] }

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Small opaque clusters not attached to the body: leftover specks. */
function specks(f: PixelImage): number {
  const { width: W, height: H, data } = f;
  const seen = new Uint8Array(W * H);
  let count = 0;
  for (let p = 0; p < W * H; p++) {
    if (seen[p] || data[p * 4 + 3] < 128) continue;
    const comp = [p];
    seen[p] = 1;
    for (let k = 0; k < comp.length && comp.length <= 3; k++) {
      const q = comp[k], x = q % W, y = (q - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (!seen[n] && data[n * 4 + 3] >= 128) { seen[n] = 1; comp.push(n); }
      }
    }
    if (comp.length <= 2) count++;
  }
  return count;
}

const list = (xs: number[]) => xs.map(i => i + 1).join(', ');

/**
 * Checks a converted animation for the things that make game sprites look amateur:
 * size drift between frames, glitch frames, flicker colors, specks, weak grid detection.
 */
export function assessResult(r: PixelizeResult, maxColors: number): QualityReport {
  const issues: QualityIssue[] = [];
  const n = r.frames.length;
  const bounds = r.frames.map(f => contentBounds(f, 128));

  const empty = bounds.flatMap((b, i) => (b ? [] : [i]));
  if (empty.length) issues.push({ severity: 'error', message: `Empty frame${empty.length > 1 ? 's' : ''} ${list(empty)}`, frames: empty });

  const hs = r.frames.map((f, i) => (bounds[i] ? bodyHeight(f) : 0)), mh = median(hs.filter(h => h > 0));
  if (mh > 0 && mh < 12) issues.push({ severity: 'warn', message: `Only ${mh}px tall: too small to read in-game; raise the height` });
  if (n > 2) {
    const off = hs.flatMap((h, i) => (h > 0 && Math.abs(h / mh - 1) > 0.08 && Math.abs(h / mh - 1) <= 0.3 ? [i] : []));
    // In grid mode each frame's own pixel grid already cancels scale drift, so a height
    // difference is the pose itself (raised arm, crouch): worth a note, not a warning.
    if (off.length) issues.push({
      severity: r.mode === 'grid' ? 'info' : 'warn',
      message: r.mode === 'grid'
        ? `Frame${off.length > 1 ? 's' : ''} ${list(off)}: body is ${off.map(i => `${hs[i]}px`).join(', ')} tall vs ${mh}px in the rest; fine for a crouch or stretch, otherwise the generator changed the size`
        : `Frame${off.length > 1 ? 's' : ''} ${list(off)}: body is ${off.map(i => `${hs[i]}px`).join(', ')} tall vs ${mh}px in the rest; turn on "Even out frame sizes" or delete ${off.length > 1 ? 'them' : 'it'}`,
      frames: off,
    });
  }

  if (n >= 4) {
    const sigs = r.frames.map(f => signature(f, 32));
    const d = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s / a.length; };
    const steps = sigs.slice(1).map((s, i) => d(sigs[i], s));
    const ms = median(steps);
    const glitch: number[] = [];
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? steps[i - 1] : Infinity, next = i < n - 1 ? steps[i] : Infinity;
      if (ms > 0 && Math.min(prev, next) > ms * 3.5) glitch.push(i);
    }
    if (glitch.length) issues.push({ severity: 'warn', message: `Frame${glitch.length > 1 ? 's' : ''} ${list(glitch)} ${glitch.length > 1 ? 'look' : 'looks'} very different from ${glitch.length > 1 ? 'their' : 'its'} neighbours (AI glitch or wrong order?)`, frames: glitch });

    const inFrames = new Map<string, number[]>();
    r.frames.forEach((f, i) => { for (const h of countColors(f).keys()) inFrames.set(h, [...(inFrames.get(h) ?? []), i]); });
    const flicker = [...inFrames].filter(([, fs]) => fs.length <= Math.max(1, Math.floor(n * 0.2)));
    if (flicker.length) {
      const fr = [...new Set(flicker.flatMap(([, fs]) => fs))].sort((a, b) => a - b);
      issues.push({ severity: 'info', message: `${flicker.length} color${flicker.length > 1 ? 's' : ''} appear in only a few frames (possible flicker)`, frames: fr });
    }
  }

  const sp = r.frames.map(specks);
  const speckFrames = sp.flatMap((c, i) => (c > 2 ? [i] : []));
  if (speckFrames.length) issues.push({ severity: 'info', message: `Single loose pixels in frame${speckFrames.length > 1 ? 's' : ''} ${list(speckFrames)}: fine for sparkles, otherwise leftovers`, frames: speckFrames });

  if (r.mode === 'grid') {
    const weak = r.grids.flatMap((g, i) => (g && g.confidence < 0.65 ? [i] : []));
    if (weak.length) issues.push({ severity: 'warn', message: `Pixel grid is uncertain in frame${weak.length > 1 ? 's' : ''} ${list(weak)}; set the block size by hand if pixels look doubled`, frames: weak });
  }
  if (r.palette.length > maxColors) issues.push({ severity: 'info', message: `${r.palette.length} colors; your style allows ${maxColors} per sprite` });

  const score = Math.max(0, 100 - issues.reduce((s, i) => s + (i.severity === 'error' ? 30 : i.severity === 'warn' ? 12 : 3), 0));
  return { score, issues };
}
