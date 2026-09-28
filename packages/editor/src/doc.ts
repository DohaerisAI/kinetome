import type { PixelImage } from '@kinetome/core';

/**
 * The editor document, modelled like Aseprite/Pixelorama: frames x layers, where each
 * intersection is a cel (a full-canvas RGBA image). Documents are IMMUTABLE: every edit
 * returns a new doc that shares all untouched cels, which makes undo/redo a list of
 * snapshots that costs only the pixels that actually changed.
 */

export interface Layer { id: string; name: string; visible: boolean; locked: boolean; opacity: number }
export interface Frame { id: string; /** Display time in ms. */ duration: number }
/** A named animation over a frame range (inclusive), like Aseprite tags. */
export interface Tag { id: string; name: string; from: number; to: number; loop: boolean; color: string }

export interface EditorDoc {
  width: number;
  height: number;
  layers: Layer[];            // bottom to top
  frames: Frame[];
  /** Cels keyed `${layerId}:${frameId}`; a missing key is an empty (transparent) cel. */
  cels: Record<string, PixelImage>;
  tags: Tag[];
  palette: string[];
  pivot: { x: number; y: number };
  name: string;
}

let counter = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;
export const celKey = (layerId: string, frameId: string) => `${layerId}:${frameId}`;

export function blank(width: number, height: number): PixelImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneImage(img: PixelImage): PixelImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

const TAG_COLORS = ['#8b6cff', '#35d0ff', '#4fd18b', '#ffb454', '#ff5d7a', '#e0885a', '#c77dff', '#7bdff2'];
export const tagColor = (i: number) => TAG_COLORS[i % TAG_COLORS.length];

export function createDoc(width: number, height: number, frames = 1, name = 'Untitled'): EditorDoc {
  const layer: Layer = { id: uid('l'), name: 'Layer 1', visible: true, locked: false, opacity: 1 };
  return {
    width, height, name,
    layers: [layer],
    frames: Array.from({ length: frames }, () => ({ id: uid('f'), duration: 100 })),
    cels: {}, tags: [], palette: [],
    pivot: { x: Math.floor(width / 2), y: height - 1 },
  };
}

/** Document from finished frames (one layer), e.g. after slicing a sheet. */
export function docFromFrames(frames: PixelImage[], opts: { name?: string; duration?: number; pivot?: { x: number; y: number }; tags?: Omit<Tag, 'id' | 'color'>[]; palette?: string[] } = {}): EditorDoc {
  if (!frames.length) throw new Error('no frames');
  const { width, height } = frames[0];
  const doc = createDoc(width, height, frames.length, opts.name);
  const layer = doc.layers[0];
  frames.forEach((f, i) => {
    if (f.width !== width || f.height !== height) throw new Error('frames must share one size');
    doc.cels[celKey(layer.id, doc.frames[i].id)] = cloneImage(f);
    doc.frames[i].duration = opts.duration ?? 100;
  });
  doc.tags = (opts.tags ?? []).map((t, i) => ({ ...t, id: uid('t'), color: tagColor(i) }));
  doc.palette = opts.palette ?? [];
  if (opts.pivot) doc.pivot = opts.pivot;
  return doc;
}

export function getCel(doc: EditorDoc, layerId: string, frameId: string): PixelImage | undefined {
  return doc.cels[celKey(layerId, frameId)];
}

/** The cel to draw on (a fresh copy, or a blank one if the cel is empty). */
export function editableCel(doc: EditorDoc, layerId: string, frameId: string): PixelImage {
  const c = getCel(doc, layerId, frameId);
  return c ? cloneImage(c) : blank(doc.width, doc.height);
}

export function withCel(doc: EditorDoc, layerId: string, frameId: string, img: PixelImage): EditorDoc {
  return { ...doc, cels: { ...doc.cels, [celKey(layerId, frameId)]: img } };
}

/** Flattens visible layers of one frame (normal blending with layer opacity). */
export function composite(doc: EditorDoc, frameIndex: number, opts: { layers?: string[]; ignoreVisibility?: boolean } = {}): PixelImage {
  const out = blank(doc.width, doc.height);
  const frame = doc.frames[frameIndex];
  if (!frame) return out;
  const d = out.data;
  for (const layer of doc.layers) {
    if (!opts.ignoreVisibility && !layer.visible) continue;
    if (opts.layers && !opts.layers.includes(layer.id)) continue;
    const cel = getCel(doc, layer.id, frame.id);
    if (!cel) continue;
    const s = cel.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = (s[i + 3] / 255) * layer.opacity;
      if (a <= 0) continue;
      const da = d[i + 3] / 255, oa = a + da * (1 - a);
      d[i] = (s[i] * a + d[i] * da * (1 - a)) / oa;
      d[i + 1] = (s[i + 1] * a + d[i + 1] * da * (1 - a)) / oa;
      d[i + 2] = (s[i + 2] * a + d[i + 2] * da * (1 - a)) / oa;
      d[i + 3] = oa * 255;
    }
  }
  return out;
}

// ---------- layers ----------

export function addLayer(doc: EditorDoc, above?: string, name?: string): { doc: EditorDoc; id: string } {
  const layer: Layer = { id: uid('l'), name: name ?? `Layer ${doc.layers.length + 1}`, visible: true, locked: false, opacity: 1 };
  const i = above ? doc.layers.findIndex(l => l.id === above) + 1 : doc.layers.length;
  const layers = [...doc.layers];
  layers.splice(i, 0, layer);
  return { doc: { ...doc, layers }, id: layer.id };
}

export function removeLayer(doc: EditorDoc, id: string): EditorDoc {
  if (doc.layers.length <= 1) return doc;
  const cels = { ...doc.cels };
  for (const f of doc.frames) delete cels[celKey(id, f.id)];
  return { ...doc, layers: doc.layers.filter(l => l.id !== id), cels };
}

export function duplicateLayer(doc: EditorDoc, id: string): { doc: EditorDoc; id: string } {
  const src = doc.layers.find(l => l.id === id);
  if (!src) return { doc, id };
  const r = addLayer(doc, id, `${src.name} copy`);
  const cels = { ...r.doc.cels };
  for (const f of doc.frames) { const c = getCel(doc, id, f.id); if (c) cels[celKey(r.id, f.id)] = cloneImage(c); }
  return { doc: { ...r.doc, cels, layers: r.doc.layers.map(l => (l.id === r.id ? { ...l, opacity: src.opacity } : l)) }, id: r.id };
}

export function patchLayer(doc: EditorDoc, id: string, patch: Partial<Omit<Layer, 'id'>>): EditorDoc {
  return { ...doc, layers: doc.layers.map(l => (l.id === id ? { ...l, ...patch } : l)) };
}

/** Moves a layer up (+1) or down (-1) in the stack. */
export function moveLayer(doc: EditorDoc, id: string, dir: 1 | -1): EditorDoc {
  const i = doc.layers.findIndex(l => l.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= doc.layers.length) return doc;
  const layers = [...doc.layers];
  [layers[i], layers[j]] = [layers[j], layers[i]];
  return { ...doc, layers };
}

/** Merges a layer into the one below it (keeps the lower layer). */
export function mergeDown(doc: EditorDoc, id: string): EditorDoc {
  const i = doc.layers.findIndex(l => l.id === id);
  if (i <= 0) return doc;
  const upper = doc.layers[i], lower = doc.layers[i - 1];
  let next = doc;
  doc.frames.forEach((f, fi) => {
    const merged = composite({ ...doc, layers: [{ ...lower, visible: true, opacity: 1 }, { ...upper, visible: true }] }, fi);
    next = withCel(next, lower.id, f.id, merged);
  });
  return removeLayer(next, upper.id);
}

// ---------- frames ----------

/** Inserts frames after `after` (index); `duplicate` copies that frame's cels. */
export function addFrame(doc: EditorDoc, after: number, duplicate = false): { doc: EditorDoc; index: number } {
  const src = doc.frames[after];
  const frame: Frame = { id: uid('f'), duration: src?.duration ?? 100 };
  const frames = [...doc.frames];
  frames.splice(after + 1, 0, frame);
  const cels = { ...doc.cels };
  if (duplicate && src) for (const l of doc.layers) { const c = getCel(doc, l.id, src.id); if (c) cels[celKey(l.id, frame.id)] = cloneImage(c); }
  const tags = doc.tags.map(t => ({ ...t, from: t.from > after ? t.from + 1 : t.from, to: t.to > after || (t.to === after && t.from <= after) ? t.to + 1 : t.to }));
  return { doc: { ...doc, frames, cels, tags }, index: after + 1 };
}

export function removeFrames(doc: EditorDoc, indices: number[]): EditorDoc {
  const drop = new Set(indices);
  if (drop.size >= doc.frames.length) return doc;
  const cels = { ...doc.cels };
  for (const i of drop) for (const l of doc.layers) delete cels[celKey(l.id, doc.frames[i].id)];
  const frames = doc.frames.filter((_, i) => !drop.has(i));
  // remap tag ranges onto the surviving frames
  const map = (i: number) => doc.frames.slice(0, i + 1).filter((_, k) => !drop.has(k)).length - 1;
  const tags = doc.tags.map(t => ({ ...t, from: Math.max(0, map(t.from - 1) + 1), to: map(t.to) })).filter(t => t.to >= t.from);
  return { ...doc, frames, cels, tags };
}

/** Moves a block of consecutive frames [from, from+count) so it starts at `to`. */
export function moveFrames(doc: EditorDoc, from: number, count: number, to: number): EditorDoc {
  const frames = [...doc.frames];
  const block = frames.splice(from, count);
  const at = Math.max(0, Math.min(frames.length, to));
  frames.splice(at, 0, ...block);
  return { ...doc, frames };
}

export function setDurations(doc: EditorDoc, indices: number[], ms: number): EditorDoc {
  const set = new Set(indices);
  return { ...doc, frames: doc.frames.map((f, i) => (set.has(i) ? { ...f, duration: Math.max(10, Math.round(ms)) } : f)) };
}

// ---------- tags ----------

export function addTag(doc: EditorDoc, name: string, from: number, to: number, loop = true): EditorDoc {
  return { ...doc, tags: [...doc.tags, { id: uid('t'), name, from: Math.min(from, to), to: Math.max(from, to), loop, color: tagColor(doc.tags.length) }] };
}

export function patchTag(doc: EditorDoc, id: string, patch: Partial<Omit<Tag, 'id'>>): EditorDoc {
  return { ...doc, tags: doc.tags.map(t => (t.id === id ? { ...t, ...patch } : t)) };
}

export function removeTag(doc: EditorDoc, id: string): EditorDoc {
  return { ...doc, tags: doc.tags.filter(t => t.id !== id) };
}

/** Frames of the animation containing `frame` (its tag), or all frames. */
export function playRange(doc: EditorDoc, frame: number): { from: number; to: number; loop: boolean } {
  const t = doc.tags.find(x => frame >= x.from && frame <= x.to);
  return t ? { from: t.from, to: t.to, loop: t.loop } : { from: 0, to: doc.frames.length - 1, loop: true };
}
