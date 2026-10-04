import { useEffect, useState } from 'react';
import { api, type GeminiSettings } from '../api.ts';
import { Icon } from '../icons.tsx';

/**
 * Optional Gemini API key. Without it everything still works by copy-paste into the Gemini app;
 * with it Kinetome makes the side-view still and move clips itself. The key is stored by the
 * local server (never in the browser, never in the repo).
 */
export function ConnectionsDialog({ onClose, onChange, fail }: { onClose: () => void; onChange: (s: GeminiSettings) => void; fail: (e: unknown) => void }) {
  const [s, setS] = useState<GeminiSettings | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<{ video: string[]; image: string[] } | null>(null);
  useEffect(() => { api.geminiSettings().then(setS, fail); }, [fail]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const save = async (body: Parameters<typeof api.saveGeminiSettings>[0]) => {
    setBusy('save');
    try { const n = await api.saveGeminiSettings(body); setS(n); onChange(n); if (body.key !== undefined) { setKey(''); setTest(null); } }
    catch (e) { fail(e); } finally { setBusy(null); }
  };
  const runTest = async () => {
    setBusy('test');
    try {
      const t = await api.testGemini();
      setTest(t);
      // pick models the key can actually use
      if (s && t.video.length && !t.video.includes(s.videoModel)) await save({ videoModel: t.video[0] });
      if (s && t.image.length && !t.image.includes(s.imageModel)) await save({ imageModel: t.image[0] });
    } catch (e) { setTest(null); fail(e); } finally { setBusy(null); }
  };
  const perClip = (id: string) => { const m = s?.videoModels.find(v => v.id === id); return m ? `~$${(m.usdPerSecond * 8).toFixed(2)} per 8 s clip` : ''; };

  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal conn-modal" role="dialog" aria-label="Connections">
        <div className="modal-head">
          <span className="ph-icon small"><Icon name="gemini" /></span>
          <div><strong>Gemini API</strong><div className="dim small">Optional. Lets Kinetome draw side views and make move videos for you.</div></div>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="conn-body">
          <div className={s?.configured ? 'conn-status ok' : 'conn-status'}>
            <span className="dot" aria-hidden />
            {!s ? 'Checking…' : s.configured
              ? <>Connected with key <code>{s.masked}</code>{s.source === 'env' ? ' (from the GEMINI_API_KEY environment variable)' : ''}</>
              : 'Not connected: Kinetome gives you prompts and files to use in the free Gemini app instead.'}
          </div>

          <label className="field"><span>{s?.configured ? 'Replace the key' : 'API key'}</span>
            <div className="row-input">
              <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="AIza…" autoComplete="off" spellCheck={false} />
              <button className="primary" disabled={!key.trim() || busy !== null} onClick={() => void save({ key })}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            </div>
          </label>
          <p className="dim small">
            Get one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>. Video (Veo) needs billing turned on for the key's
            Google Cloud project; Google charges per generated second. The key is stored by Kinetome's local server in the workspace folder (git-ignored), never in the browser.
          </p>

          {s?.configured && (
            <>
              <div className="btnrow">
                <button onClick={() => void runTest()} disabled={busy !== null}><Icon name="refresh" /> {busy === 'test' ? 'Testing…' : 'Test the key'}</button>
                {s.source === 'settings' && <button className="ghost danger" onClick={() => { if (confirm('Remove the saved Gemini key?')) void save({ key: null }); }} disabled={busy !== null}><Icon name="trash" /> Remove key</button>}
              </div>
              {test && (
                <div className="issue ok small">
                  Key works. Video models available: {test.video.length ? test.video.join(', ') : 'none (enable billing for Veo)'} · Image models: {test.image.length ? test.image.join(', ') : 'none found'}
                </div>
              )}
              <div className="row2">
                <label className="field"><span>Video model</span>
                  <select value={s.videoModel} onChange={e => void save({ videoModel: e.target.value })}>
                    {s.videoModels.map(m => <option key={m.id} value={m.id} disabled={!!test && !test.video.includes(m.id)}>{m.label} · {perClip(m.id)}</option>)}
                  </select>
                </label>
                <label className="field"><span>Image model (side views)</span>
                  <select value={s.imageModel} onChange={e => void save({ imageModel: e.target.value })}>
                    {s.imageModels.map(m => <option key={m} value={m} disabled={!!test && !test.image.includes(m)}>{m}</option>)}
                  </select>
                </label>
              </div>
              <p className="dim small">Prices are Google's list prices when this was written; check Google's pricing page for current numbers. Lite is cheapest; Fast is a good default for game sprites.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
