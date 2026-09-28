import { countColors, hexToRgb, rgbToHex, type PixelImage } from '@kinetome/core';
import { contentBounds } from './image.ts';

export interface ModelPart { name: string; colors: string[] }

export interface ModelIssue {
  severity: 'error' | 'warn' | 'info';
  message: string;
  /** 0-based frame indices; messages name them 1-based. */
  frames: number[];
  part?: string;
}

export interface ModelFrameStats {
  height: number;
  width: number;
  /** Share of opaque pixels per part name (or per reference color when no parts are given). */
  colorShare: Record<string, number>;
}

export interface ModelCheckReport { score: number; issues: ModelIssue[]; perFrame: ModelFrameStats[] }

export interface ModelCheckOptions {
  parts?: ModelPart[];
  /** Allowed height/width change vs the reference, as a fraction (squash-and-stretch). Default 0.15. */
  tolerance?: number;
}

/** A part counts as missing below this fraction of its reference pixel count. */
const MISSING = 0.15;
/** Part size change beyond this fraction is reported as shrinking/growing. */
const RESIZE = 0.4;
const PENALTY = { error: 20, warn: 8, info: 2 } as const;

const norm = (hex: string) => rgbToHex(...hexToRgb(hex));
const list = (xs: number[]) => xs.map(i => i + 1).join(', ');
const framesLabel = (xs: number[]) => `frame${xs.length > 1 ? 's' : ''} ${list(xs)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

interface Stats { w: number; h: number; total: number; colors: Map<string, number> }

function stats(img: PixelImage): Stats {
  const b = contentBounds(img, 128), colors = countColors(img, 128);
  let total = 0;
  for (const n of colors.values()) total += n;
  return { w: b?.w ?? 0, h: b?.h ?? 0, total, colors };
}

const sumColors = (s: Stats, colors: string[]) => colors.reduce((n, c) => n + (s.colors.get(c) ?? 0), 0);

/**
 * "Off-model" check: compares every animation frame to the character's reference sprite and
 * reports, in plain words naming the frames (1-based) and part, where a frame stops looking
 * like the same character: a body part whose ramp colors vanish (a leg dropped by the
 * generator), a part that shrinks/grows a lot, the silhouette getting taller/wider than
 * squash-and-stretch allows, and colors the reference never uses (palette drift).
 */
export function modelCheck(reference: PixelImage, frames: PixelImage[], opts: ModelCheckOptions = {}): ModelCheckReport {
  const tol = opts.tolerance ?? 0.15;
  const parts = (opts.parts ?? []).map(p => ({ name: p.name, colors: [...new Set(p.colors.map(norm))] }));
  const ref = stats(reference), fs = frames.map(stats);
  const issues: ModelIssue[] = [];

  const perFrame: ModelFrameStats[] = fs.map(s => {
    const share: Record<string, number> = {};
    if (parts.length) for (const p of parts) share[p.name] = s.total ? sumColors(s, p.colors) / s.total : 0;
    else for (const c of ref.colors.keys()) share[c] = s.total ? (s.colors.get(c) ?? 0) / s.total : 0;
    return { height: s.h, width: s.w, colorShare: share };
  });

  const empty = fs.flatMap((s, i) => (s.total ? [] : [i]));
  if (empty.length) issues.push({ severity: 'error', message: `${cap(framesLabel(empty))} ${empty.length > 1 ? 'are' : 'is'} empty`, frames: empty });
  const live = (i: number) => fs[i].total > 0;

  // (a) + (d): body parts, measured by their ramp colors' pixel counts.
  for (const p of parts) {
    const refN = sumColors(ref, p.colors);
    if (refN < 2) continue; // not visible in the reference: nothing to compare against
    const missing: number[] = [], shrank: number[] = [], grew: number[] = [];
    fs.forEach((s, i) => {
      if (!live(i)) return;
      const r = sumColors(s, p.colors) / refN;
      if (r < MISSING) missing.push(i);
      else if (r < 1 - RESIZE) shrank.push(i);
      else if (r > 1 + RESIZE) grew.push(i);
    });
    if (missing.length) issues.push({ severity: 'error', part: p.name, frames: missing, message: `${cap(p.name)} missing in ${framesLabel(missing)}` });
    if (shrank.length) issues.push({
      severity: 'warn', part: p.name, frames: shrank,
      message: `${cap(p.name)} shrank in ${framesLabel(shrank)} (${shrank.map(i => pct(sumColors(fs[i], p.colors) / refN)).join(', ')} of its reference size)`,
    });
    if (grew.length) issues.push({
      severity: 'warn', part: p.name, frames: grew,
      message: `${cap(p.name)} grew in ${framesLabel(grew)} (${grew.map(i => pct(sumColors(fs[i], p.colors) / refN)).join(', ')} of its reference size)`,
    });
  }

  // (b) silhouette size drift beyond squash-and-stretch.
  for (const [dim, key] of [['height', 'h'], ['width', 'w']] as const) {
    const refV = ref[key];
    if (!refV) continue;
    const off = fs.flatMap((s, i) => (live(i) && Math.abs(s[key] / refV - 1) > tol ? [i] : []));
    if (!off.length) continue;
    const worst = Math.max(...off.map(i => Math.abs(fs[i][key] / refV - 1)));
    issues.push({
      severity: worst > tol * 2 ? 'error' : 'warn', frames: off,
      message: `${cap(framesLabel(off))}: ${dim} ${off.map(i => `${fs[i][key]}px`).join(', ')} vs ${refV}px in the reference; beyond the ${pct(tol)} squash-and-stretch allowance`,
    });
  }

  // (c) colors the reference never uses.
  const drift = new Map<string, number>(), driftFrames: number[] = [];
  let worstShare = 0;
  fs.forEach((s, i) => {
    let n = 0;
    for (const [c, k] of s.colors) if (!ref.colors.has(c)) { drift.set(c, (drift.get(c) ?? 0) + k); n += k; }
    if (n) { driftFrames.push(i); worstShare = Math.max(worstShare, n / s.total); }
  });
  if (driftFrames.length) {
    const top = [...drift].sort((a, b) => b[1] - a[1]);
    const shown = top.slice(0, 4).map(([c]) => c).join(', ') + (top.length > 4 ? ` and ${top.length - 4} more` : '');
    issues.push({
      severity: worstShare > 0.02 ? 'warn' : 'info', frames: driftFrames,
      message: `${cap(framesLabel(driftFrames))} use${driftFrames.length > 1 ? '' : 's'} ${top.length} color${top.length > 1 ? 's' : ''} not in the reference (${shown}); snap to the character palette`,
    });
  }

  const score = Math.max(0, 100 - issues.reduce((s, i) => s + PENALTY[i.severity], 0));
  return { score, issues, perFrame };
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
