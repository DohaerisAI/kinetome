import { useEffect, useMemo, useState } from 'react';
import type { Project, SpriteAsset } from '@kinetome/core';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { FrameThumb } from './FrameThumb.tsx';
import { useImage } from '../pixels.ts';

type Engine = 'godot' | 'phaser' | 'pixi' | 'unity' | 'texturepacker' | 'aseprite';
const ENGINES: { id: Engine; name: string; blurb: string; normals: boolean }[] = [
  { id: 'godot', name: 'Godot 4', blurb: 'SpriteFrames + ready scenes, hitboxes and frame events', normals: true },
  { id: 'unity', name: 'Unity', blurb: 'Atlas + .meta: Multiple sprites, Point filter, feet pivots', normals: true },
  { id: 'phaser', name: 'Phaser 3', blurb: 'Atlas JSON + animation config', normals: true },
  { id: 'pixi', name: 'PixiJS', blurb: 'Atlas JSON with animations', normals: true },
  { id: 'texturepacker', name: 'TexturePacker JSON', blurb: 'The format most engines and loaders read', normals: true },
  { id: 'aseprite', name: 'Aseprite', blurb: 'One .aseprite per sprite, animations as tags', normals: false },
];

function Pick({ projectId, asset, on, toggle }: { projectId: string; asset: SpriteAsset; on: boolean; toggle: () => void }) {
  const img = useImage(api.sheetUrl(projectId, asset));
  return (
    <label className={on ? 'exp-sprite on' : 'exp-sprite'}>
      <input type="checkbox" checked={on} onChange={toggle} />
      <FrameThumb img={img} rect={asset.frames[asset.animations[0]?.frames[0] ?? 0]} size={32} className="thumb" />
      <span>{asset.name}</span>
    </label>
  );
}

/** Export any set of sprites for any engine, in one place. */
export function ExportDialog({ projectId, project, assets, initial, onClose, onSync }: {
  projectId: string; project: Project | null; assets: SpriteAsset[]; initial?: string[]; onClose: () => void; onSync: (() => void) | null;
}) {
  const [engine, setEngine] = useState<Engine>(() => { try { return (localStorage.getItem('kinetome.export.engine') as Engine) || 'godot'; } catch { return 'godot'; } });
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial?.length ? initial : assets.map(a => a.id)));
  const [normals, setNormals] = useState(false);
  const [ppu, setPpu] = useState(16);
  useEffect(() => { try { localStorage.setItem('kinetome.export.engine', engine); } catch { /* storage off */ } }, [engine]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const eng = ENGINES.find(e => e.id === engine)!;
  const url = useMemo(() => {
    const q = new URLSearchParams();
    if (picked.size !== assets.length) q.set('assets', [...picked].join(','));
    if (normals && eng.normals) q.set('normals', '1');
    if (engine === 'unity') q.set('ppu', String(ppu));
    return `/api/projects/${projectId}/export/${engine}.zip${q.size ? `?${q}` : ''}`;
  }, [picked, assets.length, normals, eng, engine, ppu, projectId]);
  const toggle = (id: string) => setPicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal export-modal" role="dialog" aria-label="Export">
        <div className="modal-head">
          <span className="ph-icon small"><Icon name="download" /></span>
          <div><strong>Export</strong><div className="dim small">Pick an engine and the sprites; you get a zip laid out the way that engine expects, with a README.</div></div>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="export-body">
          <div className="exp-engines" role="radiogroup" aria-label="Engine">
            {ENGINES.map(e => (
              <button key={e.id} role="radio" aria-checked={engine === e.id} className={engine === e.id ? 'exp-engine on' : 'exp-engine'} onClick={() => setEngine(e.id)}>
                <strong>{e.name}</strong><span className="dim small">{e.blurb}</span>
              </button>
            ))}
          </div>
          <div className="exp-side">
            <div className="section-head">
              <h3>Sprites <span className="dim">{picked.size} of {assets.length}</span></h3>
              <div className="spacer" />
              <button className="ghost small" onClick={() => setPicked(new Set(picked.size === assets.length ? [] : assets.map(a => a.id)))}>{picked.size === assets.length ? 'None' : 'All'}</button>
            </div>
            <div className="exp-sprites">
              {assets.map(a => <Pick key={a.id} projectId={projectId} asset={a} on={picked.has(a.id)} toggle={() => toggle(a.id)} />)}
            </div>
            {eng.normals && <label className="toggle block"><input type="checkbox" checked={normals} onChange={e => setNormals(e.target.checked)} /> Include normal maps for 2D lighting</label>}
            {engine === 'unity' && (
              <label className="field"><span>Pixels per unit</span>
                <input type="number" min={1} max={512} value={ppu} onChange={e => setPpu(Math.max(1, +e.target.value || 16))} />
              </label>
            )}
          </div>
        </div>
        <div className="modal-foot">
          {engine === 'godot' && onSync && project?.godot.path && <button onClick={() => { onSync(); onClose(); }} title={project.godot.path}><Icon name="refresh" /> Sync into {project.godot.path.split(/[\\/]/).pop()}</button>}
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <a className={`button primary${picked.size ? '' : ' disabled'}`} href={picked.size ? url : undefined} onClick={() => picked.size && setTimeout(onClose, 300)}>
            <Icon name="download" /> Download {eng.name} zip
          </a>
        </div>
      </div>
    </div>
  );
}
