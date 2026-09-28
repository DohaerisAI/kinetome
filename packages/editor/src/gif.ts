import type { PixelImage } from '@kinetome/core';

/**
 * Animated GIF encoder for pixel art: one global palette (exact colors when the sprite
 * uses 255 or fewer, which pixel art nearly always does), index 0 = transparent,
 * nearest-neighbour upscaling, per-frame delays, infinite or single play.
 */

export interface GifOptions {
  /** Integer upscale (1 = actual pixels). */
  scale?: number;
  /** true = loop forever, false = play once. */
  loop?: boolean;
  /** Fill transparent pixels with this color instead (GIF has only 1-bit alpha). */
  background?: [number, number, number] | null;
}

function buildPalette(frames: PixelImage[], bg: [number, number, number] | null): { colors: number[]; index: (r: number, g: number, b: number) => number } {
  const counts = new Map<number, number>();
  for (const f of frames) for (let i = 0; i < f.data.length; i += 4) {
    if (f.data[i + 3] < 128) continue;
    const k = (f.data[i] << 16) | (f.data[i + 1] << 8) | f.data[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (bg) { const k = (bg[0] << 16) | (bg[1] << 8) | bg[2]; counts.set(k, (counts.get(k) ?? 0) + 1); }
  // most used first; beyond 255 colors the rest map to their nearest kept color
  const colors = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 255).map(([k]) => k);
  const exact = new Map(colors.map((k, i) => [k, i + 1]));
  const near = new Map<number, number>();
  const index = (r: number, g: number, b: number) => {
    const k = (r << 16) | (g << 8) | b;
    const e = exact.get(k) ?? near.get(k);
    if (e !== undefined) return e;
    let best = 1, bd = Infinity;
    colors.forEach((c, i) => {
      const d = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2;
      if (d < bd) { bd = d; best = i + 1; }
    });
    near.set(k, best);
    return best;
  };
  return { colors, index };
}

/** GIF-flavoured LZW over `indices`, packed into 255-byte sub-blocks. */
function lzw(indices: Uint8Array, minCode: number): number[] {
  const clear = 1 << minCode, eoi = clear + 1;
  const out: number[] = [];
  let bits = 0, nbits = 0;
  let size = minCode + 1;
  const emit = (code: number) => {
    bits |= code << nbits; nbits += size;
    while (nbits >= 8) { out.push(bits & 255); bits >>>= 8; nbits -= 8; }
  };
  let dict = new Map<number, number>();
  let next = eoi + 1;
  emit(clear);
  let cur = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = cur * 4096 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { cur = hit; continue; }
    emit(cur);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map(); next = eoi + 1; size = minCode + 1;
    }
    cur = k;
  }
  emit(cur);
  emit(eoi);
  if (nbits > 0) out.push(bits & 255);
  const blocks: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return blocks;
}

export function encodeGif(frames: PixelImage[], delaysMs: number[], opts: GifOptions = {}): Uint8Array {
  if (!frames.length) throw new Error('No frames to encode');
  const scale = Math.max(1, Math.round(opts.scale ?? 1));
  const bg = opts.background ?? null;
  const W = frames[0].width * scale, H = frames[0].height * scale;
  const { colors, index } = buildPalette(frames, bg);
  let depth = 1;
  while ((1 << depth) < colors.length + 1) depth++;
  const tableSize = 1 << depth;

  const bytes: number[] = [];
  const u16 = (n: number) => bytes.push(n & 255, (n >> 8) & 255);
  bytes.push(...[...'GIF89a'].map(c => c.charCodeAt(0)));
  u16(W); u16(H);
  bytes.push(0x80 | ((depth - 1) << 4) | (depth - 1), 0, 0); // global table, background index 0
  for (let i = 0; i < tableSize; i++) {
    const c = i === 0 ? 0 : colors[i - 1] ?? 0;
    bytes.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
  }
  // NETSCAPE2.0: loop count (0 = forever)
  bytes.push(0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map(c => c.charCodeAt(0)), 0x03, 0x01);
  u16(opts.loop === false ? 1 : 0);
  bytes.push(0);

  const transparent = !bg;
  frames.forEach((f, n) => {
    const delay = Math.max(2, Math.round((delaysMs[n] ?? 100) / 10));
    // graphic control: dispose to background (2) so transparent frames don't smear
    bytes.push(0x21, 0xf9, 0x04, (2 << 2) | (transparent ? 1 : 0));
    u16(delay);
    bytes.push(0, 0);
    bytes.push(0x2c); u16(0); u16(0); u16(W); u16(H); bytes.push(0);
    const idx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = ((Math.floor(y / scale) * f.width) + Math.floor(x / scale)) * 4;
      const a = f.data[i + 3];
      idx[y * W + x] = a >= 128 ? index(f.data[i], f.data[i + 1], f.data[i + 2]) : bg ? index(bg[0], bg[1], bg[2]) : 0;
    }
    const minCode = Math.max(2, depth);
    bytes.push(minCode, ...lzw(idx, minCode));
  });
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
