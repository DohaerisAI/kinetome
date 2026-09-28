import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PixelImage } from './color.ts';
import type { SpriteAsset } from './schema.ts';
import {
  packAtlas, assetFrames, texturePackerJson, phaserAnimsJson, unitySpriteMeta, engineExportFiles, atlasGuid,
} from './atlas.ts';

function blank(w: number, h: number): PixelImage {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}
function fill(img: PixelImage, x: number, y: number, w: number, h: number, rgba: [number, number, number, number]) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) img.data.set(rgba, (j * img.width + i) * 4);
}
function px(img: PixelImage, x: number, y: number): number[] {
  return [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
}

/** Deterministic pseudo-random frames with transparent borders of varying size. */
function randomFrames(n: number) {
  let s = 12345;
  const rnd = (m: number) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s % m; };
  return Array.from({ length: n }, (_, k) => {
    const w = 4 + rnd(20), h = 4 + rnd(20);
    const img = blank(w, h);
    const x0 = rnd(3), y0 = rnd(3);
    const cw = Math.max(1, w - x0 - rnd(3)), ch = Math.max(1, h - y0 - rnd(3));
    for (let y = y0; y < y0 + ch; y++) for (let x = x0; x < x0 + cw; x++) {
      img.data.set([(x * 13 + k) & 255, (y * 7 + k * 3) & 255, k & 255, 255], (y * w + x) * 4);
    }
    return { key: `f${k}`, image: img };
  });
}

function asset(over: Partial<SpriteAsset> = {}): SpriteAsset {
  return {
    version: 1, id: 'hero', name: 'Hero', kind: 'character', source: 'code', image: 'sheet.png',
    frameWidth: 8, frameHeight: 8,
    frames: [0, 1, 2, 3].map(i => ({ x: i * 8, y: 0, w: 8, h: 8 })),
    pivot: { x: 4, y: 7 },
    animations: [
      { name: 'idle', frames: [0, 1], fps: 4, loop: true },
      { name: 'attack', frames: [2, 3, 1], fps: 12, loop: false },
    ],
    tags: [], description: '', reference: false, createdAt: '', updatedAt: '',
    ...over,
  };
}

/** Sheet with 4 frames: 0 and 3 identical, 1 and 2 distinct, all with transparent margins. */
function heroSheet(): PixelImage {
  const sheet = blank(32, 8);
  fill(sheet, 2, 1, 4, 7, [255, 0, 0, 255]);
  fill(sheet, 8 + 1, 2, 6, 6, [0, 255, 0, 255]);
  fill(sheet, 16 + 3, 0, 3, 8, [0, 0, 255, 255]);
  fill(sheet, 24 + 2, 1, 4, 7, [255, 0, 0, 255]);
  return sheet;
}

test('packAtlas: in bounds, no overlaps, padding respected, pixels reconstruct the source frames', () => {
  const items = randomFrames(40);
  for (const padding of [0, 1, 2]) {
    const atlas = packAtlas(items, { padding });
    assert.equal(atlas.image.width, atlas.width);
    assert.equal(atlas.image.height, atlas.height);
    const boxes = Object.values(atlas.placements);
    assert.equal(boxes.length, items.length);
    for (const b of boxes) {
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= atlas.width && b.y + b.h <= atlas.height);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const apart = a.x + a.w + padding <= b.x || b.x + b.w + padding <= a.x
        || a.y + a.h + padding <= b.y || b.y + b.h + padding <= a.y;
      assert.ok(apart, `placements ${i} and ${j} overlap or violate padding ${padding}`);
    }
    for (const it of items) {
      const p = atlas.placements[it.key];
      assert.equal(p.sourceW, it.image.width);
      assert.equal(p.sourceH, it.image.height);
      // Rebuild the original frame from the atlas region + trim offsets.
      const rebuilt = blank(p.sourceW, p.sourceH);
      for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
        rebuilt.data.set(px(atlas.image, p.x + x, p.y + y), ((p.offsetY + y) * p.sourceW + p.offsetX + x) * 4);
      }
      assert.deepEqual(rebuilt.data, it.image.data, `frame ${it.key} does not round-trip`);
    }
  }
});

test('packAtlas: trimming records offsets; trim:false keeps full frames', () => {
  const img = blank(10, 12);
  fill(img, 3, 4, 2, 5, [9, 9, 9, 255]);
  const t = packAtlas([{ key: 'a', image: img }]).placements.a;
  assert.deepEqual({ w: t.w, h: t.h, offsetX: t.offsetX, offsetY: t.offsetY, trimmed: t.trimmed }, { w: 2, h: 5, offsetX: 3, offsetY: 4, trimmed: true });
  const f = packAtlas([{ key: 'a', image: img }], { trim: false }).placements.a;
  assert.deepEqual({ w: f.w, h: f.h, offsetX: f.offsetX, offsetY: f.offsetY, trimmed: f.trimmed }, { w: 10, h: 12, offsetX: 0, offsetY: 0, trimmed: false });
});

test('packAtlas: identical trimmed frames share one region', () => {
  const a = blank(8, 8), b = blank(8, 8), c = blank(8, 8);
  fill(a, 1, 1, 3, 3, [1, 2, 3, 255]);
  fill(b, 4, 4, 3, 3, [1, 2, 3, 255]); // same pixels, different position
  fill(c, 1, 1, 3, 3, [1, 2, 4, 255]);
  const atlas = packAtlas([{ key: 'a', image: a }, { key: 'b', image: b }, { key: 'c', image: c }], { padding: 0 });
  const { a: pa, b: pb, c: pc } = atlas.placements;
  assert.deepEqual([pa.x, pa.y, pa.w, pa.h], [pb.x, pb.y, pb.w, pb.h]);
  assert.deepEqual([pa.offsetX, pb.offsetX], [1, 4]);
  assert.notDeepEqual([pa.x, pa.y], [pc.x, pc.y]);
  assert.equal(atlas.width * atlas.height, 18); // two 3x3 regions, no waste
});

test('packAtlas: powerOfTwo rounds the page up', () => {
  const atlas = packAtlas(randomFrames(10), { powerOfTwo: true });
  for (const n of [atlas.width, atlas.height]) assert.equal(n & (n - 1), 0);
});

test('packAtlas: throws when frames do not fit', () => {
  const big = blank(40, 40);
  fill(big, 0, 0, 40, 40, [1, 1, 1, 255]);
  assert.throws(() => packAtlas([{ key: 'x', image: big }], { maxSize: 32 }), /exceeds the 32px atlas limit/);
  const items = randomFrames(30).map(it => ({ ...it, image: (() => { const i = blank(16, 16); fill(i, 0, 0, 16, 16, [it.key.length, 0, Number(it.key.slice(1)), 255]); return i; })() }));
  assert.throws(() => packAtlas(items, { maxSize: 64 }), /do not fit in a 64x64 atlas/);
});

test('assetFrames cuts frames keyed by asset/index', () => {
  const frames = assetFrames(asset(), heroSheet());
  assert.deepEqual(frames.map(f => f.key), ['hero/0', 'hero/1', 'hero/2', 'hero/3']);
  assert.deepEqual(px(frames[1].image, 1, 2), [0, 255, 0, 255]);
  assert.deepEqual(frames[0].image.data, frames[3].image.data);
});

test('texturePackerJson: TexturePacker hash shape with animations and pivots', () => {
  const a = asset();
  const atlas = packAtlas(assetFrames(a, heroSheet()));
  const json = JSON.parse(texturePackerJson(atlas, { image: 'atlas.png', assets: [a] }));
  assert.deepEqual(Object.keys(json.frames), ['hero/0', 'hero/1', 'hero/2', 'hero/3']);
  const f1 = json.frames['hero/1'];
  const p1 = atlas.placements['hero/1'];
  assert.deepEqual(f1, {
    frame: { x: p1.x, y: p1.y, w: 6, h: 6 },
    rotated: false,
    trimmed: true,
    spriteSourceSize: { x: 1, y: 2, w: 6, h: 6 },
    sourceSize: { w: 8, h: 8 },
    pivot: { x: 0.5, y: 1 },
  });
  assert.deepEqual(json.frames['hero/0'].frame, json.frames['hero/3'].frame);
  assert.deepEqual(json.animations, { 'hero/idle': ['hero/0', 'hero/1'], 'hero/attack': ['hero/2', 'hero/3', 'hero/1'] });
  assert.deepEqual(json.meta, {
    app: 'Kinetome', version: '1', image: 'atlas.png', format: 'RGBA8888', size: { w: atlas.width, h: atlas.height }, scale: '1',
  });
});

test('phaserAnimsJson: repeat and frames reference the atlas key', () => {
  const json = JSON.parse(phaserAnimsJson([asset()], 'heroes'));
  assert.deepEqual(json.anims[0], {
    key: 'hero/idle', frameRate: 4, repeat: -1,
    frames: [{ key: 'heroes', frame: 'hero/0' }, { key: 'heroes', frame: 'hero/1' }],
  });
  assert.equal(json.anims[1].repeat, 0);
  assert.equal(json.anims[1].frames.length, 3);
});

test('unitySpriteMeta: every sprite with flipped y, point filter, multiple mode, stable ids', () => {
  const a = asset();
  const atlas = packAtlas(assetFrames(a, heroSheet()));
  const meta = unitySpriteMeta(atlas, [a]);
  assert.match(meta, /^fileFormatVersion: 2\nguid: [0-9a-f]{32}\nTextureImporter:/);
  assert.match(meta, /\n    filterMode: 0\n/);
  assert.match(meta, /\n  spriteMode: 2\n/);
  assert.match(meta, /\n    enableMipMap: 0\n/);
  assert.match(meta, /\n  alphaIsTransparency: 1\n/);
  assert.match(meta, /\n    textureCompression: 0\n/);
  assert.match(meta, /\n  spritePixelsToUnits: 100\n/);
  for (let i = 0; i < 4; i++) {
    const p = atlas.placements[`hero/${i}`];
    const block = meta.split('    - serializedVersion: 2\n').find(b => b.startsWith(`      name: hero_${i}\n`));
    assert.ok(block, `sprite hero_${i} missing`);
    assert.ok(block.includes(`        x: ${p.x}\n        y: ${atlas.height - p.y - p.h}\n        width: ${p.w}\n        height: ${p.h}\n`));
    assert.ok(block.includes('      alignment: 9\n'));
    const id = /internalID: (-?\d+)/.exec(block)![1];
    assert.ok(meta.includes(`\n      hero_${i}: ${id}\n`), 'nameFileIdTable entry');
  }
  // Frame 1 is trimmed to (1,2)-(7,8); pivot (4, feet at 8) sits at x=0.5, y=0 of the rect.
  const b1 = meta.split('name: hero_1\n')[1];
  assert.match(b1, /pivot: \{x: 0\.5, y: 0\}/);
  // Deterministic.
  assert.equal(meta, unitySpriteMeta(packAtlas(assetFrames(a, heroSheet())), [a]));
  assert.equal(atlasGuid(atlas).length, 32);
  assert.match(unitySpriteMeta(atlas, [a], { guid: 'abc', pixelsPerUnit: 16 }), /guid: abc\n[\s\S]*spritePixelsToUnits: 16\n/);
});

test('engineExportFiles: expected paths per engine', () => {
  const pairs = [{ asset: asset(), sheet: heroSheet() }, { asset: asset({ id: 'slime' }), sheet: heroSheet() }];
  const png = (img: PixelImage) => new Uint8Array([img.width, img.height]);
  const paths = (e: Parameters<typeof engineExportFiles>[1]) => engineExportFiles(pairs, e, png).map(f => f.path);
  assert.deepEqual(paths('phaser'), ['atlas.png', 'atlas.json', 'anims.json']);
  assert.deepEqual(paths('pixi'), ['atlas.png', 'atlas.json']);
  assert.deepEqual(paths('texturepacker'), ['atlas.png', 'atlas.json']);
  assert.deepEqual(paths('unity'), ['atlas.png', 'atlas.png.meta']);
  const files = engineExportFiles(pairs, 'phaser', png);
  const json = JSON.parse(new TextDecoder().decode(files[1].data));
  assert.equal(Object.keys(json.frames).length, 8);
  assert.deepEqual(json.frames['slime/1'].frame, json.frames['hero/1'].frame); // deduped across assets
  const meta = new TextDecoder().decode(engineExportFiles(pairs, 'unity', png)[1].data);
  assert.ok(meta.includes('name: slime_3'));
});
