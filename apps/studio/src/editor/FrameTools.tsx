import { useMemo, useState } from 'react';
import { assessResult } from '@kinetome/pixel';
import { Icon } from '../icons.tsx';
import {
  alignFrames, cleanupFrames, composite, flip, hardenFrames, hexToRgba, mapCels, outlineFrames, propagateEdit,
  removeBackgroundFrames, replaceColorFrames, snapFrames,
} from './model.ts';
import type { EditorApi } from './useEditor.ts';

type Scope = 'current' | 'picked' | 'all';

/**
 * Batch clean-up and fixes across frames: what turns an imported or generated sheet into
 * a clean, consistent animation without touching every frame by hand.
 */
export function FrameTools({ ed, notify }: { ed: EditorApi; notify: (msg: string) => void }) {
  const { state } = ed;
  const { doc, layerId, frame, picked, lastEdit } = state;
  const [scope, setScope] = useState<Scope>(picked.length > 1 ? 'picked' : 'all');
  const [tolerance, setTolerance] = useState(0.09);
  const [holes, setHoles] = useState<'auto' | 'on' | 'off'>('auto');
  const [follow, setFollow] = useState<'same' | 'feet'>('feet');
  const frames = scope === 'current' ? [frame] : scope === 'picked' ? picked : doc.frames.map((_, i) => i);
  const layerName = doc.layers.find(l => l.id === layerId)?.name ?? '';
  const n = frames.length;

  const run = (label: string, fn: () => typeof doc) => { ed.settle(); ed.commit(label, fn()); notify(`${label} · ${n} frame${n > 1 ? 's' : ''}`); };

  // on demand: checking every frame after every stroke would slow drawing down
  const [checkedDoc, setCheckedDoc] = useState<typeof doc | null>(null);
  const quality = useMemo(() => {
    if (!checkedDoc || checkedDoc.frames.length < 2) return null;
    return assessResult({ frames: checkedDoc.frames.map((_, i) => composite(checkedDoc, i)), pivot: checkedDoc.pivot, palette: checkedDoc.palette, mode: 'native', grids: [] }, Math.max(8, checkedDoc.palette.length || 32));
  }, [checkedDoc]);

  const fixTargets = picked.filter(i => i !== lastEdit?.frame);

  return (
    <section className="ed-panel">
      <div className="ed-panel-head"><h3>Frame tools</h3></div>
      <div className="seg compact ed-scope" role="radiogroup" aria-label="Apply to">
        {(['current', 'picked', 'all'] as Scope[]).map(s => (
          <button key={s} role="radio" aria-checked={scope === s} className={scope === s ? 'active' : ''} onClick={() => setScope(s)}>
            {s === 'current' ? 'This frame' : s === 'picked' ? `Picked (${picked.length})` : `All (${doc.frames.length})`}
          </button>
        ))}
      </div>
      <p className="dim small">Acts on layer "{layerName}".</p>

      <div className="ed-tool-group">
        <div className="ed-row wrap">
          <button onClick={() => {
            ed.settle();
            const r = removeBackgroundFrames(ed.ref.current.doc, layerId, frames, { tolerance, holes });
            if (!r.background) { notify('No flat background found on this layer (it may already be transparent)'); return; }
            ed.commit('Remove background', r.doc);
            notify(`Removed a ${r.background.kind === 'checker' ? 'checkerboard' : 'solid'} background · ${n} frame${n > 1 ? 's' : ''}`);
          }}><Icon name="scissors" size={12} /> Remove background</button>
          <label className="ed-opt small" title="How close a color must be to the backdrop">tol <input type="number" className="num" step={0.01} min={0.01} max={0.4} value={tolerance} onChange={e => setTolerance(+e.target.value || 0.09)} /></label>
          <select className="compact" value={holes} onChange={e => setHoles(e.target.value as typeof holes)} title="Clear enclosed gaps (between arm and body)" aria-label="Enclosed gaps">
            <option value="auto">gaps: auto</option><option value="on">gaps: clear</option><option value="off">gaps: keep</option>
          </select>
        </div>
        <div className="ed-row wrap">
          <button className="small" onClick={() => run('Clean stray pixels', () => cleanupFrames(doc, layerId, frames))}>Clean strays</button>
          <button className="small" onClick={() => run('Harden alpha', () => hardenFrames(doc, layerId, frames))} title="No semi-transparent pixels">Harden alpha</button>
          <button className="small" onClick={() => run('Snap to palette', () => snapFrames(doc, layerId, frames, doc.palette))} disabled={doc.palette.length < 2} title="Every pixel to its nearest palette color">Snap to palette</button>
          <button className="small" onClick={() => run('Outline', () => outlineFrames(doc, layerId, frames, state.primary))} title="1px outline in the primary color">Outline</button>
          <button className="small" onClick={() => run('Replace color', () => replaceColorFrames(doc, layerId, frames, hexToRgba(state.primary), hexToRgba(state.secondary)))} title="Primary color becomes the secondary color">
            <span className="ed-mini-sw" style={{ background: state.primary }} />→<span className="ed-mini-sw" style={{ background: state.secondary }} /> Replace
          </button>
        </div>
        <div className="ed-row wrap">
          <button className="small" onClick={() => run('Align feet', () => alignFrames(doc, frames, 'feet'))} title="Feet on the pivot / ground line in every frame (all layers)"><Icon name="pivot" size={12} /> Align feet</button>
          <button className="small" onClick={() => run('Center', () => alignFrames(doc, frames, 'center'))}>Center</button>
          <button className="small" onClick={() => run('Flip horizontal', () => mapCels(doc, layerId, frames, img => flip(img, 'h')))}>Flip ↔</button>
          <button className="small" onClick={() => run('Flip vertical', () => mapCels(doc, layerId, frames, img => flip(img, 'v')))}>Flip ↕</button>
        </div>
      </div>

      <div className="ed-panel-head"><h3>Apply fix to other frames</h3></div>
      {lastEdit ? (
        <>
          <p className="dim small">Last edit: <strong>{lastEdit.label}</strong> on frame {lastEdit.frame + 1}. Pick target frames in the timeline (Shift/Ctrl-click), then stamp the same change onto them.</p>
          <div className="ed-row">
            <select className="compact" value={follow} onChange={e => setFollow(e.target.value as typeof follow)} aria-label="Placement">
              <option value="feet">follow the character</option><option value="same">same position</option>
            </select>
            <button className="primary small" disabled={!fixTargets.length}
              onClick={() => run('Apply fix to frames', () => propagateEdit(doc, lastEdit.layerId, lastEdit.frame, lastEdit.before, lastEdit.after, fixTargets, follow))}>
              Apply to {fixTargets.length || 'picked'} frame{fixTargets.length === 1 ? '' : 's'}
            </button>
          </div>
        </>
      ) : <p className="dim small">Draw a fix on one frame (a missing eye, a stray pixel, a detail), then stamp it onto the others here.</p>}

      <div className="ed-panel-head">
        <h3>Quality</h3>
        {quality && <span className={`badge ${quality.score >= 90 ? 'ok' : quality.score >= 70 ? 'warn' : 'err'}`}>{quality.score}</span>}
        <div className="spacer" />
        <button className="small" onClick={() => setCheckedDoc(doc)} disabled={doc.frames.length < 2} title="Size drift, glitch frames, flicker colors, loose pixels">{checkedDoc === doc ? 'Checked' : 'Check frames'}</button>
      </div>
      {quality && checkedDoc !== doc && <p className="dim small">Edited since the check; run it again.</p>}
      {quality && (
        <>
          {quality.issues.length === 0 ? <p className="dim small">No problems found across {doc.frames.length} frames.</p>
            : quality.issues.slice(0, 4).map((i, k) => (
              <div key={k} className={`issue ${i.severity} small`}>
                <span>{i.message}</span>
                {i.frames && i.frames.length > 0 && <button className="linklike" onClick={() => { ed.goto(i.frames![0]); ed.set({ picked: i.frames! }); }}>pick these frames</button>}
              </div>
            ))}
        </>
      )}
    </section>
  );
}
