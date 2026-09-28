import { useEffect, useRef, useState } from 'react';
import type { PixelImage } from '@kinetome/core';
import { Icon } from '../icons.tsx';
import { addFrame, addTag, composite, getCel, moveFrames, patchTag, removeFrames, removeTag, setDurations, type EditorDoc } from './model.ts';
import type { EditorApi } from './useEditor.ts';

const thumbCache = new WeakMap<PixelImage, HTMLCanvasElement>();
function thumbCanvas(img: PixelImage): HTMLCanvasElement {
  let c = thumbCache.get(img);
  if (!c) {
    c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    thumbCache.set(img, c);
  }
  return c;
}

/** Composite thumbnails, memoised per frame on the identity of its cels. */
const frameThumbs = new WeakMap<EditorDoc['cels'], Map<string, PixelImage>>();
export function frameImage(doc: EditorDoc, i: number): PixelImage {
  let m = frameThumbs.get(doc.cels);
  if (!m) { m = new Map(); frameThumbs.set(doc.cels, m); }
  const key = `${doc.frames[i].id}|${doc.layers.map(l => `${l.id}${l.visible ? 1 : 0}${l.opacity}`).join(',')}`;
  let img = m.get(key);
  if (!img) { img = composite(doc, i); m.set(key, img); }
  return img;
}

function Thumb({ img, size }: { img: PixelImage; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    const s = Math.min(size / img.width, size / img.height), w = img.width * s, h = img.height * s;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(thumbCanvas(img), (size - w) / 2, (size - h) / 2, w, h);
  }, [img, size]);
  return <canvas ref={ref} width={size} height={size} style={{ width: size, height: size, imageRendering: 'pixelated' }} />;
}

export function Timeline({ ed }: { ed: EditorApi }) {
  const { state } = ed;
  const { doc, frame, picked, onion } = state;
  const [drag, setDrag] = useState<number | null>(null);
  const [editTag, setEditTag] = useState<string | null>(null);
  const cell = 44;
  const pick = [...picked].sort((a, b) => a - b);
  const contiguous = pick.every((v, i) => i === 0 || v === pick[i - 1] + 1);
  const avgMs = Math.round(pick.reduce((s, i) => s + (doc.frames[i]?.duration ?? 100), 0) / Math.max(1, pick.length));
  const layers = [...doc.layers].reverse();
  const tag = editTag ? doc.tags.find(t => t.id === editTag) : null;

  const insert = (dup: boolean) => { ed.settle(); const r = addFrame(ed.ref.current.doc, frame, dup); ed.commit(dup ? 'Duplicate frame' : 'New frame', r.doc, { frame: r.index, picked: [r.index] }); };
  const del = () => { ed.settle(); if (doc.frames.length > pick.length) ed.commit(pick.length > 1 ? `Delete ${pick.length} frames` : 'Delete frame', removeFrames(doc, pick), { frame: Math.max(0, pick[0] - 1), picked: [Math.max(0, pick[0] - 1)] }); };
  const move = (dir: -1 | 1) => {
    if (!contiguous) return;
    const from = pick[0], n = pick.length, to = from + dir;
    if (to < 0 || to + n > doc.frames.length) return;
    ed.commit('Move frames', moveFrames(doc, from, n, to), { frame: frame + dir, picked: pick.map(i => i + dir) });
  };
  const drop = (target: number) => {
    if (drag === null) return;
    const block = pick.includes(drag) && contiguous ? pick : [drag];
    const from = block[0], n = block.length;
    let to = target > from ? target - n + 1 : target;
    to = Math.max(0, Math.min(doc.frames.length - n, to));
    if (to !== from) ed.commit('Move frames', moveFrames(doc, from, n, to), { frame: to + (frame - from >= 0 && frame - from < n ? frame - from : 0), picked: Array.from({ length: n }, (_, k) => to + k) });
    setDrag(null);
  };

  return (
    <section className="ed-timeline">
      <div className="ed-tl-bar">
        <button className="icon-btn" onClick={() => ed.goto(0)} title="First frame (Home)" aria-label="First frame"><Icon name="first" /></button>
        <button className="icon-btn" onClick={() => ed.goto(frame - 1)} title="Previous frame (←)" aria-label="Previous frame"><Icon name="prev" /></button>
        <button className="play-btn" onClick={() => { ed.settle(); ed.set(s => ({ playing: !s.playing })); }} title="Play / stop (Enter)" aria-label={state.playing ? 'Stop' : 'Play'}><Icon name={state.playing ? 'pause' : 'play'} /></button>
        <button className="icon-btn" onClick={() => ed.goto(frame + 1)} title="Next frame (→)" aria-label="Next frame"><Icon name="next" /></button>
        <span className="frame-counter mono">{String(frame + 1).padStart(2, '0')} / {String(doc.frames.length).padStart(2, '0')}</span>
        <span className="ed-sep" />
        <button className="small" onClick={() => insert(false)} title="New empty frame after this one (Alt+N)"><Icon name="plus" size={12} /> Frame</button>
        <button className="small" onClick={() => insert(true)} title="Duplicate this frame (Alt+D)"><Icon name="duplicate" size={12} /> Duplicate</button>
        <button className="small" onClick={del} disabled={doc.frames.length <= pick.length} title="Delete picked frames"><Icon name="trash" size={12} /></button>
        <button className="small" onClick={() => move(-1)} disabled={!contiguous || pick[0] === 0} title="Move picked frames left">◀</button>
        <button className="small" onClick={() => move(1)} disabled={!contiguous || pick[pick.length - 1] >= doc.frames.length - 1} title="Move picked frames right">▶</button>
        <span className="ed-sep" />
        <label className="ed-opt" title="Duration of the picked frames">
          <input type="number" className="num" min={10} max={5000} step={10} value={avgMs} onChange={e => ed.commit('Frame duration', setDurations(doc, pick, +e.target.value || 100))} aria-label="Frame duration in ms" /> ms
          <span className="dim small">({Math.round(1000 / avgMs)} fps)</span>
        </label>
        <button className="small" onClick={() => { const a = pick[0], b = pick[pick.length - 1]; ed.commit('New tag', addTag(doc, `anim${doc.tags.length + 1}`, a, b)); }} disabled={!contiguous} title="Name the picked frames as an animation (tag)"><Icon name="tag" size={12} /> Tag</button>
        <div className="spacer" />
        <button className={onion.on ? 'chip active' : 'chip'} onClick={() => ed.set(s => ({ onion: { ...s.onion, on: !s.onion.on } }))} title="Onion skin (O): past frames blue, next frames red" aria-pressed={onion.on}><Icon name="onion" size={12} /> Onion</button>
        {onion.on && (
          <span className="ed-onion">
            <label title="Frames before">−<input type="number" className="num tiny" min={0} max={5} value={onion.prev} onChange={e => ed.set(s => ({ onion: { ...s.onion, prev: Math.max(0, Math.min(5, +e.target.value)) } }))} /></label>
            <label title="Frames after">+<input type="number" className="num tiny" min={0} max={5} value={onion.next} onChange={e => ed.set(s => ({ onion: { ...s.onion, next: Math.max(0, Math.min(5, +e.target.value)) } }))} /></label>
            <label className="toggle small"><input type="checkbox" checked={onion.tint} onChange={e => ed.set(s => ({ onion: { ...s.onion, tint: e.target.checked } }))} /> tint</label>
          </span>
        )}
      </div>

      <div className="ed-tl-scroll">
        <div className="ed-tl-grid" style={{ gridTemplateColumns: `140px repeat(${doc.frames.length}, ${cell}px)` }}>
          {/* tags lane */}
          <div className="ed-tl-label dim small">Tags</div>
          <div className="ed-tl-tags" style={{ gridColumn: `2 / span ${doc.frames.length}`, gridTemplateColumns: `repeat(${doc.frames.length}, ${cell}px)` }}>
            {doc.tags.map(t => (
              <button key={t.id} className={editTag === t.id ? 'ed-tag on' : 'ed-tag'} style={{ gridColumn: `${t.from + 1} / ${t.to + 2}`, background: t.color }}
                onClick={() => { ed.goto(t.from); ed.set({ picked: Array.from({ length: t.to - t.from + 1 }, (_, k) => t.from + k) }); setEditTag(t.id); }} title={`${t.name}: frames ${t.from + 1}-${t.to + 1}${t.loop ? ' · loops' : ''}`}>
                {t.name}{t.loop ? ' ↻' : ''}
              </button>
            ))}
          </div>

          {/* frame thumbnails */}
          <div className="ed-tl-label dim small">Frames</div>
          {doc.frames.map((f, i) => (
            <button key={f.id} draggable className={`ed-fr${i === frame ? ' cur' : ''}${pick.includes(i) ? ' picked' : ''}${drag === i ? ' dragging' : ''}`}
              onClick={e => ed.goto(i, { extend: e.shiftKey, toggle: e.ctrlKey || e.metaKey })}
              onDragStart={() => setDrag(i)} onDragOver={e => e.preventDefault()} onDrop={() => drop(i)} onDragEnd={() => setDrag(null)}
              title={`Frame ${i + 1} · ${f.duration}ms`}>
              <Thumb img={frameImage(doc, i)} size={cell - 10} />
              <span className="mono">{i + 1}</span>
            </button>
          ))}

          {/* cels per layer */}
          {layers.map(l => (
            <div key={l.id} style={{ display: 'contents' }}>
              <div className={l.id === state.layerId ? 'ed-tl-label cur' : 'ed-tl-label'} onClick={() => ed.set({ layerId: l.id })}>
                <Icon name={l.visible ? 'eye' : 'eyeOff'} size={12} /> {l.name}
              </div>
              {doc.frames.map((f, i) => {
                const has = !!getCel(doc, l.id, f.id)?.data.some((v, k) => k % 4 === 3 && v > 0);
                return (
                  <button key={f.id} className={`ed-cel${i === frame && l.id === state.layerId ? ' cur' : ''}${pick.includes(i) ? ' picked' : ''}`}
                    onClick={e => { ed.set({ layerId: l.id }); ed.goto(i, { extend: e.shiftKey, toggle: e.ctrlKey || e.metaKey }); }}
                    aria-label={`${l.name} frame ${i + 1}${has ? '' : ' (empty)'}`}>
                    <span className={has ? 'ed-dot on' : 'ed-dot'} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {tag && (
        <div className="ed-tag-edit">
          <Icon name="tag" />
          <input key={tag.id} defaultValue={tag.name} aria-label="Tag name"
            onBlur={e => { if (e.target.value.trim() && e.target.value !== tag.name) ed.commit('Rename tag', patchTag(ed.ref.current.doc, tag.id, { name: e.target.value.trim() })); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          <span className="dim small">frames {tag.from + 1}–{tag.to + 1}</span>
          <label className="toggle small"><input type="checkbox" checked={tag.loop} onChange={e => ed.commit('Tag loop', patchTag(doc, tag.id, { loop: e.target.checked }))} /> loop</label>
          <button className="small" disabled={!contiguous} onClick={() => ed.commit('Tag range', patchTag(doc, tag.id, { from: pick[0], to: pick[pick.length - 1] }))} title="Set the tag to the picked frames">Use picked frames</button>
          <button className="small danger" onClick={() => { ed.commit('Delete tag', removeTag(doc, tag.id)); setEditTag(null); }}>Delete tag</button>
          <button className="icon-btn" onClick={() => setEditTag(null)} aria-label="Close"><Icon name="x" /></button>
        </div>
      )}
    </section>
  );
}
