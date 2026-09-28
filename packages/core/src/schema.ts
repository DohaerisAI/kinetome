import { z } from 'zod';

export const Hex = z.string().regex(/^#[0-9a-f]{6}$/i, 'expected #rrggbb');

export const Rect = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().positive(), h: z.number().int().positive() });
export type Rect = z.infer<typeof Rect>;

export const Animation = z.object({
  name: z.string().min(1),
  frames: z.array(z.number().int().nonnegative()), // indexes into asset.frames
  fps: z.number().positive().max(60),
  loop: z.boolean(),
});
export type Animation = z.infer<typeof Animation>;

/** A box in frame pixels (top-left origin of the frame). */
export const Box = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().positive(), h: z.number().int().positive() });
export type Box = z.infer<typeof Box>;

/**
 * Game data for one sheet frame: where it hurts (hitboxes: the attack), where it can be
 * hurt (hurtboxes: the body), and named events that fire when the frame starts
 * ("impact", "footstep", "spawn:slash"...). Exported to Godot as collision shapes and
 * method tracks.
 */
export const FrameMeta = z.object({
  hitboxes: z.array(Box).default([]),
  hurtboxes: z.array(Box).default([]),
  events: z.array(z.string().min(1)).default([]),
});
export type FrameMeta = z.infer<typeof FrameMeta>;

export const AssetKind = z.enum(['character', 'prop', 'fx', 'tile', 'ui']);
export type AssetKind = z.infer<typeof AssetKind>;

/**
 * Canonical sprite asset. Every importer and generator produces this shape.
 * Frames are always uniform cells (frameWidth x frameHeight) so one pivot aligns every frame.
 */
export const SpriteAsset = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  kind: AssetKind,
  source: z.enum(['imported', 'code', 'generated']),
  image: z.string().default('sheet.png'),
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  frames: z.array(Rect),
  pivot: z.object({ x: z.number().int(), y: z.number().int() }),
  animations: z.array(Animation),
  tags: z.array(z.string()).default([]),
  /** What the character/object looks like; feeds the Prompt Kit and generators. */
  description: z.string().default(''),
  /** True when this asset is approved as a style reference for future generation. */
  reference: z.boolean().default(false),
  /** Per sheet frame (key = frame index): hitboxes, hurtboxes and events. */
  frameData: z.record(z.string(), FrameMeta).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpriteAsset = z.infer<typeof SpriteAsset>;

/**
 * The project's locked art direction. Every asset is linted against it and every
 * generator receives it, so nothing in a project is left to the model's taste.
 */
export const StyleBible = z.object({
  palette: z.array(Hex).min(2).max(256),
  /** Height in pixels of a standard humanoid character. Keeps pixel density identical across assets. */
  unitHeight: z.number().int().min(8).max(512),
  maxColorsPerSprite: z.number().int().min(2).max(256),
  outline: z.object({ mode: z.enum(['full', 'selective', 'none']), color: Hex.nullable() }),
  lightDirection: z.enum(['top-left', 'top', 'top-right', 'front']),
  perspective: z.enum(['side', 'three-quarter', 'top-down', 'isometric']),
  /** Free-form art direction handed to generators verbatim. */
  notes: z.string().default(''),
});
export type StyleBible = z.infer<typeof StyleBible>;

export const GodotSettings = z.object({
  /** Absolute path to the Godot project folder (the one holding project.godot). Optional: zip export works without it. */
  path: z.string().nullable().default(null),
  /** Folder inside the Godot project that receives sprites, e.g. "sprites" -> res://sprites/<id>/. */
  dir: z.string().regex(/^[A-Za-z0-9_\-/]+$/).default('sprites'),
});
export type GodotSettings = z.infer<typeof GodotSettings>;

export const Project = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  createdAt: z.string(),
  godot: GodotSettings.default({ path: null, dir: 'sprites' }),
});
export type Project = z.infer<typeof Project>;

export const DEFAULT_STYLE: StyleBible = {
  // PICO-8 palette: a sane 16-color starting point until the project locks its own.
  palette: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
    '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'],
  unitHeight: 32,
  maxColorsPerSprite: 16,
  outline: { mode: 'selective', color: '#000000' },
  lightDirection: 'top-left',
  perspective: 'side',
  notes: '',
};

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

// ---------- character design ----------

export const DesignPart = z.object({
  /** Human label, e.g. "Hair", "Main cloth". Its slug names the color in sprite programs. */
  name: z.string().min(1).max(40),
  color: Hex,
});
export type DesignPart = z.infer<typeof DesignPart>;

export const MoveDraft = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  /** How the character performs it, in the user's words (lore, weapon, style). */
  description: z.string().default(''),
  frames: z.number().int().min(1).max(24),
  fps: z.number().int().min(1).max(60),
  loop: z.boolean(),
  weight: z.enum(['light', 'normal', 'heavy']).default('normal'),
  /** One pose per frame; drafted by Claude or typed by the user. */
  poses: z.array(z.string()).default([]),
  /** How this character's body and story shape the move (e.g. a peg leg makes the walk limp). */
  notes: z.string().default(''),
  /** Visual effects the move needs (particles, trails, impacts), in the user's words. */
  effects: z.string().default(''),
  /** Uploaded pose reference images (e.g. rough key poses from Gemini) that guide Claude. File names. */
  refImages: z.array(z.string()).default([]),
});
export type MoveDraft = z.infer<typeof MoveDraft>;

export const CharacterDesign = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  lore: z.string().default(''),
  personality: z.string().default(''),
  build: z.string().default(''),
  outfit: z.string().default(''),
  details: z.string().default(''),
  parts: z.array(DesignPart).default([]),
  outline: Hex.nullable().default('#1a1420'),
  pixelHeight: z.number().int().min(12).max(256),
  /** Features that must look identical in every frame (checked by the generator), e.g. "left leg is a wooden peg". */
  invariants: z.array(z.string()).default([]),
  /** Visual description used in every prompt (Claude-polished, user-editable). */
  description: z.string().default(''),
  referencePose: z.string().default('neutral standing idle pose, full body, facing right'),
  /** Library asset this design became (reference imported or code drawn). */
  assetId: z.string().nullable().default(null),
  moves: z.array(MoveDraft).default([]),
  /** Latest sprite program (code-drawn route) and the animations it renders. */
  code: z.string().nullable().default(null),
  /** The program animates the reference sprite's own pixels (cut-out rig) instead of drawing from scratch. */
  codeRig: z.boolean().default(false),
  /** One sprite program per animation (preferred): editing a move never re-outputs the others. Overrides `code`. */
  programs: z.record(z.string(), z.string()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CharacterDesign = z.infer<typeof CharacterDesign>;
