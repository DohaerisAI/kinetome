import { useEffect, useState } from 'react';
import {
  animationPrompt, PLATFORMER_MOVES, PROMPT_KIT_STEPS, referencePrompt,
  type CharacterBrief, type SpriteAsset, type StyleBible,
} from '@sprite/core';
import { api } from '../api.ts';
import { useImage } from '../pixels.ts';
import { FrameThumb } from './FrameThumb.tsx';
import { BRIEF_KEY } from './PixelizeDialog.tsx';

interface Props {
  projectId: string;
  style: StyleBible;
  assets: SpriteAsset[];
  onSaveAsset: (a: SpriteAsset) => Promise<void>;
  /** Open the file picker; results go straight into this character (null = new asset). */
  onImportFor: (assetId: string | null, anim?: string | null) => void;
}

function readBrief(pid: string): CharacterBrief {
  try { return { name: '', description: '', ...JSON.parse(localStorage.getItem(BRIEF_KEY(pid)) ?? '{}') }; }
  catch { return { name: '', description: '' }; }
}

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); return ok;
  }
}

function PromptCard({ title, meta, prompt, children, action }: { title: string; meta?: string; prompt: string; children?: React.ReactNode; action?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <div className="pk-card">
      <div className="pk-card-head">
        <strong>{title}</strong>
        {meta && <span className="dim small">{meta}</span>}
        <div className="spacer" />
        <button className={copied ? 'ok' : 'primary'} onClick={async () => { if (await copy(prompt)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>
          {copied ? 'Copied ✓' : 'Copy prompt'}
        </button>
        {action}
      </div>
      {children}
      <button className="ghost small" onClick={() => setOpen(o => !o)}>{open ? 'Hide prompt' : 'Show prompt'}</button>
      {open && <pre className="pk-prompt">{prompt}</pre>}
    </div>
  );
}

function CharacterChip({ projectId, asset, active, onClick }: { projectId: string; asset: SpriteAsset; active: boolean; onClick: () => void }) {
  const img = useImage(api.sheetUrl(projectId, asset));
  return (
    <button className={active ? 'pk-char active' : 'pk-char'} onClick={onClick}>
      <FrameThumb img={img} rect={asset.frames[asset.animations[0]?.frames[0] ?? 0]} size={36} />
      <span>{asset.name}</span>
    </button>
  );
}

/**
 * Turns the Style Bible + a character description into prompts for any image generator,
 * laid out so the results import cleanly (one row of poses, chroma green, no text).
 */
export function PromptKitView({ projectId, style, assets, onSaveAsset, onImportFor }: Props) {
  const chars = assets.filter(a => a.kind === 'character');
  const [sel, setSel] = useState<string>('new');
  const [brief, setBrief] = useState<CharacterBrief>(() => readBrief(projectId));
  const asset = chars.find(a => a.id === sel) ?? null;
  const [desc, setDesc] = useState('');

  useEffect(() => { setBrief(readBrief(projectId)); setSel('new'); }, [projectId]);
  useEffect(() => { setDesc(asset?.description ?? ''); }, [asset?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveBrief = (b: CharacterBrief) => {
    setBrief(b);
    try { localStorage.setItem(BRIEF_KEY(projectId), JSON.stringify(b)); } catch { /* storage unavailable */ }
  };

  const character: CharacterBrief = asset ? { name: asset.name, description: desc } : brief;
  const has = new Set(asset?.animations.map(a => a.name) ?? []);

  return (
    <main className="promptkit">
      <aside className="pk-side">
        <h3>Character</h3>
        <button className={sel === 'new' ? 'pk-char active' : 'pk-char'} onClick={() => setSel('new')}><span className="pk-plus">+</span><span>New character</span></button>
        {chars.map(a => <CharacterChip key={a.id} projectId={projectId} asset={a} active={a.id === sel} onClick={() => setSel(a.id)} />)}

        <h3>How it works</h3>
        <ol className="pk-steps">{PROMPT_KIT_STEPS.map((s, i) => <li key={i}>{s}</li>)}</ol>
        <p className="dim small">Prompts include your Style Bible (palette, {style.unitHeight}px unit height, outline, light, perspective) and ask for a flat green backdrop, which the importer removes perfectly.</p>
      </aside>

      <section className="pk-main">
        <div className="card">
          <h3>{asset ? `Describe ${asset.name}` : 'Describe the new character'}</h3>
          {!asset && (
            <label className="field"><span>Name</span>
              <input value={brief.name} placeholder="e.g. Mira" onChange={e => saveBrief({ ...brief, name: e.target.value })} />
            </label>
          )}
          <label className="field"><span>Appearance: body, clothes, colors, signature details. Be specific; this is repeated in every prompt.</span>
            <textarea rows={3} value={asset ? desc : brief.description}
              placeholder="e.g. a small fox knight in dented silver armor, long red scarf, round wooden shield on the left arm, short sword in the right hand, big amber eyes"
              onChange={e => (asset ? setDesc(e.target.value) : saveBrief({ ...brief, description: e.target.value }))}
              onBlur={() => { if (asset && desc !== asset.description) onSaveAsset({ ...asset, description: desc }); }} />
          </label>
        </div>

        <PromptCard
          title="1 · Reference design"
          meta="generate first; regenerate until you love it"
          prompt={referencePrompt(style, character)}
          action={!asset ? <button onClick={() => onImportFor(null)}>Import reference…</button> : undefined}
        >
          <p className="dim small">Import the image you pick as a new character (it becomes its idle pose). Then attach that same image to every animation prompt below.</p>
        </PromptCard>

        <h3 className="pk-section">2 · Animations {asset ? `for ${asset.name}` : ''}</h3>
        {!asset && <p className="dim small">Tip: import the reference first, then select the character on the left so results go straight into it.</p>}
        <div className="pk-grid">
          {PLATFORMER_MOVES.map(m => (
            <PromptCard
              key={m.id}
              title={m.name}
              meta={`${m.frames} frames · ${m.fps} fps${m.loop ? ' · loop' : ''}${has.has(m.id) ? ' · ✓ has it' : ''}`}
              prompt={animationPrompt(style, character, m)}
              action={asset ? <button onClick={() => onImportFor(asset.id, m.id)} title={`Import the generated sheet into ${asset.name} as "${m.id}"`}>Import…</button> : undefined}
            >
              <ol className="pk-poses">{m.poses.map((p, i) => <li key={i}>{p}</li>)}</ol>
            </PromptCard>
          ))}
        </div>
      </section>
    </main>
  );
}
