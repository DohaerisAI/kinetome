import { useEffect, useRef, useState } from 'react';
import { MAX_VIDEO_SECONDS } from '../decode.ts';
import { Icon } from '../icons.tsx';

/** How much of a clip each move needs: one cycle plus a little room for the loop search. */
export const NEEDS: Record<string, { seconds: number; tip: string }> = {
  run: { seconds: 2, tip: 'A run needs about 1-1.5 s: pick a stretch where it is already running at full speed (not the start-up).' },
  walk: { seconds: 2.5, tip: 'A walk needs about 1-2 s: pick a stretch of steady steps.' },
  dash: { seconds: 1.5, tip: 'A dash needs well under a second of action: pick it plus a moment either side.' },
  idle: { seconds: 3, tip: 'An idle needs one breath, about 1-3 s: pick a calm stretch where the character stands still.' },
  fall: { seconds: 2, tip: 'Pick a stretch where the character is already falling.' },
};
const DEFAULT_NEED = { seconds: 2, tip: 'Pick just the action (most attacks, hurts and jumps are under 1.5 s), with a moment either side.' };
export const needFor = (move: string | null | undefined) => NEEDS[(move ?? '').replace(/-\d+$/, '')] ?? DEFAULT_NEED;

/** A suggested window: the move's length, past any start-up for locomotion. */
export function suggestTrim(duration: number, move: string | null | undefined): { start: number; end: number } {
  const len = Math.min(duration, MAX_VIDEO_SECONDS, needFor(move).seconds);
  const id = (move ?? '').replace(/-\d+$/, '');
  const lead = ['run', 'walk', 'dash', 'fall'].includes(id) ? Math.min(1, duration * 0.2) : 0;
  const start = Math.max(0, Math.min(lead, duration - len));
  return { start, end: start + len };
}

const fmt = (s: number) => `${s.toFixed(1)} s`;

/**
 * Pick the part of a clip to turn into an animation. Video models make 8-20 s clips; one
 * animation needs a second or three of it. Only the chosen part is read, so the import is faster.
 */
export function VideoTrimmer({ file, move, initial, onConfirm }: {
  file: File; move: string | null | undefined; initial: { start: number; end: number } | null;
  onConfirm: (t: { start: number; end: number }) => void;
}) {
  // created and revoked inside one effect: React's dev double-run would otherwise revoke a URL in use
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u); }, [file]);
  const video = useRef<HTMLVideoElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number } | null>(initial);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [playing, setPlaying] = useState(true);
  const [head, setHead] = useState(0);
  const need = needFor(move);

  // duration, a suggested window, and a filmstrip of the whole clip
  useEffect(() => {
    if (!url) return;
    let live = true;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = url;
    v.onloadeddata = async () => {
      if (!live) return;
      const d = v.duration || 0;
      setDuration(d);
      setRange(r => r ?? suggestTrim(d, move));
      const n = 14, c = document.createElement('canvas'), out: string[] = [];
      c.height = 54; c.width = Math.round(54 * (v.videoWidth / Math.max(1, v.videoHeight)));
      const g = c.getContext('2d')!;
      for (let i = 0; i < n && live; i++) {
        await new Promise<void>(res => { v.onseeked = () => res(); v.currentTime = Math.min(d - 0.05, ((i + 0.5) / n) * d); });
        g.drawImage(v, 0, 0, c.width, c.height);
        out.push(c.toDataURL('image/jpeg', 0.6));
        if (live) setThumbs([...out]);
      }
      v.removeAttribute('src');
    };
    return () => { live = false; v.removeAttribute('src'); };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  // the preview loops inside the window
  useEffect(() => {
    const v = video.current;
    if (!v || !range) return;
    if (v.currentTime < range.start || v.currentTime > range.end) v.currentTime = range.start;
    const tick = () => { if (v.currentTime >= range.end || v.currentTime < range.start - 0.05) v.currentTime = range.start; setHead(v.currentTime); };
    v.addEventListener('timeupdate', tick);
    return () => v.removeEventListener('timeupdate', tick);
  }, [range]);
  useEffect(() => { const v = video.current; if (v) void (playing ? v.play().catch(() => {}) : v.pause()); }, [playing]);

  // dragging: a handle moves one edge, the window body moves both
  const drag = (kind: 'start' | 'end' | 'move') => (e: React.PointerEvent) => {
    if (!range || !duration || !strip.current) return;
    e.preventDefault();
    const box = strip.current.getBoundingClientRect(), x0 = e.clientX, r0 = range;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dt = ((ev.clientX - x0) / box.width) * duration;
      let { start, end } = r0;
      if (kind === 'move') { const len = end - start; start = Math.max(0, Math.min(duration - len, start + dt)); end = start + len; }
      else if (kind === 'start') start = Math.max(0, Math.max(end - MAX_VIDEO_SECONDS, Math.min(end - 0.2, start + dt)));
      else end = Math.min(duration, Math.min(start + MAX_VIDEO_SECONDS, Math.max(start + 0.2, end + dt)));
      setRange({ start, end });
      const v = video.current;
      if (v) v.currentTime = kind === 'end' ? Math.max(start, end - 0.05) : start;
    };
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  const setLength = (len: number) => setRange(r => { if (!r) return r; const start = Math.min(r.start, Math.max(0, duration - len)); return { start, end: Math.min(duration, start + len) }; });

  const pct = (t: number) => `${(t / Math.max(0.001, duration)) * 100}%`;
  const len = range ? range.end - range.start : 0;
  return (
    <div className="trim">
      <div className="trim-top">
        <div className="trim-video">
          <video ref={video} src={url ?? undefined} muted playsInline autoPlay loop={false} onClick={() => setPlaying(p => !p)} />
          <button className="icon-btn trim-play" onClick={() => setPlaying(p => !p)} aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'pause' : 'play'} /></button>
        </div>
        <div className="trim-info">
          <strong>Pick the part to animate</strong>
          <p className="dim small">{need.tip}</p>
          <p className="small">Selected <strong>{fmt(len)}</strong> of {fmt(duration)} · {range ? `${fmt(range.start)} → ${fmt(range.end)}` : '…'}</p>
          <div className="btnrow">
            {[1, 1.5, 2, 3, 5].filter(s => s <= Math.max(1, Math.min(duration, MAX_VIDEO_SECONDS)) + 0.01).map(s => (
              <button key={s} className={Math.abs(len - s) < 0.05 ? 'chip active' : 'chip'} onClick={() => setLength(s)}>{s} s</button>
            ))}
          </div>
          <p className="dim small">Up to {MAX_VIDEO_SECONDS} s at once; shorter imports faster. Drag the handles, or drag the window to move it.</p>
        </div>
      </div>
      <div className="trim-strip" ref={strip}>
        <div className="trim-thumbs">{thumbs.map((t, i) => <img key={i} src={t} alt="" draggable={false} />)}</div>
        {range && duration > 0 && (
          <>
            <div className="trim-shade" style={{ left: 0, width: pct(range.start) }} />
            <div className="trim-shade" style={{ left: pct(range.end), right: 0 }} />
            <div className="trim-win" style={{ left: pct(range.start), width: pct(len) }} onPointerDown={drag('move')} role="slider" aria-label="Selected part" aria-valuenow={range.start} />
            <div className="trim-handle" style={{ left: pct(range.start) }} onPointerDown={drag('start')} role="slider" aria-label="Start" aria-valuenow={range.start} />
            <div className="trim-handle end" style={{ left: pct(range.end) }} onPointerDown={drag('end')} role="slider" aria-label="End" aria-valuenow={range.end} />
            <div className="trim-head" style={{ left: pct(head) }} />
          </>
        )}
      </div>
      <div className="btnrow trim-actions">
        <button className="primary" disabled={!range} onClick={() => range && onConfirm(range)}><Icon name="scissors" /> Use this part</button>
      </div>
    </div>
  );
}
