import { useEffect, useState } from 'react';
import { api, type TrashEntry } from '../api.ts';
import { Icon, type IconName } from '../icons.tsx';
import { ago } from '../time.ts';

const KIND: Record<TrashEntry['kind'], { icon: IconName; label: string }> = {
  asset: { icon: 'image', label: 'Sprite' },
  character: { icon: 'users', label: 'Character' },
  project: { icon: 'folder', label: 'Project' },
};

/** Everything deleted, for 30 days: restore it, or let it go for good. */
export function TrashDialog({ projectId, projectName, onClose, onRestored, fail }: {
  projectId: string | null; projectName: (id: string) => string; onClose: () => void;
  onRestored: (e: TrashEntry & { restoredId: string }) => void; fail: (e: unknown) => void;
}) {
  const [items, setItems] = useState<TrashEntry[] | null>(null);
  const [scope, setScope] = useState<'project' | 'all'>(projectId ? 'project' : 'all');
  const load = () => api.listTrash(scope === 'project' && projectId ? projectId : undefined).then(setItems, fail);
  useEffect(() => { void load(); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const restore = async (e: TrashEntry) => {
    try { const r = await api.restoreTrash(e.id); onRestored(r); await load(); } catch (err) { fail(err); }
  };
  const purge = async (e?: TrashEntry) => {
    if (!confirm(e ? `Delete "${e.name}" forever? This can't be undone.` : 'Empty the trash? Everything in it is deleted forever.')) return;
    try { await api.purgeTrash(e?.id); await load(); } catch (err) { fail(err); }
  };

  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal trash-modal" role="dialog" aria-label="Trash">
        <div className="modal-head">
          <span className="ph-icon small"><Icon name="trash" /></span>
          <div><strong>Trash</strong><div className="dim small">Deleted sprites, characters and projects stay here for 30 days.</div></div>
          <div className="spacer" />
          {projectId && (
            <div className="seg compact" role="radiogroup" aria-label="Show">
              <button role="radio" aria-checked={scope === 'project'} className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')}>This project</button>
              <button role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>Everything</button>
            </div>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="trash-list">
          {!items && <p className="dim pad">Loading…</p>}
          {items && !items.length && (
            <div className="empty-inline col"><Icon name="trash" size={24} /><span>The trash is empty.</span></div>
          )}
          {items?.map(e => (
            <div key={e.id} className="trash-row">
              {e.kind === 'asset'
                ? <img className="trash-thumb" src={api.trashThumbUrl(e.id)} alt="" loading="lazy" />
                : <span className="trash-thumb icon"><Icon name={KIND[e.kind].icon} size={18} /></span>}
              <span className="trash-meta">
                <strong>{e.name}</strong>
                <span className="dim small">{KIND[e.kind].label}{e.kind !== 'project' ? ` in ${projectName(e.projectId)}` : ''} · deleted {ago(e.deletedAt)}</span>
              </span>
              <button onClick={() => void restore(e)}><Icon name="undo" size={14} /> Restore</button>
              <button className="icon-btn danger" onClick={() => void purge(e)} title="Delete forever" aria-label={`Delete ${e.name} forever`}><Icon name="x" /></button>
            </div>
          ))}
        </div>
        {items && items.length > 0 && (
          <div className="modal-foot">
            <span className="dim small">{items.length} item{items.length > 1 ? 's' : ''}</span>
            <div className="spacer" />
            <button className="danger" onClick={() => void purge()}>Empty trash</button>
          </div>
        )}
      </div>
    </div>
  );
}
