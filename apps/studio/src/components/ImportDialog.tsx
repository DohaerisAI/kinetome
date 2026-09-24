import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AssetKind, detectGrid, hardenAlpha, isUniform, normalizeFrames, parseSheet, sliceGrid, sliceIslands, snapToPalette,
  type Animation, type ParsedSheet, type SourceFrame, type StyleBible,
} from '@kinetome/core';
import type { AssetDraft } from '../api.ts';
import { canvasToPng, drawChecker, loadImage, pixelsToCanvas, repack, toPixels } from '../pixels.ts';

type Mode = 'json' | 'grid' | 'islands' | 'single';

interface Props {
  files: File[];
  style: StyleBible;
  onCancel: () => void;
  onImport: (draft: AssetDraft, png: Blob) => Promise<unknown>;
  onError: (e: unknown) => void;
  onPixelize: () => void;
}

export function ImportDialog({ files, style, onCancel, onImport, onError, onPixelize }: Props) {
  const pngFile = files.find(f => /\.png$/i.test(f.name));
  const jsonFile = files.find(f => /\.json$/i.test(f.name));
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [json, setJson] = useState<unknown>(null);
  const [mode, setMode] = useState<Mode>('grid');
  const [fw, setFw] = useState(32);
  const [fh, setFh] = useState(32);
  const [perRow, setPerRow] = useState(true);
  const [merge, setMerge] = useState(2);
  const [name, setName] = useState(pngFile?.name.replace(/\.png$/i, '').replace(/[_-]+/g, ' ') ?? 'sprite');
  const [kind, setKind] = useState<AssetDraft['kind']>('character');
  const [conform, setConform] = useState(false);
  const [busy, setBusy] = useState(false);
  const preview = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!pngFile) return;
    let live = true;
    const url = URL.createObjectURL(pngFile);
    loadImage(url).then(i => {
      if (!live) return;
      setImg(i);
      const guess = detectGrid(toPixels(i));
      if (guess) { setFw(guess.frameWidth); setFh(guess.frameHeight); }
      else { setFw(i.width); setFh(i.height); }
      if (!jsonFile && !guess) setMode('islands');
    }, e => live && onError(e));
    return () => { live = false; URL.revokeObjectURL(url); };
  }, [pngFile, jsonFile, onError]);

  useEffect(() => {
    if (!jsonFile) return;
    jsonFile.text().then(t => { setJson(JSON.parse(t)); setMode('json'); }).catch(onError);
  }, [jsonFile, onError]);

  const pixels = useMemo(() => (img ? toPixels(img) : null), [img]);

  const result = useMemo((): { sheet: ParsedSheet | null; error: string | null } => {
    if (!img || !pixels) return { sheet: null, error: null };
    try {
      if (mode === 'json') {
        if (!json) return { sheet: null, error: 'No JSON file dropped' };
        return { sheet: parseSheet(json), error: null };
      }
      if (mode === 'single') {
        const r = { x: 0, y: 0, w: img.width, h: img.height };
        return { sheet: { format: 'native', cellW: r.w, cellH: r.h, frames: [{ rect: r, offsetX: 0, offsetY: 0 }], animations: [{ name: 'default', frames: [0], fps: 10, loop: true }] }, error: null };
      }
      if (mode === 'grid') {
        if (fw < 1 || fh < 1 || fw > img.width || fh > img.height) return { sheet: null, error: 'Frame size out of range' };
        const rects = sliceGrid(img.width, img.height, fw, fh, pixels);
        if (!rects.length) return { sheet: null, error: 'Every cell is empty' };
        const frames: SourceFrame[] = rects.map(rect => ({ rect, offsetX: 0, offsetY: 0 }));
        let animations: Animation[];
        if (perRow) {
          const rows = [...new Set(rects.map(r => r.y))];
          animations = rows.map((y, i) => ({
            name: rows.length === 1 ? 'default' : `row${i + 1}`,
            frames: rects.flatMap((r, idx) => (r.y === y ? [idx] : [])), fps: 10, loop: true,
          }));
        } else animations = [{ name: 'default', frames: rects.map((_, i) => i), fps: 10, loop: true }];
        return { sheet: { format: 'native', cellW: fw, cellH: fh, frames, animations }, error: null };
      }
      const rects = sliceIslands(pixels, merge);
      if (!rects.length) return { sheet: null, error: 'No opaque pixels found' };
      const n = normalizeFrames(rects);
      return { sheet: { format: 'native', cellW: n.cellW, cellH: n.cellH, frames: n.frames, animations: [{ name: 'default', frames: rects.map((_, i) => i), fps: 10, loop: true }] }, error: null };
    } catch (e) {
      return { sheet: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [img, pixels, mode, json, fw, fh, perRow, merge]);

  // overlay preview
  useEffect(() => {
    const c = preview.current;
    if (!c || !img) return;
    const maxW = 560, maxH = 320;
    const fit = Math.min(maxW / img.width, maxH / img.height);
    const s = fit >= 1 ? Math.floor(fit) : fit; // integer upscale keeps pixels crisp
    c.width = Math.ceil(img.width * s); c.height = Math.ceil(img.height * s);
    const ctx = c.getContext('2d')!;
    drawChecker(ctx, c.width, c.height, 8);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    ctx.strokeStyle = 'rgba(255,80,140,0.9)';
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255,80,140,0.9)';
    result.sheet?.frames.forEach((f, i) => {
      ctx.strokeRect(Math.floor(f.rect.x * s) + 0.5, Math.floor(f.rect.y * s) + 0.5, Math.max(1, Math.floor(f.rect.w * s) - 1), Math.max(1, Math.floor(f.rect.h * s) - 1));
      if (f.rect.w * s > 18) ctx.fillText(String(i), f.rect.x * s + 2, f.rect.y * s + 10);
    });
  }, [img, result.sheet]);

  const doImport = async () => {
    const sheet = result.sheet;
    if (!img || !sheet) return;
    setBusy(true);
    try {
      let source: HTMLImageElement | HTMLCanvasElement = img;
      let rects = sheet.frames.map(f => f.rect);
      if (!isUniform(sheet)) {
        const packed = repack(img, sheet.frames, sheet.cellW, sheet.cellH);
        source = packed.canvas; rects = packed.rects;
      }
      let canvas: HTMLCanvasElement;
      if (conform) canvas = pixelsToCanvas(snapToPalette(hardenAlpha(toPixels(source)), style.palette));
      else if (source instanceof HTMLCanvasElement) canvas = source;
      else { canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d')!.drawImage(img, 0, 0); }
      const draft: AssetDraft = {
        name: name.trim() || 'sprite', kind, source: 'imported',
        frameWidth: sheet.cellW, frameHeight: sheet.cellH, frames: rects,
        pivot: sheet.pivot ?? { x: Math.floor(sheet.cellW / 2), y: sheet.cellH - 1 },
        animations: sheet.animations, tags: [], description: '', reference: false,
      };
      await onImport(draft, await canvasToPng(canvas));
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-label="Import sprite">
        <div className="modal-head">
          <strong>Import sprite</strong>
          <span className="dim">{pngFile?.name ?? 'no PNG'}{jsonFile ? ` + ${jsonFile.name}` : ''}{img ? ` · ${img.width}×${img.height}` : ''}</span>
        </div>
        {!pngFile ? <p className="pad">Drop or choose a PNG (optionally with its JSON).</p> : (
          <div className="modal-body">
            <div className="import-preview"><canvas ref={preview} /></div>
            <div className="import-side">
              <div className="seg">
                {(['json', 'grid', 'islands', 'single'] as Mode[]).map(m => (
                  <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)} disabled={m === 'json' && !json}>
                    {m === 'json' ? 'Sheet JSON' : m === 'grid' ? 'Grid' : m === 'islands' ? 'Auto-detect' : 'Single'}
                  </button>
                ))}
              </div>
              {mode === 'grid' && (
                <>
                  <div className="row2">
                    <label className="field"><span>Frame W</span><input type="number" min={1} value={fw} onChange={e => setFw(Number(e.target.value))} /></label>
                    <label className="field"><span>Frame H</span><input type="number" min={1} value={fh} onChange={e => setFh(Number(e.target.value))} /></label>
                  </div>
                  <label className="toggle block"><input type="checkbox" checked={perRow} onChange={e => setPerRow(e.target.checked)} /> One animation per row</label>
                </>
              )}
              {mode === 'islands' && (
                <label className="field"><span>Merge parts closer than (px)</span><input type="number" min={0} max={32} value={merge} onChange={e => setMerge(Number(e.target.value))} /></label>
              )}
              {mode === 'json' && result.sheet && <p className="dim small">Detected {result.sheet.format} format</p>}

              <label className="field"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} /></label>
              <label className="field"><span>Kind</span>
                <select value={kind} onChange={e => setKind(e.target.value as AssetDraft['kind'])}>
                  {AssetKind.options.map(k => <option key={k}>{k}</option>)}
                </select>
              </label>
              <label className="toggle block" title="Snap every pixel to the project palette and remove partial transparency">
                <input type="checkbox" checked={conform} onChange={e => setConform(e.target.checked)} /> Conform to Style Bible on import
              </label>

              {result.error && <div className="issue error">{result.error}</div>}
              {result.sheet && (
                <p className="small">
                  <strong>{result.sheet.frames.length}</strong> frames · cell {result.sheet.cellW}×{result.sheet.cellH} ·{' '}
                  {result.sheet.animations.map(a => `${a.name} (${a.frames.length})`).join(', ')}
                  {!isUniform(result.sheet) && <span className="dim"> · will be repacked into a uniform grid</span>}
                </p>
              )}
            </div>
          </div>
        )}
        <div className="modal-foot">
          <button className="ghost" onClick={onPixelize} title="Treat this PNG as an illustration or fake pixel art and convert it" style={{ marginRight: 'auto' }}>Not a sprite sheet? Pixelize it →</button>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!result.sheet || busy} onClick={doImport}>{busy ? 'Importing…' : 'Import'}</button>
        </div>
      </div>
    </div>
  );
}
