import type { PixelImage } from '@kinetome/core';
import { blank, celKey, tagColor, uid, type EditorDoc, type Frame, type Layer, type Tag } from './doc.ts';

/**
 * Aseprite (.ase/.aseprite) import and export, per docs/ase-file-specs.md in the Aseprite
 * repo. Export writes RGBA files with raw (uncompressed) cels, because there is no sync
 * zlib shared by the browser and Node, and Aseprite reads raw cels fine. Import handles
 * RGBA, grayscale and indexed files; compressed cels are inflated with the Web
 * DecompressionStream, which is why decoding is async.
 */

const FILE_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;
const HEADER_SIZE = 128;
const FRAME_HEADER_SIZE = 16;
const CHUNK_OLD_PALETTE = 0x0004;
const CHUNK_OLD_PALETTE_6BIT = 0x0011;
const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;
const CHUNK_TAGS = 0x2018;
const CHUNK_PALETTE = 0x2019;

const LAYER_VISIBLE = 1, LAYER_EDITABLE = 2, LAYER_BACKGROUND = 8;
/** Header flag: the layer opacity byte is meaningful. */
const HEADER_LAYER_OPACITY = 1, HEADER_GROUP_OPACITY = 2;

// ---------- byte writing ----------

/** Little-endian growable byte buffer. */
class Writer {
  buf = new Uint8Array(1024);
  len = 0;
  private grow(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v: number) { this.grow(1); this.buf[this.len++] = v & 255; }
  u16(v: number) { this.u8(v); this.u8(v >> 8); }
  u32(v: number) { this.u16(v & 0xffff); this.u16(v >>> 16); }
  zeros(n: number) { this.grow(n); this.len += n; }
  bytes(b: Uint8Array) { this.grow(b.length); this.buf.set(b, this.len); this.len += b.length; }
  str(s: string) { const b = new TextEncoder().encode(s); this.u16(b.length); this.bytes(b); }
  patchU32(at: number, v: number) { new DataView(this.buf.buffer).setUint32(at, v >>> 0, true); }
  result() { return this.buf.slice(0, this.len); }
}

/** Writes one chunk: size (incl. its 6-byte header), type, body. */
function chunk(w: Writer, type: number, body: (w: Writer) => void) {
  const start = w.len;
  w.u32(0); w.u16(type);
  body(w);
  w.patchU32(start, w.len - start);
}

function parseHex(hex: string): [number, number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) || 0;
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 255];
}

const toHex = (r: number, g: number, b: number) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

/** Opaque bounding box of a cel, or null when it is fully transparent. */
function opaqueBounds(img: PixelImage): { x: number; y: number; w: number; h: number } | null {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!img.data[(y * img.width + x) * 4 + 3]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function writeHeader(w: Writer, doc: EditorDoc) {
  w.u32(0);                                   // file size, patched at the end
  w.u16(FILE_MAGIC);
  w.u16(doc.frames.length);
  w.u16(doc.width); w.u16(doc.height);
  w.u16(32);                                  // RGBA
  w.u32(HEADER_LAYER_OPACITY);
  w.u16(clampDuration(doc.frames[0]?.duration ?? 100)); // deprecated speed
  w.u32(0); w.u32(0);
  w.u8(0);                                    // transparent index (indexed only)
  w.zeros(3);
  w.u16(Math.min(256, doc.palette.length));  // 0 means 256
  w.u8(1); w.u8(1);                           // pixel ratio 1:1
  w.u16(0); w.u16(0); w.u16(16); w.u16(16);   // grid x, y, w, h (Aseprite's default)
  w.zeros(84);
}

const clampDuration = (ms: number) => Math.max(1, Math.min(0xffff, Math.round(ms)));

function writeLayer(w: Writer, layer: Layer) {
  chunk(w, CHUNK_LAYER, w => {
    w.u16((layer.visible ? LAYER_VISIBLE : 0) | (layer.locked ? 0 : LAYER_EDITABLE));
    w.u16(0);                                 // normal image layer
    w.u16(0);                                 // child level
    w.u16(0); w.u16(0);                       // default size (ignored)
    w.u16(0);                                 // blend: normal
    w.u8(Math.round(Math.max(0, Math.min(1, layer.opacity)) * 255));
    w.zeros(3);
    w.str(layer.name);
  });
}

function writeTags(w: Writer, tags: Tag[]) {
  chunk(w, CHUNK_TAGS, w => {
    w.u16(tags.length);
    w.zeros(8);
    for (const t of tags) {
      w.u16(t.from); w.u16(t.to);
      w.u8(0);                                // forward
      w.u16(t.loop ? 0 : 1);                  // repeat: 0 = forever
      w.zeros(6);
      const [r, g, b] = parseHex(t.color);    // deprecated tag color, still read by Aseprite
      w.u8(r); w.u8(g); w.u8(b); w.u8(0);
      w.str(t.name);
    }
  });
}

function writePalette(w: Writer, palette: string[]) {
  const colors = palette.slice(0, 256);
  chunk(w, CHUNK_PALETTE, w => {
    w.u32(colors.length); w.u32(0); w.u32(colors.length - 1);
    w.zeros(8);
    for (const c of colors) { w.u16(0); for (const v of parseHex(c)) w.u8(v); }
  });
}

/** Raw (type 0) cel cropped to its opaque bounds; empty cels are not written. */
function writeCel(w: Writer, layerIndex: number, img: PixelImage) {
  const box = opaqueBounds(img);
  if (!box) return false;
  chunk(w, CHUNK_CEL, w => {
    w.u16(layerIndex);
    w.u16(box.x); w.u16(box.y);
    w.u8(255);                                // cel opacity
    w.u16(0);                                 // raw
    w.u16(0);                                 // z-index
    w.zeros(5);
    w.u16(box.w); w.u16(box.h);
    for (let y = box.y; y < box.y + box.h; y++) {
      const i = (y * img.width + box.x) * 4;
      w.bytes(new Uint8Array(img.data.buffer, img.data.byteOffset + i, box.w * 4));
    }
  });
  return true;
}

/** Encodes a document as an RGBA .aseprite file. */
export function encodeAse(doc: EditorDoc): Uint8Array {
  const w = new Writer();
  writeHeader(w, doc);
  doc.frames.forEach((frame, fi) => {
    const start = w.len;
    w.u32(0); w.u16(FRAME_MAGIC);
    const countAt = w.len;
    w.u16(0); w.u16(clampDuration(frame.duration)); w.zeros(2); w.u32(0);
    let chunks = 0;
    if (fi === 0) {
      if (doc.palette.length) { writePalette(w, doc.palette); chunks++; }
      for (const l of doc.layers) { writeLayer(w, l); chunks++; }
      if (doc.tags.length) { writeTags(w, doc.tags); chunks++; }
    }
    doc.layers.forEach((l, li) => {
      const cel = doc.cels[celKey(l.id, frame.id)];
      if (cel && writeCel(w, li, cel)) chunks++;
    });
    w.patchU32(start, w.len - start);
    const view = new DataView(w.buf.buffer);
    view.setUint16(countAt, Math.min(chunks, 0xffff), true);
    view.setUint32(countAt + 6, chunks, true);
  });
  w.patchU32(0, w.len);
  return w.result();
}

// ---------- reading ----------

/** Little-endian cursor over the file bytes. */
class Reader {
  private view: DataView;
  constructor(readonly bytes: Uint8Array, public pos = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8() { return this.view.getUint8(this.pos++); }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  skip(n: number) { this.pos += n; }
  take(n: number) { const b = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  str() { return new TextDecoder().decode(this.take(this.u16())); }
}

/** Inflates zlib data (the 'deflate' format of DecompressionStream is zlib-wrapped). */
async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface RawLayer { type: number; flags: number; level: number; opacity: number; name: string }
interface Ctx { depth: number; transparent: number; flags: number; palette: [number, number, number, number][] }

/** Converts cel pixels in the file's color depth to RGBA, applying the cel opacity. */
function toRgba(ctx: Ctx, src: Uint8Array, count: number, opacity: number, background: boolean): Uint8ClampedArray {
  const out = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    let r: number, g: number, b: number, a: number;
    if (ctx.depth === 32) { r = src[i * 4]; g = src[i * 4 + 1]; b = src[i * 4 + 2]; a = src[i * 4 + 3]; }
    else if (ctx.depth === 16) { r = g = b = src[i * 2]; a = src[i * 2 + 1]; }
    else {
      const idx = src[i];
      [r, g, b, a] = ctx.palette[idx] ?? [0, 0, 0, 255];
      if (idx === ctx.transparent && !background) a = 0;
    }
    out.set([r, g, b, Math.round((a * opacity) / 255)], i * 4);
  }
  return out;
}

function readPalette(r: Reader, end: number, ctx: Ctx) {
  const size = r.u32(), first = r.u32(), last = r.u32();
  r.skip(8);
  ctx.palette.length = Math.max(ctx.palette.length, size);
  for (let i = first; i <= last && r.pos < end; i++) {
    const flags = r.u16();
    ctx.palette[i] = [r.u8(), r.u8(), r.u8(), r.u8()];
    if (flags & 1) r.str();
  }
}

/** Old palette chunks (0x0004, 0x0011 with 6-bit channels), used only if no new palette exists. */
function readOldPalette(r: Reader, ctx: Ctx, sixBit: boolean) {
  const scale = (v: number) => (sixBit ? Math.round((v * 255) / 63) : v);
  let idx = 0;
  for (let p = r.u16(); p > 0; p--) {
    idx += r.u8();
    const n = r.u8() || 256;
    for (let k = 0; k < n; k++) ctx.palette[idx++] = [scale(r.u8()), scale(r.u8()), scale(r.u8()), 255];
  }
}

/** Reads up to the name; a tileset index or UUID after it is skipped by the chunk walk. */
function readLayer(r: Reader, ctx: Ctx): RawLayer {
  const flags = r.u16(), type = r.u16(), level = r.u16();
  r.skip(6);                                  // default size, blend mode
  const opacity = r.u8();
  r.skip(3);
  const name = r.str();
  return { type, flags, level, opacity: ctx.flags & HEADER_LAYER_OPACITY ? opacity : 255, name };
}

function readTags(r: Reader): Tag[] {
  const n = r.u16();
  r.skip(8);
  const tags: Tag[] = [];
  for (let i = 0; i < n; i++) {
    const from = r.u16(), to = r.u16();
    r.skip(1);                                // direction (playback is always forward here)
    const repeat = r.u16();
    r.skip(6);
    const rgb = [r.u8(), r.u8(), r.u8()];
    r.skip(1);
    const name = r.str();
    const color = rgb.some(v => v) ? toHex(rgb[0], rgb[1], rgb[2]) : tagColor(i);
    tags.push({ id: uid('t'), name, from, to, loop: repeat === 0, color });
  }
  return tags;
}

/**
 * Turns the flat layer list into doc layers: only normal image layers survive, while
 * group layers pass their visibility (and opacity, when the header says it is valid)
 * down to their children.
 */
function buildLayers(raw: RawLayer[], ctx: Ctx): { layers: Layer[]; byIndex: Map<number, { id: string; background: boolean }> } {
  const layers: Layer[] = [];
  const byIndex = new Map<number, { id: string; background: boolean }>();
  const groups: RawLayer[] = [];
  raw.forEach((l, i) => {
    groups.length = l.level;
    const parents = groups.filter(Boolean);
    if (l.type === 1) { groups[l.level] = l; return; }
    if (l.type !== 0) return;
    const visible = !!(l.flags & LAYER_VISIBLE) && parents.every(g => g.flags & LAYER_VISIBLE);
    let opacity = l.opacity / 255;
    if (ctx.flags & HEADER_GROUP_OPACITY) for (const g of parents) opacity *= g.opacity / 255;
    const layer: Layer = { id: uid('l'), name: l.name, visible, locked: !(l.flags & LAYER_EDITABLE), opacity };
    layers.push(layer);
    byIndex.set(i, { id: layer.id, background: !!(l.flags & LAYER_BACKGROUND) });
  });
  return { layers, byIndex };
}

interface RawCel { layer: number; x: number; y: number; opacity: number; type: number; w: number; h: number; data?: Uint8Array; link?: number }

function readCel(r: Reader, end: number): RawCel {
  const layer = r.u16(), x = r.i16(), y = r.i16(), opacity = r.u8(), type = r.u16();
  r.skip(7);                                  // z-index, reserved
  const cel: RawCel = { layer, x, y, opacity, type, w: 0, h: 0 };
  if (type === 1) cel.link = r.u16();
  else if (type === 0 || type === 2) { cel.w = r.u16(); cel.h = r.u16(); cel.data = r.take(end - r.pos); }
  return cel;
}

/** Places a cel's pixels at x,y on a full-canvas image, clipping to the canvas. */
async function celImage(cel: RawCel, ctx: Ctx, width: number, height: number, background: boolean): Promise<PixelImage> {
  const raw = cel.type === 2 ? await inflateZlib(cel.data!) : cel.data!;
  const px = toRgba(ctx, raw, cel.w * cel.h, cel.opacity, background);
  const img = blank(width, height);
  for (let y = 0; y < cel.h; y++) {
    const ty = cel.y + y;
    if (ty < 0 || ty >= height) continue;
    for (let x = 0; x < cel.w; x++) {
      const tx = cel.x + x;
      if (tx < 0 || tx >= width) continue;
      const s = (y * cel.w + x) * 4, d = (ty * width + tx) * 4;
      img.data.set(px.subarray(s, s + 4), d);
    }
  }
  return img;
}

/** Decodes an .ase/.aseprite file into an editor document. */
export async function decodeAse(bytes: Uint8Array, name = 'aseprite'): Promise<EditorDoc> {
  const r = new Reader(bytes);
  r.skip(4);
  if (r.u16() !== FILE_MAGIC) throw new Error('not an Aseprite file');
  const frameCount = r.u16(), width = r.u16(), height = r.u16(), depth = r.u16(), flags = r.u32();
  if (![8, 16, 32].includes(depth)) throw new Error(`unsupported color depth ${depth}`);
  r.skip(2 + 8);
  const ctx: Ctx = { depth, flags, transparent: r.u8(), palette: [] };
  r.pos = HEADER_SIZE;

  const frames: Frame[] = [];
  const rawLayers: RawLayer[] = [];
  const celsPerFrame: RawCel[][] = [];
  let tags: Tag[] = [];
  let newPalette = false;
  for (let f = 0; f < frameCount; f++) {
    const start = r.pos, size = r.u32();
    if (r.u16() !== FRAME_MAGIC) throw new Error(`bad frame ${f}`);
    r.skip(2);
    const duration = r.u16();
    r.pos = start + FRAME_HEADER_SIZE;
    frames.push({ id: uid('f'), duration });
    const cels: RawCel[] = [];
    // walk chunks by byte length, which avoids the old/new chunk-count ambiguity
    while (r.pos + 6 <= start + size) {
      const cStart = r.pos, cSize = r.u32(), type = r.u16(), end = cStart + cSize;
      if (cSize < 6) break;
      if (type === CHUNK_LAYER) rawLayers.push(readLayer(r, ctx));
      else if (type === CHUNK_CEL) cels.push(readCel(r, end));
      else if (type === CHUNK_TAGS) tags = readTags(r);
      else if (type === CHUNK_PALETTE) { if (!newPalette) ctx.palette = []; newPalette = true; readPalette(r, end, ctx); }
      else if ((type === CHUNK_OLD_PALETTE || type === CHUNK_OLD_PALETTE_6BIT) && !newPalette) readOldPalette(r, ctx, type === CHUNK_OLD_PALETTE_6BIT);
      r.pos = end;
    }
    celsPerFrame.push(cels);
    r.pos = start + size;
  }
  const { layers, byIndex } = buildLayers(rawLayers, ctx);
  const doc: EditorDoc = {
    width, height, name, layers, frames, cels: {}, tags,
    palette: ctx.palette.slice(0, 256).map(c => toHex(...((c ?? [0, 0, 0]).slice(0, 3) as [number, number, number]))),
    pivot: { x: Math.floor(width / 2), y: height - 1 },
  };
  for (let f = 0; f < frames.length; f++) {
    for (const cel of celsPerFrame[f]) {
      const target = byIndex.get(cel.layer);
      if (!target) continue;                  // group, tilemap or unknown layer
      if (cel.type === 1) {
        const linked = frames[cel.link!] && doc.cels[celKey(target.id, frames[cel.link!].id)];
        if (linked) doc.cels[celKey(target.id, frames[f].id)] = linked;
      } else if (cel.type === 0 || cel.type === 2) {
        doc.cels[celKey(target.id, frames[f].id)] = await celImage(cel, ctx, width, height, target.background);
      }                                       // type 3 (tilemap) is skipped
    }
  }
  return doc;
}
