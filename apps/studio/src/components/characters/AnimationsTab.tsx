import { useEffect, useMemo, useRef, useState } from 'react';
import { designMovePrompt, designPalette, designProfilePrompt, hexToRgb, layoutFor, newMove, PLATFORMER_MOVES, slugify, usesProfile, videoKeyFor, videoMovePrompt, type MoveDraft, type PixelImage } from '@kinetome/core';
import { estimateBackground, keepMainFigure, removeBackground, videoFirstFrame } from '@kinetome/pixel';
import { api, type CodeEvent, type Packed, type Usage } from '../../api.ts';
import { Icon } from '../../icons.tsx';
import { Orb } from '../Orb.tsx';
import { ProgramHistory } from './ProgramHistory.tsx';
import { mergeIntoAsset } from '../../merge.ts';
import { canvasToPng, download, loadImage, pixelsToCanvas, toPixels, unpackFrames, useImage } from '../../pixels.ts';
import { AnimPreview } from '../AnimPreview.tsx';
import { FrameThumb } from '../FrameThumb.tsx';
import { ClaudeButton, CopyButton, Field, PromptBox, usageText, type TabProps } from './shared.tsx';

const WEIGHTS: MoveDraft['weight'][] = ['light', 'normal', 'heavy'];
const ZERO: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, ms: 0 };
const add = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, costUsd: a.costUsd + b.costUsd, ms: a.ms + b.ms });

/**
 * One place per move: describe it, let Claude choreograph it, optionally add Gemini pose
 * references, then let Claude animate it with code (on the character's own reference art).
 */
export function AnimationsTab(props: TabProps) {
  const { projectId, design: d, update, assets } = props;
  const [sel, setSel] = useState<string | null>(d.moves[0]?.id ?? null);
  const [program, setProgram] = useState<{ packed: Packed | null; error: string | null }>({ packed: null, error: null });
  useEffect(() => { if (!d.moves.some(m => m.id === sel)) setSel(d.moves[0]?.id ?? null); }, [d.moves, sel]);

  // what the character's current sprite program renders (shared by every move)
  const loadProgram = () => {
    if (!d.code && !Object.keys(d.programs).length) { setProgram({ packed: null, error: null }); return; }
    api.renderCode(projectId, d.id).then(r => setProgram(r.ok ? { packed: r.packed, error: null } : { packed: null, error: r.error }), () => {});
  };
  useEffect(loadProgram, [projectId, d.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const linked = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;
  const inLibrary = new Set(linked?.animations.map(a => a.name) ?? []);
  const inProgram = new Set(program.packed?.animations.map(a => a.name) ?? []);
  const move = d.moves.find(m => m.id === sel) ?? null;

  const addMove = (presetId: string) => {
    if (!presetId) return;
    let m = presetId === 'custom' ? newMove(null, 'New move') : newMove(presetId);
    let n = 2;
    while (d.moves.some(x => x.id === m.id)) m = { ...m, id: `${slugify(m.name)}-${n}`, name: `${m.name} ${n++}` };
    update({ ...d, moves: [...d.moves, m] });
    setSel(m.id);
  };

  return (
    <div className="moves">
      <aside className="moves-list">
        {d.moves.map(m => (
          <button key={m.id} className={m.id === sel ? 'move-row active' : 'move-row'} onClick={() => setSel(m.id)}>
            <span className="move-name">{m.name}</span>
            <span className="dim small">{m.frames}f</span>
            {inLibrary.has(m.id) ? <span className="badge ok" title="Saved in the library">saved</span>
              : inProgram.has(m.id) ? <span className="badge warn" title="Animated, not saved yet">unsaved</span>
                : m.poses.length === m.frames && m.poses.every(p => p.trim()) ? <span className="badge" title="Poses ready">poses</span> : null}
          </button>
        ))}
        <select value="" onChange={e => addMove(e.target.value)} aria-label="Add a move" className="move-add">
          <option value="">+ Add a move…</option>
          {PLATFORMER_MOVES.filter(p => !d.moves.some(m => m.id === p.id)).map(p => <option key={p.id} value={p.id}>{p.name} ({p.frames} frames)</option>)}
          <option value="custom">Custom move…</option>
        </select>
        {!linked && <p className="issue info small">Import a reference sprite first (Reference tab): Claude animates your real art.</p>}
      </aside>
      {move
        ? <MoveEditor key={move.id} {...props} move={move} program={program.packed} programError={program.error} onProgram={setProgram} savedInLibrary={inLibrary.has(move.id)} />
        : <div className="dim pad">Add a move to start.</div>}
    </div>
  );
}

interface EditorProps extends TabProps {
  move: MoveDraft;
  program: Packed | null;
  programError: string | null;
  onProgram: (p: { packed: Packed | null; error: string | null }) => void;
  savedInLibrary: boolean;
}

function Step({ n, title, hint, right, children, done }: { n: number; title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode; done?: boolean }) {
  return (
    <section className="card step">
      <div className="card-head">
        <span className={done ? 'step-n done' : 'step-n'}>{done ? <Icon name="check" size={12} /> : n}</span>
        <h3>{title}</h3>
        {hint && <span className="dim small">{hint}</span>}
        <div className="spacer" />
        {right}
      </div>
      {children}
    </section>
  );
}

function MoveEditor(props: EditorProps) {
  const { projectId, style, design: d, model, update, runClaude, busy, importFor, move: m } = props;
  const [nameDraft, setNameDraft] = useState(m.name);
  const [instruction, setInstruction] = useState('');
  const [showRefs, setShowRefs] = useState(m.refImages.length > 0);
  const setMove = (patch: Partial<MoveDraft>) => update({ ...d, moves: d.moves.map(x => (x.id === m.id ? { ...x, ...patch } : x)) });
  const posesReady = m.poses.length === m.frames && m.poses.every(p => p.trim());
  const grid = layoutFor(m.frames);
  const refInput = useRef<HTMLInputElement>(null);

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

  const uploadRefs = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      let latest = d;
      for (const f of [...files]) latest = await api.uploadMoveRef(projectId, d.id, m.id, f);
      update(latest);
    } catch (e) { props.fail(e); }
  };
  /** Removes the move AND its animation program (the old code stays in the program history). */
  const removeMove = () => {
    const had = !!d.programs[m.id];
    if (!confirm(`Remove the move “${m.name}”${had ? ' and its animation' : ''}? The library sprite keeps any saved copy.`)) return;
    const before = d;
    const programs = { ...d.programs };
    delete programs[m.id];
    update({ ...d, moves: d.moves.filter(x => x.id !== m.id), programs });
    props.notify(`Removed ${m.name}`, { label: 'Undo', run: () => update(before) });
  };

  const removeRef = async (file: string) => {
    try { update(await api.deleteMoveRef(projectId, d.id, m.id, file)); } catch (e) { props.fail(e); }
  };

  return (
    <div className="move-editor">
      <Step n={1} title="Describe" done={!!m.description.trim()}
        right={<button className="icon-btn" onClick={removeMove} title="Remove move" aria-label="Remove move"><Icon name="trash" /></button>}>
        <div className="move-title">
          <input className="title-input small" value={nameDraft} onChange={e => setNameDraft(e.target.value)} onBlur={commitName} aria-label="Move name" />
          <span className="mono dim small" title="Animation name in the library and in Godot">anim: {m.id}</span>
        </div>
        <Field label={`How does ${d.name} do it?`} hint="lore, style, which limbs, feeling">
          <textarea rows={3} value={m.description} onChange={e => setMove({ description: e.target.value })}
            placeholder="e.g. Sinks on his good leg, swings the wooden peg up behind him and stomps it down with full force" />
        </Field>
        <Field label="Effects" hint="particles, trails, impacts">
          <input value={m.effects} onChange={e => setMove({ effects: e.target.value })} placeholder="e.g. leaf tornado that withers green to brown, shockwave, dust, impact flash" />
        </Field>
        <div className="move-params">
          <Field label="Frames" hint="more = smoother"><input type="number" min={1} max={24} value={m.frames} onChange={e => setFrames(+e.target.value)} /></Field>
          <Field label="FPS"><input type="number" min={1} max={60} value={m.fps} onChange={e => setMove({ fps: Math.max(1, Math.min(60, +e.target.value || 1)) })} /></Field>
          <Field label="Weight">
            <div className="seg compact" role="radiogroup">
              {WEIGHTS.map(w => <button key={w} role="radio" aria-checked={m.weight === w} className={m.weight === w ? 'active' : ''} onClick={() => setMove({ weight: w })}>{w}</button>)}
            </div>
          </Field>
          <Field label="Playback"><label className="toggle"><input type="checkbox" checked={m.loop} onChange={e => setMove({ loop: e.target.checked })} /> <Icon name="loop" /> loop</label></Field>
        </div>
      </Step>

      <Step n={2} title="Poses" hint="Claude choreographs it with the lore; edit freely" done={posesReady}
        right={<ClaudeButton label={m.poses.some(p => p.trim()) ? 'Redraft' : 'Draft with Claude'} busyLabel="Choreographing…" busy={busy === 'move'} onClick={() => draft(false)} title="~2-4k tokens" />}>
        {(m.notes || m.poses.length > 0) && (
          <Field label="Direction for this character" hint="how their body & story shape the move">
            <textarea rows={2} value={m.notes} onChange={e => setMove({ notes: e.target.value })} />
          </Field>
        )}
        {m.poses.length ? (
          <ol className="poses">
            {Array.from({ length: m.frames }, (_, i) => (
              <li key={i}>
                <span className="pose-n">{i + 1}</span>
                <textarea rows={2} value={m.poses[i] ?? ''} aria-label={`Frame ${i + 1} pose`}
                  onChange={e => { const poses = [...m.poses]; while (poses.length < m.frames) poses.push(''); poses[i] = e.target.value; setMove({ poses }); }} />
              </li>
            ))}
          </ol>
        ) : <p className="dim small">Describe the move, then let Claude draft the poses, or <button className="linklike" onClick={() => setMove({ poses: Array.from({ length: m.frames }, () => '') })}>write them yourself</button>.</p>}
        {m.poses.length > 0 && (
          <form className="revise" onSubmit={e => { e.preventDefault(); if (instruction.trim()) void draft(true); }}>
            <input value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="Ask for changes: longer wind-up, bigger stomp, add a spin…" aria-label="Revision request" />
            <ClaudeButton label="Revise" busyLabel="Revising…" busy={busy === 'move'} disabled={!instruction.trim()} onClick={() => void draft(true)} icon="wand" />
          </form>
        )}
      </Step>

      <Step n={3} title="Pose references" hint="optional · rough key poses from Gemini guide Claude" done={m.refImages.length > 0}
        right={<button className="ghost small" onClick={() => setShowRefs(s => !s)} aria-expanded={showRefs}><Icon name={showRefs ? 'chevronDown' : 'chevronRight'} /> {showRefs ? 'Hide' : 'Show'}</button>}>
        {showRefs ? (
          <>
            <p className="dim small">Gemini's frames don't need to be perfect: Claude uses them for poses, silhouettes and staging, while the final art always comes from {d.name}'s reference sprite. Attach the reference in Gemini with this prompt ({grid.rows > 1 ? `${grid.rows}×${grid.cols} grid` : `${m.frames} in a row`}).</p>
            <div className="btnrow">
              <CopyButton text={designMovePrompt(style, d, m)} label="Copy Gemini prompt" primary={false} />
              <button onClick={() => refInput.current?.click()}><Icon name="upload" /> Add images…</button>
              <input ref={refInput} type="file" accept="image/*" multiple hidden onChange={e => { void uploadRefs(e.target.files); e.target.value = ''; }} />
            </div>
            {m.refImages.length > 0 && (
              <div className="ref-grid">
                {m.refImages.map(f => (
                  <figure key={f} className="ref-img">
                    <img src={api.moveRefUrl(projectId, d.id, m.id, f)} alt="Pose reference" />
                    <button className="icon-btn" onClick={() => removeRef(f)} aria-label="Remove reference"><Icon name="x" /></button>
                  </figure>
                ))}
              </div>
            )}
            <PromptBox text={designMovePrompt(style, d, m)} />
          </>
        ) : <p className="dim small">{m.refImages.length ? `${m.refImages.length} image${m.refImages.length > 1 ? 's' : ''} attached.` : 'Skip this unless Claude keeps misreading the motion.'}</p>}
      </Step>

      <VideoRoute {...props} />

      <AnimateStep {...props} posesReady={posesReady} />

      <p className="dim small alt-route">Prefer a finished Gemini sprite sheet for this move? <button className="linklike" onClick={() => importFor({ assetId: d.assetId, anim: m.id })}>Import a sheet instead</button>.</p>
    </div>
  );
}

function AnimateStep({ projectId, design: d, assets, model, update, notify, fail, onAssetsChanged, move: m, program, programError, onProgram, savedInLibrary, posesReady }: EditorProps & { posesReady: boolean }) {
  const linked = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;
  const refImg = useImage(linked ? api.sheetUrl(projectId, linked) : null);
  const inProgram = !!program?.animations.some(a => a.name === m.id);
  const [rounds, setRounds] = useState(1);
  const [feedback, setFeedback] = useState('');
  const hasProgram = !!d.code || Object.keys(d.programs).length > 0;
  const [useReference, setUseReference] = useState(hasProgram ? d.codeRig : !!linked);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ i: number; total: number } | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [iters, setIters] = useState<Extract<CodeEvent, { type: 'iteration' }>[]>([]);
  const [runUsage, setRunUsage] = useState<Usage>(ZERO);
  const [saving, setSaving] = useState(false);
  const [frames, setFrames] = useState<PixelImage[]>([]);
  const [showIters, setShowIters] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // this move's frames out of the program render
  useEffect(() => {
    let live = true;
    const a = program?.animations.find(x => x.name === m.id);
    if (!program || !a) { setFrames([]); return; }
    unpackFrames(program.sheet, a.frames.map(i => program.rects[i])).then(f => live && setFrames(f), () => {});
    return () => { live = false; };
  }, [program, m.id]);

  const estimate = useMemo(() => {
    // measured on real runs: ~2.5k output tokens per frame for a new animation, ~10k to revise one
    // standalone animation program, ~0.17 min per 1k output tokens
    const out = Math.round((inProgram ? 10 : 2.5 * m.frames + 4) + 10 * rounds);
    return `~${out}k output tokens · ~${Math.max(1, Math.round(out * 0.17))} min`;
  }, [inProgram, m.frames, rounds]);

  const run = async (mode: 'auto' | 'remake' | 'refine') => {
    setRunning(true); setStatus('Starting…'); setIters([]); setRunUsage(ZERO); setStartedAt(Date.now()); setNow(Date.now()); setShowIters(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      await api.animate(projectId, d.id, { model, move: m.id, mode, rounds, feedback: feedback.trim() || undefined, useReference }, e => {
        if (e.type === 'status') { setStatus(e.message); setProgress({ i: e.iteration, total: e.total }); }
        else if (e.type === 'iteration') {
          setIters(list => [...list, e]);
          setRunUsage(u => add(u, e.usage));
          if (e.packed) onProgram({ packed: e.packed, error: null });
        } else if (e.type === 'done') {
          if (e.design) update(e.design);
          if (e.packed) onProgram({ packed: e.packed, error: null });
          notify(e.ok ? `${m.name} animated · ${usageText(e.usage)}` : 'Claude could not produce a working program; see the rounds below');
          if (e.ok) setFeedback('');
        } else if (e.type === 'fail') fail(new Error(e.message));
      }, ctl.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') fail(e);
    } finally { setRunning(false); setStatus(null); setProgress(null); abort.current = null; }
  };

  /** Saves ONLY this move into the character's library sprite (other animations untouched). */
  const save = async () => {
    const a = program?.animations.find(x => x.name === m.id);
    if (!program || !a || !frames.length) return;
    setSaving(true);
    try {
      const anim = { name: a.name, fps: a.fps, loop: a.loop, frames: frames.map((_, i) => i) };
      if (linked) {
        const img = await loadImage(api.sheetUrl(projectId, linked));
        const merged = mergeIntoAsset(img, linked, { frames, pivot: program.pivot, animations: [anim] });
        const png = await new Promise<Blob>((res, rej) => merged.canvas.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
        await api.updateAsset(projectId, merged.asset, png);
        notify(`Saved "${m.id}" into ${linked.name}`);
      } else {
        const c = document.createElement('canvas');
        c.width = frames[0].width * frames.length; c.height = frames[0].height;
        const ctx = c.getContext('2d')!;
        frames.forEach((f, i) => ctx.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), i * f.width, 0));
        const png = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
        const created = await api.createAsset(projectId, {
          name: d.name, kind: 'character', source: 'code', description: d.description,
          frameWidth: frames[0].width, frameHeight: frames[0].height,
          frames: frames.map((f, i) => ({ x: i * f.width, y: 0, w: f.width, h: f.height })),
          pivot: program.pivot, animations: [anim], tags: ['code'], reference: false,
        }, png);
        update({ ...d, assetId: created.id });
        notify(`${d.name} added to the library`);
      }
      onAssetsChanged();
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  const elapsed = startedAt ? Math.floor((now - startedAt) / 1000) : 0;

  return (
    <Step n={4} title="Animate with Claude" hint="code on your reference art" done={savedInLibrary}
      right={frames.length > 0 ? (
        <button className="primary" onClick={save} disabled={saving || running}>
          <Icon name="download" /> {saving ? 'Saving…' : savedInLibrary ? 'Save again' : 'Save to library'}
        </button>
      ) : undefined}>
      {!hasProgram && linked && (
        <label className={useReference ? 'ref-mode on' : 'ref-mode'}>
          <input type="checkbox" checked={useReference} onChange={e => setUseReference(e.target.checked)} disabled={running} />
          <FrameThumb img={refImg} rect={linked.frames[linked.animations.find(a => a.name === 'idle')?.frames[0] ?? 0]} size={48} className="thumb" />
          <span><strong>Animate {d.name}'s reference art</strong> <span className="badge ok">best</span><br />
            <span className="dim small">Claude cuts the reference into parts and moves the real pixels. Off = draws from scratch (cruder).</span></span>
        </label>
      )}

      <div className="animate-grid">
        <div className="animate-preview">
          {frames.length ? <AnimPreview frames={frames} fps={m.fps} width={300} height={220} />
            : <div className="empty-inline col"><Icon name="film" size={22} /><span className="dim small">{inProgram ? 'Loading…' : 'Not animated yet'}</span></div>}
          {frames.length > 0 && <span className="dim small">{frames.length} frames · {m.fps} fps{savedInLibrary ? ' · saved' : ' · not saved yet'}</span>}
        </div>
        <div className="animate-controls">
          {inProgram && (
            <Field label="What should change?" hint="leave empty for another review round">
              <textarea rows={3} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="e.g. bigger peg swing, stomp lands in front, tornado wider at the top, scarf lags more" />
            </Field>
          )}
          <Field label="Review rounds" hint="Claude looks at its render and fixes it">
            <div className="seg compact" role="radiogroup">
              {[0, 1, 2, 3].map(n => <button key={n} role="radio" aria-checked={rounds === n} className={rounds === n ? 'active' : ''} onClick={() => setRounds(n)}>{n}</button>)}
            </div>
          </Field>
          <div className="btnrow">
            {!inProgram
              ? <ClaudeButton label={`Animate ${m.name}`} busyLabel="Working…" busy={running} disabled={!posesReady} icon="code" onClick={() => run('auto')} title={posesReady ? undefined : 'Draft the poses first'} />
              : <>
                <ClaudeButton label={feedback.trim() ? 'Apply changes' : 'Improve'} busyLabel="Working…" busy={running} icon="wand" onClick={() => run('refine')} />
                <button onClick={() => run('remake')} disabled={running} title="Throw this animation away and rebuild it from the poses (other animations are kept)"><Icon name="refresh" /> Remake</button>
              </>}
            {running && <button onClick={() => abort.current?.abort()}><Icon name="stop" /> Stop</button>}
          </div>
          <p className="dim small">{estimate} with {model === 'opus' ? 'Opus' : model === 'haiku' ? 'Haiku' : 'Sonnet'}{model !== 'opus' ? ' · Opus gives the best animations' : ''}{hasProgram ? '. Only this animation is rewritten.' : ''}</p>
        </div>
      </div>

      {running && status && (
        <div className="run-status" role="status">
          <Orb size={32} state={/review/i.test(status) ? 'searching' : /render/i.test(status) ? 'shaping' : 'weaving'} />
          <span>{status}</span>
          <span className="dim small mono">{progress ? `step ${progress.i}/${progress.total} · ` : ''}{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
          <div className="progress"><div style={{ width: `${progress ? ((progress.i - 0.5) / progress.total) * 100 : 5}%` }} /></div>
        </div>
      )}
      {programError && !running && <div className="issue error small">Current program: {programError}</div>}
      {runUsage.output > 0 && <p className="dim small">This run: {usageText(runUsage)}</p>}
      {!running && d.programs[m.id] && <ProgramHistory projectId={projectId} design={d} move={m.id} current={program} update={update} fail={fail} />}

      {iters.length > 0 && (
        <div className="iters-wrap">
          <button className="ghost small" onClick={() => setShowIters(s => !s)} aria-expanded={showIters}><Icon name={showIters ? 'chevronDown' : 'chevronRight'} /> {iters.length} round{iters.length > 1 ? 's' : ''} · what Claude changed</button>
          {showIters && (
            <div className="iters">
              {iters.map((it, k) => (
                <div key={k} className={it.error ? 'iter bad' : 'iter'}>
                  {it.preview ? <img src={it.preview} alt={`Round ${it.iteration} render`} /> : <div className="iter-err"><Icon name="alert" /> render failed</div>}
                  <div className="iter-text">
                    <strong>Round {it.iteration}</strong> <span className="dim small">{usageText(it.usage)}</span>
                    <p className="small">{it.error ? <span className="err-text">{it.error}</span> : it.notes}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Step>
  );
}


/**
 * The video route: the character's sprite on a key-colour first frame plus a tested prompt for
 * any image-to-video model; the clip comes back through Import, which keys, loops and pixelates it.
 */
function VideoRoute({ projectId, style, design: d, assets, importFor, update, fail, move: m }: EditorProps) {
  const [open, setOpen] = useState(false);
  const [idleSprite, setIdleSprite] = useState<PixelImage | null>(null);
  const [profile, setProfile] = useState<PixelImage | null>(null);
  const [useIdle, setUseIdle] = useState(false);
  const profileInput = useRef<HTMLInputElement>(null);
  const linked = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;
  const sideView = usesProfile(m);
  useEffect(() => {
    let live = true;
    setIdleSprite(null);
    if (!open || !linked) return;
    const idle = linked.animations.find(a => a.name === 'idle') ?? linked.animations[0];
    const rect = linked.frames[idle?.frames[0] ?? 0];
    if (rect) unpackFrames(api.sheetUrl(projectId, linked), [rect]).then(([f]) => live && setIdleSprite(f), () => {});
    return () => { live = false; };
  }, [open, projectId, linked]);
  // the side-view still, with its backdrop and any stray marks removed
  useEffect(() => {
    let live = true;
    setProfile(null);
    if (!open || !d.profile) return;
    loadImage(api.profileUrl(projectId, d.id, d.profile)).then(img => {
      if (!live) return;
      const px = toPixels(img);
      let f: PixelImage = { width: px.width, height: px.height, data: px.data };
      const bg = estimateBackground(f);
      if (bg) f = removeBackground(f, bg, 0.09, true);
      setProfile(keepMainFigure(f));
    }, () => {});
    return () => { live = false; };
  }, [open, projectId, d.id, d.profile]);
  const sprite = sideView && profile && !useIdle ? profile : idleSprite;
  const fromProfile = sprite === profile && !!profile;
  // key colour from what the sprite actually wears (falls back to the design's part colours)
  const key = useMemo(() => {
    const colors = new Set<string>(designPalette(d));
    if (sprite) for (let i = 0; i < sprite.data.length; i += 16) if (sprite.data[i + 3] > 127) colors.add('#' + ((1 << 24) | (sprite.data[i] << 16) | (sprite.data[i + 1] << 8) | sprite.data[i + 2]).toString(16).slice(1));
    return videoKeyFor([...colors]);
  }, [d, sprite]);
  const plan = useMemo(() => videoMovePrompt(d, m, key), [d, m, key]);
  const frame = useMemo(() => (sprite ? videoFirstFrame(sprite, hexToRgb(key.hex)) : null), [sprite, key]);
  const preview = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = preview.current;
    if (!c || !frame) return;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(pixelsToCanvas(frame), 0, 0, c.width, c.height);
  }, [frame]);
  const uploadProfile = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    try { update(await api.uploadProfile(projectId, d.id, f)); setUseIdle(false); } catch (e) { fail(e); }
  };
  const saveFrame = async () => { if (frame) download(`${slugify(d.name)}-${fromProfile ? 'side' : 'idle'}-first-frame-${key.name}.png`, await canvasToPng(pixelsToCanvas(frame))); };

  return (
    <section className="card step video-route">
      <div className="card-head">
        <span className="step-n"><Icon name="film" size={12} /></span>
        <h3>Animate with a video model</h3>
        <span className="dim small">best motion · Kling, Veo in Gemini, any image-to-video</span>
        <div className="spacer" />
        <button className="ghost small" onClick={() => setOpen(o => !o)} aria-expanded={open}><Icon name={open ? 'chevronDown' : 'chevronRight'} /> {open ? 'Hide' : 'Show'}</button>
      </div>
      {open ? (
        <div className="vr-body">
          {!linked ? <p className="dim small">Import {d.name}'s reference sprite first: the video starts from it.</p> : (
            <>
              {sideView && (
                <div className={profile ? 'vr-profile ok' : 'vr-profile'}>
                  <div>
                    <strong>{profile ? 'Side-view still ready' : 'Side-view still (recommended)'}</strong>
                    <p className="dim small">A video keeps its first frame's angle: {d.name}'s idle sprite is three-quarter, so a run from it comes out three-quarter or twists mid-clip. Have Gemini redraw {d.name} in side view once; every side-view move uses it.</p>
                  </div>
                  <div className="btnrow">
                    <CopyButton text={designProfilePrompt(style, d)} label="Copy Gemini prompt" primary={!profile} />
                    <button onClick={() => profileInput.current?.click()}><Icon name="upload" /> {profile ? 'Replace' : 'Upload'} side view…</button>
                    {profile && <label className="toggle"><input type="checkbox" checked={useIdle} onChange={e => setUseIdle(e.target.checked)} /> Use the idle sprite instead</label>}
                    <input ref={profileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { void uploadProfile(e.target.files); e.target.value = ''; }} />
                  </div>
                </div>
              )}
              <div className="vr-grid">
                <div className="vr-frame">
                  <canvas ref={preview} width={180} height={180} aria-label="First frame preview" />
                  <button onClick={() => void saveFrame()} disabled={!frame}><Icon name="download" /> First frame</button>
                </div>
                <ol className="vr-steps">
                  <li>Download the first frame ({fromProfile ? 'side view' : 'idle sprite'} on {key.name}, picked because it clashes least with {d.name}'s colours).</li>
                  <li>In the video model: upload it as the <strong>start image</strong>{plan.pinEnd ? <> and also as the <strong>end / last frame</strong></> : null}; <strong>{plan.seconds} s</strong>, square 1:1, audio off.</li>
                  <li>Paste the prompt and the negative prompt (if the model has one).
                    <div className="btnrow"><CopyButton text={plan.prompt} label="Copy prompt" /><CopyButton text={plan.negative} label="Copy negative" primary={false} /></div>
                  </li>
                  <li>Import the clip. {plan.cut}
                    <div className="btnrow"><button onClick={() => importFor({ assetId: d.assetId, anim: m.id })}><Icon name="upload" /> Import video…</button></div>
                  </li>
                </ol>
              </div>
            </>
          )}
          <PromptBox text={`${plan.prompt}\n\nNegative: ${plan.negative}`} />
        </div>
      ) : <p className="dim small">Real motion (airborne runs, follow-through) from one clip; Kinetome cuts the loop and makes it pixel art.</p>}
    </section>
  );
}
