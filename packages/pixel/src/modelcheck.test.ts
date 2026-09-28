import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgb, type PixelImage } from '@kinetome/core';
import { createImage } from './image.ts';
import { modelCheck } from './modelcheck.ts';

const PARTS = [
  { name: 'head', colors: ['#f0c8a0', '#c89870'] },
  { name: 'body', colors: ['#3050c0', '#203080'] },
  { name: 'wooden leg', colors: ['#8a5a2b', '#5a3a1b'] },
];

function rect(img: PixelImage, x0: number, y0: number, w: number, h: number, hex: string): void {
  const c = hexToRgb(hex);
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) img.data.set([...c, 255], (y * img.width + x) * 4);
}

/** 16x24 stick character; `stretch` adds rows to the body, `leg` toggles the wooden leg. */
function character({ leg = true, stretch = 0, extra }: { leg?: boolean; stretch?: number; extra?: string } = {}): PixelImage {
  const img = createImage(16, 32);
  rect(img, 5, 2, 6, 5, '#f0c8a0'); rect(img, 5, 6, 6, 1, '#c89870');
  rect(img, 4, 7, 8, 8 + stretch, '#3050c0'); rect(img, 4, 14 + stretch, 8, 1, '#203080');
  rect(img, 5, 15 + stretch, 2, 7, '#3050c0');
  if (leg) { rect(img, 9, 15 + stretch, 2, 6, '#8a5a2b'); rect(img, 9, 21 + stretch, 2, 1, '#5a3a1b'); }
  if (extra) rect(img, 6, 9, 2, 2, extra);
  return img;
}

test('identical frames score 100 with no issues', () => {
  const r = modelCheck(character(), [character(), character(), character()], { parts: PARTS });
  assert.equal(r.score, 100);
  assert.deepEqual(r.issues, []);
  assert.equal(r.perFrame.length, 3);
  assert.equal(r.perFrame[0].height, 20);
  assert.equal(r.perFrame[0].width, 8);
  const shares = r.perFrame[0].colorShare;
  assert.deepEqual(Object.keys(shares), ['head', 'body', 'wooden leg']);
  assert.ok(Math.abs(shares.head + shares.body + shares['wooden leg'] - 1) < 1e-9);
});

test('a part removed from two frames is flagged with those frames', () => {
  const frames = [character(), character(), character({ leg: false }), character({ leg: false }), character()];
  const r = modelCheck(character(), frames, { parts: PARTS });
  const leg = r.issues.find(i => i.part === 'wooden leg');
  assert.ok(leg);
  assert.equal(leg.severity, 'error');
  assert.deepEqual(leg.frames, [2, 3]);
  assert.equal(leg.message, 'Wooden leg missing in frames 3, 4');
  assert.equal(r.perFrame[2].colorShare['wooden leg'], 0);
  assert.ok(r.score < 100);
});

test('a stretched frame is flagged; mild squash-and-stretch is allowed', () => {
  const r = modelCheck(character(), [character(), character({ stretch: 2 }), character({ stretch: 6 })], { parts: PARTS });
  const h = r.issues.find(i => i.message.includes('height'));
  assert.ok(h, JSON.stringify(r.issues));
  assert.deepEqual(h.frames, [2]);
  assert.match(h.message, /^Frame 3: height 26px vs 20px/);
  const body = r.issues.find(i => i.part === 'body');
  assert.ok(body && body.message.startsWith('Body grew in frame 3'), JSON.stringify(r.issues));
});

test('a shrunken part is flagged as shrank', () => {
  const small = character({ leg: false });
  rect(small, 9, 15, 2, 3, '#8a5a2b');
  const r = modelCheck(character(), [small], { parts: PARTS });
  const leg = r.issues.find(i => i.part === 'wooden leg');
  assert.ok(leg);
  assert.equal(leg.severity, 'warn');
  assert.match(leg.message, /^Wooden leg shrank in frame 1 \(43% of its reference size\)/);
});

test('colors not in the reference are reported as drift', () => {
  const r = modelCheck(character(), [character(), character({ extra: '#ff00ff' })]);
  const d = r.issues.find(i => i.message.includes('not in the reference'));
  assert.ok(d);
  assert.deepEqual(d.frames, [1]);
  assert.match(d.message, /#ff00ff/);
  assert.ok('#3050c0' in r.perFrame[0].colorShare, 'no parts: shares keyed by reference color');
});

test('empty frames are errors', () => {
  const r = modelCheck(character(), [character(), createImage(16, 32)], { parts: PARTS });
  assert.deepEqual(r.issues.map(i => i.message), ['Frame 2 is empty']);
});
