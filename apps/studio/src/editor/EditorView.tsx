import { useEffect, useRef, useState } from 'react';
import type { CharacterDesign, SpriteAsset, StyleBible } from '@kinetome/core';
import { Icon } from '../icons.tsx';
import { api } from '../api.ts';
import { useImage } from '../pixels.ts';
import { FrameThumb } from '../components/FrameThumb.tsx';
import { Canvas } from './Canvas.tsx';
import { ColorPanel, LayersPanel } from './Panels.tsx';
import { FrameTools } from './FrameTools.tsx';
import { SlicerDialog } from './SlicerDialog.tsx';
import { Timeline } from './Timeline.tsx';
import { OptionsBar, ToolBar } from './Tools.tsx';
import { downloadSheet, openAsset, saveToLibrary } from './io.ts';
import {
  clearSelected, createDoc, editableCel, extract, invert, isEmpty, playRange, resizeDoc, scaleDoc,
  transformFloating, trimCanvas, withCel, type Anchor9, type EditorDoc, type Floating,
} from './model.ts';
import { useEditor, type Tool } from './useEditor.ts';

interface Props {
  projectId: string;
  assets: SpriteAsset[];
  style: StyleBible | null;
  designs: CharacterDesign[];
  /** Asset to open when the editor is entered from the library. */
  openRequest: { assetId: string; nonce: number } | null;
  /** The editor tab is visible (shortcuts only work then). */
  active: boolean;
  onSaved: (a: SpriteAsset) => void;
  notify: (msg: string) => void;
  fail: (e: unknown) => void;
}

function AssetPick({ projectId, asset, onClick }: { projectId: string; asset: SpriteAsset; onClick: () => void }) {
  const img = useImage(api.sheetUrl(projectId, asset));
  return (
    <button className="ed-asset" onClick={onClick}>
      <FrameThumb img={img} rect={asset.frames[asset.animations[0]?.frames[0] ?? 0]} size={48} className="thumb" />
      <span className="asset-meta"><span className="asset-name">{asset.name}</span><span className="dim small">{asset.frames.length} frames · {asset.animations.length} anim</span></span>
    </button>
  );
}

/**
 * The sprite editor: Aseprite-style frames x layers with tags, onion skin and a full pixel
 * toolset, plus batch clean-up, sheet slicing and "apply fix to frames".
 */
export function EditorView({ projectId, assets, style, designs, openRequest, active, onSaved, notify, fail }: Props) {
  const ed = useEditor();
  const { state } = ed;
  const { doc } = state;
  const [started, setStarted] = useState(false);
  const [sliceFiles, setSliceFiles] = useState<File[] | null>(null);
  const [menu, setMenu] = useState<null | 'open' | 'new' | 'canvas'>(null);
  const [newSize, setNewSize] = useState({ w: 48, h: 48, frames: 1 });
  const [canvasSize, setCanvasSize] = useState({ w: 48, h: 48, anchor: 'b' as Anchor9 });
  const [saving, setSaving] = useState(false);
  const clipboard = useRef<Floating | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const source = state.source.assetId ? assets.find(a => a.id === state.source.assetId) ?? null : null;

  const confirmDiscard = () => !state.dirty || confirm('Discard unsaved changes in the editor?');

  const openLibrary = async (a: SpriteAsset) => {
    if (!confirmDiscard()) return;
    try {
      const { doc: d, layered } = await openAsset(projectId, a);
      ed.open(d, { assetId: a.id, updatedAt: a.updatedAt });
      setStarted(true); setMenu(null);
      notify(`Opened ${a.name}${layered ? ' (with layers)' : ''}`);
    } catch (e) { fail(e); }
  };

  useEffect(() => {
    if (!openRequest) return;
    const a = assets.find(x => x.id === openRequest.assetId);
    if (a) void openLibrary(a);
  }, [openRequest?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const newDoc = () => {
    if (!confirmDiscard()) return;
    const d = createDoc(Math.max(1, Math.min(512, newSize.w)), Math.max(1, Math.min(512, newSize.h)), Math.max(1, Math.min(200, newSize.frames)), 'New sprite');
    ed.open({ ...d, palette: style?.palette ?? [] });
    setStarted(true); setMenu(null);
  };

  const save = async () => {
    ed.settle();
    setSaving(true);
    try {
      const saved = await saveToLibrary(projectId, ed.ref.current.doc, source, { name: ed.ref.current.doc.name.trim() || 'sprite', kind: source?.kind ?? 'character' });
      ed.set({ dirty: false, source: { assetId: saved.id, updatedAt: saved.updatedAt } });
      onSaved(saved);
      notify(`Saved ${saved.name} to the library · ${saved.animations.map(a => a.name).join(', ')}`);
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  // ---------- playback ----------
  useEffect(() => {
    if (!state.playing) return;
    const range = playRange(doc, state.frame);
    const t = setTimeout(() => {
      const next = state.frame + 1;
      if (next > range.to) { if (range.loop) ed.goto(range.from); else ed.set({ playing: false }); }
      else ed.goto(next);
    }, doc.frames[state.frame]?.duration ?? 100);
    return () => clearTimeout(t);
  }, [state.playing, state.frame, doc, ed]);

  // ---------- keyboard ----------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const l = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', l);
    return () => window.removeEventListener('keydown', l);
  }, []);
  keyRef.current = (e: KeyboardEvent) => {
    if (!active || !started || sliceFiles) return;
    const s = ed.ref.current, mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 's') { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); void save(); return; }
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const f = s.doc.frames[s.frame];
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) ed.redo(); else ed.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); ed.redo(); return; }
    if (mod && k === 'a') { e.preventDefault(); ed.settle(); ed.set({ selection: { mask: new Uint8Array(s.doc.width * s.doc.height).fill(1), width: s.doc.width, height: s.doc.height } }); return; }
    if (mod && k === 'd') { e.preventDefault(); ed.settle(); ed.set({ selection: null }); return; }
    if (mod && e.shiftKey && k === 'i') { e.preventDefault(); if (s.selection) ed.set({ selection: invert(s.selection) }); return; }
    if (mod && (k === 'c' || k === 'x')) {
      e.preventDefault();
      const cel = editableCel(s.doc, s.layerId, f.id);
      const block = s.floating ?? (s.selection ? extract(cel, s.selection) : extract(cel, { mask: new Uint8Array(s.doc.width * s.doc.height).fill(1), width: s.doc.width, height: s.doc.height }));
      clipboard.current = block;
      if (k === 'x' && s.selection && !s.floating) ed.commit('Cut', withCel(s.doc, s.layerId, f.id, clearSelected(cel, s.selection)), { selection: null });
      if (k === 'x' && s.floating) ed.set({ floating: null });
      notify(k === 'x' ? 'Cut' : 'Copied');
      return;
    }
    if (mod && k === 'v') {
      e.preventDefault();
      if (!clipboard.current) return;
      ed.settle();
      ed.set({ floating: { ...clipboard.current }, selection: null, tool: 'move' });
      return;
    }
    if (mod && k === "'") { e.preventDefault(); ed.set(x => ({ view: { ...x.view, grid: !x.view.grid } })); return; }
    if (mod) return;
    if (e.key === 'Enter') { e.preventDefault(); if (s.floating) ed.settle(); else ed.set({ playing: !s.playing }); return; }
    if (e.key === 'Escape') { if (s.floating) ed.settle(); ed.set({ selection: null }); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (s.floating) { ed.set({ floating: null }); return; }
      if (s.selection && !isEmpty(s.selection)) ed.commit('Delete pixels', withCel(s.doc, s.layerId, f.id, clearSelected(editableCel(s.doc, s.layerId, f.id), s.selection)));
      return;
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      if (s.floating) {
        const [dx, dy] = e.key === 'ArrowLeft' ? [-d, 0] : e.key === 'ArrowRight' ? [d, 0] : e.key === 'ArrowUp' ? [0, -d] : [0, d];
        ed.set({ floating: { ...s.floating, x: s.floating.x + dx, y: s.floating.y + dy } });
      } else if (e.key === 'ArrowLeft') ed.goto(s.frame - 1);
      else if (e.key === 'ArrowRight') ed.goto(s.frame + 1);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const i = s.doc.layers.findIndex(l => l.id === s.layerId) + (e.key === 'ArrowUp' ? 1 : -1);
        if (s.doc.layers[i]) ed.set({ layerId: s.doc.layers[i].id });
      }
      return;
    }
    if (e.key === 'Home') { ed.goto(0); return; }
    if (e.key === 'End') { ed.goto(s.doc.frames.length - 1); return; }
    if (e.key === '[' || e.key === ']') { ed.set(x => ({ opts: { ...x.opts, brush: Math.max(1, Math.min(16, x.opts.brush + (e.key === ']' ? 1 : -1))) } })); return; }
    if (k === 'x') { ed.set(x => ({ primary: x.secondary, secondary: x.primary })); return; }
    if (k === 'o') { ed.set(x => ({ onion: { ...x.onion, on: !x.onion.on } })); return; }
    if (e.key === '+' || e.key === '=') { ed.set(x => ({ view: { ...x.view, zoom: Math.min(64, (x.view.zoom || 8) + 1) } })); return; }
    if (e.key === '-') { ed.set(x => ({ view: { ...x.view, zoom: Math.max(1, (x.view.zoom || 8) - 1) } })); return; }
    if (e.key === '0') { ed.set(x => ({ view: { ...x.view, zoom: 0, panX: 0, panY: 0 } })); return; }
    if (s.floating && (k === 'h' && e.shiftKey)) { ed.set({ floating: transformFloating(s.floating, 'flip-h') }); return; }
    if (s.floating && (k === 'v' && e.shiftKey)) { ed.set({ floating: transformFloating(s.floating, 'flip-v') }); return; }
    if (s.floating && k === 'r') { ed.set({ floating: transformFloating(s.floating, e.shiftKey ? 'rot-ccw' : 'rot-cw') }); return; }
    if (e.altKey && k === 'n') return;
    const map: Record<string, Tool> = { b: 'pencil', e: 'eraser', g: 'bucket', i: 'picker', l: 'line', m: 'select', q: 'lasso', w: 'wand', v: 'move', h: 'hand' };
    if (k === 'u') { ed.set({ tool: e.shiftKey ? 'ellipse' : 'rect' }); return; }
    if (map[k]) { if (map[k] !== 'move') ed.settle(); ed.set({ tool: map[k] }); }
  };

  // ---------- canvas menu ----------
  const canvasOp = (label: string, fn: (d: EditorDoc) => EditorDoc) => { ed.settle(); ed.commit(label, fn(ed.ref.current.doc), { selection: null }); setMenu(null); };

  if (!started) {
    return (
      <main className="ed-welcome">
        <div className="ed-welcome-inner">
          <h2>Sprite editor</h2>
          <p className="dim">Frames × layers with tags and onion skin, a full pixel toolset, sheet slicing and batch clean-up.</p>
          <div className="ed-welcome-grid">
            <button className="ed-welcome-card" onClick={() => fileInput.current?.click()}>
              <Icon name="upload" size={22} /><strong>Import a sprite sheet</strong>
              <span className="dim small">Any sheet, 10 or 100 frames: remove the background, split evenly or unevenly. Also GIFs, videos and frame sequences.</span>
            </button>
            <button className="ed-welcome-card" onClick={() => { setMenu('new'); setStarted(true); }}>
              <Icon name="plus" size={22} /><strong>New sprite</strong>
              <span className="dim small">Blank canvas with your Style Bible palette.</span>
            </button>
          </div>
          {assets.length > 0 && (
            <>
              <h3>Open from the library</h3>
              <div className="ed-asset-grid">{assets.map(a => <AssetPick key={a.id} projectId={projectId} asset={a} onClick={() => void openLibrary(a)} />)}</div>
            </>
          )}
        </div>
        <input ref={fileInput} type="file" multiple accept="image/*,video/*,.gif,.webp,.png,.jpg,.jpeg" hidden onChange={e => { const f = [...(e.target.files ?? [])]; if (f.length) setSliceFiles(f); e.target.value = ''; }} />
        {sliceFiles && <SlicerDialog files={sliceFiles} onCancel={() => setSliceFiles(null)} onError={e => { fail(e); setSliceFiles(null); }}
          onDone={d => { ed.open({ ...d, palette: d.palette.length ? d.palette : [] }); setSliceFiles(null); setStarted(true); notify(`${d.frames.length} frames ready`); }} />}
      </main>
    );
  }

  const selection = state.selection;
  return (
    <main className="editor">
      <header className="ed-top">
        <div className="ed-menu">
          <button className={menu === 'open' ? 'active' : ''} onClick={() => setMenu(m => (m === 'open' ? null : 'open'))}><Icon name="folder" /> Open</button>
          {menu === 'open' && (
            <div className="ed-pop wide">
              <button className="ed-pop-item" onClick={() => { setMenu(null); fileInput.current?.click(); }}><Icon name="upload" /> Import sprite sheet / GIF / video…</button>
              {assets.length > 0 && <div className="ed-pop-title">Library</div>}
              <div className="ed-asset-grid compact">{assets.map(a => <AssetPick key={a.id} projectId={projectId} asset={a} onClick={() => void openLibrary(a)} />)}</div>
            </div>
          )}
        </div>
        <div className="ed-menu">
          <button className={menu === 'new' ? 'active' : ''} onClick={() => setMenu(m => (m === 'new' ? null : 'new'))}><Icon name="plus" /> New</button>
          {menu === 'new' && (
            <div className="ed-pop">
              <div className="row2">
                <label className="field small-field"><span>Width</span><input type="number" min={1} max={512} value={newSize.w} onChange={e => setNewSize({ ...newSize, w: +e.target.value })} /></label>
                <label className="field small-field"><span>Height</span><input type="number" min={1} max={512} value={newSize.h} onChange={e => setNewSize({ ...newSize, h: +e.target.value })} /></label>
              </div>
              <label className="field small-field"><span>Frames</span><input type="number" min={1} max={200} value={newSize.frames} onChange={e => setNewSize({ ...newSize, frames: +e.target.value })} /></label>
              <button className="primary" onClick={newDoc}>Create</button>
            </div>
          )}
        </div>
        <input className="ed-name" value={doc.name} onChange={e => ed.set(s => ({ doc: { ...s.doc, name: e.target.value }, dirty: true }))} aria-label="Sprite name" />
        {source && <span className="dim small">editing library sprite</span>}
        {state.dirty && <span className="badge warn">unsaved</span>}
        <span className="ed-sep" />
        <button className="icon-btn" onClick={ed.undo} disabled={!state.history.past.length} title={`Undo ${state.history.past[state.history.past.length - 1]?.label ?? ''} (Ctrl+Z)`} aria-label="Undo"><Icon name="undo" /></button>
        <button className="icon-btn" onClick={ed.redo} disabled={!state.history.future.length} title={`Redo ${state.history.future[0]?.label ?? ''} (Ctrl+Shift+Z)`} aria-label="Redo"><Icon name="redo" /></button>
        <span className="ed-sep" />
        <div className="ed-menu">
          <button className={menu === 'canvas' ? 'active' : ''} onClick={() => { setCanvasSize({ w: doc.width, h: doc.height, anchor: 'b' }); setMenu(m => (m === 'canvas' ? null : 'canvas')); }}><Icon name="resize" /> Canvas</button>
          {menu === 'canvas' && (
            <div className="ed-pop">
              <button className="ed-pop-item" onClick={() => canvasOp('Trim canvas', d => trimCanvas(d, 1))}><Icon name="crop" /> Trim to content (all frames)</button>
              <div className="ed-pop-title">Canvas size</div>
              <div className="row2">
                <label className="field small-field"><span>Width</span><input type="number" min={1} max={512} value={canvasSize.w} onChange={e => setCanvasSize({ ...canvasSize, w: +e.target.value })} /></label>
                <label className="field small-field"><span>Height</span><input type="number" min={1} max={512} value={canvasSize.h} onChange={e => setCanvasSize({ ...canvasSize, h: +e.target.value })} /></label>
              </div>
              <div className="ed-anchor" role="radiogroup" aria-label="Anchor">
                {(['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'] as Anchor9[]).map(a => (
                  <button key={a} role="radio" aria-checked={canvasSize.anchor === a} className={canvasSize.anchor === a ? 'on' : ''} onClick={() => setCanvasSize({ ...canvasSize, anchor: a })} aria-label={`Anchor ${a}`} />
                ))}
              </div>
              <button className="primary small" onClick={() => canvasOp('Canvas size', d => resizeDoc(d, Math.max(1, Math.min(512, canvasSize.w)), Math.max(1, Math.min(512, canvasSize.h)), canvasSize.anchor))}>Apply size</button>
              <div className="ed-pop-title">Scale (nearest neighbour)</div>
              <div className="btnrow compact-row">
                {[0.5, 2, 3, 4].map(f => <button key={f} className="small" onClick={() => canvasOp(`Scale ${f}×`, d => scaleDoc(d, f))}>{f}×</button>)}
              </div>
              <div className="ed-pop-title">Pivot (feet point)</div>
              <div className="row2">
                <label className="field small-field"><span>X</span><input type="number" min={0} max={doc.width - 1} value={doc.pivot.x} onChange={e => ed.commit('Pivot', { ...doc, pivot: { ...doc.pivot, x: Math.max(0, Math.min(doc.width - 1, +e.target.value)) } })} /></label>
                <label className="field small-field"><span>Y</span><input type="number" min={0} max={doc.height - 1} value={doc.pivot.y} onChange={e => ed.commit('Pivot', { ...doc, pivot: { ...doc.pivot, y: Math.max(0, Math.min(doc.height - 1, +e.target.value)) } })} /></label>
              </div>
            </div>
          )}
        </div>
        {selection && !isEmpty(selection) && (
          <span className="ed-selbar">
            <span className="dim small">Selection</span>
            <button className="small" onClick={() => ed.set(s => ({ selection: s.selection ? invert(s.selection) : null }))} title="Ctrl+Shift+I">Invert</button>
            <button className="small" onClick={() => ed.set({ selection: null })} title="Ctrl+D">Deselect</button>
          </span>
        )}
        {state.floating && (
          <span className="ed-selbar">
            <button className="small" onClick={() => ed.set(s => ({ floating: s.floating && transformFloating(s.floating, 'flip-h') }))} title="Shift+H">Flip ↔</button>
            <button className="small" onClick={() => ed.set(s => ({ floating: s.floating && transformFloating(s.floating, 'flip-v') }))} title="Shift+V">Flip ↕</button>
            <button className="small" onClick={() => ed.set(s => ({ floating: s.floating && transformFloating(s.floating, 'rot-cw') }))} title="R">Rotate 90°</button>
            <button className="small primary" onClick={ed.settle} title="Enter">Place</button>
          </span>
        )}
        <div className="spacer" />
        <button className={state.view.grid ? 'chip active' : 'chip'} onClick={() => ed.set(s => ({ view: { ...s.view, grid: !s.view.grid } }))} title="Pixel grid (Ctrl+')"><Icon name="grid" size={12} /> Grid</button>
        <button className={state.view.showPivot ? 'chip active' : 'chip'} onClick={() => ed.set(s => ({ view: { ...s.view, showPivot: !s.view.showPivot } }))} title="Pivot and ground line"><Icon name="pivot" size={12} /> Pivot</button>
        <select className="compact" value={state.view.bg} onChange={e => ed.set(s => ({ view: { ...s.view, bg: e.target.value as 'checker' | 'dark' | 'light' } }))} aria-label="Canvas background">
          <option value="checker">Checker</option><option value="dark">Dark</option><option value="light">Light</option>
        </select>
        <select className="compact" value={state.view.zoom} onChange={e => ed.set(s => ({ view: { ...s.view, zoom: +e.target.value, panX: 0, panY: 0 } }))} aria-label="Zoom">
          <option value={0}>Fit</option>{[1, 2, 3, 4, 6, 8, 12, 16, 24, 32].map(z => <option key={z} value={z}>{z}×</option>)}
        </select>
        <button onClick={() => void downloadSheet(ed.ref.current.doc)} title="Download PNG sheet + JSON"><Icon name="download" /> Export</button>
        <button className="primary" onClick={() => void save()} disabled={saving} title="Save to the library (Ctrl+S)"><Icon name="save" /> {saving ? 'Saving…' : source ? 'Save' : 'Save to library'}</button>
      </header>

      <div className="ed-body">
        <ToolBar ed={ed} />
        <div className="ed-center">
          <OptionsBar ed={ed} />
          <Canvas ed={ed} onPickColor={(hex, sec) => ed.set(sec ? { secondary: hex } : { primary: hex })} />
        </div>
        <aside className="ed-side">
          <ColorPanel ed={ed} style={style} designs={designs} />
          <LayersPanel ed={ed} />
          <FrameTools ed={ed} notify={notify} />
        </aside>
      </div>
      <Timeline ed={ed} />

      <input ref={fileInput} type="file" multiple accept="image/*,video/*,.gif,.webp,.png,.jpg,.jpeg" hidden onChange={e => { const f = [...(e.target.files ?? [])]; if (f.length) setSliceFiles(f); e.target.value = ''; }} />
      {sliceFiles && <SlicerDialog files={sliceFiles} onCancel={() => setSliceFiles(null)} onError={e => { fail(e); setSliceFiles(null); }}
        onDone={d => { if (confirmDiscard()) { ed.open(d); notify(`${d.frames.length} frames ready`); } setSliceFiles(null); }} />}
      {menu && <div className="ed-pop-veil" onClick={() => setMenu(null)} />}
    </main>
  );
}
