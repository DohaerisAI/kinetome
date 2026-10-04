import { useEffect, useMemo, useState } from 'react';
import type { PixelImage, SpriteAsset, StyleBible } from '@kinetome/core';
import { EFFECTS } from '@kinetome/pixel';
import { api, type AssetDraft } from '../api.ts';
import { Icon } from '../icons.tsx';
import { AnimPreview } from './AnimPreview.tsx';

const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };

/**
 * Procedural pixel effects (slash, dust, sparks, leaves, magic), tuned with the project's
 * palette, saved as library sprites for the game and the playtest. No tokens spent.
 */
export function EffectsDialog({ onClose, ...rest }: {
  projectId: string; style: StyleBible; extraColors?: string[]; onClose: () => void; onCreated: (a: SpriteAsset) => void; fail: (e: unknown) => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal fx-modal" role="dialog" aria-label="New effect">
        <div className="modal-head">
          <span className="ph-icon small"><Icon name="sparkle" /></span>
          <div><strong>New effect</strong><div className="dim small">Pixel effects drawn from code in your palette. Instant, free, and every seed is a new variation.</div></div>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <EffectMaker {...rest} onCancel={onClose} onCreated={a => { rest.onCreated(a); onClose(); }} />
      </div>
    </div>
  );
}

/** The effect tool itself: used in the Effects page and the quick dialog. */
export function EffectMaker({ projectId, style, extraColors = [], onCreated, onCancel, fail }: {
  projectId: string; style: StyleBible; extraColors?: string[]; onCreated: (a: SpriteAsset) => void; onCancel?: () => void; fail: (e: unknown) => void;
}) {
  const [id, setId] = useState(EFFECTS[0].id);
  const [size, setSize] = useState(Math.max(24, Math.round(style.unitHeight * 1.2)));
  const [frames, setFrames] = useState<number | null>(null);
  // the Style Bible plus every character's own ramps (a leaf-themed character brings its greens)
  const sorted = useMemo(() => [...new Set([...style.palette, ...extraColors].map(c => c.toLowerCase()))].sort((a, b) => lum(a) - lum(b)), [style.palette, extraColors]);
  // each effect starts from the palette colors nearest its own natural colors (green leaves, warm sparks…)
  const natural = (effect: typeof EFFECTS[number]) => {
    const own = (effect.defaults.colors as string[] | undefined) ?? [];
    const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const near = (h: string) => { const t = rgb(h); return sorted.reduce((b, c) => { const a = rgb(c), q = rgb(b); return (a[0] - t[0]) ** 2 + (a[1] - t[1]) ** 2 + (a[2] - t[2]) ** 2 < (q[0] - t[0]) ** 2 + (q[1] - t[1]) ** 2 + (q[2] - t[2]) ** 2 ? c : b; }, sorted[0]); };
    return own.length ? own.slice(-3).map(near) : sorted.slice(-3);
  };
  const [colors, setColors] = useState<string[]>(() => natural(EFFECTS[0]));
  const [seed, setSeed] = useState(7);
  const [dir, setDir] = useState<'right' | 'left'>('right');
  const [count, setCount] = useState(8);
  const [saving, setSaving] = useState(false);
  const def = EFFECTS.find(e => e.id === id)!;
  useEffect(() => { setFrames(null); setColors(natural(def)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const anim = useMemo(() => def.make({ size, colors, seed, direction: dir, count, ...(frames ? { frames } : {}) }), [def, size, colors, seed, dir, count, frames]);
  const pick = (i: number, c: string) => setColors(cs => cs.map((x, k) => (k === i ? c : x)));

  const save = async () => {
    setSaving(true);
    try {
      const w = anim.frames[0].width, h = anim.frames[0].height;
      const c = document.createElement('canvas'); c.width = w * anim.frames.length; c.height = h;
      const g = c.getContext('2d')!;
      anim.frames.forEach((f: PixelImage, i: number) => g.putImageData(new ImageData(new Uint8ClampedArray(f.data), w, h), i * w, 0));
      const png = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
      const draft: AssetDraft = {
        name: def.name, kind: 'fx', source: 'generated', description: `${def.name} effect (${anim.frames.length} frames).`,
        frameWidth: w, frameHeight: h, frames: anim.frames.map((_, i) => ({ x: i * w, y: 0, w, h })),
        pivot: { x: Math.round(anim.anchor.x), y: Math.round(anim.anchor.y) },
        animations: [{ name: id, frames: anim.frames.map((_, i) => i), fps: anim.fps, loop: anim.loop }], tags: ['effect'], reference: false,
      };
      onCreated(await api.createAsset(projectId, draft, png));
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  return (
      <div className="fx-maker">
        <div className="fx-body">
          <div className="fx-kinds" role="radiogroup" aria-label="Effect">
            {EFFECTS.map(e => <button key={e.id} role="radio" aria-checked={id === e.id} className={id === e.id ? 'exp-engine on' : 'exp-engine'} onClick={() => setId(e.id)}><strong>{e.name}</strong></button>)}
          </div>
          <div className="fx-preview">
            <AnimPreview frames={anim.frames} fps={anim.fps} width={260} height={220} />
            <span className="dim small">{anim.frames.length} frames · {anim.fps} fps · {anim.frames[0].width}×{anim.frames[0].height}</span>
          </div>
          <div className="fx-opts">
            <label className="pt-slider"><span>Size</span><input type="range" min={12} max={128} value={size} onChange={e => setSize(+e.target.value)} /><span className="mono">{size}px</span></label>
            <label className="pt-slider"><span>Frames</span><input type="range" min={3} max={16} value={frames ?? anim.frames.length} onChange={e => setFrames(+e.target.value)} /><span className="mono">{frames ?? anim.frames.length}</span></label>
            {id === 'leaves' && <label className="pt-slider"><span>Leaves</span><input type="range" min={3} max={24} value={count} onChange={e => setCount(+e.target.value)} /><span className="mono">{count}</span></label>}
            {id === 'slash' && (
              <div className="seg compact plain"><button className={dir === 'right' ? 'active' : ''} onClick={() => setDir('right')}>Swing right</button><button className={dir === 'left' ? 'active' : ''} onClick={() => setDir('left')}>Swing left</button></div>
            )}
            <h3>Colors <span className="dim">dark → light</span></h3>
            <div className="fx-colors">
              {colors.map((c, i) => (
                <select key={i} className="compact fx-color" value={c} onChange={e => pick(i, e.target.value)} style={{ borderLeft: `14px solid ${c}` }} aria-label={`Color ${i + 1}`}>
                  {sorted.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              ))}
            </div>
            <button className="small" onClick={() => setSeed(s => s + 1)}><Icon name="refresh" size={12} /> New variation</button>
          </div>
        </div>
        <div className="modal-foot">
          <span className="dim small">Saved as an effect sprite; frame events like <code>spawn:{id}</code> play it in the Playtest.</span>
          <div className="spacer" />
          {onCancel && <button onClick={onCancel}>Cancel</button>}
          <button className="primary" onClick={() => void save()} disabled={saving}><Icon name="plus" /> {saving ? 'Saving…' : 'Add to library'}</button>
        </div>
      </div>
  );
}
