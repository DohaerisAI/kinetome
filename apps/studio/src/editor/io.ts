import type { PixelImage, SpriteAsset } from '@kinetome/core';
import { api } from '../api.ts';
import { canvasToPng, download, loadImage, toPixels } from '../pixels.ts';
import { blank, celKey, docFromAsset, docToSheet, type EditorDoc } from './model.ts';

const COLS = 16;

export function imageToPng(img: PixelImage): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvasToPng(c);
}

interface EditMeta {
  version: 1;
  name: string; width: number; height: number;
  pivot: EditorDoc['pivot']; palette: string[];
  layers: EditorDoc['layers']; frames: EditorDoc['frames']; tags: EditorDoc['tags'];
  /** The asset version this layered doc belongs to; stale docs are ignored. */
  assetUpdatedAt: string;
}

/** Every cel of every layer packed in a grid: cell index = layer * frames + frame. */
function packLayers(doc: EditorDoc): PixelImage {
  const n = doc.layers.length * doc.frames.length, cols = Math.min(COLS, n), rows = Math.ceil(n / cols);
  const out = blank(cols * doc.width, rows * doc.height);
  doc.layers.forEach((l, li) => doc.frames.forEach((f, fi) => {
    const cel = doc.cels[celKey(l.id, f.id)];
    if (!cel) return;
    const k = li * doc.frames.length + fi, x = (k % cols) * doc.width, y = Math.floor(k / cols) * doc.height;
    for (let r = 0; r < doc.height; r++) out.data.set(cel.data.subarray(r * doc.width * 4, (r + 1) * doc.width * 4), ((y + r) * out.width + x) * 4);
  }));
  return out;
}

function unpackLayers(meta: EditMeta, sheet: PixelImage): EditorDoc['cels'] {
  const n = meta.layers.length * meta.frames.length, cols = Math.min(COLS, n);
  const cels: EditorDoc['cels'] = {};
  meta.layers.forEach((l, li) => meta.frames.forEach((f, fi) => {
    const k = li * meta.frames.length + fi, x = (k % cols) * meta.width, y = Math.floor(k / cols) * meta.height;
    const cel = blank(meta.width, meta.height);
    let any = false;
    for (let r = 0; r < meta.height; r++) {
      const row = sheet.data.subarray(((y + r) * sheet.width + x) * 4, ((y + r) * sheet.width + x + meta.width) * 4);
      cel.data.set(row, r * meta.width * 4);
      if (!any) for (let i = 3; i < row.length; i += 4) if (row[i]) { any = true; break; }
    }
    if (any) cels[celKey(l.id, f.id)] = cel;
  }));
  return cels;
}

/**
 * Opens a library asset: its saved layered document when it matches the current asset
 * version, otherwise the flattened sheet (one layer, tags from its animations).
 */
export async function openAsset(projectId: string, asset: SpriteAsset): Promise<{ doc: EditorDoc; layered: boolean }> {
  try {
    const meta = await fetch(`/api/projects/${projectId}/assets/${asset.id}/edit`).then(r => (r.ok ? r.json() as Promise<EditMeta> : null));
    if (meta && meta.version === 1 && meta.assetUpdatedAt === asset.updatedAt) {
      const img = await loadImage(`/api/projects/${projectId}/assets/${asset.id}/edit.png?v=${encodeURIComponent(meta.assetUpdatedAt)}`);
      const cels = unpackLayers(meta, toPixels(img));
      return { doc: { name: meta.name, width: meta.width, height: meta.height, pivot: meta.pivot, palette: meta.palette, layers: meta.layers, frames: meta.frames, tags: meta.tags, cels }, layered: true };
    }
  } catch { /* fall back to the sheet */ }
  const img = await loadImage(api.sheetUrl(projectId, asset));
  const colors = new Set<string>();
  const px = toPixels(img);
  for (let i = 0; i < px.data.length && colors.size < 64; i += 4) if (px.data[i + 3] > 127) colors.add('#' + ((1 << 24) | (px.data[i] << 16) | (px.data[i + 1] << 8) | px.data[i + 2]).toString(16).slice(1));
  return { doc: docFromAsset(px, asset, [...colors]), layered: false };
}

/**
 * Saves into the library: the flattened sheet + animations (what Godot and the rest of
 * the studio use), and the layered document for re-editing.
 */
export async function saveToLibrary(projectId: string, doc: EditorDoc, existing: SpriteAsset | null, draft: { name: string; kind: SpriteAsset['kind'] }): Promise<SpriteAsset> {
  const out = docToSheet(doc);
  const png = await imageToPng(out.sheet);
  const saved = existing
    ? await api.updateAsset(projectId, { ...existing, name: draft.name, frameWidth: out.frameWidth, frameHeight: out.frameHeight, frames: out.rects, pivot: out.pivot, animations: out.animations }, png)
    : await api.createAsset(projectId, {
      name: draft.name, kind: draft.kind, source: 'imported', description: '',
      frameWidth: out.frameWidth, frameHeight: out.frameHeight, frames: out.rects, pivot: out.pivot, animations: out.animations, tags: ['edited'], reference: false,
    }, png);
  const meta: EditMeta = { version: 1, name: draft.name, width: doc.width, height: doc.height, pivot: doc.pivot, palette: doc.palette, layers: doc.layers, frames: doc.frames, tags: doc.tags, assetUpdatedAt: saved.updatedAt };
  const f = new FormData();
  f.set('meta', JSON.stringify(meta));
  f.set('image', await imageToPng(packLayers(doc)), 'edit.png');
  await fetch(`/api/projects/${projectId}/assets/${saved.id}/edit`, { method: 'PUT', body: f });
  return saved;
}

/** Downloads the flattened sheet + a JSON with frames and animations. */
export async function downloadSheet(doc: EditorDoc): Promise<void> {
  const out = docToSheet(doc);
  const base = doc.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'sprite';
  download(`${base}.png`, await imageToPng(out.sheet));
  download(`${base}.json`, new Blob([JSON.stringify({ version: 1, image: `${base}.png`, frameWidth: out.frameWidth, frameHeight: out.frameHeight, frames: out.rects, pivot: out.pivot, animations: out.animations }, null, 2)], { type: 'application/json' }));
}
