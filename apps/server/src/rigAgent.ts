import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  CharacterRig, contactSheet, RigClip, renderClip, rigCanvas,
  type CharacterDesign, type RigPart, type StyleBible,
} from '@kinetome/core';
import { runClaude, logUsage, type ClaudeResult, type ClaudeUsage, type Model } from './claude.ts';
import { encodePng } from './png.ts';
import { buildRig } from './rig.ts';
import * as store from './store.ts';

/**
 * The rig route to animation: parts and joints are cut ONCE (by hand in the rig editor,
 * or by Claude here), then every move is just keyframes: a few angles per joint. Claude
 * answers in small JSON instead of whole programs, and the renderer moves the reference's
 * real pixels, so nothing can drift off model.
 */

const rendersDir = (p: string, id: string) => join(store.projectPath(p), '.renders', id);
const ZERO: ClaudeUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, ms: 0 };
const add = (a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage => ({ input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, costUsd: a.costUsd + b.costUsd, ms: a.ms + b.ms });

async function reference(p: string, d: CharacterDesign) {
  const dir = rendersDir(p, d.id);
  await mkdir(dir, { recursive: true });
  const rig = await buildRig(p, d, dir);
  if (!rig) throw new store.HttpError(400, `${d.name} needs a reference sprite in the library first (Reference step)`);
  return rig;
}

const partsText = (parts: RigPart[]) => parts.map(p => `- ${p.name}: joint at (${p.pivot.map(v => Math.round(v)).join(', ')}), parent ${p.parent ?? '(root)'}, draw order ${p.z}`).join('\n');

// ---------- Claude cuts the parts ----------

const partsSchema = {
  type: 'object', additionalProperties: false, required: ['parts', 'notes'],
  properties: {
    notes: { type: 'string' },
    parts: {
      type: 'array', minItems: 2, maxItems: 24,
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'poly', 'pivot', 'parent', 'z'],
        properties: {
          name: { type: 'string' },
          poly: { type: 'array', minItems: 3, maxItems: 16, items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
          pivot: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          parent: { type: ['string', 'null'] },
          z: { type: 'number' },
        },
      },
    },
  },
};

async function suggestParts(style: StyleBible, d: CharacterDesign, rig: Awaited<ReturnType<typeof reference>>, model: Model): Promise<ClaudeResult<{ parts: RigPart[]; notes: string }>> {
  return runClaude({
    task: 'rig-parts', model, timeoutMs: 600_000, thinking: 3000,
    tools: ['Read'], dirs: [rig.imagePath.replace(/\/[^/]+$/, '')],
    system: 'You are a 2D cut-out animation rigger for pixel-art game sprites. You cut a character into parts with joints so it can be animated by rotating its real pixels. Reply only through the structured output.',
    prompt: [
      `Rig ${d.name} for animation. First Read the reference image at ${rig.imagePath} (scaled up, grid lines every 10 reference pixels), then use the exact pixel map to place polygons and joints.`,
      `Character: ${d.description || d.name}. ${style.perspective === 'side' ? 'Side view facing right: the near side (towards the viewer) is the character\'s LEFT.' : ''}`,
      d.invariants.length ? `Must stay visible and intact: ${d.invariants.join('; ')}.` : '',
      '',
      rig.pixelMap,
      '',
      'Cut these parts (skip any the art does not show; add props like a staff, a scarf, a wooden leg or a weapon as their own parts):',
      'torso (the root, parent null), head (parent torso, joint at the neck), for each visible arm: upper arm (joint at the shoulder) and forearm+hand (joint at the elbow), for each visible leg: thigh (joint at the hip) and shin+foot (joint at the knee).',
      'Rules:',
      '- Coordinates are REFERENCE pixels from the map. A polygon claims the opaque pixels inside it; make each polygon hug its part with a pixel or two of slack. Overlaps are fine: the higher draw order wins a pixel.',
      '- Every opaque pixel should be inside some polygon (pixels outside all polygons stay glued to the torso).',
      '- Joint (pivot) = the point the part rotates around, placed at the real joint (shoulder, elbow, hip, knee, neck), usually at the edge where it meets its parent.',
      '- Draw order: far limbs behind the torso (negative, e.g. -2 upper, -1 lower), torso 0, head 1, near limbs in front (2 upper, 3 lower), held props above the hand holding them.',
      '- Names: short lowercase with near/far, e.g. "far thigh", "near forearm", "staff".',
      'In notes, one line per part saying which pixels it covers.',
    ].filter(Boolean).join('\n'),
    schema: partsSchema,
  }).then(r => ({ ...r, data: { notes: (r.data as { notes: string }).notes, parts: (r.data as { parts: RigPart[] }).parts.map(p => ({ ...p, pivot: [p.pivot[0], p.pivot[1]] as [number, number], poly: p.poly.map(q => [q[0], q[1]] as [number, number]) })) } }));
}

// ---------- Claude keys a move ----------

const keysSchema = {
  type: 'object', additionalProperties: false, required: ['keys', 'notes'],
  properties: {
    notes: { type: 'string' },
    keys: {
      type: 'array', minItems: 1, maxItems: 48,
      items: {
        type: 'object', additionalProperties: false, required: ['frame', 'ease', 'pose'],
        properties: {
          frame: { type: 'integer', minimum: 0 },
          ease: { type: 'string', enum: ['linear', 'in', 'out', 'inOut', 'hold'] },
          pose: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['part', 'angle', 'dx', 'dy'], properties: { part: { type: 'string' }, angle: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' } } },
          },
        },
      },
    },
  },
};

type KeyOut = { keys: { frame: number; ease: RigClip['keys'][number]['ease']; pose: { part: string; angle: number; dx: number; dy: number }[] }[]; notes: string };

function toClip(out: KeyOut, frames: number, fps: number, loop: boolean, parts: RigPart[]): RigClip {
  const names = new Set(parts.map(p => p.name));
  return RigClip.parse({
    frames, fps, loop,
    keys: out.keys.filter(k => k.frame < frames).map(k => ({
      frame: k.frame, ease: k.ease,
      pose: Object.fromEntries(k.pose.filter(q => names.has(q.part)).map(q => [q.part, { angle: q.angle, dx: q.dx, dy: q.dy }])),
    })),
  });
}

const clipText = (clip: RigClip) => clip.keys.map(k => `frame ${k.frame} (${k.ease}): ${Object.entries(k.pose).map(([n, q]) => `${n} ${Math.round(q.angle)}°${q.dx || q.dy ? ` +(${Math.round(q.dx)},${Math.round(q.dy)})` : ''}`).join(', ') || 'neutral'}`).join('\n');

async function keyMove(style: StyleBible, d: CharacterDesign, parts: RigPart[], moveId: string, model: Model, imagePath: string, prev?: { clip: RigClip; sheet?: string; feedback?: string }): Promise<ClaudeResult<KeyOut>> {
  const m = d.moves.find(x => x.id === moveId);
  if (!m) throw new store.HttpError(404, `no move ${moveId}`);
  const dirs = [...new Set([imagePath, prev?.sheet].filter((f): f is string => !!f).map(f => f.replace(/\/[^/]+$/, '')))];
  return runClaude<KeyOut>({
    task: 'rig-keys', model, timeoutMs: 600_000, thinking: 2500,
    tools: ['Read'], dirs,
    system: 'You are a senior 2D game animator keyframing a cut-out pixel-art rig. You use animation principles: anticipation, clear key poses, overlap and follow-through, arcs, weight, and holds on impact. Reply only through the structured output.',
    prompt: [
      `Keyframe ${d.name}'s "${m.name}". Read the reference at ${imagePath} to see the character and its parts.`,
      `${m.frames} frames (0..${m.frames - 1}) at ${m.fps} fps, ${m.loop ? 'looping: the last frame must flow back into frame 0' : 'plays once'}. Weight: ${m.weight}.`,
      m.description && `How ${d.name} performs it: ${m.description}`,
      m.poses.length ? `Pose plan, one line per frame:\n${m.poses.map((p, i) => `${i}. ${p}`).join('\n')}` : '',
      m.notes && `Direction: ${m.notes}`,
      d.invariants.length ? `Keep these readable in every frame: ${d.invariants.join('; ')}.` : '',
      '',
      'The rig (reference pixel coordinates, y grows DOWN):',
      partsText(parts),
      '',
      'Each key sets, per part, angle (degrees CLOCKWISE, relative to its parent: rotating a thigh also swings its shin) and dx, dy (pixels, mostly for the root: bob, lean, recoil). Parts you leave out of a key are neutral (0).',
      `Facing right: a positive angle on a forward-pointing limb swings it DOWN; a leg swinging forward is a NEGATIVE thigh angle. Keep angles plausible (thigh -45..45, knee 0..90 bending backwards is positive for a side view facing right, elbow 0..120).`,
      'Put a key on every storytelling pose (contacts, passing, anticipation, impact, recovery); in-betweens are interpolated with the ease you pick (hold = stay until the next key). The character stays in place (no travel along x); small root dy for bob.',
      prev?.sheet ? `\nYour previous keys rendered to ${prev.sheet} (first cell = the reference, then each frame). Read it, find what reads wrong (broken silhouettes, limbs through the body, stiff or floaty timing, drifting feet) and fix the keys.` : '',
      prev ? `Previous keys:\n${clipText(prev.clip)}` : '',
      prev?.feedback ? `User notes, follow them: ${prev.feedback}` : '',
      '\nIn notes, 2-4 sentences on the key poses and timing.',
    ].filter(Boolean).join('\n'),
    schema: keysSchema,
  });
}

// ---------- routes ----------

export const rigApi = new Hono();

/** The frozen reference the rig's coordinates refer to. */
rigApi.get('/projects/:p/characters/:c/rig/reference.png', async c => {
  const d = await store.getCharacter(c.req.param('p'), c.req.param('c'));
  const rig = await reference(c.req.param('p'), d);
  return c.body(new Uint8Array(encodePng(rig.ref)), 200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
});
rigApi.get('/projects/:p/characters/:c/rig/reference.json', async c => {
  const d = await store.getCharacter(c.req.param('p'), c.req.param('c'));
  const rig = await reference(c.req.param('p'), d);
  const canvas = rigCanvas(rig.ref);
  return c.json({ width: rig.ref.width, height: rig.ref.height, pivot: rig.refPivot, canvas });
});

rigApi.post('/projects/:p/characters/:c/rig/suggest', async c => {
  const p = c.req.param('p');
  const { model = 'sonnet' } = await c.req.json<{ model?: Model }>().catch(() => ({ model: 'sonnet' as Model }));
  const d = await store.getCharacter(p, c.req.param('c'));
  const { style } = await store.getProject(p);
  const rig = await reference(p, d);
  const r = await suggestParts(style, d, rig, model);
  await logUsage(store.projectPath(p), 'rig-parts', r);
  const fresh = await store.getCharacter(p, d.id);
  const saved = await store.saveCharacter(p, d.id, { ...fresh, rig: CharacterRig.parse({ parts: r.data.parts, clips: fresh.rig?.clips ?? {} }) });
  return c.json({ design: saved, notes: r.data.notes, usage: r.usage });
});

rigApi.post('/projects/:p/characters/:c/rig/animate', async c => {
  const p = c.req.param('p');
  const body = await c.req.json<{ move: string; model?: Model; rounds?: number; feedback?: string }>();
  const model = body.model ?? 'sonnet', rounds = Math.max(0, Math.min(2, body.rounds ?? 1));
  const d = await store.getCharacter(p, c.req.param('c'));
  const { style } = await store.getProject(p);
  if (!d.rig?.parts.length) throw new store.HttpError(400, 'cut the rig parts first');
  const m = d.moves.find(x => x.id === body.move);
  if (!m) throw new store.HttpError(404, `no move ${body.move}`);
  const rig = await reference(p, d);
  const parts = d.rig.parts;
  let usage = ZERO, notes = '';
  const existing = d.rig.clips[m.id];
  let clip: RigClip;
  // first pass: new keys, or a revision of the existing clip when there are notes
  const first = await keyMove(style, d, parts, m.id, model, rig.imagePath, existing && body.feedback ? { clip: existing, feedback: body.feedback } : undefined);
  usage = add(usage, first.usage); notes = first.data.notes;
  clip = toClip(first.data, m.frames, m.fps, m.loop, parts);
  // review passes: Claude looks at what its keys actually render to and fixes them
  for (let i = 0; i < rounds; i++) {
    const frames = renderClip(rig.ref, parts, clip);
    const cv = rigCanvas(rig.ref);
    // the reference first, then every frame: what Claude compares its keys against
    const refCell = { width: cv.width, height: cv.height, data: new Uint8ClampedArray(cv.width * cv.height * 4) };
    for (let y = 0; y < rig.ref.height; y++) refCell.data.set(rig.ref.data.subarray(y * rig.ref.width * 4, (y + 1) * rig.ref.width * 4), ((y + cv.pad) * cv.width + cv.pad) * 4);
    const sheet = contactSheet({ width: cv.width, height: cv.height, pivot: { x: rig.refPivot.x + cv.pad, y: rig.refPivot.y + cv.pad }, animations: [{ name: m.id, fps: m.fps, loop: m.loop, frames }] }, 1500, refCell);
    const sheetPath = join(rendersDir(p, d.id), `rig-${m.id}-review.png`);
    await writeFile(sheetPath, encodePng(sheet));
    const rev = await keyMove(style, d, parts, m.id, model, rig.imagePath, { clip, sheet: sheetPath, feedback: body.feedback });
    usage = add(usage, rev.usage); notes = rev.data.notes;
    clip = toClip(rev.data, m.frames, m.fps, m.loop, parts);
  }
  await logUsage(store.projectPath(p), 'rig-keys', { data: null, usage, model });
  const fresh = await store.getCharacter(p, d.id);
  const saved = await store.saveCharacter(p, d.id, { ...fresh, rig: { parts: fresh.rig?.parts ?? parts, clips: { ...(fresh.rig?.clips ?? {}), [m.id]: clip } } });
  return c.json({ design: saved, clip, notes, usage });
});

