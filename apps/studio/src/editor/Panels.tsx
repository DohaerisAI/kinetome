import { useState } from 'react';
import type { CharacterDesign, StyleBible } from '@kinetome/core';
import { designPalette } from '@kinetome/core';
import { Icon } from '../icons.tsx';
import { ColorWheel } from '../components/ColorWheel.tsx';
import { addLayer, duplicateLayer, mergeDown, moveLayer, patchLayer, removeLayer, usedColors } from './model.ts';
import type { EditorApi } from './useEditor.ts';

export function ColorPanel({ ed, style, designs }: { ed: EditorApi; style: StyleBible | null; designs: CharacterDesign[] }) {
  const { state } = ed;
  const { doc } = state;
  const [wheel, setWheel] = useState(false);
  const setPalette = (palette: string[], label = 'Palette') => ed.commit(label, { ...doc, palette: [...new Set(palette.map(c => c.toLowerCase()))] });
  const sources: { label: string; colors: string[] }[] = [
    ...(style ? [{ label: 'Style Bible', colors: style.palette }] : []),
    ...designs.map(d => ({ label: d.name, colors: designPalette(d) })),
  ];
  return (
    <section className="ed-panel">
      <div className="ed-panel-head">
        <h3>Color</h3>
        <div className="spacer" />
        <button className="icon-btn" onClick={() => setWheel(w => !w)} aria-expanded={wheel} title="Color wheel"><Icon name="palette" /></button>
      </div>
      <div className="ed-colors">
        <button className="ed-big-sw" style={{ background: state.primary }} onClick={() => setWheel(true)} title={`Primary ${state.primary}`} aria-label="Primary color" />
        <button className="ed-big-sw small" style={{ background: state.secondary }} onClick={() => ed.set(s => ({ primary: s.secondary, secondary: s.primary }))} title={`Secondary ${state.secondary} (click to swap)`} aria-label="Secondary color" />
        <input className="mono" value={state.primary} spellCheck={false} aria-label="Primary hex"
          onChange={e => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) ed.set({ primary: e.target.value.toLowerCase() }); }} />
      </div>
      {wheel && <div className="ed-wheel"><ColorWheel value={state.primary} onChange={hex => ed.set({ primary: hex })} swatches={[]} /></div>}

      <div className="ed-panel-head">
        <h3>Palette <span className="dim">{doc.palette.length}</span></h3>
        <div className="spacer" />
        <label className="toggle small" title="Highlight pixels that are not in the palette"><input type="checkbox" checked={state.paletteLock} onChange={e => ed.set({ paletteLock: e.target.checked })} disabled={doc.palette.length < 2} /> Lock</label>
      </div>
      <div className="ed-palette">
        {doc.palette.map(c => (
          <button key={c} className={c === state.primary ? 'ed-pal on' : 'ed-pal'} style={{ background: c }} title={`${c} · right-click: secondary · Alt+click: remove`}
            onClick={e => (e.altKey ? setPalette(doc.palette.filter(x => x !== c), 'Remove color') : ed.set({ primary: c }))}
            onContextMenu={e => { e.preventDefault(); ed.set({ secondary: c }); }} />
        ))}
        <button className="ed-pal add" onClick={() => setPalette([...doc.palette, state.primary], 'Add color')} title="Add the primary color" aria-label="Add color"><Icon name="plus" size={12} /></button>
      </div>
      <div className="btnrow compact-row">
        <button className="small" onClick={() => setPalette(usedColors(doc, 64), 'Palette from sprite')} title="Every color used in the sprite">From sprite</button>
        <select className="compact" value="" onChange={e => { const src = sources.find(x => x.label === e.target.value); if (src) setPalette(src.colors, `Palette: ${src.label}`); }} aria-label="Load a palette">
          <option value="">Load…</option>
          {sources.map(s => <option key={s.label} value={s.label}>{s.label} ({s.colors.length})</option>)}
        </select>
      </div>
    </section>
  );
}

export function LayersPanel({ ed }: { ed: EditorApi }) {
  const { state } = ed;
  const { doc } = state;
  const [renaming, setRenaming] = useState<string | null>(null);
  const layers = [...doc.layers].reverse(); // top first, like every editor
  return (
    <section className="ed-panel">
      <div className="ed-panel-head">
        <h3>Layers</h3>
        <div className="spacer" />
        <button className="icon-btn" onClick={() => { const r = addLayer(doc, state.layerId); ed.commit('New layer', r.doc, { layerId: r.id }); }} title="New layer" aria-label="New layer"><Icon name="plus" /></button>
        <button className="icon-btn" onClick={() => { const r = duplicateLayer(doc, state.layerId); ed.commit('Duplicate layer', r.doc, { layerId: r.id }); }} title="Duplicate layer" aria-label="Duplicate layer"><Icon name="duplicate" /></button>
        <button className="icon-btn" onClick={() => ed.commit('Merge down', mergeDown(doc, state.layerId))} disabled={doc.layers[0].id === state.layerId} title="Merge into the layer below" aria-label="Merge down"><Icon name="merge" /></button>
        <button className="icon-btn" onClick={() => ed.commit('Delete layer', removeLayer(doc, state.layerId))} disabled={doc.layers.length < 2} title="Delete layer" aria-label="Delete layer"><Icon name="trash" /></button>
      </div>
      <ul className="ed-layers">
        {layers.map(l => (
          <li key={l.id} className={l.id === state.layerId ? 'active' : ''} onClick={() => { ed.settle(); ed.set({ layerId: l.id }); }}>
            <button className="icon-btn" onClick={e => { e.stopPropagation(); ed.commit(l.visible ? 'Hide layer' : 'Show layer', patchLayer(doc, l.id, { visible: !l.visible })); }} aria-label={l.visible ? 'Hide' : 'Show'}><Icon name={l.visible ? 'eye' : 'eyeOff'} /></button>
            <button className="icon-btn" onClick={e => { e.stopPropagation(); ed.commit(l.locked ? 'Unlock layer' : 'Lock layer', patchLayer(doc, l.id, { locked: !l.locked })); }} aria-label={l.locked ? 'Unlock' : 'Lock'}><Icon name={l.locked ? 'lock' : 'unlock'} /></button>
            {renaming === l.id
              ? <input autoFocus defaultValue={l.name} onBlur={e => { setRenaming(null); if (e.target.value.trim() && e.target.value !== l.name) ed.commit('Rename layer', patchLayer(doc, l.id, { name: e.target.value.trim() })); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} onClick={e => e.stopPropagation()} />
              : <span className="ed-layer-name" onDoubleClick={() => setRenaming(l.id)} title="Double-click to rename">{l.name}</span>}
            <input key={`${l.id}:${l.opacity}`} className="ed-opacity" type="range" min={0} max={100} defaultValue={Math.round(l.opacity * 100)} title={`Opacity ${Math.round(l.opacity * 100)}%`}
              onClick={e => e.stopPropagation()}
              onPointerUp={e => { const v = +(e.target as HTMLInputElement).value / 100; if (v !== l.opacity) ed.commit('Layer opacity', patchLayer(ed.ref.current.doc, l.id, { opacity: v })); }}
              onKeyUp={e => { const v = +(e.target as HTMLInputElement).value / 100; if (v !== l.opacity) ed.commit('Layer opacity', patchLayer(ed.ref.current.doc, l.id, { opacity: v })); }}
              aria-label="Opacity" />
          </li>
        ))}
      </ul>
      <div className="btnrow compact-row">
        <button className="small" onClick={() => ed.commit('Layer up', moveLayer(doc, state.layerId, 1))} title="Move layer up">↑</button>
        <button className="small" onClick={() => ed.commit('Layer down', moveLayer(doc, state.layerId, -1))} title="Move layer down">↓</button>
      </div>
    </section>
  );
}
