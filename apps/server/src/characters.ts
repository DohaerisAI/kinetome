import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  contactSheet, designColors, packGrid, PLATFORMER_MOVES,
  type CharacterDesign, type PixelImage, type RenderedAnim, type RenderOutput,
} from '@sprite/core';
import { cellFor, draftMove, executeProgram, polishDescription, reviseProgram, writeProgram, type CodeAnim } from './agents.ts';
import { claudeStatus, logUsage, readUsage, type ClaudeUsage, type Model } from './claude.ts';
import { encodePng } from './png.ts';
import { buildRig, paddedReference, type RigContext } from './rig.ts';
import * as store from './store.ts';

const MODELS: Model[] = ['sonnet', 'opus', 'haiku'];
const modelOf = (v: unknown): Model => (MODELS.includes(v as Model) ? (v as Model) : 'sonnet');
const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

/** Rendered program -> one packed sheet + per-animation frame indexes (what the studio imports). */
function pack(out: RenderOutput) {
  const all: PixelImage[] = out.animations.flatMap(a => a.frames);
  const layout = packGrid(all.length, out.width, out.height, 12);
  const sheet: PixelImage = { width: layout.width, height: layout.height, data: new Uint8ClampedArray(layout.width * layout.height * 4) };
  all.forEach((f, i) => {
    const r = layout.rects[i];
    for (let y = 0; y < f.height; y++) sheet.data.set(f.data.subarray(y * f.width * 4, (y + 1) * f.width * 4), ((r.y + y) * sheet.width + r.x) * 4);
  });
  let k = 0;
  const animations = out.animations.map(a => ({ name: a.name, fps: a.fps, loop: a.loop, frames: a.frames.map(() => k++) }));
  return { sheet: dataUrl(encodePng(sheet)), frameWidth: out.width, frameHeight: out.height, rects: layout.rects, pivot: out.pivot, animations };
}

/** The animations a code run should implement: the chosen moves, falling back to the standard idle. */
/**
 * Everything a character's programs render, on one shared canvas: the legacy combined
 * program for animations that have no program of their own, plus every per-animation
 * program. Frames are padded on the right to the widest program (height and pivot must match).
 */
function renderAll(d: CharacterDesign, rig: RigContext | null, override?: { target: string | null; code: string }): RenderOutput {
  const colors = designColors(d);
  const programs = { ...d.programs };
  let legacy = d.code;
  if (override) { if (override.target === null) legacy = override.code; else programs[override.target] = override.code; }
  const outs: { out: RenderOutput; anims: RenderedAnim[] }[] = [];
  if (legacy) {
    const out = executeProgram(legacy, colors, undefined, rig);
    outs.push({ out, anims: out.animations.filter(a => !(a.name in programs)) });
  }
  for (const [name, code] of Object.entries(programs)) {
    const out = executeProgram(code, colors, [name], rig);
    outs.push({ out, anims: out.animations.filter(a => a.name === name) });
  }
  if (!outs.length) throw new Error('no program yet');
  const base = outs[0].out;
  for (const { out } of outs) {
    if (out.height !== base.height || out.pivot.x !== base.pivot.x || out.pivot.y !== base.pivot.y)
      throw new Error(`Programs disagree on canvas height or pivot (${out.height}/${out.pivot.x},${out.pivot.y} vs ${base.height}/${base.pivot.x},${base.pivot.y})`);
  }
  const W = Math.max(...outs.map(o => o.out.width)), H = base.height;
  const widen = (f: PixelImage): PixelImage => {
    if (f.width === W) return f;
    const g: PixelImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
    for (let y = 0; y < H; y++) g.data.set(f.data.subarray(y * f.width * 4, (y + 1) * f.width * 4), y * W * 4);
    return g;
  };
  const order = new Map(d.moves.map((m, i) => [m.id, i]));
  const animations = outs.flatMap(o => o.anims.map(a => ({ ...a, frames: a.frames.map(widen) })))
    .sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
  return { width: W, height: H, pivot: base.pivot, animations, allAnimations: animations.map(a => a.name) };
}

const hasPrograms = (d: CharacterDesign) => !!d.code || Object.keys(d.programs).length > 0;

const refsDir = (p: string, c: string, m: string) => join(store.projectPath(p), 'characters', c, 'refs', m);

function codeAnims(d: CharacterDesign, names: string[], projectId: string): CodeAnim[] {
  const wanted = names.length ? names : ['idle'];
  return wanted.map(n => {
    const m = d.moves.find(x => x.id === n);
    const p = PLATFORMER_MOVES.find(x => x.id === n);
    if (m) return {
      name: m.id, frames: m.frames, fps: m.fps, loop: m.loop,
      description: [m.description, m.notes && `Direction: ${m.notes}`].filter(Boolean).join(' '),
      effects: m.effects || undefined,
      refPaths: m.refImages.map(f => join(refsDir(projectId, d.id, m.id), f)),
      poses: m.poses.length === m.frames && m.poses.every(x => x.trim()) ? m.poses : (p?.frames === m.frames ? p.poses : []),
    };
    if (p) return { name: p.id, frames: p.frames, fps: p.fps, loop: p.loop, description: '', poses: p.poses };
    return { name: n, frames: 4, fps: 8, loop: true, description: '', poses: [] };
  });
}

const sum = (a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage => ({
  input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output, costUsd: a.costUsd + b.costUsd, ms: a.ms + b.ms,
});
const ZERO: ClaudeUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, ms: 0 };

export const characters = new Hono();

characters.get('/claude/status', async c => c.json(await claudeStatus()));
characters.get('/projects/:p/claude/usage', async c => c.json(await readUsage(store.projectPath(c.req.param('p')))));

characters.get('/projects/:p/characters', async c => c.json(await store.listCharacters(c.req.param('p'))));
characters.post('/projects/:p/characters', async c => {
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) throw new store.HttpError(400, 'name required');
  return c.json(await store.createCharacter(c.req.param('p'), name.trim()), 201);
});
characters.get('/projects/:p/characters/:c', async c => c.json(await store.getCharacter(c.req.param('p'), c.req.param('c'))));
characters.put('/projects/:p/characters/:c', async c => c.json(await store.saveCharacter(c.req.param('p'), c.req.param('c'), await c.req.json())));
characters.delete('/projects/:p/characters/:c', async c => { await store.deleteCharacter(c.req.param('p'), c.req.param('c')); return c.body(null, 204); });

characters.post('/projects/:p/characters/:c/describe', async c => {
  const p = c.req.param('p'), id = c.req.param('c');
  const { model } = await c.req.json<{ model?: string }>();
  const [{ style }, d] = await Promise.all([store.getProject(p), store.getCharacter(p, id)]);
  const r = await polishDescription(style, d, modelOf(model));
  await logUsage(store.projectPath(p), 'describe', r);
  const saved = await store.saveCharacter(p, id, {
    ...d, description: r.data.description.trim(), referencePose: r.data.referencePose.trim(),
    invariants: r.data.invariants.map(x => x.trim()).filter(Boolean),
  });
  return c.json({ design: saved, conflicts: r.data.conflicts ?? [], usage: r.usage });
});

characters.post('/projects/:p/characters/:c/moves/:m/draft', async c => {
  const p = c.req.param('p'), id = c.req.param('c'), mid = c.req.param('m');
  const { model, instruction } = await c.req.json<{ model?: string; instruction?: string }>();
  const [{ style }, d] = await Promise.all([store.getProject(p), store.getCharacter(p, id)]);
  const move = d.moves.find(x => x.id === mid);
  if (!move) throw new store.HttpError(404, `no move "${mid}"`);
  const r = await draftMove(style, d, move, modelOf(model), instruction?.trim() || undefined);
  await logUsage(store.projectPath(p), 'move', r);
  const poses = r.data.poses.slice(0, move.frames).map(s => s.trim());
  const saved = await store.saveCharacter(p, id, { ...d, moves: d.moves.map(x => (x.id === mid ? { ...x, poses, notes: r.data.notes.trim() } : x)) });
  return c.json({ design: saved, usage: r.usage });
});

/** Render code as-is (after manual edits, or to preview the saved program). */
characters.post('/projects/:p/characters/:c/code/render', async c => {
  const d = await store.getCharacter(c.req.param('p'), c.req.param('c'));
  const { code } = await c.req.json<{ code?: string }>();
  if (!code && !hasPrograms(d)) throw new store.HttpError(400, 'no program yet');
  try {
    const rig = d.codeRig ? await buildRig(c.req.param('p'), d, join(store.projectPath(c.req.param('p')), '.renders', d.id)) : null;
    const out = code ? executeProgram(code, designColors(d), undefined, rig) : renderAll(d, rig);
    return c.json({ ok: true, packed: pack(out), preview: dataUrl(encodePng(contactSheet(out, 1500, rig ? paddedReference(rig) : undefined))) });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

interface RunParams {
  model: Model; animations: string[]; focus: string[]; rounds: number;
  feedback?: string; fromCurrent: boolean; useReference: boolean;
  /** Per-animation program to write/edit (null = the legacy combined program). */
  target?: string | null;
  /** Starting code for a per-animation run (null = write new). */
  initialCode?: string | null;
  /** Another program of the character whose parts to reuse. */
  context?: string;
  /** Re-freeze the reference (only for a character's very first program). */
  freshRig?: boolean;
}

/**
 * The code-drawn loop, streamed as server-sent events:
 * write (or revise from feedback) -> render -> Claude looks at the render and fixes it,
 * `rounds` times. Every iteration streams its preview so the studio shows progress live.
 */
async function streamRun(c: Context, p: string, id: string, body: RunParams) {
  const { model } = body;
  const rounds = Math.max(0, Math.min(3, body.rounds));
  const [{ style }, design] = await Promise.all([store.getProject(p), store.getCharacter(p, id)]);
  const anims = codeAnims(design, body.animations, p);
  // the review sheet shows only the animations being worked on, so they render large enough to judge
  const focus = body.focus.length ? anims.filter(a => body.focus.includes(a.name)) : anims;
  const colors = designColors(design);
  const renders = join(store.projectPath(p), '.renders', id);
  await mkdir(renders, { recursive: true });
  // a brand-new program re-freezes the reference; revisions keep the one they were written against
  const perAnim = body.target !== undefined && body.target !== null;
  const fresh = body.freshRig ?? !(body.fromCurrent && design.code && design.codeRig);
  const rig = body.useReference ? await buildRig(p, design, renders, fresh) : null;
  if (body.useReference && !rig) throw new store.HttpError(400, 'This character has no reference sprite in the library yet');
  // every program of a character uses the same mode (all animate the reference, or all draw from scratch)
  if (hasPrograms(design) && !fresh && design.codeRig !== !!rig) throw new store.HttpError(400, design.codeRig ? 'This character\'s programs animate the reference; keep "Use reference" on' : 'This character\'s programs draw from scratch; turn "Use reference" off');
  const refRow = rig ? paddedReference(rig) : undefined;

  return streamSSE(c, async stream => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    let usage = ZERO;
    let code = perAnim ? body.initialCode ?? null : body.fromCurrent ? design.code : null;
    let lastGood: string | null = null;
    let lastOut: RenderOutput | null = null;
    try {
      const total = rounds + 1;
      for (let i = 0; i < total; i++) {
        const needsWrite = i === 0 && !code;
        const feedback = i === 0 ? body.feedback?.trim() || undefined : undefined;
        let sheetPath: string | undefined, error: string | undefined;

        if (code) {
          // render the current program so Claude can see it
          try {
            const out = executeProgram(code, colors, focus.map(a => a.name), rig);
            sheetPath = join(renders, `iter-${Date.now()}.png`);
            await writeFile(sheetPath, encodePng(contactSheet(out, 1500, refRow)));
          } catch (e) { error = e instanceof Error ? e.message : String(e); }
        }

        await send('status', {
          step: needsWrite ? 'writing' : 'reviewing', iteration: i + 1, total,
          message: needsWrite ? `Writing the sprite program (${anims.map(a => a.name).join(', ')})…`
            : error ? 'Fixing an error in the program…' : feedback ? `Working on ${focus.map(a => a.name).join(', ')}…` : `Reviewing the render and fixing problems (round ${i} of ${rounds})…`,
        });
        const r = needsWrite
          ? await writeProgram(style, design, anims, model, feedback, rig, body.context)
          : await reviseProgram(style, design, anims, model, { code: code!, sheetPath, sheetAnims: focus, error, feedback }, rig);
        await logUsage(store.projectPath(p), needsWrite ? 'code-write' : 'code-revise', r);
        usage = sum(usage, r.usage);
        code = r.data.code;

        await send('status', { step: 'rendering', iteration: i + 1, total, message: 'Rendering frames…' });
        try {
          const out = executeProgram(code, colors, anims.map(a => a.name), rig);
          lastGood = code;
          const focused = { ...out, animations: out.animations.filter(a => focus.some(f => f.name === a.name)) };
          // the studio gets the character's whole set (this program + all the others)
          const all = perAnim ? renderAll(design, rig, { target: body.target!, code }) : out;
          lastOut = all;
          await send('iteration', { iteration: i + 1, total, notes: r.data.notes, code, usage: r.usage, preview: dataUrl(encodePng(contactSheet(focused, 1500, refRow))), packed: pack(all) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // the next round (if any) sees this error and fixes it; otherwise we finish with the last good program
          await send('iteration', { iteration: i + 1, total, notes: r.data.notes, code, usage: r.usage, error: msg });
        }
      }
      let saved: CharacterDesign | null = null;
      if (lastGood) {
        const cur = await store.getCharacter(p, id);
        saved = await store.saveCharacter(p, id, perAnim
          ? { ...cur, programs: { ...cur.programs, [body.target!]: lastGood }, codeRig: !!rig }
          : { ...cur, code: lastGood, codeRig: !!rig });
      }
      await send('done', { ok: !!lastGood, code: lastGood ?? code, usage, packed: lastOut ? pack(lastOut) : null, cell: cellFor(design), design: saved });
    } catch (e) {
      await send('fail', { message: e instanceof Error ? e.message : String(e), usage });
    }
  });
}

/** Low-level run (kept for tooling): explicit animations/focus/feedback. */
characters.post('/projects/:p/characters/:c/code/run', async c => {
  const body = await c.req.json<{ model?: string; animations?: string[]; rounds?: number; feedback?: string; fromCurrent?: boolean; useReference?: boolean; focus?: string[] }>();
  return streamRun(c, c.req.param('p'), c.req.param('c'), {
    model: modelOf(body.model), animations: body.animations ?? [], focus: body.focus ?? [], rounds: body.rounds ?? 1,
    feedback: body.feedback, fromCurrent: !!body.fromCurrent, useReference: !!body.useReference,
  });
});

/**
 * One button in the studio: animate ONE move. Each move gets its own program, so Claude
 * only ever writes the move it works on (other programs are passed as context to reuse
 * the same parts). A move that still lives in the legacy combined program is extracted
 * into its own program the first time it is refined.
 */
characters.post('/projects/:p/characters/:c/code/animate', async c => {
  const p = c.req.param('p'), id = c.req.param('c');
  const body = await c.req.json<{ model?: string; move?: string; mode?: 'auto' | 'remake' | 'refine'; rounds?: number; feedback?: string; useReference?: boolean }>();
  const design = await store.getCharacter(p, id);
  const move = design.moves.find(m => m.id === body.move);
  if (!move) throw new store.HttpError(404, `no move "${body.move}"`);
  const any = hasPrograms(design);
  const useReference = any ? design.codeRig : (body.useReference ?? !!design.assetId);

  let legacyAnims: string[] = [];
  if (design.code) {
    try {
      const rig = design.codeRig ? await buildRig(p, design, join(store.projectPath(p), '.renders', id)) : null;
      legacyAnims = executeProgram(design.code, designColors(design), [], rig).allAnimations ?? [];
    } catch { legacyAnims = []; }
  }
  const own = design.programs[move.id] ?? null;
  const inLegacy = !own && legacyAnims.includes(move.id);
  // parts to reuse: any other program of this character
  const context = Object.entries(design.programs).find(([n]) => n !== move.id)?.[1] ?? design.code ?? undefined;
  const user = body.feedback?.trim();
  const mode = body.mode === 'remake' ? 'remake' : (own || inLegacy) ? 'refine' : 'new';
  const spec = `${move.frames} frames at ${move.fps} fps, ${move.loop ? 'looping' : 'plays once'}`;

  let initialCode: string | null = null, feedback: string | undefined = user, ctx: string | undefined;
  if (mode === 'new') { ctx = context; }
  else if (mode === 'remake') { ctx = own ?? context; feedback = [`Write the "${move.id}" animation (${spec}) fresh from its poses, direction and effects.`, user].filter(Boolean).join('\n'); }
  else if (own) { initialCode = own; feedback = [`Improve the "${move.id}" animation (${spec}).`, user && `User feedback (highest priority): ${user}`].filter(Boolean).join('\n'); }
  else {
    initialCode = design.code;
    feedback = [`Rewrite this as a STANDALONE program that defines ONLY the "${move.id}" animation (${spec}): drop the other animations and anything only they use; keep the part table, canvas height and pivot.`, user && `While doing so, apply this user feedback (highest priority): ${user}`].filter(Boolean).join('\n');
  }
  return streamRun(c, p, id, {
    model: modelOf(body.model), animations: [move.id], focus: [move.id], rounds: body.rounds ?? 1,
    feedback, fromCurrent: true, useReference, target: move.id, initialCode, context: ctx, freshRig: !any,
  });
});

// ---------- pose reference images per move ----------

characters.post('/projects/:p/characters/:c/moves/:m/refs', async c => {
  const p = c.req.param('p'), id = c.req.param('c'), mid = c.req.param('m');
  const d = await store.getCharacter(p, id);
  const move = d.moves.find(x => x.id === mid);
  if (!move) throw new store.HttpError(404, `no move "${mid}"`);
  const form = await c.req.formData();
  const file = form.get('image');
  if (!(file instanceof File)) throw new store.HttpError(400, 'missing image');
  if (file.size > 12 * 1024 * 1024) throw new store.HttpError(400, 'image too large (max 12 MB)');
  const ext = /\.(png|jpe?g|webp|gif)$/i.exec(file.name)?.[1]?.toLowerCase().replace('jpeg', 'jpg') ?? 'png';
  const name = `${Date.now()}.${ext}`;
  await mkdir(refsDir(p, id, mid), { recursive: true });
  await writeFile(join(refsDir(p, id, mid), name), new Uint8Array(await file.arrayBuffer()));
  const saved = await store.saveCharacter(p, id, { ...d, moves: d.moves.map(x => (x.id === mid ? { ...x, refImages: [...x.refImages, name] } : x)) });
  return c.json(saved);
});

characters.get('/projects/:p/characters/:c/moves/:m/refs/:f', async c => {
  const f = c.req.param('f');
  if (!/^[0-9]+\.(png|jpg|webp|gif)$/.test(f)) throw new store.HttpError(400, 'bad file');
  const buf = await readFile(join(refsDir(c.req.param('p'), c.req.param('c'), c.req.param('m')), f)).catch(() => null);
  if (!buf) throw new store.HttpError(404, 'not found');
  const type = f.endsWith('.jpg') ? 'image/jpeg' : f.endsWith('.webp') ? 'image/webp' : f.endsWith('.gif') ? 'image/gif' : 'image/png';
  return c.body(buf, 200, { 'content-type': type, 'cache-control': 'max-age=31536000, immutable' });
});

characters.delete('/projects/:p/characters/:c/moves/:m/refs/:f', async c => {
  const p = c.req.param('p'), id = c.req.param('c'), mid = c.req.param('m'), f = c.req.param('f');
  if (!/^[0-9]+\.(png|jpg|webp|gif)$/.test(f)) throw new store.HttpError(400, 'bad file');
  const d = await store.getCharacter(p, id);
  await rm(join(refsDir(p, id, mid), f), { force: true });
  return c.json(await store.saveCharacter(p, id, { ...d, moves: d.moves.map(x => (x.id === mid ? { ...x, refImages: x.refImages.filter(r => r !== f) } : x)) }));
});
