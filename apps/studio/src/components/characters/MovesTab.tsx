import { useEffect, useState } from 'react';
import { designMovePrompt, newMove, PLATFORMER_MOVES, slugify, type MoveDraft } from '@sprite/core';
import { api } from '../../api.ts';
import { Icon } from '../../icons.tsx';
import { ClaudeButton, CopyButton, Field, GeminiSteps, PromptBox, type TabProps } from './shared.tsx';

const WEIGHTS: MoveDraft['weight'][] = ['light', 'normal', 'heavy'];

export function MovesTab(props: TabProps) {
  const { design: d, update, assets } = props;
  const [sel, setSel] = useState<string | null>(d.moves[0]?.id ?? null);
  const [adding, setAdding] = useState('');
  useEffect(() => { if (!d.moves.some(m => m.id === sel)) setSel(d.moves[0]?.id ?? null); }, [d.moves, sel]);

  const linked = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;
  const has = new Set(linked?.animations.map(a => a.name) ?? []);
  const move = d.moves.find(m => m.id === sel) ?? null;

  const add = (presetId: string) => {
    if (!presetId) return;
    let m = presetId === 'custom' ? newMove(null, 'New move') : newMove(presetId);
    let n = 2;
    while (d.moves.some(x => x.id === m.id)) m = { ...m, id: `${slugify(m.name)}-${n}`, name: `${m.name} ${n++}` };
    update({ ...d, moves: [...d.moves, m] });
    setSel(m.id);
    setAdding('');
  };

  return (
    <div className="moves">
      <aside className="moves-list">
        {d.moves.map(m => (
          <button key={m.id} className={m.id === sel ? 'move-row active' : 'move-row'} onClick={() => setSel(m.id)}>
            <span className="move-name">{m.name}</span>
            <span className="dim small">{m.frames}f · {m.fps}fps</span>
            {has.has(m.id) ? <span className="badge ok" title="Imported into the library">✓</span> : m.poses.length === m.frames ? <span className="badge" title="Poses ready">ready</span> : null}
          </button>
        ))}
        <select value={adding} onChange={e => add(e.target.value)} aria-label="Add a move" className="move-add">
          <option value="">+ Add a move…</option>
          {PLATFORMER_MOVES.filter(p => !d.moves.some(m => m.id === p.id)).map(p => <option key={p.id} value={p.id}>{p.name} ({p.frames} frames)</option>)}
          <option value="custom">Custom move…</option>
        </select>
      </aside>
      {move ? <MoveEditor key={move.id} {...props} move={move} imported={has.has(move.id)} /> : <div className="dim pad">Add a move to start.</div>}
    </div>
  );
}

function MoveEditor({ projectId, style, design: d, assets, model, update, runClaude, busy, importFor, move: m, imported }: TabProps & { move: MoveDraft; imported: boolean }) {
  const [instruction, setInstruction] = useState('');
  const [nameDraft, setNameDraft] = useState(m.name);
  const setMove = (patch: Partial<MoveDraft>) => update({ ...d, moves: d.moves.map(x => (x.id === m.id ? { ...x, ...patch } : x)) });
  const linked = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;
  const posesReady = m.poses.length === m.frames && m.poses.every(p => p.trim());
  const prompt = designMovePrompt(style, d, m);

  const setFrames = (n: number) => {
    const frames = Math.max(1, Math.min(24, n || 1));
    const poses = m.poses.slice(0, frames);
    while (poses.length < frames && m.poses.length) poses.push('');
    setMove({ frames, poses });
  };

  const commitName = () => {
    const name = nameDraft.trim() || m.name;
    const id = slugify(name);
    if (id !== m.id && d.moves.some(x => x.id === id)) { setNameDraft(m.name); return; }
    update({ ...d, moves: d.moves.map(x => (x.id === m.id ? { ...x, name, id } : x)) });
  };

  const draft = (withInstruction: boolean) => runClaude('move', () => api.draftMove(projectId, d.id, m.id, model, withInstruction ? instruction : undefined))
    .then(r => { if (r && withInstruction) setInstruction(''); });

  return (
    <div className="move-editor">
      <section className="card">
        <div className="card-head">
          <input className="title-input small" value={nameDraft} onChange={e => setNameDraft(e.target.value)} onBlur={commitName} aria-label="Move name" />
          <span className="mono dim small" title="Animation name in the library and in Godot">anim: {m.id}</span>
          <div className="spacer" />
          <button className="icon-btn" onClick={() => update({ ...d, moves: d.moves.filter(x => x.id !== m.id) })} title="Remove move" aria-label="Remove move"><Icon name="trash" /></button>
        </div>
        <Field label={`How does ${d.name} do it?`} hint="lore, weapon, style, feeling">
          <textarea rows={3} value={m.description} onChange={e => setMove({ description: e.target.value })}
            placeholder={m.id === 'attack' ? 'Draws both blades in one motion, spins once and slashes upward; leaves a red arc from her sash' : 'Describe the motion in your own words'} />
        </Field>
        <div className="move-params">
          <Field label="Frames"><input type="number" min={1} max={24} value={m.frames} onChange={e => setFrames(+e.target.value)} /></Field>
          <Field label="FPS"><input type="number" min={1} max={60} value={m.fps} onChange={e => setMove({ fps: Math.max(1, Math.min(60, +e.target.value || 1)) })} /></Field>
          <Field label="Weight">
            <div className="seg compact" role="radiogroup">
              {WEIGHTS.map(w => <button key={w} role="radio" aria-checked={m.weight === w} className={m.weight === w ? 'active' : ''} onClick={() => setMove({ weight: w })}>{w}</button>)}
            </div>
          </Field>
          <Field label="Playback"><label className="toggle"><input type="checkbox" checked={m.loop} onChange={e => setMove({ loop: e.target.checked })} /> <Icon name="loop" /> loop</label></Field>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Frames</h3>
          <span className="dim small">one pose per frame; edit freely</span>
          <div className="spacer" />
          <ClaudeButton label={m.poses.some(p => p.trim()) ? 'Redraft with Claude' : 'Draft with Claude'} busyLabel="Claude is choreographing…" busy={busy === 'move'} onClick={() => draft(false)}
            title="Claude breaks the move into key poses from your description (~1-2k tokens)" />
        </div>
        {m.poses.length ? (
          <ol className="poses">
            {Array.from({ length: m.frames }, (_, i) => (
              <li key={i}>
                <span className="pose-n">{i + 1}</span>
                <textarea rows={2} value={m.poses[i] ?? ''} onChange={e => { const poses = [...m.poses]; while (poses.length < m.frames) poses.push(''); poses[i] = e.target.value; setMove({ poses }); }} aria-label={`Frame ${i + 1} pose`} />
              </li>
            ))}
          </ol>
        ) : <p className="dim">No poses yet. Describe the move above and let Claude draft them, or <button className="linklike" onClick={() => setMove({ poses: Array.from({ length: m.frames }, () => '') })}>write them yourself</button>.</p>}
        {m.poses.length > 0 && (
          <form className="revise" onSubmit={e => { e.preventDefault(); if (instruction.trim()) void draft(true); }}>
            <input value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="Ask for changes, e.g. longer wind-up, add a dust burst on the landing frame" aria-label="Revision request" />
            <ClaudeButton label="Revise" busyLabel="Revising…" busy={busy === 'move'} disabled={!instruction.trim()} onClick={() => void draft(true)} icon="wand" />
          </form>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Generate in Gemini</h3>
          {!posesReady && <span className="badge warn">fill all {m.frames} poses first</span>}
          {imported && <span className="badge ok">in library</span>}
        </div>
        <GeminiSteps withReference />
        <div className="btnrow">
          <CopyButton text={prompt} />
          <button onClick={() => importFor({ assetId: linked?.id ?? null, anim: m.id })}><Icon name="upload" /> {imported ? 'Re-import (replaces)…' : 'Import result…'}</button>
        </div>
        {!linked && <p className="issue info small">No reference sprite in the library yet. Import one first (Reference tab) so this move merges into the same character.</p>}
        <PromptBox text={prompt} />
      </section>
    </div>
  );
}
