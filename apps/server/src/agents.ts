import vm from 'node:vm';
import {
  designColors, GFX_REFERENCE, makeGfx, PLATFORMER_MOVES, rawBrief, RIG_REFERENCE, validateProgram,
  type AnimSpec, type CharacterDesign, type Gfx, type MoveDraft, type PartSpec, type RenderOutput, type StyleBible,
} from '@sprite/core';
import type { RigContext } from './rig.ts';
import { runClaude, type ClaudeResult, type Model } from './claude.ts';

// ---------- shared context ----------

function designContext(style: StyleBible, d: CharacterDesign): string {
  return [
    `Character: ${d.name}`,
    d.description && `Current visual description: ${d.description}`,
    d.build && `Build: ${d.build}`,
    d.outfit && `Outfit: ${d.outfit}`,
    d.details && `Signature details: ${d.details}`,
    d.invariants.length && `Must never change (every frame): ${d.invariants.join('; ')}`,
    d.personality && `Personality: ${d.personality}`,
    d.lore && `Lore: ${d.lore}`,
    d.parts.length && `Color parts: ${d.parts.map(p => `${p.name} (${p.color})`).join(', ')}`,
    `Sprite height: about ${d.pixelHeight}px. Perspective: ${style.perspective === 'side' ? 'side view facing right' : style.perspective}.`,
    style.notes && `Project art direction: ${style.notes}`,
  ].filter(Boolean).join('\n');
}

// ---------- 1. polish the visual description ----------

export async function polishDescription(style: StyleBible, d: CharacterDesign, model: Model): Promise<ClaudeResult<{ description: string; referencePose: string; invariants: string[]; conflicts: string[] }>> {
  return runClaude({
    task: 'describe', model, timeoutMs: 90_000,
    system: 'You are the art director of a pixel-art game. You turn character notes into short, concrete visual descriptions that image generators follow reliably. Reply only through the structured output.',
    prompt: [
      designContext(style, d),
      '',
      'Write:',
      `1. description: at most 70 words, purely visual (silhouette, proportions, each clothing piece and which color part it uses, hairstyle, face, signature details). Keep only details that still read at ${d.pixelHeight}px tall; merge or drop tiny ones. Show personality through posture/expression words. No lore prose, no hex codes (colors are listed separately).`,
      '2. referencePose: one short line for the reference image pose that shows the silhouette and weapon clearly (side view facing right).',
      '3. invariants: 2 to 6 short, concrete, checkable rules for features an image generator tends to forget between frames: missing or artificial limbs (and WHICH side), scars and eye patches (which side), weapons and where they are carried, asymmetric clothing, hair shape, body proportions. Name sides as the character\'s own left/right. Each rule must be visible in a drawing, e.g. "Left leg is a wooden peg from the knee down; never draw a normal left foot". Keep the user\'s existing rules if they are still correct.',
      '4. conflicts: short warnings where the color parts contradict the notes (e.g. "Outfit says white robe but Main cloth is blue #3d5aa8"), or a feature in the notes has no color part. Empty if consistent. Follow the NOTES in the description (they are the user\'s intent), not a contradicting color.',
      d.description ? 'Improve the current description rather than replacing what the user clearly wants.' : '',
    ].join('\n'),
    schema: {
      type: 'object', additionalProperties: false, required: ['description', 'referencePose', 'invariants', 'conflicts'],
      properties: {
        description: { type: 'string' }, referencePose: { type: 'string' },
        invariants: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } },
        conflicts: { type: 'array', maxItems: 6, items: { type: 'string' } },
      },
    },
  });
}

// ---------- 2. draft a move frame by frame ----------

export async function draftMove(style: StyleBible, d: CharacterDesign, m: MoveDraft, model: Model, instruction?: string): Promise<ClaudeResult<{ poses: string[]; notes: string }>> {
  const preset = PLATFORMER_MOVES.find(p => p.id === m.id);
  return runClaude({
    task: 'move', model, timeoutMs: 90_000,
    system: 'You are a senior 2D game animator directing pixel-art sprite sheets. You break moves into key poses using animation principles (anticipation, action, follow-through, overlap, squash and stretch, clear silhouettes). Reply only through the structured output.',
    prompt: [
      designContext(style, d),
      '',
      `Move: ${m.name}. ${m.frames} frames at ${m.fps} fps, ${m.loop ? 'looping (last frame flows into the first)' : 'plays once'}. Weight: ${m.weight}.`,
      m.description && `How ${d.name} performs it (the user's words, follow them closely): ${m.description}`,
      preset && !m.description && `Standard breakdown for reference: ${preset.poses.join(' | ')}`,
      m.poses.length && instruction ? `Current poses:\n${m.poses.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
      instruction ? `Revise the poses according to this request: ${instruction}` : '',
      '',
      m.notes && instruction ? `Current direction notes: ${m.notes}` : '',
      '',
      'First think about how THIS character\'s body, gear and story change the move (a wooden leg makes a walk limp and stiff on that side; a heavy weapon slows the wind-up; an arrogant personality shows in posture). Put that in notes: at most 60 words of direction for the image generator.',
      `Then write exactly ${m.frames} poses, one per frame, each at most 32 words: body lean, legs, arms, weapon/hands, head, and any effect (smear, dust, spark).`,
      'In a side view facing right, the character\'s LEFT side is the near side (towards the viewer). Name limbs as "near/far" plus the character\'s own left/right so nothing gets mirrored.',
      d.invariants.length ? `Whenever a pose shows a body part covered by the must-never-change rules, state that feature explicitly in that pose (e.g. "far right leg forward, near wooden peg (left leg) planted stiff") so the generator cannot drop it.` : '',
      'The character faces right in every frame, stays in place (no travel) and keeps the same size; only natural bob changes the height. Make the key frame (the hit, the peak) unmistakable as a silhouette.',
    ].filter(Boolean).join('\n'),
    schema: {
      type: 'object', additionalProperties: false, required: ['notes', 'poses'],
      properties: {
        notes: { type: 'string' },
        poses: { type: 'array', minItems: m.frames, maxItems: m.frames, items: { type: 'string' } },
      },
    },
  });
}

// ---------- 3. draw with code ----------

export interface CodeAnim { name: string; frames: number; fps: number; loop: boolean; description: string; poses: string[] }

/** Cell size that fits the design's height with room for weapons and effects. */
export function cellFor(d: CharacterDesign) {
  const h = d.pixelHeight + Math.max(8, Math.round(d.pixelHeight * 0.3));
  const w = Math.round(d.pixelHeight * 1.4);
  return { width: w, height: h, pivot: [Math.floor(w / 2), h - 3] as [number, number] };
}

function rigSystem(style: StyleBible, d: CharacterDesign, rig: RigContext): string {
  const colors = designColors(d);
  return [
    'You are a senior pixel-art animator. You animate an EXISTING, approved sprite (the reference, drawn by an artist) by writing a JavaScript cut-out rig: you slice the reference into parts and move those real pixels frame by frame. You never redraw the character from scratch. Reply only through the structured output; `code` must be the complete program.',
    '',
    'CONTRACT',
    'Define exactly: const sprite = { width, height, pivot: [x, y], parts: { name: { poly: [[x,y],...], pivot: [x,y] } }, animations: { name: { frames, fps, loop } }, draw(g, anim, frame, t) { ... } };',
    `Use height ${rig.height} and pivot [${rig.pivot.join(', ')}]. Width is at least ${rig.width}; you may widen it up to 256 to make room on the RIGHT for effects (the character stays where it is). Reference pixel (x, y) is at canvas (x + ${rig.pad}, y + ${rig.pad}); part polygons and pivots use REFERENCE coordinates; g.px/rect/etc use CANVAS coordinates.`,
    'draw() is called once per frame on a blank transparent canvas; t = frame / frames (0 .. <1). Plain JavaScript only: no imports, no DOM, no timers, no Math.random (use g.rand()).',
    '',
    'DRAWING API (g)',
    RIG_REFERENCE,
    GFX_REFERENCE,
    '',
    'PALETTE (the reference is drawn in exactly these colors; use the names for any new pixels)',
    Object.entries(colors).map(([k, v]) => `${k} = ${v}`).join('\n'),
    '',
    'CRAFT RULES',
    '- Keep the reference\'s look: most pixels in every frame must come from g.part(). Split so that each moving piece is its own part: typically body/torso (usually stays), head (+ beard/hair), near arm, far arm, near leg/foot, far leg/foot, and loose cloth (scarf, cape, robe hem, sash ends) for follow-through.',
    '- Parts can overlap in their polygons; draw back to front: far limbs, body, head, near limbs, loose cloth/effects.',
    '- Motion: small, clean offsets read best in pixel art. Whole-pixel translations for bob and sway (1-3px); rotations only where a limb swings, around its joint pivot, and keep angles modest (up to ~25 degrees) because rotated pixel art gets jaggy.',
    '- When a moving part uncovers a gap (e.g. the leg moved and exposes empty space under the robe), patch it with a few pixels in the right palette color, or draw a new simple limb segment with g.line/g.poly. Keep patches minimal and consistent frame to frame.',
    '- Everything in the must-never-change list stays visible in every frame (it comes from the reference, so do not crop it out of the parts).',
    '- Feet/contact points on the ground row in grounded frames; the loop closes seamlessly; body bob by whole pixels.',
    '- Be concise: part table, a keyframe table per animation, one draw helper. Aim for under 200 lines. Do not call g.outline() (the reference already has its outline) unless you drew new silhouette pixels that need it.',
  ].join('\n');
}

function codeSystem(style: StyleBible, d: CharacterDesign, rig?: RigContext | null): string {
  if (rig) return rigSystem(style, d, rig);
  const colors = designColors(d);
  const cell = cellFor(d);
  return [
    'You are a pixel artist who draws game sprites with code. You write a JavaScript sprite program that a renderer executes to produce every animation frame. Reply only through the structured output; `code` must be the complete program.',
    '',
    'CONTRACT',
    'Define exactly: const sprite = { width, height, pivot: [x, y], animations: { name: { frames, fps, loop } }, draw(g, anim, frame, t) { ... } };',
    `Use width ${cell.width}, height ${cell.height}, pivot [${cell.pivot.join(', ')}] (pivot = ground point between the feet; feet stand on row ${cell.pivot[1]}).`,
    'draw() is called once per frame on a blank transparent canvas; t = frame / frames (0 .. <1). Plain JavaScript only: no imports, no DOM, no timers, no Math.random (use g.rand()).',
    '',
    'DRAWING API (g)',
    GFX_REFERENCE,
    '',
    'PALETTE (the only allowed color names)',
    Object.entries(colors).map(([k, v]) => `${k} = ${v}`).join('\n'),
    '',
    'CRAFT RULES',
    `- The character is about ${d.pixelHeight}px tall, side view facing right, and stays in place (no travel across frames).`,
    `- Shade every part: <part>.shadow on the side away from the light (light from ${style.lightDirection}), <part>.light on edges facing it, <part> for the rest.`,
    '- Write reusable helpers (e.g. drawBody(g, pose)) driven by a pose object of joint angles/offsets, and compute each frame\'s pose by easing between keyframes. The character must look identical across all animations.',
    '- Draw back to front (far arm/leg, torso, head, near arm/leg, weapon, effects), then call g.outline() last so the silhouette is crisp.',
    '- Readable silhouette at 1x, clean pixel clusters, no single stray pixels, feet planted on the ground row in grounded frames.',
    '- Use animation principles: anticipation, strong key pose, follow-through; loops must close seamlessly.',
    '- Be concise: one shared body/pose helper, keyframe tables per animation, no comments beyond short labels. Aim for under 220 lines.',
  ].join('\n');
}

function animLines(anims: CodeAnim[]): string {
  return anims.map(a => [
    `- ${a.name}: ${a.frames} frames, ${a.fps} fps, ${a.loop ? 'loop' : 'once'}${a.description ? `. How: ${a.description}` : ''}`,
    ...a.poses.map((p, i) => `    ${i + 1}. ${p}`),
  ].join('\n')).join('\n');
}

export async function writeProgram(style: StyleBible, d: CharacterDesign, anims: CodeAnim[], model: Model, feedback?: string, rig?: RigContext | null): Promise<ClaudeResult<{ code: string; notes: string }>> {
  if (rig) return runClaude({
    task: 'code-write', model, timeoutMs: 900_000,
    system: codeSystem(style, d, rig),
    tools: ['Read'], dirs: [rig.imagePath.replace(/\/[^/]+$/, '')],
    prompt: [
      `Animate ${d.name}. First Read the reference image at ${rig.imagePath} (scaled up; light grid lines every 10 reference pixels) to understand the character, then use the exact pixel map below to cut parts.`,
      `Character: ${d.description || rawBrief(d) || d.name}`,
      d.invariants.length ? `Must stay visible in every frame: ${d.invariants.join('; ')}` : '',
      '',
      rig.pixelMap,
      '',
      'Animations to implement (exact names):',
      animLines(anims),
      feedback ? `\nUser notes: ${feedback}` : '',
      '\nReturn the full program in `code`, and in `notes` list the parts you cut and how each animation moves them.',
    ].filter(Boolean).join('\n'),
    schema: codeSchema,
  });
  return runClaude({
    task: 'code-write', model, timeoutMs: 600_000,
    system: codeSystem(style, d),
    prompt: [
      'Draw this character:',
      d.description || rawBrief(d) || d.name,
      d.details && `Signature details: ${d.details}`,
      d.invariants.length && `Must be visible in every frame: ${d.invariants.join('; ')}`,
      '',
      'Animations to implement (exact names):',
      animLines(anims),
      feedback ? `\nUser notes: ${feedback}` : '',
      '\nReturn the full program in `code` and a one-paragraph summary of your approach in `notes`.',
    ].filter(Boolean).join('\n'),
    schema: codeSchema,
  });
}

export async function reviseProgram(
  style: StyleBible, d: CharacterDesign, anims: CodeAnim[], model: Model,
  prev: { code: string; sheetPath?: string; sheetAnims?: CodeAnim[]; error?: string; feedback?: string },
  rig?: RigContext | null,
): Promise<ClaudeResult<{ code: string; notes: string }>> {
  const dirs = [...new Set([prev.sheetPath, rig?.imagePath].filter((x): x is string => !!x).map(x => x.replace(/\/[^/]+$/, '')))];
  return runClaude({
    task: 'code-revise', model, timeoutMs: rig ? 900_000 : 600_000,
    system: codeSystem(style, d, rig),
    tools: dirs.length ? ['Read'] : [],
    dirs,
    prompt: [
      `Character: ${d.description || rawBrief(d) || d.name}`,
      rig ? `\n${rig.pixelMap}\n` : '',
      rig && prev.sheetPath ? 'In the rendered sheet the FIRST cell (greenish background) is the untouched reference for comparison; every animated frame must look like that character.' : '',
      'Animations (exact names):',
      animLines(anims),
      '',
      'Current program:',
      '```js', prev.code, '```',
      prev.error ? `\nIt FAILED to run: ${prev.error}\nFix the error first.` : '',
      prev.sheetPath ? `\nRead the rendered frames at ${prev.sheetPath} before answering. Layout: ${prev.sheetAnims?.length ? prev.sheetAnims.map(a => `${a.name} (${a.frames} frames)`).join(', ') : anims.map(a => `${a.name} (${a.frames} frames)`).join(', ')}; each animation starts on a new row and its frames run left to right in reading order, wrapping onto the next rows; scaled up; the lighter horizontal line is the ground row.` : '',
      prev.sheetPath ? 'Critique it like a lead pixel artist: anatomy and proportions, silhouette readability, the character looking identical across frames, smooth and weighty motion, feet on the ground line, correct colors per part, stray pixels. Then fix the biggest problems.' : '',
      prev.feedback ? `\nUser feedback (highest priority): ${prev.feedback}` : '',
      '\nReturn the complete improved program in `code`, and in `notes` list what you changed (short).',
    ].filter(Boolean).join('\n'),
    schema: codeSchema,
  });
}

const codeSchema = {
  type: 'object', additionalProperties: false, required: ['code', 'notes'],
  properties: { code: { type: 'string' }, notes: { type: 'string' } },
};

/**
 * Runs inside the VM: a drawing API that only RECORDS commands as plain data. Nothing from
 * the host process is ever placed in the VM (host functions and objects would leak the
 * host's Function constructor, the classic vm escape); results leave as a JSON string.
 */
const RECORDER = `
const __mk = (frame, W, H) => {
  const ops = [];
  const push = op => { if (ops.length > 200000) throw new Error('too many drawing calls in one frame'); ops.push(op); };
  const n = v => { const x = +v; if (!Number.isFinite(x)) throw new Error('coordinate is not a number: ' + v); return x; };
  let seed = 1000 + frame;
  const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    w: W, h: H, __ops: ops,
    px: (x, y, c) => push(['px', n(x), n(y), String(c)]),
    rect: (x, y, w, h, c) => push(['rect', n(x), n(y), n(w), n(h), String(c)]),
    line: (x0, y0, x1, y1, c, t) => push(['line', n(x0), n(y0), n(x1), n(y1), String(c), t === undefined ? 1 : n(t)]),
    circle: (cx, cy, r, c) => push(['ellipse', n(cx), n(cy), n(r), n(r), String(c)]),
    ellipse: (cx, cy, rx, ry, c) => push(['ellipse', n(cx), n(cy), n(rx), n(ry), String(c)]),
    poly: (pts, c) => push(['poly', Array.from(pts || [], p => [n(p[0]), n(p[1])]), String(c)]),
    outline: c => push(['outline', c === undefined ? 'outline' : String(c)]),
    erase: (x, y, w, h) => push(['erase', n(x), n(y), n(w), n(h)]),
    part: (name, dx, dy, angle, opts) => push(['part', String(name), dx === undefined ? 0 : n(dx), dy === undefined ? 0 : n(dy), angle === undefined ? 0 : n(angle), !!(opts && opts.flip)]),
    lerp: (a, b, t) => a + (b - a) * t,
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    ease: t => t * t * (3 - 2 * t),
    easeIn: t => t * t,
    easeOut: t => 1 - (1 - t) * (1 - t),
    wave: t => Math.sin(2 * Math.PI * t),
    rand,
  };
};
const __run = (only) => {
  if (typeof sprite === 'undefined' || !sprite || typeof sprite !== 'object') throw new Error('The code must define const sprite = { width, height, pivot, animations, draw }.');
  const s = sprite;
  if (typeof s.draw !== 'function') throw new Error('sprite.draw(g, anim, frame, t) must be a function');
  const out = { width: s.width, height: s.height, pivot: Array.isArray(s.pivot) ? [+s.pivot[0], +s.pivot[1]] : null, animations: {}, ops: {}, parts: undefined };
  if (s.parts && typeof s.parts === 'object') {
    out.parts = {};
    for (const [k, v] of Object.entries(s.parts)) out.parts[k] = { poly: Array.from((v && v.poly) || [], q => [+q[0], +q[1]]), pivot: v && Array.isArray(v.pivot) ? [+v.pivot[0], +v.pivot[1]] : undefined };
  }
  for (const [name, a] of Object.entries(s.animations || {})) {
    out.animations[name] = { frames: a && a.frames, fps: a && a.fps, loop: !(a && a.loop === false) };
    if (only && !only.includes(name)) continue;
    const frames = Math.max(0, Math.min(24, (a && a.frames) | 0));
    out.ops[name] = [];
    for (let f = 0; f < frames; f++) {
      const g = __mk(f, s.width, s.height);
      try { s.draw(g, name, f, f / frames); }
      catch (e) { throw new Error('draw("' + name + '", frame ' + f + ') failed: ' + (e && e.message ? e.message : e)); }
      out.ops[name].push(g.__ops);
    }
  }
  return JSON.stringify(out);
};`;

type Op = [string, ...unknown[]];

/**
 * Executes a sprite program in an isolated VM context with a hard time limit and replays
 * its recorded drawing commands onto real pixels in the host.
 */
export function executeProgram(code: string, colors: Record<string, string>, only?: string[], rig?: RigContext | null): RenderOutput {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  let json: string;
  try {
    json = vm.runInContext(`${RECORDER}\n${code}\n;__run(${JSON.stringify(only ?? null)});`, context, { timeout: 4000, filename: 'sprite.js' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
    throw new Error(/Script execution timed out/.test(msg) ? 'The program took longer than 4s to render (infinite loop?)' : msg);
  }
  const rec = JSON.parse(String(json)) as { width: number; height: number; pivot: [number, number] | null; animations: Record<string, AnimSpec>; ops: Record<string, Op[][]>; parts?: Record<string, PartSpec> };
  const spec = validateProgram({ ...rec, pivot: rec.pivot ?? undefined, draw: () => {} });
  const animations = Object.entries(spec.animations)
    .filter(([name]) => !only || only.includes(name))
    .map(([name, a]) => ({
      name, fps: a.fps, loop: a.loop !== false,
      frames: (rec.ops[name] ?? []).map((ops, f) => {
        const img = { width: spec.width, height: spec.height, data: new Uint8ClampedArray(spec.width * spec.height * 4) };
        const g = makeGfx(img, colors, 1, rig && spec.parts ? { ref: rig.ref, pad: rig.pad, parts: spec.parts } : undefined);
        try { for (const op of ops) replay(g, op); }
        catch (e) { throw new Error(`draw("${name}", frame ${f}) failed: ${e instanceof Error ? e.message : String(e)}`); }
        return img;
      }),
    }));
  return { width: spec.width, height: spec.height, pivot: { x: Math.round(spec.pivot[0]), y: Math.round(spec.pivot[1]) }, animations };
}

function replay(g: Gfx, op: Op): void {
  const [k, ...a] = op as [string, ...never[]];
  switch (k) {
    case 'px': g.px(a[0], a[1], a[2]); break;
    case 'rect': g.rect(a[0], a[1], a[2], a[3], a[4]); break;
    case 'line': g.line(a[0], a[1], a[2], a[3], a[4], a[5]); break;
    case 'ellipse': g.ellipse(a[0], a[1], a[2], a[3], a[4]); break;
    case 'poly': g.poly(a[0], a[1]); break;
    case 'outline': g.outline(a[0]); break;
    case 'erase': g.erase(a[0], a[1], a[2], a[3]); break;
    case 'part': g.part(a[0], a[1], a[2], a[3], { flip: a[4] }); break;
  }
}
