import { useEffect, useRef, useState } from 'react';
import type { SpriteAsset } from '@sprite/core';
import { drawChecker } from '../pixels.ts';
import { FrameThumb } from './FrameThumb.tsx';

type Bg = 'checker' | 'dark' | 'light';

export function Viewer({ asset, img, animName }: { asset: SpriteAsset | null; img: HTMLImageElement | null; animName: string | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });
  const [playing, setPlaying] = useState(true);
  const [pos, setPos] = useState(0); // index within the animation
  const [zoom, setZoom] = useState(0); // 0 = fit
  const [onion, setOnion] = useState(false);
  const [grid, setGrid] = useState(false);
  const [pivot, setPivot] = useState(true);
  const [bg, setBg] = useState<Bg>('checker');

  const anim = asset?.animations.find(a => a.name === animName) ?? asset?.animations[0];
  const frames = anim?.frames ?? [];

  useEffect(() => { setPos(0); }, [asset?.id, anim?.name]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // playback
  useEffect(() => {
    if (!playing || !anim || frames.length < 2) return;
    let raf = 0, last = performance.now(), acc = 0;
    const step = 1000 / anim.fps;
    const tick = (now: number) => {
      acc += now - last; last = now;
      if (acc >= step) {
        const n = Math.floor(acc / step);
        acc -= n * step;
        setPos(p => (anim.loop ? (p + n) % frames.length : Math.min(frames.length - 1, p + n)));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, anim, frames.length]);

  const z = asset ? (zoom || Math.max(1, Math.floor(Math.min((size.w - 32) / asset.frameWidth, (size.h - 32) / asset.frameHeight)))) : 1;

  // draw
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = size.w; c.height = size.h;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    if (bg === 'checker') drawChecker(ctx, c.width, c.height, 12);
    else { ctx.fillStyle = bg === 'dark' ? '#101018' : '#e8e6f0'; ctx.fillRect(0, 0, c.width, c.height); }
    if (!asset || !img || !frames.length) return;

    const fw = asset.frameWidth, fh = asset.frameHeight;
    const ox = Math.floor((c.width - fw * z) / 2), oy = Math.floor((c.height - fh * z) / 2);
    ctx.strokeStyle = 'rgba(160,160,255,0.25)';
    ctx.strokeRect(ox - 0.5, oy - 0.5, fw * z + 1, fh * z + 1);

    const drawFrame = (idx: number) => {
      const r = asset.frames[idx];
      if (r) ctx.drawImage(img, r.x, r.y, r.w, r.h, ox, oy, r.w * z, r.h * z);
    };
    if (onion && frames.length > 1) {
      ctx.globalAlpha = 0.25;
      drawFrame(frames[(pos - 1 + frames.length) % frames.length]);
      ctx.globalAlpha = 1;
    }
    drawFrame(frames[pos % frames.length]);

    if (grid && z >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      for (let x = 0; x <= fw; x++) { ctx.moveTo(ox + x * z + 0.5, oy); ctx.lineTo(ox + x * z + 0.5, oy + fh * z); }
      for (let y = 0; y <= fh; y++) { ctx.moveTo(ox, oy + y * z + 0.5); ctx.lineTo(ox + fw * z, oy + y * z + 0.5); }
      ctx.stroke();
    }
    if (pivot) {
      const px = ox + asset.pivot.x * z + z / 2, py = oy + asset.pivot.y * z + z;
      ctx.strokeStyle = 'rgba(255,90,140,0.7)';
      ctx.beginPath();
      ctx.moveTo(ox - 8, py + 0.5); ctx.lineTo(ox + fw * z + 8, py + 0.5); // baseline
      ctx.moveTo(px + 0.5, py - 10); ctx.lineTo(px + 0.5, py + 10);
      ctx.stroke();
    }
  }, [asset, img, frames, pos, z, onion, grid, pivot, bg, size]);

  const stepBy = (d: number) => { setPlaying(false); setPos(p => (p + d + frames.length) % Math.max(1, frames.length)); };

  return (
    <section className="viewer">
      <div className="viewer-toolbar">
        <button onClick={() => setPlaying(p => !p)} disabled={frames.length < 2} title="Space">{playing ? '❚❚ Pause' : '▶ Play'}</button>
        <button onClick={() => stepBy(-1)} title="Previous frame">◀</button>
        <button onClick={() => stepBy(1)} title="Next frame">▶</button>
        <span className="dim mono">{frames.length ? `${(pos % frames.length) + 1}/${frames.length}` : '–'} · {anim?.fps ?? 0}fps</span>
        <div className="spacer" />
        <label className="toggle"><input type="checkbox" checked={onion} onChange={e => setOnion(e.target.checked)} /> Onion</label>
        <label className="toggle"><input type="checkbox" checked={grid} onChange={e => setGrid(e.target.checked)} /> Grid</label>
        <label className="toggle"><input type="checkbox" checked={pivot} onChange={e => setPivot(e.target.checked)} /> Pivot</label>
        <select value={bg} onChange={e => setBg(e.target.value as Bg)} aria-label="Background">
          <option value="checker">Checker</option><option value="dark">Dark</option><option value="light">Light</option>
        </select>
        <select value={zoom} onChange={e => setZoom(Number(e.target.value))} aria-label="Zoom">
          <option value={0}>Fit ({z}×)</option>
          {[1, 2, 3, 4, 6, 8, 12, 16].map(n => <option key={n} value={n}>{n}×</option>)}
        </select>
      </div>
      <div className="stage" ref={wrap}>
        <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
        {!asset && <div className="stage-empty dim">Select or import a sprite</div>}
      </div>
      <div className="timeline">
        {frames.map((f, i) => (
          <button key={i} className={i === pos % frames.length ? 'cell active' : 'cell'} onClick={() => { setPlaying(false); setPos(i); }} title={`frame ${f}`}>
            <FrameThumb img={img} rect={asset?.frames[f]} size={44} />
            <span className="mono">{f}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
