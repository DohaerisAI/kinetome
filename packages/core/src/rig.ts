import { z } from 'zod';
import type { PixelImage } from './color.ts';

/**
 * Character rig: the reference sprite cut into parts (a polygon per part, in reference
 * pixels) with a joint (pivot) each and a parent, so rotating an upper arm carries the
 * forearm. Animations are keyframe clips: per part an angle and an offset at a few key
 * frames; everything between is interpolated (in-betweening). Rendering moves the
 * reference's REAL pixels, so every frame stays on model by construction.
 */

const Pt = z.tuple([z.number(), z.number()]);

export const RigPart = z.object({
  name: z.string().min(1),
  /** Polygon in reference coordinates; the opaque pixels inside belong to this part. */
  poly: z.array(Pt).min(3),
  /** The joint it rotates around (hip for a leg, neck for the head), reference coordinates. */
  pivot: Pt,
  parent: z.string().nullable().default(null),
  /** Draw order: higher is in front. Overlapping pixels belong to the front-most part. */
  z: z.number().default(0),
});
export type RigPart = z.infer<typeof RigPart>;

export const PartPose = z.object({ angle: z.number().default(0), dx: z.number().default(0), dy: z.number().default(0) });
export type PartPose = z.infer<typeof PartPose>;
export type RigPose = Record<string, PartPose>;

export const Ease = z.enum(['linear', 'in', 'out', 'inOut', 'hold']);
export type Ease = z.infer<typeof Ease>;

export const RigKey = z.object({
  frame: z.number().int().min(0),
  pose: z.record(z.string(), PartPose),
  /** How the motion leaves this key towards the next one. */
  ease: Ease.default('inOut'),
});
export type RigKey = z.infer<typeof RigKey>;

export const RigClip = z.object({
  frames: z.number().int().min(1).max(48),
  fps: z.number().int().min(1).max(60),
  loop: z.boolean(),
  keys: z.array(RigKey).min(1),
});
export type RigClip = z.infer<typeof RigClip>;

export const CharacterRig = z.object({
  parts: z.array(RigPart).default([]),
  /** Keyframe clips by move id. */
  clips: z.record(z.string(), RigClip).default({}),
});
export type CharacterRig = z.infer<typeof CharacterRig>;

const easeFn: Record<Ease, (t: number) => number> = {
  linear: t => t,
  in: t => t * t,
  out: t => 1 - (1 - t) * (1 - t),
  inOut: t => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  hold: () => 0,
};

const lerpPose = (a: RigPose, b: RigPose, t: number, names: string[]): RigPose => {
  const out: RigPose = {};
  for (const n of names) {
    const p = a[n] ?? { angle: 0, dx: 0, dy: 0 }, q = b[n] ?? { angle: 0, dx: 0, dy: 0 };
    out[n] = { angle: p.angle + (q.angle - p.angle) * t, dx: p.dx + (q.dx - p.dx) * t, dy: p.dy + (q.dy - p.dy) * t };
  }
  return out;
};

/**
 * The pose at every frame of a clip: keys as written, in-betweens eased between them.
 * A looping clip also eases from its last key back into the first.
 */
export function clipPoses(clip: RigClip, partNames: string[]): RigPose[] {
  const keys = [...clip.keys].filter(k => k.frame < clip.frames).sort((a, b) => a.frame - b.frame);
  if (!keys.length) return Array.from({ length: clip.frames }, () => ({}));
  const out: RigPose[] = [];
  for (let f = 0; f < clip.frames; f++) {
    let a = keys[keys.length - 1], b = keys[0], span: number, t: number;
    const next = keys.findIndex(k => k.frame > f);
    const prevIdx = next === -1 ? keys.length - 1 : next - 1;
    if (prevIdx >= 0) {
      a = keys[prevIdx];
      if (next !== -1) { b = keys[next]; span = b.frame - a.frame; }
      else if (clip.loop) { b = keys[0]; span = clip.frames - a.frame + keys[0].frame; }
      else { out.push(lerpPose(a.pose, a.pose, 0, partNames)); continue; }
      t = (f - a.frame) / span;
    } else {
      // before the first key
      if (!clip.loop) { out.push(lerpPose(keys[0].pose, keys[0].pose, 0, partNames)); continue; }
      a = keys[keys.length - 1]; b = keys[0];
      span = clip.frames - a.frame + b.frame;
      t = (f + clip.frames - a.frame) / span;
    }
    out.push(lerpPose(a.pose, b.pose, easeFn[a.ease](Math.max(0, Math.min(1, t))), partNames));
  }
  return out;
}

export interface PartTransform { angle: number; /** Where the part's pivot ends up (reference coordinates). */ at: [number, number] }

const rot = (x: number, y: number, deg: number): [number, number] => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
};

/**
 * Final transform of every part: its own angle/offset composed with all its parents'.
 * Angles are clockwise degrees (screen space, y down), offsets in pixels.
 */
export function solvePose(parts: RigPart[], pose: RigPose): Map<string, PartTransform> {
  const byName = new Map(parts.map(p => [p.name, p]));
  const out = new Map<string, PartTransform>();
  const solve = (name: string, depth = 0): PartTransform => {
    const done = out.get(name);
    if (done) return done;
    const part = byName.get(name)!;
    const own = pose[name] ?? { angle: 0, dx: 0, dy: 0 };
    const parent = part.parent && byName.has(part.parent) && depth < 32 ? solve(part.parent, depth + 1) : null;
    let at: [number, number] = [part.pivot[0], part.pivot[1]], angle = own.angle;
    if (parent) {
      const pp = byName.get(part.parent!)!.pivot;
      const [rx, ry] = rot(part.pivot[0] - pp[0], part.pivot[1] - pp[1], parent.angle);
      at = [parent.at[0] + rx, parent.at[1] + ry];
      angle += parent.angle;
    }
    const t: PartTransform = { angle, at: [at[0] + own.dx, at[1] + own.dy] };
    out.set(name, t);
    return t;
  };
  for (const p of parts) solve(p.name);
  return out;
}

function insidePoly(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Which part owns each reference pixel: the front-most part whose polygon covers it.
 * Pixels no part covers belong to the root (they ride along, e.g. a torso left uncut).
 * Returns the part index per pixel (-1 = transparent).
 */
export function partOwnership(ref: PixelImage, parts: RigPart[]): Int16Array {
  const own = new Int16Array(ref.width * ref.height).fill(-1);
  const order = parts.map((p, i) => ({ p, i })).sort((a, b) => b.p.z - a.p.z);
  const root = Math.max(0, parts.findIndex(p => !p.parent));
  for (let y = 0; y < ref.height; y++) for (let x = 0; x < ref.width; x++) {
    const k = y * ref.width + x;
    if (ref.data[k * 4 + 3] < 128) continue;
    const hit = order.find(o => insidePoly(o.p.poly, x + 0.5, y + 0.5));
    own[k] = hit ? hit.i : parts.length ? root : -1;
  }
  return own;
}

export interface RigCanvas { width: number; height: number; /** Reference pixel (x, y) sits at canvas (x + pad, y + pad). */ pad: number }

/** The canvas a rig renders into: the reference with room to move (same as rig programs). */
export function rigCanvas(ref: PixelImage): RigCanvas {
  const pad = Math.max(6, Math.round(Math.max(ref.width, ref.height) * 0.15));
  return { width: ref.width + pad * 2, height: ref.height + pad, pad };
}

/**
 * Each part's own image: the reference pixels it owns, plus an UNDERPAINT where a part in
 * front of it covers it (the torso behind an arm). Those hidden pixels are filled from the
 * part's nearest own colors, so when the arm swings away the body isn't a hole, the way
 * cut-out animators paint the body under the limbs.
 */
export function partLayers(ref: PixelImage, parts: RigPart[], own = partOwnership(ref, parts)): Uint8ClampedArray[] {
  const W = ref.width, H = ref.height;
  return parts.map((p, i) => {
    const layer = new Uint8ClampedArray(W * H * 4);
    const dist = new Int32Array(W * H).fill(-1);
    const queue: number[] = [];
    for (let k = 0; k < W * H; k++) if (own[k] === i) { layer.set(ref.data.subarray(k * 4, k * 4 + 4), k * 4); dist[k] = 0; queue.push(k); }
    // pixels inside this part's polygon owned by a part drawn in front of it
    const hidden = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x, o = own[k];
      if (o >= 0 && o !== i && parts[o].z > p.z && insidePoly(p.poly, x + 0.5, y + 0.5)) hidden[k] = 1;
    }
    for (let q = 0; q < queue.length; q++) {
      const k = queue[q], x = k % W, y = (k - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, n = ny * W + nx;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || dist[n] >= 0 || !hidden[n]) continue;
        dist[n] = dist[k] + 1;
        layer.set(layer.subarray(k * 4, k * 4 + 4), n * 4);
        queue.push(n);
      }
    }
    return layer;
  });
}

/**
 * Draws one pose: each part's layer rotated around its (moved) pivot with nearest
 * sampling, back to front. Pure pixel moves: no new colors, no blur.
 */
export function renderPose(ref: PixelImage, parts: RigPart[], pose: RigPose, canvas: RigCanvas = rigCanvas(ref), own = partOwnership(ref, parts), layers = partLayers(ref, parts, own)): PixelImage {
  const { width: W, height: H, pad } = canvas;
  const out: PixelImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  if (!parts.length) {
    for (let y = 0; y < ref.height; y++) out.data.set(ref.data.subarray(y * ref.width * 4, (y + 1) * ref.width * 4), ((y + pad) * W + pad) * 4);
    return out;
  }
  const tf = solvePose(parts, pose);
  const order = parts.map((p, i) => ({ p, i })).sort((a, b) => a.p.z - b.p.z);
  for (const { p, i } of order) {
    const layer = layers[i];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < ref.height; y++) for (let x = 0; x < ref.width; x++) if (layer[(y * ref.width + x) * 4 + 3]) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    if (x1 < 0) continue;
    const t = tf.get(p.name)!;
    const corners = [[x0, y0], [x1 + 1, y0], [x0, y1 + 1], [x1 + 1, y1 + 1]].map(([x, y]) => {
      const [rx, ry] = rot(x - p.pivot[0], y - p.pivot[1], t.angle);
      return [rx + t.at[0] + pad, ry + t.at[1] + pad];
    });
    const cx0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[0]))) - 1), cx1 = Math.min(W - 1, Math.ceil(Math.max(...corners.map(c => c[0]))) + 1);
    const cy0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[1]))) - 1), cy1 = Math.min(H - 1, Math.ceil(Math.max(...corners.map(c => c[1]))) + 1);
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
      // inverse map the canvas pixel centre back into the part's layer
      const [sx, sy] = rot(x + 0.5 - pad - t.at[0], y + 0.5 - pad - t.at[1], -t.angle);
      const rx = Math.floor(sx + p.pivot[0]), ry = Math.floor(sy + p.pivot[1]);
      if (rx < 0 || ry < 0 || rx >= ref.width || ry >= ref.height) continue;
      const k = (ry * ref.width + rx) * 4;
      if (layer[k + 3] < 128) continue;
      out.data.set(layer.subarray(k, k + 4), (y * W + x) * 4);
    }
  }
  return out;
}

/** Every frame of a clip. */
export function renderClip(ref: PixelImage, parts: RigPart[], clip: RigClip): PixelImage[] {
  const canvas = rigCanvas(ref), own = partOwnership(ref, parts), layers = partLayers(ref, parts, own);
  return clipPoses(clip, parts.map(p => p.name)).map(pose => renderPose(ref, parts, pose, canvas, own, layers));
}

/** A clip with one neutral key: the starting point for posing a new move. */
export function emptyClip(frames: number, fps: number, loop: boolean): RigClip {
  return { frames, fps, loop, keys: [{ frame: 0, pose: {}, ease: 'inOut' }] };
}
