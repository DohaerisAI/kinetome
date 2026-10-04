import { Hono } from 'hono';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as store from './store.ts';

/**
 * Optional Gemini API connection: the side-view still (image model) and move clips (Veo) made
 * from inside Kinetome instead of copy-pasting into the Gemini app.
 *
 * The key never reaches the browser: it lives in <workspace>/.kinetome-secrets.json (the
 * workspace is git-ignored, the file is chmod 600) or the GEMINI_API_KEY environment variable,
 * and every call to Google is made from here.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
const SECRETS = join(store.WORKSPACE, '.kinetome-secrets.json');

export const VIDEO_MODELS = [
  { id: 'veo-3.1-lite-generate-preview', label: 'Veo 3.1 Lite', usdPerSecond: 0.05 },
  { id: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast', usdPerSecond: 0.1 },
  { id: 'veo-3.1-generate-preview', label: 'Veo 3.1', usdPerSecond: 0.4 },
];
export const IMAGE_MODELS = ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];

interface Secrets { geminiKey?: string; imageModel?: string; videoModel?: string }

async function readSecrets(): Promise<Secrets> {
  try { return JSON.parse(await readFile(SECRETS, 'utf8')) as Secrets; } catch { return {}; }
}
async function writeSecrets(s: Secrets) {
  await mkdir(store.WORKSPACE, { recursive: true });
  await writeFile(SECRETS, JSON.stringify(s, null, 2), { mode: 0o600 });
  await chmod(SECRETS, 0o600).catch(() => {});
}
async function config() {
  const s = await readSecrets();
  const key = s.geminiKey || process.env.GEMINI_API_KEY || '';
  return {
    key,
    source: s.geminiKey ? 'settings' as const : process.env.GEMINI_API_KEY ? 'env' as const : null,
    imageModel: s.imageModel || IMAGE_MODELS[0],
    videoModel: s.videoModel || VIDEO_MODELS[1].id,
  };
}
async function needKey() {
  const c = await config();
  if (!c.key) throw new store.HttpError(400, 'Add a Gemini API key in Settings first');
  return c;
}

/** Calls Google and turns its error body into a readable message. */
async function google(path: string, key: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API}/${path}`, { ...init, headers: { 'x-goog-api-key': key, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 300);
    throw new store.HttpError(res.status === 401 || res.status === 403 ? 400 : 502, `Gemini: ${msg}`);
  }
  return body;
}

const mask = (k: string) => (k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••');
const b64 = (s: string) => s.replace(/^data:[^,]+,/, '');

// ---------- move clips (uploaded or generated): kept so a move can be re-cut later ----------

const clipsDir = (p: string, c: string, m: string) => join(store.projectPath(p), 'characters', store.safeId(c), 'clips', store.safeId(m));
const CLIP = /^[0-9]+(-[a-z0-9.-]+)?\.(mp4|webm|mov)$/;

export interface Clip { file: string; source: string; createdAt: string; bytes: number }

function listClips(p: string, c: string, m: string): Clip[] {
  const dir = clipsDir(p, c, m);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => CLIP.test(f)).sort().reverse().map(f => {
    const stamp = Number(f.split(/[-.]/)[0]);
    const source = f.match(/^[0-9]+-([a-z0-9.-]+)\./)?.[1] ?? 'upload';
    return { file: f, source, createdAt: new Date(stamp).toISOString(), bytes: statSync(join(dir, f)).size };
  });
}

async function saveClip(p: string, c: string, m: string, bytes: Uint8Array, source: string, ext = 'mp4'): Promise<Clip> {
  const dir = clipsDir(p, c, m);
  await mkdir(dir, { recursive: true });
  const stamp = Date.now();
  const file = `${stamp}-${source.replace(/[^a-z0-9.-]/gi, '').toLowerCase() || 'upload'}.${ext}`;
  await writeFile(join(dir, file), bytes);
  return { file, source, createdAt: new Date(stamp).toISOString(), bytes: bytes.length };
}

// ---------- video jobs ----------

interface Job {
  id: string; operation: string; key: string; model: string;
  project: string; character: string; move: string;
  status: 'running' | 'done' | 'failed'; error?: string; clip?: Clip; startedAt: number;
}
const jobs = new Map<string, Job>();

async function pollJob(job: Job) {
  if (job.status !== 'running') return;
  const op = await google(job.operation, job.key) as {
    done?: boolean; error?: { message?: string };
    response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[]; raiMediaFilteredReasons?: string[] } };
  };
  if (!op.done) return;
  if (op.error) { job.status = 'failed'; job.error = op.error.message ?? 'generation failed'; return; }
  const r = op.response?.generateVideoResponse;
  const uri = r?.generatedSamples?.[0]?.video?.uri;
  if (!uri) { job.status = 'failed'; job.error = r?.raiMediaFilteredReasons?.join('; ') || 'Gemini returned no video (it may have been filtered)'; return; }
  const res = await fetch(uri, { headers: { 'x-goog-api-key': job.key }, redirect: 'follow' });
  if (!res.ok) { job.status = 'failed'; job.error = `download failed (${res.status})`; return; }
  job.clip = await saveClip(job.project, job.character, job.move, new Uint8Array(await res.arrayBuffer()), job.model.replace(/-generate-preview$/, ''));
  job.status = 'done';
}

// ---------- routes ----------

export const geminiApi = new Hono();

geminiApi.get('/settings/gemini', async c => {
  const cfg = await config();
  return c.json({
    configured: !!cfg.key, source: cfg.source, masked: cfg.key ? mask(cfg.key) : null,
    imageModel: cfg.imageModel, videoModel: cfg.videoModel, videoModels: VIDEO_MODELS, imageModels: IMAGE_MODELS,
  });
});

geminiApi.put('/settings/gemini', async c => {
  const body = await c.req.json<{ key?: string | null; imageModel?: string; videoModel?: string }>();
  const s = await readSecrets();
  if (body.key !== undefined) s.geminiKey = body.key?.trim() || undefined;
  if (body.imageModel) s.imageModel = body.imageModel;
  if (body.videoModel) s.videoModel = body.videoModel;
  await writeSecrets(s);
  const cfg = await config();
  return c.json({ configured: !!cfg.key, source: cfg.source, masked: cfg.key ? mask(cfg.key) : null, imageModel: cfg.imageModel, videoModel: cfg.videoModel, videoModels: VIDEO_MODELS, imageModels: IMAGE_MODELS });
});

/** Checks the key and reports which of our image and video models it can use. */
geminiApi.post('/settings/gemini/test', async c => {
  const { key } = await needKey();
  const names: string[] = [];
  let page = '';
  for (let i = 0; i < 5; i++) {
    const r = await google(`models?pageSize=200${page ? `&pageToken=${page}` : ''}`, key) as { models?: { name: string }[]; nextPageToken?: string };
    names.push(...(r.models ?? []).map(m => m.name.replace(/^models\//, '')));
    if (!r.nextPageToken) break;
    page = r.nextPageToken;
  }
  return c.json({
    ok: true,
    video: VIDEO_MODELS.filter(m => names.includes(m.id)).map(m => m.id),
    image: IMAGE_MODELS.filter(m => names.includes(m)),
  });
});

/** Image model: prompt + reference images (data URLs or base64 PNG) -> one PNG. */
geminiApi.post('/gemini/image', async c => {
  const cfg = await needKey();
  const { prompt, images = [], aspectRatio = '1:1' } = await c.req.json<{ prompt: string; images?: string[]; aspectRatio?: string }>();
  if (!prompt?.trim()) throw new store.HttpError(400, 'prompt required');
  const parts: unknown[] = [{ text: prompt }, ...images.map(d => ({ inlineData: { mimeType: 'image/png', data: b64(d) } }))];
  const r = await google(`models/${cfg.imageModel}:generateContent`, cfg.key, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } } }),
  }) as { candidates?: { content?: { parts?: { inlineData?: { data: string; mimeType: string }; inline_data?: { data: string; mime_type: string } }[] } }[] };
  const img = r.candidates?.[0]?.content?.parts?.map(p => p.inlineData ?? (p.inline_data && { data: p.inline_data.data, mimeType: p.inline_data.mime_type })).find(Boolean);
  if (!img) throw new store.HttpError(502, 'Gemini returned no image (it may have refused the request); try again or rephrase');
  return c.json({ mimeType: img.mimeType, data: img.data, model: cfg.imageModel });
});

/** Veo: start a clip for a move. The first frame comes from the client (built from the sprite). */
geminiApi.post('/projects/:p/characters/:c/moves/:m/clips/generate', async c => {
  const cfg = await needKey();
  const p = c.req.param('p'), ch = c.req.param('c'), mv = c.req.param('m');
  await store.getCharacter(p, ch); // 404 for an unknown character
  const body = await c.req.json<{ prompt: string; negative?: string; image: string; pinEnd?: boolean; seconds?: number; aspectRatio?: '16:9' | '9:16'; model?: string }>();
  const model = VIDEO_MODELS.some(m => m.id === body.model) ? body.model! : cfg.videoModel;
  const image = { inlineData: { mimeType: 'image/png', data: b64(body.image) } };
  // a pinned last frame (interpolation) only works on 8 s clips
  const seconds = body.pinEnd ? 8 : [4, 6, 8].includes(body.seconds ?? 0) ? body.seconds! : 8;
  const request = (withNegative: boolean) => ({
    instances: [{ prompt: body.prompt, image, ...(body.pinEnd ? { lastFrame: image } : {}) }],
    parameters: { aspectRatio: body.aspectRatio ?? '16:9', durationSeconds: String(seconds), numberOfVideos: 1, ...(withNegative && body.negative ? { negativePrompt: body.negative } : {}) },
  });
  let op: { name?: string };
  try {
    op = await google(`models/${model}:predictLongRunning`, cfg.key, { method: 'POST', body: JSON.stringify(request(true)) }) as { name?: string };
  } catch (e) {
    // older or newer Veo versions may not take a negative prompt: retry without it
    if (!(e instanceof store.HttpError) || !/negative/i.test(e.message)) throw e;
    op = await google(`models/${model}:predictLongRunning`, cfg.key, { method: 'POST', body: JSON.stringify(request(false)) }) as { name?: string };
  }
  if (!op.name) throw new store.HttpError(502, 'Gemini did not start the video');
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  jobs.set(id, { id, operation: op.name, key: cfg.key, model, project: p, character: ch, move: mv, status: 'running', startedAt: Date.now() });
  return c.json({ job: id, model, seconds }, 202);
});

geminiApi.get('/gemini/jobs/:id', async c => {
  const job = jobs.get(c.req.param('id'));
  if (!job) throw new store.HttpError(404, 'unknown job (the server restarted?)');
  try { await pollJob(job); } catch (e) { job.status = 'failed'; job.error = e instanceof Error ? e.message : String(e); }
  return c.json({ status: job.status, error: job.error ?? null, clip: job.clip ?? null, seconds: Math.round((Date.now() - job.startedAt) / 1000) });
});

geminiApi.get('/projects/:p/characters/:c/moves/:m/clips', async c => c.json(listClips(c.req.param('p'), c.req.param('c'), c.req.param('m'))));

geminiApi.post('/projects/:p/characters/:c/moves/:m/clips', async c => {
  const p = c.req.param('p'), ch = c.req.param('c'), mv = c.req.param('m');
  await store.getCharacter(p, ch);
  const file = (await c.req.formData()).get('video');
  if (!(file instanceof File)) throw new store.HttpError(400, 'missing video');
  if (file.size > 200 * 1024 * 1024) throw new store.HttpError(400, 'video too large (max 200 MB)');
  const ext = /\.(mp4|webm|mov)$/i.exec(file.name)?.[1]?.toLowerCase() ?? 'mp4';
  return c.json(await saveClip(p, ch, mv, new Uint8Array(await file.arrayBuffer()), 'upload', ext), 201);
});

geminiApi.get('/projects/:p/characters/:c/moves/:m/clips/:f', async c => {
  const f = c.req.param('f');
  if (!CLIP.test(f)) throw new store.HttpError(400, 'bad file');
  const buf = await readFile(join(clipsDir(c.req.param('p'), c.req.param('c'), c.req.param('m')), f)).catch(() => null);
  if (!buf) throw new store.HttpError(404, 'not found');
  const type = f.endsWith('.webm') ? 'video/webm' : f.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
  return c.body(buf, 200, { 'content-type': type, 'cache-control': 'max-age=31536000, immutable' });
});

geminiApi.delete('/projects/:p/characters/:c/moves/:m/clips/:f', async c => {
  const f = c.req.param('f');
  if (!CLIP.test(f)) throw new store.HttpError(400, 'bad file');
  await rm(join(clipsDir(c.req.param('p'), c.req.param('c'), c.req.param('m')), f), { force: true });
  return c.body(null, 204);
});
