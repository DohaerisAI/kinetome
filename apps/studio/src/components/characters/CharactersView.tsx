import { useCallback, useEffect, useRef, useState } from 'react';
import { lintAsset, type CharacterDesign, type SpriteAsset, type StyleBible } from '@sprite/core';
import { api, type Model, type Usage } from '../../api.ts';
import { Icon, type IconName } from '../../icons.tsx';
import { loadImage, toPixels, useImage } from '../../pixels.ts';
import { FrameThumb } from '../FrameThumb.tsx';
import { CodeTab } from './CodeTab.tsx';
import { DesignTab } from './DesignTab.tsx';
import { MovesTab } from './MovesTab.tsx';
import { ReferenceTab } from './ReferenceTab.tsx';
import { usageText, type ImportRequest, type TabProps } from './shared.tsx';

type Sub = 'design' | 'reference' | 'moves' | 'code';
const SUBS: { id: Sub; label: string; icon: IconName; hint: string }[] = [
  { id: 'design', label: 'Design', icon: 'palette', hint: 'Who they are, colors per part' },
  { id: 'reference', label: 'Reference', icon: 'image', hint: 'The master sprite (Gemini)' },
  { id: 'moves', label: 'Moves', icon: 'film', hint: 'Animations via Gemini' },
  { id: 'code', label: 'Draw with code', icon: 'code', hint: 'Claude draws it, no images needed' },
];

interface Props {
  projectId: string;
  style: StyleBible;
  assets: SpriteAsset[];
  model: Model;
  onUsage: (u: Usage) => void;
  onImport: (req: ImportRequest) => void;
  onAssetsChanged: () => void;
  notify: (msg: string) => void;
  fail: (e: unknown) => void;
}

function Avatar({ projectId, asset, size = 36 }: { projectId: string; asset: SpriteAsset | undefined; size?: number }) {
  const img = useImage(asset ? api.sheetUrl(projectId, asset) : null);
  if (!asset) return <span className="avatar-empty" style={{ width: size, height: size }}><Icon name="users" /></span>;
  return <FrameThumb img={img} rect={asset.frames[asset.animations[0]?.frames[0] ?? 0]} size={size} className="thumb" />;
}

/**
 * Character workspace: design once (lore, parts and colors), then produce the reference
 * and every move either through Gemini (prompts Claude drafts) or with code (Claude draws).
 */
export function CharactersView({ projectId, style, assets, model, onUsage, onImport, onAssetsChanged, notify, fail }: Props) {
  const [designs, setDesigns] = useState<CharacterDesign[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>('design');
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saving' | 'saved'>('idle');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const pending = useRef<Map<string, CharacterDesign>>(new Map());
  const latest = useRef<CharacterDesign[]>([]);
  latest.current = designs;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.listCharacters(projectId).then(list => { setDesigns(list); setSelId(list[0]?.id ?? null); if (!list.length) setCreating(true); }, fail);
  }, [projectId, fail]);

  const design = designs.find(d => d.id === selId) ?? null;

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const batch = [...pending.current.values()];
    pending.current.clear();
    if (!batch.length) return;
    setSaving('saving');
    try {
      for (const d of batch) await api.saveCharacter(projectId, d);
      setSaving('saved');
    } catch (e) { fail(e); setSaving('idle'); }
  }, [projectId, fail]);

  /** Local-first edits, saved 600ms after typing stops. */
  const update = useCallback((d: CharacterDesign) => {
    setDesigns(list => list.map(x => (x.id === d.id ? d : x)));
    pending.current.set(d.id, d);
    setSaving('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  }, [flush]);

  useEffect(() => () => { void flush(); }, [flush]);

  const runClaude: TabProps['runClaude'] = async (label, fn) => {
    setBusy(label);
    try {
      await flush();
      const r = await fn();
      if (r.design) setDesigns(list => list.map(x => (x.id === r.design!.id ? r.design! : x)));
      onUsage(r.usage);
      notify(`Claude · ${usageText(r.usage)}`);
      return r;
    } catch (e) { fail(e); return null; } finally { setBusy(null); }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const d = await api.createCharacter(projectId, name);
      setDesigns(list => [...list, d]);
      setSelId(d.id); setSub('design'); setCreating(false); setNewName('');
    } catch (e) { fail(e); }
  };

  const remove = async () => {
    if (!design || !confirm(`Delete the design "${design.name}"? Its library sprite (if any) stays.`)) return;
    try {
      await api.deleteCharacter(projectId, design.id);
      setDesigns(list => list.filter(d => d.id !== design.id));
      setSelId(designs.find(d => d.id !== design.id)?.id ?? null);
    } catch (e) { fail(e); }
  };

  const importFor: TabProps['importFor'] = req => {
    if (!design) return;
    onImport({
      ...req, design,
      onDone: asset => {
        // read the newest copy at completion time; the import may finish long after it started
        const fresh = latest.current.find(d => d.id === design.id) ?? design;
        const link = (pixelHeight: number) => {
          const cur = latest.current.find(d => d.id === design.id) ?? fresh;
          if (cur.assetId !== asset.id || cur.pixelHeight !== pixelHeight) update({ ...cur, assetId: asset.id, pixelHeight });
        };
        // The reference defines the real size: prompts must quote it, or Gemini gets told
        // "40px" while looking at a 100px reference.
        if (req.anim === 'idle' || !fresh.assetId) {
          loadImage(api.sheetUrl(projectId, asset)).then(img => {
            const h = lintAsset(toPixels(img), asset, style).stats.contentHeight;
            link(h >= 12 && h <= 256 ? h : fresh.pixelHeight);
          }, () => link(fresh.pixelHeight));
        } else link(fresh.pixelHeight);
      },
    });
  };

  const linked = design?.assetId ? assets.find(a => a.id === design.assetId) : undefined;
  const props: TabProps | null = design && {
    projectId, style, design, assets, model, update, runClaude, busy, importFor, onAssetsChanged, notify, fail,
  };

  return (
    <main className="chars">
      <aside className="chars-side">
        <div className="panel-title">Characters <span className="dim">{designs.length}</span></div>
        <div className="scroll">
          {designs.map(d => (
            <button key={d.id} className={d.id === selId ? 'char-row active' : 'char-row'} onClick={() => { void flush(); setSelId(d.id); }}>
              <Avatar projectId={projectId} asset={assets.find(a => a.id === d.assetId)} />
              <span className="asset-meta">
                <span className="asset-name">{d.name}</span>
                <span className="dim small">{d.moves.length} move{d.moves.length === 1 ? '' : 's'}{d.assetId ? ' · in library' : ''}</span>
              </span>
            </button>
          ))}
          {creating ? (
            <form className="char-new" onSubmit={e => { e.preventDefault(); void create(); }}>
              <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="Character name" aria-label="New character name" />
              <div className="btnrow">
                <button type="submit" className="primary" disabled={!newName.trim()}>Create</button>
                {designs.length > 0 && <button type="button" onClick={() => setCreating(false)}>Cancel</button>}
              </div>
            </form>
          ) : (
            <button className="char-add" onClick={() => setCreating(true)}><Icon name="plus" /> New character</button>
          )}
        </div>
      </aside>

      {design && props ? (
        <section className="chars-main">
          <header className="chars-head">
            <Avatar projectId={projectId} asset={linked} size={44} />
            <div className="chars-title">
              <input className="title-input" value={design.name} onChange={e => update({ ...design, name: e.target.value })} aria-label="Character name" />
              <span className="dim small">
                {linked ? <>In library as <strong>{linked.name}</strong> · {linked.animations.map(a => a.name).join(', ')}</> : 'Not in the library yet: import a reference or draw it with code'}
              </span>
            </div>
            <div className="spacer" />
            <span className={`save-state ${saving}`} aria-live="polite">{saving === 'pending' || saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : ''}</span>
            <button className="icon-btn" onClick={remove} title="Delete design" aria-label="Delete design"><Icon name="trash" /></button>
          </header>
          <nav className="subtabs" role="tablist">
            {SUBS.map((s, i) => (
              <button key={s.id} role="tab" aria-selected={sub === s.id} className={sub === s.id ? 'subtab active' : 'subtab'} onClick={() => setSub(s.id)} title={s.hint}>
                <span className="subtab-n">{i + 1}</span><Icon name={s.icon} /> {s.label}
              </button>
            ))}
          </nav>
          <div className="chars-body">
            {sub === 'design' && <DesignTab {...props} onNext={() => setSub('reference')} />}
            {sub === 'reference' && <ReferenceTab {...props} />}
            {sub === 'moves' && <MovesTab {...props} />}
            {sub === 'code' && <CodeTab {...props} />}
          </div>
        </section>
      ) : (
        <section className="chars-empty">
          <div className="empty-card">
            <Icon name="users" size={28} />
            <h2>Create your first character</h2>
            <p className="dim">Describe who they are and pick their colors. Claude turns that into Gemini prompts, or draws the sprite itself with code.</p>
          </div>
        </section>
      )}
    </main>
  );
}
