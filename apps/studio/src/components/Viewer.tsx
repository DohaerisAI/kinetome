import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpriteAsset } from '@kinetome/core';
import { Icon } from '../icons.tsx';
import { drawChecker } from '../pixels.ts';
import { FrameThumb } from './FrameThumb.tsx';
import { EyedropperButton } from './Eyedropper.tsx';

type Bg = 'checker' | 'dark' | 'light' | 'custom';
type Mode = 'auto' | 'loop' | 'pingpong' | 'once';
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const PREFS = 'sprite.viewer';

interface Prefs { onion: boolean; grid: boolean; pivot: boolean; bg: Bg; custom: string; speed: number; mode: Mode }
const DEFAULTS: Prefs = { onion: false, grid: false, pivot: true, bg: 'checker', custom: '#3b6b4f', speed: 1, mode: 'auto' };
function readPrefs(): Prefs { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }; } catch { return DEFAULTS; } }

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'], ['← →', 'Previous / next frame'], ['Home', 'First frame'], ['[ ]', 'Previous / next animation'],
  ['+ −', 'Zoom in / out (0 = fit)'], ['O', 'Onion skin'], ['G', 'Pixel grid'], ['P', 'Pivot & ground line'], ['?', 'This help'],
];

/**
 * The sprite player. Plays the selected animation at its fps (times the speed), with
 * frame stepping, scrubbing, onion skin, pixel grid and pivot, all on the keyboard too.
 */
export function Viewer({ asset, img, animName, onAnim }: { asset: SpriteAsset | null; img: HTMLImageElement | null; animName: string | null; onAnim: (name: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });
  const [playing, setPlaying] = useState(false); // paused until asked: Space or the play button
  const [pos, setPos] = useState(0);
  const [zoom, setZoom] = useState(0); // 0 = fit
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const [help, setHelp] = useState(false);
  const dir = useRef(1);

  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs(p => ({ ...p, [k]: v }));
  useEffect(() => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* storage unavailable */ } }, [prefs]);

  const anim = asset?.animations.find(a => a.name === animName) ?? asset?.animations[0];
  const frames = anim?.frames ?? [];
  const n = frames.length;
  const mode: Exclude<Mode, 'auto'> = prefs.mode === 'auto' ? (anim?.loop === false ? 'once' : 'loop') : prefs.mode;

  useEffect(() => { setPos(0); dir.current = 1; setPlaying(false); }, [asset?.id, anim?.name]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // playback clock
  useEffect(() => {
    if (!playing || !anim || n < 2) return;
    let raf = 0, last = performance.now(), acc = 0;
    const step = 1000 / (anim.fps * prefs.speed);
    const tick = (now: number) => {
      acc += now - last; last = now;
      while (acc >= step) {
        acc -= step;
        setPos(p => {
          if (mode === 'loop') return (p + 1) % n;
          if (mode === 'once') { if (p >= n - 1) { setPlaying(false); return p; } return p + 1; }
          let next = p + dir.current;
          if (next >= n || next < 0) { dir.current *= -1; next = p + dir.current; }
          return Math.max(0, Math.min(n - 1, next));
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, anim, n, prefs.speed, mode]);

  const fit = asset ? Math.max(1, Math.floor(Math.min((size.w - 48) / asset.frameWidth, (size.h - 48) / asset.frameHeight))) : 1;
  const z = zoom || fit;

  // draw
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (prefs.bg === 'checker') drawChecker(ctx, size.w, size.h, 12);
    else { ctx.fillStyle = prefs.bg === 'dark' ? '#0e0e15' : prefs.bg === 'light' ? '#e8e6f0' : prefs.custom; ctx.fillRect(0, 0, size.w, size.h); }
    if (!asset || !img || !n) return;

    const fw = asset.frameWidth, fh = asset.frameHeight;
    const ox = Math.floor((size.w - fw * z) / 2), oy = Math.floor((size.h - fh * z) / 2);
    ctx.strokeStyle = 'rgba(160,160,255,0.18)';
    ctx.strokeRect(ox - 0.5, oy - 0.5, fw * z + 1, fh * z + 1);
    const drawFrame = (idx: number) => { const r = asset.frames[idx]; if (r) ctx.drawImage(img, r.x, r.y, r.w, r.h, ox, oy, r.w * z, r.h * z); };
    if (prefs.onion && n > 1) {
      ctx.globalAlpha = 0.22; drawFrame(frames[(pos - 1 + n) % n]);
      ctx.globalAlpha = 0.1; drawFrame(frames[(pos + 1) % n]);
      ctx.globalAlpha = 1;
    }
    drawFrame(frames[Math.min(pos, n - 1)]);
    if (prefs.grid && z >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      for (let x = 0; x <= fw; x++) { ctx.moveTo(ox + x * z + 0.5, oy); ctx.lineTo(ox + x * z + 0.5, oy + fh * z); }
      for (let y = 0; y <= fh; y++) { ctx.moveTo(ox, oy + y * z + 0.5); ctx.lineTo(ox + fw * z, oy + y * z + 0.5); }
      ctx.stroke();
    }
    if (prefs.pivot) {
      const px = ox + asset.pivot.x * z + z / 2, py = oy + (asset.pivot.y + 1) * z;
      ctx.strokeStyle = 'rgba(255,90,140,0.65)';
      ctx.beginPath();
      ctx.moveTo(ox - 12, py + 0.5); ctx.lineTo(ox + fw * z + 12, py + 0.5);
      ctx.moveTo(px + 0.5, py - 8); ctx.lineTo(px + 0.5, py + 8);
      ctx.stroke();
    }
  }, [asset, img, frames, n, pos, z, prefs, size]);

  const step = useCallback((d: number) => { setPlaying(false); setPos(p => (n ? (p + d + n) % n : 0)); }, [n]);
  const switchAnim = useCallback((d: number) => {
    if (!asset?.animations.length) return;
    const i = asset.animations.findIndex(a => a.name === anim?.name);
    onAnim(asset.animations[(i + d + asset.animations.length) % asset.animations.length].name);
  }, [asset, anim, onAnim]);

  // keyboard (ignored while typing in a field). Registered once; the handler ref always sees fresh state.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  useEffect(() => {
    onKeyRef.current = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || !asset) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); if (mode === 'once' && pos >= n - 1) setPos(0); setPlaying(p => !p); }
      else if (k === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (k === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (k === 'Home') { setPlaying(false); setPos(0); }
      else if (k === '[') switchAnim(-1);
      else if (k === ']') switchAnim(1);
      else if (k === '+' || k === '=') setZoom(v => Math.min(32, (v || fit) + 1));
      else if (k === '-') setZoom(v => Math.max(1, (v || fit) - 1));
      else if (k === '0') setZoom(0);
      else if (k === 'o' || k === 'O') setPref('onion', !prefs.onion);
      else if (k === 'g' || k === 'G') setPref('grid', !prefs.grid);
      else if (k === 'p' || k === 'P') setPref('pivot', !prefs.pivot);
      else if (k === '?') setHelp(h => !h);
      else if (k === 'Escape') setHelp(false);
    };
  });

  const toggleBtn = (on: boolean, icon: Parameters<typeof Icon>[0]['name'], label: string, key: string, onClick: () => void) => (
    <button className={on ? 'icon-btn on' : 'icon-btn'} onClick={onClick} aria-pressed={on} title={`${label} (${key})`} aria-label={label}><Icon name={icon} /></button>
  );

  return (
    <section className="viewer">
      <div className="viewer-toolbar">
        <div className="tb-group">
          <button className="icon-btn" onClick={() => { setPlaying(false); setPos(0); }} title="First frame (Home)" aria-label="First frame" disabled={!n}><Icon name="first" /></button>
          <button className="icon-btn" onClick={() => step(-1)} title="Previous frame (←)" aria-label="Previous frame" disabled={!n}><Icon name="prev" /></button>
          <button className="play-btn" onClick={() => { if (mode === 'once' && pos >= n - 1) setPos(0); setPlaying(p => !p); }} disabled={n < 2} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'}>
            <Icon name={playing && n > 1 ? 'pause' : 'play'} />
          </button>
          <button className="icon-btn" onClick={() => step(1)} title="Next frame (→)" aria-label="Next frame" disabled={!n}><Icon name="next" /></button>
        </div>
        <span className="frame-counter mono">{n ? `${String(Math.min(pos, n - 1) + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}` : '–'}</span>
        <select className="compact" value={prefs.speed} onChange={e => setPref('speed', Number(e.target.value))} aria-label="Speed" title="Playback speed">
          {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
        </select>
        <select className="compact" value={prefs.mode} onChange={e => setPref('mode', e.target.value as Mode)} aria-label="Playback mode" title="Playback mode">
          <option value="auto">{anim?.loop === false ? 'Once' : 'Loop'} (anim)</option>
          <option value="loop">Loop</option><option value="pingpong">Ping-pong</option><option value="once">Once</option>
        </select>
        <span className="dim small">{anim ? `${anim.fps} fps` : ''}</span>
        <div className="spacer" />
        <div className="tb-group">
          {toggleBtn(prefs.onion, 'onion', 'Onion skin', 'O', () => setPref('onion', !prefs.onion))}
          {toggleBtn(prefs.grid, 'grid', 'Pixel grid', 'G', () => setPref('grid', !prefs.grid))}
          {toggleBtn(prefs.pivot, 'pivot', 'Pivot & ground line', 'P', () => setPref('pivot', !prefs.pivot))}
        </div>
        <select className="compact" value={prefs.bg} onChange={e => setPref('bg', e.target.value as Bg)} aria-label="Background">
          <option value="checker">Checker</option><option value="dark">Dark</option><option value="light">Light</option><option value="custom">Custom</option>
        </select>
        {prefs.bg === 'custom' && <input type="color" value={prefs.custom} onChange={e => setPref('custom', e.target.value)} aria-label="Custom background color" />}
        {prefs.bg === 'custom' && <EyedropperButton onPick={c => setPref('custom', c)} title="Pick the background color from anywhere (e.g. your game's level)" />}
        <select className="compact" value={zoom} onChange={e => setZoom(Number(e.target.value))} aria-label="Zoom">
          <option value={0}>Fit · {fit}×</option>
          {[1, 2, 3, 4, 6, 8, 12, 16, 24].map(v => <option key={v} value={v}>{v}×</option>)}
        </select>
        <button className="icon-btn" onClick={() => setHelp(h => !h)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><Icon name="keyboard" /></button>
      </div>

      {asset && asset.animations.length > 1 && (
        <div className="anim-tabs" role="tablist" aria-label="Animations">
          {asset.animations.map(a => (
            <button key={a.name} role="tab" aria-selected={a.name === anim?.name} className={a.name === anim?.name ? 'anim-tab active' : 'anim-tab'} onClick={() => onAnim(a.name)}>
              {a.name}<span className="dim">{a.frames.length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="stage" ref={wrap}>
        <canvas ref={canvas} style={{ width: size.w, height: size.h }} onWheel={e => { if (!asset) return; setZoom(v => Math.max(1, Math.min(32, (v || fit) + (e.deltaY < 0 ? 1 : -1)))); }} />
        {!asset && <div className="stage-empty"><Icon name="film" size={28} /><span>Select a sprite, or drop images, GIFs or videos anywhere</span></div>}
        {help && (
          <div className="shortcuts" role="dialog" aria-label="Keyboard shortcuts" onClick={() => setHelp(false)}>
            <div className="shortcuts-card" onClick={e => e.stopPropagation()}>
              <strong>Keyboard</strong>
              {SHORTCUTS.map(([k, v]) => <div key={k} className="sc-row"><kbd>{k}</kbd><span>{v}</span></div>)}
            </div>
          </div>
        )}
      </div>

      {n > 1 && (
        <input className="scrubber" type="range" min={0} max={n - 1} value={Math.min(pos, n - 1)} aria-label="Scrub frames"
          onChange={e => { setPlaying(false); setPos(Number(e.target.value)); }} />
      )}
      <div className="timeline">
        {frames.map((f, i) => (
          <button key={i} className={i === pos ? 'cell active' : 'cell'} onClick={() => { setPlaying(false); setPos(i); }} title={`Frame ${i + 1} (sheet #${f})`}>
            <FrameThumb img={img} rect={asset?.frames[f]} size={44} crop={false} />
            <span className="mono">{i + 1}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
