import { useEffect, useMemo, useRef, useState } from 'react';
import { designPalette, designProfilePrompt, hexToRgb, slugify, usesProfile, videoKeyFor, videoMovePrompt, type MoveDraft, type PixelImage, type SpriteAsset } from '@kinetome/core';
import { contentBounds, estimateBackground, keepMainFigure, removeBackground, videoFirstFrame } from '@kinetome/pixel';
import { api, type Clip } from '../../api.ts';
import { Icon } from '../../icons.tsx';
import { openConnections, useGemini } from '../../gemini.ts';
import { canvasToPng, download, loadImage, pixelsToCanvas, toPixels, unpackFrames } from '../../pixels.ts';
import { ago } from '../../time.ts';
import { CopyButton, PromptBox, type TabProps } from './shared.tsx';

type Provider = 'app' | 'api' | 'other';
const PROVIDER_KEY = 'kinetome.videoProvider';
const readProvider = (): Provider => { try { const v = localStorage.getItem(PROVIDER_KEY); return v === 'api' || v === 'other' ? v : 'app'; } catch { return 'app'; } };

/** First idle frame of an asset (the character as it stands). */
async function idleFrame(projectId: string, a: SpriteAsset): Promise<PixelImage | null> {
  const idle = a.animations.find(x => x.name === 'idle') ?? a.animations[0];
  const rect = a.frames[idle?.frames[0] ?? 0];
  return rect ? (await unpackFrames(api.sheetUrl(projectId, a), [rect]))[0] : null;
}

const toDataUrl = async (img: PixelImage) => {
  const blob = await canvasToPng(pixelsToCanvas(img));
  return new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });
};
/** Pixel art scaled up by a whole number to about `h` px: image models read tiny sprites badly. */
function upscale(img: PixelImage, h = 512): PixelImage {
  const b = contentBounds(img, 128) ?? { x: 0, y: 0, w: img.width, h: img.height };
  const k = Math.max(1, Math.floor(h / b.h)), pad = 8;
  const W = b.w * k + pad * 2, H = b.h * k + pad * 2, out = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let i = 0; i < out.data.length; i += 4) out.data.set([0, 255, 0, 255], i);
  for (let y = 0; y < b.h * k; y++) for (let x = 0; x < b.w * k; x++) {
    const i = ((b.y + Math.floor(y / k)) * img.width + b.x + Math.floor(x / k)) * 4;
    if (img.data[i + 3] > 127) out.data.set(img.data.subarray(i, i + 4), ((pad + y) * W + pad + x) * 4);
  }
  return out;
}

/**
 * The standard way to animate a move: a still the clip starts from, one video (Gemini app,
 * Gemini API or any image-to-video model), then Import, which keys, loops and pixelates it.
 * Every clip is kept, so the move can be re-cut later without a new video.
 */
export function VideoStudio(props: TabProps & { move: MoveDraft }) {
  const { projectId, style, design: d, assets, importFor, update, fail, notify, move: m } = props;
  const gemini = useGemini();
  const [open, setOpen] = useState(true);
  const [provider, setProviderState] = useState<Provider>(readProvider);
  const setProvider = (p: Provider) => { setProviderState(p); try { localStorage.setItem(PROVIDER_KEY, p); } catch { /* storage off */ } };
  const [idle, setIdle] = useState<PixelImage | null>(null);
  const [profile, setProfile] = useState<PixelImage | null>(null);
  const [useIdle, setUseIdle] = useState(false);
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [job, setJob] = useState<{ id: string; seconds: number; model: string } | null>(null);
  const profileInput = useRef<HTMLInputElement>(null);
  const clipInput = useRef<HTMLInputElement>(null);

  const linked = d.assetId ? assets.find(a => a.id === d.assetId) : undefined;
  const characters = assets.filter(a => a.kind === 'character');
  const sideView = usesProfile(m);

  useEffect(() => {
    let live = true;
    setIdle(null);
    if (open && linked) idleFrame(projectId, linked).then(f => live && setIdle(f), () => {});
    return () => { live = false; };
  }, [open, projectId, linked]);
  useEffect(() => {
    let live = true;
    setProfile(null);
    if (!open || !d.profile) return;
    loadImage(api.profileUrl(projectId, d.id, d.profile)).then(img => {
      if (!live) return;
      const px = toPixels(img);
      let f: PixelImage = { width: px.width, height: px.height, data: px.data };
      const bg = estimateBackground(f);
      if (bg) f = removeBackground(f, bg, 0.09, true);
      setProfile(keepMainFigure(f));
    }, () => {});
    return () => { live = false; };
  }, [open, projectId, d.id, d.profile]);
  const loadClips = () => api.listClips(projectId, d.id, m.id).then(setClips, () => setClips([]));
  useEffect(() => { if (open) void loadClips(); }, [open, projectId, d.id, m.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const sprite = sideView && profile && !useIdle ? profile : idle;
  const fromProfile = !!profile && sprite === profile;
  const key = useMemo(() => {
    const colors = new Set<string>(designPalette(d));
    if (sprite) for (let i = 0; i < sprite.data.length; i += 16) if (sprite.data[i + 3] > 127) colors.add('#' + ((1 << 24) | (sprite.data[i] << 16) | (sprite.data[i + 1] << 8) | sprite.data[i + 2]).toString(16).slice(1));
    return videoKeyFor([...colors]);
  }, [d, sprite]);
  const plan = useMemo(() => videoMovePrompt(d, m, key), [d, m, key]);
  const wide = provider !== 'other'; // Veo makes 16:9 (or 9:16) only
  const frame = useMemo(() => (sprite ? videoFirstFrame(sprite, hexToRgb(key.hex), wide ? 720 : 960, wide ? 1280 : 960) : null), [sprite, key, wide]);
  const appPrompt = `${plan.prompt} Avoid: ${plan.negative}.`;
  const preview = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = preview.current;
    if (!c || !frame) return;
    c.width = wide ? 256 : 180; c.height = wide ? 144 : 180;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pixelsToCanvas(frame), 0, 0, c.width, c.height);
  }, [frame, wide]);

  // ---------- actions ----------
  const relink = async (assetId: string) => {
    const a = assets.find(x => x.id === assetId);
    if (!a) return;
    let pixelHeight = d.pixelHeight;
    try { const f = await idleFrame(projectId, a); const b = f && contentBounds(f, 128); if (b && b.h >= 12 && b.h <= 256) pixelHeight = b.h; } catch { /* keep */ }
    update({ ...d, assetId, pixelHeight });
  };
  const saveFrame = async () => { if (frame) download(`${slugify(d.name)}-${m.id}-first-frame-${wide ? '16x9' : '1x1'}.png`, await canvasToPng(pixelsToCanvas(frame))); };
  const uploadProfile = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    try { update(await api.uploadProfile(projectId, d.id, f)); setUseIdle(false); } catch (e) { fail(e); }
  };
  const drawProfile = async () => {
    if (!idle) return;
    setDrawing(true);
    try {
      const r = await api.geminiImage(designProfilePrompt(style, d), [await toDataUrl(upscale(idle))]);
      const bytes = Uint8Array.from(atob(r.data), c => c.charCodeAt(0));
      update(await api.uploadProfile(projectId, d.id, new File([bytes], `side.${r.mimeType.includes('jpeg') ? 'jpg' : 'png'}`, { type: r.mimeType })));
      setUseIdle(false);
      notify(`Gemini drew ${d.name} in side view. Check it; redraw if the angle or design is off.`);
    } catch (e) { fail(e); } finally { setDrawing(false); }
  };
  const openClip = async (c: Clip) => {
    try {
      const blob = await (await fetch(api.clipUrl(projectId, d.id, m.id, c.file))).blob();
      importFor({ assetId: d.assetId, anim: m.id, files: [new File([blob], `${m.id}-${c.file}`, { type: blob.type || 'video/mp4' })] });
    } catch (e) { fail(e); }
  };
  const importFile = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    try { const c = await api.uploadClip(projectId, d.id, m.id, f); void loadClips(); importFor({ assetId: d.assetId, anim: m.id, files: [new File([f], `${m.id}-${c.file}`, { type: f.type })] }); }
    catch (e) { fail(e); }
  };
  const removeClip = async (c: Clip) => {
    if (!confirm('Delete this clip? Animations already made from it stay.')) return;
    try { await api.deleteClip(projectId, d.id, m.id, c.file); void loadClips(); } catch (e) { fail(e); }
  };
  const generate = async () => {
    if (!frame) return;
    try {
      const r = await api.generateClip(projectId, d.id, m.id, { prompt: plan.prompt, negative: plan.negative, image: await toDataUrl(frame), pinEnd: plan.pinEnd, aspectRatio: '16:9' });
      setJob({ id: r.job, seconds: 0, model: r.model });
    } catch (e) { fail(e); }
  };
  // poll a running Veo job; when the clip lands, open it for import
  useEffect(() => {
    if (!job) return;
    let live = true;
    const t = setInterval(async () => {
      try {
        const s = await api.clipJob(job.id);
        if (!live) return;
        if (s.status === 'running') { setJob(j => (j ? { ...j, seconds: s.seconds } : j)); return; }
        clearInterval(t); setJob(null); void loadClips();
        if (s.status === 'failed') fail(new Error(s.error ?? 'Video generation failed'));
        else if (s.clip) { notify(`Clip ready (${s.seconds}s). Opening the import…`); void openClip(s.clip); }
      } catch (e) { clearInterval(t); setJob(null); fail(e); }
    }, 5000);
    return () => { live = false; clearInterval(t); };
  }, [job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const modelInfo = gemini?.videoModels.find(v => v.id === gemini.videoModel);
  const seconds = provider === 'other' ? plan.seconds : 8;
  const inLibrary = !!linked?.animations.some(a => a.name === m.id);

  return (
    <section className="card step video-route">
      <div className="card-head">
        <span className="step-n"><Icon name="film" size={12} /></span>
        <h3>Animate with video</h3>
        <span className="dim small">the standard route: real motion from one clip</span>
        <div className="spacer" />
        <button className="ghost small" onClick={() => setOpen(o => !o)} aria-expanded={open}><Icon name={open ? 'chevronDown' : 'chevronRight'} /> {open ? 'Hide' : 'Show'}</button>
      </div>
      {!open ? <p className="dim small">Make one video of {d.name} doing {m.name.toLowerCase()} (Gemini app, Gemini API or any image-to-video model); Kinetome cuts the loop and turns it into pixel art.</p> : (
        <div className="vs">
          <div className="vs-target">
            <span className="dim small">Sprite</span>
            <select value={d.assetId ?? ''} onChange={e => void relink(e.target.value)} aria-label="Sprite the animation is saved into">
              {!d.assetId && <option value="">Choose {d.name}'s sprite…</option>}
              {characters.map(a => <option key={a.id} value={a.id}>{a.name}{a.id === d.assetId ? ` · ${d.pixelHeight}px` : ''}</option>)}
            </select>
            <span className="dim small">{linked ? <>{m.name} is saved into this sprite{inLibrary ? ' (replacing the current one)' : ''}; its idle is the size reference.</> : 'Import an idle sprite first: the video starts from it.'}</span>
          </div>

          {linked && sideView && (
            <div className={profile ? 'vs-step done' : 'vs-step'}>
              <div className="vs-step-head"><span className="vs-n">{profile ? <Icon name="check" size={11} /> : 1}</span><strong>Side view</strong><span className="dim small">once per character · every move except idle starts from it</span></div>
              <div className="vs-row">
                {profile && <ProfileThumb img={profile} />}
                <div className="vs-col">
                  <p className="dim small">A video keeps its first frame's angle. {d.name}'s idle is three-quarter, so a {m.name.toLowerCase()} from it comes out turned. {profile ? 'Looks wrong? Redraw it.' : `Have Gemini redraw ${d.name} side-on, facing right.`}</p>
                  <div className="btnrow">
                    {gemini?.configured
                      ? <button className={profile ? '' : 'primary'} onClick={() => void drawProfile()} disabled={drawing || !idle}><Icon name="gemini" /> {drawing ? 'Gemini is drawing…' : profile ? 'Redraw with Gemini' : 'Draw with Gemini'}</button>
                      : <CopyButton text={designProfilePrompt(style, d)} label="Copy prompt for Gemini" primary={!profile} />}
                    <button onClick={() => profileInput.current?.click()}><Icon name="upload" /> {profile ? 'Replace…' : 'Upload…'}</button>
                    {profile && <label className="toggle small"><input type="checkbox" checked={useIdle} onChange={e => setUseIdle(e.target.checked)} /> Start from the idle sprite instead</label>}
                    <input ref={profileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { void uploadProfile(e.target.files); e.target.value = ''; }} />
                  </div>
                  {!gemini?.configured && !profile && <p className="dim small">In the Gemini app: attach {d.name}'s sprite (the image below, or the reference), paste the prompt, save the result and upload it here.</p>}
                </div>
              </div>
            </div>
          )}

          {linked && (
            <div className="vs-step">
              <div className="vs-step-head"><span className="vs-n">{sideView ? 2 : 1}</span><strong>Make the video</strong>
                <div className="spacer" />
                <div className="seg compact plain" role="radiogroup" aria-label="Video model">
                  <button role="radio" aria-checked={provider === 'app'} className={provider === 'app' ? 'active' : ''} onClick={() => setProvider('app')}>Gemini app · free</button>
                  <button role="radio" aria-checked={provider === 'api'} className={provider === 'api' ? 'active' : ''} onClick={() => setProvider('api')}>Gemini API</button>
                  <button role="radio" aria-checked={provider === 'other'} className={provider === 'other' ? 'active' : ''} onClick={() => setProvider('other')}>Other model</button>
                </div>
              </div>
              <div className="vs-row">
                <div className="vs-frame">
                  <canvas ref={preview} aria-label="First frame preview" />
                  <button onClick={() => void saveFrame()} disabled={!frame}><Icon name="download" /> First frame</button>
                  <span className="dim small">{fromProfile ? 'side view' : 'idle sprite'} on {key.name} · {wide ? '16:9' : '1:1'}</span>
                </div>
                <div className="vs-col">
                  {provider === 'app' && (
                    <ol className="vr-steps">
                      <li>Download the <strong>first frame</strong>.</li>
                      <li>Open <a href="https://gemini.google.com" target="_blank" rel="noreferrer">gemini.google.com</a>, pick <strong>Video</strong> in the tools, attach the first frame.</li>
                      <li>Paste the prompt and send. <div className="btnrow"><CopyButton text={appPrompt} label="Copy prompt" /></div></li>
                      <li>Download the video, then <strong>Import video</strong> below. Gemini clips run slow: Kinetome plays {['run', 'walk', 'dash'].includes(m.id.replace(/-\d+$/, '')) ? `the ${m.name.toLowerCase()} at game speed` : 'the loop it finds'} and you can change the speed after.</li>
                    </ol>
                  )}
                  {provider === 'api' && (gemini?.configured ? (
                    <div className="vs-api">
                      <p className="small">Kinetome sends the first frame and the prompt to <strong>{modelInfo?.label ?? gemini.videoModel}</strong>{plan.pinEnd ? ', with the first frame also as the last frame (so the angle holds)' : ''}: an {seconds} s clip, {modelInfo ? <>about <strong>${(modelInfo.usdPerSecond * seconds).toFixed(2)}</strong> on your Google bill</> : 'billed by Google'}. It usually takes 1-3 minutes.</p>
                      <div className="btnrow">
                        <button className="primary" onClick={() => void generate()} disabled={!frame || !!job}><Icon name="film" /> {job ? `Making the video… ${job.seconds}s` : 'Generate video'}</button>
                        <button className="ghost small" onClick={openConnections}><Icon name="gemini" /> Model & key</button>
                      </div>
                      {job && <p className="dim small">You can keep working; the import opens when the clip is ready (keep this page open).</p>}
                    </div>
                  ) : (
                    <div className="vs-api">
                      <p className="small">Connect a Gemini API key and Kinetome makes the side view and the video for you: no copy-paste. Google bills video per second (about $0.40-$0.80 per clip on Veo Lite/Fast).</p>
                      <div className="btnrow"><button className="primary" onClick={openConnections}><Icon name="gemini" /> Connect Gemini</button></div>
                    </div>
                  ))}
                  {provider === 'other' && (
                    <ol className="vr-steps">
                      <li>In Kling, Hailuo or any image-to-video model: the first frame is the <strong>start image</strong>{plan.pinEnd ? <> and, if it has one, the <strong>end / last frame</strong></> : null}; <strong>{plan.seconds} s</strong>, 1:1, audio off.</li>
                      <li>Paste the prompt, and the negative prompt if there is a field for it.
                        <div className="btnrow"><CopyButton text={plan.prompt} label="Copy prompt" /><CopyButton text={plan.negative} label="Copy negative" primary={false} /></div>
                      </li>
                      <li>Download the video and <strong>Import video</strong> below. Watermarks are removed.</li>
                    </ol>
                  )}
                  <PromptBox text={provider === 'app' ? appPrompt : `${plan.prompt}\n\nNegative: ${plan.negative}`} />
                </div>
              </div>
            </div>
          )}

          {linked && (
            <div className="vs-step">
              <div className="vs-step-head"><span className="vs-n">{sideView ? 3 : 2}</span><strong>Clips</strong><span className="dim small">every video is kept: re-cut it any time (size, frames, loop, colours) without a new one</span>
                <div className="spacer" />
                <button className="primary" onClick={() => clipInput.current?.click()}><Icon name="upload" /> Import video…</button>
                <input ref={clipInput} type="file" accept="video/*,.mp4,.webm,.mov" hidden onChange={e => { void importFile(e.target.files); e.target.value = ''; }} />
              </div>
              {clips && !clips.length && <p className="dim small">No clips yet. {plan.cut}</p>}
              {!!clips?.length && (
                <div className="clip-list">
                  {clips.map(c => (
                    <div key={c.file} className="clip-row">
                      <video src={api.clipUrl(projectId, d.id, m.id, c.file)} muted loop playsInline preload="metadata" onMouseEnter={e => void e.currentTarget.play().catch(() => {})} onMouseLeave={e => e.currentTarget.pause()} />
                      <span className="clip-meta"><strong>{clipLabel(c.source)}</strong><span className="dim small">{ago(c.createdAt)} · {(c.bytes / 1e6).toFixed(1)} MB</span></span>
                      <div className="spacer" />
                      <button onClick={() => void openClip(c)}><Icon name="scissors" /> {inLibrary ? 'Re-cut' : 'Use this clip'}</button>
                      <button className="icon-btn" onClick={() => void removeClip(c)} aria-label="Delete clip" title="Delete clip"><Icon name="trash" /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** "veo-3.1-fast" -> "Veo 3.1 Fast"; uploads are "Imported video". */
const clipLabel = (source: string) => source === 'upload' ? 'Imported video'
  : source.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function ProfileThumb({ img }: { img: PixelImage }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const b = contentBounds(img, 128) ?? { x: 0, y: 0, w: img.width, h: img.height };
    const s = Math.min(88 / b.w, 88 / b.h);
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, 96, 96);
    ctx.imageSmoothingEnabled = s < 1;
    ctx.drawImage(pixelsToCanvas(img), b.x, b.y, b.w, b.h, (96 - b.w * s) / 2, (96 - b.h * s) / 2, b.w * s, b.h * s);
  }, [img]);
  return <canvas ref={ref} width={96} height={96} className="vs-thumb" aria-label="Side view" />;
}
