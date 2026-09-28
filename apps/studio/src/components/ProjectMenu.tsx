import { useEffect, useRef, useState } from 'react';
import type { Project } from '@kinetome/core';
import { Icon } from '../icons.tsx';

/** The project switcher: switch, create, rename, duplicate, delete, and the trash. */
export function ProjectMenu({ projects, current, onSwitch, onNew, onRename, onDuplicate, onDelete, onTrash }: {
  projects: Project[]; current: Project | null;
  onSwitch: (id: string) => void; onNew: () => void; onRename: () => void; onDuplicate: () => void; onDelete: () => void; onTrash: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const act = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="project-menu" ref={box}>
      <button className="project-switch" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="menu">
        <Icon name="folder" size={14} />
        <span className="pm-name">{current?.name ?? 'No project'}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="pm-pop" role="menu">
          <div className="pm-title">Projects</div>
          {projects.map(p => (
            <button key={p.id} role="menuitemradio" aria-checked={p.id === current?.id} className={p.id === current?.id ? 'pm-item on' : 'pm-item'} onClick={act(() => onSwitch(p.id))}>
              <Icon name={p.id === current?.id ? 'check' : 'folder'} size={14} /> {p.name}
            </button>
          ))}
          <button role="menuitem" className="pm-item" onClick={act(onNew)}><Icon name="plus" size={14} /> New project…</button>
          {current && (
            <>
              <div className="pm-sep" />
              <button role="menuitem" className="pm-item" onClick={act(onRename)}><Icon name="pencil" size={14} /> Rename “{current.name}”…</button>
              <button role="menuitem" className="pm-item" onClick={act(onDuplicate)}><Icon name="duplicate" size={14} /> Duplicate</button>
              <button role="menuitem" className="pm-item danger" onClick={act(onDelete)}><Icon name="trash" size={14} /> Delete project…</button>
            </>
          )}
          <div className="pm-sep" />
          <button role="menuitem" className="pm-item" onClick={act(onTrash)}><Icon name="trash" size={14} /> Trash</button>
        </div>
      )}
    </div>
  );
}
