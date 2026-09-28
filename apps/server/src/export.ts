import { readFile } from 'node:fs/promises';
import {
  assetFrames, godotFiles, packAtlas, phaserAnimsJson, texturePackerJson, unitySpriteMeta, zip,
  type PixelImage, type SpriteAsset,
} from '@kinetome/core';
import { docFromAsset, encodeAse } from '@kinetome/editor';
import { normalMap, normalMapFrames } from '@kinetome/pixel';
import { decodePng, encodePng } from './png.ts';
import * as store from './store.ts';

/**
 * One export pipeline for every engine: pick sprites, get a zip laid out the way that
 * engine expects, with an optional normal map for 2D lighting and a short README.
 */
export const ENGINES = ['godot', 'phaser', 'pixi', 'unity', 'texturepacker', 'aseprite'] as const;
export type Engine = typeof ENGINES[number];

export interface ExportOptions { assets?: string[]; normals?: boolean; ppu?: number; padding?: number }

const utf8 = (s: string) => new TextEncoder().encode(s);

const README: Record<Engine, string> = {
  godot: `Unzip into your Godot 4 project root (the folder with project.godot).
Each sprite gets <id>.tres (SpriteFrames) and <id>.tscn (an AnimatedSprite2D with nearest filtering, feet on the origin).
Sprites with hitboxes or events also get <id>.gd: it keeps Hitbox/Hurtbox Area2D shapes in step with the frame and emits frame_event(name).
With normal maps, <id>_n.png is next to the sheet and <id>_lit.tres uses them through a CanvasTexture: swap it into the scene's sprite_frames to light the sprite with PointLight2D.`,
  phaser: `Phaser 3:
  this.load.atlas('atlas', 'atlas.png', 'atlas.json');
  this.load.json('anims', 'anims.json');
  // in create():
  this.anims.fromJSON(this.cache.json.get('anims'));
  this.add.sprite(x, y, 'atlas').play('<sprite id>/<animation>');
Frame names are <sprite id>/<frame index>. Set pixelArt: true in the game config.`,
  pixi: `PixiJS (v7/v8):
  const sheet = await PIXI.Assets.load('atlas.json');
  const anim = new PIXI.AnimatedSprite(sheet.animations['<sprite id>/<animation>']);
  anim.texture.source.scaleMode = 'nearest'; // v8 (v7: baseTexture.scaleMode = SCALE_MODES.NEAREST)
atlas.json is TexturePacker's JSON (Hash) format with an "animations" block.`,
  unity: `Unity 2021+:
Copy atlas.png AND atlas.png.meta into your Assets folder together. Unity reads the meta:
Sprite Mode Multiple, Point filter, no compression, one sprite per frame named <sprite id>_<frame index>, pivots on the feet.
Pixels per unit is set from the export dialog. Build animations by dragging a sprite's frames into the scene.`,
  texturepacker: `TexturePacker JSON (Hash) format, read by most engines and frameworks (Phaser, PixiJS, Cocos, Defold plugins, custom loaders).
Frames are trimmed; spriteSourceSize/sourceSize restore the original frame, pivot is normalized to the untrimmed frame.`,
  aseprite: `One .aseprite file per sprite, with its animations as tags and the palette.
Open them in Aseprite (or LibreSprite/Pixelorama). Sprites edited in Kinetome keep their frames; layers are flattened.`,
};

async function loadSprites(p: string, ids?: string[]) {
  const all = await store.listAssets(p);
  const chosen = ids?.length ? all.filter(a => ids.includes(a.id)) : all;
  if (!chosen.length) throw new store.HttpError(400, 'no sprites selected');
  return Promise.all(chosen.map(async asset => ({ asset, sheet: decodePng(await readFile(store.sheetPath(p, asset.id))) })));
}

/** Godot SpriteFrames whose frames sample a CanvasTexture (sheet + normal map) for 2D lights. */
function litSpriteFrames(asset: SpriteAsset, pngPath: string, normalPath: string): string {
  const q = JSON.stringify;
  const used = [...new Set(asset.animations.flatMap(a => a.frames))].sort((a, b) => a - b);
  const out = [`[gd_resource type="SpriteFrames" load_steps=${used.length + 4} format=3]`, '',
    `[ext_resource type="Texture2D" path=${q(pngPath)} id="1_sheet"]`,
    `[ext_resource type="Texture2D" path=${q(normalPath)} id="2_normal"]`, '',
    '[sub_resource type="CanvasTexture" id="CanvasTexture_lit"]', 'diffuse_texture = ExtResource("1_sheet")', 'normal_texture = ExtResource("2_normal")', 'texture_filter = 1', ''];
  for (const i of used) {
    const r = asset.frames[i];
    out.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_f${i}"]`, 'atlas = SubResource("CanvasTexture_lit")', `region = Rect2(${r.x}, ${r.y}, ${r.w}, ${r.h})`, '');
  }
  const anims = asset.animations.map(a => `{\n"frames": [${a.frames.map(i => `{\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_f${i}")\n}`).join(', ')}],\n"loop": ${a.loop},\n"name": &${q(a.name)},\n"speed": ${a.fps.toFixed(1)}\n}`);
  out.push('[resource]', `animations = [${anims.join(', ')}]`, '');
  return out.join('\n');
}

export async function exportZip(p: string, engine: Engine, opts: ExportOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const sprites = await loadSprites(p, opts.assets);
  const files: { path: string; data: Uint8Array }[] = [{ path: 'README.txt', data: utf8(README[engine]) }];
  if (engine === 'godot') {
    const { project } = await store.getProject(p);
    for (const { asset, sheet } of sprites) {
      for (const f of godotFiles(asset, encodePng(sheet), project.godot.dir)) files.push({ path: f.path, data: f.binary ?? utf8(f.text ?? '') });
      if (opts.normals) {
        const base = `${project.godot.dir.replace(/^\/+|\/+$/g, '')}/${asset.id}/${asset.id}`;
        files.push({ path: `${base}_n.png`, data: encodePng(normalMapFrames(sheet, asset.frames)) });
        files.push({ path: `${base}_lit.tres`, data: utf8(litSpriteFrames(asset, `res://${base}.png`, `res://${base}_n.png`)) });
      }
    }
  } else if (engine === 'aseprite') {
    for (const { asset, sheet } of sprites) files.push({ path: `${asset.id}.aseprite`, data: encodeAse(docFromAsset(sheet, asset)) });
  } else {
    const atlas = packAtlas(sprites.flatMap(s => assetFrames(s.asset, s.sheet)), { padding: opts.padding ?? 1 });
    const list = sprites.map(s => s.asset);
    files.push({ path: 'atlas.png', data: encodePng(atlas.image) });
    if (opts.normals) {
      // per placed frame, so neighbours in the atlas never bleed into each other's edges
      const rects = Object.values(atlas.placements).map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
      files.push({ path: 'atlas_n.png', data: encodePng(normalMapFrames(atlas.image, rects)) });
    }
    if (engine === 'unity') files.push({ path: 'atlas.png.meta', data: utf8(unitySpriteMeta(atlas, list, { pixelsPerUnit: opts.ppu ?? 16 })) });
    else {
      files.push({ path: 'atlas.json', data: utf8(texturePackerJson(atlas, { image: 'atlas.png', assets: list })) });
      if (engine === 'phaser') files.push({ path: 'anims.json', data: utf8(phaserAnimsJson(list, 'atlas')) });
    }
  }
  return zip(files);
}

/** A sprite's normal map sheet (for the Lighting preview and single downloads). */
export async function normalSheet(p: string, a: string, opts: { bevel?: number; strength?: number; luminance?: number }): Promise<Buffer> {
  const asset = await store.getAsset(p, a);
  const sheet: PixelImage = decodePng(await readFile(store.sheetPath(p, a)));
  return encodePng(asset.frames.length ? normalMapFrames(sheet, asset.frames, opts) : normalMap(sheet, opts));
}
