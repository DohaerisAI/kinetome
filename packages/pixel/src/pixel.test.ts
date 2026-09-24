import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countColors, type PixelImage } from '@sprite/core';
import {
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
  assert.ok(bg[0] > 240 && bg[1] > 240, 'white background');
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
