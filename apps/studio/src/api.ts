import { track } from './claudeActivity.ts';
import type { CharacterDesign, GodotSettings, Project, Rect, SpriteAsset, StyleBible } from '@kinetome/core';

export type Model = 'sonnet' | 'opus' | 'haiku';
export interface Usage { input: number; cacheRead: number; cacheWrite: number; output: number; costUsd: number; ms: number }
export interface Packed { sheet: string; frameWidth: number; frameHeight: number; rects: Rect[]; pivot: { x: number; y: number }; animations: { name: string; fps: number; loop: boolean; frames: number[] }[] }

export type CodeEvent =
  | { type: 'status'; step: 'writing' | 'reviewing' | 'rendering'; iteration: number; total: number; message: string }
  | { type: 'iteration'; iteration: number; total: number; notes: string; code: string; usage: Usage; preview?: string; packed?: Packed; error?: string }
  | { type: 'done'; ok: boolean; code: string | null; usage: Usage; packed: Packed | null; design?: CharacterDesign | null }
  | { type: 'fail'; message: string; usage: Usage };

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** POSTs JSON and parses the server-sent event stream until it ends. */
async function readStream(url: string, body: unknown, onEvent: (e: CodeEvent) => void, signal?: AbortSignal) {
  const res = await fetch(url, { ...json(body), signal });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
      if (ev && data) onEvent({ type: ev, ...JSON.parse(data) } as CodeEvent);
    }
  }
}

export type TrashKind = 'asset' | 'character' | 'project';
export interface TrashEntry { id: string; kind: TrashKind; projectId: string; itemId: string; name: string; deletedAt: string }
export interface AssetVersion { id: string; savedAt: string; note: string; frames: number; animations: string[]; name: string }
export interface ProgramVersion { id: string; move: string; savedAt: string; code: string }

export type AssetDraft = Omit<SpriteAsset, 'version' | 'id' | 'image' | 'createdAt' | 'updatedAt'>;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

function assetForm(asset: unknown, png?: Blob): FormData {
  const f = new FormData();
  f.set('asset', JSON.stringify(asset));
  if (png) f.set('image', png, 'sheet.png');
  return f;
}

export const api = {
  listProjects: () => call<Project[]>('/projects'),
  createProject: (name: string) => call<Project>('/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  getProject: (p: string) => call<{ project: Project; style: StyleBible }>(`/projects/${p}`),
  saveStyle: (p: string, style: StyleBible) => call<StyleBible>(`/projects/${p}/style`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(style),
  }),
  listAssets: (p: string) => call<SpriteAsset[]>(`/projects/${p}/assets`),
  createAsset: (p: string, draft: AssetDraft, png: Blob) =>
    call<SpriteAsset>(`/projects/${p}/assets`, { method: 'POST', body: assetForm(draft, png) }),
  updateAsset: (p: string, asset: SpriteAsset, png?: Blob) =>
    call<SpriteAsset>(`/projects/${p}/assets/${asset.id}`, { method: 'PUT', body: assetForm(asset, png) }),
  deleteAsset: (p: string, a: string) => call<void>(`/projects/${p}/assets/${a}`, { method: 'DELETE' }),
  saveGodot: (p: string, godot: GodotSettings) => call<Project>(`/projects/${p}/godot`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(godot),
  }),
  godotZipUrl: (p: string, assetId?: string) => `/api/projects/${p}/export/godot.zip${assetId ? `?asset=${assetId}` : ''}`,
  syncGodot: (p: string, assetId?: string) =>
    call<{ written: string[]; root: string }>(`/projects/${p}/export/godot/sync${assetId ? `?asset=${assetId}` : ''}`, { method: 'POST' }),
  claudeStatus: () => call<{ available: boolean; version: string | null; error?: string }>('/claude/status'),
  usage: (p: string) => call<{ total: Usage & { calls: number } }>(`/projects/${p}/claude/usage`),
  listCharacters: (p: string) => call<CharacterDesign[]>(`/projects/${p}/characters`),
  createCharacter: (p: string, name: string) => call<CharacterDesign>(`/projects/${p}/characters`, json({ name })),
  saveCharacter: (p: string, d: CharacterDesign) => call<CharacterDesign>(`/projects/${p}/characters/${d.id}`, { ...json(d), method: 'PUT' }),
  deleteCharacter: (p: string, id: string) => call<void>(`/projects/${p}/characters/${id}`, { method: 'DELETE' }),
  describe: (p: string, id: string, model: Model) => track('composing', 'Writing the visual brief', () => call<{ design: CharacterDesign; conflicts: string[]; usage: Usage }>(`/projects/${p}/characters/${id}/describe`, json({ model }))),
  draftMove: (p: string, id: string, move: string, model: Model, instruction?: string) =>
    track('shaping', `Drafting ${move} poses`, () => call<{ design: CharacterDesign; usage: Usage }>(`/projects/${p}/characters/${id}/moves/${move}/draft`, json({ model, instruction }))),
  renderCode: (p: string, id: string, code?: string) =>
    call<{ ok: true; packed: Packed; preview: string } | { ok: false; error: string }>(`/projects/${p}/characters/${id}/code/render`, json({ code })),
  /** Streams the write -> render -> review loop. Resolves when the stream ends. */
  runCode: (p: string, id: string, body: { model: Model; animations: string[]; rounds: number; feedback?: string; fromCurrent?: boolean; useReference?: boolean }, onEvent: (e: CodeEvent) => void, signal?: AbortSignal) =>
    track('weaving', 'Animating in code', () => readStream(`/api/projects/${p}/characters/${id}/code/run`, body, onEvent, signal)),
  /** One move: new program, add to the existing one, remake or refine; other animations are kept. */
  animate: (p: string, id: string, body: { model: Model; move: string; mode?: 'auto' | 'remake' | 'refine'; rounds: number; feedback?: string; useReference?: boolean }, onEvent: (e: CodeEvent) => void, signal?: AbortSignal) =>
    track('weaving', `Animating ${body.move}`, () => readStream(`/api/projects/${p}/characters/${id}/code/animate`, body, onEvent, signal)),
  uploadMoveRef: (p: string, id: string, move: string, file: File) => {
    const f = new FormData(); f.set('image', file, file.name);
    return call<CharacterDesign>(`/projects/${p}/characters/${id}/moves/${move}/refs`, { method: 'POST', body: f });
  },
  deleteMoveRef: (p: string, id: string, move: string, file: string) => call<CharacterDesign>(`/projects/${p}/characters/${id}/moves/${move}/refs/${file}`, { method: 'DELETE' }),
  moveRefUrl: (p: string, id: string, move: string, file: string) => `/api/projects/${p}/characters/${id}/moves/${move}/refs/${file}`,
  // projects
  renameProject: (p: string, name: string) => call<Project>(`/projects/${p}`, { ...json({ name }), method: 'PATCH' }),
  duplicateProject: (p: string, name?: string) => call<Project>(`/projects/${p}/duplicate`, json({ name })),
  deleteProject: (p: string) => call<void>(`/projects/${p}`, { method: 'DELETE' }),
  // trash
  listTrash: (p?: string) => call<TrashEntry[]>(`/trash${p ? `?project=${p}` : ''}`),
  restoreTrash: (id: string) => call<TrashEntry & { restoredId: string }>(`/trash/${id}/restore`, { method: 'POST' }),
  purgeTrash: (id?: string) => call<void>(id ? `/trash/${id}` : '/trash', { method: 'DELETE' }),
  trashThumbUrl: (id: string) => `/api/trash/${id}/sheet.png`,
  // version history
  listVersions: (p: string, a: string) => call<AssetVersion[]>(`/projects/${p}/assets/${a}/versions`),
  getVersion: (p: string, a: string, v: string) => call<SpriteAsset>(`/projects/${p}/assets/${a}/versions/${v}`),
  versionSheetUrl: (p: string, a: string, v: string) => `/api/projects/${p}/assets/${a}/versions/${v}/sheet.png`,
  restoreVersion: (p: string, a: string, v: string) => call<SpriteAsset>(`/projects/${p}/assets/${a}/versions/${v}/restore`, { method: 'POST' }),
  programHistory: (p: string, c: string, move?: string) => call<ProgramVersion[]>(`/projects/${p}/characters/${c}/programs/history${move ? `?move=${move}` : ''}`),
  // rig: parts cut once, moves as keyframes
  rigSuggest: (p: string, c: string, model: Model) => track('shaping', 'Cutting the rig', () => call<{ design: CharacterDesign; notes: string; usage: Usage }>(`/projects/${p}/characters/${c}/rig/suggest`, json({ model }))),
  rigAnimate: (p: string, c: string, body: { move: string; model: Model; rounds: number; feedback?: string }) => track('weaving', `Keyframing ${body.move}`, () => call<{ design: CharacterDesign; notes: string; usage: Usage }>(`/projects/${p}/characters/${c}/rig/animate`, json(body))),
  queueMoves: (p: string, c: string, body: { moves: string[]; model: Model; rounds: number }) => call<unknown[]>(`/projects/${p}/characters/${c}/rig/queue`, json(body)),
  cancelJob: (p: string, id: string) => call<unknown[]>(`/projects/${p}/queue/${id}`, { method: 'DELETE' }),
  sheetUrl: (p: string, a: SpriteAsset) => `/api/projects/${p}/assets/${a.id}/sheet.png?v=${encodeURIComponent(a.updatedAt)}`,
};
