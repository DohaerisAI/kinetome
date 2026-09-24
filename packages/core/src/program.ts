import { hexToRgb, type PixelImage } from './color.ts';

/**
 * Sprite programs: the code-drawn route. Claude writes
 *
 *   const sprite = {
 *     width: 48, height: 48, pivot: [24, 46],
 *     animations: { idle: { frames: 4, fps: 6, loop: true } },
 *     draw(g, anim, frame, t) { g.rect(20, 30, 8, 14, 'main-cloth'); ... },
 *   };
 *
 * and the studio renders every frame. Colors are palette NAMES only, so an off-palette
 * pixel is impossible by construction; the same code re-renders identically forever.
 */

export interface AnimSpec { frames: number; fps: number; loop: boolean }

/** A piece of the reference sprite, cut out by a polygon in REFERENCE coordinates. */
export interface PartSpec { poly: [number, number][]; pivot?: [number, number] }

export interface SpriteProgram {
  width: number;
  height: number;
  pivot: [number, number];
  animations: Record<string, AnimSpec>;
  /** Cut-out parts of the reference sprite (rig mode only). */
  parts?: Record<string, PartSpec>;
  draw: (g: Gfx, anim: string, frame: number, t: number) => void;
}

/**
 * Rig mode: the program animates an existing reference sprite by moving pieces of its
 * real pixels. Reference pixel (x, y) sits at canvas (x + pad, y + pad).
 */
export interface Rig { ref: PixelImage; pad: number; parts: Record<string, PartSpec> }

export interface RenderedAnim { name: string; fps: number; loop: boolean; frames: PixelImage[] }
export interface RenderOutput { width: number; height: number; pivot: { x: number; y: number }; animations: RenderedAnim[] }

export interface Gfx {
  readonly w: number;
  readonly h: number;
  px(x: number, y: number, color: string): void;
  rect(x: number, y: number, w: number, h: number, color: string): void;
  line(x0: number, y0: number, x1: number, y1: number, color: string, thickness?: number): void;
  circle(cx: number, cy: number, r: number, color: string): void;
  ellipse(cx: number, cy: number, rx: number, ry: number, color: string): void;
  poly(points: [number, number][], color: string): void;
  outline(color?: string): void;
  erase(x: number, y: number, w: number, h: number): void;
  /** Rig mode: draw a reference part moved by (dx, dy), rotated `angle` degrees clockwise around its pivot. */
  part(name: string, dx?: number, dy?: number, angle?: number, opts?: { flip?: boolean }): void;
  lerp(a: number, b: number, t: number): number;
  clamp(v: number, lo: number, hi: number): number;
  ease(t: number): number;
  easeIn(t: number): number;
  easeOut(t: number): number;
  wave(t: number): number;
  rand(): number;
}

export const LIMITS = { maxSize: 256, maxFrames: 24, maxAnims: 16 };

/** Short API reference handed to Claude; kept next to the implementation so they never drift. */
export const GFX_REFERENCE = `g.w, g.h                          canvas size
g.px(x, y, c)                     one pixel
g.rect(x, y, w, h, c)             filled rectangle
g.line(x0, y0, x1, y1, c, t=1)    line, optional thickness t
g.circle(cx, cy, r, c)            filled circle
g.ellipse(cx, cy, rx, ry, c)      filled ellipse
g.poly([[x,y],...], c)            filled polygon
g.outline(c='outline')            1px outline around everything drawn so far (call last)
g.erase(x, y, w, h)               clear to transparent
g.lerp(a,b,t) g.clamp(v,lo,hi)    math helpers
g.ease(t) g.easeIn(t) g.easeOut(t) easing 0..1 -> 0..1
g.wave(t)                         sin(2*PI*t), -1..1 (perfect loops)
g.rand()                          deterministic random 0..1 (same every render)
Coordinates are rounded to whole pixels. c is a palette NAME (never a hex value).`;

export const RIG_REFERENCE = `g.part(name, dx=0, dy=0, angle=0, {flip})
    draws a cut-out part of the reference sprite: moved by (dx, dy), rotated angle
    degrees CLOCKWISE around the part's pivot, optionally mirrored. g.part(n) with no
    motion draws it exactly where it is in the reference.
sprite.parts = { name: { poly: [[x,y],...], pivot: [x,y] } }
    polygons in REFERENCE coordinates (from the pixel map); pivot = the joint it
    rotates around (hip for a leg, neck for the head). Only opaque reference pixels
    inside the polygon belong to the part. Parts may overlap; draw order decides.`;

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function insidePoly(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Precomputed pixel mask + default pivot (centroid) for each part. */
function prepareParts(rig: Rig) {
  const out = new Map<string, { mask: Uint8Array; bx: number; by: number; bw: number; bh: number; pivot: [number, number] }>();
  for (const [name, p] of Object.entries(rig.parts)) {
    const xs = p.poly.map(q => q[0]), ys = p.poly.map(q => q[1]);
    const bx = Math.max(0, Math.floor(Math.min(...xs))), by = Math.max(0, Math.floor(Math.min(...ys)));
    const bw = Math.min(rig.ref.width, Math.ceil(Math.max(...xs))) - bx, bh = Math.min(rig.ref.height, Math.ceil(Math.max(...ys))) - by;
    const mask = new Uint8Array(Math.max(0, bw * bh));
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (!insidePoly(p.poly, bx + x + 0.5, by + y + 0.5)) continue;
      if (rig.ref.data[((by + y) * rig.ref.width + bx + x) * 4 + 3] < 128) continue;
      mask[y * bw + x] = 1; sx += bx + x + 0.5; sy += by + y + 0.5; n++;
    }
    out.set(name, { mask, bx, by, bw, bh, pivot: p.pivot ?? (n ? [sx / n, sy / n] : [bx, by]) });
  }
  return out;
}

export function makeGfx(img: PixelImage, colors: Record<string, string>, seed = 1, rig?: Rig): Gfx {
  const parts = rig ? prepareParts(rig) : null;
  const W = img.width, H = img.height, d = img.data;
  const rgb = new Map(Object.entries(colors).map(([k, v]) => [k, hexToRgb(v)]));
  const names = [...rgb.keys()];
  const col = (c: string) => {
    const v = rgb.get(c);
    if (!v) throw new Error(`Unknown color "${c}". Use one of: ${names.join(', ')}`);
    return v;
  };
  const set = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  };
  const R = Math.round;
  const g: Gfx = {
    w: W, h: H,
    px(x, y, c) { set(R(x), R(y), col(c)); },
    rect(x, y, w, h, c) {
      const v = col(c);
      let x0 = R(x), y0 = R(y), x1 = R(x + w), y1 = R(y + h);
      if (x1 < x0) [x0, x1] = [x1, x0];
      if (y1 < y0) [y0, y1] = [y1, y0];
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) set(xx, yy, v);
    },
    line(x0, y0, x1, y1, c, thickness = 1) {
      const v = col(c), t = Math.max(1, R(thickness)), o = Math.floor((t - 1) / 2);
      let ax = R(x0), ay = R(y0);
      const bx = R(x1), by = R(y1);
      const dx = Math.abs(bx - ax), sx = ax < bx ? 1 : -1, dy = -Math.abs(by - ay), sy = ay < by ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 4096; guard++) {
        for (let yy = 0; yy < t; yy++) for (let xx = 0; xx < t; xx++) set(ax + xx - o, ay + yy - o, v);
        if (ax === bx && ay === by) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; ax += sx; }
        if (e2 <= dx) { err += dx; ay += sy; }
      }
    },
    circle(cx, cy, r, c) { g.ellipse(cx, cy, r, r, c); },
    ellipse(cx, cy, rx, ry, c) {
      const v = col(c);
      if (rx <= 0 || ry <= 0) { set(R(cx), R(cy), v); return; }
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const nx = (x - cx) / (rx + 0.25), ny = (y - cy) / (ry + 0.25);
          if (nx * nx + ny * ny <= 1) set(x, y, v);
        }
    },
    poly(points, c) {
      const v = col(c);
      if (!Array.isArray(points) || points.length < 3) return;
      const ys = points.map(p => p[1]);
      for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
        const sy = y + 0.5, xs: number[] = [];
        for (let i = 0; i < points.length; i++) {
          const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length];
          if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2)
          for (let x = Math.ceil(xs[k] - 0.5); x <= Math.floor(xs[k + 1] - 0.5); x++) set(x, y, v);
      }
    },
    outline(c = 'outline') {
      const v = col(c);
      const snap = new Uint8Array(W * H);
      for (let p = 0; p < W * H; p++) snap[p] = d[p * 4 + 3] > 0 ? 1 : 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (snap[y * W + x]) continue;
        if ((x > 0 && snap[y * W + x - 1]) || (x < W - 1 && snap[y * W + x + 1]) || (y > 0 && snap[(y - 1) * W + x]) || (y < H - 1 && snap[(y + 1) * W + x])) set(x, y, v);
      }
    },
    erase(x, y, w, h) {
      for (let yy = R(y); yy < R(y + h); yy++) for (let xx = R(x); xx < R(x + w); xx++)
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) d[(yy * W + xx) * 4 + 3] = 0;
    },
    part(name, dx = 0, dy = 0, angle = 0, opts) {
      if (!rig || !parts) throw new Error('g.part() needs a reference sprite (rig mode)');
      const p = parts.get(name);
      if (!p) throw new Error(`Unknown part "${name}". Defined parts: ${[...parts.keys()].join(', ') || '(none)'}`);
      const ref = rig.ref, pad = rig.pad, flip = !!opts?.flip;
      const rad = (angle * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const [px, py] = p.pivot;
      const cx = px + pad + dx, cy = py + pad + dy; // pivot position on the canvas
      // destination bounds: transform the part's bbox corners
      const corners = [[p.bx, p.by], [p.bx + p.bw, p.by], [p.bx, p.by + p.bh], [p.bx + p.bw, p.by + p.bh]].map(([x, y]) => {
        let u = x - px; const v = y - py;
        if (flip) u = -u;
        return [cx + u * cos - v * sin, cy + u * sin + v * cos];
      });
      const x0 = Math.floor(Math.min(...corners.map(c => c[0]))) - 1, x1 = Math.ceil(Math.max(...corners.map(c => c[0]))) + 1;
      const y0 = Math.floor(Math.min(...corners.map(c => c[1]))) - 1, y1 = Math.ceil(Math.max(...corners.map(c => c[1]))) + 1;
      for (let Y = Math.max(0, y0); Y < Math.min(H, y1); Y++)
        for (let X = Math.max(0, x0); X < Math.min(W, x1); X++) {
          // inverse-map the destination pixel centre into the reference (nearest neighbour)
          const u = X + 0.5 - cx, v = Y + 0.5 - cy;
          let su = u * cos + v * sin;
          const sv = -u * sin + v * cos;
          if (flip) su = -su;
          const sx = Math.floor(px + su), sy = Math.floor(py + sv);
          const mx = sx - p.bx, my = sy - p.by;
          if (mx < 0 || my < 0 || mx >= p.bw || my >= p.bh || !p.mask[my * p.bw + mx]) continue;
          const i = (sy * ref.width + sx) * 4, o = (Y * W + X) * 4;
          d[o] = ref.data[i]; d[o + 1] = ref.data[i + 1]; d[o + 2] = ref.data[i + 2]; d[o + 3] = 255;
        }
    },
    lerp: (a, b, t) => a + (b - a) * t,
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    ease: t => t * t * (3 - 2 * t),
    easeIn: t => t * t,
    easeOut: t => 1 - (1 - t) * (1 - t),
    wave: t => Math.sin(2 * Math.PI * t),
    rand: mulberry32(seed),
  };
  return g;
}

/** Checks the object a program produced, with messages written for the model to act on. */
export function validateProgram(p: unknown): SpriteProgram {
  const s = p as Partial<SpriteProgram> | undefined;
  if (!s || typeof s !== 'object') throw new Error('The code must define `const sprite = { width, height, pivot, animations, draw }`.');
  const int = (v: unknown, name: string, lo: number, hi: number) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`sprite.${name} must be an integer ${lo}..${hi}`);
    return v;
  };
  int(s.width, 'width', 8, LIMITS.maxSize);
  int(s.height, 'height', 8, LIMITS.maxSize);
  if (!Array.isArray(s.pivot) || s.pivot.length !== 2) throw new Error('sprite.pivot must be [x, y] (the point between the feet)');
  if (typeof s.draw !== 'function') throw new Error('sprite.draw(g, anim, frame, t) must be a function');
  if (!s.animations || typeof s.animations !== 'object') throw new Error('sprite.animations must be an object like { idle: { frames: 4, fps: 6, loop: true } }');
  const entries = Object.entries(s.animations);
  if (!entries.length || entries.length > LIMITS.maxAnims) throw new Error(`sprite.animations needs 1..${LIMITS.maxAnims} entries`);
  for (const [name, a] of entries) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Animation name "${name}" must be lowercase letters, digits or dashes`);
    int(a?.frames, `animations.${name}.frames`, 1, LIMITS.maxFrames);
    int(a?.fps, `animations.${name}.fps`, 1, 60);
  }
  if (s.parts !== undefined) {
    if (typeof s.parts !== 'object' || !s.parts) throw new Error('sprite.parts must be an object of { poly: [[x,y],...], pivot?: [x,y] }');
    for (const [name, part] of Object.entries(s.parts)) {
      if (!Array.isArray(part?.poly) || part.poly.length < 3 || part.poly.some(q => !Array.isArray(q) || q.length !== 2 || q.some(v => typeof v !== 'number' || !Number.isFinite(v))))
        throw new Error(`sprite.parts.${name}.poly must be at least 3 [x, y] number pairs`);
      if (part.pivot !== undefined && (!Array.isArray(part.pivot) || part.pivot.length !== 2)) throw new Error(`sprite.parts.${name}.pivot must be [x, y]`);
    }
  }
  return s as SpriteProgram;
}

/** Renders every (or the selected) animation. Frame t runs 0 .. (frames-1)/frames so loops close cleanly. */
export function renderProgram(p: SpriteProgram, colors: Record<string, string>, only?: string[], rig?: Rig): RenderOutput {
  const animations: RenderedAnim[] = [];
  for (const [name, a] of Object.entries(p.animations)) {
    if (only && !only.includes(name)) continue;
    const frames: PixelImage[] = [];
    for (let f = 0; f < a.frames; f++) {
      const img: PixelImage = { width: p.width, height: p.height, data: new Uint8ClampedArray(p.width * p.height * 4) };
      try {
        p.draw(makeGfx(img, colors, 1000 + f, rig), name, f, f / a.frames);
      } catch (e) {
        throw new Error(`draw("${name}", frame ${f}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      frames.push(img);
    }
    animations.push({ name, fps: a.fps, loop: a.loop !== false, frames });
  }
  return { width: p.width, height: p.height, pivot: { x: Math.round(p.pivot[0]), y: Math.round(p.pivot[1]) }, animations };
}

/**
 * All frames on one image for Claude to look at: one row per animation, frames scaled up
 * with a visible cell background and a ground line at the pivot.
 */
export function contactSheet(out: RenderOutput, maxWidth = 1500, reference?: PixelImage): PixelImage {
  if (reference) out = { ...out, animations: [{ name: 'reference', fps: 1, loop: false, frames: [reference] }, ...out.animations] };
  const cols = Math.max(...out.animations.map(a => a.frames.length));
  const gap = 6;
  const scale = Math.max(1, Math.min(8, Math.floor((maxWidth - gap * (cols + 1)) / (cols * out.width))));
  const cw = out.width * scale, ch = out.height * scale;
  const W = gap + cols * (cw + gap), H = gap + out.animations.length * (ch + gap);
  const img: PixelImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const fill = (x: number, y: number, w: number, h: number, c: [number, number, number]) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (yy * W + xx) * 4;
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
    }
  };
  fill(0, 0, W, H, [34, 34, 44]);
  out.animations.forEach((a, row) => a.frames.forEach((f, col) => {
    const ox = gap + col * (cw + gap), oy = gap + row * (ch + gap);
    fill(ox, oy, cw, ch, [70, 70, 88]);
    fill(ox, oy + (out.pivot.y + 1) * scale, cw, 1, [120, 120, 150]); // ground line
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
      const s = (y * f.width + x) * 4;
      if (f.data[s + 3] === 0) continue;
      fill(ox + x * scale, oy + y * scale, scale, scale, [f.data[s], f.data[s + 1], f.data[s + 2]]);
    }
  }));
  return img;
}
