import { useState } from 'react';
import type { CharacterDesign, SpriteAsset, StyleBible } from '@kinetome/core';
import type { Model, Usage } from '../../api.ts';
import { Orb } from '../Orb.tsx';
import { Icon, type IconName } from '../../icons.tsx';

export interface ImportRequest {
  assetId: string | null;
  anim: string | null;
  design: CharacterDesign;
  onDone: (asset: SpriteAsset) => void;
}

export interface TabProps {
  projectId: string;
  style: StyleBible;
  design: CharacterDesign;
  assets: SpriteAsset[];
  model: Model;
  update: (d: CharacterDesign) => void;
  /** Flush pending edits, then run a server action that returns the saved design. */
  runClaude: <T extends { design?: CharacterDesign; usage: Usage }>(label: string, fn: () => Promise<T>) => Promise<T | null>;
  busy: string | null;
  importFor: (req: Omit<ImportRequest, 'design' | 'onDone'>) => void;
  onAssetsChanged: () => void;
  notify: (msg: string) => void;
  fail: (e: unknown) => void;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); return ok;
  }
}

export function CopyButton({ text, label = 'Copy prompt', primary = true }: { text: string; label?: string; primary?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button className={done ? 'btn-ok' : primary ? 'primary' : ''} onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1600); } }}>
      <Icon name={done ? 'check' : 'copy'} /> {done ? 'Copied' : label}
    </button>
  );
}

export function ClaudeButton({ label, busyLabel, busy, onClick, disabled, icon = 'sparkle', title }: { label: string; busyLabel: string; busy: boolean; onClick: () => void; disabled?: boolean; icon?: IconName; title?: string }) {
  return (
    <button className="claude-btn" onClick={onClick} disabled={disabled || busy} title={title} aria-busy={busy}>
      {busy ? <Orb size={20} state="composing" /> : <Icon name={icon} />} {busy ? busyLabel : label}
    </button>
  );
}

export const fmtTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const usageText = (u: Usage) => `${fmtTokens(u.input + u.cacheRead + u.cacheWrite)} in · ${fmtTokens(u.output)} out · ${(u.ms / 1000).toFixed(1)}s`;

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}{hint && <em className="dim"> · {hint}</em>}</span>
      {children}
    </label>
  );
}

export function PromptBox({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="prompt-box">
      <button className="ghost small" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} /> {open ? 'Hide' : 'Preview'} the full prompt <span className="dim">({text.split(/\s+/).length} words)</span>
      </button>
      {open && <pre className="pk-prompt">{text}</pre>}
    </div>
  );
}

export function GeminiSteps({ withReference }: { withReference: boolean }) {
  return (
    <ol className="gem-steps">
      <li>Copy the prompt</li>
      <li>Open <a href="https://gemini.google.com/app" target="_blank" rel="noreferrer">Gemini <Icon name="external" size={12} /></a> and paste it{withReference ? ', attaching your reference sprite' : ''}</li>
      <li>Download the image, then click <strong>Import result</strong></li>
    </ol>
  );
}
