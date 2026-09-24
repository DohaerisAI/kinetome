import { useEffect, useMemo, useRef, useState } from 'react';
import { PLATFORMER_MOVES, type PixelImage } from '@sprite/core';
import { api, type CodeEvent, type Packed, type Usage } from '../../api.ts';
import { Icon } from '../../icons.tsx';
import { mergeIntoAsset } from '../../merge.ts';
import { dataUrlToBlob, loadImage, unpackFrames } from '../../pixels.ts';
import { AnimPreview } from '../AnimPreview.tsx';
import { ClaudeButton, Field, usageText, type TabProps } from './shared.tsx';

interface Iteration { iteration: number; notes: string; code: string; usage: Usage; preview?: string; packed?: Packed; error?: string }

const ZERO: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, ms: 0 };
const add = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, costUsd: a.costUsd + b.costUsd, ms: a.ms + b.ms });

/** Frames grouped per animation, ready for players. */
function useUnpacked(packed: Packed | null) {
  const [anims, setAnims] = useState<{ name: string; fps: number; loop: boolean; frames: PixelImage[] }[]>([]);
  useEffect(() => {
    let live = true;
    if (!packed) { setAnims([]); return; }
    unpackFrames(packed.sheet, packed.rects).then(frames => {
      if (live) setAnims(packed.animations.map(a => ({ name: a.name, fps: a.fps, loop: a.loop, frames: a.frames.map(i => frames[i]) })));
    }, () => {});
    return () => { live = false; };
  }, [packed]);
  return anims;
}

export function CodeTab({ projectId, design: d, assets, model, update, notify, fail, onAssetsChanged }: TabProps) {
  const choices = useMemo(() => {
    const ids = d.moves.map(m => m.id);
    return ids.includes('idle') ? ids : ['idle', ...ids];
  }, [d.moves]);
  const [picked, setPicked] = useState<string[]>(() => choices.filter(id => id === 'idle' || d.moves.find(m => m.id === id)?.poses.length));
  const [rounds, setRounds] = useState(1);
  const [feedback, setFeedback] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ i: number; total: number } | null>(null);
  const [iters, setIters] = useState<Iteration[]>([]);
  const [packed, setPacked] = useState<Packed | null>(null);
  const [code, setCode] = useState(d.code ?? '');
  const [codeDirty, setCodeDirty] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [runUsage, setRunUsage] = useState<Usage>(ZERO);
  const [saving, setSaving] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const anims = useUnpacked(packed);

  // show the saved program on open
  useEffect(() => {
    if (!d.code) return;
    api.renderCode(projectId, d.id, d.code).then(r => { if (r.ok) setPacked(r.packed); else setRenderError(r.error); }, () => {});
  }, [projectId, d.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fromCurrent: boolean) => {
    setRunning(true); setStatus('Starting…'); setRunUsage(ZERO); setRenderError(null); setStartedAt(Date.now()); setNow(Date.now());
    if (!fromCurrent) setIters([]);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      await api.runCode(projectId, d.id, { model, animations: picked, rounds, feedback: feedback.trim() || undefined, fromCurrent }, (e: CodeEvent) => {
        if (e.type === 'status') { setStatus(e.message); setProgress({ i: e.iteration, total: e.total }); }
        else if (e.type === 'iteration') {
          setIters(list => [...list, e]);
          setRunUsage(u => add(u, e.usage));
          if (e.packed) { setPacked(e.packed); setCode(e.code); setCodeDirty(false); }
        } else if (e.type === 'done') {
          if (e.code) update({ ...d, code: e.code });
          if (e.packed) setPacked(e.packed);
          notify(e.ok ? `Drawn with code · ${usageText(e.usage)}` : 'Claude could not produce a working program; see the errors below');
          setFeedback('');
        } else if (e.type === 'fail') fail(new Error(e.message));
      }, ctl.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') fail(e);
    } finally { setRunning(false); setStatus(null); setProgress(null); abort.current = null; }
  };

  const rerender = async () => {
    try {
      const r = await api.renderCode(projectId, d.id, code);
      if (r.ok) { setPacked(r.packed); setRenderError(null); setCodeDirty(false); update({ ...d, code }); }
      else setRenderError(r.error);
    } catch (e) { fail(e); }
  };

  const linked = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;

  const save = async () => {
    if (!packed) return;
    setSaving(true);
    try {
      const frames = await unpackFrames(packed.sheet, packed.rects);
      const animations = packed.animations.map(a => ({ name: a.name, fps: a.fps, loop: a.loop, frames: a.frames }));
      if (linked) {
        const img = await loadImage(api.sheetUrl(projectId, linked));
        const merged = mergeIntoAsset(img, linked, { frames, pivot: packed.pivot, animations });
        const png = await new Promise<Blob>((res, rej) => merged.canvas.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
        await api.updateAsset(projectId, { ...merged.asset, description: linked.description || d.description }, png);
        notify(`Updated ${linked.name}: ${animations.map(a => a.name).join(', ')}`);
      } else {
        const created = await api.createAsset(projectId, {
          name: d.name, kind: 'character', source: 'code', description: d.description,
          frameWidth: packed.frameWidth, frameHeight: packed.frameHeight, frames: packed.rects, pivot: packed.pivot,
          animations, tags: ['code'], reference: false,
        }, await dataUrlToBlob(packed.sheet));
        update({ ...d, assetId: created.id });
        notify(`${d.name} added to the library`);
      }
      onAssetsChanged();
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  const toggle = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  const label = (id: string) => d.moves.find(m => m.id === id)?.name ?? PLATFORMER_MOVES.find(m => m.id === id)?.name ?? id;
  const frameCount = (id: string) => d.moves.find(m => m.id === id)?.frames ?? PLATFORMER_MOVES.find(m => m.id === id)?.frames ?? 4;
  const estimate = picked.reduce((s, id) => s + frameCount(id), 0);

  return (
    <div className="tab-grid code-tab">
      <section className="card">
        <h3>Claude draws {d.name} with code</h3>
        <p className="dim small">Claude writes a small drawing program using only {d.name}'s palette, the studio renders it, then Claude looks at the frames and fixes what's off. Pixel-perfect consistency; best for simpler characters, enemies and effects.</p>
        <Field label="Animations">
          <div className="chips">
            {choices.map(id => (
              <button key={id} className={picked.includes(id) ? 'chip active' : 'chip'} onClick={() => toggle(id)} aria-pressed={picked.includes(id)}>
                {picked.includes(id) && <Icon name="check" size={12} />} {label(id)} <span className="dim">{frameCount(id)}f</span>
              </button>
            ))}
          </div>
        </Field>
        <div className="row2">
          <Field label="Review rounds" hint="Claude looks at the render and fixes it">
            <div className="seg compact" role="radiogroup">
              {[0, 1, 2, 3].map(n => <button key={n} role="radio" aria-checked={rounds === n} className={rounds === n ? 'active' : ''} onClick={() => setRounds(n)}>{n}</button>)}
            </div>
          </Field>
          <Field label="Estimated cost" hint="measured on real runs">
            <span className="dim small">{(() => {
              // measured: writing 10 frames = 26k output tokens / 4.2 min; each review round ~75% of that
              const write = 12 + 1.4 * estimate, total = write * (1 + 0.75 * rounds);
              return `~${Math.round(total)}k output tokens · ~${Math.max(1, Math.round(total * 0.175))} min · ${picked.length} anim, ${estimate} frames`;
            })()}</span>
          </Field>
        </div>
        <Field label={d.code ? 'What should change?' : 'Extra notes (optional)'}>
          <textarea rows={2} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder={d.code ? 'e.g. the sword is too short; make the wind-up slower; hair should bounce on the landing' : 'e.g. chunky proportions, big head, cape flows behind'} />
        </Field>
        <div className="btnrow">
          {!d.code || !packed ? (
            <ClaudeButton label="Draw with Claude" busyLabel="Working…" busy={running} disabled={!picked.length} icon="code" onClick={() => run(false)} />
          ) : (
            <>
              <ClaudeButton label={feedback.trim() ? 'Apply feedback' : 'Another review round'} busyLabel="Working…" busy={running} disabled={!picked.length} icon="wand" onClick={() => run(true)} />
              <button onClick={() => run(false)} disabled={running} title="Start over from scratch"><Icon name="refresh" /> Redraw from scratch</button>
            </>
          )}
          {running && <button onClick={() => abort.current?.abort()}><Icon name="stop" /> Stop</button>}
        </div>
        {running && status && (
          <div className="run-status" role="status">
            <span className="spinner" aria-hidden />
            <span>{status}</span>
            <span className="dim small mono">{progress ? `step ${progress.i}/${progress.total} · ` : ''}{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
            <div className="progress"><div style={{ width: `${progress ? ((progress.i - 0.5) / progress.total) * 100 : 5}%` }} /></div>
          </div>
        )}
        {running && <p className="dim small">Writing a full sprite program takes Claude a few minutes; each review round adds about as long. You can keep working in other tabs.</p>}
        {runUsage.output > 0 && <p className="dim small">This run: {usageText(runUsage)}</p>}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Result</h3>
          <div className="spacer" />
          <button className="primary" onClick={save} disabled={!packed || saving || running || codeDirty}>
            <Icon name="download" /> {saving ? 'Saving…' : linked ? `Save into ${linked.name}` : 'Save to library'}
          </button>
        </div>
        {anims.length ? (
          <div className="code-players">
            {anims.map(a => (
              <figure key={a.name} className="code-player">
                <AnimPreview frames={a.frames} fps={a.fps} width={150} height={150} />
                <figcaption><strong>{a.name}</strong> <span className="dim small">{a.frames.length}f · {a.fps}fps</span></figcaption>
              </figure>
            ))}
          </div>
        ) : <div className="empty-inline"><Icon name="code" size={22} /><span className="dim">Nothing drawn yet</span></div>}
        {renderError && <div className="issue error small">{renderError}</div>}
      </section>

      {iters.length > 0 && (
        <section className="card wide">
          <h3>Iterations</h3>
          <div className="iters">
            {iters.map((it, k) => (
              <div key={k} className={it.error ? 'iter bad' : 'iter'}>
                {it.preview ? <img src={it.preview} alt={`Iteration ${it.iteration} render`} /> : <div className="iter-err"><Icon name="alert" /> render failed</div>}
                <div className="iter-text">
                  <strong>Round {it.iteration}</strong> <span className="dim small">{usageText(it.usage)}</span>
                  <p className="small">{it.error ? <span className="err-text">{it.error}</span> : it.notes}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {(code || d.code) && (
        <section className="card wide">
          <div className="card-head">
            <button className="ghost" onClick={() => setShowCode(s => !s)} aria-expanded={showCode}><Icon name={showCode ? 'chevronDown' : 'chevronRight'} /> Sprite program</button>
            <span className="dim small">{code.split('\n').length} lines · stored with the design, re-renders identically</span>
            <div className="spacer" />
            {codeDirty && <button onClick={rerender}><Icon name="refresh" /> Re-render</button>}
          </div>
          {showCode && <textarea className="code-edit mono" spellCheck={false} value={code} onChange={e => { setCode(e.target.value); setCodeDirty(true); }} rows={22} aria-label="Sprite program" />}
        </section>
      )}
    </div>
  );
}
