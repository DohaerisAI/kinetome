import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import type { PixelImage } from '@kinetome/core';
import { addFrame, addLayer, addTag, blank, celKey, createDoc, patchLayer, setDurations, withCel, type EditorDoc } from './index.ts';
import { decodeAse, encodeAse } from './aseprite.ts';

const px = (img: PixelImage, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const put = (img: PixelImage, x: number, y: number, c: number[]) => img.data.set(c, (y * img.width + x) * 4);

function sampleDoc(): EditorDoc {
  let doc = createDoc(8, 6, 1, 'hero');
  doc = addFrame(doc, 0).doc;
  doc = addFrame(doc, 1).doc;
  doc = setDurations(doc, [0], 80);
  doc = setDurations(doc, [1], 120);
  doc = setDurations(doc, [2], 250);
  const base = doc.layers[0].id;
  const r = addLayer(doc, base, 'Shadow');
  doc = patchLayer(r.doc, r.id, { opacity: 0.5, visible: false });
  const a = blank(8, 6); put(a, 1, 1, [255, 0, 0, 255]); put(a, 6, 4, [0, 128, 255, 100]);
  const b = blank(8, 6); put(b, 0, 0, [10, 20, 30, 255]); put(b, 7, 5, [40, 50, 60, 255]);
  const c = blank(8, 6); put(c, 3, 2, [1, 2, 3, 4]);
  doc = withCel(doc, base, doc.frames[0].id, a);
  doc = withCel(doc, base, doc.frames[2].id, b);
  doc = withCel(doc, r.id, doc.frames[1].id, c);
  doc = withCel(doc, r.id, doc.frames[2].id, blank(8, 6)); // empty cel is dropped
  doc = addTag(doc, 'idle', 0, 1, true);
  doc = addTag(doc, 'hit', 2, 2, false);
  return { ...doc, palette: ['#ff0000', '#0080ff', '#0a141e'] };
}

test('aseprite round trip keeps layers, frames, cels, tags and palette', async () => {
  const src = sampleDoc();
  const doc = await decodeAse(encodeAse(src));
  assert.equal(doc.width, 8);
  assert.equal(doc.height, 6);
  assert.equal(doc.name, 'aseprite');
  assert.deepEqual(doc.pivot, { x: 4, y: 5 });
  assert.deepEqual(doc.layers.map(l => [l.name, l.visible, Math.round(l.opacity * 255)]), [['Layer 1', true, 255], ['Shadow', false, 128]]);
  assert.deepEqual(doc.frames.map(f => f.duration), [80, 120, 250]);
  for (let li = 0; li < 2; li++) for (let fi = 0; fi < 3; fi++) {
    const want = src.cels[celKey(src.layers[li].id, src.frames[fi].id)];
    const got = doc.cels[celKey(doc.layers[li].id, doc.frames[fi].id)];
    const empty = !want || want.data.every(v => v === 0);
    if (empty) { assert.equal(got, undefined, `cel ${li}/${fi} empty`); continue; }
    assert.ok(got, `cel ${li}/${fi} present`);
    assert.deepEqual([...got.data], [...want.data], `cel ${li}/${fi} pixels`);
  }
  assert.deepEqual(doc.tags.map(({ name, from, to, loop, color }) => ({ name, from, to, loop, color })),
    src.tags.map(({ name, from, to, loop, color }) => ({ name, from, to, loop, color })));
  assert.deepEqual(doc.palette, src.palette);
});

test('aseprite header and frame magic numbers', () => {
  const src = sampleDoc();
  const bytes = encodeAse(src);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(v.getUint32(0, true), bytes.length);
  assert.equal(v.getUint16(4, true), 0xa5e0);
  assert.equal(v.getUint16(6, true), 3);
  assert.equal(v.getUint16(12, true), 32);
  assert.equal(v.getUint8(34), 1, 'pixel ratio 1:1');
  let at = 128;
  for (let f = 0; f < 3; f++) {
    assert.equal(v.getUint16(at + 4, true), 0xf1fa, `frame ${f} magic`);
    at += v.getUint32(at, true);
  }
  assert.equal(at, bytes.length);
});

// ---------- hand-built files ----------

/** Minimal little-endian writer for building test files by hand. */
class B {
  out: number[] = [];
  u8(...v: number[]) { for (const x of v) this.out.push(x & 255); return this; }
  u16(...v: number[]) { for (const x of v) this.u8(x, x >> 8); return this; }
  u32(v: number) { return this.u16(v & 0xffff, v >>> 16); }
  z(n: number) { return this.u8(...new Array(n).fill(0)); }
  str(s: string) { const b = Buffer.from(s); return this.u16(b.length).u8(...b); }
  bytes(b: Uint8Array) { return this.u8(...b); }
}

const chunkBytes = (type: number, body: B) => new B().u32(body.out.length + 6).u16(type).u8(...body.out).out;
const layerChunk = (name: string, type = 0, level = 0, flags = 3, opacity = 255) =>
  chunkBytes(0x2004, new B().u16(flags, type, level, 0, 0, 0).u8(opacity).z(3).str(name));
const celHead = (layer: number, x: number, y: number, type: number, opacity = 255) =>
  new B().u16(layer, x, y).u8(opacity).u16(type, 0).z(5);

function file(w: number, h: number, depth: number, frames: { duration: number; chunks: number[][] }[], transparent = 0): Uint8Array {
  const body: number[] = [];
  for (const f of frames) {
    const data = f.chunks.flat();
    body.push(...new B().u32(data.length + 16).u16(0xf1fa, f.chunks.length, f.duration).z(2).u32(f.chunks.length).out, ...data);
  }
  const head = new B().u32(128 + body.length).u16(0xa5e0, frames.length, w, h, depth).u32(1).u16(100).u32(0).u32(0)
    .u8(transparent).z(3).u16(0).u8(1, 1).u16(0, 0, 16, 16).z(84);
  assert.equal(head.out.length, 128);
  return new Uint8Array([...head.out, ...body]);
}

test('aseprite decodes zlib cels, linked cels and skips group layers', async () => {
  // 2x1 RGBA cel at (1,1): red, half-transparent green
  const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]);
  const zcel = chunkBytes(0x2005, celHead(1, 1, 1, 2, 128).u16(2, 1).bytes(deflateSync(pixels)));
  const link = chunkBytes(0x2005, celHead(1, 0, 0, 1).u16(0));
  const bytes = file(4, 3, 32, [
    { duration: 50, chunks: [layerChunk('Group', 1, 0, 1), layerChunk('Body', 0, 1, 3, 200), zcel] },
    { duration: 70, chunks: [link] },
  ]);
  const doc = await decodeAse(bytes, 'test');
  assert.equal(doc.name, 'test');
  assert.deepEqual(doc.layers.map(l => [l.name, l.visible, Math.round(l.opacity * 255)]), [['Body', true, 200]]);
  assert.deepEqual(doc.frames.map(f => f.duration), [50, 70]);
  const cel = doc.cels[celKey(doc.layers[0].id, doc.frames[0].id)];
  assert.deepEqual(px(cel, 1, 1), [255, 0, 0, 128], 'cel opacity multiplied into alpha');
  assert.deepEqual(px(cel, 2, 1), [0, 255, 0, 64]);
  assert.deepEqual(px(cel, 0, 0), [0, 0, 0, 0]);
  assert.equal(doc.cels[celKey(doc.layers[0].id, doc.frames[1].id)], cel, 'linked cel reuses frame 0');
});

test('aseprite decodes indexed files with palette and transparent index', async () => {
  const palette = chunkBytes(0x2019, new B().u32(3).u32(0).u32(2).z(8)
    .u16(0).u8(0, 0, 0, 255).u16(0).u8(255, 255, 0, 255).u16(1).u8(0, 0, 255, 255).str('blue'));
  const cel = chunkBytes(0x2005, celHead(0, 0, 0, 0).u16(3, 1).u8(1, 0, 2));
  const tags = chunkBytes(0x2018, new B().u16(1).z(8).u16(0, 0).u8(0).u16(2).z(6).u8(0, 0, 0, 0).str('walk'));
  const doc = await decodeAse(file(3, 2, 8, [{ duration: 100, chunks: [palette, layerChunk('Ink'), tags, cel] }], 0));
  assert.deepEqual(doc.palette, ['#000000', '#ffff00', '#0000ff']);
  const img = doc.cels[celKey(doc.layers[0].id, doc.frames[0].id)];
  assert.deepEqual(px(img, 0, 0), [255, 255, 0, 255]);
  assert.equal(px(img, 1, 0)[3], 0, 'transparent index');
  assert.deepEqual(px(img, 2, 0), [0, 0, 255, 255]);
  assert.deepEqual(doc.tags.map(t => [t.name, t.from, t.to, t.loop]), [['walk', 0, 0, false]]);
  assert.match(doc.tags[0].color, /^#[0-9a-f]{6}$/);
});

test('aseprite decodes grayscale files', async () => {
  const cel = chunkBytes(0x2005, celHead(0, 0, 0, 0).u16(2, 1).u8(200, 255, 50, 10));
  const doc = await decodeAse(file(2, 1, 16, [{ duration: 100, chunks: [layerChunk('G'), cel] }]));
  const img = doc.cels[celKey(doc.layers[0].id, doc.frames[0].id)];
  assert.deepEqual(px(img, 0, 0), [200, 200, 200, 255]);
  assert.deepEqual(px(img, 1, 0), [50, 50, 50, 10]);
});
