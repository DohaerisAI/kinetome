import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PixelImage } from './color.ts';
import {
  expandBlob47, godotTileSetTres, paintMap, blankTemplate, normalizeMask, BLOB47_MASKS, TEMPLATE_LAYOUT,
  N, NE, E, SE, S, SW, W, NW,
} from './tileset.ts';

const T = 4, H = T / 2;

/** Template where every T/2 quarter is a flat, unique colour: red = quarter column, green = quarter row. */
function quarterTemplate(): PixelImage {
  const img = { width: T * 2, height: T * 3, data: new Uint8ClampedArray(T * 2 * T * 3 * 4) };
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    img.data.set([Math.floor(x / H) * 10, Math.floor(y / H) * 10, 7, 255], (y * img.width + x) * 4);
  }
  return img;
}

/** Template quarter coords [qx, qy] each output quarter came from (checked flat per quarter). */
function quarters(r: ReturnType<typeof expandBlob47>, mask: number): [number, number][] {
  const t = r.tiles.find(t => t.mask === mask)!;
  const ox = (t.index % r.columns) * T, oy = Math.floor(t.index / r.columns) * T;
  const out: [number, number][] = [];
  for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const at = (x: number, y: number) => (y * r.image.width + x) * 4;
    const p = at(ox + qx * H, oy + qy * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < H; i++) {
      assert.equal(r.image.data[at(ox + qx * H + i, oy + qy * H + j)], r.image.data[p]);
    }
    out.push([r.image.data[p] / 10, r.image.data[p + 1] / 10]);
  }
  return out; // order: NW, NE, SW, SE
}

const ALL = N | NE | E | SE | S | SW | W | NW;

test('47 unique normalized masks, laid out 8 wide', () => {
  assert.equal(BLOB47_MASKS.length, 47);
  const r = expandBlob47(quarterTemplate(), T);
  assert.equal(r.tiles.length, 47);
  assert.equal(new Set(r.tiles.map(t => t.mask)).size, 47);
  assert.equal(r.columns, 8);
  assert.deepEqual([r.image.width, r.image.height], [8 * T, 6 * T]);
  assert.equal(normalizeMask(NE | NW | SE | SW), 0);
  assert.equal(TEMPLATE_LAYOUT.columns * TEMPLATE_LAYOUT.rows, 6);
});

test('quarters come from the right template regions', () => {
  const r = expandBlob47(quarterTemplate(), T);
  // isolated = single tile verbatim (quarters 0..1 x 0..1)
  assert.deepEqual(quarters(r, 0), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  // full interior = centre 2x2 of the block (block quarter rows start at 2), parity preserved
  assert.deepEqual(quarters(r, ALL), [[2, 4], [1, 4], [2, 3], [1, 3]]);
  // top edge of a long platform (E, W, S and both lower diagonals solid): top quarters from the block's top border
  assert.deepEqual(quarters(r, E | SE | S | SW | W), [[2, 2], [1, 2], [2, 3], [1, 3]]);
  // everything solid except NE diagonal: NE quarter is the inner-corner tile's NE quarter
  assert.deepEqual(quarters(r, ALL & ~NE), [[2, 4], [3, 0], [2, 3], [1, 3]]);
  // lone vertical run (N and S only): left/right edges from block sides
  assert.deepEqual(quarters(r, N | S), [[0, 4], [3, 4], [0, 3], [3, 3]]);
  // outer corners: top-left corner of a big block (E, S, SE)
  assert.deepEqual(quarters(r, E | SE | S), [[0, 2], [1, 2], [0, 3], [1, 3]]);
});

test('paintMap picks isolated for a lone cell and interior for 3x3 centre', () => {
  const r = expandBlob47(quarterTemplate(), T);
  const idx = (m: number) => r.tiles.find(t => t.mask === m)!.index;
  const lone = paintMap(3, 3, [false, false, false, false, true, false, false, false, false], r);
  assert.equal(lone.tileIndexAt(1, 1), idx(0));
  assert.equal(lone.tileIndexAt(0, 0), -1);
  const block = paintMap(3, 3, Array(9).fill(true), r);
  assert.equal(block.tileIndexAt(1, 1), idx(ALL));
  assert.equal(block.tileIndexAt(0, 0), idx(E | SE | S));
  const img = block.render();
  assert.deepEqual([img.width, img.height], [3 * T, 3 * T]);
  // centre cell's NW pixel = interior quarter (2,4)
  const p = ((T) * img.width + T) * 4;
  assert.deepEqual([...img.data.slice(p, p + 2)], [20, 40]);
});

test('godotTileSetTres emits 47 terrain tiles with matching peering bits and physics', () => {
  const r = expandBlob47(quarterTemplate(), T);
  const tres = godotTileSetTres({ texturePath: 'res://tiles/ground.png', tile: T, columns: r.columns, tiles: r.tiles, terrainName: 'Ground' });
  assert.match(tres, /^\[gd_resource type="TileSet" load_steps=3 format=3\]/);
  assert.match(tres, /texture_region_size = Vector2i\(4, 4\)/);
  assert.match(tres, /terrain_set_0\/mode = 0/);
  assert.match(tres, /terrain_set_0\/terrain_0\/name = "Ground"/);
  assert.equal(tres.match(/^\d+:\d+\/0 = 0$/gm)!.length, 47);
  assert.equal(tres.match(/\/terrain_set = 0$/gm)!.length, 47);
  assert.equal(tres.match(/physics_layer_0\/polygon_0\/points = PackedVector2Array\(-2, -2, 2, -2, 2, 2, -2, 2\)/g)!.length, 47);
  const names: [number, string][] = [[N, 'top_side'], [NE, 'top_right_corner'], [E, 'right_side'], [SE, 'bottom_right_corner'],
    [S, 'bottom_side'], [SW, 'bottom_left_corner'], [W, 'left_side'], [NW, 'top_left_corner']];
  for (const { index, mask } of r.tiles) {
    const k = `${index % 8}:${Math.floor(index / 8)}/0`;
    for (const [bit, name] of names) {
      assert.equal(tres.includes(`${k}/terrains_peering_bit/${name} = 0\n`), !!(mask & bit), `${k} ${name}`);
    }
  }
  const bare = godotTileSetTres({ texturePath: 'res://t.png', tile: T, columns: 8, tiles: r.tiles, physics: false });
  assert.doesNotMatch(bare, /physics_layer/);
});

test('blankTemplate is 2x3 tiles and expands cleanly', () => {
  const img = blankTemplate(16);
  assert.deepEqual([img.width, img.height], [32, 48]);
  assert.equal(img.data[3], 255);
  assert.equal(expandBlob47(img, 16).tiles.length, 47);
});
