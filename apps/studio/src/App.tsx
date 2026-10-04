import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { designPalette, type CharacterDesign, type Project, type SpriteAsset, type StyleBible } from '@kinetome/core';
import { api, type AssetDraft, type Model, type Usage } from './api.ts';
import { CharactersView } from './components/characters/CharactersView.tsx';
import { EditorView } from './editor/EditorView.tsx';
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
import { Home } from './components/Home.tsx';
import { Playtest } from './components/Playtest.tsx';
import { TilesView } from './components/TilesView.tsx';
import { CommandPalette, type Command } from './components/CommandPalette.tsx';
import { Orb } from './components/Orb.tsx';
import { useClaudeActivity } from './claudeActivity.ts';
import { watchQueue } from './queue.ts';
import { ProjectMenu } from './components/ProjectMenu.tsx';
import { TrashDialog } from './components/TrashDialog.tsx';
import { ConnectionsDialog } from './components/ConnectionsDialog.tsx';
import { setGemini, useGemini } from './gemini.ts';
import { ExportDialog } from './components/ExportDialog.tsx';
import { EffectsDialog } from './components/EffectsDialog.tsx';
import { CheckPanel, LightingPanel, VariantsPanel } from './components/SpritePanels.tsx';
import { pop, slideTo, viewIn } from './motion.ts';

type Tab = 'home' | 'library' | 'editor' | 'characters' | 'playtest' | 'tiles' | 'lineup' | 'style';
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'library', label: 'Library', icon: 'layers' },
  { id: 'editor', label: 'Editor', icon: 'pencil' },
  { id: 'characters', label: 'Characters', icon: 'users' },
  { id: 'playtest', label: 'Playtest', icon: 'gamepad' },
  { id: 'tiles', label: 'Tiles', icon: 'tiles' },
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
  const [noticeAction, setNoticeAction] = useState<{ label: string; run: () => void } | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [connOpen, setConnOpen] = useState(false);
  const gemini = useGemini();
  useEffect(() => {
    const open = () => setConnOpen(true);
    window.addEventListener('kinetome:connections', open);
    return () => window.removeEventListener('kinetome:connections', open);
  }, []);
  const [exportFor, setExportFor] = useState<string[] | null>(null);
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [assets, setAssets] = useState<SpriteAsset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [animName, setAnimName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [palette, setPalette] = useState(false);
  const activity = useClaudeActivity();
  const navRef = useRef<HTMLElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const firstSlide = useRef(true);
  const [importFiles, setImportFiles] = useState<File[] | null>(null);
  const [pixelizeFiles, setPixelizeFiles] = useState<File[] | null>(null);
  const [pixelizeTarget, setPixelizeTarget] = useState<{ asset: string | null; anim: string | null; design: CharacterDesign | null }>({ asset: null, anim: null, design: null });
  const pendingImport = useRef<ImportRequest | null>(null);
  const [model, setModel] = useState<Model>(readModel);
  const [claude, setClaude] = useState<{ available: boolean; version: string | null; error?: string } | null>(null);
  const [sessionUsage, setSessionUsage] = useState({ tokens: 0, calls: 0 });
  const [designs, setDesigns] = useState<CharacterDesign[]>([]);
  const [editRequest, setEditRequest] = useState<{ assetId: string; nonce: number } | null>(null);
  const [editorFiles, setEditorFiles] = useState<{ files: File[]; nonce: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pixelInput = useRef<HTMLInputElement>(null);

  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  /** A toast; with an action ("Undo") it stays a little longer so there's time to click. */
  const notify = useCallback((msg: string, action?: { label: string; run: () => void }) => { setNotice(msg); setNoticeAction(action ?? null); }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => { setNotice(null); setNoticeAction(null); }, noticeAction ? 8000 : 4500);
    return () => clearTimeout(t);
  }, [notice, noticeAction]);

  // the nav pill slides to the active tab; each view eases in
  useLayoutEffect(() => {
    const btn = navRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`) ?? null;
    slideTo(indicator.current, btn, firstSlide.current);
    firstSlide.current = false;
  }, [tab, pid]);
  useEffect(() => {
    const onResize = () => slideTo(indicator.current, navRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`) ?? null, true);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [tab]);
  useEffect(() => { viewIn(document.querySelector('.app > main, .app > .tab-host:not([hidden])')); }, [tab]);
  useEffect(() => { pop(toastRef.current); }, [notice, error]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); setPalette(p => !p); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  // the background moveset queue: announce each finished move, here and as a system notification
  useEffect(() => {
    watchQueue(pid, j => {
      const msg = j.status === 'done' ? `${j.move} animated (${j.character})` : `${j.move} failed: ${j.error ?? 'error'}`;
      notify(msg);
      if (pid) api.listCharacters(pid).then(setDesigns, () => {});
      try { if (document.hidden && Notification.permission === 'granted') new Notification('Kinetome', { body: msg, icon: '/favicon.svg' }); } catch { /* notifications unavailable */ }
    });
  }, [pid, notify]);

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
    // drop the previous project's lists right away, so nothing asks this project for them
    setAssets([]); setDesigns([]); setStyle(null); setProject(null);
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

  // views render only once the selected project has actually loaded (no stale lists)
  const ready = !!pid && project?.id === pid;
  const selected = assets.find(a => a.id === selectedId) ?? null;
  const img = useImage(ready && pid && selected ? api.sheetUrl(pid, selected) : null);

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

  /** Straight to the trash, no confirm: the toast's Undo (or the Trash) brings it back. */
  const removeAsset = async (id: string) => {
    if (!pid) return;
    const name = assets.find(a => a.id === id)?.name ?? id;
    try {
      await api.deleteAsset(pid, id);
      setAssets(list => list.filter(a => a.id !== id));
      setSelectedId(null);
      notify(`Moved “${name}” to the trash`, { label: 'Undo', run: () => void undoDelete('asset', id) });
    } catch (e) { fail(e); }
  };

  const undoDelete = async (kind: 'asset' | 'character' | 'project', itemId: string) => {
    try {
      const entry = (await api.listTrash()).find(e => e.kind === kind && e.itemId === itemId);
      if (!entry) return;
      afterRestore(await api.restoreTrash(entry.id));
    } catch (e) { fail(e); }
  };

  const afterRestore = (r: { kind: string; projectId: string; restoredId: string; name: string }) => {
    if (r.kind === 'project') { api.listProjects().then(ps => { setProjects(ps); setPid(r.restoredId); }, fail); }
    else if (r.projectId === pid) { refreshAssets(); if (r.kind === 'character') setDesigns([]); if (r.kind === 'asset') setSelectedId(r.restoredId); }
    notify(`Restored “${r.name}”`);
  };

  const renameProject = async () => {
    if (!pid || !project) return;
    const name = prompt('Rename project', project.name);
    if (!name?.trim() || name.trim() === project.name) return;
    try {
      const p = await api.renameProject(pid, name.trim());
      setProject(p); setProjects(ps => ps.map(x => (x.id === p.id ? p : x)));
    } catch (e) { fail(e); }
  };
  const duplicateProject = async () => {
    if (!pid) return;
    try {
      const p = await api.duplicateProject(pid);
      setProjects(ps => [...ps, p]); setPid(p.id);
      notify(`Duplicated as “${p.name}”`);
    } catch (e) { fail(e); }
  };
  const deleteProject = async () => {
    if (!pid || !project || !confirm(`Delete the project “${project.name}”? It moves to the trash with everything in it, and can be restored for 30 days.`)) return;
    const id = pid;
    try {
      await api.deleteProject(id);
      const ps = await api.listProjects();
      setProjects(ps); setPid(ps[0]?.id ?? null); setProject(null); setAssets([]);
      notify(`Moved “${project.name}” to the trash`, { label: 'Undo', run: () => void undoDelete('project', id) });
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
    const ase = all.filter(f => /\.(ase|aseprite)$/i.test(f.name));
    if (ase.length) { setEditorFiles({ files: ase, nonce: Date.now() }); setTab('editor'); return; }
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
    if (req.files?.length) setPixelizeFiles(req.files);
    else pixelInput.current?.click();
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



  const editAsset = (id: string) => { setEditRequest({ assetId: id, nonce: Date.now() }); setTab('editor'); };
  const openAsset = (id: string) => { setSelectedId(id); setTab('library'); };

  const commands = useMemo<Command[]>(() => [
    ...TABS.map(t => ({ id: `tab-${t.id}`, label: `Go to ${t.label}`, group: 'Navigate', icon: t.icon, run: () => setTab(t.id) })),
    { id: 'import', label: 'Import art…', group: 'Actions', icon: 'upload' as IconName, keywords: 'sprite sheet gif video image pixelize', run: () => fileInput.current?.click() },
    { id: 'new-project', label: 'New project…', group: 'Actions', icon: 'plus' as IconName, run: () => void newProject() },
    { id: 'effect', label: 'New effect (slash, dust, spark, leaves, magic)…', group: 'Actions', icon: 'sparkle' as IconName, keywords: 'vfx particles fx', run: () => setEffectsOpen(true) },
    { id: 'connections', label: 'Gemini API key and models…', group: 'Actions', icon: 'gemini' as IconName, keywords: 'settings api key veo video connect', run: () => setConnOpen(true) },
    { id: 'trash', label: 'Open the trash', group: 'Actions', icon: 'trash' as IconName, keywords: 'restore deleted undo', run: () => setTrashOpen(true) },
    ...(pid ? [
      { id: 'rename-project', label: 'Rename this project…', group: 'Project', icon: 'pencil' as IconName, run: () => void renameProject() },
      { id: 'dup-project', label: 'Duplicate this project', group: 'Project', icon: 'duplicate' as IconName, run: () => void duplicateProject() },
      { id: 'del-project', label: 'Delete this project…', group: 'Project', icon: 'trash' as IconName, run: () => void deleteProject() },
    ] : []),
    ...(pid ? [{ id: 'export', label: 'Export…', group: 'Actions', icon: 'download' as IconName, keywords: 'godot unity phaser pixi texturepacker aseprite zip', run: () => setExportFor([]) }] : []),
    ...(project?.godot.path ? [{ id: 'godot-sync', label: 'Sync all sprites to Godot', group: 'Actions', icon: 'refresh' as IconName, run: () => void syncGodot() }] : []),
    ...assets.flatMap(a => [
      { id: `open-${a.id}`, label: a.name, group: 'Sprites', icon: 'image' as IconName, keywords: `${a.kind} ${a.animations.map(x => x.name).join(' ')} open library`, run: () => openAsset(a.id) },
      { id: `edit-${a.id}`, label: `Edit ${a.name}`, group: 'Edit in the sprite editor', icon: 'pencil' as IconName, keywords: 'editor', run: () => editAsset(a.id) },
    ]),
    ...designs.map(d => ({ id: `char-${d.id}`, label: d.name, group: 'Characters', icon: 'users' as IconName, keywords: 'character design animate', run: () => setTab('characters') })),
    ...projects.filter(p => p.id !== pid).map(p => ({ id: `proj-${p.id}`, label: `Switch to ${p.name}`, group: 'Projects', icon: 'folder' as IconName, run: () => setPid(p.id) })),
    ...(['sonnet', 'opus', 'haiku'] as Model[]).filter(m => m !== model).map(m => ({ id: `model-${m}`, label: `Use ${m[0].toUpperCase()}${m.slice(1)} for Claude`, group: 'Claude', icon: 'sparkle' as IconName, run: () => setModel(m) })),
  ], [assets, designs, projects, pid, project, model]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <button className="brand" onClick={() => setTab('home')} aria-label="Kinetome home"><span className="brand-mark" aria-hidden /><span className="brand-word">Kinetome</span></button>
        <ProjectMenu projects={projects} current={project} onSwitch={setPid} onNew={() => void newProject()}
          onRename={() => void renameProject()} onDuplicate={() => void duplicateProject()} onDelete={() => void deleteProject()} onTrash={() => setTrashOpen(true)} />
        <nav className="tabs" role="tablist" ref={navRef}>
          <span className="tab-indicator" ref={indicator} aria-hidden />
          {TABS.map(t => (
            <button key={t.id} data-tab={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)} title={t.label} aria-label={t.label}>
              <Icon name={t.icon} /> <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <button className="search-btn" onClick={() => setPalette(true)} title="Search and commands (Ctrl+K)"><Icon name="search" size={14} /> <span>Search</span> <kbd>Ctrl K</kbd></button>
        <div className={`claude-pill ${claude?.available ? 'on' : claude ? 'off' : ''}${activity.length ? ' busy' : ''}`} title={activity.length ? activity.map(a => a.label).join(' · ') : claude?.available ? `Claude Code ${claude.version} · uses your subscription` : claude?.error ?? 'Checking Claude…'}>
          {activity.length ? <Orb size={20} state={activity[activity.length - 1].state} label={activity[activity.length - 1].label} /> : <span className="dot" aria-hidden />}
          <span className="pill-label">{activity.length ? activity[activity.length - 1].label : 'Claude'}</span>
          <select value={model} onChange={e => setModel(e.target.value as Model)} aria-label="Claude model" disabled={!claude?.available}>
            <option value="sonnet">Sonnet</option><option value="opus">Opus</option><option value="haiku">Haiku</option>
          </select>
          {sessionUsage.calls > 0 && <span className="pill-usage" title={`${sessionUsage.calls} Claude calls this session`}>{fmtTokens(sessionUsage.tokens)} tok</span>}
        </div>
        <button className={gemini?.configured ? 'icon-btn conn-btn on' : 'icon-btn conn-btn'} onClick={() => setConnOpen(true)}
          title={gemini?.configured ? `Gemini API connected (${gemini.masked})` : 'Connect a Gemini API key (optional)'} aria-label="Gemini API connection">
          <Icon name="gemini" /><span className="conn-dot" aria-hidden />
        </button>
        {pid && <button className="godot-btn" onClick={() => setExportFor([])} title="Export for Godot, Unity, Phaser, PixiJS, TexturePacker or Aseprite"><Icon name="download" /> <span>Export</span></button>}
        <button className="primary" onClick={() => fileInput.current?.click()} disabled={!pid} title="Sprite sheets, images, GIFs, videos"><Icon name="upload" /> Import…</button>
        <input
          ref={fileInput} type="file" multiple accept=".png,.json,.jpg,.jpeg,.gif,.webp,.bmp,.avif,.ase,.aseprite,image/*,video/*" hidden
          onChange={e => { routeFiles([...(e.target.files ?? [])]); e.target.value = ''; }}
        />
        <input
          ref={pixelInput} type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,image/*,video/*" hidden
          onChange={e => { const f = [...(e.target.files ?? [])]; if (f.length) setPixelizeFiles(f); else pendingImport.current = null; e.target.value = ''; }}
        />
      </header>

      {error && <div className="toast" ref={toastRef} role="alert" onClick={() => setError(null)}><span className="toast-ic"><Icon name="alert" /></span> <span>{error}</span> <span className="dim small">click to dismiss</span></div>}
      {notice && !error && (
        <div className="toast ok" ref={toastRef} role="status" onClick={() => { setNotice(null); setNoticeAction(null); }}>
          <span className="toast-ic"><Icon name="check" /></span> <span>{notice}</span>
          {noticeAction && <button className="toast-action" onClick={e => { e.stopPropagation(); const a = noticeAction; setNotice(null); setNoticeAction(null); a.run(); }}>{noticeAction.label}</button>}
        </div>
      )}

      {ready && pid && style && tab === 'home' && (
        <Home project={project} style={style} assets={assets} designs={designs} projectId={pid}
          onGo={t => setTab(t)} onOpenAsset={openAsset} onEditAsset={editAsset} onImport={() => fileInput.current?.click()} onPalette={() => setPalette(true)} />
      )}

      {ready && pid && style && tab === 'library' && (
        <main className="library">
          <AssetList projectId={pid} assets={assets} selectedId={selectedId} onSelect={setSelectedId} onNewEffect={() => setEffectsOpen(true)} />
          <Viewer asset={selected} img={img} animName={animName} onAnim={setAnimName} />
          <Inspector
            asset={selected} img={img} style={style} animName={animName} extraPalette={selected ? paletteFor(selected.id) : []}
            onAnim={setAnimName} onSave={saveAsset} onDelete={removeAsset}
            godotZipUrl={selected ? api.godotZipUrl(pid, selected.id) : null}
            onSyncGodot={project?.godot.path && selected ? () => syncGodot(selected.id) : null}
            onEdit={selected ? () => editAsset(selected.id) : null}
            onExport={selected ? () => setExportFor([selected.id]) : null}
            extraTabs={selected ? [
              { id: 'variants', label: 'Variants', icon: 'palette', render: () => <VariantsPanel projectId={pid} asset={selected} img={img} design={designs.find(d => d.assetId === selected.id) ?? null} fail={fail} onCreated={a => { setAssets(list => [...list, a]); notify(`Created ${a.name}`, { label: 'Open', run: () => setSelectedId(a.id) }); }} /> },
              { id: 'light', label: 'Lighting', icon: 'sparkle', render: () => <LightingPanel projectId={pid} asset={selected} img={img} /> },
              { id: 'check', label: 'Check', icon: 'check', render: () => <CheckPanel asset={selected} img={img} design={designs.find(d => d.assetId === selected.id) ?? null} onPick={setAnimName} /> },
            ] : []}
            projectId={pid} fail={fail}
            onRestored={a => { replaceAsset(a); notify(`Restored an earlier version of ${a.name}`); }}
          />
        </main>
      )}
      {ready && pid && style && tab === 'playtest' && <Playtest projectId={pid} assets={assets} style={style} designs={designs} active={tab === 'playtest'} />}
      {ready && pid && style && tab === 'tiles' && (
        <TilesView projectId={pid} assets={assets} style={style} fail={fail} notify={notify} onEdit={editAsset}
          onCreated={a => setAssets(list => [...list, a])} />
      )}
      {ready && pid && style && tab === 'lineup' && (
        <LineupView projectId={pid} assets={assets} style={style} paletteFor={paletteFor}
          onOpen={id => { setSelectedId(id); setTab('library'); }} />
      )}
      {pid && style && (
        // kept mounted so switching tabs never loses unsaved editor work
        <div className="tab-host" hidden={tab !== 'editor'}>
          <EditorView projectId={pid} assets={ready ? assets : []} importFiles={editorFiles} style={style} designs={designs} openRequest={editRequest} active={tab === 'editor'}
            onSaved={a => { setAssets(list => (list.some(x => x.id === a.id) ? list.map(x => (x.id === a.id ? a : x)) : [...list, a])); setSelectedId(a.id); }}
            notify={notify} fail={fail} />
        </div>
      )}
      {ready && pid && style && tab === 'characters' && (
        <CharactersView projectId={pid} style={style} assets={assets} model={model} onUsage={onUsage}
          onImport={importForCharacter} onAssetsChanged={refreshAssets} notify={notify} fail={fail} />
      )}
      {ready && pid && style && tab === 'style' && (
        <StyleView projectId={pid} project={project} style={style} assets={assets}
          onSaved={setStyle} onProject={setProject} onError={fail} />
      )}
      {!pid && (
        <div className="empty">
          <div className="empty-card">
            <span className="brand-mark big" aria-hidden />
            <h2 className="display">Welcome to Kinetome</h2>
            <p>A project holds a Style Bible, your cast and every sprite. Start one to begin.</p>
            <button className="primary lg" onClick={newProject}><Icon name="plus" /> Create a project</button>
          </div>
        </div>
      )}

      {importFiles && style && (
        <ImportDialog files={importFiles} style={style} onCancel={() => setImportFiles(null)} onImport={importAsset} onError={fail}
          onPixelize={() => { openPixelize(importFiles.filter(f => !/\.json$/i.test(f.name))); setImportFiles(null); }} />
      )}
      {pixelizeFiles && style && (
        <PixelizeDialog files={pixelizeFiles} style={style} projectId={pid!} assets={assets}
          initialTarget={pixelizeTarget.asset} initialAnim={pixelizeTarget.anim} design={pixelizeTarget.design}
          onCancel={() => { pendingImport.current = null; setPixelizeFiles(null); }} onCreate={importPixelized} onMerge={mergePixelized} onError={fail} />
      )}
      {dragging && <div className="dropveil"><div className="dropveil-card"><Icon name="upload" size={28} /><strong>Drop to import</strong><span className="dim">Sprite sheets, images, GIFs or videos</span></div></div>}
      {effectsOpen && pid && style && <EffectsDialog projectId={pid} style={style} extraColors={designs.flatMap(d => designPalette(d))} fail={fail} onClose={() => setEffectsOpen(false)}
        onCreated={a => { setAssets(list => [...list, a]); setSelectedId(a.id); setTab('library'); notify(`Added ${a.name} to the library`); }} />}
      {exportFor && pid && <ExportDialog projectId={pid} project={project} assets={assets} initial={exportFor} onClose={() => setExportFor(null)} onSync={project?.godot.path ? () => void syncGodot() : null} />}
      {connOpen && <ConnectionsDialog onClose={() => setConnOpen(false)} onChange={setGemini} fail={fail} />}
      {trashOpen && <TrashDialog projectId={pid} projectName={id => projects.find(p => p.id === id)?.name ?? id} onClose={() => setTrashOpen(false)} onRestored={afterRestore} fail={fail} />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}
