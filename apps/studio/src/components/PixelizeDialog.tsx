import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssetKind, countColors, designPalette, lintAsset, packGrid, PLATFORMER_MOVES,
  type CharacterDesign, type PixelImage, type SpriteAsset, type StyleBible,
} from '@sprite/core';
import {
  contentBounds, DEFAULT_PIXELIZE, generateMotion, MOTION_PRESETS, pickEvenly,
  type LoopCandidate, type MotionPreset, type PixelizeOptions, type PixelizeResult, type QualityReport,
} from '@sprite/pixel';
import { api, type AssetDraft } from '../api.ts';
import { decodeFiles, type Decoded } from '../decode.ts';
import { mergeIntoAsset } from '../merge.ts';
import { canvasToPng, loadImage, toPixels } from '../pixels.ts';
import type { Prepared, WorkerIn, WorkerOut } from '../pixelize.worker.ts';
import { AnimPreview } from './AnimPreview.tsx';
import { PixelThumb } from './PixelThumb.tsx';

type Axis = 'height' | 'colors' | 'resample' | 'none';

/** A named animation covering order positions [start, next segment's start). */
interface Segment { name: string; start: number; fps: number; loop: boolean }

interface Target { asset: SpriteAsset; img: HTMLImageElement; palette: string[]; height: number }

interface Props {
  files: File[];
  style: StyleBible;
  projectId: string;
  assets: SpriteAsset[];
  initialTarget?: string | null;
  /** Name for a single-row sheet (e.g. "walk" when importing from the Prompt Kit's Walk card). */
  initialAnim?: string | null;
  /** Importing for a character design: lock to its palette, height and name. */
  design?: CharacterDesign | null;
  onCancel: () => void;
  onCreate: (draft: AssetDraft, png: Blob) => Promise<unknown>;
  onMerge: (asset: SpriteAsset, png: Blob) => Promise<boolean>;
  onError: (e: unknown) => void;
}

export const BRIEF_KEY = (pid: string) => `sprite.brief.${pid}`;

function variantsFor(base: PixelizeOptions, axis: Axis): { label: string; opts: PixelizeOptions }[] {
  const h = base.targetHeight;
  switch (axis) {
    case 'height': return [Math.round(h * 0.75), h, Math.round(h * 1.5)].map(v => ({ label: `${v}px tall`, opts: { ...base, targetHeight: v } }));
    case 'colors': return [8, 16, 32].map(v => ({ label: `${v} colors`, opts: { ...base, colors: v, palette: base.palette === 'auto' ? 'auto' : 'auto-bible' } }));
    case 'resample': return (['smooth', 'sharp'] as const).map(v => ({ label: v === 'smooth' ? 'Smooth downscale' : 'Sharp downscale', opts: { ...base, resample: v } }));
    case 'none': return [{ label: 'Result', opts: base }];
  }
}

const presetFor = (name: string) => PLATFORMER_MOVES.find(m => m.id === name.toLowerCase() || m.name.toLowerCase() === name.toLowerCase());

/**
 * Any image, AI sprite sheet, GIF, video or frame sequence -> clean on-style animations,
 * as a new asset or added to an existing character.
 */
export function PixelizeDialog({ files, style, projectId, assets, initialTarget, initialAnim, design, onCancel, onCreate, onMerge, onError }: Props) {
  const [src, setSrc] = useState<Decoded | null>(null);
  const [loading, setLoading] = useState(true);
  const [split, setSplit] = useState(true);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selSeg, setSelSeg] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [count, setCount] = useState(0);
  const [loops, setLoops] = useState<LoopCandidate[] | null>(null);
  const [opts, setOpts] = useState<PixelizeOptions>({
    ...DEFAULT_PIXELIZE, bible: style.palette, targetHeight: style.unitHeight,
    outline: style.outline.mode === 'full' ? style.outline.color : null,
  });
  const [axis, setAxis] = useState<Axis>('none');
  const [results, setResults] = useState<PixelizeResult[] | null>(null);
  const [quality, setQuality] = useState<QualityReport[] | null>(null);
  const [pick, setPick] = useState(0);
  const [running, setRunning] = useState(false);
  const [motion, setMotion] = useState<MotionPreset | ''>('breathe');
  const [targetId, setTargetId] = useState<string>(initialTarget ?? 'new');
  const [target, setTarget] = useState<Target | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<AssetDraft['kind']>('character');
  const [busy, setBusy] = useState(false);
  const worker = useRef<Worker | null>(null);
  const ids = useRef({ prep: 0, run: 0, loop: 0 });
  const animHint = useRef(initialAnim ?? null);
  const designRef = useRef(design ?? null);
  const expectedFrames = initialAnim ? design?.moves.find(x => x.id === initialAnim)?.frames : undefined;

  const set = useCallback(<K extends keyof PixelizeOptions>(k: K, v: PixelizeOptions[K]) => setOpts(o => ({ ...o, [k]: v })), []);
  const isStill = !!src && src.frames.length === 1;

  // ---------- worker ----------
  useEffect(() => {
    const w = new Worker(new URL('../pixelize.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'loops') { if (m.id === ids.current.loop) setLoops(m.loops); return; }
      if (m.type === 'prepared') {
        if (m.id !== ids.current.prep) return;
        const p = m.prepared;
        setPrepared(p);
        setOrder(Array.from({ length: p.count }, (_, i) => i));
        const hint = animHint.current ? presetFor(animHint.current) : undefined;
        const move = animHint.current ? designRef.current?.moves.find(x => x.id === animHint.current) : undefined;
        // Imported for a specific move: the whole grid is that one animation, rows read in order.
        setSegments(animHint.current
          ? [{ name: animHint.current, start: 0, fps: move?.fps ?? hint?.fps ?? 10, loop: move?.loop ?? hint?.loop ?? true }]
          : p.rows.map((row, i) => ({
            name: p.count === 1 ? 'idle' : p.rows.length === 1 ? 'default' : `row${i + 1}`,
            start: row[0] ?? 0, fps: hint?.fps ?? 10, loop: hint?.loop ?? true,
          })));
        setSelSeg(0);
        setAxis(p.count === 1 ? 'height' : 'none');
        return;
      }
      if (m.id !== ids.current.run) return;
      if (m.type === 'result') { setResults(m.results); setQuality(m.quality); setRunning(false); }
      else { setRunning(false); onError(new Error(m.message)); }
    };
    return () => w.terminate();
  }, [onError]);

  // ---------- decode ----------
  useEffect(() => {
    let live = true;
    setLoading(true);
    decodeFiles(files).then(d => {
      if (!live) return;
      setSrc(d);
      setRange([0, d.frames.length]);
      setName(d.name.replace(/[_-]+/g, ' ').trim() || 'sprite');
      if (design) { setName(design.name); setDescription(design.description); }
      else try {
        const brief = JSON.parse(localStorage.getItem(BRIEF_KEY(projectId)) ?? 'null');
        if (brief?.description) setDescription(brief.description);
        if (brief?.name) setName(brief.name);
      } catch { /* storage unavailable */ }
      const frames: PixelImage[] = d.frames.map(f => ({ width: f.width, height: f.height, data: f.data }));
      worker.current?.postMessage({ type: 'load', frames } satisfies WorkerIn);
    }, e => live && onError(e)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [files, onError, projectId]);

  // ---------- prepare (split sheets; re-run when backdrop settings change) ----------
  useEffect(() => {
    if (!src) return;
    const t = setTimeout(() => {
      const id = ++ids.current.prep;
      worker.current?.postMessage({ type: 'prepare', id, split: isStill && split, opts } satisfies WorkerIn);
    }, 200);
    return () => clearTimeout(t);
  }, [src, isStill, split, opts.background, opts.tolerance, opts.holes]); // eslint-disable-line react-hooks/exhaustive-deps

  // GIF/video: range + frame count rebuild the order
  const srcFps = useMemo(() => {
    if (!src || isStill) return 10;
    const total = src.durations.slice(range[0], range[1]).reduce((a, b) => a + b, 0);
    const n = count > 0 ? Math.min(count, range[1] - range[0]) : range[1] - range[0];
    return total > 0 ? Math.max(1, Math.min(30, Math.round((n * 1000) / total))) : 10;
  }, [src, isStill, range, count]);

  useEffect(() => {
    if (!src || isStill || !prepared) return;
    const [s, e] = range;
    setOrder(count > 0 ? pickEvenly(s, e, count) : Array.from({ length: Math.max(0, e - s) }, (_, i) => s + i));
    setSegments(segs => [{ name: segs[0]?.name ?? 'default', start: 0, fps: srcFps, loop: segs[0]?.loop ?? true }]);
  }, [src, isStill, prepared, range, count, srcFps]);

  // ---------- existing-character target ----------
  useEffect(() => {
    let live = true;
    if (targetId === 'new') {
      setTarget(null);
      if (design) setOpts(o => ({ ...o, palette: 'fixed', fixedPalette: designPalette(design), targetHeight: design.pixelHeight, outline: design.outline }));
      else setOpts(o => (o.palette === 'fixed' ? { ...o, palette: 'auto-bible', targetHeight: style.unitHeight } : o));
      return;
    }
    const asset = assets.find(a => a.id === targetId);
    if (!asset) return;
    loadImage(api.sheetUrl(projectId, asset)).then(img => {
      if (!live) return;
      const px = toPixels(img);
      // a character design's intended colors beat whatever an earlier import left in the sheet
      const palette = design ? designPalette(design) : [...countColors(px).keys()];
      const height = lintAsset(px, asset, style).stats.contentHeight || style.unitHeight;
      setTarget({ asset, img, palette, height });
      setKind(asset.kind);
      setOpts(o => ({ ...o, palette: 'fixed', fixedPalette: palette, targetHeight: height }));
    }, onError);
    return () => { live = false; };
  }, [targetId, assets, projectId, style, onError, design]);

  const variants = useMemo(() => variantsFor(opts, axis), [opts, axis]);

  // ---------- run ----------
  useEffect(() => {
    if (!prepared || !order.length) return;
    const t = setTimeout(() => {
      const id = ++ids.current.run;
      setRunning(true);
      worker.current?.postMessage({ type: 'run', id, order, variants: variants.map(v => v.opts), maxColors: style.maxColorsPerSprite } satisfies WorkerIn);
    }, 250);
    return () => clearTimeout(t);
  }, [prepared, order, variants, style.maxColorsPerSprite]);

  useEffect(() => { setPick(p => Math.min(p, variants.length - 1)); }, [variants.length]);

  const findLoop = () => {
    const id = ++ids.current.loop;
    worker.current?.postMessage({ type: 'loops', id, order, opts: variants[pick]?.opts ?? opts } satisfies WorkerIn);
  };

  // ---------- frame strip editing ----------
  const segEnd = (i: number) => (i + 1 < segments.length ? segments[i + 1].start : order.length);

  const deleteFrame = (pos: number) => {
    if (order.length <= 1) return;
    const n = order.length - 1;
    setOrder(o => o.filter((_, i) => i !== pos));
    setSegments(segs => {
      const shifted = segs.map((g, i) => ({ ...g, start: i === 0 ? 0 : g.start > pos ? g.start - 1 : g.start }));
      // drop segments that became empty (same start as the next one, or starting past the end)
      return shifted.filter((g, i) => i === 0 || (g.start < n && g.start !== shifted[i - 1].start && g.start !== shifted[i + 1]?.start));
    });
  };
  const moveFrame = (pos: number, dir: -1 | 1) => {
    const to = pos + dir;
    if (to < 0 || to >= order.length) return;
    setOrder(o => { const n = [...o]; [n[pos], n[to]] = [n[to], n[pos]]; return n; });
  };
  const splitAt = (pos: number) => {
    if (pos <= 0 || segments.some(g => g.start === pos)) return;
    setSegments(segs => [...segs, { name: `anim${segs.length + 1}`, start: pos, fps: 10, loop: true }].sort((a, b) => a.start - b.start));
  };
  const joinSegment = (i: number) => { if (i > 0) setSegments(segs => segs.filter((_, k) => k !== i)); };
  const patchSeg = (i: number, p: Partial<Segment>) => setSegments(segs => segs.map((g, k) => {
    if (k !== i) return g;
    const next = { ...g, ...p };
    if (p.name) { const pre = presetFor(p.name); if (pre) { next.fps = pre.fps; next.loop = pre.loop; } }
    return next;
  }));
  const applyLoop = (l: LoopCandidate) => {
    setOrder(o => o.slice(l.start, l.end));
    setSegments(segs => [{ ...(segs[0] ?? { name: 'default', fps: srcFps, loop: true }), start: 0, loop: true }]);
    setLoops(null);
  };

  // ---------- derived ----------
  const chosen = results?.[pick] ?? null;
  const report = quality?.[pick] ?? null;
  const single = !!chosen && chosen.frames.length === 1;
  const motionResult = useMemo(() => (chosen && single && motion ? generateMotion(chosen.frames[0], motion) : null), [chosen, single, motion]);
  const badFrames = useMemo(() => {
    const m = new Map<number, string[]>();
    report?.issues.filter(i => i.severity !== 'info').forEach(i => i.frames?.forEach(f => m.set(f, [...(m.get(f) ?? []), i.message])));
    return m;
  }, [report]);
  const si = Math.max(0, Math.min(selSeg, segments.length - 1));
  const seg = segments[si];
  const segFrames = (r: PixelizeResult) => r.frames.slice(seg?.start ?? 0, segEnd(si));
  const previewFps = motionResult ? motionResult.fps : seg?.fps ?? 10;

  const heightMismatch = useMemo(() => {
    if (!target || !chosen || chosen.mode === 'illustration') return null;
    const h = Math.max(...chosen.frames.map(f => contentBounds(f, 128)?.h ?? 0));
    return Math.abs(h / target.height - 1) > 0.1 ? h : null;
  }, [target, chosen]);

  const saveBrief = (patch: { name?: string; description?: string }) => {
    try {
      const prev = JSON.parse(localStorage.getItem(BRIEF_KEY(projectId)) ?? '{}');
      localStorage.setItem(BRIEF_KEY(projectId), JSON.stringify({ ...prev, ...patch }));
    } catch { /* storage unavailable */ }
  };

  // ---------- import ----------
  const doImport = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const frames = motionResult ? motionResult.frames : chosen.frames;
      const animations = motionResult
        ? [{ name: motionResult.name, frames: frames.map((_, i) => i), fps: motionResult.fps, loop: motionResult.loop }]
        : segments.map((g, i) => ({ name: g.name.trim() || `anim${i + 1}`, frames: Array.from({ length: segEnd(i) - g.start }, (_, k) => g.start + k), fps: g.fps, loop: g.loop }));
      const names = animations.map(a => a.name);
      if (new Set(names).size !== names.length) throw new Error('Two animations share a name; rename one');

      if (target) {
        const merged = mergeIntoAsset(target.img, target.asset, { frames, pivot: chosen.pivot, animations });
        await onMerge({ ...merged.asset, description: description.trim() || target.asset.description }, await canvasToPng(merged.canvas));
      } else {
        const f0 = frames[0];
        const layout = packGrid(frames.length, f0.width, f0.height);
        const c = document.createElement('canvas');
        c.width = layout.width; c.height = layout.height;
        const ctx = c.getContext('2d')!;
        frames.forEach((f, i) => ctx.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), layout.rects[i].x, layout.rects[i].y));
        await onCreate({
          name: name.trim() || 'sprite', kind, source: 'imported', description: description.trim(),
          frameWidth: f0.width, frameHeight: f0.height, frames: layout.rects, pivot: chosen.pivot,
          animations, tags: ['pixelized'], reference: false,
        }, await canvasToPng(c));
      }
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  const thumbs = prepared?.thumbs ?? [];
  const stripFrames: (PixelImage | undefined)[] = chosen && chosen.frames.length === order.length ? chosen.frames : order.map(i => thumbs[i]);
  const importLabel = busy ? 'Saving…'
    : target ? `Add ${motionResult ? 1 : segments.length} animation${!motionResult && segments.length > 1 ? 's' : ''} to ${target.asset.name}`
    : `Import${chosen ? ` (${(motionResult?.frames ?? chosen.frames).length} frames, ${motionResult ? 1 : segments.length} anim${!motionResult && segments.length > 1 ? 's' : ''})` : ''}`;

  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal pixelize" role="dialog" aria-label="Pixelize">
        <div className="modal-head">
          <strong>Pixelize</strong>
          <span className="dim">
            {src ? `${src.name} · ${src.kind} · ${src.frames.length > 1 ? `${src.frames.length} frames · ` : ''}${src.width}×${src.height}` : files.map(f => f.name).join(', ')}
            {prepared?.sheet && ` · sprite sheet: ${prepared.count} poses in ${prepared.rows.length} row${prepared.rows.length > 1 ? 's' : ''}${prepared.dropped ? `, ${prepared.dropped} label/speck${prepared.dropped > 1 ? 's' : ''} ignored` : ''}`}
          </span>
          <div className="spacer" />
          {running && <span className="dim small">working…</span>}
          {report && <span className={`badge ${report.score >= 90 ? 'ok' : report.score >= 70 ? 'warn' : 'err'}`} title="Quality score">quality {report.score}</span>}
        </div>
        {loading && <p className="pad">Decoding…</p>}
        {!loading && src && (
          <div className="pz-body">
            {/* ---------- left: source + destination ---------- */}
            <section className="pz-col">
              <h3>Source</h3>
              <AnimPreview frames={isStill ? src.frames : order.map(i => src.frames[i]).filter(Boolean)} fps={srcFps} width={260} height={200} pixel={false} />
              {src.note && <div className="issue warn small">{src.note}</div>}
              {isStill && (
                <label className="toggle block" title="Treat the image as a sprite sheet and cut out each pose">
                  <input type="checkbox" checked={split} onChange={e => setSplit(e.target.checked)} /> Split into poses (sprite sheet)
                </label>
              )}
              {!isStill && (
                <>
                  <div className="row2">
                    <label className="field"><span>First frame</span>
                      <input type="number" min={0} max={range[1] - 1} value={range[0]} onChange={e => setRange([Math.max(0, Math.min(range[1] - 1, +e.target.value)), range[1]])} />
                    </label>
                    <label className="field"><span>End (exclusive)</span>
                      <input type="number" min={range[0] + 1} max={src.frames.length} value={range[1]} onChange={e => setRange([range[0], Math.max(range[0] + 1, Math.min(src.frames.length, +e.target.value))])} />
                    </label>
                  </div>
                  <label className="field"><span>Frames to keep (0 = all {range[1] - range[0]})</span>
                    <input type="number" min={0} max={range[1] - range[0]} value={count} onChange={e => setCount(Math.max(0, +e.target.value))} />
                  </label>
                </>
              )}
              {order.length > 4 && (
                <>
                  <div className="btnrow"><button onClick={findLoop} title="Find ranges that loop seamlessly">Find loop</button></div>
                  {loops && (
                    <div className="chips">
                      {loops.length ? loops.map(l => (
                        <button key={`${l.start}-${l.end}`} className="chip" onClick={() => applyLoop(l)} title={`keep frames ${l.start + 1}-${l.end}`}>
                          {l.start + 1}–{l.end} <span className="dim">({l.end - l.start}f)</span>
                        </button>
                      )) : <span className="dim small">No clean loop found</span>}
                    </div>
                  )}
                </>
              )}

              <h3>Destination</h3>
              <label className="field"><span>Save as</span>
                <select value={targetId} onChange={e => setTargetId(e.target.value)}>
                  <option value="new">New asset</option>
                  {assets.filter(a => a.kind === 'character').map(a => <option key={a.id} value={a.id}>Add to {a.name}</option>)}
                  {assets.filter(a => a.kind !== 'character').map(a => <option key={a.id} value={a.id}>Add to {a.name} ({a.kind})</option>)}
                </select>
              </label>
              {target ? (
                <p className="dim small">Uses {design ? `${design.name}'s design` : target.asset.name + "'s"} {target.palette.length} colors and {target.height}px height; feet line up with its existing animations. An animation with the same name is replaced.</p>
              ) : (
                <>
                  <label className="field"><span>Name</span><input value={name} onChange={e => { setName(e.target.value); saveBrief({ name: e.target.value }); }} /></label>
                  <label className="field"><span>Kind</span>
                    <select value={kind} onChange={e => setKind(e.target.value as AssetDraft['kind'])}>{AssetKind.options.map(k => <option key={k}>{k}</option>)}</select>
                  </label>
                </>
              )}
              <label className="field"><span>Description (used by the Prompt Kit)</span>
                <textarea rows={2} value={description} placeholder={target?.asset.description || 'e.g. small fox knight, red scarf, round shield'}
                  onChange={e => { setDescription(e.target.value); saveBrief({ description: e.target.value }); }} />
              </label>
            </section>

            {/* ---------- middle: result, frame strip, quality ---------- */}
            <section className="pz-col pz-results">
              <div className="pz-results-head">
                <h3>{segments.length > 1 && !single ? `Previewing "${seg?.name}"` : 'Result'}{variants.length > 1 ? ' · pick one' : ''}</h3>
                <select value={axis} onChange={e => setAxis(e.target.value as Axis)} aria-label="Compare variants by">
                  <option value="none">Single result</option>
                  <option value="height">Compare: height</option>
                  <option value="colors">Compare: colors</option>
                  <option value="resample">Compare: downscale</option>
                </select>
              </div>
              <div className="pz-variants">
                {variants.map((v, i) => {
                  const r = results?.[i];
                  const frames = r ? (i === pick && motionResult ? motionResult.frames : segFrames(r)) : [];
                  const big = variants.length === 1;
                  return (
                    <button key={v.label} className={i === pick ? 'pz-variant active' : 'pz-variant'} onClick={() => setPick(i)}>
                      {r ? <AnimPreview frames={frames} fps={i === pick ? previewFps : seg?.fps ?? 10} width={big ? 300 : 200} height={big ? 250 : 200} /> : <div className="pz-wait" style={{ width: big ? 300 : 200, height: big ? 250 : 200 }}>…</div>}
                      <span>{v.label}</span>
                      {r && <span className="dim small">{r.mode === 'grid' ? `fixed pixel grid ×${r.grids[0]?.scale.toFixed(1)}` : r.mode} · {r.frames[0].width}×{r.frames[0].height} · {r.palette.length} colors</span>}
                    </button>
                  );
                })}
              </div>
              {chosen && <div className="swatches small pz-palette">{chosen.palette.slice(0, 48).map(c => <span key={c} className="sw" style={{ background: c }} title={c} />)}</div>}

              {heightMismatch && target && (
                <div className="issue warn">
                  <div>This art is {heightMismatch}px tall but {target.asset.name} is {target.height}px: the AI drew it at a different pixel size.</div>
                  <button onClick={() => set('mode', 'illustration')}>Resample to {target.height}px</button>
                </div>
              )}

              {!single && order.length > 0 && (
                <>
                  <h3>Frames <span className="dim">◀ ▶ reorder · ✕ delete · ⤓ new animation from here</span></h3>
                  <div className="strip">
                    {segments.map((g, k) => (
                      <div key={k} className={k === si ? 'strip-seg active' : 'strip-seg'} onClick={() => setSelSeg(k)}>
                        <div className="seg-head">
                          <input list="move-names" value={g.name} onChange={e => patchSeg(k, { name: e.target.value })} aria-label="Animation name" placeholder="animation name" />
                          <input type="number" className="num" min={1} max={60} value={g.fps} title="fps" onChange={e => patchSeg(k, { fps: Math.max(1, Math.min(60, +e.target.value || 1)) })} />
                          <label className="toggle" title="Loop"><input type="checkbox" checked={g.loop} onChange={e => patchSeg(k, { loop: e.target.checked })} />↻</label>
                          {k > 0 && <button className="icon" title="Join with previous animation" onClick={e => { e.stopPropagation(); joinSegment(k); }}>⤒</button>}
                        </div>
                        <div className="seg-frames">
                          {Array.from({ length: segEnd(k) - g.start }, (_, j) => g.start + j).map(pos => {
                            const bad = badFrames.get(pos);
                            return (
                              <div key={pos} className={bad ? 'sf bad' : 'sf'} title={bad?.join('\n') ?? `frame ${pos + 1}`}>
                                <PixelThumb img={stripFrames[pos]} size={52} />
                                <span className="sf-n mono">{pos + 1}</span>
                                <div className="sf-tools">
                                  <button className="icon" onClick={() => moveFrame(pos, -1)} title="Move left">◀</button>
                                  <button className="icon" onClick={() => deleteFrame(pos)} title="Delete frame">✕</button>
                                  <button className="icon" onClick={() => moveFrame(pos, 1)} title="Move right">▶</button>
                                  {pos > g.start && <button className="icon" onClick={() => splitAt(pos)} title="Start a new animation at this frame">⤓</button>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  <datalist id="move-names">{PLATFORMER_MOVES.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
                </>
              )}

              {single && (
                <div className="pz-motion">
                  <h3>Animate this still</h3>
                  <div className="chips">
                    <button className={!motion ? 'chip active' : 'chip'} onClick={() => setMotion('')}>No motion</button>
                    {MOTION_PRESETS.map(m => (
                      <button key={m.id} className={motion === m.id ? 'chip active' : 'chip'} onClick={() => setMotion(m.id)} title={m.hint}>{m.label}</button>
                    ))}
                  </div>
                  <p className="dim small">For walks, attacks and other real moves: open the Prompt Kit tab, generate a sprite sheet of that move, drop it here and add it to this character.</p>
                </div>
              )}

              {expectedFrames && !single && order.length !== expectedFrames && (
                <div className="issue warn">
                  Expected {expectedFrames} frames for "{initialAnim}", found {order.length}. {order.length > expectedFrames ? 'Delete the extra poses below' : 'Gemini dropped some; regenerate, or keep these if the motion still reads'}.
                </div>
              )}
              {report && report.issues.length > 0 && (
                <>
                  <h3>Quality check</h3>
                  {report.issues.map((i, k) => <div key={k} className={`issue ${i.severity}`}>{i.message}</div>)}
                </>
              )}
            </section>

            {/* ---------- right: settings ---------- */}
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
                <label className="field"><span>Block size in source px (0 = auto)</span>
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
                    {(target || design) && <option value="fixed">{design?.name ?? target?.asset.name}'s colors</option>}
                    <option value="none">Keep colors</option>
                  </select>
                </label>
                <label className="field"><span>Colors</span>
                  <input type="number" min={2} max={64} value={opts.colors} disabled={!['auto', 'auto-bible'].includes(opts.palette)} onChange={e => set('colors', Math.max(2, Math.min(64, +e.target.value || 2)))} />
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
              <label className="field"><span>Gaps inside the character (arm ↔ body)</span>
                <select value={opts.holes} onChange={e => set('holes', e.target.value as PixelizeOptions['holes'])}>
                  <option value="auto">Clear on green / checker backdrops</option>
                  <option value="on">Always clear</option>
                  <option value="off">Keep</option>
                </select>
              </label>
              <label className="field"><span>Anchor frames</span>
                <select value={opts.anchor} onChange={e => set('anchor', e.target.value as PixelizeOptions['anchor'])}>
                  <option value="feet">Feet (walk in place, removes drift)</option>
                  <option value="center">Center (flying, effects)</option>
                  <option value="none">Keep original positions</option>
                </select>
              </label>
              <label className="toggle block" title="Rescale frames the AI drew bigger or smaller than the rest">
                <input type="checkbox" checked={opts.normalizeSize} onChange={e => set('normalizeSize', e.target.checked)} /> Even out frame sizes
              </label>
              <div className="row2">
                <label className="toggle block"><input type="checkbox" checked={opts.cleanup} onChange={e => set('cleanup', e.target.checked)} /> Clean stray pixels</label>
                <label className="toggle block"><input type="checkbox" checked={!!opts.outline} onChange={e => set('outline', e.target.checked ? (style.outline.color ?? '#000000') : null)} /> Outline</label>
              </div>
            </section>
          </div>
        )}
        <div className="modal-foot">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!chosen || busy || running} onClick={doImport}>{importLabel}</button>
        </div>
      </div>
    </div>
  );
}
