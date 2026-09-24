import type { PixelImage } from '@kinetome/core';
import { createImage } from './image.ts';

export interface GridGuess { scale: number; offsetX: number; offsetY: number; confidence: number }

/** Sum of color change between neighbouring columns (axis 'x') or rows ('y'). */
function edgeProfile(img: PixelImage, axis: 'x' | 'y'): Float64Array {
  const { width: W, height: H, data } = img;
  const n = axis === 'x' ? W : H;
  const prof = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    let s = 0;
    const m = axis === 'x' ? H : W;
    for (let j = 0; j < m; j++) {
      const a = (axis === 'x' ? j * W + i : i * W + j) * 4;
      const b = (axis === 'x' ? j * W + i - 1 : (i - 1) * W + j) * 4;
      if (data[a + 3] < 128 && data[b + 3] < 128) continue;
      s += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]) + Math.abs(data[a + 3] - data[b + 3]);
    }
    prof[i] = s;
  }
  return prof;
}

/**
 * Edge positions: local maxima of the profile, refined to sub-pixel precision with a
 * parabola (blur spreads each edge over 2-3px; the peak is still where the boundary is).
 * Position b means "a cell starts at pixel b".
 */
function edgePeaks(prof: Float64Array): { x: number; w: number }[] {
  let max = 0;
  for (const v of prof) if (v > max) max = v;
  const thresh = max * 0.15;
  const out: { x: number; w: number }[] = [];
  for (let i = 1; i < prof.length - 1; i++) {
    const a = prof[i - 1], b = prof[i], c = prof[i + 1];
    if (b <= thresh || b <= a || b < c) continue;
    const den = a - 2 * b + c;
    out.push({ x: i + (den !== 0 ? (0.5 * (a - c)) / den : 0), w: b });
  }
  return out;
}

/** How tightly edges line up on a grid of period s: 1 = every edge on a boundary. Also returns the phase. */
function alignment(peaks: { x: number; w: number }[], s: number): { r: number; phase: number } {
  let re = 0, im = 0, tot = 0;
  const k = (2 * Math.PI) / s;
  for (const p of peaks) { re += p.w * Math.cos(k * p.x); im += p.w * Math.sin(k * p.x); tot += p.w; }
  const ang = Math.atan2(im, re);
  return { r: tot ? Math.hypot(re, im) / tot : 0, phase: (((ang / k) % s) + s) % s };
}

function bestPeriod(prof: Float64Array, minS: number, maxS: number): { s: number; r: number; phase: number; edges: number } | null {
  const peaks = edgePeaks(prof);
  if (peaks.length < 8) return null;
  const cands: { s: number; r: number; phase: number }[] = [];
  for (let s = minS; s <= maxS; s += 0.01) cands.push({ s, ...alignment(peaks, s) });
  const rMax = Math.max(...cands.map(c => c.r));
  if (rMax < 0.6) return null;
  // Edges on a period-s grid also sit on every s/m grid (harmonics), but not on 2s.
  // The fundamental is therefore the LARGEST period that is nearly as well aligned as the best.
  let pick = cands[0];
  for (const c of cands) if (c.r >= rMax * 0.9) pick = c;
  // refine around the pick (local maximum of r)
  for (const c of cands) if (Math.abs(c.s - pick.s) < pick.s * 0.03 && c.r > pick.r) pick = c;
  return { ...pick, edges: peaks.length };
}

/**
 * Detects "fake pixel art": pixel art that was upscaled (often by a non-integer factor)
 * and blurred, typical of AI generators and screenshots. Returns the block size and grid
 * phase, or null when there's no convincing grid (then it's an illustration).
 */
export function detectPixelScale(img: PixelImage, maxScale = 40): GridGuess | null {
  const upper = Math.min(maxScale, Math.floor(Math.min(img.width, img.height) / 6));
  if (upper < 2) return null;
  const gx = bestPeriod(edgeProfile(img, 'x'), 2, upper);
  const gy = bestPeriod(edgeProfile(img, 'y'), 2, upper);
  if (!gx || !gy || gx.s < 2 || gy.s < 2) return null;
  if (Math.abs(gx.s - gy.s) / Math.max(gx.s, gy.s) > 0.06) return null;
  // Enough cells must be crossed for the alignment to mean anything.
  if (Math.min(img.width, img.height) / gx.s < 6) return null;
  const confidence = Math.min(gx.r, gy.r);
  if (confidence < 0.75) return null;
  return { scale: (gx.s + gy.s) / 2, offsetX: gx.phase, offsetY: gy.phase, confidence };
}

/** Grid of a user-given block size; only the alignment (phase) is detected. */
export function gridAt(img: PixelImage, scale: number): GridGuess {
  const ax = alignment(edgePeaks(edgeProfile(img, 'x')), scale);
  const ay = alignment(edgePeaks(edgeProfile(img, 'y')), scale);
  return { scale, offsetX: ax.phase, offsetY: ay.phase, confidence: Math.min(ax.r, ay.r) };
}

/**
 * Rebuilds true pixels from a detected grid: each cell becomes the dominant color of its
 * inner area (edges skipped, since that's where blur and JPEG ringing live).
 */
export function sampleGrid(img: PixelImage, g: GridGuess): PixelImage {
  const w = Math.max(1, Math.floor((img.width - g.offsetX) / g.scale));
  const h = Math.max(1, Math.floor((img.height - g.offsetY) / g.scale));
  const out = createImage(w, h);
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const x0 = g.offsetX + cx * g.scale, y0 = g.offsetY + cy * g.scale;
      const inset = g.scale * 0.2;
      const xa = Math.floor(x0 + inset), xb = Math.max(xa, Math.ceil(x0 + g.scale - inset) - 1);
      const ya = Math.floor(y0 + inset), yb = Math.max(ya, Math.ceil(y0 + g.scale - inset) - 1);
      bins.clear();
      let opaque = 0, count = 0;
      for (let y = ya; y <= yb && y < img.height; y++)
        for (let x = xa; x <= xb && x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          count++;
          if (img.data[i + 3] < 128) continue;
          opaque++;
          const k = ((img.data[i] >> 3) << 10) | ((img.data[i + 1] >> 3) << 5) | (img.data[i + 2] >> 3);
          const b = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
          b.n++; b.r += img.data[i]; b.g += img.data[i + 1]; b.b += img.data[i + 2];
          bins.set(k, b);
        }
      if (opaque * 2 < count || !bins.size) continue;
      let best = null as { n: number; r: number; g: number; b: number } | null;
      for (const b of bins.values()) if (!best || b.n > best.n) best = b;
      const o = (cy * w + cx) * 4;
      out.data[o] = best!.r / best!.n; out.data[o + 1] = best!.g / best!.n; out.data[o + 2] = best!.b / best!.n; out.data[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Downscale for illustrations. 'smooth' = alpha-weighted area average (soft, keeps detail;
 * the palette step re-sharpens colors). 'sharp' = dominant color per cell (crisp lines,
 * can drop thin details).
 */
export function resize(img: PixelImage, tw: number, th: number, mode: 'smooth' | 'sharp' = 'smooth'): PixelImage {
  const out = createImage(tw, th);
  const sx = img.width / tw, sy = img.height / th;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let oy = 0; oy < th; oy++) {
    const y0 = Math.floor(oy * sy), y1 = Math.max(y0 + 1, Math.floor((oy + 1) * sy));
    for (let ox = 0; ox < tw; ox++) {
      const x0 = Math.floor(ox * sx), x1 = Math.max(x0 + 1, Math.floor((ox + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      bins.clear();
      for (let y = y0; y < y1 && y < img.height; y++)
        for (let x = x0; x < x1 && x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          const al = img.data[i + 3];
          n++;
          a += al;
          if (mode === 'smooth') { r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al; }
          else if (al >= 128) {
            const k = ((img.data[i] >> 3) << 10) | ((img.data[i + 1] >> 3) << 5) | (img.data[i + 2] >> 3);
            const bn = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
            bn.n++; bn.r += img.data[i]; bn.g += img.data[i + 1]; bn.b += img.data[i + 2];
            bins.set(k, bn);
          }
        }
      const o = (oy * tw + ox) * 4;
      if (mode === 'smooth') {
        if (a === 0) continue;
        out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a; out.data[o + 3] = a / n;
      } else {
        if (a / n < 128 || !bins.size) continue;
        let best = null as { n: number; r: number; g: number; b: number } | null;
        for (const bn of bins.values()) if (!best || bn.n > best.n) best = bn;
        out.data[o] = best!.r / best!.n; out.data[o + 1] = best!.g / best!.n; out.data[o + 2] = best!.b / best!.n; out.data[o + 3] = 255;
      }
    }
  }
  return out;
}
