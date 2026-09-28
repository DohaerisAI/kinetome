import { useCallback, useMemo, useRef, useState } from 'react';
import {
  commitFloatingInto, createDoc, emptyHistory, record, redo as redoH, undo as undoH,
  type EditorDoc, type Floating, type History, type Selection,
} from './model.ts';

export type Tool = 'pencil' | 'eraser' | 'bucket' | 'picker' | 'line' | 'rect' | 'ellipse' | 'select' | 'lasso' | 'wand' | 'move' | 'hand';

export interface ToolOptions {
  brush: number;
  pixelPerfect: boolean;
  mirrorX: boolean;
  mirrorY: boolean;
  fillShapes: boolean;
  contiguous: boolean;
  tolerance: number;
  /** Magic wand / bucket read the flattened frame instead of the current layer. */
  sampleAll: boolean;
}

export interface Onion { on: boolean; prev: number; next: number; tint: boolean; opacity: number }

export interface View { zoom: number; panX: number; panY: number; grid: boolean; showPivot: boolean; bg: 'checker' | 'dark' | 'light' }

export interface EditorSource { assetId: string | null; updatedAt?: string }

export interface EditorState {
  doc: EditorDoc;
  history: History;
  dirty: boolean;
  frame: number;
  layerId: string;
  /** Frames picked in the timeline (for batch operations and tags). Always includes `frame`. */
  picked: number[];
  tool: Tool;
  opts: ToolOptions;
  primary: string;
  secondary: string;
  selection: Selection | null;
  floating: Floating | null;
  view: View;
  onion: Onion;
  paletteLock: boolean;
  playing: boolean;
  source: EditorSource;
  /** Last committed pixel edit (for "apply this fix to other frames"). */
  lastEdit: { layerId: string; frame: number; before: EditorDoc['cels'][string]; after: EditorDoc['cels'][string]; label: string } | null;
}

const DEFAULT_OPTS: ToolOptions = { brush: 1, pixelPerfect: true, mirrorX: false, mirrorY: false, fillShapes: false, contiguous: true, tolerance: 0, sampleAll: false };

export function initialState(doc?: EditorDoc): EditorState {
  const d = doc ?? createDoc(48, 48, 1, 'Untitled');
  return {
    doc: d, history: emptyHistory(), dirty: false, frame: 0, layerId: d.layers[d.layers.length - 1].id, picked: [0],
    tool: 'pencil', opts: DEFAULT_OPTS, primary: '#1a1420', secondary: '#ffffff',
    selection: null, floating: null,
    view: { zoom: 0, panX: 0, panY: 0, grid: false, showPivot: true, bg: 'checker' },
    onion: { on: false, prev: 1, next: 1, tint: true, opacity: 0.35 },
    paletteLock: false, playing: false, source: { assetId: null }, lastEdit: null,
  };
}

/**
 * Editor state + the operations the UI calls. Every document change goes through
 * `commit`, which records undo history; transient UI state (tool, view…) doesn't.
 * A ref mirrors the latest state for pointer handlers that outlive a render.
 */
export function useEditor() {
  const [state, setState] = useState<EditorState>(() => initialState());
  const ref = useRef(state);
  ref.current = state;

  const set = useCallback((patch: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)) => {
    setState(s => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
  }, []);

  /** Replaces the document, recording the previous one for undo. */
  const commit = useCallback((label: string, doc: EditorDoc, extra: Partial<EditorState> = {}) => {
    setState(s => {
      const frame = Math.min(extra.frame ?? s.frame, doc.frames.length - 1);
      const layerId = doc.layers.some(l => l.id === (extra.layerId ?? s.layerId)) ? (extra.layerId ?? s.layerId) : doc.layers[doc.layers.length - 1].id;
      const picked = (extra.picked ?? s.picked).filter(i => i < doc.frames.length);
      return { ...s, ...extra, doc, history: record(s.history, s.doc, label), dirty: true, frame, layerId, picked: picked.length ? picked : [frame] };
    });
  }, []);

  /** Stamps floating content back into its cel (called before most other actions). */
  const settle = useCallback(() => {
    const s = ref.current;
    if (!s.floating) return;
    const doc = commitFloatingInto(s.doc, s.layerId, s.doc.frames[s.frame].id, s.floating);
    setState(x => ({ ...x, doc, history: record(x.history, x.doc, 'Move pixels'), floating: null, dirty: true }));
  }, []);

  const undo = useCallback(() => {
    setState(s => {
      const r = undoH(s.history, s.doc);
      if (!r) return s;
      return { ...s, doc: r.doc, history: r.history, floating: null, frame: Math.min(s.frame, r.doc.frames.length - 1), layerId: r.doc.layers.some(l => l.id === s.layerId) ? s.layerId : r.doc.layers[0].id, dirty: true };
    });
  }, []);
  const redo = useCallback(() => {
    setState(s => {
      const r = redoH(s.history, s.doc);
      if (!r) return s;
      return { ...s, doc: r.doc, history: r.history, floating: null, frame: Math.min(s.frame, r.doc.frames.length - 1), layerId: r.doc.layers.some(l => l.id === s.layerId) ? s.layerId : r.doc.layers[0].id, dirty: true };
    });
  }, []);

  /** Opens a new document (resets history). */
  const open = useCallback((doc: EditorDoc, source: EditorSource = { assetId: null }) => {
    setState(s => ({
      ...initialState(doc), tool: s.tool, opts: s.opts, primary: s.primary, secondary: s.secondary, view: { ...s.view, zoom: 0, panX: 0, panY: 0 }, onion: s.onion,
      paletteLock: doc.palette.length >= 2 && s.paletteLock, source,
    }));
  }, []);

  const goto = useCallback((frame: number, opts: { extend?: boolean; toggle?: boolean } = {}) => {
    setState(s => {
      const f = Math.max(0, Math.min(s.doc.frames.length - 1, frame));
      let picked: number[];
      if (opts.extend) { const a = Math.min(s.frame, f), b = Math.max(s.frame, f); picked = Array.from({ length: b - a + 1 }, (_, i) => a + i); }
      else if (opts.toggle) picked = s.picked.includes(f) ? s.picked.filter(x => x !== f) : [...s.picked, f].sort((a, b) => a - b);
      else picked = [f];
      return { ...s, frame: opts.extend ? s.frame : f, picked: picked.length ? picked : [f], floating: null };
    });
  }, []);

  const api = useMemo(() => ({ set, commit, settle, undo, redo, open, goto }), [set, commit, settle, undo, redo, open, goto]);
  return { state, ref, ...api };
}

export type EditorApi = ReturnType<typeof useEditor>;
