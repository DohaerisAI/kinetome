import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons.tsx';
import { drawChecker } from '../pixels.ts';
import { playRange, tagOf } from './model.ts';
import { frameImage } from './Timeline.tsx';
import type { EditorApi } from './useEditor.ts';

const H = 150;

/**
 * Live preview (Aseprite's Preview window): the sprite at true pixel scale, updating as
 * you draw, with its own playback of the current tag so you can watch the loop while
 * editing a frame. Paused by default; shows the frame being edited.
 */
export function Preview({ ed }: { ed: EditorApi }) {
  const { doc, frame } = ed.state;
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(260);
  const [scale, setScale] = useState<0 | 1 | 2 | 3>(0);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(frame);
  const range = playRange(doc, frame);
  const tag = tagOf(doc, frame);
  const shown = playing ? Math.max(range.from, Math.min(range.to, pos)) : frame;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { if (!playing) setPos(frame); }, [frame, playing]);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setPos(p => (p + 1 > range.to || p < range.from ? range.from : p + 1)), doc.frames[shown]?.duration ?? 100);
    return () => clearTimeout(t);
  }, [playing, shown, range.from, range.to, doc.frames]);

  const fit = Math.max(1, Math.floor(Math.min((w - 16) / doc.width, (H - 16) / doc.height)));
  const z = scale || fit;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(H * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChecker(ctx, w, H, 6);
    const img = frameImage(doc, shown);
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    ctx.imageSmoothingEnabled = false;
    const dw = doc.width * z, dh = doc.height * z;
    ctx.drawImage(cv, Math.floor((w - dw) / 2), Math.floor((H - dh) / 2), dw, dh);
  });

  return (
    <section className="ed-panel">
      <div className="ed-panel-head">
        <h3>Preview</h3>
        <span className="dim small">{tag ? tag.name : 'all frames'}</span>
        <div className="spacer" />
        <button className={playing ? 'icon-btn on' : 'icon-btn'} onClick={() => setPlaying(p => !p)} disabled={range.to <= range.from} aria-label={playing ? 'Pause preview' : 'Play preview'} title={playing ? 'Pause' : `Loop ${tag ? `"${tag.name}"` : 'all frames'} while you edit`}>
          <Icon name={playing ? 'pause' : 'play'} size={12} />
        </button>
        <select className="compact" value={scale} onChange={e => setScale(+e.target.value as typeof scale)} aria-label="Preview scale">
          <option value={0}>Fit</option><option value={1}>1×</option><option value={2}>2×</option><option value={3}>3×</option>
        </select>
      </div>
      <div ref={box} className="ed-preview">
        <canvas ref={ref} style={{ width: w, height: H }} />
        <span className="ed-preview-f mono">{shown + 1}</span>
      </div>
    </section>
  );
}
