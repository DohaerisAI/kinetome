import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { ZodError } from 'zod';
import * as store from './store.ts';
import { characters } from './characters.ts';

const app = new Hono().basePath('/api');

app.onError((err, c) => {
  if (err instanceof store.HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof ZodError) return c.json({ error: 'validation failed', issues: err.issues }, 400);
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

/** Multipart body with a JSON `asset` field and an optional `image` PNG file. */
async function readAssetForm(req: Request) {
  const form = await req.formData();
  const raw = form.get('asset');
  if (typeof raw !== 'string') throw new store.HttpError(400, 'missing asset field');
  const image = form.get('image');
  const png = image instanceof File ? new Uint8Array(await image.arrayBuffer()) : undefined;
  return { asset: JSON.parse(raw) as unknown, png };
}

app.get('/projects', async c => c.json(await store.listProjects()));
app.post('/projects', async c => {
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) throw new store.HttpError(400, 'name required');
  return c.json(await store.createProject(name.trim()), 201);
});
app.get('/projects/:p', async c => c.json(await store.getProject(c.req.param('p'))));
app.patch('/projects/:p', async c => {
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) throw new store.HttpError(400, 'name required');
  return c.json(await store.renameProject(c.req.param('p'), name));
});
app.post('/projects/:p/duplicate', async c => {
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  return c.json(await store.duplicateProject(c.req.param('p'), name), 201);
});
app.delete('/projects/:p', async c => { await store.deleteProject(c.req.param('p')); return c.body(null, 204); });

// trash: everything deleted lands here for 30 days
app.get('/trash', async c => c.json(await store.listTrash(c.req.query('project') || undefined)));
app.post('/trash/:id/restore', async c => c.json(await store.restoreTrash(c.req.param('id'))));
app.delete('/trash/:id', async c => { await store.purgeTrash(c.req.param('id')); return c.body(null, 204); });
app.delete('/trash', async c => { await store.purgeTrash(); return c.body(null, 204); });
app.get('/trash/:id/sheet.png', async c => {
  const buf = await readFile(`${store.trashItemPath(c.req.param('id'))}/sheet.png`).catch(() => null);
  if (!buf) throw new store.HttpError(404, 'not found');
  return c.body(buf, 200, { 'content-type': 'image/png' });
});
app.put('/projects/:p/style', async c => c.json(await store.saveStyle(c.req.param('p'), await c.req.json())));

app.put('/projects/:p/godot', async c => c.json(await store.saveGodotSettings(c.req.param('p'), await c.req.json())));
app.get('/projects/:p/export/godot.zip', async c => {
  const asset = c.req.query('asset') || undefined;
  const bytes = await store.exportGodotZip(c.req.param('p'), asset);
  const name = `${asset ?? c.req.param('p')}-godot.zip`;
  return c.body(bytes, 200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"` });
});
app.post('/projects/:p/export/godot/sync', async c => {
  const asset = c.req.query('asset') || undefined;
  return c.json(await store.syncGodot(c.req.param('p'), asset));
});

app.get('/projects/:p/assets', async c => c.json(await store.listAssets(c.req.param('p'))));
app.post('/projects/:p/assets', async c => {
  const { asset, png } = await readAssetForm(c.req.raw);
  if (!png) throw new store.HttpError(400, 'missing image');
  return c.json(await store.createAsset(c.req.param('p'), asset, png), 201);
});
app.put('/projects/:p/assets/:a', async c => {
  const { asset, png } = await readAssetForm(c.req.raw);
  return c.json(await store.updateAsset(c.req.param('p'), c.req.param('a'), asset, png));
});
app.delete('/projects/:p/assets/:a', async c => {
  await store.deleteAsset(c.req.param('p'), c.req.param('a'));
  return c.body(null, 204);
});
app.get('/projects/:p/assets/:a/sheet.png', async c => {
  const buf = await readFile(store.sheetPath(c.req.param('p'), c.req.param('a'))).catch(() => null);
  if (!buf) throw new store.HttpError(404, 'not found');
  return c.body(buf, 200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
});

// version history
app.get('/projects/:p/assets/:a/versions', async c => c.json(await store.listVersions(c.req.param('p'), c.req.param('a'))));
app.get('/projects/:p/assets/:a/versions/:v', async c => c.json(await store.getVersion(c.req.param('p'), c.req.param('a'), c.req.param('v'))));
app.get('/projects/:p/assets/:a/versions/:v/sheet.png', async c => {
  const buf = await readFile(store.versionSheetPath(c.req.param('p'), c.req.param('a'), c.req.param('v'))).catch(() => null);
  if (!buf) throw new store.HttpError(404, 'not found');
  return c.body(buf, 200, { 'content-type': 'image/png', 'cache-control': 'max-age=31536000, immutable' });
});
app.post('/projects/:p/assets/:a/versions/:v/restore', async c => c.json(await store.restoreVersion(c.req.param('p'), c.req.param('a'), c.req.param('v'))));

app.get('/projects/:p/assets/:a/edit', async c => c.json(await store.getEditMeta(c.req.param('p'), c.req.param('a'))));
app.get('/projects/:p/assets/:a/edit.png', async c => {
  const buf = await readFile(store.editPngPath(c.req.param('p'), c.req.param('a'))).catch(() => null);
  if (!buf) throw new store.HttpError(404, 'not found');
  return c.body(buf, 200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
});
app.put('/projects/:p/assets/:a/edit', async c => {
  const form = await c.req.formData();
  const meta = form.get('meta'), image = form.get('image');
  if (typeof meta !== 'string' || !(image instanceof File)) throw new store.HttpError(400, 'meta and image required');
  await store.saveEdit(c.req.param('p'), c.req.param('a'), JSON.parse(meta), new Uint8Array(await image.arrayBuffer()));
  return c.body(null, 204);
});

app.route('/', characters);

const port = Number(process.env.PORT ?? 4317);
await store.seedIfEmpty();
serve({ fetch: app.fetch, port }, () => console.log(`kinetome server on http://localhost:${port}  (workspace: ${store.WORKSPACE})`));
