import { useCallback, useEffect, useRef, useState } from 'react';
import { rampFor } from '@sprite/core';

type HSV = { h: number; s: number; v: number };

function hexToHsv(hex: string): HSV {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: HSV): string {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${to(f(5))}${to(f(3))}${to(f(1))}`;
}

const SIZE = 196, RING = 16, R = SIZE / 2, INNER = R - RING - 6, SQ = Math.floor(INNER * Math.SQRT2) - 2;

/**
 * Hue ring + saturation/value square. Emits every change (live) and shows the pixel-art
 * ramp the chosen color will produce, so the user sees shadow and highlight as they pick.
 */
export function ColorWheel({ value, onChange, swatches = [] }: { value: string; onChange: (hex: string) => void; swatches?: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(value));
  const [hex, setHex] = useState(value);
  const drag = useRef<'ring' | 'square' | null>(null);

  useEffect(() => {
    if (value.toLowerCase() !== hsvToHex(hsv).toLowerCase()) setHsv(hexToHsv(value));
    setHex(value);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = SIZE * dpr; c.height = SIZE * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, SIZE, SIZE);
    // hue ring
    const cg = ctx.createConicGradient(0, R, R);
    for (let a = 0; a <= 360; a += 30) cg.addColorStop(a / 360, `hsl(${a}, 100%, 50%)`);
    ctx.beginPath(); ctx.arc(R, R, R - 1, 0, Math.PI * 2); ctx.arc(R, R, R - RING, 0, Math.PI * 2, true);
    ctx.fillStyle = cg; ctx.fill();
    // SV square
    const x0 = R - SQ / 2, y0 = R - SQ / 2;
    ctx.fillStyle = `hsl(${hsv.h}, 100%, 50%)`; ctx.fillRect(x0, y0, SQ, SQ);
    const white = ctx.createLinearGradient(x0, 0, x0 + SQ, 0); white.addColorStop(0, '#fff'); white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white; ctx.fillRect(x0, y0, SQ, SQ);
    const black = ctx.createLinearGradient(0, y0, 0, y0 + SQ); black.addColorStop(0, 'rgba(0,0,0,0)'); black.addColorStop(1, '#000');
    ctx.fillStyle = black; ctx.fillRect(x0, y0, SQ, SQ);
    // markers
    const ha = (hsv.h * Math.PI) / 180, hr = R - RING / 2;
    const marker = (x: number, y: number) => {
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 7.5, 0, Math.PI * 2); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.stroke();
    };
    marker(R + Math.cos(ha) * hr, R + Math.sin(ha) * hr);
    marker(x0 + hsv.s * SQ, y0 + (1 - hsv.v) * SQ);
  }, [hsv]);

  const update = useCallback((next: HSV) => { setHsv(next); const h = hsvToHex(next); setHex(h); onChange(h); }, [onChange]);

  const pick = (e: React.PointerEvent, mode?: 'ring' | 'square') => {
    const rect = ref.current!.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const dx = x - R, dy = y - R, dist = Math.hypot(dx, dy);
    const m = mode ?? (dist > R - RING - 3 ? 'ring' : 'square');
    if (m === 'ring') update({ ...hsv, h: ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360 });
    else {
      const x0 = R - SQ / 2, y0 = R - SQ / 2;
      update({ ...hsv, s: Math.max(0, Math.min(1, (x - x0) / SQ)), v: Math.max(0, Math.min(1, 1 - (y - y0) / SQ)) });
    }
    return m;
  };

  const ramp = /^#[0-9a-f]{6}$/i.test(hex) ? rampFor(hex) : null;

  return (
    <div className="cw">
      <canvas
        ref={ref} style={{ width: SIZE, height: SIZE, touchAction: 'none', cursor: 'crosshair' }} aria-label="Color wheel" role="slider"
        onPointerDown={e => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = pick(e); }}
        onPointerMove={e => { if (drag.current) pick(e, drag.current); }}
        onPointerUp={() => { drag.current = null; }}
      />
      <div className="cw-row">
        <span className="cw-chip" style={{ background: hex }} />
        <input className="mono" value={hex} spellCheck={false} aria-label="Hex color"
          onChange={e => { const v = e.target.value.trim(); setHex(v); if (/^#[0-9a-f]{6}$/i.test(v)) { setHsv(hexToHsv(v)); onChange(v.toLowerCase()); } }} />
      </div>
      {ramp && (
        <div className="cw-ramp" title="Pixel-art ramp: cool shadow, base, warm highlight">
          {[ramp.shadow, ramp.base, ramp.light].map((c, i) => <span key={i} style={{ background: c }}><em>{['shadow', 'base', 'light'][i]}</em></span>)}
        </div>
      )}
      {swatches.length > 0 && (
        <div className="cw-swatches">
          {swatches.slice(0, 32).map(c => <button key={c} className="sw" style={{ background: c }} title={c} onClick={() => { setHsv(hexToHsv(c)); setHex(c); onChange(c); }} />)}
        </div>
      )}
    </div>
  );
}

/** A swatch button that opens the wheel in a popover. */
export function ColorField({ value, onChange, swatches, label }: { value: string; onChange: (hex: string) => void; swatches?: string[]; label: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const ramp = rampFor(value);
  return (
    <div className="cf" ref={box}>
      <button className="cf-btn" onClick={() => setOpen(o => !o)} aria-label={`${label} color ${value}`} aria-expanded={open}>
        <span style={{ background: ramp.shadow }} /><span style={{ background: ramp.base }} /><span style={{ background: ramp.light }} />
      </button>
      {open && <div className="cf-pop"><ColorWheel value={value} onChange={onChange} swatches={swatches} /></div>}
    </div>
  );
}
