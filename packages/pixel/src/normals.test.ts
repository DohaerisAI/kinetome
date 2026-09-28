import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PixelImage } from '@kinetome/core';
import { createImage } from './image.ts';
import { litPreview, normalMap, normalMapFrames } from './normals.ts';

/** A flat grey disc of radius `r` centred in a `size` square. */
function disc(size: number, r: number, color: [number, number, number] = [160, 160, 160]): PixelImage {
  const img = createImage(size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if ((x - c) ** 2 + (y - c) ** 2 <= r * r) img.data.set([...color, 255], (y * size + x) * 4);
  return img;
}

const px = (img: PixelImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [...img.data.subarray(i, i + 4)];
};

test('normalMap keeps size and transparency', () => {
  const img = disc(20, 8);
  const n = normalMap(img);
  assert.equal(n.width, 20);
  assert.equal(n.height, 20);
  assert.equal(px(n, 0, 0)[3], 0);
  assert.deepEqual(px(n, 0, 0), [128, 128, 255, 0]);
  for (let i = 0; i < 20 * 20; i++) assert.equal(n.data[i * 4 + 3], img.data[i * 4 + 3]);
});

test('disc normals point outward at the edges and toward the viewer at the centre', () => {
  const n = normalMap(disc(21, 9), { luminance: 0 });
  const left = px(n, 1, 10), right = px(n, 19, 10), top = px(n, 10, 1), bottom = px(n, 10, 19), centre = px(n, 10, 10);
  assert.ok(left[0] < 128, `left red ${left[0]}`);
  assert.ok(right[0] > 128, `right red ${right[0]}`);
  assert.ok(top[1] > 128, `top green ${top[1]}`);
  assert.ok(bottom[1] < 128, `bottom green ${bottom[1]}`);
  assert.ok(Math.abs(centre[0] - 128) <= 2 && Math.abs(centre[1] - 128) <= 2 && centre[2] >= 250, `centre ${centre}`);
});

test('square touching the image border still gets rims', () => {
  const img = createImage(10, 10);
  for (let i = 0; i < 100; i++) img.data.set([200, 50, 50, 255], i * 4);
  const n = normalMap(img, { luminance: 0 });
  assert.ok(px(n, 0, 5)[0] < 128);
  assert.ok(px(n, 9, 5)[0] > 128);
  assert.ok(px(n, 5, 0)[1] > 128);
});

test('flipY inverts green', () => {
  const img = disc(21, 9);
  const a = normalMap(img), b = normalMap(img, { flipY: true });
  assert.ok(px(a, 10, 1)[1] > 128);
  assert.ok(px(b, 10, 1)[1] < 128);
  assert.ok(Math.abs(px(a, 10, 1)[1] + px(b, 10, 1)[1] - 255) <= 1);
  assert.equal(px(a, 10, 1)[0], px(b, 10, 1)[0]);
});

test('luminance adds bumps on a flat interior', () => {
  const img = disc(21, 9);
  img.data.set([255, 255, 255, 255], (10 * 21 + 10) * 4);
  const n = normalMap(img, { luminance: 0.5 });
  assert.ok(px(n, 9, 10)[0] < 128, 'left of bright pixel tilts left');
  assert.ok(px(n, 11, 10)[0] > 128, 'right of bright pixel tilts right');
});

test('normalMapFrames does not bleed across frame boundaries', () => {
  // two full 10x10 frames side by side: the whole sheet is opaque
  const sheet = createImage(20, 10);
  for (let i = 0; i < 200; i++) sheet.data.set([150, 150, 150, 255], i * 4);
  const rects = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }];
  const n = normalMapFrames(sheet, rects, { luminance: 0 });
  assert.equal(n.width, 20);
  assert.equal(n.height, 10);
  assert.ok(px(n, 9, 5)[0] > 128, 'frame 1 right edge points right');
  assert.ok(px(n, 10, 5)[0] < 128, 'frame 2 left edge points left');
  // identical frames give identical maps
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 10; x++) assert.deepEqual(px(n, x, y), px(n, x + 10, y));
  // whole-sheet generation would treat the seam as interior
  const whole = normalMap(sheet, { luminance: 0 });
  assert.ok(Math.abs(px(whole, 9, 5)[0] - 128) <= 2);
});

test('litPreview is brighter on the side facing the light', () => {
  const img = disc(21, 9);
  const n = normalMap(img);
  const lit = litPreview(img, n, { x: -20, y: 10, z: 10 });
  assert.equal(lit.width, 21);
  assert.ok(px(lit, 2, 10)[0] > px(lit, 18, 10)[0], `left ${px(lit, 2, 10)[0]} right ${px(lit, 18, 10)[0]}`);
  assert.equal(px(lit, 0, 0)[3], 0);
  const fromRight = litPreview(img, n, { x: 40, y: 10, z: 10, ambient: 0.2, color: [255, 200, 150] });
  assert.ok(px(fromRight, 18, 10)[0] > px(fromRight, 2, 10)[0]);
});
