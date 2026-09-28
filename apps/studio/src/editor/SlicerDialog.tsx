import { useEffect, useMemo, useRef, useState } from 'react';
import { detectGrid, type PixelImage, type Rect } from '@kinetome/core';
import { DEFAULT_PIXELIZE, detectPixelScale, estimateBackground, pixelize, removeBackground, splitSheet, useHoles } from '@kinetome/pixel';
import { Icon } from '../icons.tsx';
import { decodeFiles } from '../decode.ts';
import { drawChecker } from '../pixels.ts';
import { blank, countRects, docFromFrames, framesFromRects, gridRects, isBlank, usedColors, type Align, type EditorDoc } from './model.ts';

type Mode = 'grid' | 'count' | 'auto' | 'manual';

interface Props { files: File[]; onCancel: () => void; onDone: (doc: EditorDoc) => void; onError: (e: unknown) => void }

const toImg = (d: ImageData): PixelImage => ({ width: d.width, height: d.height, data: d.data });

/**
 * Import any sprite sheet: remove its background, split it evenly (by cell size with
 * offset/padding, or by rows x columns), auto-detect uneven poses, or draw the boxes by
 * hand. GIFs, videos and image sequences skip straight to frames.
 */
export function SlicerDialog({ files, onCancel, onDone, onError }: Props) {
  const [source, setSource] = useState<PixelImage | null>(null);
  const [name, setName] = useState(files[0]?.name.replace(/\.\w+$/, '').replace(/[_-]+/g, ' ') ?? 'sprite');
  const [bg, setBg] = useState<'keep' | 'auto'>('auto');
  const [tolerance, setTolerance] = useState(0.09);
  const [holes, setHoles] = useState<'auto' | 'on' | 'off'>('auto');
  const [mode, setMode] = useState<Mode>('auto');
  const [grid, setGrid] = useState({ frameW: 32, frameH: 32, offsetX: 0, offsetY: 0, padX: 0, padY: 0, order: 'rows' as 'rows' | 'cols' });
  const [cnt, setCnt] = useState({ cols: 4, rows: 1, offsetX: 0, offsetY: 0, padX: 0, padY: 0 });
  const [skipEmpty, setSkipEmpty] = useState(true);
  const [align, setAlign] = useState<Align>('bottom');
  const [perRow, setPerRow] = useState(false);
  const [rebuild, setRebuild] = useState(true);
  const [manual, setManual] = useState<Rect[]>([]);
  const [selRect, setSelRect] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const preview = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const drag = useRef<{ kind: 'new' | 'move' | 'resize'; i: number; x0: number; y0: number; r0: Rect } | null>(null);

  // decode: one still image -> slicer; animations / sequences -> frames immediately
  useEffect(() => {
    let live = true;
    decodeFiles(files).then(d => {
      if (!live) return;
      if (d.frames.length > 1) {
        // GIF / video / image sequence: every frame onto one canvas, bottom-centred
        const imgs = d.frames.map(toImg);
        const W = Math.max(...imgs.map(f => f.width)), H = Math.max(...imgs.map(f => f.height));
        const frames = imgs.map(img => {
          const out = blank(W, H), ox = Math.floor((W - img.width) / 2), oy = H - img.height;
          for (let y = 0; y < img.height; y++) out.data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((oy + y) * W + ox) * 4);
          return out;
        });
        const ms = Math.round(d.durations.reduce((a, b) => a + b, 0) / d.durations.length);
        onDone(docFromFrames(frames, { name: d.name, duration: ms, pivot: { x: Math.floor(W / 2), y: H - 1 } }));
        return;
      }
      const img = toImg(d.frames[0]);
      setSource(img);
      const g = detectGrid(img);
      if (g) { setGrid(x => ({ ...x, frameW: g.frameWidth, frameH: g.frameHeight })); setMode('grid'); }
      setBusy(false);
    }, e => { if (live) onError(e); });
    return () => { live = false; };
  }, [files, onDone, onError]);

  // background removal on the whole sheet (so auto-detect sees poses, not the backdrop)
  const sheet = useMemo(() => {
    if (!source) return null;
    if (bg === 'keep') return { img: source, found: null as string | null };
    const b = estimateBackground(source);
    if (!b) return { img: source, found: 'none' };
    return { img: removeBackground(source, b, tolerance, useHoles({ holes }, b)), found: b.kind };
  }, [source, bg, tolerance, holes]);

  const split = useMemo((): { rects: Rect[]; rows: number[][] } => {
    if (!sheet) return { rects: [], rows: [] };
    const img = sheet.img;
    const keep = (rs: Rect[]) => (skipEmpty ? rs.filter(r => !isBlank(img, r)) : rs);
    const byRows = (rs: Rect[]) => {
      const ys = [...new Set(rs.map(r => r.y))].sort((a, b) => a - b);
      return ys.map(y => rs.flatMap((r, i) => (r.y === y ? [i] : [])));
    };
    if (mode === 'grid') { const rs = keep(gridRects(img.width, img.height, grid)); return { rects: rs, rows: byRows(rs) }; }
    if (mode === 'count') { const rs = keep(countRects(img.width, img.height, Math.max(1, cnt.cols), Math.max(1, cnt.rows), cnt)); return { rects: rs, rows: byRows(rs) }; }
    if (mode === 'auto') { const s = splitSheet(img); return { rects: s.rects, rows: s.rows }; }
    return { rects: manual, rows: [manual.map((_, i) => i)] };
  }, [sheet, mode, grid, cnt, manual, skipEmpty]);

  // AI "pixel art" is usually upscaled with blurry blocks; find the hidden pixel grid once
  const fakeScale = useMemo(() => {
    if (!sheet || !split.rects.length) return null;
    const probe = framesFromRects(sheet.img, split.rects.slice(0, 3), align).frames;
    const found = probe.map(f => detectPixelScale(f)).filter((g): g is NonNullable<typeof g> => !!g && g.scale >= 1.8);
    return found.length ? found.reduce((a, g) => a + g.scale, 0) / found.length : null;
  }, [sheet, split, align]);

  const cell = useMemo(() => {
    if (!split.rects.length) return null;
    return { w: Math.max(...split.rects.map(r => r.w)), h: Math.max(...split.rects.map(r => r.h)) };
  }, [split]);

  // preview drawing
  useEffect(() => {
    const c = preview.current;
    if (!c || !sheet) return;
    const img = sheet.img;
    const maxW = 720, maxH = 520;
    const fit = Math.min(maxW / img.width, maxH / img.height);
    const s = fit >= 1 ? Math.min(8, Math.floor(fit)) : fit;
    setScale(s);
    c.width = Math.ceil(img.width * s); c.height = Math.ceil(img.height * s);
    const ctx = c.getContext('2d')!;
    drawChecker(ctx, c.width, c.height, 8);
    const tmp = document.createElement('canvas');
    tmp.width = img.width; tmp.height = img.height;
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, c.width, c.height);
    ctx.font = '11px ui-monospace, monospace';
    split.rects.forEach((r, i) => {
      const on = mode === 'manual' && i === selRect;
      ctx.strokeStyle = on ? '#35d0ff' : 'rgba(255,80,140,.95)';
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeRect(r.x * s + 0.5, r.y * s + 0.5, r.w * s - 1, r.h * s - 1);
      if (r.w * s > 16) { ctx.fillStyle = on ? '#35d0ff' : 'rgba(255,80,140,.95)'; ctx.fillText(String(i + 1), r.x * s + 3, r.y * s + 11); }
      if (mode === 'manual') { ctx.fillStyle = on ? '#35d0ff' : 'rgba(255,80,140,.95)'; ctx.fillRect((r.x + r.w) * s - 5, (r.y + r.h) * s - 5, 5, 5); }
    });
  }, [sheet, split, mode, selRect]);

  // manual box editing
  const toImgPt = (e: React.PointerEvent) => {
    const r = preview.current!.getBoundingClientRect();
    return [Math.round((e.clientX - r.left) / scale), Math.round((e.clientY - r.top) / scale)] as [number, number];
  };
  const onDown = (e: React.PointerEvent) => {
    if (mode !== 'manual') return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const [x, y] = toImgPt(e);
    const hitCorner = manual.findIndex(r => Math.abs(x - (r.x + r.w)) * scale < 7 && Math.abs(y - (r.y + r.h)) * scale < 7);
    const hitBox = manual.findIndex(r => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
    if (hitCorner >= 0) { drag.current = { kind: 'resize', i: hitCorner, x0: x, y0: y, r0: manual[hitCorner] }; setSelRect(hitCorner); }
    else if (hitBox >= 0) { drag.current = { kind: 'move', i: hitBox, x0: x, y0: y, r0: manual[hitBox] }; setSelRect(hitBox); }
    else {
      const r = { x, y, w: 1, h: 1 };
      setManual(m => [...m, r]);
      drag.current = { kind: 'new', i: manual.length, x0: x, y0: y, r0: r };
      setSelRect(manual.length);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !sheet) return;
    const [x, y] = toImgPt(e);
    const W = sheet.img.width, H = sheet.img.height;
    setManual(m => m.map((r, i) => {
      if (i !== d.i) return r;
      if (d.kind === 'move') return { ...r, x: Math.max(0, Math.min(W - r.w, d.r0.x + x - d.x0)), y: Math.max(0, Math.min(H - r.h, d.r0.y + y - d.y0)) };
      if (d.kind === 'resize') return { ...r, w: Math.max(1, Math.min(W - r.x, d.r0.w + x - d.x0)), h: Math.max(1, Math.min(H - r.y, d.r0.h + y - d.y0)) };
      const x0 = Math.max(0, Math.min(d.x0, x)), y0 = Math.max(0, Math.min(d.y0, y));
      return { x: x0, y: y0, w: Math.max(1, Math.min(W, Math.max(d.x0, x)) - x0), h: Math.max(1, Math.min(H, Math.max(d.y0, y)) - y0) };
    }));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'new') setManual(m => m.filter((r, i) => i !== d.i || (r.w > 2 && r.h > 2)));
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (mode !== 'manual' || selRect === null || (e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { setManual(m => m.filter((_, i) => i !== selRect)); setSelRect(null); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [mode, selRect]);

  const create = () => {
    if (!sheet || !split.rects.length) return;
    let { frames, pivot } = framesFromRects(sheet.img, split.rects, align);
    if (rebuild && fakeScale) {
      // same engine as Pixelize: per-frame grid detection, shared anchoring, stray cleanup
      // rebuilt blocks carry many near-duplicate colors: consolidate to one clean shared palette
      const r = pixelize(frames, { ...DEFAULT_PIXELIZE, mode: 'grid', background: 'none', palette: 'auto', colors: 32, bible: [], fixedPalette: [], targetHeight: frames[0].height, outline: null, anchor: align === 'bottom' ? 'feet' : align === 'center' ? 'center' : 'none' });
      frames = r.frames; pivot = r.pivot;
    }
    const tags = perRow && split.rows.length > 1 ? split.rows.map((row, i) => ({ name: `row${i + 1}`, from: row[0], to: row[row.length - 1], loop: true })) : [];
    const doc = docFromFrames(frames, { name: name.trim() || 'sprite', pivot, tags });
    const colors = usedColors(doc, 65);
    onDone({ ...doc, palette: colors.length <= 64 ? colors : [] });
  };

  const num = (label: string, v: number, on: (n: number) => void, min = 0) => (
    <label className="field small-field"><span>{label}</span><input type="number" min={min} value={v} onChange={e => on(Math.max(min, +e.target.value || 0))} /></label>
  );

  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal slicer" role="dialog" aria-label="Import sprite sheet">
        <div className="modal-head">
          <strong>Import sprite sheet</strong>
          <span className="dim">{files.map(f => f.name).join(', ')}{source ? ` · ${source.width}×${source.height}` : ''}</span>
        </div>
        {busy && <p className="pad">Reading…</p>}
        {!busy && sheet && (
          <div className="slicer-body">
            <div className="slicer-preview">
              <canvas ref={preview} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} style={{ cursor: mode === 'manual' ? 'crosshair' : 'default' }} />
              {mode === 'manual' && <p className="dim small">Drag to draw a box · drag a box to move it · drag its corner to resize · Delete removes the selected box</p>}
            </div>
            <div className="slicer-side">
              <h3>1 · Background</h3>
              <div className="seg compact">
                <button className={bg === 'auto' ? 'active' : ''} onClick={() => setBg('auto')}>Remove</button>
                <button className={bg === 'keep' ? 'active' : ''} onClick={() => setBg('keep')}>Keep</button>
              </div>
              {bg === 'auto' && (
                <div className="row2">
                  <label className="field small-field"><span>Tolerance</span><input type="number" step={0.01} min={0.01} max={0.4} value={tolerance} onChange={e => setTolerance(+e.target.value || 0.09)} /></label>
                  <label className="field small-field"><span>Enclosed gaps</span>
                    <select value={holes} onChange={e => setHoles(e.target.value as typeof holes)}><option value="auto">auto</option><option value="on">clear</option><option value="off">keep</option></select>
                  </label>
                </div>
              )}
              {sheet.found === 'none' && <p className="dim small">No flat backdrop found; the sheet may already be transparent.</p>}

              <h3>2 · Split into frames</h3>
              <div className="seg compact slicer-modes">
                {([['grid', 'Cell size'], ['count', 'Rows × cols'], ['auto', 'Auto-detect'], ['manual', 'Manual']] as [Mode, string][]).map(([m, l]) => (
                  <button key={m} className={mode === m ? 'active' : ''} onClick={() => { if (m === 'manual' && !manual.length) setManual(split.rects); setMode(m); }}>{l}</button>
                ))}
              </div>
              {mode === 'grid' && (
                <>
                  <div className="row2">{num('Frame width', grid.frameW, v => setGrid({ ...grid, frameW: v }), 1)}{num('Frame height', grid.frameH, v => setGrid({ ...grid, frameH: v }), 1)}</div>
                  <div className="row2">{num('Offset X', grid.offsetX, v => setGrid({ ...grid, offsetX: v }))}{num('Offset Y', grid.offsetY, v => setGrid({ ...grid, offsetY: v }))}</div>
                  <div className="row2">{num('Padding X', grid.padX, v => setGrid({ ...grid, padX: v }))}{num('Padding Y', grid.padY, v => setGrid({ ...grid, padY: v }))}</div>
                  <label className="field small-field"><span>Order</span>
                    <select value={grid.order} onChange={e => setGrid({ ...grid, order: e.target.value as 'rows' | 'cols' })}><option value="rows">By rows</option><option value="cols">By columns</option></select>
                  </label>
                </>
              )}
              {mode === 'count' && (
                <>
                  <div className="row2">{num('Columns', cnt.cols, v => setCnt({ ...cnt, cols: v }), 1)}{num('Rows', cnt.rows, v => setCnt({ ...cnt, rows: v }), 1)}</div>
                  <div className="row2">{num('Offset X', cnt.offsetX, v => setCnt({ ...cnt, offsetX: v }))}{num('Offset Y', cnt.offsetY, v => setCnt({ ...cnt, offsetY: v }))}</div>
                  <div className="row2">{num('Padding X', cnt.padX, v => setCnt({ ...cnt, padX: v }))}{num('Padding Y', cnt.padY, v => setCnt({ ...cnt, padY: v }))}</div>
                </>
              )}
              {mode === 'auto' && <p className="dim small">Finds each pose by its outline: handles uneven spacing and sizes, drops text labels and specks, splits poses that touch.</p>}
              {mode === 'manual' && (
                <div className="btnrow">
                  <button className="small" onClick={() => { setManual([]); setSelRect(null); }}>Clear boxes</button>
                  <span className="dim small">{manual.length} box{manual.length === 1 ? '' : 'es'}</span>
                </div>
              )}
              {(mode === 'grid' || mode === 'count') && <label className="toggle block"><input type="checkbox" checked={skipEmpty} onChange={e => setSkipEmpty(e.target.checked)} /> Skip empty cells</label>}

              <h3>3 · Frames</h3>
              <label className="field small-field"><span>Line up uneven frames</span>
                <select value={align} onChange={e => setAlign(e.target.value as Align)}>
                  <option value="bottom">Bottom-centre (feet on one line)</option><option value="center">Centre</option><option value="top-left">Top-left (as cut)</option>
                </select>
              </label>
              {split.rows.length > 1 && <label className="toggle block"><input type="checkbox" checked={perRow} onChange={e => setPerRow(e.target.checked)} /> One animation per row ({split.rows.length} rows)</label>}
              {fakeScale && (
                <label className="toggle block" title="The art is drawn with blurry blocks about this many screen pixels wide; rebuild the real pixels">
                  <input type="checkbox" checked={rebuild} onChange={e => setRebuild(e.target.checked)} /> Rebuild true pixels (blocks ×{fakeScale.toFixed(1)} → 1px)
                </label>
              )}
              <label className="field small-field"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} /></label>
              <p className="slicer-summary"><strong>{split.rects.length}</strong> frames{cell ? ` · ${rebuild && fakeScale ? `~${Math.round(cell.w / fakeScale)}×${Math.round(cell.h / fakeScale)}` : `${cell.w}×${cell.h}`} each` : ''}</p>
            </div>
          </div>
        )}
        <div className="modal-foot">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!split.rects.length} onClick={create}><Icon name="check" /> Open {split.rects.length} frames in the editor</button>
        </div>
      </div>
    </div>
  );
}
