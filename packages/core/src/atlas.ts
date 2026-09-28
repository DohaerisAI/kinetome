import type { PixelImage } from './color.ts';
import type { SpriteAsset } from './schema.ts';

/**
 * Multi-engine export: packs every frame of one or more assets into a single atlas page
 * and writes the data files Phaser 3, PixiJS, TexturePacker consumers and Unity understand.
 */

export interface AtlasItem { key: string; image: PixelImage }

export interface AtlasOptions {
  /** Largest allowed page side in pixels. Default 4096. */
  maxSize?: number;
  /** Transparent gap between packed sprites. Default 1. */
  padding?: number;
  /** Strip fully transparent borders (offsets are recorded). Default true. */
  trim?: boolean;
  /** Round the page up to power-of-two sides. Default false. */
  powerOfTwo?: boolean;
}

export interface AtlasPlacement {
  /** Region in the atlas page. */
  x: number; y: number; w: number; h: number;
  trimmed: boolean;
  /** Original (untrimmed) frame size. */
  sourceW: number; sourceH: number;
  /** Where the trimmed region sits inside the original frame. */
  offsetX: number; offsetY: number;
}

export interface Atlas {
  width: number;
  height: number;
  image: PixelImage;
  placements: Record<string, AtlasPlacement>;
}

export type ExportEngine = 'phaser' | 'pixi' | 'unity' | 'texturepacker';

interface Box { x: number; y: number; w: number; h: number }

// ---------- trimming ----------

/** Bounding box of non-transparent pixels; a fully transparent image keeps a 1x1 box at the origin. */
function opaqueBounds(img: PixelImage): Box {
  const { width, height, data } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: Math.min(1, width), h: Math.min(1, height) };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Copies a region; pixels outside the source stay transparent. */
function crop(img: PixelImage, r: Box): PixelImage {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const sy = r.y + y;
    if (sy < 0 || sy >= img.height) continue;
    const x0 = Math.max(0, r.x), x1 = Math.min(img.width, r.x + r.w);
    if (x1 <= x0) continue;
    out.set(img.data.subarray((sy * img.width + x0) * 4, (sy * img.width + x1) * 4), (y * r.w + (x0 - r.x)) * 4);
  }
  return { width: r.w, height: r.h, data: out };
}

function blit(dst: PixelImage, src: PixelImage, dx: number, dy: number) {
  for (let y = 0; y < src.height; y++) {
    dst.data.set(src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4), ((dy + y) * dst.width + dx) * 4);
  }
}

// ---------- hashing ----------

function fnv1a(bytes: ArrayLike<number>, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

/** Deterministic 32-hex id (4 independently seeded FNV-1a lanes). Not cryptographic. */
function hash128(bytes: ArrayLike<number>): string {
  return [0x811c9dc5, 0x01234567, 0x89abcdef, 0xdeadbeef].map(s => hex8(fnv1a(bytes, s))).join('');
}

const utf8 = (s: string) => new TextEncoder().encode(s);

// ---------- MaxRects ----------

/**
 * MaxRects bin packer with the Best Short Side Fit heuristic (Jukka Jylänki,
 * "A Thousand Ways to Pack the Bin"). Free space is kept as maximal, possibly
 * overlapping rectangles; each placement splits every free rect it touches.
 */
class MaxRects {
  private free: Box[];
  constructor(width: number, height: number) { this.free = [{ x: 0, y: 0, w: width, h: height }]; }

  insert(w: number, h: number): Box | null {
    let best: Box | null = null, bestShort = Infinity, bestLong = Infinity;
    for (const f of this.free) {
      if (w > f.w || h > f.h) continue;
      const lw = f.w - w, lh = f.h - h;
      const s = Math.min(lw, lh), l = Math.max(lw, lh);
      // Tie-break on position so results are stable and hug the top-left corner.
      if (s < bestShort || (s === bestShort && (l < bestLong || (l === bestLong && best && (f.y < best.y || (f.y === best.y && f.x < best.x)))))) {
        best = { x: f.x, y: f.y, w, h }; bestShort = s; bestLong = l;
      }
    }
    if (!best) return null;
    this.place(best);
    return best;
  }

  private place(used: Box) {
    const next: Box[] = [];
    for (const f of this.free) {
      if (used.x >= f.x + f.w || used.x + used.w <= f.x || used.y >= f.y + f.h || used.y + used.h <= f.y) {
        next.push(f);
        continue;
      }
      if (used.x > f.x) next.push({ x: f.x, y: f.y, w: used.x - f.x, h: f.h });
      if (used.x + used.w < f.x + f.w) next.push({ x: used.x + used.w, y: f.y, w: f.x + f.w - used.x - used.w, h: f.h });
      if (used.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: used.y - f.y });
      if (used.y + used.h < f.y + f.h) next.push({ x: f.x, y: used.y + used.h, w: f.w, h: f.y + f.h - used.y - used.h });
    }
    // Prune rects fully contained in another (keep the first of exact duplicates).
    this.free = next.filter((a, i) => !next.some((b, j) => j !== i &&
      a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h &&
      !(j > i && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)));
  }
}

const nextPow2 = (n: number) => { let p = 1; while (p < n) p *= 2; return p; };

/** Packs sizes into a bin `binW` wide and `limit` tall; returns positions or null. */
function packInto(sizes: { w: number; h: number }[], binW: number, limit: number, padding: number): Box[] | null {
  // Every rect is inflated by the padding; the bin grows by the same amount so the
  // last row/column needs no trailing gap.
  const bin = new MaxRects(binW + padding, limit + padding);
  const out: Box[] = [];
  for (const s of sizes) {
    const r = bin.insert(s.w + padding, s.h + padding);
    if (!r) return null;
    out.push({ x: r.x, y: r.y, w: s.w, h: s.h });
  }
  return out;
}

/**
 * Packs every item into one atlas page. Frames are trimmed (optional) and byte-identical
 * trimmed frames share one region. The page size is chosen by trying several widths and
 * keeping the smallest resulting area.
 */
export function packAtlas(items: AtlasItem[], opts: AtlasOptions = {}): Atlas {
  const maxSize = opts.maxSize ?? 4096;
  const padding = Math.max(0, Math.floor(opts.padding ?? 1));
  const trim = opts.trim ?? true;
  const pot = opts.powerOfTwo ?? false;

  // 1. Trim and dedupe.
  interface Unique { image: PixelImage; hash: number }
  const uniques: Unique[] = [];
  const byHash = new Map<string, number[]>();
  const refs: { key: string; unique: number; bounds: Box; sourceW: number; sourceH: number }[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.key)) throw new Error(`packAtlas: duplicate key "${it.key}"`);
    seen.add(it.key);
    const full = { x: 0, y: 0, w: it.image.width, h: it.image.height };
    const bounds = trim ? opaqueBounds(it.image) : full;
    const image = bounds === full ? it.image : crop(it.image, bounds);
    const hash = fnv1a(image.data);
    const bucket = `${image.width}x${image.height}:${hash}`;
    const candidates = byHash.get(bucket) ?? [];
    let idx = candidates.find(c => sameBytes(uniques[c].image.data, image.data));
    if (idx === undefined) {
      idx = uniques.push({ image, hash }) - 1;
      candidates.push(idx);
      byHash.set(bucket, candidates);
    }
    refs.push({ key: it.key, unique: idx, bounds, sourceW: it.image.width, sourceH: it.image.height });
  }

  // 2. Pack uniques, largest first.
  const order = uniques.map((_, i) => i).sort((a, b) => {
    const A = uniques[a].image, B = uniques[b].image;
    return Math.max(B.width, B.height) - Math.max(A.width, A.height)
      || B.width * B.height - A.width * A.height || a - b;
  });
  const sizes = order.map(i => ({ w: uniques[i].image.width, h: uniques[i].image.height }));
  const maxW = Math.max(1, ...sizes.map(s => s.w));
  const maxH = Math.max(1, ...sizes.map(s => s.h));
  if (maxW > maxSize || maxH > maxSize) {
    throw new Error(`packAtlas: a ${maxW}x${maxH} frame exceeds the ${maxSize}px atlas limit`);
  }
  const area = sizes.reduce((s, r) => s + (r.w + padding) * (r.h + padding), 0);
  const sumW = sizes.reduce((s, r) => s + r.w + padding, 0);

  const widths = new Set<number>();
  if (pot) {
    for (let w = nextPow2(maxW); w <= maxSize; w *= 2) widths.add(w);
  } else {
    const hi = Math.min(maxSize, Math.max(maxW, sumW));
    const root = Math.ceil(Math.sqrt(area));
    for (const w of [maxW, hi, root, Math.ceil(root * 1.25), Math.ceil(root * 1.5), Math.ceil(root * 2)]) widths.add(Math.min(hi, Math.max(maxW, w)));
    for (let k = 0; k <= 12; k++) widths.add(Math.round(maxW + (hi - maxW) * k / 12));
  }

  let best: { w: number; h: number; boxes: Box[] } | null = null;
  for (const bw of [...widths].sort((a, b) => a - b)) {
    const boxes = packInto(sizes, bw, maxSize, padding);
    if (!boxes) continue;
    let w = Math.max(1, ...boxes.map(b => b.x + b.w));
    let h = Math.max(1, ...boxes.map(b => b.y + b.h));
    if (pot) { w = nextPow2(w); h = nextPow2(h); }
    if (w > maxSize || h > maxSize) continue;
    if (!best || w * h < best.w * best.h || (w * h === best.w * best.h && Math.max(w, h) < Math.max(best.w, best.h))) {
      best = { w, h, boxes };
    }
  }
  if (!best) {
    throw new Error(`packAtlas: ${items.length} frames (${uniques.length} unique) do not fit in a ${maxSize}x${maxSize} atlas; reduce frames or raise maxSize`);
  }

  // 3. Compose the page and the placement table.
  const image: PixelImage = { width: best.w, height: best.h, data: new Uint8ClampedArray(best.w * best.h * 4) };
  const at: Box[] = new Array(uniques.length);
  order.forEach((u, i) => { at[u] = best!.boxes[i]; blit(image, uniques[u].image, at[u].x, at[u].y); });

  const placements: Record<string, AtlasPlacement> = {};
  for (const r of refs) {
    const b = at[r.unique];
    placements[r.key] = {
      x: b.x, y: b.y, w: b.w, h: b.h,
      trimmed: r.bounds.w !== r.sourceW || r.bounds.h !== r.sourceH,
      sourceW: r.sourceW, sourceH: r.sourceH,
      offsetX: r.bounds.x, offsetY: r.bounds.y,
    };
  }
  return { width: best.w, height: best.h, image, placements };
}

function sameBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------- asset frames ----------

export const frameKey = (asset: SpriteAsset, index: number) => `${asset.id}/${index}`;

/** Cuts every frame of `asset` out of its sheet, keyed `<asset.id>/<index>`. */
export function assetFrames(asset: SpriteAsset, sheet: PixelImage): AtlasItem[] {
  return asset.frames.map((r, i) => ({ key: frameKey(asset, i), image: crop(sheet, r) }));
}

/**
 * Asset pivot as a fraction of the untrimmed frame, top-left origin. The pivot names the
 * feet pixel, so its bottom edge (y + 1) is the anchor, matching the Godot export.
 */
function pivotFraction(asset: SpriteAsset, sourceW: number, sourceH: number) {
  return { x: asset.pivot.x / sourceW, y: (asset.pivot.y + 1) / sourceH };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// ---------- TexturePacker JSON (Hash) / Phaser 3 / PixiJS ----------

/** TexturePacker "JSON (Hash)" atlas, readable by Phaser 3 (`load.atlas`) and PixiJS (`Assets.load`). */
export function texturePackerJson(atlas: Atlas, meta: { image: string; assets: SpriteAsset[] }): string {
  const frames: Record<string, unknown> = {};
  const animations: Record<string, string[]> = {};
  for (const asset of meta.assets) {
    asset.frames.forEach((_, i) => {
      const key = frameKey(asset, i);
      const p = atlas.placements[key];
      if (!p) return;
      const pv = pivotFraction(asset, p.sourceW, p.sourceH);
      frames[key] = {
        frame: { x: p.x, y: p.y, w: p.w, h: p.h },
        rotated: false,
        trimmed: p.trimmed,
        spriteSourceSize: { x: p.offsetX, y: p.offsetY, w: p.w, h: p.h },
        sourceSize: { w: p.sourceW, h: p.sourceH },
        pivot: { x: round6(pv.x), y: round6(pv.y) },
      };
    });
    for (const a of asset.animations) {
      animations[`${asset.id}/${a.name}`] = a.frames.map(i => frameKey(asset, i)).filter(k => k in frames);
    }
  }
  return JSON.stringify({
    frames,
    animations,
    meta: {
      app: 'Kinetome', version: '1', image: meta.image, format: 'RGBA8888',
      size: { w: atlas.width, h: atlas.height }, scale: '1',
    },
  }, null, 2);
}

/** Phaser 3 animation config for `this.anims.fromJSON(...)`; frames reference the atlas loaded as `atlasKey`. */
export function phaserAnimsJson(assets: SpriteAsset[], atlasKey = 'atlas'): string {
  const anims = assets.flatMap(asset => asset.animations.map(a => ({
    key: `${asset.id}/${a.name}`,
    frameRate: a.fps,
    repeat: a.loop ? -1 : 0,
    frames: a.frames.map(i => ({ key: atlasKey, frame: frameKey(asset, i) })),
  })));
  return JSON.stringify({ anims }, null, 2);
}

// ---------- Unity ----------

/** Unity sprite names can't contain '/', so frames are named `<asset.id>_<index>`. */
export const unitySpriteName = (asset: SpriteAsset, index: number) => `${asset.id}_${index}`;

/** Stable signed 64-bit id from a name, the same shape Unity uses for sprite internalIDs. */
function internalId(name: string): string {
  const b = utf8(name);
  const v = (BigInt(fnv1a(b, 0x811c9dc5)) << 32n) | BigInt(fnv1a(b, 0x9e3779b9));
  const signed = BigInt.asIntN(64, v);
  return (signed === 0n ? 1n : signed).toString();
}

/**
 * Unity TextureImporter `.meta` for the atlas PNG: Sprite (2D and UI), Multiple sprite mode,
 * point filtering, no mipmaps, no compression, and one sprite per frame. Unity's rect origin is
 * bottom-left, so y is flipped; pivots are relative to the (trimmed) rect so every frame of an
 * asset keeps the same anchor even though Unity has no trim offsets.
 */
export function unitySpriteMeta(atlas: Atlas, assets: SpriteAsset[], opts: { guid?: string; pixelsPerUnit?: number } = {}): string {
  const guid = opts.guid ?? atlasGuid(atlas);
  const ppu = opts.pixelsPerUnit ?? 100;
  const maxTex = Math.min(16384, Math.max(32, nextPow2(Math.max(atlas.width, atlas.height))));
  const sprites: string[] = [];
  const table: string[] = [];
  for (const asset of assets) {
    asset.frames.forEach((_, i) => {
      const p = atlas.placements[frameKey(asset, i)];
      if (!p) return;
      const name = unitySpriteName(asset, i);
      const id = internalId(name);
      const px = (asset.pivot.x - p.offsetX) / p.w;
      const py = 1 - (asset.pivot.y + 1 - p.offsetY) / p.h;
      sprites.push(
        '    - serializedVersion: 2',
        `      name: ${name}`,
        '      rect:',
        '        serializedVersion: 2',
        `        x: ${p.x}`,
        `        y: ${atlas.height - p.y - p.h}`,
        `        width: ${p.w}`,
        `        height: ${p.h}`,
        '      alignment: 9',
        `      pivot: {x: ${round6(px)}, y: ${round6(py)}}`,
        '      border: {x: 0, y: 0, z: 0, w: 0}',
        '      outline: []',
        '      physicsShape: []',
        '      tessellationDetail: 0',
        '      bones: []',
        `      spriteID: ${hash128(utf8(`sprite:${name}`))}`,
        `      internalID: ${id}`,
        '      vertices: []',
        '      indices: ',
        '      edges: []',
        '      weights: []',
      );
      table.push(`      ${name}: ${id}`);
    });
  }
  return [
    'fileFormatVersion: 2',
    `guid: ${guid}`,
    'TextureImporter:',
    '  internalIDToNameTable: []',
    '  externalObjects: {}',
    '  serializedVersion: 12',
    '  mipmaps:',
    '    mipMapMode: 0',
    '    enableMipMap: 0',
    '    sRGBTexture: 1',
    '    linearTexture: 0',
    '    fadeOut: 0',
    '    borderMipMap: 0',
    '    mipMapsPreserveCoverage: 0',
    '    alphaTestReferenceValue: 0.5',
    '    mipMapFadeDistanceStart: 1',
    '    mipMapFadeDistanceEnd: 3',
    '  bumpmap:',
    '    convertToNormalMap: 0',
    '    externalNormalMap: 0',
    '    heightScale: 0.25',
    '    normalMapFilter: 0',
    '  isReadable: 0',
    '  streamingMipmaps: 0',
    '  streamingMipmapsPriority: 0',
    '  vTOnly: 0',
    '  ignoreMasterTextureLimit: 0',
    '  grayScaleToAlpha: 0',
    '  generateCubemap: 6',
    '  cubemapConvolution: 0',
    '  seamlessCubemap: 0',
    '  textureFormat: 1',
    `  maxTextureSize: ${maxTex}`,
    '  textureSettings:',
    '    serializedVersion: 2',
    '    filterMode: 0',
    '    aniso: 1',
    '    mipBias: 0',
    '    wrapU: 1',
    '    wrapV: 1',
    '    wrapW: 1',
    '  nPOTScale: 0',
    '  lightmap: 0',
    '  compressionQuality: 50',
    '  spriteMode: 2',
    '  spriteExtrude: 1',
    '  spriteMeshType: 0',
    '  alignment: 0',
    '  spritePivot: {x: 0.5, y: 0.5}',
    `  spritePixelsToUnits: ${ppu}`,
    '  spriteBorder: {x: 0, y: 0, z: 0, w: 0}',
    '  spriteGenerateFallbackPhysicsShape: 1',
    '  alphaUsage: 1',
    '  alphaIsTransparency: 1',
    '  spriteTessellationDetail: -1',
    '  textureType: 8',
    '  textureShape: 1',
    '  singleChannelComponent: 0',
    '  flipbookRows: 1',
    '  flipbookColumns: 1',
    '  maxTextureSizeSet: 0',
    '  compressionQualitySet: 0',
    '  textureFormatSet: 0',
    '  ignorePngGamma: 0',
    '  applyGammaDecoding: 0',
    '  cookieLightType: 0',
    '  platformSettings:',
    '  - serializedVersion: 3',
    '    buildTarget: DefaultTexturePlatform',
    `    maxTextureSize: ${maxTex}`,
    '    resizeAlgorithm: 0',
    '    textureFormat: -1',
    '    textureCompression: 0',
    '    compressionQuality: 50',
    '    crunchedCompression: 0',
    '    allowsAlphaSplitting: 0',
    '    overridden: 0',
    '    androidETC2FallbackOverride: 0',
    '    forceMaximumCompressionQuality_BC6H_BC7: 0',
    '  spriteSheet:',
    '    serializedVersion: 2',
    sprites.length ? '    sprites:' : '    sprites: []',
    ...sprites,
    '    outline: []',
    '    physicsShape: []',
    '    bones: []',
    '    spriteID: ',
    '    internalID: 0',
    '    vertices: []',
    '    indices: ',
    '    edges: []',
    '    weights: []',
    '    secondaryTextures: []',
    table.length ? '    nameFileIdTable:' : '    nameFileIdTable: {}',
    ...table,
    '  spritePackingTag: ',
    '  pSDRemoveMatte: 0',
    '  pSDShowRemoveMatteOption: 0',
    '  userData: ',
    '  assetBundleName: ',
    '  assetBundleVariant: ',
    '',
  ].join('\n');
}

/** Deterministic Unity guid derived from the atlas pixels and layout. */
export function atlasGuid(atlas: Atlas): string {
  const layout = utf8(JSON.stringify([atlas.width, atlas.height, Object.entries(atlas.placements).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]));
  const px = hash128(atlas.image.data);
  return hash128(utf8(px + ':' + hash128(layout)));
}

// ---------- file assembly ----------

/**
 * Builds the files for one engine from `{ asset, sheet }` pairs. All assets share one atlas page.
 *   phaser         atlas.png, atlas.json, anims.json (load with key "atlas")
 *   pixi           atlas.png, atlas.json
 *   texturepacker  atlas.png, atlas.json
 *   unity          atlas.png, atlas.png.meta
 */
export function engineExportFiles(
  assets: { asset: SpriteAsset; sheet: PixelImage }[],
  engine: ExportEngine,
  encodePng: (img: PixelImage) => Uint8Array,
  opts: AtlasOptions = {},
): { path: string; data: Uint8Array }[] {
  const atlas = packAtlas(assets.flatMap(a => assetFrames(a.asset, a.sheet)), opts);
  const list = assets.map(a => a.asset);
  const files = [{ path: 'atlas.png', data: encodePng(atlas.image) }];
  if (engine === 'unity') {
    files.push({ path: 'atlas.png.meta', data: utf8(unitySpriteMeta(atlas, list)) });
    return files;
  }
  files.push({ path: 'atlas.json', data: utf8(texturePackerJson(atlas, { image: 'atlas.png', assets: list })) });
  if (engine === 'phaser') files.push({ path: 'anims.json', data: utf8(phaserAnimsJson(list, 'atlas')) });
  return files;
}
