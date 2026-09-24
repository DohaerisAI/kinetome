import { countColors, PaletteMatcher, type PixelImage } from './color.ts';
import type { SpriteAsset, StyleBible } from './schema.ts';

export type Severity = 'error' | 'warn' | 'info';
export type FixId = 'snap-palette' | 'harden-alpha' | 'downscale';

export interface LintIssue {
  code: 'off-palette' | 'semi-alpha' | 'too-many-colors' | 'scale' | 'baseline-jitter';
  severity: Severity;
  message: string;
  fix?: FixId;
  /** Offending colors, for off-palette. */
  colors?: string[];
  /** Integer downscale factor, for scale issues drawn at k× density. */
  factor?: number;
}

export interface LintReport {
  issues: LintIssue[];
  stats: { colors: number; offPalettePixels: number; semiAlphaPixels: number; contentHeight: number };
}

/**
 * Checks an asset against the project's Style Bible. This is the mechanical half of
 * project-wide consistency: whatever produced the pixels (import, code, model), they
 * must use the same palette, alpha rules, and pixel density as everything else.
 */
export function lintAsset(img: PixelImage, asset: SpriteAsset, style: StyleBible): LintReport {
  const issues: LintIssue[] = [];
  const m = new PaletteMatcher(style.palette);
  const d = img.data;

  let semi = 0, off = 0;
  const offColors = new Map<string, number>();
  const colors = countColors(img);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a > 0 && a < 255) semi++;
  }
  for (const [hex, n] of colors) {
    const v = parseInt(hex.slice(1), 16);
    if (!m.has((v >> 16) & 255, (v >> 8) & 255, v & 255)) { off += n; offColors.set(hex, n); }
  }

  if (off > 0) {
    const top = [...offColors].sort((a, b) => b[1] - a[1]).map(([h]) => h);
    issues.push({
      code: 'off-palette', severity: 'error', fix: 'snap-palette', colors: top.slice(0, 12),
      message: `${off} px use ${offColors.size} color${offColors.size === 1 ? '' : 's'} outside the project palette`,
    });
  }
  if (semi > 0) {
    issues.push({ code: 'semi-alpha', severity: 'warn', fix: 'harden-alpha', message: `${semi} px are semi-transparent (pixel art should be fully on or off)` });
  }
  if (colors.size > style.maxColorsPerSprite) {
    issues.push({ code: 'too-many-colors', severity: 'warn', message: `Uses ${colors.size} colors; style allows ${style.maxColorsPerSprite} per sprite` });
  }

  // content height & baseline per frame (relative to each frame's cell)
  const bottoms: number[] = [];
  let contentHeight = 0;
  for (const f of asset.frames) {
    let top = -1, bottom = -1;
    for (let y = f.y; y < f.y + f.h; y++) {
      for (let x = f.x; x < f.x + f.w; x++) {
        if (d[(y * img.width + x) * 4 + 3] > 0) { if (top < 0) top = y; bottom = y; break; }
      }
    }
    if (top < 0) continue;
    contentHeight = Math.max(contentHeight, bottom - top + 1);
    bottoms.push(bottom - f.y);
  }

  if (asset.kind === 'character' && contentHeight > 0) {
    const ratio = contentHeight / style.unitHeight;
    if (ratio < 0.6 || ratio > 1.6) {
      const k = Math.round(ratio);
      const divisible = k >= 2 && asset.frameWidth % k === 0 && asset.frameHeight % k === 0;
      issues.push({
        code: 'scale', severity: 'warn', ...(divisible ? { fix: 'downscale' as const, factor: k } : {}),
        message: `Character is ${contentHeight}px tall vs project unit of ${style.unitHeight}px; it will look ${ratio > 1 ? 'higher' : 'lower'}-resolution than the rest of the cast`,
      });
    }
  }

  for (const anim of asset.animations) {
    const bs = anim.frames.map(i => bottoms[i]).filter(b => b !== undefined);
    if (bs.length < 2) continue;
    const spread = Math.max(...bs) - Math.min(...bs);
    if (spread > 2) {
      issues.push({ code: 'baseline-jitter', severity: 'info', message: `"${anim.name}": feet move ${spread}px between frames (fine for jumps, a bug for walks)` });
    }
  }

  return { issues, stats: { colors: colors.size, offPalettePixels: off, semiAlphaPixels: semi, contentHeight } };
}
