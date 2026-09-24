import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssetKind, packGrid, type PixelImage, type StyleBible } from '@sprite/core';
import {
  DEFAULT_PIXELIZE, generateMotion, MOTION_PRESETS, pickEvenly,
  type LoopCandidate, type MotionPreset, type PixelizeOptions, type PixelizeResult,
} from '@sprite/pixel';
import type { AssetDraft } from '../api.ts';
import { decodeFiles, type Decoded } from '../decode.ts';
import { canvasToPng } from '../pixels.ts';
import type { WorkerIn, WorkerOut } from '../pixelize.worker.ts';
import { AnimPreview } from './AnimPreview.tsx';

type Axis = 'height' | 'colors' | 'resample' | 'none';

interface Props {
  files: File[];
  style: StyleBible;
  onCancel: () => void;
  onImport: (draft: AssetDraft, png: Blob) => Promise<unknown>;
  onError: (e: unknown) => void;
}

function variantsFor(base: PixelizeOptions, axis: Axis): { label: string; opts: PixelizeOptions }[] {
  const h = base.targetHeight;
  switch (axis) {
    case 'height': return [Math.round(h * 0.75), h, Math.round(h * 1.5)].map(v => ({ label: `${v}px tall`, opts: { ...base, targetHeight: v } }));
    case 'colors': return [8, 16, 32].map(v => ({ label: `${v} colors`, opts: { ...base, colors: v, palette: base.palette === 'bible' || base.palette === 'none' ? 'auto' : base.palette } }));
    case 'resample': return (['smooth', 'sharp'] as const).map(v => ({ label: v === 'smooth' ? 'Smooth downscale' : 'Sharp downscale', opts: { ...base, resample: v } }));
    case 'none': return [{ label: 'Result', opts: base }];
  }
}

/**
 * Any image, GIF, video, or frame sequence -> clean on-style pixel animation.
 * All heavy lifting happens in a worker; decisions are shared across frames.
 */
export function PixelizeDialog({ files, style, onCancel, onImport, onError }: Props) {
  const [src, setSrc] = useState<Decoded | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [count, setCount] = useState(0); // 0 = every frame in range
  const [loops, setLoops] = useState<LoopCandidate[] | null>(null);
  const [opts, setOpts] = useState<PixelizeOptions>({
    ...DEFAULT_PIXELIZE, bible: style.palette, targetHeight: style.unitHeight,
    outline: style.outline.mode === 'full' ? style.outline.color : null,
  });
  const [axis, setAxis] = useState<Axis>('height');
  const [results, setResults] = useState<PixelizeResult[] | null>(null);
  const [pick, setPick] = useState(1);
  const [running, setRunning] = useState(false);
  const [motion, setMotion] = useState<MotionPreset | ''>('breathe');
  const [fpsOverride, setFpsOverride] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AssetDraft['kind']>('character');
  const [busy, setBusy] = useState(false);
  const worker = useRef<Worker | null>(null);
  const runId = useRef(0);
  const loopId = useRef(0);

  // worker lifecycle
  useEffect(() => {
    const w = new Worker(new URL('../pixelize.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'loops') { if (m.id === loopId.current) setLoops(m.loops); return; }
      if (m.id !== runId.current) return; // stale run
      if (m.type === 'result') {
        setResults(m.results);
        setRunning(false);
        // fixed-grid results ignore target height, so height variants would be identical
        if (m.results.length > 1 && m.results.every(r => r.mode !== 'illustration')) setAxis(a => (a === 'height' ? 'none' : a));
      }
      else { setRunning(false); onError(new Error(m.message)); }
    };
    return () => w.terminate();
  }, [onError]);

  // decode
  useEffect(() => {
    let live = true;
    setLoading(true);
    decodeFiles(files).then(d => {
      if (!live) return;
      setSrc(d);
      setRange([0, d.frames.length]);
      setName(d.name.replace(/[_-]+/g, ' ').trim() || 'sprite');
      setAxis(d.frames.length > 1 ? 'none' : 'height');
      const frames: PixelImage[] = d.frames.map(f => ({ width: f.width, height: f.height, data: f.data }));
      worker.current?.postMessage({ type: 'load', frames } satisfies WorkerIn);
    }, e => live && onError(e)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [files, onError]);

  const indices = useMemo(() => {
    const [s, e] = range;
    return count > 0 ? pickEvenly(s, e, count) : Array.from({ length: Math.max(0, e - s) }, (_, i) => s + i);
  }, [range, count]);

  const variants = useMemo(() => variantsFor(opts, axis), [opts, axis]);

  // run (debounced)
  useEffect(() => {
    if (!src || !indices.length) return;
    const t = setTimeout(() => {
      const id = ++runId.current;
      setRunning(true);
      worker.current?.postMessage({ type: 'run', id, indices, variants: variants.map(v => v.opts) } satisfies WorkerIn);
    }, 250);
    return () => clearTimeout(t);
  }, [src, indices, variants]);

  useEffect(() => { setPick(p => Math.min(p, variants.length - 1)); }, [variants.length]);

  const findLoop = () => {
    if (!src) return;
    const id = ++loopId.current;
    const all = Array.from({ length: range[1] - range[0] }, (_, i) => range[0] + i);
    worker.current?.postMessage({ type: 'loops', id, indices: all, opts: variants[pick]?.opts ?? opts } satisfies WorkerIn);
  };

  const srcFps = useMemo(() => {
    if (!src) return 10;
    const total = src.durations.slice(range[0], range[1]).reduce((a, b) => a + b, 0);
    return total > 0 ? Math.max(1, Math.min(30, Math.round((indices.length * 1000) / total))) : 10;
  }, [src, range, indices.length]);

  const chosen = results?.[pick] ?? null;
  const still = !!chosen && chosen.frames.length === 1;
  const final = useMemo(() => {
    if (!chosen) return null;
    if (still && motion) return generateMotion(chosen.frames[0], motion);
    return { frames: chosen.frames, fps: srcFps, loop: true, name: still ? 'idle' : 'default' };
  }, [chosen, still, motion, srcFps]);
  const fps = fpsOverride ?? final?.fps ?? 10;

  const set = useCallback(<K extends keyof PixelizeOptions>(k: K, v: PixelizeOptions[K]) => setOpts(o => ({ ...o, [k]: v })), []);

  const doImport = async () => {
    if (!final || !chosen) return;
    setBusy(true);
    try {
      const f0 = final.frames[0];
      const layout = packGrid(final.frames.length, f0.width, f0.height);
      const c = document.createElement('canvas');
      c.width = layout.width; c.height = layout.height;
      const ctx = c.getContext('2d')!;
      final.frames.forEach((f, i) => ctx.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), layout.rects[i].x, layout.rects[i].y));
      const draft: AssetDraft = {
        name: name.trim() || 'sprite', kind, source: 'imported',
        frameWidth: f0.width, frameHeight: f0.height, frames: layout.rects, pivot: chosen.pivot,
        animations: [{ name: final.name, frames: final.frames.map((_, i) => i), fps, loop: final.loop }],
        tags: ['pixelized'], reference: false,
      };
      await onImport(draft, await canvasToPng(c));
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  const srcFrames = useMemo<PixelImage[]>(() => (src ? indices.map(i => src.frames[i]).filter(Boolean) : []), [src, indices]);

  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal pixelize" role="dialog" aria-label="Pixelize">
        <div className="modal-head">
          <strong>Pixelize</strong>
          <span className="dim">
            {src ? `${src.name} · ${src.kind} · ${src.frames.length} frame${src.frames.length > 1 ? 's' : ''} · ${src.width}×${src.height}` : files.map(f => f.name).join(', ')}
          </span>
          {running && <span className="dim small">working…</span>}
        </div>
        {loading && <p className="pad">Decoding…</p>}
        {!loading && src && (
          <div className="pz-body">
            <section className="pz-col">
              <h3>Source</h3>
              <AnimPreview frames={srcFrames} fps={srcFps} width={260} height={220} pixel={false} />
              {src.note && <div className="issue warn small">{src.note}</div>}
              {src.frames.length > 1 && (
                <>
                  <div className="row2">
                    <label className="field"><span>First frame</span>
                      <input type="number" min={0} max={range[1] - 1} value={range[0]} onChange={e => { setLoops(null); setRange([Math.max(0, Math.min(range[1] - 1, +e.target.value)), range[1]]); }} />
                    </label>
                    <label className="field"><span>End (exclusive)</span>
                      <input type="number" min={range[0] + 1} max={src.frames.length} value={range[1]} onChange={e => { setLoops(null); setRange([range[0], Math.max(range[0] + 1, Math.min(src.frames.length, +e.target.value))]); }} />
                    </label>
                  </div>
                  <label className="field"><span>Frames to keep (0 = all {range[1] - range[0]})</span>
                    <input type="number" min={0} max={range[1] - range[0]} value={count} onChange={e => setCount(Math.max(0, +e.target.value))} />
                  </label>
                  <div className="btnrow">
                    <button onClick={findLoop} title="Find ranges that loop seamlessly">Find loop</button>
                    <span className="dim small">{indices.length} frames · {srcFps} fps</span>
                  </div>
                  {loops && (
                    <div className="chips">
                      {loops.map(l => (
                        <button key={`${l.start}-${l.end}`} className="chip" onClick={() => setRange([l.start, l.end])} title={`seam score ${l.score.toFixed(4)}`}>
                          {l.start}–{l.end - 1} <span className="dim">({l.end - l.start}f)</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>

            <section className="pz-col pz-results">
              <div className="pz-results-head">
                <h3>Result{variants.length > 1 ? 's: pick one' : ''}</h3>
                <select value={axis} onChange={e => setAxis(e.target.value as Axis)} aria-label="Compare variants by">
                  <option value="height">Compare: height</option>
                  <option value="colors">Compare: colors</option>
                  <option value="resample">Compare: downscale</option>
                  <option value="none">Single result</option>
                </select>
              </div>
              <div className="pz-variants">
                {variants.map((v, i) => {
                  const r = results?.[i];
                  const frames = r ? (still && motion && i === pick && final ? final.frames : r.frames) : [];
                  return (
                    <button key={v.label} className={i === pick ? 'pz-variant active' : 'pz-variant'} onClick={() => setPick(i)}>
                      {r ? <AnimPreview frames={frames} fps={i === pick ? fps : srcFps} width={220} height={220} /> : <div className="pz-wait">…</div>}
                      <span>{v.label}</span>
                      {r && <span className="dim small">{r.mode === 'grid' ? `fixed pixel grid ×${r.grid?.scale.toFixed(1)}` : r.mode} · {r.frames[0].width}×{r.frames[0].height} · {r.palette.length} colors</span>}
                    </button>
                  );
                })}
              </div>
              {chosen && (
                <div className="swatches small pz-palette">{chosen.palette.slice(0, 48).map(c => <span key={c} className="sw" style={{ background: c }} title={c} />)}</div>
              )}
              {still && (
                <div className="pz-motion">
                  <h3>Animate this still</h3>
                  <div className="chips">
                    <button className={!motion ? 'chip active' : 'chip'} onClick={() => setMotion('')}>No motion</button>
                    {MOTION_PRESETS.map(m => (
                      <button key={m.id} className={motion === m.id ? 'chip active' : 'chip'} onClick={() => { setMotion(m.id); setFpsOverride(null); }} title={m.hint}>{m.label}</button>
                    ))}
                  </div>
                  <p className="dim small">Walk, attack and other full moves from a single image arrive with the rig engine. For those today, turn the image into a short video with any image-to-video tool and drop the video here.</p>
                </div>
              )}
            </section>

            <section className="pz-col">
              <h3>Settings</h3>
              <label className="field"><span>Mode</span>
                <select value={opts.mode} onChange={e => set('mode', e.target.value as PixelizeOptions['mode'])}>
                  <option value="auto">Auto-detect</option>
                  <option value="illustration">Illustration → pixel art</option>
                  <option value="grid">Fix fake pixel art (find grid)</option>
                  <option value="native">Already pixel art (keep size)</option>
                </select>
              </label>
              {opts.mode === 'grid' && (
                <label className="field"><span>Block size in source px (0 = auto-detect)</span>
                  <input type="number" min={0} max={64} step={0.1} value={opts.gridScale} onChange={e => set('gridScale', Math.max(0, Math.min(64, +e.target.value || 0)))} />
                </label>
              )}
              <div className="row2">
                <label className="field"><span>Height (px)</span>
                  <input type="number" min={8} max={512} value={opts.targetHeight} onChange={e => set('targetHeight', Math.max(8, Math.min(512, +e.target.value || 8)))} />
                </label>
                <label className="field"><span>Downscale</span>
                  <select value={opts.resample} onChange={e => set('resample', e.target.value as 'smooth' | 'sharp')}>
                    <option value="smooth">Smooth</option><option value="sharp">Sharp</option>
                  </select>
                </label>
              </div>
              <div className="row2">
                <label className="field"><span>Palette</span>
                  <select value={opts.palette} onChange={e => set('palette', e.target.value as PixelizeOptions['palette'])}>
                    <option value="auto-bible">Auto → Style Bible</option>
                    <option value="bible">Style Bible (direct)</option>
                    <option value="auto">Auto (free)</option>
                    <option value="none">Keep colors</option>
                  </select>
                </label>
                <label className="field"><span>Colors</span>
                  <input type="number" min={2} max={64} value={opts.colors} disabled={opts.palette === 'bible' || opts.palette === 'none'} onChange={e => set('colors', Math.max(2, Math.min(64, +e.target.value || 2)))} />
                </label>
              </div>
              <div className="row2">
                <label className="field"><span>Background</span>
                  <select value={opts.background} onChange={e => set('background', e.target.value as PixelizeOptions['background'])}>
                    <option value="auto">Remove (auto)</option><option value="none">Keep</option>
                  </select>
                </label>
                <label className="field"><span>Tolerance</span>
                  <input type="number" step={0.01} min={0.01} max={0.4} value={opts.tolerance} onChange={e => set('tolerance', Math.max(0.01, Math.min(0.4, +e.target.value || 0.09)))} />
                </label>
              </div>
              <label className="field"><span>Anchor frames</span>
                <select value={opts.anchor} onChange={e => set('anchor', e.target.value as PixelizeOptions['anchor'])}>
                  <option value="feet">Feet (walk in place, removes drift)</option>
                  <option value="center">Center (flying, effects)</option>
                  <option value="none">Keep original positions</option>
                </select>
              </label>
              <div className="row2">
                <label className="toggle block"><input type="checkbox" checked={opts.cleanup} onChange={e => set('cleanup', e.target.checked)} /> Clean stray pixels</label>
                <label className="toggle block"><input type="checkbox" checked={!!opts.outline} onChange={e => set('outline', e.target.checked ? (style.outline.color ?? '#000000') : null)} /> Outline</label>
              </div>

              <h3>Asset</h3>
              <label className="field"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} /></label>
              <div className="row2">
                <label className="field"><span>Kind</span>
                  <select value={kind} onChange={e => setKind(e.target.value as AssetDraft['kind'])}>{AssetKind.options.map(k => <option key={k}>{k}</option>)}</select>
                </label>
                <label className="field"><span>FPS</span>
                  <input type="number" min={1} max={60} value={fps} onChange={e => setFpsOverride(Math.max(1, Math.min(60, +e.target.value || 1)))} />
                </label>
              </div>
            </section>
          </div>
        )}
        <div className="modal-foot">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!final || busy || running} onClick={doImport}>{busy ? 'Importing…' : `Import ${final ? `(${final.frames.length} frame${final.frames.length > 1 ? 's' : ''})` : ''}`}</button>
        </div>
      </div>
    </div>
  );
}
