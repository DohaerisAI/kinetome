import { useState } from 'react';
import { designPalette, designPortraitPrompt, designReferencePrompt, type Rect } from '@kinetome/core';
import { api } from '../../api.ts';
import { Icon } from '../../icons.tsx';
import { useImage } from '../../pixels.ts';
import type { AssetDraft } from '../../api.ts';
import { FrameThumb } from '../FrameThumb.tsx';
import { CopyButton, GeminiSteps, PromptBox, type TabProps } from './shared.tsx';

export function ReferenceTab({ projectId, style, design: d, assets, importFor, notify, fail, onAssetsChanged }: TabProps) {
  const prompt = designReferencePrompt(style, d);
  const linked = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;
  const img = useImage(linked ? api.sheetUrl(projectId, linked) : null);
  const palette = designPalette(d);

  return (
    <div className="tab-grid">
      <section className="card wide hero-card">
        <div className="hero-text">
          <h3>The reference sprite</h3>
          <p>One master image of {d.name} in your game's pixel style. Claude animates this exact art, so regenerate in Gemini until you truly love it, and make sure the limbs you want animated are visible (a robe that hides the legs limits leg moves).</p>
          <GeminiSteps withReference={false} />
          <div className="btnrow">
            <CopyButton text={prompt} />
            <button onClick={() => importFor({ assetId: linked?.id ?? null, anim: 'idle' })}><Icon name="upload" /> {linked ? 'Replace reference…' : 'Import result…'}</button>
          </div>
          <p className="dim small">Imports lock to {d.name}'s {palette.length} colors and {d.pixelHeight}px height{linked ? `, and become the "idle" animation of ${linked.name}` : ', creating the character in your library'}.</p>
        </div>
        <div className="hero-preview">
          {linked ? <FrameThumb img={img} rect={linked.frames[linked.animations.find(a => a.name === 'idle')?.frames[0] ?? 0]} size={160} className="thumb" />
            : <div className="hero-placeholder"><Icon name="image" size={28} /><span className="dim small">No reference yet</span></div>}
          <div className="swatches small">{palette.map(c => <span key={c} className="sw" style={{ background: c }} title={c} />)}</div>
        </div>
      </section>
      {linked && img && <PortraitCard projectId={projectId} name={d.name} img={img} rect={linked.frames[linked.animations.find(a => a.name === 'idle')?.frames[0] ?? 0]}
        prompt={designPortraitPrompt(style, d)} importFor={() => importFor({ assetId: null, anim: 'portrait' })} notify={notify} fail={fail} onSaved={onAssetsChanged} />}
      <section className="card wide">
        <PromptBox text={prompt} />
        <p className="dim small">Have an anime drawing, a photo or a sketch you like? Attach it in Gemini together with this prompt and add "based on the attached image". Gemini will translate it into your pixel style; use the pixel result as the reference, never the original.</p>
      </section>
    </div>
  );
}

/**
 * Dialogue portrait and inventory/HUD icon. Instant: cropped from the reference's head
 * (no tokens). Better: a Gemini bust portrait with the prompt below, imported like any art.
 */
function PortraitCard({ projectId, name, img, rect, prompt, importFor, notify, fail, onSaved }: {
  projectId: string; name: string; img: HTMLImageElement; rect: Rect; prompt: string;
  importFor: () => void; notify: (m: string) => void; fail: (e: unknown) => void; onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // the head: top of the visible pixels, a square as wide as the upper body
  const head = (() => {
    const c = document.createElement('canvas'); c.width = rect.w; c.height = rect.h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    const d = g.getImageData(0, 0, rect.w, rect.h).data;
    let x0 = rect.w, y0 = rect.h, x1 = -1, y1 = -1;
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) if (d[(y * rect.w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    const hgt = y1 - y0 + 1, side = Math.max(8, Math.round(hgt * 0.3));
    // the head is where the pixel mass is densest near the top: slide a head-sized window
    // over the upper band and keep the fullest spot (a thin staff or a hat tip loses)
    const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < rect.w && y < rect.h && d[(y * rect.w + x) * 4 + 3] > 0;
    let best = { x: x0, y: y0, n: -1 };
    for (let wy = y0; wy <= y0 + Math.round(side * 0.5); wy++) for (let wx = x0 - Math.floor(side / 3); wx <= x1 - Math.floor(side * 0.66); wx++) {
      let n = 0;
      for (let y = wy; y < wy + side; y++) for (let x = wx; x < wx + side; x++) if (opaque(x, y)) n++;
      if (n > best.n) best = { x: wx, y: wy, n };
    }
    // then start at the head's top so the crown isn't cut off
    let top = best.y;
    for (let y = y0; y <= best.y; y++) { let hit = 0; for (let x = best.x; x < best.x + side; x++) if (opaque(x, y)) hit++; if (hit >= Math.max(2, side / 8)) { top = y; break; } }
    return { canvas: c, x: Math.max(0, Math.min(rect.w - side, best.x)), y: Math.max(0, Math.min(rect.h - side, top - 1)), side };
  })();
  const save = async (kind: 'portrait' | 'icon') => {
    if (!head) return;
    setBusy(true);
    try {
      const scale = kind === 'portrait' ? Math.max(1, Math.round(64 / head.side)) : 1;
      const w = head.side * scale;
      const c = document.createElement('canvas'); c.width = w; c.height = w;
      const g = c.getContext('2d')!; g.imageSmoothingEnabled = false;
      g.drawImage(head.canvas, head.x, head.y, head.side, head.side, 0, 0, w, w);
      const png = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
      const draft: AssetDraft = {
        name: `${name} ${kind}`, kind: 'ui', source: 'generated', description: `${name}'s ${kind === 'portrait' ? 'dialogue portrait' : 'icon'}, cropped from the reference sprite.`,
        frameWidth: w, frameHeight: w, frames: [{ x: 0, y: 0, w, h: w }], pivot: { x: Math.floor(w / 2), y: w - 1 },
        animations: [{ name: kind, frames: [0], fps: 1, loop: false }], tags: [kind], reference: false,
      };
      await api.createAsset(projectId, draft, png);
      onSaved();
      notify(`Saved ${draft.name} to the library`);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const preview = (canvasSize: number) => (c: HTMLCanvasElement | null) => {
    if (!c || !head) return;
    c.width = canvasSize; c.height = canvasSize;
    const g = c.getContext('2d')!; g.imageSmoothingEnabled = false; g.clearRect(0, 0, canvasSize, canvasSize);
    g.drawImage(head.canvas, head.x, head.y, head.side, head.side, 0, 0, canvasSize, canvasSize);
  };
  return (
    <section className="card wide portrait-card">
      <div className="hero-text">
        <h3>Portrait &amp; icon</h3>
        <p>For dialogue boxes, menus and the HUD. Crop one from the reference right now, or ask Gemini for a proper bust portrait with its own expression.</p>
        <div className="btnrow">
          <button onClick={() => void save('portrait')} disabled={busy || !head}><Icon name="plus" /> Save cropped portrait</button>
          <button onClick={() => void save('icon')} disabled={busy || !head}><Icon name="plus" /> Save icon ({head?.side ?? 0}px)</button>
        </div>
        <div className="btnrow">
          <CopyButton text={prompt} label="Copy portrait prompt" primary={false} />
          <button onClick={importFor}><Icon name="upload" /> Import Gemini portrait…</button>
        </div>
      </div>
      <div className="portrait-previews">
        <canvas ref={preview(96)} className="pix portrait-big" aria-label="Portrait preview" />
        <canvas ref={preview(32)} className="pix portrait-icon" aria-label="Icon preview" />
      </div>
    </section>
  );
}
