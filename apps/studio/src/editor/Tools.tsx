import { Icon, type IconName } from '../icons.tsx';
import type { EditorApi, Tool } from './useEditor.ts';
import { copyFrameMeta, patchFrameMeta, type Dither } from './model.ts';

/** A tiny swatch of the dither pattern itself, drawn with CSS. */
function DitherSwatch({ level }: { level: Dither }) {
  const cells = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  return <span className="ed-dither-sw" aria-hidden>{cells.map((v, i) => <i key={i} className={!level || v < (level / 100) * 16 ? 'on' : ''} />)}</span>;
}

export const TOOLS: { id: Tool; icon: IconName; label: string; key: string }[] = [
  { id: 'pencil', icon: 'pencil', label: 'Pencil', key: 'B' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'shade', icon: 'shade', label: 'Shade', key: 'D' },
  { id: 'bucket', icon: 'bucket', label: 'Fill', key: 'G' },
  { id: 'picker', icon: 'eyedropper', label: 'Pick color', key: 'I' },
  { id: 'line', icon: 'line', label: 'Line', key: 'L' },
  { id: 'rect', icon: 'square', label: 'Rectangle', key: 'U' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse', key: 'Shift+U' },
  { id: 'select', icon: 'marquee', label: 'Select', key: 'M' },
  { id: 'lasso', icon: 'lasso', label: 'Lasso', key: 'Q' },
  { id: 'wand', icon: 'wandTool', label: 'Magic wand', key: 'W' },
  { id: 'move', icon: 'move', label: 'Move', key: 'V' },
  { id: 'boxes', icon: 'hitbox', label: 'Hitboxes', key: 'Y' },
  { id: 'hand', icon: 'hand', label: 'Pan (or hold Space)', key: 'H' },
];

export function ToolBar({ ed }: { ed: EditorApi }) {
  const { state } = ed;
  return (
    <div className="ed-tools" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {TOOLS.map((t, i) => (
        <span key={t.id} style={{ display: 'contents' }}>
          {(i === 5 || i === 8 || i === 11 || i === 13) && <span className="ed-tools-sep" />}
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
  const brushTools = ['pencil', 'eraser', 'shade', 'line', 'rect', 'ellipse'].includes(t);
  const ditherTools = ['pencil', 'eraser', 'line', 'rect', 'ellipse', 'bucket'].includes(t);
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
      {ditherTools && (
        <span className="seg compact ed-dither" role="radiogroup" aria-label="Dither pattern" title="Paint through a dither pattern: texture, gradients and soft shadows the pixel-art way">
          {([0, 25, 50, 75] as Dither[]).map(l => (
            <button key={l} role="radio" aria-checked={o.dither === l} className={o.dither === l ? 'active' : ''} onClick={() => setO({ dither: l })} title={l ? `${l}% dither` : 'Solid'}>
              <DitherSwatch level={l} />{l ? `${l}%` : 'Solid'}
            </button>
          ))}
        </span>
      )}
      {t === 'boxes' && (() => {
        const meta = state.doc.frames[state.frame]?.meta;
        const targets = state.picked.filter(i => i !== state.frame);
        return (
          <>
            <span className="seg compact" role="radiogroup" aria-label="Box kind">
              <button role="radio" aria-checked={state.boxKind === 'hurtboxes'} className={state.boxKind === 'hurtboxes' ? 'active' : ''} onClick={() => ed.set({ boxKind: 'hurtboxes' })} title="Where the character can be hit (its body)"><span className="ed-box-dot hurt" /> Hurtbox</button>
              <button role="radio" aria-checked={state.boxKind === 'hitboxes'} className={state.boxKind === 'hitboxes' ? 'active' : ''} onClick={() => ed.set({ boxKind: 'hitboxes' })} title="Where this frame hits (the attack)"><span className="ed-box-dot hit" /> Hitbox</button>
            </span>
            <span className="dim small">{meta ? `${meta.hurtboxes.length} hurt · ${meta.hitboxes.length} hit` : 'drag to draw · click a box to select, drag to move, Delete removes'}</span>
            <button className="small" disabled={!targets.length || !meta?.hurtboxes.length} onClick={() => ed.commit('Copy hurtboxes', copyFrameMeta(state.doc, state.frame, targets, { hurtboxes: true }))} title="Pick frames in the timeline first (Shift/Ctrl-click)">Copy hurtboxes to {targets.length || 'picked'} frames</button>
            <button className="small" disabled={!meta?.hitboxes.length && !meta?.hurtboxes.length} onClick={() => ed.commit('Clear boxes', patchFrameMeta(state.doc, state.frame, m => ({ ...m, hitboxes: [], hurtboxes: [] })), { selectedBox: null })}>Clear frame</button>
          </>
        );
      })()}
      {t === 'shade' && <span className="dim small">Left = lighter · right = darker · {state.doc.palette.length >= 2 ? 'steps along your palette, staying in each color’s hue family' : 'hue-shifted (warm lights, cool shadows); add a palette to shade along its ramps'}</span>}
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
