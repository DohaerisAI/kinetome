import { useEffect, useMemo, useRef, useState } from 'react';
import {
  hueShiftVariant, rampFor, rampSwap, recolorByRamps, tintVariant,
  type CharacterDesign, type PixelImage, type Rect, type SpriteAsset, type TintKind,
} from '@kinetome/core';
import { litPreview, modelCheck } from '@kinetome/pixel';
import { api, type AssetDraft } from '../api.ts';
import { Icon } from '../icons.tsx';
import { loadImage, toPixels, usePixels } from '../pixels.ts';

/** Inspector tabs that work on a sprite's pixels: lighting, variants and the off-model check. */

const asPixels = (d: ImageData): PixelImage => ({ width: d.width, height: d.height, data: d.data });
function crop(src: PixelImage, r: Rect): PixelImage {
  const out: PixelImage = { width: r.w, height: r.h, data: new Uint8ClampedArray(r.w * r.h * 4) };
  for (let y = 0; y < r.h; y++) out.data.set(src.data.subarray(((r.y + y) * src.width + r.x) * 4, ((r.y + y) * src.width + r.x + r.w) * 4), y * r.w * 4);
  return out;
}
/** Bounds of the visible pixels (frames often carry wide empty margins). */
function content(img: PixelImage): Rect {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? { x: 0, y: 0, w: img.width, h: img.height } : { x: Math.max(0, x0 - 1), y: Math.max(0, y0 - 1), w: Math.min(img.width, x1 + 2) - Math.max(0, x0 - 1), h: Math.min(img.height, y1 + 2) - Math.max(0, y0 - 1) };
}

function paint(c: HTMLCanvasElement | null, img: PixelImage | null, zoom: number) {
  if (!c || !img) return;
  c.width = img.width * zoom; c.height = img.height * zoom;
  const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
  t.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const g = c.getContext('2d')!; g.imageSmoothingEnabled = false; g.clearRect(0, 0, c.width, c.height); g.drawImage(t, 0, 0, c.width, c.height);
}
const firstFrame = (a: SpriteAsset) => a.frames[a.animations[0]?.frames[0] ?? 0];

// ---------- lighting ----------

/** The sprite lit by a light that follows the mouse, from its generated normal map. */
export function LightingPanel({ projectId, asset, img }: { projectId: string; asset: SpriteAsset; img: HTMLImageElement | null }) {
  const [bevel, setBevel] = useState(3);
  const [strength, setStrength] = useState(1);
  const [normals, setNormals] = useState<PixelImage | null>(null);
  const [light, setLight] = useState({ x: 0.2, y: 0.25, z: 0.6 });
  const pixels = usePixels(img);
  const canvas = useRef<HTMLCanvasElement>(null);
  const normalCanvas = useRef<HTMLCanvasElement>(null);
  const url = `/api/projects/${projectId}/assets/${asset.id}/normals.png?bevel=${bevel}&strength=${strength}&v=${encodeURIComponent(asset.updatedAt)}`;
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => loadImage(url).then(i => live && setNormals(asPixels(toPixels(i))), () => {}), 150);
    return () => { live = false; clearTimeout(t); };
  }, [url]);
  const r = firstFrame(asset);
  // crop sprite and normal map by the same visible bounds, so the preview is big
  const full = useMemo(() => (pixels && r ? crop(asPixels(pixels), r) : null), [pixels, r]);
  const bounds = useMemo(() => (full ? content(full) : null), [full]);
  const frame = useMemo(() => (full && bounds ? crop(full, bounds) : null), [full, bounds]);
  const nFrame = useMemo(() => (normals && r && bounds ? crop(crop(normals, r), bounds) : null), [normals, r, bounds]);
  const zoom = frame ? Math.max(1, Math.min(8, Math.floor(240 / Math.max(frame.width, frame.height)))) : 1;
  useEffect(() => {
    if (!frame || !nFrame) return;
    paint(canvas.current, litPreview(frame, nFrame, { x: light.x * frame.width, y: light.y * frame.height, z: light.z * Math.max(frame.width, frame.height), ambient: 0.28 }), zoom);
    paint(normalCanvas.current, nFrame, Math.max(1, Math.floor(zoom / 2)));
  }, [frame, nFrame, light, zoom]);
  return (
    <div className="sp-panel">
      <p className="dim small">A normal map lets the sprite catch real 2D lights in the engine. It's generated from the silhouette and shading; move the mouse over the sprite to move the light.</p>
      <div className="lit-stage" onMouseMove={e => { const b = e.currentTarget.getBoundingClientRect(); setLight(l => ({ ...l, x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height })); }}>
        <canvas ref={canvas} className="lit-canvas" />
      </div>
      <div className="lit-row">
        <canvas ref={normalCanvas} className="lit-normal" title="The normal map" />
        <div className="grow">
          <label className="pt-slider"><span>Bevel</span><input type="range" min={1} max={8} value={bevel} onChange={e => setBevel(+e.target.value)} /><span className="mono">{bevel}px</span></label>
          <label className="pt-slider"><span>Depth</span><input type="range" min={0.2} max={3} step={0.1} value={strength} onChange={e => setStrength(+e.target.value)} /><span className="mono">{strength.toFixed(1)}</span></label>
          <label className="pt-slider"><span>Light z</span><input type="range" min={0.1} max={2} step={0.05} value={light.z} onChange={e => setLight(l => ({ ...l, z: +e.target.value }))} /><span className="mono">{light.z.toFixed(2)}</span></label>
        </div>
      </div>
      <div className="btnrow"><a className="button" href={url} download={`${asset.id}_n.png`}><Icon name="download" /> Normal map PNG</a></div>
      <p className="dim small">Engine exports can include normal maps (Export → "Include normal maps").</p>
    </div>
  );
}

// ---------- variants ----------

type Variant = { id: string; label: string; make: (img: PixelImage) => PixelImage };

/** One-click recolors: game states (hurt flash, frozen…), hue shifts and per-part color swaps. */
export function VariantsPanel({ projectId, asset, img, design, onCreated, fail }: {
  projectId: string; asset: SpriteAsset; img: HTMLImageElement | null; design: CharacterDesign | null;
  onCreated: (a: SpriteAsset) => void; fail: (e: unknown) => void;
}) {
  const pixels = usePixels(img);
  const [swaps, setSwaps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const protect = useMemo(() => (design ? [...(design.outline ? [design.outline] : []), ...design.parts.filter(p => /skin|eye/i.test(p.name)).flatMap(p => { const r = rampFor(p.color); return [r.shadow, r.base, r.light]; })] : []), [design]);
  const variants: Variant[] = useMemo(() => [
    ...(['hurt', 'frozen', 'poison', 'shadow', 'gold', 'ghost'] as TintKind[]).map(k => ({ id: k, label: k[0].toUpperCase() + k.slice(1), make: (i: PixelImage) => tintVariant(i, k) })),
    ...[60, 120, 180, 240].map(d => ({ id: `hue${d}`, label: `Hue +${d}°`, make: (i: PixelImage) => hueShiftVariant(i, d, { protect }) })),
  ], [protect]);
  const r = firstFrame(asset);
  const frame = useMemo(() => (pixels && r ? crop(asPixels(pixels), r) : null), [pixels, r]);
  const partSwap = useMemo(() => {
    if (!design) return null;
    const maps = design.parts.filter(p => swaps[p.name] && swaps[p.name] !== p.color).map(p => rampSwap(p.color, swaps[p.name]));
    return maps.length ? maps : null;
  }, [design, swaps]);

  const create = async (label: string, fn: (i: PixelImage) => PixelImage) => {
    if (!pixels) return;
    setBusy(label);
    try {
      const out = fn(asPixels(pixels));
      const c = document.createElement('canvas'); c.width = out.width; c.height = out.height;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0);
      const png = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
      const draft: AssetDraft = { name: `${asset.name} ${label.toLowerCase()}`, kind: asset.kind, source: 'generated', description: asset.description, frameWidth: asset.frameWidth, frameHeight: asset.frameHeight, frames: asset.frames, pivot: asset.pivot, animations: asset.animations, frameData: asset.frameData, tags: [...new Set([...asset.tags, 'variant'])], reference: false };
      onCreated(await api.createAsset(projectId, draft, png));
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  return (
    <div className="sp-panel">
      <p className="dim small">Each variant becomes its own sprite with the same animations, hitboxes and events: enemy recolors, status effects, a damage flash.</p>
      <div className="variant-grid">
        {variants.map(v => <VariantCard key={v.id} label={v.label} src={frame} make={v.make} busy={busy === v.label} onCreate={() => void create(v.label, v.make)} />)}
      </div>
      {design && (
        <>
          <h3>Recolor by part</h3>
          <div className="part-swaps">
            {design.parts.map(p => (
              <label key={p.name} className="part-swap">
                <span className="sw" style={{ background: p.color }} />
                <span className="grow">{p.name}</span>
                <span className="dim">→</span>
                <input type="color" value={swaps[p.name] ?? p.color} onChange={e => setSwaps(s => ({ ...s, [p.name]: e.target.value }))} aria-label={`New ${p.name} color`} />
              </label>
            ))}
          </div>
          {partSwap && <VariantCard label="Recolor" src={frame} make={i => recolorByRamps(i, partSwap)} busy={busy === 'recolor'} onCreate={() => void create('recolor', i => recolorByRamps(i, partSwap))} wide />}
        </>
      )}
    </div>
  );
}

function VariantCard({ label, src, make, busy, onCreate, wide }: { label: string; src: PixelImage | null; make: (i: PixelImage) => PixelImage; busy: boolean; onCreate: () => void; wide?: boolean }) {
  const c = useRef<HTMLCanvasElement>(null);
  const out = useMemo(() => { if (!src) return null; const o = make(src); return crop(o, content(o)); }, [src, make]);
  useEffect(() => { if (out) paint(c.current, out, Math.max(1, Math.floor(72 / Math.max(out.width, out.height)))); }, [out]);
  return (
    <div className={wide ? 'variant wide' : 'variant'}>
      <div className="variant-img"><canvas ref={c} /></div>
      <span className="small">{label}</span>
      <button className="small" onClick={onCreate} disabled={busy || !out}>{busy ? 'Saving…' : <><Icon name="plus" size={12} /> Save</>}</button>
    </div>
  );
}

// ---------- off-model check ----------

/**
 * Compares every frame of an animation against the reference pose (the first frame of
 * idle, or of the first animation): missing body parts, size drift, new colors.
 */
export function CheckPanel({ asset, img, design, onPick }: { asset: SpriteAsset; img: HTMLImageElement | null; design: CharacterDesign | null; onPick: (anim: string) => void }) {
  const pixels = usePixels(img);
  const refAnim = asset.animations.find(a => /idle/i.test(a.name)) ?? asset.animations[0];
  const report = useMemo(() => {
    if (!pixels || !refAnim) return null;
    const px = asPixels(pixels);
    const ref = crop(px, asset.frames[refAnim.frames[0]]);
    const parts = design?.parts.map(p => { const r = rampFor(p.color); return { name: p.name, colors: [r.shadow, r.base, r.light] }; });
    return asset.animations.map(a => ({ anim: a.name, r: modelCheck(ref, a.frames.map(i => crop(px, asset.frames[i])), { parts }) }));
  }, [pixels, asset, design, refAnim]);
  if (!refAnim) return <p className="dim small">No animations to check yet.</p>;
  if (!report) return <p className="dim small">Checking…</p>;
  return (
    <div className="sp-panel">
      <p className="dim small">Every frame compared with the reference pose (<strong>{refAnim.name}</strong>, frame 1){design ? ` and ${design.name}'s body parts` : ''}: parts that vanish, size that drifts, colors that creep in.</p>
      {report.map(({ anim, r }) => (
        <div key={anim} className="check-anim">
          <button className="check-head" onClick={() => onPick(anim)}>
            <strong>{anim}</strong>
            <span className={`badge ${r.score >= 90 ? 'ok' : r.score >= 70 ? 'warn' : 'err'}`}>{r.score}</span>
          </button>
          {r.issues.length === 0 ? <p className="dim small">On model in every frame.</p>
            : r.issues.slice(0, 5).map((i, k) => <div key={k} className={`issue ${i.severity === 'error' ? 'error' : i.severity} small`}>{i.message}</div>)}
        </div>
      ))}
    </div>
  );
}
