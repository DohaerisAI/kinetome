import type { PixelImage, Rect } from '@kinetome/core';
import { createImage } from './image.ts';

export interface NormalMapOptions {
  /** Width in pixels of the rounded rim; interiors deeper than this are flat. Default 3. */
  bevel?: number;
  /** Multiplier on the surface slope. Default 1. */
  strength?: number;
  /** 0..1, how much pixel brightness adds height (shading becomes bumps). Default 0.35. */
  luminance?: number;
  /** false (default) = Godot/OpenGL convention, green points up. true = DirectX, green down. */
  flipY?: boolean;
}

export interface PreviewLight {
  /** Light position in pixel space (x right, y down, z toward the viewer). */
  x: number;
  y: number;
  z: number;
  color?: [number, number, number];
  /** 0..1 floor brightness for unlit sides. Default 0.35. */
  ambient?: number;
}

const FLAT: [number, number, number] = [128, 128, 255];

/**
 * Distance (in pixels, chamfer 1/√2) from each opaque pixel to the nearest transparent pixel
 * or the image border. Edge pixels get 1; transparent pixels get 0.
 */
function edgeDistance(solid: Uint8Array, W: number, H: number): Float32Array {
  const D = new Float32Array(W * H);
  const INF = 1e9, DIAG = Math.SQRT2;
  for (let i = 0; i < W * H; i++) D[i] = solid[i] ? INF : 0;
  // out-of-bounds counts as transparent, so a neighbour outside reads as 0
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : D[y * W + x]);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!D[i]) continue;
      D[i] = Math.min(D[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + DIAG, at(x + 1, y - 1) + DIAG);
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!D[i]) continue;
      D[i] = Math.min(D[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + DIAG, at(x - 1, y + 1) + DIAG);
    }
  return D;
}

/**
 * Normal map for a sprite, ready for Godot's CanvasTexture `normal_texture`. Height = a pillow
 * rising from the silhouette edge over `bevel` px (so every shape bulges toward the viewer)
 * plus a little luminance detail; normals come from a Sobel filter on that height field.
 * One output pixel per input pixel, alpha copied, transparent pixels get the flat normal.
 */
export function normalMap(img: PixelImage, opts: NormalMapOptions = {}): PixelImage {
  const bevel = Math.max(1, opts.bevel ?? 3);
  const strength = opts.strength ?? 1;
  const lum = Math.min(1, Math.max(0, opts.luminance ?? 0.35));
  const ySign = opts.flipY ? -1 : 1;
  const { width: W, height: H, data } = img;
  const solid = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) solid[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  const dist = edgeDistance(solid, W, H);

  // height in pixel units: the pillow tops out at `bevel` px, giving ~45° rims at strength 1
  const h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!solid[i]) continue;
    const t = Math.min(dist[i], bevel) / bevel;
    const pillow = 1 - (1 - t) * (1 - t); // ease-out: steep at the rim, flat on top
    const p = i * 4;
    const L = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
    h[i] = bevel * ((1 - lum) * pillow + lum * L);
  }

  const out = createImage(W, H);
  const o = out.data;
  const hAt = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : h[y * W + x]);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4;
      o[p + 3] = data[p + 3];
      if (!solid[i]) { o[p] = FLAT[0]; o[p + 1] = FLAT[1]; o[p + 2] = FLAT[2]; continue; }
      const tl = hAt(x - 1, y - 1), t = hAt(x, y - 1), tr = hAt(x + 1, y - 1);
      const l = hAt(x - 1, y), r = hAt(x + 1, y);
      const bl = hAt(x - 1, y + 1), b = hAt(x, y + 1), br = hAt(x + 1, y + 1);
      // Sobel / 8 = per-pixel slope; y grows downward in the image
      const dx = (tr + 2 * r + br - tl - 2 * l - bl) / 8;
      const dy = (bl + 2 * b + br - tl - 2 * t - tr) / 8;
      let nx = -dx * strength;
      let ny = dy * strength * ySign; // green-up: rising toward the bottom tilts the normal up
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      o[p] = Math.round((nx * 0.5 + 0.5) * 255);
      o[p + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      o[p + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  return out;
}

/**
 * Normal map for a sprite sheet, computed frame by frame so a frame's rim never sees its
 * neighbour's pixels. Areas outside every rect get the flat normal with the source alpha.
 */
export function normalMapFrames(sheet: PixelImage, rects: Rect[], opts: NormalMapOptions = {}): PixelImage {
  const { width: W, height: H } = sheet;
  const out = createImage(W, H);
  for (let i = 0; i < W * H; i++) out.data.set([...FLAT, sheet.data[i * 4 + 3]], i * 4);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(W, Math.floor(r.x + r.w)), y1 = Math.min(H, Math.floor(r.y + r.h));
    if (x1 <= x0 || y1 <= y0) continue;
    const fw = x1 - x0, fh = y1 - y0;
    const frame = createImage(fw, fh);
    for (let y = 0; y < fh; y++)
      frame.data.set(sheet.data.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1) * 4), y * fw * 4);
    const n = normalMap(frame, opts);
    for (let y = 0; y < fh; y++)
      out.data.set(n.data.subarray(y * fw * 4, (y + 1) * fw * 4), ((y0 + y) * W + x0) * 4);
  }
  return out;
}

/**
 * Lambert-shaded preview of a sprite under a point light, using a green-up normal map.
 * Brightness = ambient + (1 - ambient) * max(0, N·L), tinted by the light color.
 */
export function litPreview(img: PixelImage, normals: PixelImage, light: PreviewLight): PixelImage {
  const { width: W, height: H, data } = img;
  const ambient = Math.min(1, Math.max(0, light.ambient ?? 0.35));
  const [cr, cg, cb] = (light.color ?? [255, 255, 255]).map((c) => c / 255);
  const out = createImage(W, H);
  const o = out.data, n = normals.data;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      o[p + 3] = data[p + 3];
      if (!data[p + 3]) continue;
      const nx = n[p] / 127.5 - 1, ny = n[p + 1] / 127.5 - 1, nz = n[p + 2] / 127.5 - 1;
      // light vector from pixel centre, converted to y-up to match the map
      const lx = light.x - (x + 0.5), ly = (y + 0.5) - light.y, lz = light.z;
      const ll = Math.hypot(lx, ly, lz) || 1;
      const nl = Math.max(0, (nx * lx + ny * ly + nz * lz) / ll);
      const k = ambient + (1 - ambient) * nl;
      o[p] = Math.round(data[p] * Math.min(1, k * cr));
      o[p + 1] = Math.round(data[p + 1] * Math.min(1, k * cg));
      o[p + 2] = Math.round(data[p + 2] * Math.min(1, k * cb));
    }
  return out;
}
