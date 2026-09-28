import { useSyncExternalStore } from 'react';
import { setExternal } from './claudeActivity.ts';

/**
 * The background moveset queue (server side): jobs keep running while you work anywhere
 * else in the studio. This store polls while something is queued or running, mirrors it
 * into the Claude pill, and announces each finished move.
 */
export interface Job { id: string; character: string; move: string; status: 'queued' | 'running' | 'done' | 'failed'; error?: string; usage?: { output: number } }

let jobs: Job[] = [];
let project: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());
let onFinished: ((j: Job) => void) | null = null;

async function poll() {
  timer = null;
  if (!project) return;
  try {
    const next: Job[] = await fetch(`/api/projects/${project}/queue`).then(r => r.json());
    for (const j of next) {
      const before = jobs.find(x => x.id === j.id);
      if (before && before.status !== j.status && (j.status === 'done' || j.status === 'failed')) onFinished?.(j);
    }
    jobs = next;
    emit();
    const active = jobs.filter(j => j.status === 'running' || j.status === 'queued');
    const run = active.find(j => j.status === 'running');
    setExternal('queue', run ? { state: 'weaving', label: `Animating ${run.move}${active.length > 1 ? ` (+${active.length - 1} queued)` : ''}` } : null);
    if (active.length) timer = setTimeout(poll, 4000);
  } catch { timer = setTimeout(poll, 8000); }
}

export function watchQueue(projectId: string | null, finished: (j: Job) => void) {
  onFinished = finished;
  if (project !== projectId) { project = projectId; jobs = []; emit(); }
  if (!timer) void poll();
}
/** Call after enqueueing so polling starts right away. */
export function kickQueue() { if (timer) clearTimeout(timer); timer = null; void poll(); }
export function useQueue(): Job[] { return useSyncExternalStore(cb => { subs.add(cb); return () => subs.delete(cb); }, () => jobs); }
