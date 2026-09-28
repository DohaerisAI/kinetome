import { useState } from 'react';
import { Icon } from '../icons.tsx';

interface NativeEyeDropper { open(): Promise<{ sRGBHex: string }> }
declare global { interface Window { EyeDropper?: new () => NativeEyeDropper } }

const toHex = (r: number, g: number, b: number) => '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);

/** Color under a click on a canvas or image (maps CSS pixels to the bitmap). */
function sampleElement(el: Element, clientX: number, clientY: number): string | null {
  const r = el.getBoundingClientRect();
  if (el instanceof HTMLCanvasElement) {
    const x = Math.floor(((clientX - r.left) / r.width) * el.width), y = Math.floor(((clientY - r.top) / r.height) * el.height);
    try {
      const d = el.getContext('2d')?.getImageData(x, y, 1, 1).data;
      return d && d[3] ? toHex(d[0], d[1], d[2]) : null;
    } catch { return null; }
  }
  if (el instanceof HTMLImageElement && el.naturalWidth) {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const ctx = c.getContext('2d')!;
    const x = Math.floor(((clientX - r.left) / r.width) * el.naturalWidth), y = Math.floor(((clientY - r.top) / r.height) * el.naturalHeight);
    try {
      ctx.drawImage(el, x, y, 1, 1, 0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return d[3] ? toHex(d[0], d[1], d[2]) : null;
    } catch { return null; }
  }
  // any other element: its background color
  const bg = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g);
  if (bg && (bg.length < 4 || +bg[3] > 0)) return toHex(+bg[0], +bg[1], +bg[2]);
  return null;
}

/** Fallback when the browser has no EyeDropper: the next click anywhere in the app samples it. */
function pickInPage(): Promise<string | null> {
  return new Promise(resolve => {
    document.body.classList.add('eyedropping');
    const done = (v: string | null) => {
      document.body.classList.remove('eyedropping');
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('keydown', esc, true);
      resolve(v);
    };
    const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); window.removeEventListener('click', swallow, true); };
    const down = (e: PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      done(el ? sampleElement(el, e.clientX, e.clientY) : null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    // attach after the click that started picking has finished
    setTimeout(() => {
      window.addEventListener('pointerdown', down, true);
      window.addEventListener('click', swallow, true);
      window.addEventListener('keydown', esc, true);
    }, 0);
  });
}

/**
 * Picks a color from anywhere: the whole screen with the browser's EyeDropper (Chrome,
 * Edge: other windows too, like a Gemini reference), otherwise any image or canvas here.
 */
export async function pickColor(): Promise<string | null> {
  if (window.EyeDropper) {
    try { return (await new window.EyeDropper().open()).sRGBHex.toLowerCase(); }
    catch { return null; } // cancelled with Esc
  }
  return pickInPage();
}

export function EyedropperButton({ onPick, className = 'icon-btn', title = 'Pick a color from anywhere on screen' }: { onPick: (hex: string) => void; className?: string; title?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className={busy ? `${className} on` : className} aria-pressed={busy} title={`${title} (Esc cancels)`} aria-label="Eyedropper"
      onClick={async e => { e.stopPropagation(); setBusy(true); const c = await pickColor(); setBusy(false); if (c) onPick(c); }}>
      <Icon name="eyedropper" size={14} />
    </button>
  );
}
