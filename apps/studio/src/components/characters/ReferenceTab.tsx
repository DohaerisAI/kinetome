import { designPalette, designReferencePrompt } from '@sprite/core';
import { api } from '../../api.ts';
import { Icon } from '../../icons.tsx';
import { useImage } from '../../pixels.ts';
import { FrameThumb } from '../FrameThumb.tsx';
import { CopyButton, GeminiSteps, PromptBox, type TabProps } from './shared.tsx';

export function ReferenceTab({ projectId, style, design: d, assets, importFor }: TabProps) {
  const prompt = designReferencePrompt(style, d);
  const linked = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;
  const img = useImage(linked ? api.sheetUrl(projectId, linked) : null);
  const palette = designPalette(d);

  return (
    <div className="tab-grid">
      <section className="card wide hero-card">
        <div className="hero-text">
          <h3>The reference sprite</h3>
          <p>One master image of {d.name} in your game's pixel style. Every animation is drawn from it, so regenerate in Gemini until you truly love it.</p>
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
      <section className="card wide">
        <PromptBox text={prompt} />
        <p className="dim small">Have an anime drawing, a photo or a sketch you like? Attach it in Gemini together with this prompt and add "based on the attached image". Gemini will translate it into your pixel style; use the pixel result as the reference, never the original.</p>
      </section>
    </div>
  );
}
