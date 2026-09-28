/** Re-exports of the editor engine plus a few UI-side helpers. */
export * from '@kinetome/editor';
import { editableCel, stampFloating, withCel, type EditorDoc, type Floating } from '@kinetome/editor';

export function commitFloatingInto(doc: EditorDoc, layerId: string, frameId: string, f: Floating): EditorDoc {
  return withCel(doc, layerId, frameId, stampFloating(editableCel(doc, layerId, frameId), f));
}

/** Frame index -> which tag (animation) it belongs to. */
export function tagOf(doc: EditorDoc, frame: number) {
  return doc.tags.find(t => frame >= t.from && frame <= t.to) ?? null;
}
