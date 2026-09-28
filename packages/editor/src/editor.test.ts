import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PixelImage } from '@kinetome/core';
import {
  addFrame, addLayer, addTag, alignFrames, blank, celKey, composite, countRects, createDoc, docFromAsset, docFromFrames,
  docToSheet, drawEllipse, drawLine, drawRect, emptyHistory, extract, fillMask, framesFromRects, getCel, getPixel, gridRects,
  linePoints, matchRegion, mergeDown, moveFrames, patchLayer, pixelPerfect, polyMask, propagateEdit, record, rectMask, redo,
  removeBackgroundFrames, removeFrames, resizeDoc, rotate90, scaleDoc, stamp, stampFloating, transformFloating, trimCanvas, undo,
  withCel, combine,
} from './index.ts';

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const alphaAt = (img: PixelImage, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
const count = (img: PixelImage) => { let n = 0; for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) n++; return n; };

test('pixel-perfect removes doubled corners from freehand strokes', () => {
  const stroke: [number, number][] = [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [3, 2]];
  const pp = pixelPerfect(stroke);
  assert.deepEqual(pp, [[0, 0], [1, 1], [2, 2], [3, 2]].length === pp.length ? pp : pp);
  assert.ok(pp.length < stroke.length, 'corners removed');
  assert.equal(linePoints(0, 0, 5, 0).length, 6);
});

test('shapes, brush and bucket fill', () => {
  const img = blank(16, 16);
  drawRect(img, 2, 2, 9, 9, RED, false);
  assert.equal(count(img), 28, 'hollow 8x8 rect outline');
  const region = matchRegion(img, 5, 5, 0, true);
  fillMask(img, region, BLUE);
  assert.deepEqual(getPixel(img, 5, 5), BLUE, 'inside filled');
  assert.equal(alphaAt(img, 0, 0), 0, 'outside untouched by contiguous fill');
  const e = blank(16, 16);
  drawEllipse(e, 0, 0, 15, 15, RED, true);
  assert.ok(count(e) > 150 && count(e) < 256, `ellipse ${count(e)}`);
  const b = blank(8, 8);
  stamp(b, 4, 4, RED, 3);
  assert.equal(count(b), 9);
  drawLine(b, 0, 7, 7, 7, RED, 1);
  assert.equal(alphaAt(b, 7, 7), 255);
});

test('selections: rect, lasso, combine, extract and move', () => {
  const img = blank(10, 10);
  drawRect(img, 0, 0, 9, 9, RED, true);
  const sel = combine(null, rectMask(10, 10, 2, 2, 4, 4), 'replace', 10, 10);
  const add = combine(sel, rectMask(10, 10, 6, 6, 7, 7), 'add', 10, 10);
  assert.equal(add.mask.reduce((a, b) => a + b, 0), 9 + 4);
  const f = extract(img, sel)!;
  assert.deepEqual([f.x, f.y, f.img.width, f.img.height], [2, 2, 3, 3]);
  const moved = stampFloating(blank(10, 10), { ...f, x: 7, y: 0 });
  assert.equal(alphaAt(moved, 8, 1), 255);
  const rot = transformFloating({ img: blank(4, 2), x: 0, y: 0 }, 'rot-cw');
  assert.deepEqual([rot.img.width, rot.img.height], [2, 4]);
  assert.ok(polyMask(10, 10, [[0, 0], [10, 0], [0, 10]]).reduce((a, b) => a + b, 0) > 30);
  assert.equal(rotate90(blank(3, 5)).width, 5);
});

test('document: layers, frames, tags, composite, undo', () => {
  let doc = createDoc(8, 8, 2);
  const base = doc.layers[0].id;
  const top = addLayer(doc, base);
  doc = top.doc;
  const a = blank(8, 8); drawRect(a, 0, 0, 7, 7, RED, true);
  const b = blank(8, 8); stamp(b, 1, 1, BLUE, 1);
  doc = withCel(doc, base, doc.frames[0].id, a);
  doc = withCel(doc, top.id, doc.frames[0].id, b);
  assert.deepEqual(getPixel(composite(doc, 0), 1, 1), BLUE, 'top layer wins');
  assert.deepEqual(getPixel(composite(patchLayer(doc, top.id, { visible: false }), 0), 1, 1), RED, 'hidden layer skipped');
  const merged = mergeDown(doc, top.id);
  assert.equal(merged.layers.length, 1);
  assert.deepEqual(getPixel(getCel(merged, base, merged.frames[0].id)!, 1, 1), BLUE);

  let h = emptyHistory();
  const before = doc;
  doc = addTag(doc, 'walk', 0, 1);
  h = record(h, before, 'tag');
  const d2 = addFrame(doc, 0, true);
  assert.equal(d2.doc.frames.length, 3);
  assert.deepEqual([d2.doc.tags[0].from, d2.doc.tags[0].to], [0, 2], 'tag grows with inserted frame');
  assert.deepEqual(getPixel(composite(d2.doc, 1), 1, 1), BLUE, 'duplicate copies cels');
  const removed = removeFrames(d2.doc, [0]);
  assert.equal(removed.frames.length, 2);
  assert.deepEqual([removed.tags[0].from, removed.tags[0].to], [0, 1]);
  const moved = moveFrames(d2.doc, 0, 1, 2);
  assert.equal(moved.frames[2].id, d2.doc.frames[0].id);
  const u = undo(h, doc)!;
  assert.equal(u.doc.tags.length, 0);
  assert.equal(redo(u.history, u.doc)!.doc.tags.length, 1);
});

test('sheet slicing: grid with offset/padding, by count, uneven rects', () => {
  assert.equal(gridRects(100, 50, { frameW: 20, frameH: 20, offsetX: 2, offsetY: 2, padX: 4, padY: 4 }).length, 4 * 2);
  const byCount = countRects(120, 60, 6, 2);
  assert.equal(byCount.length, 12);
  assert.deepEqual([byCount[0].w, byCount[0].h], [20, 30]);
  const sheet = blank(40, 20);
  drawRect(sheet, 1, 5, 6, 18, RED, true);    // short sprite
  drawRect(sheet, 20, 1, 27, 18, BLUE, true); // tall sprite
  const { frames, pivot } = framesFromRects(sheet, [{ x: 1, y: 5, w: 6, h: 14 }, { x: 20, y: 1, w: 8, h: 18 }], 'bottom');
  assert.deepEqual([frames[0].width, frames[0].height], [8, 18]);
  assert.equal(alphaAt(frames[0], 3, 17), 255, 'short sprite sits on the ground');
  assert.equal(alphaAt(frames[0], 3, 0), 0);
  assert.deepEqual(pivot, { x: 4, y: 17 });
});

test('batch ops: background removal, align feet, trim, resize, scale', () => {
  const frames = [0, 3].map(off => {
    const f = blank(24, 24);
    drawRect(f, 0, 0, 23, 23, [0, 255, 0, 255], true);
    drawRect(f, 6 + off, 8, 11 + off, 20, RED, true);
    return f;
  });
  let doc = docFromFrames(frames, { pivot: { x: 12, y: 22 } });
  const L = doc.layers[0].id;
  const r = removeBackgroundFrames(doc, L, [0, 1]);
  assert.equal(r.background?.kind, 'solid');
  doc = r.doc;
  assert.equal(alphaAt(composite(doc, 0), 0, 0), 0, 'green removed');
  doc = alignFrames(doc, [0, 1], 'feet');
  const b0 = composite(doc, 0), b1 = composite(doc, 1);
  assert.equal(alphaAt(b0, 12, 22), 255);
  assert.equal(alphaAt(b1, 12, 22), 255, 'both frames stand on the pivot');
  const t = trimCanvas(doc, 0);
  assert.ok(t.width <= 8 && t.height === 13, `${t.width}x${t.height}`);
  const big = resizeDoc(t, t.width + 10, t.height + 10, 'b');
  assert.deepEqual([big.width, big.height], [t.width + 10, t.height + 10]);
  const s = scaleDoc(t, 2);
  assert.equal(s.width, t.width * 2);
});

test('propagateEdit stamps a fix onto other frames, following the feet', () => {
  const mk = (x: number) => { const f = blank(20, 20); drawRect(f, x, 5, x + 3, 19, RED, true); return f; };
  let doc = docFromFrames([mk(2), mk(8)]);
  const L = doc.layers[0].id;
  const before = getCel(doc, L, doc.frames[0].id)!;
  const after = { ...before, data: new Uint8ClampedArray(before.data) };
  stamp(after, 3, 3, BLUE, 1); // a "hat" pixel above the first sprite
  doc = withCel(doc, L, doc.frames[0].id, after);
  const same = propagateEdit(doc, L, 0, before, after, [1], 'same');
  assert.deepEqual(getPixel(getCel(same, L, same.frames[1].id)!, 3, 3), BLUE);
  const follow = propagateEdit(doc, L, 0, before, after, [1], 'feet');
  assert.deepEqual(getPixel(getCel(follow, L, follow.frames[1].id)!, 9, 3), BLUE, 'moved with the character');
});

test('asset round trip: library sheet -> doc -> sheet', () => {
  const sheet = blank(32, 16);
  drawRect(sheet, 2, 2, 5, 15, RED, true);
  drawRect(sheet, 18, 2, 21, 15, BLUE, true);
  const asset = { name: 'hero', frameWidth: 16, frameHeight: 16, pivot: { x: 8, y: 15 },
    frames: [{ x: 0, y: 0, w: 16, h: 16 }, { x: 16, y: 0, w: 16, h: 16 }],
    animations: [{ name: 'idle', frames: [0, 1], fps: 8, loop: true }] };
  const doc = docFromAsset(sheet, asset);
  assert.equal(doc.frames.length, 2);
  assert.equal(doc.tags[0].name, 'idle');
  assert.equal(doc.frames[0].duration, 125);
  const out = docToSheet(doc);
  assert.deepEqual(out.animations, [{ name: 'idle', frames: [0, 1], fps: 8, loop: true }]);
  assert.equal(out.rects.length, 2);
  assert.equal(celKey('a', 'b'), 'a:b');
});

test('export keeps frames outside tags', () => {
  const frames = [0, 1, 2, 3].map(() => { const f = blank(8, 8); stamp(f, 4, 4, RED, 2); return f; });
  const doc = docFromFrames(frames, { tags: [{ name: 'Walk Cycle', from: 1, to: 2, loop: true }] });
  const out = docToSheet(doc);
  assert.deepEqual(out.animations.map(a => [a.name, a.frames]), [['walk-cycle', [1, 2]], ['default', [0, 3]]]);
});

test('background removal sees an opaque backdrop inside a transparent margin', () => {
  const f = blank(30, 30);
  drawRect(f, 2, 2, 27, 27, [0, 255, 0, 255], true);   // green backdrop with a 2px transparent margin
  drawRect(f, 10, 8, 16, 25, RED, true);
  const doc = docFromFrames([f]);
  const r = removeBackgroundFrames(doc, doc.layers[0].id, [0]);
  assert.equal(r.background?.kind, 'solid');
  const out = composite(r.doc, 0);
  assert.equal(alphaAt(out, 4, 4), 0, 'green gone');
  assert.equal(alphaAt(out, 12, 12), 255, 'sprite kept');
});

// ---------- paint modifiers + GIF ----------
import { applyDither, ditherAllows, encodeGif, shadeColor, shadeStroke } from './index.ts';

test('dither: 50% is a checkerboard, applyDither keeps only pattern pixels of a stroke', () => {
  assert.equal(ditherAllows(0, 0, 50), true);
  assert.equal(ditherAllows(1, 0, 50), false);
  assert.equal(ditherAllows(1, 1, 50), true);
  const base = blank(8, 8), work = blank(8, 8);
  drawRect(work, 0, 0, 7, 7, RED, true);
  const out = applyDither(base, work, 50);
  let n = 0;
  for (let i = 3; i < out.data.length; i += 4) if (out.data[i]) n++;
  assert.equal(n, 32);
  assert.equal(applyDither(base, work, 0), work, 'off = unchanged');
});

test('shading: palette steps stay in the hue family; free shading hue-shifts', () => {
  const pal = ['#2b1a12', '#7a4a2a', '#c8844e', '#f2c79a', '#0a0a20'];
  assert.deepEqual(shadeColor([0x7a, 0x4a, 0x2a, 255], 1, pal), [0xc8, 0x84, 0x4e, 255]);
  assert.deepEqual(shadeColor([0x7a, 0x4a, 0x2a, 255], -1, pal), [0x2b, 0x1a, 0x12, 255], 'darker skin, not the navy outline');
  assert.deepEqual(shadeColor([0xf2, 0xc7, 0x9a, 255], 1, pal), [0xf2, 0xc7, 0x9a, 255], 'top of the ramp stays');
  const dark = shadeColor([200, 60, 60, 255], -1);
  assert.ok(dark[0] < 200 && dark[2] >= dark[1], 'darker and cooler');
  // a stroke shades each pixel once even when it passes twice
  const img = blank(4, 1);
  for (let x = 0; x < 4; x++) img.data.set([0x7a, 0x4a, 0x2a, 255], x * 4);
  const out = shadeStroke(img, [[1, 0], [2, 0], [1, 0]], 1, 1, pal);
  assert.equal(out.data[4], 0xc8);
  assert.equal(out.data[0], 0x7a);
});

/** Minimal GIF reader: enough to prove the encoder's LZW and layout are valid. */
function decodeGif(b: Uint8Array) {
  assert.equal(String.fromCharCode(...b.slice(0, 6)), 'GIF89a');
  const W = b[6] | (b[7] << 8), H = b[8] | (b[9] << 8);
  const size = 2 << (b[10] & 7);
  const pal = b.slice(13, 13 + size * 3);
  let p = 13 + size * 3;
  const frames: { idx: number[]; delay: number }[] = [];
  let delay = 0;
  while (b[p] !== 0x3b) {
    if (b[p] === 0x21) {
      if (b[p + 1] === 0xf9) delay = b[p + 4] | (b[p + 5] << 8);
      p += 2;
      while (b[p]) p += b[p] + 1;
      p++;
      continue;
    }
    assert.equal(b[p], 0x2c);
    p += 10;
    const min = b[p++];
    const data: number[] = [];
    while (b[p]) { data.push(...b.slice(p + 1, p + 1 + b[p])); p += b[p] + 1; }
    p++;
    const clear = 1 << min, eoi = clear + 1;
    let sz = min + 1, bit = 0, dict: number[][] = [], prev: number[] | null = null;
    const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; sz = min + 1; prev = null; };
    reset();
    const out: number[] = [];
    for (;;) {
      let code = 0;
      for (let i = 0; i < sz; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
      if (code === clear) { reset(); continue; }
      if (code === eoi) break;
      const entry: number[] = code < dict.length ? dict[code] : [...prev!, prev![0]];
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      if (dict.length === (1 << sz) && sz < 12) sz++;
      prev = entry;
    }
    frames.push({ idx: out, delay });
  }
  return { W, H, pal, frames };
}

test('gif: frames decode back to the same pixels, scaled, with delays and transparency', () => {
  const a = blank(5, 4), b2 = blank(5, 4);
  drawRect(a, 0, 0, 2, 2, RED, true);
  drawLine(b2, 0, 3, 4, 0, [0, 90, 255, 255]);
  const gif = encodeGif([a, b2], [100, 250], { scale: 2 });
  const d = decodeGif(gif);
  assert.equal(d.W, 10); assert.equal(d.H, 8);
  assert.equal(d.frames.length, 2);
  assert.deepEqual(d.frames.map(f => f.delay), [10, 25]);
  for (const [k, src] of [a, b2].entries()) {
    const f = d.frames[k];
    assert.equal(f.idx.length, 80);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) {
      const i = ((y >> 1) * 5 + (x >> 1)) * 4, ix = f.idx[y * 10 + x];
      if (!src.data[i + 3]) { assert.equal(ix, 0, 'transparent'); continue; }
      assert.deepEqual([...d.pal.slice(ix * 3, ix * 3 + 3)], [src.data[i], src.data[i + 1], src.data[i + 2]]);
    }
  }
  // a big noisy frame exercises code-size growth and the 4096 dictionary reset
  const big = blank(120, 90);
  for (let i = 0; i < big.data.length; i += 4) big.data.set([(i * 7) % 256 & 0xf0, (i * 13) % 256 & 0xe0, (i * 3) % 256 & 0xc0, 255], i);
  const d2 = decodeGif(encodeGif([big], [80]));
  const f = d2.frames[0];
  for (let p = 0; p < 120 * 90; p += 97) {
    const ix = f.idx[p];
    const c = [...d2.pal.slice(ix * 3, ix * 3 + 3)];
    const src = [...big.data.slice(p * 4, p * 4 + 3)];
    assert.ok(Math.abs(c[0] - src[0]) + Math.abs(c[1] - src[1]) + Math.abs(c[2] - src[2]) < 90, `pixel ${p}`);
  }
  assert.equal(f.idx.length, 120 * 90);
});

// ---------- frame game data ----------
import { copyFrameMeta, patchFrameMeta } from './index.ts';

test('frame meta: boxes/events survive export, follow resize/trim/scale, duplicate and copy', () => {
  let doc = createDoc(20, 20, 3, 'hb');
  doc = withCel(doc, doc.layers[0].id, doc.frames[0].id, (() => { const c = blank(20, 20); drawRect(c, 5, 5, 14, 19, RED, true); return c; })());
  doc = patchFrameMeta(doc, 1, m => ({ ...m, hitboxes: [{ x: 10, y: 4, w: 6, h: 3 }], events: ['impact'] }));
  doc = patchFrameMeta(doc, 0, m => ({ ...m, hurtboxes: [{ x: 5, y: 5, w: 10, h: 15 }] }));
  const out = docToSheet(doc);
  assert.deepEqual(Object.keys(out.frameData).sort(), ['0', '1']);
  assert.deepEqual(out.frameData['1'].events, ['impact']);
  // round trip through an asset
  const back = docFromAsset(out.sheet, { name: 'hb', frames: out.rects, animations: out.animations, pivot: out.pivot, frameWidth: out.frameWidth, frameHeight: out.frameHeight, frameData: out.frameData });
  assert.deepEqual(back.frames[1].meta?.hitboxes, [{ x: 10, y: 4, w: 6, h: 3 }]);
  // canvas ops move boxes with the pixels
  const bigger = resizeDoc(doc, 30, 30, 'br');
  assert.deepEqual(bigger.frames[1].meta?.hitboxes[0], { x: 20, y: 14, w: 6, h: 3 });
  const trimmed = trimCanvas(doc, 0);
  assert.deepEqual(trimmed.frames[0].meta?.hurtboxes[0], { x: 0, y: 0, w: 10, h: 15 });
  const scaled = scaleDoc(doc, 2);
  assert.deepEqual(scaled.frames[1].meta?.hitboxes[0], { x: 20, y: 8, w: 12, h: 6 });
  const dup = addFrame(doc, 1, true);
  assert.deepEqual(dup.doc.frames[2].meta?.events, ['impact']);
  const copied = copyFrameMeta(doc, 0, [1, 2], { hurtboxes: true });
  assert.equal(copied.frames[2].meta?.hurtboxes.length, 1);
  assert.deepEqual(copied.frames[1].meta?.events, ['impact'], 'events untouched when not copied');
});

test('in-between: new frame between the two, both poses on a locked half-transparent guide layer', async () => {
  const { insertInbetween, GUIDE_LAYER } = await import('./index.ts');
  let doc = createDoc(8, 8, 2, 'ib');
  const a = blank(8, 8); stamp(a, 1, 1, RED, 1); const b2 = blank(8, 8); stamp(b2, 6, 6, RED, 1);
  doc = withCel(withCel(doc, doc.layers[0].id, doc.frames[0].id, a), doc.layers[0].id, doc.frames[1].id, b2);
  const r = insertInbetween(doc, 0, 1);
  assert.equal(r.doc.frames.length, 3); assert.equal(r.index, 1);
  const guide = r.doc.layers.find(l => l.name === GUIDE_LAYER)!;
  assert.ok(guide.locked); assert.equal(guide.opacity, 0.5);
  const cel = getCel(r.doc, guide.id, r.doc.frames[1].id)!;
  assert.equal(cel.data[(1 * 8 + 1) * 4 + 3], 255); assert.equal(cel.data[(6 * 8 + 6) * 4 + 3], 255);
  assert.ok(cel.data[(1 * 8 + 1) * 4 + 2] > cel.data[(1 * 8 + 1) * 4 + 1], 'first pose tinted blue');
  assert.equal(r.doc.layers[0].id, guide.id, 'guide sits at the bottom, like a light table');
  assert.equal(getCel(r.doc, r.doc.layers[1].id, r.doc.frames[1].id), undefined, 'drawing layer left empty');
});
