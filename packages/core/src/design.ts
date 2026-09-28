import { rampFor } from './color.ts';
import { PLATFORMER_MOVES, type MovePreset } from './prompts.ts';
import type { CharacterDesign, MoveDraft, StyleBible } from './schema.ts';
import { slugify } from './schema.ts';

export const PART_PRESETS: { name: string; color: string }[] = [
  { name: 'Skin', color: '#e8b796' },
  { name: 'Hair', color: '#5a3a2e' },
  { name: 'Eyes', color: '#3f7fd0' },
  { name: 'Main cloth', color: '#3d5aa8' },
  { name: 'Second cloth', color: '#8a8f99' },
  { name: 'Accent', color: '#d84a3a' },
  { name: 'Metal', color: '#b8c0cc' },
  { name: 'Leather', color: '#7a4e2d' },
  { name: 'Weapon', color: '#c9a34a' },
];

export const partSlug = (name: string) => slugify(name);

/**
 * The design's palette as named colors: every part becomes three names
 * (`hair.shadow`, `hair`, `hair.light`), plus `outline`. Sprite programs draw with these
 * names; prompts list them as exact hex; imports lock to them.
 */
export function designColors(d: Pick<CharacterDesign, 'parts' | 'outline'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of d.parts) {
    const s = partSlug(p.name), r = rampFor(p.color);
    out[`${s}.shadow`] = r.shadow;
    out[s] = r.base;
    out[`${s}.light`] = r.light;
  }
  if (d.outline) out.outline = d.outline;
  return out;
}

export function designPalette(d: Pick<CharacterDesign, 'parts' | 'outline'>): string[] {
  return [...new Set(Object.values(designColors(d)))];
}

/** What the user typed, merged into one brief (used when no polished description exists yet). */
export function rawBrief(d: CharacterDesign): string {
  return [
    d.build && `Build: ${d.build}.`,
    d.outfit && `Outfit: ${d.outfit}.`,
    d.details && `Signature details: ${d.details}.`,
    d.personality && `Personality (show it in posture and expression): ${d.personality}.`,
    d.lore && `Background: ${d.lore}`,
  ].filter(Boolean).join(' ');
}

function colorLines(d: CharacterDesign): string[] {
  if (!d.parts.length) return [];
  return [
    'Exact colors (use these hex values, flat fills, no gradients):',
    ...d.parts.map(p => {
      const r = rampFor(p.color);
      return `- ${p.name}: base ${r.base}, shadow ${r.shadow}, highlight ${r.light}`;
    }),
    ...(d.outline ? [`- Outline: ${d.outline}`] : []),
  ];
}

function formLines(style: StyleBible, d: CharacterDesign): string[] {
  const lines = [
    `Perspective: ${style.perspective === 'side' ? 'side view, character facing right' : style.perspective}.`,
    `Pixel art: the character is about ${d.pixelHeight} pixels tall, drawn with crisp, square, hard-edged pixels. No blur, no anti-aliasing, no gradients, no painterly texture, no dithering noise.`,
    `Light comes from the ${style.lightDirection === 'front' ? 'front' : style.lightDirection.replace('-', ' ')}.`,
    d.outline ? `A clean 1-pixel outline in ${d.outline} around the character.` : 'No outline.',
  ];
  if (style.notes.trim()) lines.push(`Art direction: ${style.notes.trim()}`);
  return lines;
}

const BACKDROP = [
  'Background: one flat, solid pure green (#00FF00) everywhere. No gradient, no texture, no checkerboard, no floor, no shadow under the character.',
  'No text, no labels, no numbers, no frame borders, no grid lines, no watermark.',
];

const describe = (d: CharacterDesign) => (d.description.trim() || rawBrief(d) || '(describe the character in the Design tab)');

/**
 * Grid Gemini can actually produce: it will not reliably put more than 4 poses in a row,
 * so longer moves become rows of 3-4 cells read left to right, top to bottom.
 */
export function layoutFor(frames: number): { rows: number; cols: number } {
  if (frames <= 4) return { rows: 1, cols: frames };
  if (frames <= 8) return { rows: 2, cols: Math.ceil(frames / 2) };
  if (frames <= 12) return { rows: 3, cols: Math.ceil(frames / 3) };
  return { rows: Math.ceil(frames / 4), cols: 4 };
}

function invariantLines(d: CharacterDesign, every: boolean): string[] {
  const inv = d.invariants.map(s => s.trim()).filter(Boolean);
  if (!inv.length) return [];
  return [
    every ? `NEVER CHANGES: these must be true in EVERY single frame, with no exceptions:` : 'Defining features (make them unmistakable):',
    ...inv.map(s => `- ${s}`),
  ];
}

/** Gemini prompt for the reference design (step 1). */
export function designReferencePrompt(style: StyleBible, d: CharacterDesign): string {
  return [
    `Create a single pixel-art game sprite of ${d.name}.`,
    `The character: ${describe(d)}`,
    ...invariantLines(d, false),
    `Pose: ${d.referencePose || 'neutral standing idle pose'}, full body visible from head to feet, centered.`,
    ...colorLines(d),
    ...formLines(style, d),
    ...BACKDROP,
    'This image is the reference design for all of the character\'s animations, so keep the design clear, readable and simple enough to redraw consistently.',
  ].join('\n');
}

/**
 * Gemini prompt for a dialogue portrait: head and shoulders, bigger than the sprite so
 * the face reads, same colors and outline, the personality in the expression.
 */
export function designPortraitPrompt(style: StyleBible, d: CharacterDesign, size = 64): string {
  return [
    `Using the attached reference image of ${d.name}, create a pixel-art bust portrait of the SAME character for a game dialogue box.`,
    `The character: ${describe(d)}`,
    ...invariantLines(d, false),
    `Framing: head and shoulders only, three-quarter view facing right, filling a ${size}x${size} pixel square.`,
    d.personality ? `Expression: show their personality: ${d.personality}.` : 'Expression: a clear, characterful expression.',
    ...colorLines(d),
    `Pixel art at ${size}x${size}: crisp square pixels, no blur, no anti-aliasing, no gradients.${d.outline ? ` A clean 1-pixel outline in ${d.outline}.` : ''}`,
    ...(style.notes.trim() ? [`Art direction: ${style.notes.trim()}`] : []),
    ...BACKDROP,
  ].join('\n');
}

/**
 * Gemini prompt for one animation sheet (step 2). Structured so the generator keeps the
 * character on-model (invariants repeated and checked), honours the grid it can actually
 * draw, and keeps one scale across frames. Poses and move notes come from Claude's draft.
 */
export function designMovePrompt(style: StyleBible, d: CharacterDesign, m: MoveDraft): string {
  const preset = PLATFORMER_MOVES.find(p => p.id === m.id);
  const poses = m.poses.length === m.frames ? m.poses : preset && preset.frames === m.frames ? preset.poses : m.poses;
  const { rows, cols } = layoutFor(m.frames);
  const inv = d.invariants.map(s => s.trim().replace(/[.;]+$/, '')).filter(Boolean);
  const where = (i: number) => (rows > 1 ? ` (row ${Math.floor(i / cols) + 1}, column ${(i % cols) + 1})` : '');
  return [
    `Using the attached reference image of ${d.name}, create a pixel-art sprite sheet of the SAME character performing: ${m.name}.`,
    '',
    'CHARACTER: must match the reference image exactly (same design, proportions, colors, clothes, details):',
    describe(d),
    ...invariantLines(d, true),
    '',
    'THE MOVE',
    ...(m.description.trim() ? [`How ${d.name} performs it: ${m.description.trim()}`] : []),
    ...(m.notes.trim() ? [`Direction: ${m.notes.trim()}`] : []),
    ...(m.effects.trim() ? [`Effects: ${m.effects.trim()}`] : []),
    `Motion weight: ${m.weight === 'heavy' ? 'heavy and powerful (big anticipation, strong impact, slower recovery)' : m.weight === 'light' ? 'light and quick (small anticipation, snappy)' : 'normal'}.`,
    ...(m.loop ? ['It loops: the last frame must flow smoothly back into the first.'] : []),
    'The character stays in place (no travel across the sheet), facing right in every frame.',
    '',
    'LAYOUT',
    rows > 1
      ? `A grid of ${rows} rows x ${cols} columns = exactly ${m.frames} frames. Read order: left to right, top row first.`
      : `Exactly ${m.frames} frames in one horizontal row, left to right.`,
    'Every cell is the same size with one pose centered in it and clear empty space between cells; poses never touch or cross into another cell.',
    'SAME SCALE IN EVERY FRAME: the character is drawn at exactly the same size in every cell (same head size, same standing height, same pixel size). Do not zoom in or out between frames. Feet rest on the same ground line in every cell of a row.',
    '',
    'FRAMES',
    ...poses.map((p, i) => `${i + 1}${where(i)}: ${p}`),
    '',
    ...colorLines(d),
    ...formLines(style, d),
    ...BACKDROP,
    '',
    `BEFORE FINISHING, check: there are exactly ${m.frames} frames${rows > 1 ? ` in a ${rows}x${cols} grid` : ''}; every frame is the same scale${inv.length ? `; every frame shows: ${inv.join('; ')}` : ''}; colors match the reference. Fix any frame that fails.`,
  ].join('\n');
}

/** A new move draft seeded from a preset (or blank for custom moves). */
export function newMove(presetId: string | null, name?: string): MoveDraft {
  const p: MovePreset | undefined = PLATFORMER_MOVES.find(m => m.id === presetId);
  const label = name?.trim() || p?.name || 'Custom move';
  return {
    id: slugify(presetId && !name ? presetId : label),
    name: label,
    description: '',
    frames: p?.frames ?? 6,
    fps: p?.fps ?? 10,
    loop: p?.loop ?? false,
    weight: 'normal',
    poses: p ? [...p.poses] : [],
    notes: '',
    effects: '',
    refImages: [],
  };
}
