import { useEffect, useMemo, useRef, useState } from 'react';
import type { Rect, SpriteAsset } from '@kinetome/core';
import { Icon } from '../icons.tsx';
import { drawChecker, useImage } from '../pixels.ts';

type Sheet = Pick<SpriteAsset, 'frames' | 'animations' | 'frameWidth' | 'frameHeight' | 'pivot'>;
export interface CompareSide { label: string; sheetUrl: string; asset: Sheet }
type Mode = 'side' | 'onion' | 'diff';

function frameOf(side: Sheet, anim: string, i: number): Rect | null {
  const a = side.animations.find(x => x.name === anim) ?? side.animations[0];
  if (!a || !a.frames.length) return side.frames[0] ?? null;
  return side.frames[a.frames[i % a.frames.length]] ?? null;
}

/**
 * Before / after: two versions of a sprite played in lockstep, side by side, as an onion
 * overlay, or as a diff that lights up every pixel that changed. Paused until asked.
 */
export function Compare({ left, right, onClose, actions }: { left: CompareSide; right: CompareSide; onClose?: () => void; actions?: React.ReactNode }) {
  const imgL = useImage(left.sheetUrl), imgR = useImage(right.sheetUrl);
  const names = useMemo(() => [...new Set([...right.asset.animations.map(a => a.name), ...left.asset.animations.map(a => a.name)])], [left, right]);
  const [anim, setAnim] = useState(names[0] ?? '');
  const [mode, setMode] = useState<Mode>('side');
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const H = 320;

  const lenOf = (s: Sheet) => (s.animations.find(x => x.name === anim)?.frames.length ?? 1);
  const n = Math.max(lenOf(left.asset), lenOf(right.asset));
  const fps = right.asset.animations.find(x => x.name === anim)?.fps ?? left.asset.animations.find(x => x.name === anim)?.fps ?? 8;

  useEffect(() => { setI(0); }, [anim]);
  useEffect(() => {
    if (!playing || n < 2) return;
    const t = setInterval(() => setI(x => (x + 1) % n), 1000 / fps);
    return () => clearInterval(t);
  }, [playing, n, fps]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    drawChecker(ctx, w, H, 10);
    const rl = frameOf(left.asset, anim, i), rr = frameOf(right.asset, anim, i);
    const fw = Math.max(left.asset.frameWidth, right.asset.frameWidth), fh = Math.max(left.asset.frameHeight, right.asset.frameHeight);
    const cols = mode === 'side' ? 2 : 1;
    const z = Math.max(1, Math.floor(Math.min((w / cols - 30) / fw, (H - 40) / fh)));
    const draw = (img: HTMLImageElement | null, r: Rect | null, s: Sheet, cx: number, alpha = 1) => {
      if (!img || !r) return;
      // align both versions on their pivots (feet), so a moved pivot doesn't read as a change
      const x = Math.round(cx - (s.pivot.x + 0.5) * z), y = Math.round(H - 20 - (s.pivot.y + 1) * z);
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, r.x, r.y, r.w, r.h, x, y, r.w * z, r.h * z);
      ctx.globalAlpha = 1;
    };
    if (mode === 'side') {
      draw(imgL, rl, left.asset, w / 4);
      draw(imgR, rr, right.asset, (w * 3) / 4);
      ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(Math.floor(w / 2), 10, 1, H - 20);
    } else if (mode === 'onion') {
      draw(imgL, rl, left.asset, w / 2, 0.45);
      draw(imgR, rr, right.asset, w / 2, 0.75);
    } else if (imgL && imgR && rl && rr) {
      // diff at 1:1 on an offscreen canvas, then scaled: magenta = changed, dim = same
      const off = document.createElement('canvas');
      off.width = fw; off.height = fh;
      const o = off.getContext('2d', { willReadFrequently: true })!;
      const grab = (img: HTMLImageElement, r: Rect, s: Sheet) => {
        o.clearRect(0, 0, fw, fh);
        o.drawImage(img, r.x, r.y, r.w, r.h, Math.floor(fw / 2) - s.pivot.x, fh - 1 - s.pivot.y, r.w, r.h);
        return o.getImageData(0, 0, fw, fh).data;
      };
      const a = grab(imgL, rl, left.asset), b = grab(imgR, rr, right.asset);
      const out = o.createImageData(fw, fh);
      let changed = 0;
      for (let p = 0; p < a.length; p += 4) {
        const same = a[p] === b[p] && a[p + 1] === b[p + 1] && a[p + 2] === b[p + 2] && (a[p + 3] > 0) === (b[p + 3] > 0);
        if (!same) { out.data.set([255, 60, 200, 255], p); changed++; }
        else if (b[p + 3]) out.data.set([b[p] * 0.35, b[p + 1] * 0.35, b[p + 2] * 0.35, 255], p);
      }
      o.putImageData(out, 0, 0);
      ctx.drawImage(off, Math.round(w / 2 - (fw * z) / 2), Math.round(H - 20 - fh * z), fw * z, fh * z);
      ctx.font = "12px 'Geist Mono Variable', monospace"; ctx.fillStyle = '#ff78d6';
      ctx.fillText(`${changed} px changed`, 12, 20);
    }
  }, [imgL, imgR, left, right, anim, i, mode, w]);

  return (
    <div className="compare">
      <div className="compare-bar">
        <span className="compare-label"><span className="dot-l" /> {left.label}</span>
        <span className="dim">vs</span>
        <span className="compare-label"><span className="dot-r" /> {right.label}</span>
        <div className="spacer" />
        {names.length > 1 && (
          <select className="compact" value={anim} onChange={e => setAnim(e.target.value)} aria-label="Animation">
            {names.map(x => <option key={x}>{x}</option>)}
          </select>
        )}
        <div className="seg compact" role="radiogroup" aria-label="Compare mode">
          {(['side', 'onion', 'diff'] as Mode[]).map(m => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{m === 'side' ? 'Side by side' : m === 'onion' ? 'Overlay' : 'Diff'}</button>
          ))}
        </div>
        {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close compare"><Icon name="x" /></button>}
      </div>
      <div ref={box} className="compare-stage"><canvas ref={canvas} style={{ width: w, height: H }} /></div>
      <div className="compare-foot">
        <button className="icon-btn" onClick={() => { setPlaying(false); setI(x => (x - 1 + n) % n); }} aria-label="Previous frame"><Icon name="prev" /></button>
        <button className="play-btn" onClick={() => setPlaying(p => !p)} disabled={n < 2} aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'pause' : 'play'} /></button>
        <button className="icon-btn" onClick={() => { setPlaying(false); setI(x => (x + 1) % n); }} aria-label="Next frame"><Icon name="next" /></button>
        <span className="frame-counter mono">{(i % n) + 1} / {n}</span>
        <div className="spacer" />
        {actions}
      </div>
    </div>
  );
}
