import { useEffect, useMemo, useRef, useState } from 'react';
import {
  blankTemplate, expandBlob47, godotTileSetTres, paintMap, TEMPLATE_LAYOUT, zip,
  type PixelImage, type SpriteAsset, type StyleBible,
} from '@kinetome/core';
import { api, type AssetDraft } from '../api.ts';
import { Icon } from '../icons.tsx';
import { download, drawChecker, toPixels, useImage } from '../pixels.ts';
import { PageHeader } from './PageHeader.tsx';

const toCanvas = (img: PixelImage) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0); return c; };
const pngOf = (img: PixelImage) => new Promise<Blob>((res, rej) => toCanvas(img).toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
const hexRgb = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lum = (h: string) => { const [r, g, b] = hexRgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

/** A little test level: a floor, a platform, a pillar, so every blob case shows up. */
function starterMap(w: number, h: number): boolean[] {
  const m = new Array(w * h).fill(false);
  const set = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < w && y < h) m[y * w + x] = true; };
  for (let x = 0; x < w; x++) for (let y = h - 3; y < h; y++) set(x, y);
  for (let x = 3; x < 9; x++) set(x, h - 7);
  for (let x = 4; x < 8; x++) set(x, h - 8);
  for (let y = h - 9; y < h - 3; y++) { set(w - 5, y); set(w - 4, y); }
  set(12, h - 5); set(13, h - 4);
  return m;
}

/**
 * Tileset maker: paint a small template (in the sprite editor, like any sprite), get the
 * full 47-tile blob set, paint a test map that autotiles live, and export a Godot TileSet
 * with terrain peering bits and collision already set up.
 */
export function TilesView({ projectId, assets, style, onCreated, onEdit, fail, notify }: {
  projectId: string; assets: SpriteAsset[]; style: StyleBible;
  onCreated: (a: SpriteAsset) => void; onEdit: (id: string) => void; fail: (e: unknown) => void; notify: (m: string) => void;
}) {
  const templates = assets.filter(a => a.kind === 'tile' && a.tags.includes('tile-template'));
  const [sel, setSel] = useState<string | null>(null);
  const tpl = templates.find(t => t.id === sel) ?? templates[0] ?? null;
  const tile = tpl ? tpl.frameWidth / TEMPLATE_LAYOUT.columns : 16;
  const img = useImage(tpl ? api.sheetUrl(projectId, tpl) : null);
  const [size, setSize] = useState(16);
  const [name, setName] = useState('ground');
  const MW = 24, MH = 14;
  const [cells, setCells] = useState<boolean[]>(() => starterMap(MW, MH));
  const painting = useRef<boolean | null>(null);
  const mapCanvas = useRef<HTMLCanvasElement>(null);
  const sheetCanvas = useRef<HTMLCanvasElement>(null);
  const tplCanvas = useRef<HTMLCanvasElement>(null);

  const expanded = useMemo(() => {
    if (!img) return null;
    try { return expandBlob47(toPixels(img), tile); } catch (e) { fail(e); return null; }
  }, [img, tile]); // eslint-disable-line react-hooks/exhaustive-deps

  // template with its guides
  useEffect(() => {
    const c = tplCanvas.current;
    if (!c || !img) return;
    const z = Math.max(2, Math.floor(200 / (tile * 2)));
    c.width = tile * 2 * z; c.height = tile * 3 * z;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    drawChecker(g, c.width, c.height, 6);
    g.drawImage(img, 0, 0, c.width, c.height);
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.setLineDash([3, 3]);
    for (const cell of TEMPLATE_LAYOUT.cells) g.strokeRect(cell.x * tile * z + 0.5, cell.y * tile * z + 0.5, cell.w * tile * z - 1, cell.h * tile * z - 1);
    g.setLineDash([]);
  }, [img, tile]);

  // the expanded sheet and the painted test map
  useEffect(() => {
    if (!expanded) return;
    const sc = sheetCanvas.current;
    if (sc) {
      const z = Math.max(1, Math.floor(300 / expanded.image.width));
      sc.width = expanded.image.width * z; sc.height = expanded.image.height * z;
      const g = sc.getContext('2d')!; g.imageSmoothingEnabled = false;
      drawChecker(g, sc.width, sc.height, 6);
      g.drawImage(toCanvas(expanded.image), 0, 0, sc.width, sc.height);
    }
    const mc = mapCanvas.current;
    if (mc) {
      const map = paintMap(MW, MH, cells, expanded).render();
      const z = Math.max(2, Math.floor(Math.min(900 / map.width, 520 / map.height)));
      mc.width = map.width * z; mc.height = map.height * z;
      const g = mc.getContext('2d')!; g.imageSmoothingEnabled = false;
      const sky = [...style.palette].sort((a, b) => lum(a) - lum(b));
      g.fillStyle = sky[Math.floor(sky.length * 0.12)] ?? '#14131f'; g.fillRect(0, 0, mc.width, mc.height);
      g.drawImage(toCanvas(map), 0, 0, mc.width, mc.height);
    }
  }, [expanded, cells, style.palette]);

  const cellAt = (e: React.PointerEvent) => {
    const c = mapCanvas.current!, r = c.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * MW), y = Math.floor(((e.clientY - r.top) / r.height) * MH);
    return x >= 0 && y >= 0 && x < MW && y < MH ? y * MW + x : -1;
  };
  const paintAt = (e: React.PointerEvent) => {
    const i = cellAt(e);
    if (i < 0 || painting.current === null) return;
    setCells(cs => (cs[i] === painting.current ? cs : cs.map((v, k) => (k === i ? painting.current! : v))));
  };

  const newTemplate = async () => {
    // the palette's closest dirt and grass, so the starter already looks like this project
    type RGB = [number, number, number];
    const d2 = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const nearest = (t: RGB, from: RGB[]) => from.reduce((best, c) => (d2(c, t) < d2(best, t) ? c : best), from[0] ?? t);
    const colors = style.palette.map(hexRgb);
    const fill = nearest([110, 76, 52], colors);
    // the grass edge must read against the fill even when the palette has no green
    const edge = nearest([86, 160, 72], colors.filter(c => d2(c, fill) > 70 ** 2)) ?? fill;
    const t = blankTemplate(size, fill, edge);
    try {
      const draft: AssetDraft = {
        name: `${name || 'ground'} template`, kind: 'tile', source: 'imported', description: 'Tileset template: single tile, inner corners, and a 2x2 terrain block. Paint over it.',
        frameWidth: t.width, frameHeight: t.height, frames: [{ x: 0, y: 0, w: t.width, h: t.height }], pivot: { x: 0, y: t.height - 1 },
        animations: [{ name: 'template', frames: [0], fps: 1, loop: false }], tags: ['tile-template'], reference: false,
      };
      const a = await api.createAsset(projectId, draft, await pngOf(t));
      onCreated(a); setSel(a.id);
      notify('Template created: paint it in the sprite editor, save, and it updates here');
    } catch (e) { fail(e); }
  };

  const exportGodot = async () => {
    if (!expanded) return;
    const base = (name || 'tiles').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const png = new Uint8Array(await (await pngOf(expanded.image)).arrayBuffer());
    const tres = godotTileSetTres({ texturePath: `res://tiles/${base}.png`, tile, columns: expanded.columns, tiles: expanded.tiles, terrainName: name || 'Terrain' });
    const readme = `Unzip into your Godot 4 project root. tiles/${base}.tres is a TileSet with one terrain ("${name}"), all 47 blob tiles with peering bits, and a full-tile collision polygon on physics layer 0.\nIn a TileMapLayer: set tile_set to it, then paint with the Terrains tab (Connect mode).`;
    const z = zip([{ path: `tiles/${base}.png`, data: png }, { path: `tiles/${base}.tres`, data: new TextEncoder().encode(tres) }, { path: 'README.txt', data: new TextEncoder().encode(readme) }]);
    download(`${base}-tileset-godot.zip`, new Blob([z], { type: 'application/zip' }));
  };

  const saveSheet = async () => {
    if (!expanded) return;
    try {
      const im = expanded.image, cols = expanded.columns;
      const draft: AssetDraft = {
        name: `${name || 'ground'} tiles`, kind: 'tile', source: 'generated', description: '47-tile blob autotile set.',
        frameWidth: tile, frameHeight: tile,
        frames: expanded.tiles.map((_, i) => ({ x: (i % cols) * tile, y: Math.floor(i / cols) * tile, w: tile, h: tile })),
        pivot: { x: 0, y: tile - 1 }, animations: [{ name: 'tiles', frames: expanded.tiles.map((_, i) => i), fps: 4, loop: true }], tags: ['tileset'], reference: false,
      };
      onCreated(await api.createAsset(projectId, draft, await pngOf(im)));
      notify(`Saved ${draft.name} to the library`);
    } catch (e) { fail(e); }
  };

  return (
    <main className="tiles">
      <PageHeader icon="tiles" title="Tiles" sub="Paint five pieces, get all 47 autotiles: corners, edges and inner corners, wired for Godot's terrain painter.">
        {tpl && <button onClick={() => onEdit(tpl.id)}><Icon name="pencil" /> Paint template</button>}
        <button className="primary" onClick={() => void exportGodot()} disabled={!expanded}><Icon name="download" /> Godot TileSet</button>
      </PageHeader>
      {!tpl ? (
        <div className="tiles-empty">
          <div className="empty-card">
            <Icon name="tiles" size={28} />
            <h2>Start a tileset</h2>
            <p>You paint a small template: a single tile, the inner corners, and a 2×2 block with edges. Kinetome builds every other tile from it.</p>
            <div className="row2">
              <label className="field"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} /></label>
              <label className="field"><span>Tile size</span>
                <select value={size} onChange={e => setSize(+e.target.value)}>{[8, 12, 16, 24, 32].map(s => <option key={s} value={s}>{s}px</option>)}</select>
              </label>
            </div>
            <button className="primary lg" onClick={() => void newTemplate()}><Icon name="plus" /> Create template</button>
          </div>
        </div>
      ) : (
        <div className="tiles-body">
          <section className="card tiles-template">
            <div className="card-head">
              <h3>Template</h3>
              <div className="spacer" />
              {templates.length > 1 && (
                <select className="compact" value={tpl.id} onChange={e => setSel(e.target.value)} aria-label="Template">
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
            </div>
            <canvas ref={tplCanvas} className="pix" />
            <ul className="tiles-legend">
              {TEMPLATE_LAYOUT.cells.map(c => <li key={c.id}><strong>{c.label}</strong><span className="dim small">{c.hint}</span></li>)}
            </ul>
            <div className="btnrow">
              <button onClick={() => onEdit(tpl.id)}><Icon name="pencil" /> Paint it in the editor</button>
              <button className="ghost" onClick={() => void newTemplate()}><Icon name="plus" /> New</button>
            </div>
            <p className="dim small">{tile}px tiles. Save in the editor and this page updates.</p>
          </section>
          <section className="card tiles-map">
            <div className="card-head">
              <h3>Test map</h3>
              <span className="dim small">drag to paint · right-drag to erase</span>
              <div className="spacer" />
              <button className="ghost small" onClick={() => setCells(starterMap(MW, MH))}>Reset</button>
              <button className="ghost small" onClick={() => setCells(new Array(MW * MH).fill(false))}>Clear</button>
            </div>
            <canvas ref={mapCanvas} className="pix tiles-canvas"
              onContextMenu={e => e.preventDefault()}
              onPointerDown={e => { (e.target as HTMLElement).setPointerCapture(e.pointerId); const i = cellAt(e); painting.current = e.button === 2 ? false : i >= 0 ? !cells[i] : true; paintAt(e); }}
              onPointerMove={paintAt} onPointerUp={() => { painting.current = null; }} />
          </section>
          <section className="card tiles-sheet">
            <div className="card-head"><h3>All 47 tiles</h3><div className="spacer" /><input className="compact" value={name} onChange={e => setName(e.target.value)} aria-label="Tileset name" style={{ width: 120 }} /></div>
            <canvas ref={sheetCanvas} className="pix" />
            <div className="btnrow">
              <button onClick={() => void saveSheet()} disabled={!expanded}><Icon name="plus" /> Save to library</button>
              <button onClick={() => void exportGodot()} disabled={!expanded}><Icon name="download" /> Godot TileSet</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
