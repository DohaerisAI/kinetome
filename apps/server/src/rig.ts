import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { designColors, hexToRgb, PaletteMatcher, type CharacterDesign, type PixelImage, type SpriteAsset } from '@kinetome/core';
import { decodePng, encodePng } from './png.ts';
import * as store from './store.ts';

export interface RigContext {
  ref: PixelImage;
  refPivot: { x: number; y: number };
  pad: number;
  width: number;
  height: number;
  pivot: [number, number];
  /** Text pixel map with coordinates, for precise part polygons. */
  pixelMap: string;
  /** Scaled, gridded PNG of the reference for Claude to look at. */
  imagePath: string;
}

/** The character's reference frame: first frame of "idle" (or of the first animation). */
export async function loadReference(p: string, d: CharacterDesign): Promise<{ asset: SpriteAsset; ref: PixelImage } | null> {
  if (!d.assetId) return null;
  const asset = await store.getAsset(p, d.assetId).catch(() => null);
  if (!asset) return null;
  const sheet = decodePng(await readFile(store.sheetPath(p, asset.id)));
  const anim = asset.animations.find(a => a.name === 'idle') ?? asset.animations[0];
  const r = asset.frames[anim?.frames[0] ?? 0];
  const ref: PixelImage = { width: r.w, height: r.h, data: new Uint8ClampedArray(r.w * r.h * 4) };
  for (let y = 0; y < r.h; y++) ref.data.set(sheet.data.subarray(((r.y + y) * sheet.width + r.x) * 4, ((r.y + y) * sheet.width + r.x + r.w) * 4), y * r.w * 4);
  return { asset, ref };
}

const SYMBOLS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * The reference as text: one character per pixel ('.' = transparent), each symbol a
 * palette color name, with column and row coordinates. Claude reads exact coordinates
 * from this to cut parts, far more precisely than from an image.
 */
export function pixelMap(ref: PixelImage, colors: Record<string, string>): string {
  const names = Object.keys(colors);
  const m = new PaletteMatcher(names.map(n => colors[n]));
  let x0 = ref.width, y0 = ref.height, x1 = -1, y1 = -1;
  for (let y = 0; y < ref.height; y++) for (let x = 0; x < ref.width; x++)
    if (ref.data[(y * ref.width + x) * 4 + 3] >= 128) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 < 0) return '(empty reference)';
  const used = new Set<number>();
  const rows: string[] = [];
  for (let y = y0; y <= y1; y++) {
    let line = '';
    for (let x = x0; x <= x1; x++) {
      const i = (y * ref.width + x) * 4;
      if (ref.data[i + 3] < 128) { line += '.'; continue; }
      const k = m.nearest(ref.data[i], ref.data[i + 1], ref.data[i + 2]);
      used.add(k);
      line += SYMBOLS[k % SYMBOLS.length];
    }
    rows.push(`${String(y).padStart(3)} |${line}`);
  }
  const ruler = (digit: (x: number) => string) => `    |${Array.from({ length: x1 - x0 + 1 }, (_, k) => digit(x0 + k)).join('')}`;
  const legend = [...used].sort((a, b) => a - b).map(k => `${SYMBOLS[k % SYMBOLS.length]} = ${names[k]}`).join(', ');
  return [
    `Reference pixel map: columns x=${x0}..${x1}, rows y=${y0}..${y1} (reference coordinates; the rest is transparent).`,
    `Legend: . = transparent, ${legend}`,
    ruler(x => String(Math.floor(x / 100) % 10)),
    ruler(x => String(Math.floor(x / 10) % 10)),
    ruler(x => String(x % 10)),
    ...rows,
  ].join('\n');
}

/** Scaled reference with a light grid every 10px, so Claude can relate the image to the map. */
function griddedImage(ref: PixelImage): PixelImage {
  const s = Math.max(2, Math.min(8, Math.floor(900 / Math.max(ref.width, ref.height))));
  const W = ref.width * s, H = ref.height * s;
  const out: PixelImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const rx = Math.floor(x / s), ry = Math.floor(y / s), i = (ry * ref.width + rx) * 4, o = (y * W + x) * 4;
    const grid = (x % (s * 10) === 0 || y % (s * 10) === 0);
    if (ref.data[i + 3] >= 128) { out.data[o] = ref.data[i]; out.data[o + 1] = ref.data[i + 1]; out.data[o + 2] = ref.data[i + 2]; }
    else { const c = grid ? 110 : 52; out.data[o] = c; out.data[o + 1] = c; out.data[o + 2] = c + 14; }
    if (grid && ref.data[i + 3] >= 128) { out.data[o] = Math.min(255, out.data[o] + 40); out.data[o + 1] = Math.min(255, out.data[o + 1] + 40); out.data[o + 2] = Math.min(255, out.data[o + 2] + 40); }
    out.data[o + 3] = 255;
  }
  return out;
}

/**
 * The reference a rig program was written against is FROZEN in a snapshot next to the
 * design: merging new animations into the library sprite can grow its frame cell and
 * shift the reference, which would misalign every part polygon of an existing program.
 */
const snapshotPath = (p: string, d: CharacterDesign) => join(store.projectPath(p), 'characters', `${d.id}.ref.png`);
const snapshotMeta = (p: string, d: CharacterDesign) => join(store.projectPath(p), 'characters', `${d.id}.ref.json`);

async function readSnapshot(p: string, d: CharacterDesign): Promise<{ ref: PixelImage; pivot: { x: number; y: number } } | null> {
  try {
    await stat(snapshotPath(p, d));
    return { ref: decodePng(await readFile(snapshotPath(p, d))), pivot: JSON.parse(await readFile(snapshotMeta(p, d), 'utf8')).pivot };
  } catch { return null; }
}

/**
 * `fresh`: take the reference from the library sprite now and freeze it (new program).
 * Otherwise reuse the frozen snapshot when there is one (revisions, re-renders).
 */
export async function buildRig(p: string, d: CharacterDesign, dir: string, fresh = false): Promise<RigContext | null> {
  let src = fresh ? null : await readSnapshot(p, d);
  if (!src) {
    const loaded = await loadReference(p, d);
    if (!loaded) return null;
    src = { ref: loaded.ref, pivot: loaded.asset.pivot };
    await writeFile(snapshotPath(p, d), encodePng(src.ref));
    await writeFile(snapshotMeta(p, d), JSON.stringify({ pivot: src.pivot, takenAt: new Date().toISOString() }));
  }
  const { ref } = src;
  const asset = { pivot: src.pivot };
  const pad = Math.max(6, Math.round(Math.max(ref.width, ref.height) * 0.15));
  const imagePath = join(dir, 'reference.png');
  await writeFile(imagePath, encodePng(griddedImage(ref)));
  return {
    ref, refPivot: asset.pivot, pad,
    width: ref.width + pad * 2, height: ref.height + pad,
    pivot: [asset.pivot.x + pad, asset.pivot.y + pad],
    pixelMap: pixelMap(ref, designColors(d)),
    imagePath,
  };
}

/** The reference placed on the program's canvas (for the review sheet's first row). */
export function paddedReference(rig: RigContext): PixelImage {
  const out: PixelImage = { width: rig.width, height: rig.height, data: new Uint8ClampedArray(rig.width * rig.height * 4) };
  for (let y = 0; y < rig.ref.height; y++)
    out.data.set(rig.ref.data.subarray(y * rig.ref.width * 4, (y + 1) * rig.ref.width * 4), ((y + rig.pad) * rig.width + rig.pad) * 4);
  return out;
}

export { hexToRgb };
