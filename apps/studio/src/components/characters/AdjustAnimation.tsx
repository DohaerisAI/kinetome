import { useEffect, useMemo, useState } from 'react';
import type { Animation, MoveDraft, PixelImage, SpriteAsset } from '@kinetome/core';
import { api } from '../../api.ts';
import { Icon } from '../../icons.tsx';
import { unpackFrames } from '../../pixels.ts';
import { AnimPreview } from '../AnimPreview.tsx';
import type { TabProps } from './shared.tsx';

/** Seconds per loop at a game's usual pace, by move: where "Game pace" lands. */
const PACE: Record<string, number> = { run: 0.67, dash: 0.5, walk: 1, idle: 1.4 };

/**
 * Change a saved animation without a new video: speed, direction, frame count. Every save keeps
 * the previous version in the sprite's history, so nothing here is destructive.
 */
export function AdjustAnimation({ projectId, design: d, assets, onAssetsChanged, notify, fail, move: m }: TabProps & { move: MoveDraft }) {
  const asset = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;
  const anim = asset?.animations.find(a => a.name === m.id);
  const [frames, setFrames] = useState<PixelImage[]>([]);
  const [draft, setDraft] = useState<Animation | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(anim ? { ...anim } : null); }, [anim?.name, anim?.fps, anim?.loop, anim?.frames.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  // every frame of the sheet once; the draft only reorders indexes
  useEffect(() => {
    let live = true;
    if (asset) unpackFrames(api.sheetUrl(projectId, asset), asset.frames).then(f => live && setFrames(f), () => {});
    return () => { live = false; };
  }, [projectId, asset?.id, asset?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (draft ? draft.frames.map(i => frames[i]).filter(Boolean) : []), [draft, frames]);
  if (!asset || !anim || !draft) return null;

  const changed = draft.fps !== anim.fps || draft.loop !== anim.loop || draft.frames.join(',') !== anim.frames.join(',');
  const loopSeconds = draft.frames.length / draft.fps;
  const set = (p: Partial<Animation>) => setDraft(x => (x ? { ...x, ...p } : x));
  const pace = PACE[m.id.replace(/-\d+$/, '')];
  const save = async () => {
    setSaving(true);
    try {
      const next: SpriteAsset = { ...asset, animations: asset.animations.map(a => (a.name === anim.name ? draft : a)) };
      await api.updateAsset(projectId, next);
      onAssetsChanged();
      notify(`${m.name}: ${draft.frames.length} frames at ${draft.fps} fps saved (the previous version is in the sprite's history)`);
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  return (
    <section className="card step adjust">
      <div className="card-head">
        <span className="step-n"><Icon name="speed" size={12} /></span>
        <h3>Adjust</h3>
        <span className="dim small">speed and timing of the saved {m.name.toLowerCase()}, no new video needed</span>
      </div>
      <div className="adj">
        <div className="adj-preview">
          {shown.length ? <AnimPreview key={`${draft.fps}-${draft.frames.join(',')}`} frames={shown} fps={draft.fps} width={180} height={180} playing /> : <div className="pz-wait" style={{ width: 180, height: 180 }}>…</div>}
          <span className="dim small">{draft.frames.length} frames · {draft.fps} fps · {loopSeconds.toFixed(2)} s per loop</span>
        </div>
        <div className="adj-controls">
          <label className="field"><span>Speed · {draft.fps} fps{pace ? ` (game pace ≈ ${Math.round(draft.frames.length / pace)} fps)` : ''}</span>
            <input type="range" min={2} max={30} value={draft.fps} onChange={e => set({ fps: +e.target.value })} aria-label="Frames per second" />
          </label>
          <div className="btnrow">
            <button onClick={() => set({ fps: Math.max(2, Math.round(draft.fps * 0.8)) })}><Icon name="minus" /> Slower</button>
            <button onClick={() => set({ fps: Math.min(30, Math.round(draft.fps * 1.25)) })}><Icon name="plus" /> Faster</button>
            {pace && <button onClick={() => set({ fps: Math.max(2, Math.min(30, Math.round(draft.frames.length / pace))) })}><Icon name="target" /> Game pace</button>}
          </div>
          <div className="btnrow">
            <button onClick={() => set({ frames: [...draft.frames].reverse() })} title="Play backwards"><Icon name="swap" /> Reverse</button>
            <button onClick={() => set({ frames: [...draft.frames, ...draft.frames.slice(1, -1).reverse()] })} title="Forwards then backwards (good for idles and hovers)"><Icon name="pingpong" /> Ping-pong</button>
            <button disabled={draft.frames.length < 6} onClick={() => set({ frames: draft.frames.filter((_, i) => i % 2 === 0), fps: Math.max(2, Math.round(draft.fps / 2)) })} title="Half the frames, half the fps: same speed, snappier, more retro"><Icon name="scissors" /> Thin to half</button>
            <button onClick={() => set({ frames: draft.frames.flatMap(f => [f, f]), fps: Math.min(30, draft.fps * 2) })} title="Each frame twice at double fps: same look, smoother speed control"><Icon name="duplicate" /> Hold ×2</button>
            <label className="toggle"><input type="checkbox" checked={draft.loop} onChange={e => set({ loop: e.target.checked })} /> Loop</label>
          </div>
          <div className="btnrow">
            <button className="primary" disabled={!changed || saving} onClick={() => void save()}><Icon name="save" /> {saving ? 'Saving…' : 'Save'}</button>
            <button className="ghost" disabled={!changed || saving} onClick={() => setDraft({ ...anim })}><Icon name="undo" /> Reset</button>
            <span className="dim small">Need a different size, colours or loop point? Re-cut a clip above.</span>
          </div>
        </div>
      </div>
    </section>
  );
}
