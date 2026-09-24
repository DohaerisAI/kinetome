import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectGrid, sliceGrid, sliceIslands, normalizeFrames, parseSheet, detectFormat, isUniform,
  lintAsset, snapToPalette, hardenAlpha, countColors, type PixelImage, type SpriteAsset, DEFAULT_STYLE,
} from './index.ts';

function blank(w: number, h: number): PixelImage {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}
function fill(img: PixelImage, x: number, y: number, w: number, h: number, rgba: [number, number, number, number]) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) img.data.set(rgba, (j * img.width + i) * 4);
}
const RED: [number, number, number, number] = [255, 0, 77, 255];

test('detectGrid finds cell size from transparent gutters', () => {
  const img = blank(64, 32);
  for (let c = 0; c < 4; c++) fill(img, c * 16 + 3, 4, 10, 24, RED);
  assert.deepEqual(detectGrid(img), { frameWidth: 16, frameHeight: 32 });
  assert.equal(sliceGrid(64, 32, 16, 32, img).length, 4);
});

test('sliceGrid drops empty cells', () => {
  const img = blank(32, 16);
  fill(img, 2, 2, 4, 4, RED);
  assert.equal(sliceGrid(32, 16, 16, 16, img).length, 1);
});

test('sliceIslands merges detached parts and keeps reading order', () => {
  const img = blank(60, 40);
  fill(img, 30, 2, 6, 10, RED);   // right sprite
  fill(img, 2, 2, 6, 10, RED);    // left sprite body
  fill(img, 9, 4, 1, 1, RED);     // detached spark 1px away from the left body
  fill(img, 2, 25, 8, 8, RED);    // second row
  const r = sliceIslands(img, 2);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { x: 2, y: 2, w: 8, h: 10 });
  assert.equal(r[1].x, 30);
  assert.equal(r[2].y, 25);
  const n = normalizeFrames(r);
  assert.equal(n.cellW, 8);
  assert.equal(n.cellH, 10);
  assert.equal(n.frames[2].offsetY, 2); // shorter sprite bottom-aligned
});

test('parses the wizard row-format export', () => {
  const json = JSON.parse(readFileSync(new URL('../../../samples/wizard/wizard.json', import.meta.url), 'utf8'));
  assert.equal(detectFormat(json), 'rows');
  const p = parseSheet(json);
  assert.equal(p.frames.length, 50);
  assert.deepEqual(p.animations.map(a => a.name), ['idle', 'charge', 'cast', 'recover']);
  assert.equal(p.animations[2].frames[0], 35);
  assert.ok(isUniform(p));
});

test('parses Aseprite JSON with tags and trimmed frames', () => {
  const json = {
    frames: {
      'hero 0.aseprite': { frame: { x: 0, y: 0, w: 10, h: 12 }, rotated: false, trimmed: true, spriteSourceSize: { x: 3, y: 4, w: 10, h: 12 }, sourceSize: { w: 16, h: 16 }, duration: 100 },
      'hero 1.aseprite': { frame: { x: 10, y: 0, w: 10, h: 12 }, rotated: false, trimmed: true, spriteSourceSize: { x: 3, y: 4, w: 10, h: 12 }, sourceSize: { w: 16, h: 16 }, duration: 100 },
      'hero 2.aseprite': { frame: { x: 20, y: 0, w: 12, h: 14 }, rotated: false, trimmed: true, spriteSourceSize: { x: 2, y: 2, w: 12, h: 14 }, sourceSize: { w: 16, h: 16 }, duration: 50 },
    },
    meta: { app: 'https://www.aseprite.org/', frameTags: [{ name: 'walk', from: 0, to: 1, direction: 'forward' }, { name: 'hit', from: 1, to: 2, direction: 'pingpong' }] },
  };
  const p = parseSheet(json);
  assert.equal(p.format, 'aseprite');
  assert.equal(p.cellW, 16);
  assert.deepEqual(p.frames[0], { rect: { x: 0, y: 0, w: 10, h: 12 }, offsetX: 3, offsetY: 4 });
  assert.equal(p.animations[0].fps, 10);
  assert.deepEqual(p.animations[1].frames, [1, 2]);
  assert.ok(!isUniform(p));
});

test('groups TexturePacker frames by name', () => {
  const json = { frames: {
    'run_2.png': { frame: { x: 16, y: 0, w: 16, h: 16 } },
    'run_1.png': { frame: { x: 0, y: 0, w: 16, h: 16 } },
    'idle_1.png': { frame: { x: 32, y: 0, w: 16, h: 16 } },
  } };
  const p = parseSheet(json);
  assert.equal(p.format, 'texturepacker');
  const run = p.animations.find(a => a.name === 'run')!;
  assert.deepEqual(run.frames, [1, 0]);
});

test('lint flags off-palette and semi-alpha, fixes resolve them', () => {
  const img = blank(16, 16);
  fill(img, 4, 4, 8, 8, [250, 10, 70, 255]);   // near PICO red, not exact
  fill(img, 4, 12, 8, 1, [0, 0, 0, 120]);      // soft shadow
  const asset: SpriteAsset = {
    version: 1, id: 'x', name: 'x', kind: 'prop', source: 'imported', image: 'sheet.png',
    frameWidth: 16, frameHeight: 16, frames: [{ x: 0, y: 0, w: 16, h: 16 }], pivot: { x: 8, y: 15 },
    animations: [{ name: 'default', frames: [0], fps: 10, loop: true }], tags: [], reference: false, createdAt: '', updatedAt: '',
  };
  const before = lintAsset(img, asset, DEFAULT_STYLE);
  assert.deepEqual(before.issues.map(i => i.code).sort(), ['off-palette', 'semi-alpha']);
  const fixed = snapToPalette(hardenAlpha(img), DEFAULT_STYLE.palette);
  assert.equal(lintAsset(fixed, asset, DEFAULT_STYLE).issues.length, 0);
  assert.ok(countColors(fixed).has('#ff004d'));
});

test('downscale undoes a blurry 2x upscale by mode pooling', async () => {
  const { downscale } = await import('./index.ts');
  const img = blank(8, 8);
  fill(img, 0, 0, 8, 8, RED);
  fill(img, 4, 0, 4, 4, [0, 0, 0, 255]);
  img.data.set([128, 0, 40, 255], (1 * 8 + 3) * 4); // one blended edge pixel
  const out = downscale(img, 2);
  assert.equal(out.width, 4);
  assert.deepEqual([...out.data.slice(4, 8)], [255, 0, 77, 255]); // block (1,0) stays red despite the blend
  assert.deepEqual([...out.data.slice(8, 12)], [0, 0, 0, 255]);
});
