import { useEffect, useState } from 'react';
import type { CharacterDesign } from '@kinetome/core';
import { api, type Packed, type ProgramVersion } from '../../api.ts';
import { Icon } from '../../icons.tsx';
import { ago } from '../../time.ts';
import { Compare } from '../Compare.tsx';

const asSheet = (p: Packed) => ({ frames: p.rects, animations: p.animations, frameWidth: p.frameWidth, frameHeight: p.frameHeight, pivot: p.pivot });

/**
 * Earlier versions of one move's animation program (every Claude run or manual change
 * keeps the one before it). Render any of them next to the current one, and roll back.
 */
export function ProgramHistory({ projectId, design: d, move, current, update, fail }: {
  projectId: string; design: CharacterDesign; move: string; current: Packed | null;
  update: (d: CharacterDesign) => void; fail: (e: unknown) => void;
}) {
  const [versions, setVersions] = useState<ProgramVersion[]>([]);
  const [open, setOpen] = useState<{ v: ProgramVersion; packed: Packed } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    let live = true;
    api.programHistory(projectId, d.id, move).then(v => live && setVersions(v), () => {});
    return () => { live = false; };
  }, [projectId, d.id, move, d.programs[move]]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (v: ProgramVersion) => {
    setLoading(v.id);
    try {
      const r = await api.renderCode(projectId, d.id, v.code);
      if (!r.ok) throw new Error(`That version doesn't render anymore: ${r.error}`);
      setOpen({ v, packed: r.packed });
    } catch (e) { fail(e); } finally { setLoading(null); }
  };

  if (!versions.length) return null;
  return (
    <div className="prog-history">
      <button className="ghost small" onClick={() => setShow(s => !s)} aria-expanded={show}>
        <Icon name={show ? 'chevronDown' : 'chevronRight'} /> {versions.length} earlier version{versions.length > 1 ? 's' : ''} · compare or roll back
      </button>
      {show && (
        <ol className="versions compact">
          {versions.map((v, k) => (
            <li key={v.id}>
              <button className="version" onClick={() => void pick(v)} disabled={!!loading}>
                <span className="version-meta"><strong>{k === 0 ? 'Just before the latest change' : `Version ${versions.length - k}`}</strong><span className="dim small">{ago(v.savedAt)} · {Math.round(v.code.length / 100) / 10}k chars</span></span>
                {loading === v.id ? <span className="dim small">rendering…</span> : <Icon name="chevronRight" size={12} />}
              </button>
            </li>
          ))}
        </ol>
      )}
      {open && current && (
        <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(null); }}>
          <div className="modal compare-modal">
            <Compare
              left={{ label: `Earlier · ${ago(open.v.savedAt)}`, sheetUrl: open.packed.sheet, asset: sheetFor(open.packed, move) }}
              right={{ label: 'Current', sheetUrl: current.sheet, asset: sheetFor(current, move) }}
              onClose={() => setOpen(null)}
              actions={<button className="primary" onClick={() => { update({ ...d, programs: { ...d.programs, [move]: open.v.code } }); setOpen(null); }}><Icon name="undo" /> Use this version</button>} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Only this move's animation, so the compare doesn't offer the character's other moves. */
function sheetFor(p: Packed, move: string) {
  const s = asSheet(p);
  const only = s.animations.filter(a => a.name === move);
  return { ...s, animations: only.length ? only : s.animations };
}
