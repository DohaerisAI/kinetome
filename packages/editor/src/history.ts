import type { EditorDoc } from './doc.ts';

/**
 * Undo/redo over immutable document snapshots. Each entry shares every untouched cel with
 * its neighbours, so a stroke costs one cel copy, not the whole document.
 */
export interface History { past: { doc: EditorDoc; label: string }[]; future: { doc: EditorDoc; label: string }[] }

export const LIMIT = 200;
export const emptyHistory = (): History => ({ past: [], future: [] });

/** Records `prev` as undoable before replacing it with a new document. */
export function record(h: History, prev: EditorDoc, label: string): History {
  const past = [...h.past, { doc: prev, label }];
  return { past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past, future: [] };
}

export function undo(h: History, current: EditorDoc): { history: History; doc: EditorDoc; label: string } | null {
  const last = h.past[h.past.length - 1];
  if (!last) return null;
  return { history: { past: h.past.slice(0, -1), future: [{ doc: current, label: last.label }, ...h.future] }, doc: last.doc, label: last.label };
}

export function redo(h: History, current: EditorDoc): { history: History; doc: EditorDoc; label: string } | null {
  const next = h.future[0];
  if (!next) return null;
  return { history: { past: [...h.past, { doc: current, label: next.label }], future: h.future.slice(1) }, doc: next.doc, label: next.label };
}
