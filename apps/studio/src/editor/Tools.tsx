import { Icon, type IconName } from '../icons.tsx';
import type { EditorApi, Tool } from './useEditor.ts';

export const TOOLS: { id: Tool; icon: IconName; label: string; key: string }[] = [
  { id: 'pencil', icon: 'pencil', label: 'Pencil', key: 'B' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'bucket', icon: 'bucket', label: 'Fill', key: 'G' },
  { id: 'picker', icon: 'eyedropper', label: 'Pick color', key: 'I' },
  { id: 'line', icon: 'line', label: 'Line', key: 'L' },
  { id: 'rect', icon: 'square', label: 'Rectangle', key: 'U' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse', key: 'Shift+U' },
  { id: 'select', icon: 'marquee', label: 'Select', key: 'M' },
  { id: 'lasso', icon: 'lasso', label: 'Lasso', key: 'Q' },
  { id: 'wand', icon: 'wandTool', label: 'Magic wand', key: 'W' },
  { id: 'move', icon: 'move', label: 'Move', key: 'V' },
  { id: 'hand', icon: 'hand', label: 'Pan (or hold Space)', key: 'H' },
];

export function ToolBar({ ed }: { ed: EditorApi }) {
  const { state } = ed;
  return (
    <div className="ed-tools" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {TOOLS.map((t, i) => (
        <span key={t.id} style={{ display: 'contents' }}>
          {(i === 4 || i === 7 || i === 10) && <span className="ed-tools-sep" />}
          <button className={state.tool === t.id ? 'ed-tool active' : 'ed-tool'} onClick={() => { if (t.id !== 'move') ed.settle(); ed.set({ tool: t.id }); }}
            title={`${t.label} (${t.key})`} aria-label={t.label} aria-pressed={state.tool === t.id}>
            <Icon name={t.icon} />
          </button>
        </span>
      ))}
      <span className="ed-tools-sep" />
      <div className="ed-swatches" title="Primary / secondary color (X swaps). Right-click draws with secondary.">
        <span className="ed-sw2" style={{ background: state.secondary }} />
        <span className="ed-sw1" style={{ background: state.primary }} />
        <button className="ed-swap" onClick={() => ed.set(s => ({ primary: s.secondary, secondary: s.primary }))} aria-label="Swap colors"><Icon name="swap" size={12} /></button>
      </div>
    </div>
  );
}

/** Context bar above the canvas: options for the active tool. */
export function OptionsBar({ ed }: { ed: EditorApi }) {
  const { state } = ed;
  const o = state.opts;
  const setO = (patch: Partial<typeof o>) => ed.set(s => ({ opts: { ...s.opts, ...patch } }));
  const t = state.tool;
  const brushTools = ['pencil', 'eraser', 'line', 'rect', 'ellipse'].includes(t);
  const toggle = (on: boolean, label: string, onClick: () => void, icon?: IconName, title?: string) => (
    <button className={on ? 'chip active' : 'chip'} onClick={onClick} aria-pressed={on} title={title}>{icon && <Icon name={icon} size={12} />} {label}</button>
  );
  return (
    <div className="ed-options">
      <strong className="ed-tool-name">{TOOLS.find(x => x.id === t)?.label}</strong>
      {brushTools && (
        <label className="ed-opt">Size
          <input type="range" min={1} max={16} value={o.brush} onChange={e => setO({ brush: +e.target.value })} aria-label="Brush size" />
          <span className="mono">{o.brush}px</span>
        </label>
      )}
      {(t === 'pencil' || t === 'eraser') && toggle(o.pixelPerfect, 'Pixel perfect', () => setO({ pixelPerfect: !o.pixelPerfect }), undefined, 'Removes doubled corners from 1px freehand lines')}
      {(t === 'rect' || t === 'ellipse') && toggle(o.fillShapes, 'Filled', () => setO({ fillShapes: !o.fillShapes }))}
      {(t === 'bucket' || t === 'wand') && (
        <>
          {toggle(o.contiguous, 'Contiguous', () => setO({ contiguous: !o.contiguous }), undefined, 'Off = every pixel of that color')}
          {toggle(o.sampleAll, 'All layers', () => setO({ sampleAll: !o.sampleAll }), undefined, 'Read the flattened frame instead of the current layer')}
          <label className="ed-opt">Tolerance
            <input type="range" min={0} max={128} value={o.tolerance} onChange={e => setO({ tolerance: +e.target.value })} aria-label="Tolerance" />
            <span className="mono">{o.tolerance}</span>
          </label>
        </>
      )}
      {(t === 'select' || t === 'lasso' || t === 'wand') && <span className="dim small">Shift = add · Alt = subtract · Ctrl+D = deselect · V to move the selection</span>}
      {t === 'move' && <span className="dim small">{state.floating ? 'Drag to place · arrows nudge · Enter drops it' : state.selection ? 'Drag to lift and move the selection' : 'Drag to move the whole layer'}</span>}
      {t === 'picker' && <span className="dim small">Left = primary · right = secondary · Alt with any tool picks too</span>}
      <div className="spacer" />
      {brushTools && (
        <>
          {toggle(o.mirrorX, 'Mirror ↔', () => setO({ mirrorX: !o.mirrorX }), 'mirror', 'Symmetric drawing across the vertical centre')}
          {toggle(o.mirrorY, 'Mirror ↕', () => setO({ mirrorY: !o.mirrorY }), undefined, 'Symmetric drawing across the horizontal centre')}
        </>
      )}
    </div>
  );
}
