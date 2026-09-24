import { useState } from 'react';
import { PART_PRESETS, partSlug, rampFor, rawBrief } from '@kinetome/core';
import { api } from '../../api.ts';
import { Icon } from '../../icons.tsx';
import { ColorField } from '../ColorWheel.tsx';
import { ClaudeButton, Field, type TabProps } from './shared.tsx';

export function DesignTab({ projectId, style, design: d, model, update, runClaude, busy, onNext }: TabProps & { onNext: () => void }) {
  const [conflicts, setConflicts] = useState<string[]>([]);
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => update({ ...d, [k]: v });
  const used = new Set(d.parts.map(p => partSlug(p.name)));
  const dupes = d.parts.filter((p, i) => d.parts.findIndex(q => partSlug(q.name) === partSlug(p.name)) !== i);
  const canPolish = !!(d.lore || d.build || d.outfit || d.details || d.description);

  const setPart = (i: number, patch: Partial<(typeof d.parts)[number]>) => set('parts', d.parts.map((p, k) => (k === i ? { ...p, ...patch } : p)));

  return (
    <div className="tab-grid">
      <section className="card">
        <h3>Who is {d.name}?</h3>
        <p className="dim small">Plain words are fine. Claude turns this into a precise visual brief, and the lore steers how moves are animated.</p>
        <Field label="Lore / backstory"><textarea rows={3} value={d.lore} onChange={e => set('lore', e.target.value)} placeholder="An exiled blade dancer from the salt deserts, hunting the knight who burned her village…" /></Field>
        <div className="row2">
          <Field label="Personality" hint="shows in posture"><input value={d.personality} onChange={e => set('personality', e.target.value)} placeholder="calm, precise, a little arrogant" /></Field>
          <Field label="Build" hint="body & proportions"><input value={d.build} onChange={e => set('build', e.target.value)} placeholder="lean, tall, long limbs" /></Field>
        </div>
        <Field label="Outfit & gear"><textarea rows={2} value={d.outfit} onChange={e => set('outfit', e.target.value)} placeholder="long sleeveless coat, wrapped forearms, curved twin blades on her back" /></Field>
        <Field label="Signature details" hint="what makes them recognisable"><input value={d.details} onChange={e => set('details', e.target.value)} placeholder="white braid, scar across left eye, red sash" /></Field>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Colors by part</h3>
          <span className="dim small">each color becomes a 3-shade pixel ramp</span>
        </div>
        <div className="parts">
          {d.parts.map((p, i) => {
            const r = rampFor(p.color);
            return (
              <div key={i} className="part-row">
                <ColorField value={p.color} onChange={c => setPart(i, { color: c })} swatches={style.palette} label={p.name} />
                <input className="part-name" value={p.name} onChange={e => setPart(i, { name: e.target.value })} aria-label="Part name" />
                <span className="mono dim small part-hex" title={`shadow ${r.shadow} · base ${r.base} · light ${r.light}`}>{r.base}</span>
                <button className="icon-btn" onClick={() => set('parts', d.parts.filter((_, k) => k !== i))} aria-label={`Remove ${p.name}`}><Icon name="x" /></button>
              </div>
            );
          })}
        </div>
        {dupes.length > 0 && <div className="issue warn small">Two parts share the name "{dupes[0].name}"; rename one.</div>}
        <div className="chips">
          {PART_PRESETS.filter(p => !used.has(partSlug(p.name))).map(p => (
            <button key={p.name} className="chip" onClick={() => set('parts', [...d.parts, { ...p }])}><Icon name="plus" size={12} /> {p.name}</button>
          ))}
          <button className="chip" onClick={() => set('parts', [...d.parts, { name: `Part ${d.parts.length + 1}`, color: '#8866cc' }])}><Icon name="plus" size={12} /> Custom</button>
        </div>
        <div className="row2 top-gap">
          <Field label="Outline">
            <div className="inline">
              <label className="toggle"><input type="checkbox" checked={!!d.outline} onChange={e => set('outline', e.target.checked ? (style.outline.color ?? '#1a1420') : null)} /> 1px outline</label>
              {d.outline && <ColorField value={d.outline} onChange={c => set('outline', c)} swatches={style.palette} label="Outline" />}
            </div>
          </Field>
          <Field label="Sprite height" hint={`project unit ${style.unitHeight}px`}>
            <input type="number" min={12} max={256} value={d.pixelHeight} onChange={e => set('pixelHeight', Math.max(12, Math.min(256, +e.target.value || 12)))} />
          </Field>
        </div>
      </section>

      <section className="card wide">
        <div className="card-head">
          <h3>Visual brief</h3>
          <span className="dim small">this exact text goes into every prompt</span>
          <div className="spacer" />
          <ClaudeButton
            label={d.description ? 'Improve with Claude' : 'Write with Claude'} busyLabel="Claude is writing…" busy={busy === 'describe'}
            disabled={!canPolish} title={canPolish ? 'Turns the notes above into a short, generator-friendly description (~1-2k tokens)' : 'Fill in some of the notes above first'}
            onClick={() => runClaude('describe', () => api.describe(projectId, d.id, model)).then(r => setConflicts(r?.conflicts ?? []))}
          />
        </div>
        {conflicts.map((c, i) => (
          <div key={i} className="issue warn small">
            <span><strong>Color mismatch:</strong> {c}</span>
            <button className="small" onClick={() => setConflicts(list => list.filter((_, k) => k !== i))}>Dismiss</button>
          </div>
        ))}
        {conflicts.length > 0 && <p className="dim small">Fix the part colors above so the prompt never contradicts itself; Gemini picks randomly between contradictions.</p>}
        <textarea rows={3} value={d.description} onChange={e => set('description', e.target.value)}
          placeholder={rawBrief(d) || 'A short visual description: silhouette, proportions, clothing pieces, hairstyle, signature details.'} />
        <Field label="Reference pose"><input value={d.referencePose} onChange={e => set('referencePose', e.target.value)} /></Field>
        <div className="invariants">
          <div className="card-head">
            <h3>Never changes</h3>
            <span className="dim small">checked by the generator in every frame: missing or special limbs (which side), scars, weapons, asymmetric clothing</span>
          </div>
          {d.invariants.map((rule, i) => (
            <div key={i} className="inv-row">
              <Icon name="check" />
              <input value={rule} onChange={e => set('invariants', d.invariants.map((r, k) => (k === i ? e.target.value : r)))} aria-label={`Rule ${i + 1}`} />
              <button className="icon-btn" onClick={() => set('invariants', d.invariants.filter((_, k) => k !== i))} aria-label="Remove rule"><Icon name="x" /></button>
            </div>
          ))}
          <button className="chip" onClick={() => set('invariants', [...d.invariants, ''])}><Icon name="plus" size={12} /> Add rule</button>
          {!d.invariants.length && <span className="dim small"> e.g. "Left leg is a wooden peg from the knee down; never draw a normal left foot". Claude suggests these when it writes the brief.</span>}
        </div>
        <div className="btnrow end">
          <button className="primary" onClick={onNext}>Next: reference sprite <Icon name="chevronRight" /></button>
        </div>
      </section>
    </div>
  );
}
