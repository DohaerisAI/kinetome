import type { Animation, Rect } from './schema.ts';
import type { SourceFrame } from './slice.ts';

export type SheetFormat = 'native' | 'rows' | 'aseprite' | 'texturepacker';

export interface ParsedSheet {
  format: SheetFormat;
  cellW: number;
  cellH: number;
  frames: SourceFrame[];
  animations: Animation[];
  pivot?: { x: number; y: number };
}

/** True when frames can be used as-is (uniform cells, no trim offsets) without repacking. */
export function isUniform(p: Pick<ParsedSheet, 'cellW' | 'cellH' | 'frames'>): boolean {
  return p.frames.every(f => f.rect.w === p.cellW && f.rect.h === p.cellH && f.offsetX === 0 && f.offsetY === 0);
}

const plain = (rect: Rect): SourceFrame => ({ rect, offsetX: 0, offsetY: 0 });

/* eslint-disable @typescript-eslint/no-explicit-any */
export function detectFormat(json: any): SheetFormat | null {
  if (!json || typeof json !== 'object') return null;
  if (json.version === 1 && Array.isArray(json.frames) && json.frameWidth) return 'native';
  if (json.frameWidth && json.animations && !Array.isArray(json.animations) &&
      Object.values(json.animations).every((a: any) => typeof a?.row === 'number')) return 'rows';
  const frames = Array.isArray(json.frames) ? json.frames : json.frames && Object.values(json.frames);
  if (frames?.length && frames.every((f: any) => f?.frame && typeof f.frame.x === 'number')) {
    return json.meta?.frameTags || /aseprite/i.test(json.meta?.app ?? '') ? 'aseprite' : 'texturepacker';
  }
  return null;
}

export function parseSheet(json: any): ParsedSheet {
  const format = detectFormat(json);
  switch (format) {
    case 'native': return {
      format, cellW: json.frameWidth, cellH: json.frameHeight,
      frames: json.frames.map(plain), animations: json.animations, pivot: json.pivot,
    };
    case 'rows': return parseRows(json);
    case 'aseprite':
    case 'texturepacker': return parseFrameList(json, format);
    default: throw new Error('Unrecognized sprite sheet JSON (supported: native, Aseprite, TexturePacker/Phaser, row-based)');
  }
}

/** `{ frameWidth, frameHeight, fps, animations: { idle: { row, frames, loop } } }` */
function parseRows(json: any): ParsedSheet {
  const fw = json.frameWidth, fh = json.frameHeight, fps = json.fps ?? 10;
  const frames: SourceFrame[] = [];
  const animations: Animation[] = [];
  for (const [name, a] of Object.entries<any>(json.animations)) {
    const idx: number[] = [];
    for (let i = 0; i < a.frames; i++) {
      idx.push(frames.length);
      frames.push(plain({ x: i * fw, y: a.row * fh, w: fw, h: fh }));
    }
    animations.push({ name, frames: idx, fps: a.fps ?? fps, loop: a.loop ?? true });
  }
  return { format: 'rows', cellW: fw, cellH: fh, frames, animations, pivot: json.pivot };
}

interface ListEntry { name: string; frame: Rect; sss?: { x: number; y: number }; source?: { w: number; h: number }; duration?: number; rotated?: boolean }

function parseFrameList(json: any, format: 'aseprite' | 'texturepacker'): ParsedSheet {
  const entries: ListEntry[] = (Array.isArray(json.frames)
    ? json.frames.map((f: any, i: number) => ({ ...f, filename: f.filename ?? String(i) }))
    : Object.entries<any>(json.frames).map(([filename, f]) => ({ ...f, filename })))
    .map((f: any) => ({
      name: f.filename, frame: f.frame, rotated: f.rotated, duration: f.duration,
      sss: f.trimmed || f.spriteSourceSize ? f.spriteSourceSize : undefined, source: f.sourceSize,
    }));
  if (entries.some(e => e.rotated)) throw new Error('Rotated frames are not supported yet; re-export without rotation');

  const cellW = Math.max(...entries.map(e => e.source?.w ?? e.frame.w));
  const cellH = Math.max(...entries.map(e => e.source?.h ?? e.frame.h));
  const frames: SourceFrame[] = entries.map(e => {
    const sw = e.source?.w ?? e.frame.w, sh = e.source?.h ?? e.frame.h;
    return {
      rect: e.frame,
      offsetX: (e.sss?.x ?? 0) + Math.floor((cellW - sw) / 2),
      offsetY: (e.sss?.y ?? 0) + (cellH - sh),
    };
  });

  const fpsOf = (idx: number[]) => {
    const ds = idx.map(i => entries[i].duration).filter((d): d is number => !!d);
    return ds.length ? Math.max(1, Math.min(60, Math.round(1000 / (ds.reduce((a, b) => a + b, 0) / ds.length)))) : 10;
  };

  let animations: Animation[] = [];
  const tags: any[] = json.meta?.frameTags ?? [];
  if (tags.length) {
    animations = tags.map(t => {
      const fwd: number[] = [];
      for (let i = t.from; i <= t.to; i++) fwd.push(i);
      const idx = t.direction === 'reverse' ? fwd.reverse()
        : t.direction === 'pingpong' ? [...fwd, ...fwd.slice(1, -1).reverse()] : fwd;
      return { name: t.name, frames: idx, fps: fpsOf(idx), loop: t.repeat === undefined || t.repeat === '0' || t.repeat === 0 };
    });
  } else {
    // group "walk_01.png", "walk_02.png" -> walk
    const groups = new Map<string, { i: number; n: number }[]>();
    entries.forEach((e, i) => {
      const base = e.name.replace(/\.[a-z0-9]+$/i, '');
      const m = base.match(/^(.*?)[\s_\-.]*(\d+)$/);
      const key = (m ? m[1] : base) || 'default';
      const list = groups.get(key) ?? [];
      list.push({ i, n: m ? parseInt(m[2], 10) : i });
      groups.set(key, list);
    });
    const collapse = [...groups.values()].every(g => g.length === 1);
    animations = collapse
      ? [{ name: 'default', frames: entries.map((_, i) => i), fps: fpsOf(entries.map((_, i) => i)), loop: true }]
      : [...groups].map(([name, g]) => {
          const idx = g.sort((a, b) => a.n - b.n).map(x => x.i);
          return { name, frames: idx, fps: fpsOf(idx), loop: true };
        });
  }
  return { format, cellW, cellH, frames, animations };
}
