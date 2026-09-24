import type { StyleBible } from './schema.ts';

/**
 * Prompt Kit: instructions for external image generators (ChatGPT, Gemini, Midjourney, …)
 * written so their output imports cleanly: one pose per cell, chroma backdrop, no text,
 * constant size and ground line, the project's palette and form. The studio's importer
 * is built for exactly this layout.
 */

export interface MovePreset {
  id: string;
  name: string;
  frames: number;
  fps: number;
  loop: boolean;
  /** One description per frame, in order. */
  poses: string[];
  tip?: string;
}

/** Standard side-view platformer moveset, with key-pose breakdowns animators use. */
export const PLATFORMER_MOVES: MovePreset[] = [
  {
    id: 'idle', name: 'Idle', frames: 4, fps: 6, loop: true,
    poses: ['neutral stance, weight centered', 'breathing in: chest and shoulders rise slightly', 'top of breath, held', 'breathing out: settle back to neutral'],
    tip: 'Keep the feet exactly still; only the upper body moves.',
  },
  {
    id: 'walk', name: 'Walk', frames: 8, fps: 10, loop: true,
    poses: [
      'contact: right leg forward, heel touching ground, left leg back, arms opposite',
      'down: weight on right leg, knee bent, body at lowest point',
      'passing: left leg swinging past the right, body rising',
      'up: pushing off right toes, body at highest point',
      'contact: left leg forward, heel touching ground, right leg back',
      'down: weight on left leg, knee bent, body lowest',
      'passing: right leg swinging past the left, body rising',
      'up: pushing off left toes, body highest',
    ],
    tip: 'Walk in place (no forward travel between frames). Frames 5-8 mirror 1-4 with legs swapped.',
  },
  {
    id: 'run', name: 'Run', frames: 8, fps: 12, loop: true,
    poses: [
      'contact: right foot striking the ground ahead, strong forward lean',
      'down: right knee bent absorbing impact, body lowest',
      'push: right leg driving back, left knee lifting high',
      'flight: both feet off the ground, legs spread, arms pumping',
      'contact: left foot striking the ground ahead, forward lean',
      'down: left knee bent absorbing impact',
      'push: left leg driving back, right knee lifting high',
      'flight: both feet off the ground, legs spread',
    ],
    tip: 'Run in place. Stronger lean and bigger arm swing than the walk.',
  },
  {
    id: 'jump', name: 'Jump (take-off)', frames: 3, fps: 12, loop: false,
    poses: ['anticipation: deep crouch, arms back', 'launch: body fully stretched upward, toes leaving the ground', 'rising: knees tucked slightly, arms up'],
  },
  {
    id: 'fall', name: 'Fall', frames: 2, fps: 8, loop: true,
    poses: ['falling: legs slightly apart, arms raised for balance', 'falling: arms and legs shifted slightly (flutter)'],
  },
  {
    id: 'land', name: 'Land', frames: 2, fps: 12, loop: false,
    poses: ['impact: knees bent deeply, body squashed down', 'recover: rising back toward neutral stance'],
  },
  {
    id: 'attack', name: 'Attack', frames: 6, fps: 14, loop: false,
    poses: [
      'anticipation: weapon drawn back, body coiled',
      'wind-up peak: weapon at the furthest back point',
      'strike: weapon swung forward fast, motion smear arc',
      'follow-through: weapon past the target, body leaning in',
      'hold: brief pause at the end of the swing',
      'recover: returning to neutral stance',
    ],
    tip: 'The strike frame should read clearly even as a silhouette.',
  },
  {
    id: 'hurt', name: 'Hurt', frames: 3, fps: 12, loop: false,
    poses: ['recoil: head and torso snapped backward, eyes squeezed shut', 'stagger: leaning back, one foot sliding', 'recover: regaining balance'],
  },
  {
    id: 'death', name: 'Death', frames: 6, fps: 10, loop: false,
    poses: ['hit: body jolts backward', 'stagger: knees buckling', 'falling backward', 'hitting the ground', 'small bounce on impact', 'lying still on the ground'],
  },
  {
    id: 'dash', name: 'Dash', frames: 4, fps: 14, loop: false,
    poses: ['crouch forward, ready to burst', 'bursting forward, body almost horizontal, speed lines trailing', 'mid-dash, stretched and low', 'braking: heels dug in, leaning back'],
  },
  {
    id: 'crouch', name: 'Crouch', frames: 2, fps: 10, loop: false,
    poses: ['half crouch', 'full crouch, knees bent, head lowered'],
  },
];

export interface CharacterBrief {
  name: string;
  /** What the character looks like: body, clothes, colors, signature features. */
  description: string;
}

function styleLines(style: StyleBible): string[] {
  const lines = [
    `Perspective: ${style.perspective === 'side' ? 'side view, character facing right' : style.perspective}.`,
    `Pixel art at roughly ${style.unitHeight} pixels tall for a standard character, drawn with crisp, square, hard-edged pixels. No blur, no anti-aliasing, no gradients, no painterly texture.`,
    `Use only these colors: ${style.palette.slice(0, 32).join(', ')}.`,
    `Light comes from the ${style.lightDirection === 'front' ? 'front' : style.lightDirection.replace('-', ' ')}.`,
  ];
  if (style.outline.mode !== 'none' && style.outline.color) lines.push(`${style.outline.mode === 'full' ? 'A clean 1-pixel outline' : 'A selective 1-pixel outline'} in ${style.outline.color} around the character.`);
  else lines.push('No outline.');
  if (style.notes.trim()) lines.push(`Art direction: ${style.notes.trim()}`);
  return lines;
}

const LAYOUT = [
  'Background: one flat, solid pure green (#00FF00) everywhere. No gradient, no texture, no checkerboard, no floor, no shadow under the character.',
  'No text, no labels, no numbers, no frame borders, no grid lines, no watermark.',
];

/** Step 1: the canonical look of a character, used as the reference for every animation. */
export function referencePrompt(style: StyleBible, c: CharacterBrief): string {
  return [
    `Create a single pixel-art game sprite of ${c.name}: ${c.description.trim() || '(describe the character here)'}`,
    'Pose: neutral standing idle pose, full body visible from head to feet, centered.',
    ...styleLines(style),
    ...LAYOUT,
    'This image will be the reference design for all of the character\'s animations, so keep the design clear and simple enough to redraw consistently.',
  ].join('\n');
}

/** Step 2: one animation as a single-row sprite sheet, conditioned on the reference. */
export function animationPrompt(style: StyleBible, c: CharacterBrief, m: MovePreset): string {
  return [
    `Using the attached reference image, create a pixel-art sprite sheet of the SAME character (${c.name}) performing a ${m.name.toLowerCase()} animation.`,
    `Keep the design identical to the reference: same proportions, same colors, same clothes and details, same size. ${c.description.trim() ? `The character: ${c.description.trim()}` : ''}`.trim(),
    `Layout: exactly ${m.frames} frames in ONE horizontal row, left to right, evenly spaced with a clear gap between frames (poses must not touch or overlap).`,
    'Every frame: the whole character visible, the same scale, feet on the same ground line.',
    'Frames, in order:',
    ...m.poses.map((p, i) => `${i + 1}. ${p}`),
    ...(m.tip ? [m.tip] : []),
    ...styleLines(style),
    ...LAYOUT,
  ].join('\n');
}

/** Short instructions shown next to the prompts. */
export const PROMPT_KIT_STEPS = [
  'Describe the character once (appearance, clothes, colors, signature details).',
  'Copy the Reference prompt into your image generator. Regenerate until you love the design; that image is now the character.',
  'For each animation: start a new request, attach the reference image, paste that animation\'s prompt.',
  'Save the result and drop it on the studio. Choose "Add to <character>" so every animation shares the same size, palette and feet position.',
];
