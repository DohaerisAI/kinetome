import { useEffect, useMemo, useRef, useState } from 'react';
import { animate } from 'animejs';
import { Icon, type IconName } from '../icons.tsx';
import { reducedMotion } from '../motion.ts';

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: IconName;
  hint?: string;
  keywords?: string;
  run: () => void;
}

/** Subsequence match with a score: consecutive and word-start hits rank higher. */
function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 100 - direct + (direct === 0 || t[direct - 1] === ' ' ? 50 : 0);
  let ti = 0, s = 0, run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return 0;
    run = i === ti ? run + 1 : 0;
    s += 1 + run * 2 + (i === 0 || t[i - 1] === ' ' ? 3 : 0);
    ti = i + 1;
  }
  return s;
}

/**
 * Ctrl+K: go anywhere, open any sprite, run any action by typing a few letters. The
 * fastest path through the studio once you know what you want.
 */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (box.current && !reducedMotion()) animate(box.current, { opacity: [0, 1], translateY: [-8, 0], scale: [0.98, 1], duration: 320, ease: 'outExpo' });
  }, []);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return commands
      .map(c => ({ c, s: Math.max(score(needle, c.label), score(needle, `${c.group} ${c.keywords ?? ''}`) * 0.6) }))
      .filter(r => r.s > 0)
      .sort((a, b) => (needle ? b.s - a.s : 0))
      .slice(0, 40)
      .map(r => r.c);
  }, [q, commands]);

  useEffect(() => { setI(0); }, [q]);
  useEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }); }, [i]);

  const run = (c: Command | undefined) => { if (!c) return; onClose(); c.run(); };

  let lastGroup = '';
  return (
    <div className="cmdk-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" ref={box} role="dialog" aria-label="Command palette">
        <div className="cmdk-input">
          <Icon name="search" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Jump to a tab, open a sprite, run an action…" aria-label="Search commands"
            role="combobox" aria-expanded aria-controls="cmdk-list" aria-activedescendant={results[i] ? `cmd-${results[i].id}` : undefined}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(results.length - 1, x + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(0, x - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(results[i]); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={list}>
          {results.map((c, k) => {
            const head = !q && c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head && <div className="cmdk-group">{head}</div>}
                <button id={`cmd-${c.id}`} role="option" aria-selected={k === i} className={k === i ? 'cmdk-item on' : 'cmdk-item'}
                  onMouseMove={() => setI(k)} onClick={() => run(c)}>
                  <Icon name={c.icon} size={15} />
                  <span className="cmdk-label">{c.label}</span>
                  {q && <span className="cmdk-grp">{c.group}</span>}
                  {c.hint && <kbd>{c.hint}</kbd>}
                </button>
              </div>
            );
          })}
          {!results.length && <div className="cmdk-empty">Nothing matches “{q}”.</div>}
        </div>
        <div className="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span className="spacer" /><span className="dim">Kinetome</span></div>
      </div>
    </div>
  );
}
