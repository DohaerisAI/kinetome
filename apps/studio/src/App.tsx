import { useCallback, useEffect, useRef, useState } from 'react';
import { designPalette, type CharacterDesign, type Project, type SpriteAsset, type StyleBible } from '@sprite/core';
import { api, type AssetDraft, type Model, type Usage } from './api.ts';
import { CharactersView } from './components/characters/CharactersView.tsx';
import type { ImportRequest } from './components/characters/shared.tsx';
import { fmtTokens } from './components/characters/shared.tsx';
import { Icon, type IconName } from './icons.tsx';
import { AssetList } from './components/AssetList.tsx';
import { Viewer } from './components/Viewer.tsx';
import { Inspector } from './components/Inspector.tsx';
import { ImportDialog } from './components/ImportDialog.tsx';
import { PixelizeDialog } from './components/PixelizeDialog.tsx';
import { isVideo } from './decode.ts';
import { LineupView } from './components/LineupView.tsx';
import { StyleView } from './components/StyleView.tsx';
import { useImage } from './pixels.ts';

type Tab = 'library' | 'characters' | 'lineup' | 'style';
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'library', label: 'Library', icon: 'layers' },
  { id: 'characters', label: 'Characters', icon: 'users' },
  { id: 'lineup', label: 'Lineup', icon: 'grid' },
  { id: 'style', label: 'Style Bible', icon: 'palette' },
];
const MODEL_KEY = 'sprite.model';
const readModel = (): Model => { try { const m = localStorage.getItem(MODEL_KEY); return m === 'opus' || m === 'haiku' ? m : 'sonnet'; } catch { return 'sonnet'; } };
const LAST_PROJECT = 'sprite.lastProject';

function readLast(): string | null {
  try { return localStorage.getItem(LAST_PROJECT); } catch { return null; }
}
function writeLast(id: string) {
  try { localStorage.setItem(LAST_PROJECT, id); } catch { /* storage unavailable */ }
}

/**
 * A PNG that is already a clean sprite sheet (real transparency, a small palette) goes to
 * the sheet importer. Anything else (opaque backdrop, thousands of colors: AI output,
 * screenshots, illustrations) goes to Pixelize for cleanup.
 */
async function isCleanSpriteSheet(file: File): Promise<boolean> {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let transparent = 0;
    const colors = new Set<number>();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) { transparent++; continue; }
      if (colors.size <= 256) colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    return transparent > d.length / 4 * 0.05 && colors.size <= 256;
  } catch { return false; }
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [pid, setPid] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [style, setStyle] = useState<StyleBible | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assets, setAssets] = useState<SpriteAsset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [animName, setAnimName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('library');
  const [importFiles, setImportFiles] = useState<File[] | null>(null);
  const [pixelizeFiles, setPixelizeFiles] = useState<File[] | null>(null);
  const [pixelizeTarget, setPixelizeTarget] = useState<{ asset: string | null; anim: string | null; design: CharacterDesign | null }>({ asset: null, anim: null, design: null });
  const pendingImport = useRef<ImportRequest | null>(null);
  const [model, setModel] = useState<Model>(readModel);
  const [claude, setClaude] = useState<{ available: boolean; version: string | null; error?: string } | null>(null);
  const [sessionUsage, setSessionUsage] = useState({ tokens: 0, calls: 0 });
  const [designs, setDesigns] = useState<CharacterDesign[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pixelInput = useRef<HTMLInputElement>(null);

  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  const notify = useCallback((msg: string) => setNotice(msg), []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => { api.claudeStatus().then(setClaude, () => setClaude({ available: false, version: null })); }, []);
  useEffect(() => { try { localStorage.setItem(MODEL_KEY, model); } catch { /* storage unavailable */ } }, [model]);

  const onUsage = useCallback((u: Usage) => setSessionUsage(s => ({ tokens: s.tokens + u.input + u.cacheRead + u.cacheWrite + u.output, calls: s.calls + 1 })), []);

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
      setProject(p.project);
      setStyle(p.style);
      setAssets(list);
      setSelectedId(list[0]?.id ?? null);
    }, fail);
  }, [pid, fail]);

  // character designs own their palettes: the style check accepts them for the linked sprite
  useEffect(() => {
    if (pid && tab !== 'characters') api.listCharacters(pid).then(setDesigns, () => setDesigns([]));
  }, [pid, tab, assets]);
  const paletteFor = useCallback((assetId: string) => {
    const d = designs.find(x => x.assetId === assetId);
    return d ? designPalette(d) : [];
  }, [designs]);

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

  const importAsset = async (draft: AssetDraft, png: Blob): Promise<boolean> => {
    if (!pid) return false;
    try {
      const created = await api.createAsset(pid, draft, png);
      setAssets(list => [...list, created]);
      setSelectedId(created.id);
      setImportFiles(null);
      setTab('library');
      return true;
    } catch (e) { fail(e); return false; }
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

  const syncGodot = async (assetId?: string) => {
    if (!pid) return;
    try {
      const r = await api.syncGodot(pid, assetId);
      setNotice(`Wrote ${r.written.length} files into ${r.root}`);
    } catch (e) { fail(e); }
  };

  /**
   * PNG (+JSON) sprite sheets go to the sheet importer; photos, illustrations, GIFs,
   * videos and frame sequences go to the pixelizer.
   */
  const routeFiles = async (all: File[]) => {
    const files = all.filter(f => /\.(png|json|jpe?g|gif|webp|bmp|avif|mp4|webm|mov|m4v)$/i.test(f.name) || isVideo(f));
    if (!files.length) return;
    const hasJson = files.some(f => /\.json$/i.test(f.name));
    const onlyPng = files.length === 1 && /\.png$/i.test(files[0].name);
    if (hasJson || (onlyPng && await isCleanSpriteSheet(files[0]))) setImportFiles(files);
    else openPixelize(files.filter(f => !/\.json$/i.test(f.name)));
  };

  const openPixelize = (files: File[], asset: string | null = null, anim: string | null = null) => {
    pendingImport.current = null;
    setPixelizeTarget({ asset, anim, design: null });
    setPixelizeFiles(files);
  };

  const refreshAssets = useCallback(() => {
    if (pid) api.listAssets(pid).then(setAssets, fail);
  }, [pid, fail]);

  const importPixelized = async (draft: AssetDraft, png: Blob) => {
    if (!pid) return;
    try {
      const created = await api.createAsset(pid, draft, png);
      setAssets(list => [...list, created]);
      pendingImport.current?.onDone(created);
      pendingImport.current = null;
      setPixelizeFiles(null);
      if (tab !== 'characters') { setSelectedId(created.id); setTab('library'); }
      setNotice(`${created.name} added to the library`);
    } catch (e) { fail(e); }
  };

  /** From the Characters workspace: pick a Gemini result; it opens in Pixelize aimed at that character. */
  const importForCharacter = (req: ImportRequest) => {
    pendingImport.current = req;
    setPixelizeTarget({ asset: req.assetId, anim: req.anim, design: req.design });
    pixelInput.current?.click();
  };

  const mergePixelized = async (a: SpriteAsset, png: Blob): Promise<boolean> => {
    if (!pid) return false;
    try {
      const saved = await api.updateAsset(pid, a, png);
      replaceAsset(saved);
      setSelectedId(saved.id);
      setAnimName(saved.animations[saved.animations.length - 1]?.name ?? null);
      pendingImport.current?.onDone(saved);
      pendingImport.current = null;
      setPixelizeFiles(null);
      if (tab !== 'characters') setTab('library');
      setNotice(`Updated ${saved.name}: ${saved.animations.map(x => x.name).join(', ')}`);
      return true;
    } catch (e) { fail(e); return false; }
  };



  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    routeFiles([...e.dataTransfer.files]);
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
        <nav className="tabs" role="tablist">
          {TABS.map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className={`claude-pill ${claude?.available ? 'on' : claude ? 'off' : ''}`} title={claude?.available ? `Claude Code ${claude.version} · uses your subscription` : claude?.error ?? 'Checking Claude…'}>
          <span className="dot" aria-hidden />
          <span>Claude</span>
          <select value={model} onChange={e => setModel(e.target.value as Model)} aria-label="Claude model" disabled={!claude?.available}>
            <option value="sonnet">Sonnet</option><option value="opus">Opus</option><option value="haiku">Haiku</option>
          </select>
          {sessionUsage.calls > 0 && <span className="pill-usage" title={`${sessionUsage.calls} Claude calls this session`}>{fmtTokens(sessionUsage.tokens)} tok</span>}
        </div>
        {pid && <a className="button" href={api.godotZipUrl(pid)} title="Every asset as SpriteFrames + scenes, laid out relative to the Godot project root"><Icon name="download" /> Godot</a>}
        {project?.godot.path && <button onClick={() => syncGodot()} title={project.godot.path}>Sync all to Godot</button>}
        <button className="primary" onClick={() => fileInput.current?.click()} disabled={!pid} title="Sprite sheets, images, GIFs, videos"><Icon name="upload" /> Import…</button>
        <input
          ref={fileInput} type="file" multiple accept=".png,.json,.jpg,.jpeg,.gif,.webp,.bmp,.avif,image/*,video/*" hidden
          onChange={e => { routeFiles([...(e.target.files ?? [])]); e.target.value = ''; }}
        />
        <input
          ref={pixelInput} type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,image/*,video/*" hidden
          onChange={e => { const f = [...(e.target.files ?? [])]; if (f.length) setPixelizeFiles(f); else pendingImport.current = null; e.target.value = ''; }}
        />
      </header>

      {error && <div className="toast" role="alert" onClick={() => setError(null)}><Icon name="alert" /> {error} <span className="dim">· click to dismiss</span></div>}
      {notice && !error && <div className="toast ok" role="status" onClick={() => setNotice(null)}><Icon name="check" /> {notice}</div>}

      {pid && style && tab === 'library' && (
        <main className="library">
          <AssetList projectId={pid} assets={assets} selectedId={selectedId} onSelect={setSelectedId} />
          <Viewer asset={selected} img={img} animName={animName} onAnim={setAnimName} />
          <Inspector
            asset={selected} img={img} style={style} animName={animName} extraPalette={selected ? paletteFor(selected.id) : []}
            onAnim={setAnimName} onSave={saveAsset} onDelete={removeAsset}
            godotZipUrl={selected ? api.godotZipUrl(pid, selected.id) : null}
            onSyncGodot={project?.godot.path && selected ? () => syncGodot(selected.id) : null}
          />
        </main>
      )}
      {pid && style && tab === 'lineup' && (
        <LineupView projectId={pid} assets={assets} style={style} paletteFor={paletteFor}
          onOpen={id => { setSelectedId(id); setTab('library'); }} />
      )}
      {pid && style && tab === 'characters' && (
        <CharactersView projectId={pid} style={style} assets={assets} model={model} onUsage={onUsage}
          onImport={importForCharacter} onAssetsChanged={refreshAssets} notify={notify} fail={fail} />
      )}
      {pid && style && tab === 'style' && (
        <StyleView projectId={pid} project={project} style={style} assets={assets}
          onSaved={setStyle} onProject={setProject} onError={fail} />
      )}
      {!pid && <div className="empty">No project yet. <button className="primary" onClick={newProject}>Create one</button></div>}

      {importFiles && style && (
        <ImportDialog files={importFiles} style={style} onCancel={() => setImportFiles(null)} onImport={importAsset} onError={fail}
          onPixelize={() => { openPixelize(importFiles.filter(f => !/\.json$/i.test(f.name))); setImportFiles(null); }} />
      )}
      {pixelizeFiles && style && (
        <PixelizeDialog files={pixelizeFiles} style={style} projectId={pid!} assets={assets}
          initialTarget={pixelizeTarget.asset} initialAnim={pixelizeTarget.anim} design={pixelizeTarget.design}
          onCancel={() => { pendingImport.current = null; setPixelizeFiles(null); }} onCreate={importPixelized} onMerge={mergePixelized} onError={fail} />
      )}
      {dragging && <div className="dropveil">Drop sprite sheets, images, GIFs or videos</div>}
    </div>
  );
}
