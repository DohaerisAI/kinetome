import { useEffect, useState } from 'react';
import { api, type GeminiSettings } from './api.ts';

/** Whether a Gemini key is connected, shared by every screen (the dialog updates it). */
let current: GeminiSettings | null = null;
const subs = new Set<(s: GeminiSettings | null) => void>();
let loading: Promise<void> | null = null;

export function setGemini(s: GeminiSettings) { current = s; subs.forEach(f => f(s)); }
export function openConnections() { window.dispatchEvent(new CustomEvent('kinetome:connections')); }

export function useGemini(): GeminiSettings | null {
  const [s, setS] = useState(current);
  useEffect(() => {
    subs.add(setS);
    if (!current && !loading) loading = api.geminiSettings().then(setGemini, () => {}).finally(() => { loading = null; });
    return () => { subs.delete(setS); };
  }, []);
  return s;
}
