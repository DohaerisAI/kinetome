import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  contactSheet, designColors, packGrid, PLATFORMER_MOVES,
  type CharacterDesign, type PixelImage, type RenderOutput,
} from '@sprite/core';
import { cellFor, draftMove, executeProgram, polishDescription, reviseProgram, writeProgram, type CodeAnim } from './agents.ts';
import { claudeStatus, logUsage, readUsage, type ClaudeUsage, type Model } from './claude.ts';
import { encodePng } from './png.ts';
import { buildRig, paddedReference } from './rig.ts';
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
function codeAnims(d: CharacterDesign, names: string[]): CodeAnim[] {
  const wanted = names.length ? names : ['idle'];
  return wanted.map(n => {
    const m = d.moves.find(x => x.id === n);
    const p = PLATFORMER_MOVES.find(x => x.id === n);
    if (m) return {
      name: m.id, frames: m.frames, fps: m.fps, loop: m.loop,
      description: [m.description, m.notes && `Direction: ${m.notes}`].filter(Boolean).join(' '),
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
  const src = code ?? d.code;
  if (!src) throw new store.HttpError(400, 'no program yet');
  try {
    const rig = d.codeRig ? await buildRig(c.req.param('p'), d, join(store.projectPath(c.req.param('p')), '.renders', d.id)) : null;
    const out = executeProgram(src, designColors(d), undefined, rig);
    return c.json({ ok: true, packed: pack(out), preview: dataUrl(encodePng(contactSheet(out, 1500, rig ? paddedReference(rig) : undefined))) });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * The code-drawn loop, streamed as server-sent events:
 * write (or revise from feedback) -> render -> Claude looks at the render and fixes it,
 * `rounds` times. Every iteration streams its preview so the studio shows progress live.
 */
characters.post('/projects/:p/characters/:c/code/run', async c => {
  const p = c.req.param('p'), id = c.req.param('c');
  const body = await c.req.json<{ model?: string; animations?: string[]; rounds?: number; feedback?: string; fromCurrent?: boolean; useReference?: boolean; focus?: string[] }>();
  const model = modelOf(body.model);
  const rounds = Math.max(0, Math.min(3, body.rounds ?? 1));
  const [{ style }, design] = await Promise.all([store.getProject(p), store.getCharacter(p, id)]);
  const anims = codeAnims(design, body.animations ?? []);
  // the review sheet shows only the animations being worked on, so they render large enough to judge
  const focus = body.focus?.length ? anims.filter(a => body.focus!.includes(a.name)) : anims;
  const colors = designColors(design);
  const renders = join(store.projectPath(p), '.renders', id);
  await mkdir(renders, { recursive: true });
  // a brand-new program re-freezes the reference; revisions keep the one they were written against
  const rig = body.useReference ? await buildRig(p, design, renders, !(body.fromCurrent && design.code && design.codeRig)) : null;
  if (body.useReference && !rig) throw new store.HttpError(400, 'This character has no reference sprite in the library yet');
  // a revision keeps the mode of the program it revises
  if (body.fromCurrent && design.code && design.codeRig !== !!rig) throw new store.HttpError(400, design.codeRig ? 'The current program animates the reference; keep "Use reference" on, or redraw from scratch' : 'The current program was drawn from scratch; turn "Use reference" off, or redraw');
  const refRow = rig ? paddedReference(rig) : undefined;

  return streamSSE(c, async stream => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    let usage = ZERO;
    let code = body.fromCurrent ? design.code : null;
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
            : error ? 'Fixing an error in the program…' : feedback ? 'Applying your feedback…' : `Reviewing the render and fixing problems (round ${i} of ${rounds})…`,
        });
        const r = needsWrite
          ? await writeProgram(style, design, anims, model, feedback, rig)
          : await reviseProgram(style, design, anims, model, { code: code!, sheetPath, sheetAnims: focus, error, feedback }, rig);
        await logUsage(store.projectPath(p), needsWrite ? 'code-write' : 'code-revise', r);
        usage = sum(usage, r.usage);
        code = r.data.code;

        await send('status', { step: 'rendering', iteration: i + 1, total, message: 'Rendering frames…' });
        try {
          const out = executeProgram(code, colors, anims.map(a => a.name), rig);
          lastGood = code; lastOut = out;
          await send('iteration', { iteration: i + 1, total, notes: r.data.notes, code, usage: r.usage, preview: dataUrl(encodePng(contactSheet(out, 1500, refRow))), packed: pack(out) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // the next round (if any) sees this error and fixes it; otherwise we finish with the last good program
          await send('iteration', { iteration: i + 1, total, notes: r.data.notes, code, usage: r.usage, error: msg });
        }
      }
      if (lastGood) await store.saveCharacter(p, id, { ...(await store.getCharacter(p, id)), code: lastGood, codeRig: !!rig });
      await send('done', { ok: !!lastGood, code: lastGood ?? code, usage, packed: lastOut ? pack(lastOut) : null, cell: cellFor(design) });
    } catch (e) {
      await send('fail', { message: e instanceof Error ? e.message : String(e), usage });
    }
  });
});
