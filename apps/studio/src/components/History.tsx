import { useEffect, useState } from 'react';
import type { SpriteAsset } from '@kinetome/core';
import { api, type AssetVersion } from '../api.ts';
import { Icon } from '../icons.tsx';
import { ago } from '../time.ts';
import { Compare } from './Compare.tsx';

/**
 * Every save of a sprite keeps the version before it. Pick one to compare it with the
 * current sprite (side by side, overlay or pixel diff), then restore it if it was better.
 */
export function History({ projectId, asset, onRestored, fail }: { projectId: string; asset: SpriteAsset; onRestored: (a: SpriteAsset) => void; fail: (e: unknown) => void }) {
  const [versions, setVersions] = useState<AssetVersion[] | null>(null);
  const [open, setOpen] = useState<{ v: AssetVersion; asset: SpriteAsset } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setVersions(null); setOpen(null);
    api.listVersions(projectId, asset.id).then(v => live && setVersions(v), () => live && setVersions([]));
    return () => { live = false; };
  }, [projectId, asset.id, asset.updatedAt]);

  const pick = async (v: AssetVersion) => {
    try { setOpen({ v, asset: await api.getVersion(projectId, asset.id, v.id) }); } catch (e) { fail(e); }
  };
  const restore = async () => {
    if (!open) return;
    setBusy(true);
    try { onRestored(await api.restoreVersion(projectId, asset.id, open.v.id)); setOpen(null); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  if (!versions) return <p className="dim small">Loading history…</p>;
  if (!versions.length) return <p className="dim small">No earlier versions yet. Every save from now on keeps the one before it, so you can always go back.</p>;

  return (
    <div className="history">
      {open && (
        <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(null); }}>
          <div className="modal compare-modal">
            <Compare
              left={{ label: `${ago(open.v.savedAt)} · ${open.v.note || 'earlier'}`, sheetUrl: api.versionSheetUrl(projectId, asset.id, open.v.id), asset: open.asset }}
              right={{ label: 'Current', sheetUrl: api.sheetUrl(projectId, asset), asset }}
              onClose={() => setOpen(null)}
              actions={<button className="primary" disabled={busy} onClick={restore}><Icon name="undo" /> Restore this version</button>} />
          </div>
        </div>
      )}
      <ol className="versions">
        {versions.map(v => (
          <li key={v.id}>
            <button className="version" onClick={() => void pick(v)} title="Compare with the current sprite">
              <img src={api.versionSheetUrl(projectId, asset.id, v.id)} alt="" loading="lazy" />
              <span className="version-meta">
                <strong>{v.note || 'Saved'}</strong>
                <span className="dim small">{ago(v.savedAt)} · {v.animations.join(', ') || 'no animations'} · {v.frames}f</span>
              </span>
              <Icon name="chevronRight" size={12} />
            </button>
          </li>
        ))}
      </ol>
      <p className="dim small">Before each save, the previous version is kept (the last 40).</p>
    </div>
  );
}
