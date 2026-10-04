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
    animations: [{ name: 'default', frames: [0], fps: 10, loop: true }], tags: [], description: '', reference: false, createdAt: '', updatedAt: '',
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

test('Godot export: SpriteFrames .tres + AnimatedSprite2D .tscn', async () => {
  const { godotFiles, parseSheet: parse } = await import('./index.ts');
  const json = JSON.parse(readFileSync(new URL('../../../samples/wizard/wizard.json', import.meta.url), 'utf8'));
  const p = parse(json);
  const asset: SpriteAsset = {
    version: 1, id: 'wizard', name: 'Old Wizard', kind: 'character', source: 'code', image: 'sheet.png',
    frameWidth: p.cellW, frameHeight: p.cellH, frames: p.frames.map(f => f.rect), pivot: { x: 20, y: 50 },
    animations: p.animations, tags: [], description: '', reference: true, createdAt: '', updatedAt: '',
  };
  const files = godotFiles(asset, new Uint8Array([1, 2, 3]), 'art/sprites');
  assert.deepEqual(files.map(f => f.path), ['art/sprites/wizard/wizard.png', 'art/sprites/wizard/wizard.tres', 'art/sprites/wizard/wizard.tscn']);
  const tres = files[1].text!;
  assert.match(tres, /^\[gd_resource type="SpriteFrames" load_steps=52 format=3\]/); // 50 atlas regions + texture + resource
  assert.match(tres, /\[ext_resource type="Texture2D" path="res:\/\/art\/sprites\/wizard\/wizard.png" id="1_sheet"\]/);
  assert.equal((tres.match(/\[sub_resource type="AtlasTexture"/g) ?? []).length, 50);
  assert.match(tres, /region = Rect2\(48, 56, 48, 56\)/); // charge frame 1
  assert.match(tres, /"name": &"cast",\n"speed": 10\.0/);
  assert.match(tres, /"loop": false,\n"name": &"charge"/);
  const tscn = files[2].text!;
  assert.match(tscn, /\[node name="OldWizard" type="AnimatedSprite2D"\]/);
  assert.match(tscn, /texture_filter = 1\n/);
  assert.match(tscn, /autoplay = "idle"/);
  assert.match(tscn, /offset = Vector2\(-20, -51\)/); // feet on node origin
});

test('zip writer produces a valid archive', async () => {
  const { zip, crc32 } = await import('./index.ts');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926); // standard CRC-32 check value
  const z = zip([{ path: 'a/b.txt', data: new TextEncoder().encode('hello') }]);
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint32(z.length - 22, true), 0x06054b50);
  assert.equal(dv.getUint16(z.length - 22 + 10, true), 1);
});

test('Prompt Kit: prompts carry style, layout and per-frame poses', async () => {
  const { referencePrompt, animationPrompt, PLATFORMER_MOVES } = await import('./index.ts');
  const c = { name: 'Mira', description: 'a small fox knight with a red scarf and a round shield' };
  const ref = referencePrompt(DEFAULT_STYLE, c);
  assert.match(ref, /fox knight/);
  assert.match(ref, /#00FF00/);
  assert.match(ref, /32 pixels tall/);
  const walk = PLATFORMER_MOVES.find(m => m.id === 'walk')!;
  const p = animationPrompt(DEFAULT_STYLE, c, walk);
  assert.match(p, /exactly 8 frames in ONE horizontal row/);
  assert.match(p, /\n8\. up: pushing off left toes/);
  assert.match(p, /No text, no labels/);
  assert.ok(PLATFORMER_MOVES.every(m => m.poses.length === m.frames), 'pose list matches frame count');
});

test('rampFor: darker cool shadow, lighter warm highlight', async () => {
  const { rampFor, hexToRgb: h2r, rgbToOklab: lab } = await import('./index.ts');
  const r = rampFor('#3d5aa8');
  const L = (hex: string) => lab(...h2r(hex))[0];
  assert.ok(L(r.shadow) < L(r.base) && L(r.base) < L(r.light), JSON.stringify(r));
  assert.equal(r.base, '#3d5aa8');
  const grey = rampFor('#808080');
  assert.notEqual(grey.shadow, grey.light);
});

test('design palette names every part in three shades plus outline', async () => {
  const { designColors, designMovePrompt, newMove } = await import('./index.ts');
  const design = {
    id: 'kai', name: 'Kai', lore: 'exiled blade dancer', personality: 'calm', build: 'lean', outfit: 'long coat', details: 'scar over left eye',
    parts: [{ name: 'Main cloth', color: '#3d5aa8' }, { name: 'Skin', color: '#e8b796' }], outline: '#1a1420', pixelHeight: 40,
    description: 'a lean blade dancer in a long blue coat', referencePose: 'idle', assetId: null, moves: [], code: null, createdAt: '', updatedAt: '',
    invariants: ['Left leg is a wooden peg from the knee down'], codeRig: false, programs: {},
  };
  const c = designColors(design);
  assert.deepEqual(Object.keys(c).sort(), ['main-cloth', 'main-cloth.light', 'main-cloth.shadow', 'outline', 'skin', 'skin.light', 'skin.shadow']);
  const m = { ...newMove('attack'), description: 'spins once then cuts upward', effects: 'red sash arc', poses: ['a', 'b', 'c', 'd', 'e', 'f'] };
  const p = designMovePrompt(DEFAULT_STYLE, design, m);
  assert.match(p, /How Kai performs it: spins once then cuts upward/);
  assert.match(p, /Effects: red sash arc/);
  assert.match(p, /- Main cloth: base #3d5aa8/);
  assert.match(p, /\n6 \(row 2, column 3\): f/, 'six frames become a 2x3 grid with positions');
  assert.match(p, /A grid of 2 rows x 3 columns = exactly 6 frames/);
  assert.match(p, /NEVER CHANGES[^]*- Left leg is a wooden peg/);
  assert.match(p, /every frame shows: Left leg is a wooden peg/);
  assert.match(p, /SAME SCALE IN EVERY FRAME/);
  assert.match(p, /about 40 pixels tall/);
  const { layoutFor } = await import('./index.ts');
  assert.deepEqual([4, 6, 8, 10, 12].map(n => layoutFor(n)), [{ rows: 1, cols: 4 }, { rows: 2, cols: 3 }, { rows: 2, cols: 4 }, { rows: 3, cols: 4 }, { rows: 3, cols: 4 }]);
});

test('sprite program renders frames with palette names only', async () => {
  const { validateProgram, renderProgram, contactSheet } = await import('./index.ts');
  const code = `const sprite = {
    width: 16, height: 16, pivot: [8, 15],
    animations: { idle: { frames: 2, fps: 4, loop: true } },
    draw(g, anim, frame, t) { g.rect(4, 6 + frame, 8, 10 - frame, 'body'); g.outline(); },
  }; return sprite;`;
  const program = validateProgram(new Function(code)());
  const out = renderProgram(program, { body: '#ff0000', outline: '#000000' });
  assert.equal(out.animations[0].frames.length, 2);
  const f0 = out.animations[0].frames[0];
  assert.deepEqual([...f0.data.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)], [255, 0, 0, 255]);
  assert.deepEqual([...f0.data.slice((8 * 16 + 3) * 4, (8 * 16 + 3) * 4 + 4)], [0, 0, 0, 255], 'outline drawn');
  assert.ok(contactSheet(out).width > 32);
  const bad = validateProgram(new Function(code.replace("'body'", "'#ff0000'"))());
  assert.throws(() => renderProgram(bad, { body: '#ff0000', outline: '#000000' }), /Unknown color "#ff0000"/);
  assert.throws(() => validateProgram({ width: 4 }), /integer 8\.\.256/);
});

test('rig parts: cut from the reference, moved, rotated, flipped', async () => {
  const { makeGfx } = await import('./index.ts');
  const ref = blank(10, 10);
  fill(ref, 2, 2, 2, 6, RED);                 // a vertical "leg" 2x6 at (2,2)
  const rig = { ref, pad: 3, parts: { leg: { poly: [[1, 1], [5, 1], [5, 9], [1, 9]] as [number, number][], pivot: [3, 2] as [number, number] } } };
  const at = (img: ReturnType<typeof blank>, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
  const a = blank(16, 16);
  makeGfx(a, {}, 1, rig).part('leg');
  assert.equal(at(a, 5, 5), 255, 'drawn in place (+pad)');
  assert.equal(at(a, 5, 11), 0);
  const b = blank(16, 16);
  makeGfx(b, {}, 1, rig).part('leg', 4, 0);
  assert.equal(at(b, 9, 5), 255, 'moved right by 4');
  const c = blank(16, 16);
  makeGfx(c, {}, 1, rig).part('leg', 0, 0, 90);
  // rotated 90deg clockwise around the hip (3,2)+pad: the leg now points left
  assert.equal(at(c, 3, 5), 255, JSON.stringify([...Array(16)].map((_, y) => [...Array(16)].map((_, x) => at(c, x, y) ? '#' : '.').join('')).join('/')));
  assert.equal(at(c, 5, 9), 0);
});

test('godot export: frame data script + Hitbox/Hurtbox areas only when the sprite has game data', async () => {
  const { godotFiles, frameDataScript } = await import('./index.ts');
  const base = {
    version: 1 as const, id: 'hero', name: 'Hero', kind: 'character' as const, source: 'code' as const, image: 'sheet.png',
    frameWidth: 32, frameHeight: 32, frames: [{ x: 0, y: 0, w: 32, h: 32 }, { x: 32, y: 0, w: 32, h: 32 }], pivot: { x: 16, y: 31 },
    animations: [{ name: 'attack', frames: [0, 1], fps: 12, loop: false }], tags: [], description: '', reference: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  assert.equal(godotFiles(base, new Uint8Array([1])).length, 3, 'no script without game data');
  const withData = { ...base, frameData: { '1': { hitboxes: [{ x: 20, y: 10, w: 8, h: 4 }], hurtboxes: [], events: ['impact'] } } };
  const files = godotFiles(withData, new Uint8Array([1]));
  assert.deepEqual(files.map(f => f.path.split('/').pop()), ['hero.png', 'hero.tres', 'hero.tscn', 'hero.gd']);
  const tscn = files[2].text!;
  assert.match(tscn, /load_steps=3/);
  assert.match(tscn, /\[ext_resource type="Script" path="res:\/\/sprites\/hero\/hero.gd" id="2_data"\]/);
  assert.match(tscn, /\[node name="Hitbox" type="Area2D" parent="\."\]/);
  const gd = frameDataScript(withData);
  assert.match(gd, /^extends AnimatedSprite2D/);
  assert.match(gd, /"attack": \[\n\t\t\{"hit": \[\], "hurt": \[\], "events": \[\]\},\n\t\t\{"hit": \[Rect2\(20, 10, 8, 4\)\], "hurt": \[\], "events": \["impact"\]\}/);
  assert.match(gd, /const FRAME_W := 32/);
  assert.ok(!/ {4}/.test(gd.split('\n').filter(l => !l.startsWith('##')).join('\n')), 'GDScript indents with tabs');
});

test('video route: key avoids the character colours; locomotion is 5 s pinned in profile', async () => {
  const { videoKeyFor, videoMovePrompt, newMove } = await import('./index.ts');
  assert.equal(videoKeyFor(['#5e0a3c', '#3c004a', '#c8a080']).name, 'green', 'purple/maroon character -> green key');
  assert.equal(videoKeyFor(['#2e8b3c', '#c8a080']).name, 'magenta', 'green character -> magenta key');
  const design = { id: 't', name: 'Thief', description: 'hooded thief', invariants: [], parts: [], outline: '#111', pixelHeight: 64 } as never;
  const run = videoMovePrompt(design, newMove('run'), { hex: '#00FF00', name: 'green' });
  assert.equal(run.seconds, 5); assert.equal(run.pinEnd, true);
  assert.match(run.prompt, /treadmill/); assert.match(run.prompt, /never see its chest or its back/); assert.match(run.prompt, /green \(#00FF00\)/);
  assert.match(run.negative, /standing still/);
  const death = videoMovePrompt(design, newMove('death'), { hex: '#FF00FF', name: 'magenta' });
  assert.equal(death.pinEnd, false);
  const atk = videoMovePrompt(design, { ...newMove('attack'), effects: 'red slash arc' }, { hex: '#FF00FF', name: 'magenta' });
  assert.match(atk.prompt, /returns to the starting ready pose/); assert.match(atk.prompt, /no glow/);
});
