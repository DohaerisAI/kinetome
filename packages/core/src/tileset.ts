import type { PixelImage } from './color.ts';

/**
 * Blob-47 autotile maker for Godot 4 side-view platformers.
 *
 * The artist draws a small template (RPG Maker A2 style, 2 x 3 tiles of size T, T even);
 * every tile is split into four T/2 quarters and each output quarter is picked from the
 * template by looking at the two orthogonal neighbours and the diagonal between them.
 *
 *        col 0         col 1
 *     +---------+---------+
 *  0  | single  |  inner  |   single: used verbatim for an isolated tile (mask 0)
 *     |  tile   | corners |   inner:  each quarter is the inner-corner piece for that corner
 *     +---------+---------+
 *  1  | ┌─ ─ ─ ─ ─ ─ ─ ┐ |   rows 1-2: one 2T x 2T block drawn as a single chunk of
 *     | │  a 2x2 chunk  │ |   terrain with outer edges all round. Cut into a 4x4 grid of
 *  2  | │  with edges   │ |   quarters: corners = outer corners, border = straight edges,
 *     | └─ ─ ─ ─ ─ ─ ─ ┘ |   centre 2x2 = interior fill.
 *     +---------+---------+
 */

/** Template geometry in tiles, for UI guides. `cells` rects are in tile units. */
export const TEMPLATE_LAYOUT = {
  columns: 2,
  rows: 3,
  cells: [
    { id: 'single', x: 0, y: 0, w: 1, h: 1, label: 'Single tile', hint: 'Used as-is for a lone tile with no neighbours.' },
    { id: 'inner', x: 1, y: 0, w: 1, h: 1, label: 'Inner corners', hint: 'Each quarter is the notch where two sides meet but the diagonal is open.' },
    { id: 'block', x: 0, y: 1, w: 2, h: 2, label: 'Terrain block', hint: 'A 2x2 chunk with outer edges; corners, sides and centre are cut into quarters.' },
  ],
} as const;

/** Neighbour bits, clockwise from north. */
export const N = 1, NE = 2, E = 4, SE = 8, S = 16, SW = 32, W = 64, NW = 128;

export interface BlobTile { index: number; mask: number }
export interface Blob47 { image: PixelImage; columns: number; tile: number; tiles: BlobTile[] }

/** Drops diagonal bits whose two adjacent sides aren't both set (they can't change the look). */
export function normalizeMask(m: number): number {
  let out = m & (N | E | S | W);
  if ((m & NE) && (m & N) && (m & E)) out |= NE;
  if ((m & SE) && (m & S) && (m & E)) out |= SE;
  if ((m & SW) && (m & S) && (m & W)) out |= SW;
  if ((m & NW) && (m & N) && (m & W)) out |= NW;
  return out;
}

/** The 47 canonical blob masks, ascending. */
export const BLOB47_MASKS: number[] = [...new Set(Array.from({ length: 256 }, (_, m) => normalizeMask(m)))].sort((a, b) => a - b);

function blank(w: number, h: number): PixelImage {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

function blit(src: PixelImage, sx: number, sy: number, dst: PixelImage, dx: number, dy: number, w: number, h: number) {
  for (let j = 0; j < h; j++) {
    const s = ((sy + j) * src.width + sx) * 4;
    dst.data.set(src.data.subarray(s, s + w * 4), ((dy + j) * dst.width + dx) * 4);
  }
}

/** Template pixel origin of the source quarter for quarter (qx,qy) of a tile with `mask`. */
function quarterSource(mask: number, qx: number, qy: number, t: number): [number, number] {
  const h = t / 2;
  const side = mask & (qx ? E : W), vert = mask & (qy ? S : N);
  const diag = mask & (qx ? (qy ? SE : NE) : (qy ? SW : NW));
  // Block quarters live in a 4x4 grid starting at tile row 1; parity keeps textures continuous.
  const block = (bx: number, by: number): [number, number] => [bx * h, t + by * h];
  const inner = qx ? 1 : 2, outer = qx * 3;
  const innerY = qy ? 1 : 2, outerY = qy * 3;
  if (!side && !vert) return block(outer, outerY);
  if (!side) return block(outer, innerY); // left/right edge
  if (!vert) return block(inner, outerY); // top/bottom edge
  if (!diag) return [t + qx * h, qy * h]; // inner corner
  return block(inner, innerY);
}

/** Expands a 2x3 template (see TEMPLATE_LAYOUT) into the 47 blob tiles, `columns` per row. */
export function expandBlob47(source: PixelImage, tile: number, columns = 8): Blob47 {
  if (tile < 2 || tile % 2) throw new Error('tile size must be even');
  if (source.width < tile * 2 || source.height < tile * 3) throw new Error(`template must be at least ${tile * 2}x${tile * 3}`);
  const h = tile / 2;
  const rows = Math.ceil(BLOB47_MASKS.length / columns);
  const image = blank(columns * tile, rows * tile);
  const tiles = BLOB47_MASKS.map((mask, index) => {
    const ox = (index % columns) * tile, oy = Math.floor(index / columns) * tile;
    if (mask === 0) blit(source, 0, 0, image, ox, oy, tile, tile);
    else for (let qy = 0; qy < 2; qy++) for (let qx = 0; qx < 2; qx++) {
      const [sx, sy] = quarterSource(mask, qx, qy, tile);
      blit(source, sx, sy, image, ox + qx * h, oy + qy * h, h, h);
    }
    return { index, mask };
  });
  return { image, columns, tile, tiles };
}

// Godot 4 square-tile peering bits (mode 0 "Match Corners and Sides") in mask-bit order.
const PEERING: [number, string][] = [
  [E, 'right_side'], [SE, 'bottom_right_corner'], [S, 'bottom_side'], [SW, 'bottom_left_corner'],
  [W, 'left_side'], [NW, 'top_left_corner'], [N, 'top_side'], [NE, 'top_right_corner'],
];

const q = (s: string) => JSON.stringify(s);

/** Godot 4 TileSet resource: one atlas source, one terrain (Match Corners and Sides), optional full-tile collision. */
export function godotTileSetTres(opts: {
  texturePath: string;
  tile: number;
  columns: number;
  tiles: BlobTile[];
  terrainName?: string;
  physics?: boolean;
}): string {
  const { texturePath, tile: t, columns, tiles, terrainName = 'Terrain', physics = true } = opts;
  const h = t / 2;
  const out: string[] = [];
  out.push('[gd_resource type="TileSet" load_steps=3 format=3]', '');
  out.push(`[ext_resource type="Texture2D" path=${q(texturePath)} id="1_atlas"]`, '');
  out.push('[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_blob"]');
  out.push('texture = ExtResource("1_atlas")', `texture_region_size = Vector2i(${t}, ${t})`);
  for (const { index, mask } of tiles) {
    const k = `${index % columns}:${Math.floor(index / columns)}/0`;
    out.push(`${k} = 0`, `${k}/terrain_set = 0`, `${k}/terrain = 0`);
    for (const [bit, name] of PEERING) if (mask & bit) out.push(`${k}/terrains_peering_bit/${name} = 0`);
    if (physics) out.push(`${k}/physics_layer_0/polygon_0/points = PackedVector2Array(${-h}, ${-h}, ${h}, ${-h}, ${h}, ${h}, ${-h}, ${h})`);
  }
  out.push('', '[resource]', `tile_size = Vector2i(${t}, ${t})`);
  if (physics) out.push('physics_layer_0/collision_layer = 1');
  out.push(
    'terrain_set_0/mode = 0',
    `terrain_set_0/terrain_0/name = ${q(terrainName)}`,
    'terrain_set_0/terrain_0/color = Color(0.5, 0.75, 0.35, 1)',
    'sources/0 = SubResource("TileSetAtlasSource_blob")', '',
  );
  return out.join('\n');
}

/** Picks and renders blob tiles for a row-major solid map; out-of-bounds counts as empty. */
export function paintMap(width: number, height: number, cells: boolean[], expanded: Blob47) {
  const byMask = new Map(expanded.tiles.map(t => [t.mask, t.index]));
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && !!cells[y * width + x];
  const tileIndexAt = (x: number, y: number): number => {
    if (!solid(x, y)) return -1;
    const m = (solid(x, y - 1) ? N : 0) | (solid(x + 1, y - 1) ? NE : 0) | (solid(x + 1, y) ? E : 0) | (solid(x + 1, y + 1) ? SE : 0)
      | (solid(x, y + 1) ? S : 0) | (solid(x - 1, y + 1) ? SW : 0) | (solid(x - 1, y) ? W : 0) | (solid(x - 1, y - 1) ? NW : 0);
    return byMask.get(normalizeMask(m)) ?? -1;
  };
  const render = (): PixelImage => {
    const t = expanded.tile, img = blank(width * t, height * t);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = tileIndexAt(x, y);
      if (i >= 0) blit(expanded.image, (i % expanded.columns) * t, Math.floor(i / expanded.columns) * t, img, x * t, y * t, t, t);
    }
    return img;
  };
  return { tileIndexAt, render };
}

/** Starter 2x3 template: `fill` terrain with 1px `edge` outlines where edges and inner corners go. */
export function blankTemplate(tile: number, fill: [number, number, number] = [124, 88, 60], edge: [number, number, number] = [84, 160, 68]): PixelImage {
  if (tile < 2 || tile % 2) throw new Error('tile size must be even');
  const img = blank(tile * 2, tile * 3);
  const put = (x: number, y: number, c: [number, number, number]) => img.data.set([...c, 255], (y * img.width + x) * 4);
  const box = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      put(x, y, x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1 ? edge : fill);
    }
  };
  box(0, 0, tile, tile); // single
  box(0, tile, tile * 2, tile * 2); // block
  // inner corners: solid fill with a notch pixel at each tile corner
  for (let y = 0; y < tile; y++) for (let x = tile; x < tile * 2; x++) put(x, y, fill);
  for (const [x, y] of [[tile, 0], [tile * 2 - 1, 0], [tile, tile - 1], [tile * 2 - 1, tile - 1]]) put(x, y, edge);
  return img;
}
