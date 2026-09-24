import { hexToRgb, PaletteMatcher, rgbToHex, rgbToOklab, type PixelImage } from '@kinetome/core';

/** Deterministic PRNG so the same input always yields the same palette. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One palette for ALL frames (k-means in Oklab over opaque pixels). Per-frame palettes are
 * what make converted animations flicker; a shared one keeps every frame's colors identical.
 */
export function sharedPalette(frames: PixelImage[], k: number, sampleMax = 40_000): string[] {
  const rgb: [number, number, number][] = [];
  let total = 0;
  for (const f of frames) for (let i = 3; i < f.data.length; i += 4) if (f.data[i] >= 128) total++;
  const step = Math.max(1, Math.floor(total / sampleMax));
  let seen = 0;
  for (const f of frames)
    for (let i = 0; i < f.data.length; i += 4) {
      if (f.data[i + 3] < 128) continue;
      if (seen++ % step === 0) rgb.push([f.data[i], f.data[i + 1], f.data[i + 2]]);
    }
  if (!rgb.length) return [];
  const pts = rgb.map(([r, g, b]) => rgbToOklab(r, g, b));
  const unique = new Set(rgb.map(([r, g, b]) => (r << 16) | (g << 8) | b));
  if (unique.size <= k) return [...unique].map(v => rgbToHex((v >> 16) & 255, (v >> 8) & 255, v & 255));

  const rand = mulberry32(1337);
  const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // k-means++ seeding
  const cents: number[][] = [pts[Math.floor(rand() * pts.length)]];
  const dist = new Float64Array(pts.length).fill(Infinity);
  while (cents.length < k) {
    const c = cents[cents.length - 1];
    let sum = 0;
    for (let i = 0; i < pts.length; i++) { dist[i] = Math.min(dist[i], d2(pts[i], c)); sum += dist[i]; }
    let r = rand() * sum, idx = 0;
    for (; idx < pts.length - 1; idx++) { r -= dist[idx]; if (r <= 0) break; }
    cents.push(pts[idx]);
  }
  const assign = new Int32Array(pts.length);
  const sums = cents.map(() => [0, 0, 0, 0]);
  const sumRgb = cents.map(() => [0, 0, 0]);
  for (let iter = 0; iter < 12; iter++) {
    for (const s of sums) s.fill(0);
    for (const s of sumRgb) s.fill(0);
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < cents.length; c++) { const d = d2(pts[i], cents[c]); if (d < bd) { bd = d; best = c; } }
      assign[i] = best;
      const s = sums[best]; s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++;
      const sr = sumRgb[best]; sr[0] += rgb[i][0]; sr[1] += rgb[i][1]; sr[2] += rgb[i][2];
    }
    for (let c = 0; c < cents.length; c++) if (sums[c][3]) cents[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
  }
  // centroid colors as the mean RGB of their members (exact, no Oklab->sRGB inverse needed)
  const out = new Set<string>();
  for (let c = 0; c < cents.length; c++) {
    const n = sums[c][3];
    if (n) out.add(rgbToHex(Math.round(sumRgb[c][0] / n), Math.round(sumRgb[c][1] / n), Math.round(sumRgb[c][2] / n)));
  }
  return [...out];
}

/** Maps each auto color to its nearest Style Bible color, so a free palette lands on the project's. */
export function mapPaletteTo(auto: string[], bible: string[]): string[] {
  const m = new PaletteMatcher(bible);
  return [...new Set(auto.map(h => { const [r, g, b] = hexToRgb(h); return bible[m.nearest(r, g, b)]; }))];
}
