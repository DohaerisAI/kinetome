import { useSyncExternalStore } from 'react';
import type { OrbState } from 'thinking-orbs';

/**
 * What Claude is doing right now, app-wide: every Claude call registers here so the top
 * bar can show a thinking orb (and what it's thinking about) wherever you are.
 */
export interface Activity { id: number; state: OrbState; label: string }

let items: Activity[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());

export function track<T>(state: OrbState, label: string, work: () => Promise<T>): Promise<T> {
  const a: Activity = { id: ++seq, state, label };
  items = [...items, a];
  emit();
  return work().finally(() => { items = items.filter(x => x.id !== a.id); emit(); });
}

/** Long-running work tracked elsewhere (the server queue) shows up here too, by key. */
const external = new Map<string, Activity>();
export function setExternal(key: string, a: Omit<Activity, 'id'> | null) {
  const cur = external.get(key);
  if (!a) { if (!cur) return; external.delete(key); items = items.filter(x => x.id !== cur.id); emit(); return; }
  if (cur && cur.label === a.label && cur.state === a.state) return;
  const next: Activity = { id: cur?.id ?? ++seq, ...a };
  external.set(key, next);
  items = [...items.filter(x => x.id !== next.id), next];
  emit();
}

export function useClaudeActivity(): Activity[] {
  return useSyncExternalStore(cb => { subs.add(cb); return () => subs.delete(cb); }, () => items);
}
