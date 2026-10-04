import { useEffect, useState } from 'react';
import type { PixelImage, SpriteAsset, StyleBible } from '@kinetome/core';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { unpackFrames } from '../pixels.ts';
import { AnimPreview } from './AnimPreview.tsx';
import { EffectMaker } from './EffectsDialog.tsx';
import { PageHeader } from './PageHeader.tsx';
import { CopyButton } from './characters/shared.tsx';

/** A Veo/Gemini prompt for an effect clip; the key colour is removed on import. */
const effectPrompt = (what: string) => [
  `Pixel art game visual effect: ${what.trim() || 'a burst of magic sparks'}.`,
  'Side view, centred in the frame, the effect stays in place and does not travel across the frame.',
  'Locked static camera, flat solid bright green (#00FF00) background with no glow or light cast on it, no ground, no shadow, no characters, no text.',
  'Crisp pixel art, bold readable shapes, a limited palette, one complete effect from start to finish.',
].join(' ');

/**
 * Everything effects: make one from code (instant, free), turn a video into one, and see the
 * project's effects playing side by side.
 */
export function EffectsView({ projectId, style, assets, extraColors, onCreated, onOpen, onImportVideo, fail }: {
  projectId: string; style: StyleBible; assets: SpriteAsset[]; extraColors: string[];
  onCreated: (a: SpriteAsset) => void; onOpen: (id: string) => void; onImportVideo: () => void; fail: (e: unknown) => void;
}) {
  const fx = assets.filter(a => a.kind === 'fx');
  const [what, setWhat] = useState('');
  return (
    <main className="page effects-page">
      <PageHeader icon="sparkle" title="Effects" sub="Slashes, dust, sparks, magic: drawn from code in your palette, or made from a video. Saved effects play in the Playtest and export with your sprites.">
        <button onClick={onImportVideo}><Icon name="film" /> Effect from video…</button>
      </PageHeader>

      <section className="card fx-card">
        <div className="card-head"><h3>Make an effect</h3><span className="dim small">instant and free · every variation is new</span></div>
        <EffectMaker projectId={projectId} style={style} extraColors={extraColors} onCreated={onCreated} fail={fail} />
      </section>

      <section className="card fx-card">
        <div className="card-head"><h3>From a video</h3><span className="dim small">fire, explosions, spells: anything code can't draw</span></div>
        <div className="fx-video">
          <label className="field"><span>Describe the effect</span>
            <input value={what} onChange={e => setWhat(e.target.value)} placeholder="e.g. a swirling purple vortex that bursts into sparks" />
          </label>
          <ol className="vr-steps">
            <li>In the Gemini app (Video) or any video model, paste this prompt. <div className="btnrow"><CopyButton text={effectPrompt(what)} label="Copy prompt" /></div></li>
            <li>Download the clip and bring it in: Kinetome removes the green, finds the frames and makes it pixel art.
              <div className="btnrow"><button className="primary" onClick={onImportVideo}><Icon name="upload" /> Import effect video…</button></div>
            </li>
          </ol>
        </div>
      </section>

      <section className="card fx-card">
        <div className="card-head"><h3>Your effects</h3><span className="dim small">{fx.length ? `${fx.length} in the library` : 'none yet'}</span></div>
        {fx.length ? (
          <div className="fx-grid">{fx.map(a => <FxTile key={a.id} projectId={projectId} asset={a} onOpen={() => onOpen(a.id)} />)}</div>
        ) : <p className="dim small">Effects you make or import show up here, playing.</p>}
      </section>
    </main>
  );
}

function FxTile({ projectId, asset, onOpen }: { projectId: string; asset: SpriteAsset; onOpen: () => void }) {
  const [frames, setFrames] = useState<PixelImage[]>([]);
  const anim = asset.animations[0];
  useEffect(() => {
    let live = true;
    if (anim) unpackFrames(api.sheetUrl(projectId, asset), anim.frames.map(i => asset.frames[i]).filter(Boolean)).then(f => live && setFrames(f), () => {});
    return () => { live = false; };
  }, [projectId, asset.id, asset.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    // a div, not a button: the preview inside has its own play button
    <div className="fx-tile" role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }} title="Open in the library">
      {frames.length ? <AnimPreview frames={frames} fps={anim?.fps ?? 12} width={120} height={120} playing /> : <div className="pz-wait" style={{ width: 120, height: 120 }} />}
      <strong>{asset.name}</strong>
      <span className="dim small">{anim ? `${anim.frames.length}f · ${anim.fps} fps` : 'no animation'}</span>
    </div>
  );
}
