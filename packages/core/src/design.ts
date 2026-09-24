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

const LAYOUT = [
  'Background: one flat, solid pure green (#00FF00) everywhere. No gradient, no texture, no checkerboard, no floor, no shadow under the character.',
  'No text, no labels, no numbers, no frame borders, no grid lines, no watermark.',
];

const describe = (d: CharacterDesign) => (d.description.trim() || rawBrief(d) || '(describe the character in the Design tab)');

/** Gemini prompt for the reference design (step 1). */
export function designReferencePrompt(style: StyleBible, d: CharacterDesign): string {
  return [
    `Create a single pixel-art game sprite of ${d.name}.`,
    `The character: ${describe(d)}`,
    `Pose: ${d.referencePose || 'neutral standing idle pose'}, full body visible from head to feet, centered.`,
    ...colorLines(d),
    ...formLines(style, d),
    ...LAYOUT,
    'This image is the reference design for all of the character\'s animations, so keep the design clear, readable and simple enough to redraw consistently.',
  ].join('\n');
}

/** Gemini prompt for one animation sheet (step 2); poses come from the move draft. */
export function designMovePrompt(style: StyleBible, d: CharacterDesign, m: MoveDraft): string {
  const preset = PLATFORMER_MOVES.find(p => p.id === m.id);
  const poses = m.poses.length === m.frames ? m.poses : preset && preset.frames === m.frames ? preset.poses : m.poses;
  return [
    `Using the attached reference image, create a pixel-art sprite sheet of the SAME character (${d.name}) performing: ${m.name}.`,
    `Keep the design identical to the reference: same proportions, same colors, same clothes and details, same size. The character: ${describe(d)}`,
    ...(m.description.trim() ? [`How ${d.name} performs it: ${m.description.trim()}`] : []),
    `Motion weight: ${m.weight === 'heavy' ? 'heavy and powerful (big anticipation, strong impact, slower recovery)' : m.weight === 'light' ? 'light and quick (small anticipation, snappy)' : 'normal'}.`,
    `Layout: exactly ${m.frames} frames in ONE horizontal row, left to right, evenly spaced with a clear gap between frames (poses must not touch or overlap).`,
    'Every frame: the whole character visible, the same scale, feet on the same ground line (for airborne poses keep the same scale).',
    ...(poses.length ? ['Frames, in order:', ...poses.map((p, i) => `${i + 1}. ${p}`)] : []),
    ...(m.loop ? ['The last frame must flow smoothly back into the first (looping animation).'] : []),
    ...colorLines(d),
    ...formLines(style, d),
    ...LAYOUT,
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
  };
}
