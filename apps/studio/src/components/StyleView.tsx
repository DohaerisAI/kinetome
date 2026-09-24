import { useEffect, useState } from 'react';
import { countColors, StyleBible, type Project, type SpriteAsset } from '@kinetome/core';
import { api } from '../api.ts';
import { loadImage, toPixels } from '../pixels.ts';

interface Props {
  projectId: string;
  project: Project | null;
  style: StyleBible;
  assets: SpriteAsset[];
  onSaved: (s: StyleBible) => void;
  onProject: (p: Project) => void;
  onError: (e: unknown) => void;
}

/** The project's locked art direction. Everything is linted against it; generators will receive it verbatim. */
export function StyleView({ projectId, project, style, assets, onSaved, onProject, onError }: Props) {
  const [godotPath, setGodotPath] = useState(project?.godot.path ?? '');
  const [godotDir, setGodotDir] = useState(project?.godot.dir ?? 'sprites');
  useEffect(() => { setGodotPath(project?.godot.path ?? ''); setGodotDir(project?.godot.dir ?? 'sprites'); }, [project]);
  const saveGodot = async () => {
    try { onProject(await api.saveGodot(projectId, { path: godotPath.trim() || null, dir: godotDir.trim() || 'sprites' })); }
    catch (e) { onError(e); }
  };
  const [draft, setDraft] = useState<StyleBible>(style);
  const [newColor, setNewColor] = useState('#ffffff');
  const [paste, setPaste] = useState('');
  useEffect(() => setDraft(style), [style]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(style);
  const set = <K extends keyof StyleBible>(k: K, v: StyleBible[K]) => setDraft(d => ({ ...d, [k]: v }));

  const save = async () => {
    const parsed = StyleBible.safeParse(draft);
    if (!parsed.success) return onError(new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')));
    try { onSaved(await api.saveStyle(projectId, parsed.data)); } catch (e) { onError(e); }
  };

  const addColors = (hexes: string[]) => {
    const next = [...draft.palette];
    for (const h of hexes.map(x => x.toLowerCase())) if (/^#[0-9a-f]{6}$/.test(h) && !next.includes(h)) next.push(h);
    set('palette', next.slice(0, 256));
  };

  const fromAsset = async (id: string) => {
    const a = assets.find(x => x.id === id);
    if (!a) return;
    try {
      const counts = countColors(toPixels(await loadImage(api.sheetUrl(projectId, a))));
      set('palette', [...counts].sort((x, y) => y[1] - x[1]).map(([h]) => h).slice(0, 256));
    } catch (e) { onError(e); }
  };

  return (
    <main className="style-view">
      <div className="style-grid">
        <section className="card">
          <h3>Palette <span className="dim">{draft.palette.length} colors, locked</span></h3>
          <p className="dim small">Every pixel in the project must come from this list. Click a swatch to remove it.</p>
          <div className="swatches big">
            {draft.palette.map(c => (
              <button key={c} className="sw" style={{ background: c }} title={`${c} (click to remove)`}
                onClick={() => draft.palette.length > 2 && set('palette', draft.palette.filter(x => x !== c))} />
            ))}
          </div>
          <div className="btnrow">
            <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)} aria-label="New color" />
            <button onClick={() => addColors([newColor])}>Add color</button>
            <select value="" onChange={e => fromAsset(e.target.value)} aria-label="Extract palette from asset">
              <option value="">Extract from asset…</option>
              {assets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="btnrow">
            <input className="grow" placeholder="Paste hex list: #1a1c2c #5d275d …" value={paste} onChange={e => setPaste(e.target.value)} />
            <button onClick={() => { addColors(paste.match(/#[0-9a-f]{6}/gi) ?? []); setPaste(''); }}>Append</button>
            <button onClick={() => { const h = paste.match(/#[0-9a-f]{6}/gi) ?? []; if (h.length >= 2) { set('palette', [...new Set(h.map(x => x.toLowerCase()))]); setPaste(''); } }}>Replace</button>
          </div>
        </section>

        <section className="card">
          <h3>Form</h3>
          <div className="row2">
            <label className="field"><span>Unit height (px)</span>
              <input type="number" min={8} max={512} value={draft.unitHeight} onChange={e => set('unitHeight', Number(e.target.value))} />
            </label>
            <label className="field"><span>Max colors per sprite</span>
              <input type="number" min={2} max={256} value={draft.maxColorsPerSprite} onChange={e => set('maxColorsPerSprite', Number(e.target.value))} />
            </label>
          </div>
          <p className="dim small">Unit height is how tall a standard character is. It fixes pixel density so nothing looks higher-res than its neighbours.</p>
          <div className="row2">
            <label className="field"><span>Perspective</span>
              <select value={draft.perspective} onChange={e => set('perspective', e.target.value as StyleBible['perspective'])}>
                {StyleBible.shape.perspective.options.map(o => <option key={o}>{o}</option>)}
              </select>
            </label>
            <label className="field"><span>Light direction</span>
              <select value={draft.lightDirection} onChange={e => set('lightDirection', e.target.value as StyleBible['lightDirection'])}>
                {StyleBible.shape.lightDirection.options.map(o => <option key={o}>{o}</option>)}
              </select>
            </label>
          </div>
          <div className="row2">
            <label className="field"><span>Outline</span>
              <select value={draft.outline.mode} onChange={e => set('outline', { ...draft.outline, mode: e.target.value as StyleBible['outline']['mode'] })}>
                <option>full</option><option>selective</option><option>none</option>
              </select>
            </label>
            <label className="field"><span>Outline color</span>
              <select value={draft.outline.color ?? ''} onChange={e => set('outline', { ...draft.outline, color: e.target.value || null })}>
                <option value="">(none)</option>
                {draft.palette.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="card">
          <h3>Godot export</h3>
          <p className="dim small">Zip export always works. Set the Godot project folder (the one with project.godot) to sync files straight in; Godot re-imports when you switch back to it.</p>
          <label className="field"><span>Godot project folder (optional)</span>
            <input value={godotPath} onChange={e => setGodotPath(e.target.value)} placeholder="/mnt/c/Users/you/Documents/my-game" />
          </label>
          <label className="field"><span>Sprites folder inside the project</span>
            <input value={godotDir} onChange={e => setGodotDir(e.target.value)} placeholder="sprites" />
          </label>
          <div className="btnrow">
            <span className="dim small mono">res://{godotDir || 'sprites'}/&lt;asset&gt;/</span>
            <div className="spacer" />
            <button onClick={saveGodot} disabled={godotPath === (project?.godot.path ?? '') && godotDir === (project?.godot.dir ?? 'sprites')}>Save</button>
          </div>
        </section>

        <section className="card wide">
          <h3>Art direction notes</h3>
          <p className="dim small">Plain-language direction handed to every generator verbatim: mood, era, references, dos and don'ts.</p>
          <textarea rows={5} value={draft.notes} onChange={e => set('notes', e.target.value)}
            placeholder="e.g. 16-bit SNES-era fantasy. Chunky readable silhouettes, 2-tone shading, no dithering on characters, cyan reserved for magic." />
        </section>
      </div>
      <div className="savebar">
        <span className="dim">{dirty ? 'Unsaved changes' : 'Saved'}</span>
        <button onClick={() => setDraft(style)} disabled={!dirty}>Revert</button>
        <button className="primary" onClick={save} disabled={!dirty}>Save Style Bible</button>
      </div>
    </main>
  );
}
