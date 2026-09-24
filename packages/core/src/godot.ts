import type { SpriteAsset } from './schema.ts';

/**
 * Godot 4 export. Per asset, under `<dir>/<id>/`:
 *   <id>.png   the sheet
 *   <id>.tres  SpriteFrames resource (one AtlasTexture region per frame)
 *   <id>.tscn  drop-in AnimatedSprite2D scene: nearest filtering, feet on the node origin
 */
export interface GodotFile { path: string; text?: string; binary?: Uint8Array }

const q = (s: string) => JSON.stringify(s); // Godot string literals use JSON-compatible escaping

export function godotPaths(asset: SpriteAsset, dir = 'sprites') {
  const base = `${dir.replace(/^\/+|\/+$/g, '')}/${asset.id}`;
  return {
    png: `${base}/${asset.id}.png`,
    tres: `${base}/${asset.id}.tres`,
    tscn: `${base}/${asset.id}.tscn`,
  };
}

export function spriteFramesTres(asset: SpriteAsset, pngResPath: string): string {
  const used = [...new Set(asset.animations.flatMap(a => a.frames))].sort((a, b) => a - b);
  const subId = (i: number) => `AtlasTexture_f${i}`;
  const out: string[] = [];
  out.push(`[gd_resource type="SpriteFrames" load_steps=${used.length + 2} format=3]`, '');
  out.push(`[ext_resource type="Texture2D" path=${q(pngResPath)} id="1_sheet"]`, '');
  for (const i of used) {
    const r = asset.frames[i];
    out.push(`[sub_resource type="AtlasTexture" id="${subId(i)}"]`);
    out.push('atlas = ExtResource("1_sheet")');
    out.push(`region = Rect2(${r.x}, ${r.y}, ${r.w}, ${r.h})`, '');
  }
  const anims = asset.animations.map(a => [
    '{',
    `"frames": [${a.frames.map(i => `{\n"duration": 1.0,\n"texture": SubResource("${subId(i)}")\n}`).join(', ')}],`,
    `"loop": ${a.loop},`,
    `"name": &${q(a.name)},`,
    `"speed": ${a.fps.toFixed(1)}`,
    '}',
  ].join('\n'));
  out.push('[resource]', `animations = [${anims.join(', ')}]`, '');
  return out.join('\n');
}

export function animatedSpriteTscn(asset: SpriteAsset, tresResPath: string): string {
  const first = asset.animations.find(a => /idle/i.test(a.name)) ?? asset.animations[0];
  const nodeName = asset.name.replace(/[^A-Za-z0-9_]+/g, '') || 'Sprite';
  // centered = false + integer offset keeps pixels on the grid; the feet (pivot) sit on the node origin.
  const lines = [
    '[gd_scene load_steps=2 format=3]', '',
    `[ext_resource type="SpriteFrames" path=${q(tresResPath)} id="1_frames"]`, '',
    `[node name=${q(nodeName)} type="AnimatedSprite2D"]`,
    'texture_filter = 1',
    'sprite_frames = ExtResource("1_frames")',
  ];
  if (first) lines.push(`animation = &${q(first.name)}`, `autoplay = ${q(first.name)}`);
  lines.push('centered = false', `offset = Vector2(${-asset.pivot.x}, ${-(asset.pivot.y + 1)})`, '');
  return lines.join('\n');
}

export function godotFiles(asset: SpriteAsset, png: Uint8Array, dir = 'sprites'): GodotFile[] {
  const p = godotPaths(asset, dir);
  return [
    { path: p.png, binary: png },
    { path: p.tres, text: spriteFramesTres(asset, `res://${p.png}`) },
    { path: p.tscn, text: animatedSpriteTscn(asset, `res://${p.tres}`) },
  ];
}
