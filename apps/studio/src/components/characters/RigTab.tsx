import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clipPoses, emptyClip, partOwnership, renderPose, rigCanvas, solvePose,
  type CharacterRig, type Ease, type PixelImage, type RigClip, type RigPart, type RigPose,
} from '@kinetome/core';
import { api } from '../../api.ts';
import { Icon } from '../../icons.tsx';
import { mergeIntoAsset } from '../../merge.ts';
import { loadImage, toPixels } from '../../pixels.ts';
import { ClaudeButton, type TabProps } from './shared.tsx';
import { kickQueue, useQueue } from '../../queue.ts';

type Pt = [number, number];
const HUES = [265, 190, 140, 35, 330, 90, 210, 10, 300, 165, 50, 240];
const partColor = (i: number, a = 1) => `hsla(${HUES[i % HUES.length]}, 85%, 62%, ${a})`;
const EASES: Ease[] = ['inOut', 'linear', 'in', 'out', 'hold'];
const EASE_LABEL: Record<Ease, string> = { inOut: 'Smooth', linear: 'Linear', in: 'Ease in', out: 'Ease out', hold: 'Hold' };
const rot = (x: number, y: number, deg: number): Pt => { const r = (deg * Math.PI) / 180; return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]; };

function paint(c: HTMLCanvasElement, img: PixelImage, z: number, tint?: [number, number, number, number]) {
  const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
  const d = new Uint8ClampedArray(img.data);
  if (tint) for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { d[i] = (d[i] + tint[0]) / 2; d[i + 1] = (d[i + 1] + tint[1]) / 2; d[i + 2] = (d[i + 2] + tint[2]) / 2; d[i + 3] = tint[3]; }
  t.getContext('2d')!.putImageData(new ImageData(d, img.width, img.height), 0, 0);
  const g = c.getContext('2d')!; g.imageSmoothingEnabled = false; g.drawImage(t, 0, 0, img.width * z, img.height * z);
}

/**
 * The rig: cut the reference into parts with joints (by hand or by Claude), then animate
 * any move with keyframes. Only the keys are stored; in-betweens are interpolated, and
 * every frame is the reference's real pixels moved, so the character never drifts.
 */
export function RigTab(props: TabProps) {
  const { projectId, design: d, update, runClaude, busy, model, assets, notify, fail, onAssetsChanged } = props;
  const [ref, setRef] = useState<PixelImage | null>(null);
  const [info, setInfo] = useState<{ pivot: { x: number; y: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rig: CharacterRig = d.rig ?? { parts: [], clips: {} };
  const [parts, setParts] = useState<RigPart[]>(rig.parts);
  useEffect(() => { setParts(d.rig?.parts ?? []); }, [d.rig?.parts]); // eslint-disable-line react-hooks/exhaustive-deps
  const linked = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([
      loadImage(`/api/projects/${projectId}/characters/${d.id}/rig/reference.png?v=${encodeURIComponent(linked?.updatedAt ?? '')}`),
      fetch(`/api/projects/${projectId}/characters/${d.id}/rig/reference.json`).then(r => (r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))))),
    ]).then(([img, j]) => { if (live) { setRef(toPixels(img)); setInfo(j); } }, e => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [projectId, d.id, linked?.updatedAt]);

  const saveParts = (next: RigPart[]) => { setParts(next); update({ ...d, rig: { parts: next, clips: rig.clips } }); };

  if (error) return <div className="card"><p className="dim">{error}</p></div>;
  if (!ref || !info) return <p className="dim small">Loading the reference…</p>;
  return (
    <div className="rig">
      <PartsEditor ref_={ref} parts={parts} setParts={setParts} saveParts={saveParts}
        claude={<ClaudeButton label={parts.length ? 'Recut parts with Claude' : 'Cut the parts with Claude'} busyLabel="Cutting…" busy={busy === 'rig-parts'} icon="scissors"
          onClick={() => { if (!parts.length || confirm('Replace the current parts with a new cut? Existing clips keep their angles by part name.')) void runClaude('rig-parts', () => api.rigSuggest(projectId, d.id, model)); }}
          title="Claude reads the reference pixel by pixel and cuts torso, head, arms, legs and props with joints. One call, a few minutes; you only do this once per character." />} />
      {parts.length > 0 && <MovesetQueue {...props} />}
      {parts.length > 0 && <ClipEditor {...props} ref_={ref} parts={parts} refPivot={info.pivot} linked={linked ?? null} onSaved={onAssetsChanged} notify={notify} fail={fail} />}
    </div>
  );
}

// ---------- parts ----------

function PartsEditor({ ref_: ref, parts, setParts, saveParts, claude }: { ref_: PixelImage; parts: RigPart[]; setParts: (p: RigPart[]) => void; saveParts: (p: RigPart[]) => void; claude: React.ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<Pt[] | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const drag = useRef<{ kind: 'vertex' | 'pivot'; part: string; index: number } | null>(null);
  const cv = rigCanvas(ref);
  const z = Math.max(2, Math.min(8, Math.floor(560 / Math.max(cv.width, cv.height))));
  const own = useMemo(() => partOwnership(ref, parts), [ref, parts]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = cv.width * z; c.height = cv.height * z;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0c0c14'; g.fillRect(0, 0, c.width, c.height);
    // the reference, each pixel tinted by the part that owns it
    const t: PixelImage = { width: cv.width, height: cv.height, data: new Uint8ClampedArray(cv.width * cv.height * 4) };
    for (let y = 0; y < ref.height; y++) for (let x = 0; x < ref.width; x++) {
      const i = (y * ref.width + x) * 4;
      if (ref.data[i + 3] < 128) continue;
      t.data.set(ref.data.subarray(i, i + 4), ((y + cv.pad) * cv.width + x + cv.pad) * 4);
    }
    paint(c, t, z);
    const P = (p: Pt): Pt => [(p[0] + cv.pad) * z, (p[1] + cv.pad) * z];
    parts.forEach((p, i) => {
      const on = p.name === sel;
      g.beginPath(); p.poly.forEach((q, k) => { const [x, y] = P(q); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.closePath();
      g.fillStyle = partColor(i, on ? 0.22 : 0.1); g.fill();
      g.strokeStyle = partColor(i, on ? 1 : 0.6); g.lineWidth = on ? 2 : 1; g.stroke();
      if (on) { g.fillStyle = '#fff'; for (const q of p.poly) { const [x, y] = P(q); g.fillRect(x - 3, y - 3, 6, 6); } }
      // joint + bone to the parent's joint
      const [px, py] = P(p.pivot);
      const parent = parts.find(o => o.name === p.parent);
      if (parent) { const [qx, qy] = P(parent.pivot); g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(qx, qy); g.lineTo(px, py); g.stroke(); g.setLineDash([]); }
      g.beginPath(); g.arc(px, py, on ? 6 : 4.5, 0, Math.PI * 2); g.fillStyle = partColor(i); g.fill(); g.strokeStyle = '#0c0c14'; g.lineWidth = 2; g.stroke();
    });
    if (drawing) {
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.setLineDash([4, 3]);
      g.beginPath(); [...drawing, ...(hover ? [hover] : [])].forEach((q, k) => { const [x, y] = P(q); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); g.setLineDash([]);
      for (const q of drawing) { const [x, y] = P(q); g.fillStyle = '#fff'; g.fillRect(x - 2.5, y - 2.5, 5, 5); }
    }
  }, [ref, parts, sel, drawing, hover, z, cv.width, cv.height, cv.pad]);

  const toRef = (e: React.PointerEvent): Pt => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * cv.width - cv.pad), Math.round(((e.clientY - r.top) / r.height) * cv.height - cv.pad)];
  };
  const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) * z < 9;

  const finish = (pts: Pt[]) => {
    setDrawing(null); setHover(null);
    if (pts.length < 3) return;
    const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length, cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    let name = `part ${parts.length + 1}`, n = 2;
    while (parts.some(p => p.name === name)) name = `part ${parts.length + n++}`;
    const root = parts.find(p => !p.parent);
    saveParts([...parts, { name, poly: pts, pivot: [Math.round(cx), Math.round(cy)], parent: root?.name ?? null, z: 1 }]);
    setSel(name);
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = toRef(e);
    if (drawing) {
      if (drawing.length >= 3 && near(p, drawing[0])) finish(drawing);
      else setDrawing([...drawing, p]);
      return;
    }
    const cur = parts.find(x => x.name === sel);
    const vi = cur?.poly.findIndex(q => near(p, q)) ?? -1;
    if (cur && vi >= 0) { drag.current = { kind: 'vertex', part: cur.name, index: vi }; return; }
    const pj = [...parts].reverse().find(x => near(p, x.pivot));
    if (pj) { setSel(pj.name); drag.current = { kind: 'pivot', part: pj.name, index: 0 }; return; }
    const i = p[0] >= 0 && p[1] >= 0 && p[0] < ref.width && p[1] < ref.height ? own[p[1] * ref.width + p[0]] : -1;
    setSel(i >= 0 ? parts[i].name : null);
  };
  const onMove = (e: React.PointerEvent) => {
    const p = toRef(e);
    if (drawing) { setHover(p); return; }
    const dg = drag.current;
    if (!dg) return;
    setParts(parts.map(x => (x.name !== dg.part ? x : dg.kind === 'pivot' ? { ...x, pivot: p } : { ...x, poly: x.poly.map((q, k) => (k === dg.index ? p : q)) })));
  };
  const onUp = () => { if (drag.current) { drag.current = null; saveParts(parts); } };

  const patch = (name: string, patchP: Partial<RigPart>) => {
    const renamed = patchP.name && patchP.name !== name;
    saveParts(parts.map(p => (p.name === name ? { ...p, ...patchP } : renamed && p.parent === name ? { ...p, parent: patchP.name! } : p)));
    if (renamed) setSel(patchP.name!);
  };
  const remove = (name: string) => saveParts(parts.filter(p => p.name !== name).map(p => (p.parent === name ? { ...p, parent: parts.find(x => x.name === name)?.parent ?? null } : p)));

  return (
    <section className="card rig-parts">
      <div className="card-head">
        <h3><Icon name="scissors" size={14} /> Parts &amp; joints</h3>
        <span className="dim small">{parts.length ? `${parts.length} parts` : 'cut the reference into moving parts once; every move reuses them'}</span>
        <div className="spacer" />
        {claude}
        <button className={drawing ? 'primary' : ''} onClick={() => (drawing ? finish(drawing) : setDrawing([]))}><Icon name="lasso" /> {drawing ? (drawing.length >= 3 ? 'Finish part' : 'Click points…') : 'Draw a part'}</button>
        {drawing && <button className="ghost" onClick={() => { setDrawing(null); setHover(null); }}>Cancel</button>}
      </div>
      <div className="rig-grid">
        <div className="rig-stage">
          <canvas ref={canvas} className="pix" style={{ cursor: drawing ? 'crosshair' : 'default' }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
            onDoubleClick={() => drawing && finish(drawing)} />
          <p className="dim small">{drawing ? 'Click around the part; click the first point (or double-click) to close it.' : 'Click a part to select it · drag its corners to reshape · drag a joint dot to move the joint.'}</p>
        </div>
        <div className="rig-list">
          {!parts.length && <p className="dim small">No parts yet. Let Claude cut them (torso, head, arms, legs, props), or draw them yourself.</p>}
          {parts.map((p, i) => (
            <div key={p.name} className={p.name === sel ? 'rig-part on' : 'rig-part'} onClick={() => setSel(p.name)}>
              <span className="rig-dot" style={{ background: partColor(i) }} />
              <input key={p.name} defaultValue={p.name} aria-label="Part name" onBlur={e => { const v = e.target.value.trim(); if (v && v !== p.name && !parts.some(x => x.name === v)) patch(p.name, { name: v }); else e.target.value = p.name; }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
              <select className="compact" value={p.parent ?? ''} onChange={e => patch(p.name, { parent: e.target.value || null })} title="Parent: this part moves with it" aria-label="Parent">
                <option value="">(root)</option>
                {parts.filter(x => x.name !== p.name).map(x => <option key={x.name} value={x.name}>{x.name}</option>)}
              </select>
              <input type="number" className="num tiny" value={p.z} onChange={e => patch(p.name, { z: +e.target.value })} title="Draw order: higher is in front" aria-label="Draw order" />
              <button className="icon-btn" onClick={e => { e.stopPropagation(); remove(p.name); }} aria-label={`Remove ${p.name}`}><Icon name="x" size={12} /></button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- keyframes ----------

function ClipEditor({ projectId, design: d, update, runClaude, busy, model, ref_: ref, parts, refPivot, linked, onSaved, notify, fail }: TabProps & {
  ref_: PixelImage; parts: RigPart[]; refPivot: { x: number; y: number }; linked: import('@kinetome/core').SpriteAsset | null; onSaved: () => void;
}) {
  const rig: CharacterRig = d.rig ?? { parts, clips: {} };
  const [moveId, setMoveId] = useState(d.moves[0]?.id ?? '');
  const move = d.moves.find(m => m.id === moveId) ?? d.moves[0];
  const stored = move ? rig.clips[move.id] : undefined;
  const [clip, setClip] = useState<RigClip | null>(null);
  useEffect(() => { if (move) setClip(stored ? { ...stored, frames: move.frames, fps: move.fps, loop: move.loop } : emptyClip(move.frames, move.fps, move.loop)); }, [move?.id, stored]); // eslint-disable-line react-hooks/exhaustive-deps
  const [frame, setFrame] = useState(0);
  const [sel, setSel] = useState<string | null>(parts[0]?.name ?? null);
  const [playing, setPlaying] = useState(false);
  const [onion, setOnion] = useState(true);
  const [rounds, setRounds] = useState(1);
  const [feedback, setFeedback] = useState('');
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: 'rotate' | 'move'; start: Pt; base: RigPose; part: string; startAngle: number } | null>(null);
  const cv = rigCanvas(ref);
  const z = Math.max(2, Math.min(6, Math.floor(540 / Math.max(cv.width, cv.height))));
  const own = useMemo(() => partOwnership(ref, parts), [ref, parts]);
  const names = useMemo(() => parts.map(p => p.name), [parts]);
  const poses = useMemo(() => (clip ? clipPoses(clip, names) : []), [clip, names]);
  const pose = poses[Math.min(frame, poses.length - 1)] ?? {};
  const key = clip?.keys.find(k => k.frame === frame) ?? null;

  useEffect(() => {
    if (!playing || !clip) return;
    const t = setInterval(() => setFrame(f => (f + 1) % clip.frames), 1000 / clip.fps);
    return () => clearInterval(t);
  }, [playing, clip]);

  const persist = (next: RigClip) => { setClip(next); if (move) update({ ...d, rig: { parts, clips: { ...rig.clips, [move.id]: next } } }); };
  /** Edits at a frame that isn't a key create one there (auto-key), from the current in-between. */
  const setPoseAt = (f: number, p: RigPose, commit: boolean) => {
    if (!clip) return;
    const keys = clip.keys.some(k => k.frame === f) ? clip.keys.map(k => (k.frame === f ? { ...k, pose: p } : k)) : [...clip.keys, { frame: f, pose: p, ease: 'inOut' as Ease }].sort((a, b) => a.frame - b.frame);
    const next = { ...clip, keys };
    if (commit) persist(next); else setClip(next);
  };

  // draw: onion of the previous frame, the frame, joints of the parts
  useEffect(() => {
    const c = canvas.current;
    if (!c || !clip) return;
    c.width = cv.width * z; c.height = cv.height * z;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0c0c14'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = 'rgba(255,90,140,.45)'; g.beginPath(); g.moveTo(0, (refPivot.y + cv.pad + 1) * z + 0.5); g.lineTo(c.width, (refPivot.y + cv.pad + 1) * z + 0.5); g.stroke();
    if (onion && !playing && poses.length > 1) paint(c, renderPose(ref, parts, poses[(frame - 1 + poses.length) % poses.length], cv, own), z, [80, 120, 255, 90]);
    paint(c, renderPose(ref, parts, pose, cv, own), z);
    if (!playing) {
      const tf = solvePose(parts, pose);
      parts.forEach((p, i) => {
        const t = tf.get(p.name)!;
        const [x, y] = [(t.at[0] + cv.pad) * z, (t.at[1] + cv.pad) * z];
        g.beginPath(); g.arc(x, y, p.name === sel ? 6 : 3.5, 0, Math.PI * 2);
        g.fillStyle = partColor(i, p.name === sel ? 1 : 0.8); g.fill(); g.strokeStyle = '#0c0c14'; g.lineWidth = 2; g.stroke();
      });
    }
  }, [clip, pose, poses, frame, onion, playing, sel, ref, parts, own, z, cv.width, cv.height, cv.pad, refPivot.y]);

  /** The part under a canvas point in the CURRENT pose (front-most first). */
  const partAt = (cx: number, cy: number): string | null => {
    const tf = solvePose(parts, pose);
    const order = parts.map((p, i) => ({ p, i })).sort((a, b) => b.p.z - a.p.z);
    for (const { p, i } of order) {
      const t = tf.get(p.name)!;
      const [sx, sy] = rot(cx - cv.pad - t.at[0], cy - cv.pad - t.at[1], -t.angle);
      const rx = Math.floor(sx + p.pivot[0]), ry = Math.floor(sy + p.pivot[1]);
      if (rx >= 0 && ry >= 0 && rx < ref.width && ry < ref.height && own[ry * ref.width + rx] === i) return p.name;
    }
    return null;
  };
  const toCanvas = (e: React.PointerEvent): Pt => { const r = canvas.current!.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * cv.width, ((e.clientY - r.top) / r.height) * cv.height]; };

  const onDown = (e: React.PointerEvent) => {
    if (!clip) return;
    setPlaying(false);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = toCanvas(e);
    const hit = partAt(p[0], p[1]) ?? sel;
    if (!hit) return;
    setSel(hit);
    const t = solvePose(parts, pose).get(hit)!;
    const startAngle = (Math.atan2(p[1] - cv.pad - t.at[1], p[0] - cv.pad - t.at[0]) * 180) / Math.PI;
    drag.current = { mode: e.shiftKey ? 'move' : 'rotate', start: p, base: pose, part: hit, startAngle };
  };
  const onMove = (e: React.PointerEvent) => {
    const dg = drag.current;
    if (!dg) return;
    const p = toCanvas(e);
    const cur = dg.base[dg.part] ?? { angle: 0, dx: 0, dy: 0 };
    let next;
    if (dg.mode === 'move') next = { ...cur, dx: Math.round(cur.dx + p[0] - dg.start[0]), dy: Math.round(cur.dy + p[1] - dg.start[1]) };
    else {
      const t = solvePose(parts, dg.base).get(dg.part)!;
      const a = (Math.atan2(p[1] - cv.pad - t.at[1], p[0] - cv.pad - t.at[0]) * 180) / Math.PI;
      let delta = a - dg.startAngle;
      if (delta > 180) delta -= 360; if (delta < -180) delta += 360;
      next = { ...cur, angle: Math.round(cur.angle + delta) };
    }
    setPoseAt(frame, { ...dg.base, [dg.part]: next }, false);
  };
  const onUp = () => { if (drag.current && clip) { drag.current = null; persist(clip); } };

  const selPose = sel ? pose[sel] ?? { angle: 0, dx: 0, dy: 0 } : null;
  const setSel_ = (patchP: Partial<{ angle: number; dx: number; dy: number }>) => sel && setPoseAt(frame, { ...pose, [sel]: { ...(pose[sel] ?? { angle: 0, dx: 0, dy: 0 }), ...patchP } }, true);

  const save = async () => {
    if (!clip || !move || !linked) return;
    setSaving(true);
    try {
      const frames = poses.map(p => renderPose(ref, parts, p, cv, own));
      const img = await loadImage(api.sheetUrl(projectId, linked));
      const merged = mergeIntoAsset(img, linked, { frames, pivot: { x: refPivot.x + cv.pad, y: refPivot.y + cv.pad }, animations: [{ name: move.id, fps: clip.fps, loop: clip.loop, frames: frames.map((_, i) => i) }] });
      const png = await new Promise<Blob>((res, rej) => merged.canvas.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
      await api.updateAsset(projectId, merged.asset, png);
      onSaved();
      notify(`Saved "${move.id}" into ${linked.name} · ${frames.length} frames from ${clip.keys.length} keys`);
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  if (!move || !clip) return <section className="card"><p className="dim">Add a move in the Animations step first.</p></section>;
  return (
    <section className="card rig-clip">
      <div className="card-head">
        <h3><Icon name="film" size={14} /> Animate with the rig</h3>
        <select className="compact" value={move.id} onChange={e => { setMoveId(e.target.value); setFrame(0); setPlaying(false); }} aria-label="Move">
          {d.moves.map(m => <option key={m.id} value={m.id}>{m.name}{rig.clips[m.id] ? ' ◆' : ''}</option>)}
        </select>
        <span className="dim small">{clip.frames} frames · {clip.fps} fps · {clip.loop ? 'loops' : 'once'} · {clip.keys.length} key{clip.keys.length === 1 ? '' : 's'}</span>
        <div className="spacer" />
        <button className="primary" onClick={() => void save()} disabled={saving || !linked}><Icon name="save" /> {saving ? 'Saving…' : `Save "${move.id}" to ${linked?.name ?? 'library'}`}</button>
      </div>
      <div className="rig-grid">
        <div className="rig-stage">
          <canvas ref={canvas} className="pix" style={{ cursor: 'grab' }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
          <div className="rig-timeline">
            <button className="play-btn" onClick={() => setPlaying(p => !p)} aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'pause' : 'play'} /></button>
            {Array.from({ length: clip.frames }, (_, f) => (
              <button key={f} className={`rig-f${f === frame ? ' cur' : ''}${clip.keys.some(k => k.frame === f) ? ' key' : ''}`} onClick={() => { setPlaying(false); setFrame(f); }} title={clip.keys.some(k => k.frame === f) ? `Key at frame ${f + 1}` : `Frame ${f + 1} (in-between)`}>
                {clip.keys.some(k => k.frame === f) ? '◆' : f + 1}
              </button>
            ))}
          </div>
          <p className="dim small">Drag a part to rotate it around its joint · Shift-drag to move it · editing an in-between adds a key there.</p>
        </div>
        <div className="rig-side">
          <div className="rig-row">
            <strong className="small">Frame {frame + 1}</strong>
            <span className={key ? 'badge ok' : 'badge'}>{key ? 'key' : 'in-between'}</span>
            <div className="spacer" />
            {key ? (
              <>
                <select className="compact" value={key.ease} onChange={e => persist({ ...clip, keys: clip.keys.map(k => (k.frame === frame ? { ...k, ease: e.target.value as Ease } : k)) })} title="How the motion leaves this key" aria-label="Ease">
                  {EASES.map(x => <option key={x} value={x}>{EASE_LABEL[x]}</option>)}
                </select>
                <button className="icon-btn" disabled={clip.keys.length < 2} onClick={() => persist({ ...clip, keys: clip.keys.filter(k => k.frame !== frame) })} title="Delete this key" aria-label="Delete key"><Icon name="trash" size={14} /></button>
              </>
            ) : <button className="small" onClick={() => setPoseAt(frame, pose, true)}><Icon name="plus" size={12} /> Key</button>}
          </div>
          <label className="toggle small"><input type="checkbox" checked={onion} onChange={e => setOnion(e.target.checked)} /> Onion skin (previous frame)</label>
          <h3>Part</h3>
          <select value={sel ?? ''} onChange={e => setSel(e.target.value)} aria-label="Selected part">
            {parts.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          {selPose && (
            <>
              <label className="pt-slider"><span>Angle</span><input type="range" min={-180} max={180} value={Math.round(selPose.angle)} onChange={e => setSel_({ angle: +e.target.value })} /><span className="mono">{Math.round(selPose.angle)}°</span></label>
              <label className="pt-slider"><span>Move x</span><input type="range" min={-30} max={30} value={Math.round(selPose.dx)} onChange={e => setSel_({ dx: +e.target.value })} /><span className="mono">{Math.round(selPose.dx)}</span></label>
              <label className="pt-slider"><span>Move y</span><input type="range" min={-30} max={30} value={Math.round(selPose.dy)} onChange={e => setSel_({ dy: +e.target.value })} /><span className="mono">{Math.round(selPose.dy)}</span></label>
              <button className="small ghost" onClick={() => setSel_({ angle: 0, dx: 0, dy: 0 })}>Reset part</button>
            </>
          )}
          <h3>Claude</h3>
          <p className="dim small">Claude keys {move.name} from its description and pose plan{rounds ? `, then looks at the render and fixes it${rounds > 1 ? ` (${rounds} rounds)` : ''}` : ''}. Each pass is one Claude call of a few minutes (mostly its thinking); the keys it writes are tiny and every later edit is free.</p>
          <input value={feedback} onChange={e => setFeedback(e.target.value)} placeholder={clip.keys.length > 1 ? 'What to change (e.g. snappier, bigger swing)' : 'Optional notes'} aria-label="Notes for Claude" />
          <div className="rig-row">
            <select className="compact" value={rounds} onChange={e => setRounds(+e.target.value)} aria-label="Review rounds">
              <option value={0}>No review</option><option value={1}>1 review</option><option value={2}>2 reviews</option>
            </select>
            <ClaudeButton label={clip.keys.length > 1 ? 'Rekey with Claude' : 'Key it with Claude'} busyLabel="Keyframing…" busy={busy === 'rig-keys'} icon="wand"
              onClick={() => void runClaude('rig-keys', () => api.rigAnimate(projectId, d.id, { move: move.id, model, rounds, feedback: feedback.trim() || undefined })).then(r => { if (r) { setFrame(0); setFeedback(''); } })} />
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- animate the whole moveset in the background ----------

function MovesetQueue({ projectId, design: d, model, fail }: TabProps) {
  const jobs = useQueue().filter(j => j.character === d.id);
  const clips = d.rig?.clips ?? {};
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(d.moves.filter(m => !clips[m.id]).map(m => m.id)));
  const [rounds, setRounds] = useState(1);
  const active = jobs.filter(j => j.status === 'queued' || j.status === 'running');
  const minutes = picked.size * (3 + rounds * 3);
  const start = async () => {
    try {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
      await api.queueMoves(projectId, d.id, { moves: [...picked], model, rounds });
      kickQueue(); setOpen(false);
    } catch (e) { fail(e); }
  };
  return (
    <section className="card rig-queue">
      <div className="card-head">
        <h3><Icon name="layers" size={14} /> Whole moveset</h3>
        <span className="dim small">{active.length ? `${active.length} move${active.length > 1 ? 's' : ''} in the queue: keep working, you'll be notified` : `${Object.keys(clips).length} of ${d.moves.length} moves keyed`}</span>
        <div className="spacer" />
        <button onClick={() => setOpen(o => !o)} aria-expanded={open}><Icon name="wand" /> Animate several moves…</button>
      </div>
      {open && (
        <div className="queue-pick">
          {d.moves.map(m => (
            <label key={m.id} className="toggle"><input type="checkbox" checked={picked.has(m.id)} onChange={() => setPicked(s => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })} /> {m.name} <span className="dim small">{m.frames}f{clips[m.id] ? ' · keyed (redo)' : ''}</span></label>
          ))}
          <div className="rig-row">
            <select className="compact" value={rounds} onChange={e => setRounds(+e.target.value)} aria-label="Review rounds"><option value={0}>No review</option><option value={1}>1 review each</option><option value={2}>2 reviews each</option></select>
            <span className="dim small">≈ {minutes} min with {model === 'opus' ? 'Opus' : model === 'haiku' ? 'Haiku' : 'Sonnet'}, one Claude call per pass, runs on the server one after another</span>
            <div className="spacer" />
            <button className="primary" disabled={!picked.size} onClick={() => void start()}><Icon name="play" /> Queue {picked.size} move{picked.size === 1 ? '' : 's'}</button>
          </div>
        </div>
      )}
      {jobs.length > 0 && (
        <ul className="queue-jobs">
          {jobs.slice(-8).map(j => (
            <li key={j.id} className={`job ${j.status}`}>
              <span className="job-dot" />
              <strong>{d.moves.find(m => m.id === j.move)?.name ?? j.move}</strong>
              <span className="dim small">{j.status === 'running' ? 'animating…' : j.status === 'queued' ? 'waiting' : j.status === 'done' ? `done${j.usage ? ` · ${Math.round(j.usage.output / 1000)}k out` : ''}` : j.error}</span>
              {j.status === 'queued' && <button className="icon-btn" onClick={() => void api.cancelJob(projectId, j.id).then(kickQueue)} aria-label="Remove from queue"><Icon name="x" size={12} /></button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
