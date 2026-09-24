import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, SpriteAsset, StyleBible } from '@sprite/core';
import { api, type AssetDraft } from './api.ts';
import { AssetList } from './components/AssetList.tsx';
import { Viewer } from './components/Viewer.tsx';
import { Inspector } from './components/Inspector.tsx';
import { ImportDialog } from './components/ImportDialog.tsx';
import { LineupView } from './components/LineupView.tsx';
import { StyleView } from './components/StyleView.tsx';
import { useImage } from './pixels.ts';

type Tab = 'library' | 'lineup' | 'style';
const LAST_PROJECT = 'sprite.lastProject';

function readLast(): string | null {
  try { return localStorage.getItem(LAST_PROJECT); } catch { return null; }
}
function writeLast(id: string) {
  try { localStorage.setItem(LAST_PROJECT, id); } catch { /* storage unavailable */ }
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [pid, setPid] = useState<string | null>(null);
  const [style, setStyle] = useState<StyleBible | null>(null);
  const [assets, setAssets] = useState<SpriteAsset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [animName, setAnimName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('library');
  const [importFiles, setImportFiles] = useState<File[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);

  useEffect(() => {
    api.listProjects().then(ps => {
      setProjects(ps);
      const last = readLast();
      setPid(ps.find(p => p.id === last)?.id ?? ps[0]?.id ?? null);
    }, fail);
  }, [fail]);

  useEffect(() => {
    if (!pid) return;
    writeLast(pid);
    setSelectedId(null);
    Promise.all([api.getProject(pid), api.listAssets(pid)]).then(([p, list]) => {
      setStyle(p.style);
      setAssets(list);
      setSelectedId(list[0]?.id ?? null);
    }, fail);
  }, [pid, fail]);

  const selected = assets.find(a => a.id === selectedId) ?? null;
  const img = useImage(pid && selected ? api.sheetUrl(pid, selected) : null);

  useEffect(() => {
    setAnimName(selected?.animations[0]?.name ?? null);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const replaceAsset = (a: SpriteAsset) => setAssets(list => list.map(x => (x.id === a.id ? a : x)));

  const saveAsset = async (a: SpriteAsset, png?: Blob) => {
    if (!pid) return;
    try { replaceAsset(await api.updateAsset(pid, a, png)); } catch (e) { fail(e); }
  };

  const importAsset = async (draft: AssetDraft, png: Blob) => {
    if (!pid) return;
    try {
      const created = await api.createAsset(pid, draft, png);
      setAssets(list => [...list, created]);
      setSelectedId(created.id);
      setImportFiles(null);
      setTab('library');
    } catch (e) { fail(e); }
  };

  const removeAsset = async (id: string) => {
    if (!pid || !confirm(`Delete "${id}"? This removes its files from the project.`)) return;
    try {
      await api.deleteAsset(pid, id);
      setAssets(list => list.filter(a => a.id !== id));
      setSelectedId(null);
    } catch (e) { fail(e); }
  };

  const newProject = async () => {
    const name = prompt('Project name');
    if (!name?.trim()) return;
    try {
      const p = await api.createProject(name.trim());
      setProjects(ps => [...ps, p]);
      setPid(p.id);
      setTab('style');
    } catch (e) { fail(e); }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files].filter(f => /\.(png|json)$/i.test(f.name));
    if (files.length) setImportFiles(files);
  };

  return (
    <div
      className="app"
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">Sprite Studio</div>
        <select value={pid ?? ''} onChange={e => setPid(e.target.value)} aria-label="Project">
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="ghost" onClick={newProject}>New project</button>
        <nav className="tabs">
          {(['library', 'lineup', 'style'] as Tab[]).map(t => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t === 'library' ? 'Library' : t === 'lineup' ? 'Lineup' : 'Style Bible'}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <button className="primary" onClick={() => fileInput.current?.click()} disabled={!pid}>Import sprite…</button>
        <input
          ref={fileInput} type="file" multiple accept=".png,.json" hidden
          onChange={e => { const f = [...(e.target.files ?? [])]; if (f.length) setImportFiles(f); e.target.value = ''; }}
        />
      </header>

      {error && <div className="toast" onClick={() => setError(null)}>{error} <span className="dim">(click to dismiss)</span></div>}

      {pid && style && tab === 'library' && (
        <main className="library">
          <AssetList projectId={pid} assets={assets} selectedId={selectedId} onSelect={setSelectedId} />
          <Viewer asset={selected} img={img} animName={animName} />
          <Inspector
            asset={selected} img={img} style={style} animName={animName}
            onAnim={setAnimName} onSave={saveAsset} onDelete={removeAsset}
          />
        </main>
      )}
      {pid && style && tab === 'lineup' && (
        <LineupView projectId={pid} assets={assets} style={style}
          onOpen={id => { setSelectedId(id); setTab('library'); }} />
      )}
      {pid && style && tab === 'style' && (
        <StyleView projectId={pid} style={style} assets={assets}
          onSaved={setStyle} onError={fail} />
      )}
      {!pid && <div className="empty">No project yet. <button className="primary" onClick={newProject}>Create one</button></div>}

      {importFiles && style && (
        <ImportDialog files={importFiles} style={style} onCancel={() => setImportFiles(null)} onImport={importAsset} onError={fail} />
      )}
      {dragging && <div className="dropveil">Drop PNG (+ optional JSON) to import</div>}
    </div>
  );
}
