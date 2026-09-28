import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countColors, type PixelImage } from '@kinetome/core';
import { EFFECTS, dustPuff, hitSpark, leafSwirl, magicBurst, slashArc, type EffectAnimation } from './effects.ts';

const COLORS = ['#223344', '#6688aa', '#eeffff'];

const cases: [string, (seed: number) => EffectAnimation, number, number][] = [
  ['slashArc', seed => slashArc({ size: 40, colors: COLORS, thickness: 6, arc: 160, seed }), 5, 40],
  ['slashArc left', seed => slashArc({ size: 40, colors: COLORS, direction: 'left', seed }), 5, 40],
  ['dustPuff', seed => dustPuff({ size: 32, colors: COLORS, seed }), 6, 32],
  ['hitSpark', seed => hitSpark({ size: 32, colors: COLORS, seed }), 4, 32],
  ['leafSwirl', seed => leafSwirl({ size: 48, colors: COLORS, count: 12, seed }), 10, 48],
  ['magicBurst', seed => magicBurst({ size: 40, colors: COLORS, seed }), 8, 40],
];

const opaque = (f: PixelImage) => { let n = 0; for (let i = 3; i < f.data.length; i += 4) if (f.data[i]) n++; return n; };

for (const [name, make, frames, size] of cases) {
  test(`${name}: frame count, size, palette, binary alpha, determinism, motion`, () => {
    const a = make(7);
    assert.equal(a.frames.length, frames);
    assert.ok(a.fps > 0);
    assert.ok(a.anchor.x >= 0 && a.anchor.x < size && a.anchor.y >= 0 && a.anchor.y < size);
    for (const f of a.frames) {
      assert.equal(f.width, size);
      assert.equal(f.height, size);
      assert.equal(f.data.length, size * size * 4);
      for (let i = 3; i < f.data.length; i += 4) assert.ok(f.data[i] === 0 || f.data[i] === 255);
      for (const c of countColors(f, 1).keys()) assert.ok(COLORS.includes(c), `${c} not in palette`);
    }
    assert.ok(a.frames.some(f => opaque(f) > 0));
    const b = make(7);
    a.frames.forEach((f, i) => assert.deepEqual(f.data, b.frames[i].data));
    for (let i = 1; i < a.frames.length; i++) assert.notDeepEqual(a.frames[i].data, a.frames[i - 1].data, `frame ${i} same as ${i - 1}`);
  });
}

test('slashArc: left is a mirror of right', () => {
  const r = slashArc({ size: 24, colors: COLORS }), l = slashArc({ size: 24, colors: COLORS, direction: 'left' });
  const f = r.frames[2], g = l.frames[2];
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) assert.equal(f.data[(y * 24 + x) * 4 + 3], g.data[(y * 24 + 23 - x) * 4 + 3]);
  assert.equal(r.anchor.x + l.anchor.x, 23);
});

test('leafSwirl: leaves rise (centroid y decreases)', () => {
  const a = leafSwirl({ size: 48, colors: COLORS, count: 12, seed: 3 });
  const cy = a.frames.map(f => {
    let s = 0, n = 0;
    for (let p = 0; p < 48 * 48; p++) if (f.data[p * 4 + 3]) { s += Math.floor(p / 48); n++; }
    return s / n;
  });
  for (let i = 1; i < cy.length; i++) assert.ok(cy[i] < cy[i - 1], `frame ${i + 1}: ${cy[i]} !< ${cy[i - 1]}`);
});

test('different seeds give different effects', () => {
  const a = hitSpark({ size: 32, colors: COLORS, seed: 1 }), b = hitSpark({ size: 32, colors: COLORS, seed: 2 });
  assert.notDeepEqual(a.frames[1].data, b.frames[1].data);
});

test('EFFECTS registry builds every effect from its defaults', () => {
  assert.deepEqual(EFFECTS.map(e => e.id), ['slash', 'dust', 'spark', 'leaves', 'magic']);
  for (const e of EFFECTS) {
    const a = e.make();
    assert.equal(a.frames.length, e.defaults.frames);
    assert.equal(a.frames[0].width, e.defaults.size);
    const small = e.make({ size: 16, frames: 3 });
    assert.equal(small.frames.length, 3);
    assert.equal(small.frames[0].width, 16);
  }
});
