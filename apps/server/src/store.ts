import { mkdir, readdir, readFile, rename, rm, writeFile, copyFile, stat, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  CharacterDesign, DEFAULT_STYLE, GodotSettings, PART_PRESETS, Project, SpriteAsset, StyleBible,
  godotFiles, isUniform, newMove, parseSheet, slugify, zip,
} from '@kinetome/core';

/**
 * On-disk layout (plain files so projects are diffable and git-friendly):
 *   <workspace>/<project>/project.json
 *   <workspace>/<project>/style.json
 *   <workspace>/<project>/assets/<asset>/asset.json + sheet.png
 */
export const WORKSPACE = resolve(process.env.SPRITE_WORKSPACE ?? new URL('../../../workspace', import.meta.url).pathname);
const SAMPLES = resolve(new URL('../../../samples', import.meta.url).pathname);

const ID = /^[a-z0-9][a-z0-9-]*$/;
export function safeId(id: string): string {
  if (!ID.test(id)) throw new HttpError(400, `invalid id: ${id}`);
  return id;
}

export class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string) { super(message); }
}

const projectDir = (p: string) => join(WORKSPACE, safeId(p));
const assetDir = (p: string, a: string) => join(projectDir(p), 'assets', safeId(a));

async function exists(path: string) {
  try { await stat(path); return true; } catch { return false; }
}
async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'not found'); throw e; }
}
const writeJson = (path: string, v: unknown) => writeFile(path, JSON.stringify(v, null, 2) + '\n');

export async function listProjects(): Promise<Project[]> {
  await mkdir(WORKSPACE, { recursive: true });
  const out: Project[] = [];
  for (const d of await readdir(WORKSPACE, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try { out.push(Project.parse(await readJson(join(WORKSPACE, d.name, 'project.json')))); } catch { /* skip foreign dirs */ }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function createProject(name: string, style: StyleBible = DEFAULT_STYLE): Promise<Project> {
  let id = slugify(name), n = 2;
  while (await exists(join(WORKSPACE, id))) id = `${slugify(name)}-${n++}`;
  const project: Project = { id, name, createdAt: new Date().toISOString(), godot: { path: null, dir: 'sprites' } };
  await mkdir(join(WORKSPACE, id, 'assets'), { recursive: true });
  await writeJson(join(WORKSPACE, id, 'project.json'), project);
  await writeJson(join(WORKSPACE, id, 'style.json'), style);
  return project;
}

export async function getProject(p: string) {
  const dir = projectDir(p);
  return {
    project: Project.parse(await readJson(join(dir, 'project.json'))),
    style: StyleBible.parse(await readJson(join(dir, 'style.json'))),
  };
}

export async function saveStyle(p: string, body: unknown): Promise<StyleBible> {
  const style = StyleBible.parse(body);
  await getProject(p);
  await writeJson(join(projectDir(p), 'style.json'), style);
  return style;
}

export async function listAssets(p: string): Promise<SpriteAsset[]> {
  const dir = join(projectDir(p), 'assets');
  if (!(await exists(dir))) throw new HttpError(404, 'project not found');
  const out: SpriteAsset[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try { out.push(SpriteAsset.parse(await readJson(join(dir, d.name, 'asset.json')))); } catch { /* skip broken */ }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getAsset(p: string, a: string): Promise<SpriteAsset> {
  return SpriteAsset.parse(await readJson(join(assetDir(p, a), 'asset.json')));
}

export function sheetPath(p: string, a: string): string {
  return join(assetDir(p, a), 'sheet.png');
}

/** Creates an asset. `draft` has everything except id/timestamps; the id is derived from the name. */
export async function createAsset(p: string, draft: unknown, png: Uint8Array): Promise<SpriteAsset> {
  await getProject(p);
  const now = new Date().toISOString();
  const partial = draft as { name?: string };
  let id = slugify(partial.name ?? 'sprite'), n = 2;
  while (await exists(join(projectDir(p), 'assets', id))) id = `${slugify(partial.name ?? 'sprite')}-${n++}`;
  const asset = SpriteAsset.parse({ ...(draft as object), version: 1, id, image: 'sheet.png', createdAt: now, updatedAt: now });
  await mkdir(assetDir(p, id), { recursive: true });
  await writeFile(sheetPath(p, id), png);
  await writeJson(join(assetDir(p, id), 'asset.json'), asset);
  return asset;
}

export async function updateAsset(p: string, a: string, body: unknown, png?: Uint8Array): Promise<SpriteAsset> {
  const prev = await getAsset(p, a);
  const next = SpriteAsset.parse({ ...(body as object), version: 1, id: prev.id, createdAt: prev.createdAt, image: 'sheet.png', updatedAt: new Date().toISOString() });
  await snapshotAsset(p, a, prev, describeChange(prev, next, !!png));
  if (png) await writeFile(sheetPath(p, a), png);
  await writeJson(join(assetDir(p, a), 'asset.json'), next);
  return next;
}

/** Deleting moves the asset (with its history) to the trash; it can be restored for 30 days. */
export async function deleteAsset(p: string, a: string): Promise<void> {
  const asset = await getAsset(p, a);
  await toTrash('asset', p, asset.id, asset.name, assetDir(p, a));
}

// ---------- version history (every save keeps the previous version) ----------

const HISTORY_LIMIT = 40;
const stamp = (iso: string) => iso.replace(/[:.]/g, '-');
const historyDir = (p: string, a: string) => join(assetDir(p, a), 'history');

export interface AssetVersion { id: string; savedAt: string; note: string; frames: number; animations: string[]; name: string }

/** A human line for what changed between two versions ("added attack · redrew pixels"). */
function describeChange(prev: SpriteAsset, next: SpriteAsset, pixels: boolean): string {
  const bits: string[] = [];
  const a = new Set(prev.animations.map(x => x.name)), b = new Set(next.animations.map(x => x.name));
  const added = [...b].filter(x => !a.has(x)), removed = [...a].filter(x => !b.has(x));
  if (added.length) bits.push(`added ${added.join(', ')}`);
  if (removed.length) bits.push(`removed ${removed.join(', ')}`);
  if (prev.name !== next.name) bits.push(`renamed to ${next.name}`);
  const timing = next.animations.some(x => { const o = prev.animations.find(y => y.name === x.name); return o && (o.fps !== x.fps || o.loop !== x.loop || o.frames.join() !== x.frames.join()); });
  if (timing) bits.push('changed timing');
  if (pixels) bits.push(prev.frames.length !== next.frames.length ? `${prev.frames.length} → ${next.frames.length} frames` : 'redrew pixels');
  if (prev.pivot.x !== next.pivot.x || prev.pivot.y !== next.pivot.y) bits.push('moved pivot');
  if (prev.description !== next.description) bits.push('description');
  if ((prev as { frameData?: unknown }).frameData !== undefined && JSON.stringify((prev as { frameData?: unknown }).frameData) !== JSON.stringify((next as { frameData?: unknown }).frameData)) bits.push('hitboxes / events');
  return bits.join(' · ') || 'details';
}

async function snapshotAsset(p: string, a: string, prev: SpriteAsset, note: string): Promise<void> {
  const dir = join(historyDir(p, a), stamp(prev.updatedAt));
  if (await exists(dir)) return;
  await mkdir(dir, { recursive: true });
  await copyFile(sheetPath(p, a), join(dir, 'sheet.png'));
  await writeJson(join(dir, 'asset.json'), prev);
  await writeJson(join(dir, 'info.json'), { note, savedAt: new Date().toISOString() });
  const all = (await readdir(historyDir(p, a))).sort();
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_LIMIT))) await rm(join(historyDir(p, a), old), { recursive: true, force: true });
}

export async function listVersions(p: string, a: string): Promise<AssetVersion[]> {
  await getAsset(p, a);
  if (!(await exists(historyDir(p, a)))) return [];
  const out: AssetVersion[] = [];
  for (const v of (await readdir(historyDir(p, a))).sort().reverse()) {
    try {
      const asset = SpriteAsset.parse(await readJson(join(historyDir(p, a), v, 'asset.json')));
      const info = await readJson(join(historyDir(p, a), v, 'info.json')).catch(() => ({})) as { note?: string; savedAt?: string };
      out.push({ id: v, savedAt: info.savedAt ?? asset.updatedAt, note: info.note ?? '', frames: asset.frames.length, animations: asset.animations.map(x => x.name), name: asset.name });
    } catch { /* skip broken */ }
  }
  return out;
}

const versionDir = (p: string, a: string, v: string) => {
  if (!/^[0-9TZ-]+$/.test(v)) throw new HttpError(400, 'invalid version');
  return join(historyDir(p, a), v);
};
export const versionSheetPath = (p: string, a: string, v: string) => join(versionDir(p, a, v), 'sheet.png');
export async function getVersion(p: string, a: string, v: string): Promise<SpriteAsset> {
  return SpriteAsset.parse(await readJson(join(versionDir(p, a, v), 'asset.json')));
}

/** Restores a version; the current state is snapshotted first, so restoring is itself undoable. */
export async function restoreVersion(p: string, a: string, v: string): Promise<SpriteAsset> {
  const old = await getVersion(p, a, v);
  const png = new Uint8Array(await readFile(versionSheetPath(p, a, v)));
  const cur = await getAsset(p, a);
  await snapshotAsset(p, a, cur, `before restoring ${v.slice(0, 10)}`);
  const next = SpriteAsset.parse({ ...old, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() });
  await writeFile(sheetPath(p, a), png);
  await writeJson(join(assetDir(p, a), 'asset.json'), next);
  await rm(join(assetDir(p, a), 'edit.json'), { force: true }); // the layered doc belonged to the replaced version
  return next;
}

// ---------- trash ----------

const TRASH = join(WORKSPACE, '.trash');
const TRASH_DAYS = 30;
export type TrashKind = 'asset' | 'character' | 'project';
export interface TrashEntry { id: string; kind: TrashKind; projectId: string; itemId: string; name: string; deletedAt: string }

async function toTrash(kind: TrashKind, p: string, itemId: string, name: string, path: string): Promise<void> {
  const id = `${Date.now()}-${kind}-${itemId}`;
  const dir = join(TRASH, id);
  await mkdir(dir, { recursive: true });
  await rename(path, join(dir, 'item'));
  const entry: TrashEntry = { id, kind, projectId: p, itemId, name, deletedAt: new Date().toISOString() };
  await writeJson(join(dir, 'entry.json'), entry);
}

const trashDir = (id: string) => {
  if (!/^[0-9]+-(asset|character|project)-[a-z0-9-]+$/.test(id)) throw new HttpError(400, 'invalid trash id');
  return join(TRASH, id);
};

/** Lists the trash (optionally one project's), purging anything past the retention window. */
export async function listTrash(p?: string): Promise<TrashEntry[]> {
  if (!(await exists(TRASH))) return [];
  const out: TrashEntry[] = [];
  const cutoff = Date.now() - TRASH_DAYS * 86400_000;
  for (const d of await readdir(TRASH)) {
    try {
      const e = await readJson(join(TRASH, d, 'entry.json')) as TrashEntry;
      if (new Date(e.deletedAt).getTime() < cutoff) { await rm(join(TRASH, d), { recursive: true, force: true }); continue; }
      if (!p || e.projectId === p || e.kind === 'project') out.push(e);
    } catch { /* skip */ }
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export const trashItemPath = (id: string) => join(trashDir(id), 'item');

/** Puts an item back; a clashing id gets a new one (a same-named sprite was made since). */
export async function restoreTrash(id: string): Promise<TrashEntry & { restoredId: string }> {
  const dir = trashDir(id);
  const e = await readJson(join(dir, 'entry.json')) as TrashEntry;
  const item = join(dir, 'item');
  let restoredId = e.itemId;
  if (e.kind === 'project') {
    let n = 2;
    while (await exists(join(WORKSPACE, restoredId))) restoredId = `${e.itemId}-${n++}`;
    await rename(item, join(WORKSPACE, restoredId));
    if (restoredId !== e.itemId) {
      const proj = Project.parse(await readJson(join(WORKSPACE, restoredId, 'project.json')));
      await writeJson(join(WORKSPACE, restoredId, 'project.json'), { ...proj, id: restoredId });
    }
  } else {
    if (!(await exists(projectDir(e.projectId)))) throw new HttpError(409, 'its project is gone (restore the project first)');
    if (e.kind === 'asset') {
      let n = 2;
      while (await exists(assetDir(e.projectId, restoredId))) restoredId = `${e.itemId}-${n++}`;
      await mkdir(join(projectDir(e.projectId), 'assets'), { recursive: true });
      await rename(item, assetDir(e.projectId, restoredId));
      if (restoredId !== e.itemId) {
        const asset = SpriteAsset.parse(await readJson(join(assetDir(e.projectId, restoredId), 'asset.json')));
        await writeJson(join(assetDir(e.projectId, restoredId), 'asset.json'), { ...asset, id: restoredId });
      }
    } else {
      let n = 2;
      while (await exists(charPath(e.projectId, restoredId))) restoredId = `${e.itemId}-${n++}`;
      await mkdir(charDir(e.projectId), { recursive: true });
      const design = CharacterDesign.parse(await readJson(item));
      await writeJson(charPath(e.projectId, restoredId), { ...design, id: restoredId });
      await rm(item, { force: true });
    }
  }
  await rm(dir, { recursive: true, force: true });
  return { ...e, restoredId };
}

export async function purgeTrash(id?: string): Promise<void> {
  if (id) { await rm(trashDir(id), { recursive: true, force: true }); return; }
  await rm(TRASH, { recursive: true, force: true });
}

// ---------- project management ----------

export async function renameProject(p: string, name: string): Promise<Project> {
  const { project } = await getProject(p);
  const next = { ...project, name: name.trim() || project.name };
  await writeJson(join(projectDir(p), 'project.json'), next);
  return next;
}

export async function duplicateProject(p: string, name?: string): Promise<Project> {
  const { project } = await getProject(p);
  const base = name?.trim() || `${project.name} copy`;
  let id = slugify(base), n = 2;
  while (await exists(join(WORKSPACE, id))) id = `${slugify(base)}-${n++}`;
  // version history and the layered edit docs come along: a duplicate is a full fork
  await cp(projectDir(p), join(WORKSPACE, id), { recursive: true });
  const next: Project = { ...project, id, name: base, createdAt: new Date().toISOString() };
  await writeJson(join(WORKSPACE, id, 'project.json'), next);
  return next;
}

export async function deleteProject(p: string): Promise<void> {
  const { project } = await getProject(p);
  await toTrash('project', p, project.id, project.name, projectDir(p));
}

/** First run: create a demo project holding the wizard spike so the studio is never empty. */
export async function seedIfEmpty(): Promise<void> {
  if ((await listProjects()).length) return;
  const wizardStyle: StyleBible = {
    palette: ['#0b0a1f', '#14133a', '#221d52', '#191538', '#cfd8ff', '#5d61a3', '#f2e9c9', '#c9bb8e',
      '#3a3552', '#57507a', '#221f33', '#120d1c', '#3d1f6b', '#5b2fa0', '#7d4cc7', '#e8b24a',
      '#f0b88a', '#c07e5a', '#e9e6f2', '#a9a4c0', '#8a5a32', '#4f2d18', '#ffffff', '#9ffcff',
      '#35d0ff', '#2a6bd8', '#1f2f7a'],
    unitHeight: 40,
    maxColorsPerSprite: 20,
    outline: { mode: 'full', color: '#120d1c' },
    lightDirection: 'front',
    perspective: 'side',
    notes: '16-bit night fantasy. Deep blue/purple world, warm skin and gold accents, cyan magic. Dark #120d1c outline on characters.',
  };
  const project = await createProject('Demo', wizardStyle);
  const json = JSON.parse(await readFile(join(SAMPLES, 'wizard', 'wizard.json'), 'utf8'));
  const parsed = parseSheet(json);
  if (!isUniform(parsed)) throw new Error('sample sheet must be uniform');
  const id = 'wizard', now = new Date().toISOString();
  const asset: SpriteAsset = {
    version: 1, id, name: 'Wizard', kind: 'character', source: 'code', image: 'sheet.png',
    frameWidth: parsed.cellW, frameHeight: parsed.cellH, frames: parsed.frames.map(f => f.rect),
    pivot: parsed.pivot ?? { x: Math.floor(parsed.cellW / 2), y: parsed.cellH - 1 },
    animations: parsed.animations, tags: ['sample'], description: 'An old wizard in a tall bent purple hat with a gold band, long white beard, purple robe with gold trim, holding a wooden staff with a glowing cyan gem.', reference: true, createdAt: now, updatedAt: now,
  };
  await mkdir(assetDir(project.id, id), { recursive: true });
  await copyFile(join(SAMPLES, 'wizard', 'wizard.png'), sheetPath(project.id, id));
  await writeJson(join(assetDir(project.id, id), 'asset.json'), asset);
}

export async function saveGodotSettings(p: string, body: unknown): Promise<Project> {
  const godot = GodotSettings.parse(body);
  if (godot.path && !(await exists(join(godot.path, 'project.godot')))) {
    throw new HttpError(400, `no project.godot found in ${godot.path}`);
  }
  const { project } = await getProject(p);
  const next = { ...project, godot };
  await writeJson(join(projectDir(p), 'project.json'), next);
  return next;
}

async function collectGodotFiles(p: string, assetId?: string) {
  const { project } = await getProject(p);
  const assets = assetId ? [await getAsset(p, assetId)] : await listAssets(p);
  const files = [];
  for (const a of assets) files.push(...godotFiles(a, new Uint8Array(await readFile(sheetPath(p, a.id))), project.godot.dir));
  return { project, files };
}

const toBytes = (f: { text?: string; binary?: Uint8Array }) => f.binary ?? new TextEncoder().encode(f.text ?? '');

/** Zip laid out relative to the Godot project root: unzip into the project and it just works. */
export async function exportGodotZip(p: string, assetId?: string): Promise<Uint8Array<ArrayBuffer>> {
  const { files } = await collectGodotFiles(p, assetId);
  return zip(files.map(f => ({ path: f.path, data: toBytes(f) })));
}

/** Writes straight into the configured Godot project; Godot re-imports when its window regains focus. */
export async function syncGodot(p: string, assetId?: string): Promise<{ written: string[]; root: string }> {
  const { project, files } = await collectGodotFiles(p, assetId);
  const root = project.godot.path;
  if (!root) throw new HttpError(400, 'set the Godot project path first');
  if (!(await exists(join(root, 'project.godot')))) throw new HttpError(400, `no project.godot found in ${root}`);
  for (const f of files) {
    const dest = resolve(root, f.path);
    if (!dest.startsWith(resolve(root) + '/')) throw new HttpError(400, `refusing to write outside the Godot project: ${f.path}`);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, toBytes(f));
  }
  return { written: files.map(f => `res://${f.path}`), root };
}

// ---------- character designs ----------

const charDir = (p: string) => join(projectDir(p), 'characters');
const charPath = (p: string, c: string) => join(charDir(p), `${safeId(c)}.json`);

export function projectPath(p: string): string { return projectDir(p); }

export async function listCharacters(p: string): Promise<CharacterDesign[]> {
  await getProject(p);
  await mkdir(charDir(p), { recursive: true });
  const out: CharacterDesign[] = [];
  for (const f of await readdir(charDir(p))) {
    if (!f.endsWith('.json')) continue;
    try { out.push(CharacterDesign.parse(await readJson(join(charDir(p), f)))); } catch { /* skip broken */ }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getCharacter(p: string, c: string): Promise<CharacterDesign> {
  return CharacterDesign.parse(await readJson(charPath(p, c)));
}

export async function createCharacter(p: string, name: string): Promise<CharacterDesign> {
  const { style } = await getProject(p);
  await mkdir(charDir(p), { recursive: true });
  let id = slugify(name), n = 2;
  while (await exists(charPath(p, id))) id = `${slugify(name)}-${n++}`;
  const now = new Date().toISOString();
  const design = CharacterDesign.parse({
    id, name, pixelHeight: style.unitHeight,
    parts: PART_PRESETS.filter(x => ['Skin', 'Hair', 'Main cloth', 'Accent'].includes(x.name)),
    outline: style.outline.mode === 'none' ? null : (style.outline.color ?? '#1a1420'),
    moves: [newMove('idle')],
    createdAt: now, updatedAt: now,
  });
  await writeJson(charPath(p, id), design);
  return design;
}

export async function saveCharacter(p: string, c: string, body: unknown): Promise<CharacterDesign> {
  const prev = await getCharacter(p, c);
  const next = CharacterDesign.parse({ ...(body as object), id: prev.id, createdAt: prev.createdAt, updatedAt: new Date().toISOString() });
  await snapshotDesign(p, prev, next);
  await writeJson(charPath(p, c), next);
  return next;
}

export async function deleteCharacter(p: string, c: string): Promise<void> {
  const d = await getCharacter(p, c);
  await toTrash('character', p, d.id, d.name, charPath(p, c));
}

// Designs keep a history of their animation programs: every time Claude (or you) changes
// one, the previous program is kept so any animation can be compared and rolled back.
const designHistoryDir = (p: string, c: string) => join(charDir(p), '.history', safeId(c));

export interface ProgramVersion { id: string; move: string; savedAt: string; code: string }

async function snapshotDesign(p: string, prev: CharacterDesign, next: CharacterDesign): Promise<void> {
  const changed = Object.keys(prev.programs).filter(m => prev.programs[m] !== next.programs[m]);
  if (!changed.length) return;
  const dir = designHistoryDir(p, prev.id);
  await mkdir(dir, { recursive: true });
  const at = new Date().toISOString();
  for (const move of changed) {
    await writeJson(join(dir, `${stamp(at)}--${safeId(move)}.json`), { move, savedAt: at, code: prev.programs[move] });
  }
  const all = (await readdir(dir)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_LIMIT * 3))) await rm(join(dir, old), { force: true });
}

export async function listProgramVersions(p: string, c: string, move?: string): Promise<ProgramVersion[]> {
  const dir = designHistoryDir(p, c);
  if (!(await exists(dir))) return [];
  const out: ProgramVersion[] = [];
  for (const f of (await readdir(dir)).sort().reverse()) {
    const m = /^(.+)--([a-z0-9-]+)\.json$/.exec(f);
    if (!m || (move && m[2] !== move)) continue;
    const v = await readJson(join(dir, f)) as { move: string; savedAt: string; code: string };
    out.push({ id: f.replace(/\.json$/, ''), move: v.move, savedAt: v.savedAt, code: v.code });
  }
  return out;
}

// ---------- layered editor documents (next to the flattened sheet) ----------

export async function saveEdit(p: string, a: string, meta: unknown, png: Uint8Array): Promise<void> {
  await getAsset(p, a);
  await writeFile(join(assetDir(p, a), 'edit.png'), png);
  await writeJson(join(assetDir(p, a), 'edit.json'), meta);
}

export async function getEditMeta(p: string, a: string): Promise<unknown> {
  return readJson(join(assetDir(p, a), 'edit.json'));
}

export const editPngPath = (p: string, a: string) => join(assetDir(p, a), 'edit.png');
