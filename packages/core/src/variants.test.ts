import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countColors, hexToRgb, rampFor, rgbToHex, rgbToOklab, type PixelImage } from './color.ts';
import { GHOST_ALPHA, TINT_RAMPS, hueShiftVariant, rampSwap, recolorByRamps, tintVariant } from './variants.ts';

const OUTLINE = '#141018', SKIN = '#f0c8a0';
const RED = rampFor('#c03030');

/**
 * 8x8 test sprite: transparent border ring, outline ring, red ramp body, one skin pixel,
 * and one half-transparent pixel to check alpha is preserved.
 */
function sprite(): PixelImage {
  const W = 8, data = new Uint8ClampedArray(W * W * 4);
  const put = (x: number, y: number, hex: string, a = 255) => { const i = (y * W + x) * 4; data.set([...hexToRgb(hex), a], i); };
  for (let y = 1; y < 7; y++)
    for (let x = 1; x < 7; x++) {
      const edge = x === 1 || y === 1 || x === 6 || y === 6;
      put(x, y, edge ? OUTLINE : y < 3 ? RED.light : y < 5 ? RED.base : RED.shadow);
    }
  put(3, 3, SKIN);
  put(4, 4, RED.base, 200);
  return { width: W, height: W, data };
}

const px = (img: PixelImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return { hex: rgbToHex(img.data[i], img.data[i + 1], img.data[i + 2]), a: img.data[i + 3] };
};

test('rampSwap builds shadow/base/light mapping from rampFor', () => {
  const m = rampSwap('#c03030', '#3050c0'), b = rampFor('#3050c0');
  assert.deepEqual(m.from, [RED.shadow, RED.base, RED.light]);
  assert.deepEqual(m.to, [b.shadow, b.base, b.light]);
});

test('recolorByRamps swaps exact ramp colors only and keeps alpha', () => {
  const src = sprite(), blue = rampFor('#3050c0');
  const out = recolorByRamps(src, [rampSwap('#c03030', '#3050c0')]);
  assert.equal(px(out, 3, 2).hex, blue.light);
  assert.equal(px(out, 2, 4).hex, blue.base);
  assert.equal(px(out, 2, 5).hex, blue.shadow);
  assert.deepEqual(px(out, 4, 4), { hex: blue.base, a: 200 });
  assert.equal(px(out, 1, 1).hex, OUTLINE);
  assert.equal(px(out, 3, 3).hex, SKIN);
  assert.equal(px(out, 0, 0).a, 0);
  assert.notEqual(out.data, src.data);
  assert.equal(px(src, 2, 4).hex, RED.base, 'input untouched');
});

test('tintVariant hurt: white silhouette, outline kept', () => {
  const out = tintVariant(sprite(), 'hurt');
  assert.equal(px(out, 1, 1).hex, OUTLINE);
  assert.equal(px(out, 6, 3).hex, OUTLINE);
  assert.equal(px(out, 3, 3).hex, '#ffffff');
  assert.equal(px(out, 2, 5).hex, '#ffffff');
  assert.deepEqual(px(out, 4, 4), { hex: '#ffffff', a: 200 });
  assert.equal(px(out, 0, 0).a, 0);
});

for (const kind of ['frozen', 'poison', 'gold'] as const) {
  test(`tintVariant ${kind}: only ramp colors, darkest→first, lightest→last`, () => {
    const out = tintVariant(sprite(), kind), ramp = TINT_RAMPS[kind] as readonly string[];
    for (const c of countColors(out, 1).keys()) assert.ok(ramp.includes(c), c);
    assert.equal(px(out, 1, 1).hex, ramp[0]);
    assert.equal(px(out, 3, 3).hex, ramp[3]); // skin is the lightest color
    const l = (h: string) => rgbToOklab(...hexToRgb(h))[0];
    assert.ok(l(px(out, 2, 2).hex) > l(px(out, 2, 5).hex), 'light rows stay lighter than shadow rows');
    assert.equal(px(out, 4, 4).a, 200);
    assert.equal(px(out, 0, 0).a, 0);
  });
}

test('tintVariant shadow: one flat dark color', () => {
  const out = tintVariant(sprite(), 'shadow');
  assert.equal(countColors(out, 1).size, 1);
  assert.ok(rgbToOklab(...hexToRgb([...countColors(out, 1).keys()][0]))[0] < 0.25);
  assert.equal(px(out, 0, 0).a, 0);
});

test('tintVariant ghost: grey at alpha 128, transparent stays transparent', () => {
  const out = tintVariant(sprite(), 'ghost');
  for (let i = 0; i < out.data.length; i += 4) {
    const a = out.data[i + 3];
    assert.ok(a === 0 || a === GHOST_ALPHA);
    if (a) assert.ok(Math.max(Math.abs(out.data[i] - out.data[i + 1]), Math.abs(out.data[i + 1] - out.data[i + 2])) <= 2, 'desaturated');
  }
  assert.equal(px(out, 0, 0).a, 0);
});

test('hueShiftVariant rotates hue, keeps lightness, respects protect', () => {
  const src = sprite();
  const out = hueShiftVariant(src, 120, { protect: [SKIN, OUTLINE] });
  const before = rgbToOklab(...hexToRgb(RED.base)), after = rgbToOklab(...hexToRgb(px(out, 2, 4).hex));
  assert.ok(Math.abs(before[0] - after[0]) < 0.02);
  const hue = (v: number[]) => (Math.atan2(v[2], v[1]) * 180) / Math.PI;
  const dh = ((hue(after) - hue(before)) % 360 + 360) % 360;
  assert.ok(Math.abs(dh - 120) < 8, `hue moved ${dh}`);
  assert.equal(px(out, 3, 3).hex, SKIN);
  assert.equal(px(out, 1, 1).hex, OUTLINE, 'protected outline untouched');
  assert.equal(px(out, 4, 4).a, 200);
  assert.deepEqual(hueShiftVariant(src, 360).data, src.data);
});

test('hueShiftVariant leaves pure greys exactly as they are', () => {
  const grey = { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) };
  assert.deepEqual(hueShiftVariant(grey, 90).data, grey.data);
});
