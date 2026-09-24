import { spawn, execFile } from 'node:child_process';
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs Claude through the Claude Code CLI in headless mode, so it uses the user's Claude
 * subscription login (the Agent SDK only supports API keys). Every call is locked down:
 * replaced system prompt, no tools unless asked, no MCP servers, no settings, no session
 * files, structured JSON output.
 */

export type Model = 'sonnet' | 'opus' | 'haiku';

export interface ClaudeUsage { input: number; cacheRead: number; cacheWrite: number; output: number; costUsd: number; ms: number }
export interface ClaudeResult<T> { data: T; usage: ClaudeUsage; model: Model }

export interface ClaudeCall {
  task: string;
  system: string;
  prompt: string;
  schema: object;
  model: Model;
  /** Built-in tools to allow, e.g. ['Read'] to let Claude look at a rendered PNG. */
  tools?: string[];
  /** Directories Claude may read (with tools: ['Read']). */
  dirs?: string[];
  timeoutMs?: number;
  /** Cap on Claude's hidden reasoning tokens (MAX_THINKING_TOKENS); lower = faster and cheaper. */
  thinking?: number;
}

const WORKDIR = join(tmpdir(), 'sprite-studio-claude');

export class ClaudeError extends Error {}

let queue: Promise<unknown> = Promise.resolve();

/** Serialised: one Claude call at a time keeps usage predictable and the machine responsive. */
export function runClaude<T>(call: ClaudeCall): Promise<ClaudeResult<T>> {
  const job = queue.then(() => exec<T>(call), () => exec<T>(call));
  queue = job.catch(() => undefined);
  return job;
}

async function exec<T>(c: ClaudeCall): Promise<ClaudeResult<T>> {
  await mkdir(WORKDIR, { recursive: true });
  const tools = c.tools ?? [];
  const args = [
    '-p', '--model', c.model, '--output-format', 'json',
    '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '',
    '--system-prompt', c.system,
    '--json-schema', JSON.stringify(c.schema),
    '--tools', tools.join(','),
  ];
  if (tools.length) args.push('--allowedTools', tools.join(','));
  for (const d of c.dirs ?? []) args.push('--add-dir', d);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // would silently override the subscription login
  if (c.thinking !== undefined) env.MAX_THINKING_TOKENS = String(c.thinking);

  const started = Date.now();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, { cwd: WORKDIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ClaudeError(`Claude timed out after ${Math.round((c.timeoutMs ?? 120_000) / 1000)}s`)); }, c.timeoutMs ?? 120_000);
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { err += b; });
    child.on('error', e => { clearTimeout(timer); reject(new ClaudeError(`Could not start Claude Code (${e.message}). Is it installed and logged in?`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) reject(new ClaudeError(err.trim().slice(0, 400) || `Claude exited with code ${code}`));
      else resolve(out);
    });
    child.stdin.end(c.prompt);
  });

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(stdout); } catch { throw new ClaudeError(`Unexpected Claude output: ${stdout.slice(0, 200)}`); }
  if (parsed.is_error) throw new ClaudeError(String(parsed.result ?? 'Claude reported an error'));
  let data = parsed.structured_output as T | undefined;
  if (data === undefined && typeof parsed.result === 'string') {
    try { data = JSON.parse(parsed.result) as T; } catch { /* fall through */ }
  }
  if (data === undefined) throw new ClaudeError('Claude returned no structured result');
  const u = (parsed.usage ?? {}) as Record<string, number>;
  return {
    data,
    model: c.model,
    usage: {
      input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0, costUsd: Number(parsed.total_cost_usd ?? 0), ms: Date.now() - started,
    },
  };
}

let status: Promise<{ available: boolean; version: string | null; error?: string }> | null = null;

/** Whether the `claude` CLI is installed (checked once per server start). */
export function claudeStatus() {
  status ??= new Promise(resolve => {
    execFile('claude', ['--version'], { timeout: 10_000 }, (err, out) => {
      if (err) resolve({ available: false, version: null, error: 'Claude Code CLI not found. Install it and run `claude` once to log in.' });
      else resolve({ available: true, version: out.trim() });
    });
  });
  return status;
}

// ---------- usage log (per project) ----------

export interface UsageEntry extends ClaudeUsage { at: string; task: string; model: Model }

export async function logUsage(projectDir: string, task: string, r: ClaudeResult<unknown>) {
  const entry: UsageEntry = { at: new Date().toISOString(), task, model: r.model, ...r.usage };
  await appendFile(join(projectDir, 'claude-usage.jsonl'), JSON.stringify(entry) + '\n');
}

export async function readUsage(projectDir: string): Promise<{ total: ClaudeUsage & { calls: number }; recent: UsageEntry[] }> {
  let lines: string[] = [];
  try { lines = (await readFile(join(projectDir, 'claude-usage.jsonl'), 'utf8')).trim().split('\n').filter(Boolean); } catch { /* none yet */ }
  const entries = lines.map(l => JSON.parse(l) as UsageEntry);
  const total = entries.reduce((t, e) => ({
    calls: t.calls + 1, input: t.input + e.input, cacheRead: t.cacheRead + e.cacheRead, cacheWrite: t.cacheWrite + e.cacheWrite,
    output: t.output + e.output, costUsd: t.costUsd + e.costUsd, ms: t.ms + e.ms,
  }), { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, ms: 0 });
  return { total, recent: entries.slice(-20).reverse() };
}
