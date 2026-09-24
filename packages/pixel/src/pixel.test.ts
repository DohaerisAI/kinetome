import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countColors, type PixelImage } from '@kinetome/core';
import {
  addOutline, assessResult, bodyHeight, hasOutline, prepareSheet, removeOrphans, splitSheet,
  anchorFrames, contentBounds, createImage, detectPixelScale, estimateBackground, findLoops, generateMotion,
  pickEvenly, pixelize, removeBackground, sampleGrid, DEFAULT_PIXELIZE,
} from './index.ts';

const PAL: [number, number, number][] = [[20, 12, 28], [93, 39, 93], [177, 62, 83], [239, 125, 87], [255, 205, 117]];

/** A 16x24 "real" pixel sprite: a banded capsule with an outline. */
function tinySprite(): PixelImage {
  const img = createImage(16, 24);
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 16; x++) {
      const dx = (x - 7.5) / 7, dy = (y - 11.5) / 11.5;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      const c = d > 0.75 ? PAL[0] : PAL[1 + ((x + (y >> 2)) % 4)];
      img.data.set([...c, 255], (y * 16 + x) * 4);
    }
  return img;
}

/** Bilinear upscale by a non-integer factor onto a white background + noise: typical AI "pixel art". */
function fakePixelArt(src: PixelImage, s: number, bg: [number, number, number] = [255, 255, 255]): PixelImage {
  const W = Math.round(src.width * s) + 20, H = Math.round(src.height * s) + 20;
  const out = createImage(W, H);
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 10;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const fx = (x - 10) / s - 0.5, fy = (y - 10) / s - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const at = (xx: number, yy: number, c: number) => {
        if (xx < 0 || yy < 0 || xx >= src.width || yy >= src.height) return c === 3 ? 0 : bg[c];
        const i = (yy * src.width + xx) * 4;
        return src.data[i + 3] ? src.data[i + c] : c === 3 ? 0 : bg[c];
      };
      // sharpen the interpolation so blocks stay mostly flat with blurry seams (like real outputs)
      const k = (t: number) => Math.min(1, Math.max(0, (t - 0.35) / 0.3));
      const ax = k(tx), ay = k(ty);
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = (at(x0, y0, c) * (1 - ax) + at(x0 + 1, y0, c) * ax) * (1 - ay) + (at(x0, y0 + 1, c) * (1 - ax) + at(x0 + 1, y0 + 1, c) * ax) * ay;
        out.data[o + c] = v + noise();
      }
      out.data[o + 3] = 255;
    }
  return out;
}

test('detects the hidden grid in blurry upscaled pixel art and recovers the sprite', () => {
  const src = tinySprite();
  const fake = fakePixelArt(src, 5.6);
  const g = detectPixelScale(fake);
  assert.ok(g, 'grid detected');
  assert.ok(Math.abs(g.scale - 5.6) < 0.15, `scale ${g.scale}`);
  const bg = estimateBackground(fake)!;
  assert.equal(bg.kind, 'solid');
  assert.ok(bg.colors[0][0] > 240 && bg.colors[0][1] > 240, 'white background');
  const rec = sampleGrid(removeBackground(fake, bg), g);
  const b = contentBounds(rec, 128)!, want = contentBounds(src, 128)!;
  assert.ok(Math.abs(b.w - want.w) <= 1 && Math.abs(b.h - want.h) <= 1, `recovered ${b.w}x${b.h}, want ${want.w}x${want.h}`);
});

test('does not hallucinate a grid in a smooth illustration', () => {
  const img = createImage(300, 300);
  for (let y = 0; y < 300; y++)
    for (let x = 0; x < 300; x++) {
      const d = Math.hypot(x - 150, y - 150);
      img.data.set(d < 120 ? [200 - d, 80 + d / 2, 120, 255] : [255, 255, 255, 255], (y * 300 + x) * 4);
    }
  assert.equal(detectPixelScale(img), null);
});

test('pixelize: illustration on white -> transparent, target height, limited palette', () => {
  const img = createImage(240, 400);
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 240; x++) {
      const inside = ((x - 120) / 100) ** 2 + ((y - 200) / 180) ** 2 < 1;
      img.data.set(inside ? [60 + (x >> 1), 40 + (y >> 2), 150, 255] : [252, 252, 250, 255], (y * 240 + x) * 4);
    }
  const r = pixelize([img], { ...DEFAULT_PIXELIZE, bible: PAL.map(c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')), targetHeight: 32, palette: 'auto', colors: 8 });
  assert.equal(r.mode, 'illustration');
  const b = contentBounds(r.frames[0], 128)!;
  assert.ok(Math.abs(b.h - 32) <= 1, `height ${b.h}`);
  assert.ok(countColors(r.frames[0]).size <= 8);
  assert.equal(r.frames[0].data[3], 0, 'corner is transparent');
});

test('pixelize: fake pixel art GIF frames share grid, palette and anchoring', () => {
  const base = tinySprite();
  const frames = [0, 3, 6].map(shift => {
    const f = fakePixelArt(base, 4);
    // simulate the character drifting right across the frame
    const moved = createImage(f.width + 30, f.height);
    for (let y = 0; y < f.height; y++) for (let x = 0; x < moved.width; x++) moved.data.set([255, 255, 255, 255], (y * moved.width + x) * 4);
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) moved.data.set(f.data.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 4), (y * moved.width + x + shift * 4) * 4);
    return moved;
  });
  const r = pixelize(frames, { ...DEFAULT_PIXELIZE, bible: [], targetHeight: 32, palette: 'auto', colors: 6 });
  assert.equal(r.mode, 'grid');
  const sizes = new Set(r.frames.map(f => `${f.width}x${f.height}`));
  assert.equal(sizes.size, 1, 'uniform frames');
  const bounds = r.frames.map(f => contentBounds(f, 128)!);
  assert.ok(Math.max(...bounds.map(b => b.x)) - Math.min(...bounds.map(b => b.x)) <= 1, 'drift removed by feet anchoring');
  assert.ok(countColors(r.frames[0]).size <= 6);
});

test('anchorFrames aligns feet and ground line', () => {
  const a = createImage(40, 40), b = createImage(40, 40);
  for (let y = 10; y < 30; y++) for (let x = 5; x < 11; x++) a.data.set([255, 0, 0, 255], (y * 40 + x) * 4);
  for (let y = 5; y < 25; y++) for (let x = 25; x < 31; x++) b.data.set([255, 0, 0, 255], (y * 40 + x) * 4);
  const r = anchorFrames([a, b], 'feet');
  assert.deepEqual(contentBounds(r.frames[0]), contentBounds(r.frames[1]));
  assert.equal(r.pivot.y, r.frames[0].height - 1);
});

test('findLoops finds the period of a cyclic sequence', () => {
  const frames = Array.from({ length: 14 }, (_, i) => {
    const f = createImage(24, 24);
    const x = 4 + (i % 6) * 3;
    for (let y = 8; y < 16; y++) for (let xx = x; xx < x + 4; xx++) f.data.set([200, 200, 200, 255], (y * 24 + xx) * 4);
    return f;
  });
  const best = findLoops(frames, 3)[0];
  assert.equal((best.end - best.start) % 6, 0);
  assert.deepEqual(pickEvenly(0, 12, 4), [0, 3, 6, 9]);
});

test('motion presets keep palette and produce loops', () => {
  const s = createImage(20, 30);
  for (let y = 4; y < 28; y++) for (let x = 6; x < 14; x++) s.data.set([93, 39, 93, 255], (y * 20 + x) * 4);
  const breathe = generateMotion(s, 'breathe');
  assert.equal(breathe.frames.length, 4);
  assert.ok(breathe.loop);
  assert.deepEqual(contentBounds(breathe.frames[2], 128)!.y, 5, 'upper body dipped 1px');
  assert.equal(contentBounds(breathe.frames[2], 128)!.y + contentBounds(breathe.frames[2], 128)!.h, 28, 'feet planted');
  const flash = generateMotion(s, 'hurt-flash');
  assert.ok(countColors(flash.frames[0]).has('#ffffff'));
  assert.equal(flash.loop, false);
});

test('findLoops ignores still stretches and finds the real cycle', () => {
  const still = createImage(24, 24);
  for (let y = 8; y < 16; y++) for (let x = 2; x < 6; x++) still.data.set([200, 200, 200, 255], (y * 24 + x) * 4);
  const cycle = (i: number) => {
    const f = createImage(24, 24);
    const x = 2 + [0, 3, 6, 9, 12, 9, 6, 3][i % 8];
    for (let y = 8; y < 16; y++) for (let xx = x; xx < x + 4; xx++) f.data.set([200, 200, 200, 255], (y * 24 + xx) * 4);
    return f;
  };
  const frames = [still, still, still, still, still, ...Array.from({ length: 17 }, (_, i) => cycle(i))];
  const best = findLoops(frames, 4)[0];
  assert.equal((best.end - best.start) % 8, 0, `got ${best.start}-${best.end}`);
  assert.ok(best.start >= 4, 'loop starts in the moving part');
});

/** Paints a pose (filled rounded body + head) at (x, y) with height h. */
function pose(img: PixelImage, x: number, y: number, h: number, color: [number, number, number]) {
  const w = Math.round(h * 0.45);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const head = j < h * 0.3, dx = (i - w / 2) / (w / 2), dy = (j - h * 0.15) / (h * 0.15);
    const inHead = head && dx * dx + dy * dy < 1;
    const inBody = !head && i > w * 0.15 && i < w * 0.85;
    if (inHead || inBody) img.data.set([...color, 255], ((y + j) * img.width + x + i) * 4);
  }
}
function fill(img: PixelImage, c: [number, number, number]) { for (let i = 0; i < img.data.length; i += 4) img.data.set([...c, 255], i); }

test('checkerboard fake transparency is detected and removed, including enclosed pockets', () => {
  const img = createImage(120, 120);
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
    const c = ((x >> 3) + (y >> 3)) & 1 ? 204 : 255;
    img.data.set([c, c, c, 255], (y * 120 + x) * 4);
  }
  // a ring (donut) character: its hole shows the checkerboard
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
    const d = Math.hypot(x - 60, y - 60);
    if (d < 40 && d > 18) img.data.set([180, 40, 60, 255], (y * 120 + x) * 4);
  }
  const bg = estimateBackground(img)!;
  assert.equal(bg.kind, 'checker');
  const out = removeBackground(img, bg, 0.09, true);
  assert.equal(out.data[(60 * 120 + 60) * 4 + 3], 0, 'hole cleared');
  assert.equal(out.data[(60 * 120 + 30) * 4 + 3], 255, 'ring kept');
  assert.equal(out.data[3], 0, 'corner cleared');
});

test('splitSheet: labels dropped, touching poses separated, rows kept', () => {
  const img = createImage(400, 260);
  // row 1: four poses, the last two touching
  pose(img, 10, 10, 90, [60, 60, 200]); pose(img, 90, 10, 90, [60, 60, 200]);
  pose(img, 180, 10, 90, [60, 60, 200]); pose(img, 220, 10, 90, [60, 60, 200]);
  // a text label under the row
  for (let y = 108; y < 114; y++) for (let x = 12; x < 60; x++) if (x % 4) img.data.set([0, 0, 0, 255], (y * 400 + x) * 4);
  // row 2: three poses
  pose(img, 10, 150, 90, [200, 60, 60]); pose(img, 110, 150, 90, [200, 60, 60]); pose(img, 210, 150, 90, [200, 60, 60]);
  const s = splitSheet(img);
  assert.equal(s.rects.length, 7, `got ${s.rects.length}`);
  assert.deepEqual(s.rows.map(r => r.length), [4, 3]);
  assert.ok(s.dropped >= 1, 'label dropped');
});

test('prepareSheet + pixelize: AI sheet on chroma green becomes uniform frames; size drift fixed', () => {
  const img = createImage(520, 200);
  fill(img, [0, 255, 0]);
  const heights = [150, 150, 172, 150]; // frame 3 drawn ~15% bigger, as AI does
  heights.forEach((h, i) => pose(img, 20 + i * 125, 190 - h, h, [90, 50, 160]));
  const prep = prepareSheet(img, { background: 'auto', tolerance: 0.09, holes: 'auto' });
  assert.equal(prep.frames.length, 4);
  assert.equal(prep.background?.kind, 'solid');
  const r = pixelize(prep.frames, { ...DEFAULT_PIXELIZE, background: 'none', bible: [], targetHeight: 40, palette: 'auto', colors: 4 });
  assert.equal(new Set(r.frames.map(f => `${f.width}x${f.height}`)).size, 1);
  const hs = r.frames.map(f => contentBounds(f, 128)!.h);
  assert.ok(Math.max(...hs) - Math.min(...hs) <= 1, `heights ${hs}`);
  assert.equal(assessResult(r, 16).issues.filter(i => i.severity !== 'info').length, 0);
  // without normalization the quality report catches the outlier
  const raw = pixelize(prep.frames, { ...DEFAULT_PIXELIZE, background: 'none', bible: [], targetHeight: 40, palette: 'auto', colors: 4, normalizeSize: false });
  const q = assessResult(raw, 16);
  assert.ok(q.issues.some(i => /body is \d+px tall/.test(i.message) && i.frames?.includes(2)), JSON.stringify(q.issues));
});

test('removeOrphans leaves solid shapes alone', () => {
  const img = createImage(10, 10);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) img.data.set([10, 10, 10, 255], (y * 10 + x) * 4);
  img.data.set([10, 10, 10, 255], (0 * 10 + 9) * 4); // lone speck
  const out = removeOrphans(img);
  assert.equal(out.data[(0 * 10 + 9) * 4 + 3], 0);
  assert.equal(countColors(out).get('#0a0a0a'), 36);
});

test('outline is detected so it is never doubled', () => {
  const img = createImage(20, 20);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) img.data.set([200, 150, 90, 255], (y * 20 + x) * 4);
  assert.equal(hasOutline(img), false);
  const withLine = addOutline(img, '#101010');
  assert.equal(hasOutline(withLine), true);
});

test('a raised thin weapon is not mistaken for a bigger character', () => {
  const { bodyHeight: bh } = { bodyHeight } as { bodyHeight: (i: PixelImage) => number };
  const body = createImage(40, 80);
  for (let y = 30; y < 78; y++) for (let x = 14; x < 26; x++) body.data.set([90, 50, 160, 255], (y * 40 + x) * 4);
  const withSword = createImage(40, 80);
  withSword.data.set(body.data);
  for (let y = 2; y < 30; y++) withSword.data.set([220, 220, 230, 255], (y * 40 + 24) * 4); // 1px blade overhead
  assert.equal(bh(body), 48);
  assert.equal(bh(withSword), 48);
  assert.equal(contentBounds(withSword, 128)!.h, 76);
});

test('grid mode re-samples a frame the generator drew too big', () => {
  const base = tinySprite();
  const frames = [4, 4, 4.6, 4].map(s => { const f = fakePixelArt(base, 4); return s === 4 ? f : fakePixelArt(base, s); });
  // frame 3 has the same art at a bigger block size -> per-frame grid already handles it
  const r = pixelize(frames, { ...DEFAULT_PIXELIZE, bible: [], targetHeight: 32, palette: 'auto', colors: 6 });
  const hs = r.frames.map(f => contentBounds(f, 128)!.h);
  assert.ok(Math.max(...hs) - Math.min(...hs) <= 1, `heights ${hs}`);
});
