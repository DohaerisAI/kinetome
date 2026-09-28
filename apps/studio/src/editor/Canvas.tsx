import { useCallback, useEffect, useRef, useState } from 'react';
import type { PixelImage } from '@kinetome/core';
import {
  blank, clearSelected, cloneImage, combine, composite, drawEllipse, drawLine, drawRect, editableCel, extract, fillMask,
  floatingMask, getCel, getPixel, hexToRgba, linePoints, matchRegion, pixelPerfect, polyMask, rectMask, rgbaToHex, shift,
  stamp, stampFloating, withCel, type EditorDoc, type Floating, type RGBA,
} from './model.ts';
import type { EditorApi, EditorState } from './useEditor.ts';

type Pt = [number, number];

interface Gesture {
  tool: EditorState['tool'];
  button: number;
  start: Pt;
  last: Pt;
  points: Pt[];
  base: PixelImage;        // cel before the gesture
  work: PixelImage;        // cel being edited
  color: RGBA;
  floatStart?: Floating;   // move tool: floating block at gesture start
  lifted?: boolean;        // this gesture lifted the selection out of the cel
  panStart?: { x: number; y: number; px: number; py: number };
  selectMode: 'replace' | 'add' | 'subtract' | 'intersect';
}

const toCanvas = (img: PixelImage) => {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
};

/** Tints every opaque pixel of an image (onion skin: blue = past, red = future). */
function tinted(img: PixelImage, rgb: [number, number, number] | null): HTMLCanvasElement {
  if (!rgb) return toCanvas(img);
  const out = cloneImage(img);
  for (let i = 0; i < out.data.length; i += 4) {
    if (!out.data[i + 3]) continue;
    out.data[i] = (out.data[i] + rgb[0]) / 2; out.data[i + 1] = (out.data[i + 1] + rgb[1]) / 2; out.data[i + 2] = (out.data[i + 2] + rgb[2]) / 2;
  }
  return toCanvas(out);
}

export function Canvas({ ed, onPickColor }: { ed: EditorApi; onPickColor: (hex: string, secondary: boolean) => void }) {
  const { state, ref } = ed;
  const { doc, frame, layerId, view } = state;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const [hover, setHover] = useState<Pt | null>(null);
  const [space, setSpace] = useState(false);
  const [ants, setAnts] = useState(0);
  const gesture = useRef<Gesture | null>(null);
  const [, force] = useState(0);
  const redraw = useCallback(() => force(n => n + 1), []);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // marching ants
  useEffect(() => {
    if (!state.selection && !state.floating) return;
    const t = setInterval(() => setAnts(a => (a + 1) % 8), 120);
    return () => clearInterval(t);
  }, [state.selection, state.floating]);

  // hold space = temporary hand
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target as HTMLElement).closest('input, textarea, select')) { e.preventDefault(); setSpace(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(false); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  const fit = Math.max(1, Math.floor(Math.min((size.w - 40) / doc.width, (size.h - 40) / doc.height)));
  const z = view.zoom || fit;
  const ox = Math.floor((size.w - doc.width * z) / 2) + view.panX;
  const oy = Math.floor((size.h - doc.height * z) / 2) + view.panY;

  const toPixel = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.floor((e.clientX - r.left - ox) / z), Math.floor((e.clientY - r.top - oy) / z)];
  };

  // ---------- rendering ----------
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0c0c12'; ctx.fillRect(0, 0, size.w, size.h);

    // canvas background
    const W = doc.width * z, H = doc.height * z;
    if (view.bg === 'checker') {
      const s = Math.max(4, Math.min(16, z * 4));
      for (let y = 0; y < H; y += s) for (let x = 0; x < W; x += s) {
        ctx.fillStyle = ((x / s + y / s) & 1) ? '#34343f' : '#2a2a34';
        ctx.fillRect(ox + x, oy + y, Math.min(s, W - x), Math.min(s, H - y));
      }
    } else { ctx.fillStyle = view.bg === 'dark' ? '#14141c' : '#e9e7f1'; ctx.fillRect(ox, oy, W, H); }

    // onion skin
    const on = state.onion;
    if (on.on && !state.playing) {
      for (let k = on.prev; k >= 1; k--) {
        const i = frame - k;
        if (i < 0) continue;
        ctx.globalAlpha = on.opacity / k;
        ctx.drawImage(tinted(composite(doc, i), on.tint ? [60, 110, 255] : null), ox, oy, W, H);
      }
      for (let k = on.next; k >= 1; k--) {
        const i = frame + k;
        if (i >= doc.frames.length) continue;
        ctx.globalAlpha = on.opacity / k;
        ctx.drawImage(tinted(composite(doc, i), on.tint ? [255, 80, 80] : null), ox, oy, W, H);
      }
      ctx.globalAlpha = 1;
    }

    // current frame (with the in-progress gesture / floating block)
    const g = gesture.current;
    const f = doc.frames[frame];
    let shown: EditorDoc = doc;
    if (f && g && (g.tool !== 'hand' && g.tool !== 'select' && g.tool !== 'lasso' && g.tool !== 'picker' && g.tool !== 'wand')) shown = withCel(doc, layerId, f.id, g.work);
    if (f && state.floating) shown = withCel(shown, layerId, f.id, stampFloating(g && g.tool === 'move' ? g.work : editableCel(shown, layerId, f.id), state.floating));
    const flat = composite(shown, frame);
    ctx.drawImage(toCanvas(flat), ox, oy, W, H);

    // palette lock: mark off-palette pixels
    if (state.paletteLock && doc.palette.length >= 2) {
      const pal = new Set(doc.palette.map(h => h.toLowerCase()));
      ctx.strokeStyle = 'rgba(255,60,90,.9)'; ctx.lineWidth = 1;
      for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) {
        const i = (y * doc.width + x) * 4;
        if (flat.data[i + 3] < 128) continue;
        if (!pal.has(rgbaToHex([flat.data[i], flat.data[i + 1], flat.data[i + 2], 255]))) ctx.strokeRect(ox + x * z + 0.5, oy + y * z + 0.5, Math.max(1, z - 1), Math.max(1, z - 1));
      }
    }

    // pixel grid
    if (view.grid && z >= 6) {
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.beginPath();
      for (let x = 0; x <= doc.width; x++) { ctx.moveTo(ox + x * z + 0.5, oy); ctx.lineTo(ox + x * z + 0.5, oy + H); }
      for (let y = 0; y <= doc.height; y++) { ctx.moveTo(ox, oy + y * z + 0.5); ctx.lineTo(ox + W, oy + y * z + 0.5); }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(160,160,255,.25)'; ctx.strokeRect(ox - 0.5, oy - 0.5, W + 1, H + 1);

    // pivot / ground line
    if (view.showPivot) {
      const px = ox + doc.pivot.x * z + z / 2, py = oy + (doc.pivot.y + 1) * z;
      ctx.strokeStyle = 'rgba(255,90,140,.55)';
      ctx.beginPath(); ctx.moveTo(ox - 10, py + 0.5); ctx.lineTo(ox + W + 10, py + 0.5); ctx.moveTo(px + 0.5, py - 8); ctx.lineTo(px + 0.5, py + 8); ctx.stroke();
    }

    // selection outline (marching ants)
    const sel = state.floating ? floatingMask(state.floating, doc.width, doc.height) : state.selection;
    if (sel) {
      const m = sel.mask, Wd = doc.width, Hd = doc.height;
      const segs: [number, number, number, number][] = [];
      for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
        if (!m[y * Wd + x]) continue;
        if (y === 0 || !m[(y - 1) * Wd + x]) segs.push([x, y, x + 1, y]);
        if (y === Hd - 1 || !m[(y + 1) * Wd + x]) segs.push([x, y + 1, x + 1, y + 1]);
        if (x === 0 || !m[y * Wd + x - 1]) segs.push([x, y, x, y + 1]);
        if (x === Wd - 1 || !m[y * Wd + x + 1]) segs.push([x + 1, y, x + 1, y + 1]);
      }
      const path = () => { ctx.beginPath(); for (const [a, b, c2, d] of segs) { ctx.moveTo(ox + a * z + 0.5, oy + b * z + 0.5); ctx.lineTo(ox + c2 * z + 0.5, oy + d * z + 0.5); } };
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#000'; ctx.lineDashOffset = ants; path(); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineDashOffset = ants + 4; path(); ctx.stroke();
      ctx.setLineDash([]);
    }

    // live previews of selection gestures
    if (g && (g.tool === 'select' || g.tool === 'lasso')) {
      ctx.strokeStyle = '#fff'; ctx.setLineDash([3, 3]);
      if (g.tool === 'select') {
        const [ax, ay] = g.start, [bx, by] = g.last;
        ctx.strokeRect(ox + Math.min(ax, bx) * z + 0.5, oy + Math.min(ay, by) * z + 0.5, (Math.abs(bx - ax) + 1) * z, (Math.abs(by - ay) + 1) * z);
      } else {
        ctx.beginPath();
        g.points.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, ox + (x + 0.5) * z, oy + (y + 0.5) * z));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // brush cursor
    const t = space ? 'hand' : state.tool;
    if (hover && ['pencil', 'eraser', 'line', 'rect', 'ellipse'].includes(t)) {
      const b = state.opts.brush, o = Math.floor((b - 1) / 2);
      ctx.strokeStyle = 'rgba(255,255,255,.8)';
      ctx.strokeRect(ox + (hover[0] - o) * z + 0.5, oy + (hover[1] - o) * z + 0.5, b * z - 1, b * z - 1);
      if (state.opts.mirrorX) ctx.strokeRect(ox + (doc.width - 1 - hover[0] - o) * z + 0.5, oy + (hover[1] - o) * z + 0.5, b * z - 1, b * z - 1);
    }
    if (state.opts.mirrorX) { ctx.strokeStyle = 'rgba(53,208,255,.35)'; ctx.beginPath(); ctx.moveTo(ox + W / 2 + 0.5, oy); ctx.lineTo(ox + W / 2 + 0.5, oy + H); ctx.stroke(); }
    if (state.opts.mirrorY) { ctx.strokeStyle = 'rgba(53,208,255,.35)'; ctx.beginPath(); ctx.moveTo(ox, oy + H / 2 + 0.5); ctx.lineTo(ox + W, oy + H / 2 + 0.5); ctx.stroke(); }
  });

  // ---------- tools ----------
  const mirrored = (x: number, y: number): Pt[] => {
    const s = ref.current, pts: Pt[] = [[x, y]];
    if (s.opts.mirrorX) pts.push([s.doc.width - 1 - x, y]);
    if (s.opts.mirrorY) pts.push([x, s.doc.height - 1 - y]);
    if (s.opts.mirrorX && s.opts.mirrorY) pts.push([s.doc.width - 1 - x, s.doc.height - 1 - y]);
    return pts;
  };

  const paintStroke = (g: Gesture) => {
    const s = ref.current;
    g.work = cloneImage(g.base);
    const mask = s.selection?.mask ?? null;
    let pts: Pt[] = [];
    for (let i = 0; i < g.points.length; i++) {
      const seg = i === 0 ? [g.points[0]] : linePoints(g.points[i - 1][0], g.points[i - 1][1], g.points[i][0], g.points[i][1]).slice(1);
      pts.push(...(seg as Pt[]));
    }
    if (s.opts.pixelPerfect && s.opts.brush === 1) pts = pixelPerfect(pts);
    for (const [x, y] of pts) for (const [mx, my] of mirrored(x, y)) stamp(g.work, mx, my, g.color, s.opts.brush, mask);
  };

  const shapePreview = (g: Gesture, shiftKey: boolean) => {
    const s = ref.current;
    g.work = cloneImage(g.base);
    const mask = s.selection?.mask ?? null;
    let [x1, y1] = g.last;
    const [x0, y0] = g.start;
    if (shiftKey) {
      if (g.tool === 'line') {
        // snap to 0/45/90 degrees
        const dx = x1 - x0, dy = y1 - y0, a = Math.abs(dx), b = Math.abs(dy);
        if (a > b * 2) y1 = y0; else if (b > a * 2) x1 = x0; else { const m = Math.max(a, b); x1 = x0 + Math.sign(dx) * m; y1 = y0 + Math.sign(dy) * m; }
      } else { const m = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); x1 = x0 + Math.sign(x1 - x0 || 1) * m; y1 = y0 + Math.sign(y1 - y0 || 1) * m; }
    }
    const mirrorShape = (fn: (a: number, b: number, c: number, d: number) => void) => {
      fn(x0, y0, x1, y1);
      if (s.opts.mirrorX) fn(s.doc.width - 1 - x0, y0, s.doc.width - 1 - x1, y1);
      if (s.opts.mirrorY) fn(x0, s.doc.height - 1 - y0, x1, s.doc.height - 1 - y1);
    };
    if (g.tool === 'line') mirrorShape((a, b, c, d) => drawLine(g.work, a, b, c, d, g.color, s.opts.brush, mask));
    if (g.tool === 'rect') mirrorShape((a, b, c, d) => drawRect(g.work, a, b, c, d, g.color, s.opts.fillShapes, s.opts.brush, mask));
    if (g.tool === 'ellipse') mirrorShape((a, b, c, d) => drawEllipse(g.work, a, b, c, d, g.color, s.opts.fillShapes, s.opts.brush, mask));
  };

  const sampleImage = (s: EditorState) => (s.opts.sampleAll ? composite(s.doc, s.frame) : (getCel(s.doc, s.layerId, s.doc.frames[s.frame].id) ?? blank(s.doc.width, s.doc.height)));

  const onDown = (e: React.PointerEvent) => {
    const s = ref.current;
    const f = s.doc.frames[s.frame];
    if (!f) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = toPixel(e);
    let tool = space || e.button === 1 ? 'hand' : s.tool;
    if (e.altKey && ['pencil', 'bucket', 'line', 'rect', 'ellipse'].includes(tool)) tool = 'picker';
    const layer = s.doc.layers.find(l => l.id === s.layerId);
    const drawing = ['pencil', 'eraser', 'bucket', 'line', 'rect', 'ellipse', 'move'].includes(tool);
    if (drawing && (layer?.locked || !layer?.visible)) return;
    if (tool !== 'move' && s.floating) ed.settle();

    const secondary = e.button === 2;
    const color: RGBA = tool === 'eraser' ? [0, 0, 0, 0] : hexToRgba(secondary ? s.secondary : s.primary);
    const base = editableCel(ed.ref.current.doc, s.layerId, f.id);
    const g: Gesture = {
      tool: tool as Gesture['tool'], button: e.button, start: p, last: p, points: [p], base, work: cloneImage(base), color,
      selectMode: e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace',
    };
    if (tool === 'hand') g.panStart = { x: e.clientX, y: e.clientY, px: s.view.panX, py: s.view.panY };
    gesture.current = g;

    if (tool === 'pencil' || tool === 'eraser') paintStroke(g);
    else if (tool === 'picker') {
      const c = getPixel(sampleImage({ ...s, opts: { ...s.opts, sampleAll: true } }), p[0], p[1]);
      if (c[3] > 0) onPickColor(rgbaToHex(c), secondary);
      gesture.current = null;
    } else if (tool === 'bucket') {
      const region = matchRegion(sampleImage(s), p[0], p[1], s.opts.tolerance, s.opts.contiguous);
      fillMask(g.work, region, color, s.selection?.mask ?? null);
      ed.commit('Fill', withCel(s.doc, s.layerId, f.id, g.work), { lastEdit: { layerId: s.layerId, frame: s.frame, before: base, after: g.work, label: 'Fill' } });
      gesture.current = null;
    } else if (tool === 'wand') {
      const region = matchRegion(sampleImage(s), p[0], p[1], s.opts.tolerance, s.opts.contiguous);
      ed.set({ selection: combine(s.selection, region, g.selectMode, s.doc.width, s.doc.height) });
      gesture.current = null;
    } else if (tool === 'move') {
      if (!s.floating && s.selection) {
        // lift the selected pixels into a floating block
        const lifted = extract(base, s.selection);
        if (lifted) {
          g.work = clearSelected(base, s.selection);
          g.floatStart = lifted;
          g.lifted = true;
          ed.set({ floating: lifted, selection: null });
        }
      } else if (s.floating) g.floatStart = s.floating;
    }
    redraw();
  };

  const onMove = (e: React.PointerEvent) => {
    const p = toPixel(e);
    setHover(p[0] >= 0 && p[1] >= 0 && p[0] < doc.width && p[1] < doc.height ? p : null);
    const g = gesture.current;
    if (!g) return;
    const s = ref.current;
    if (g.tool === 'hand' && g.panStart) { ed.set({ view: { ...s.view, panX: g.panStart.px + e.clientX - g.panStart.x, panY: g.panStart.py + e.clientY - g.panStart.y } }); return; }
    if (p[0] === g.last[0] && p[1] === g.last[1]) return;
    g.last = p;
    if (g.tool === 'pencil' || g.tool === 'eraser') { g.points.push(p); paintStroke(g); }
    else if (g.tool === 'line' || g.tool === 'rect' || g.tool === 'ellipse') shapePreview(g, e.shiftKey);
    else if (g.tool === 'lasso') g.points.push(p);
    else if (g.tool === 'move') {
      const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
      if (g.floatStart) ed.set({ floating: { ...g.floatStart, x: g.floatStart.x + dx, y: g.floatStart.y + dy } });
      else g.work = shift(g.base, dx, dy);
    }
    redraw();
  };

  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const s = ref.current;
    const f = s.doc.frames[s.frame];
    if (!f) return;
    const label = { pencil: 'Draw', eraser: 'Erase', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', move: 'Move' }[g.tool as string];
    if (g.tool === 'select') {
      const click = g.start[0] === g.last[0] && g.start[1] === g.last[1];
      if (click && g.selectMode === 'replace') ed.set({ selection: null });
      else ed.set({ selection: combine(s.selection, rectMask(s.doc.width, s.doc.height, g.start[0], g.start[1], g.last[0], g.last[1]), g.selectMode, s.doc.width, s.doc.height) });
    } else if (g.tool === 'lasso') {
      if (g.points.length > 2) ed.set({ selection: combine(s.selection, polyMask(s.doc.width, s.doc.height, g.points.map(([x, y]) => [x + 0.5, y + 0.5])), g.selectMode, s.doc.width, s.doc.height) });
    } else if (g.tool === 'move') {
      if (g.floatStart) {
        // the lift leaves a hole in the cel (one undo step); the block keeps floating until placed
        if (g.lifted) ed.commit('Lift pixels', withCel(s.doc, s.layerId, f.id, g.work));
      } else if (!(g.start[0] === g.last[0] && g.start[1] === g.last[1])) {
        ed.commit('Move', withCel(s.doc, s.layerId, f.id, g.work), { lastEdit: { layerId: s.layerId, frame: s.frame, before: g.base, after: g.work, label: 'Move' } });
      }
    } else if (label) {
      ed.commit(label, withCel(s.doc, s.layerId, f.id, g.work), { lastEdit: { layerId: s.layerId, frame: s.frame, before: g.base, after: g.work, label } });
    }
    redraw();
    void e;
  };

  const onWheel = (e: React.WheelEvent) => {
    const s = ref.current;
    const cur = s.view.zoom || fit;
    const next = Math.max(1, Math.min(64, e.deltaY < 0 ? cur + Math.max(1, Math.round(cur * 0.15)) : cur - Math.max(1, Math.round(cur * 0.15))));
    if (next === cur) return;
    // zoom around the cursor
    const r = canvas.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const px = (mx - ox) / cur, py = (my - oy) / cur;
    const nox = Math.floor((size.w - s.doc.width * next) / 2), noy = Math.floor((size.h - s.doc.height * next) / 2);
    ed.set({ view: { ...s.view, zoom: next, panX: Math.round(mx - px * next - nox), panY: Math.round(my - py * next - noy) } });
  };

  const cursor = space || state.tool === 'hand' ? (gesture.current ? 'grabbing' : 'grab') : state.tool === 'move' ? 'move' : state.tool === 'picker' ? 'copy' : 'crosshair';

  return (
    <div className="ed-stage" ref={wrap}>
      <canvas
        ref={canvas} style={{ width: size.w, height: size.h, cursor }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setHover(null)}
        onContextMenu={e => e.preventDefault()} onWheel={onWheel}
      />
      <div className="ed-status mono">
        {hover ? `${hover[0]}, ${hover[1]}` : `${doc.width}×${doc.height}`} · {z}× · frame {frame + 1}/{doc.frames.length}
        {state.floating && <span className="badge warn">floating: drag to move · Enter to place</span>}
      </div>
    </div>
  );
}
