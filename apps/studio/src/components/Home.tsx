import { useEffect, useMemo, useRef, useState } from 'react';
import type { CharacterDesign, Project, SpriteAsset, StyleBible } from '@kinetome/core';
import { api } from '../api.ts';
import { Icon, type IconName } from '../icons.tsx';
import { loadImage, useImage } from '../pixels.ts';
import { useEnter } from '../motion.ts';
import { ago } from '../time.ts';
import { FrameThumb } from './FrameThumb.tsx';

export type HomeTarget = 'library' | 'editor' | 'characters' | 'lineup' | 'style';

interface Props {
  project: Project | null;
  style: StyleBible;
  assets: SpriteAsset[];
  designs: CharacterDesign[];
  projectId: string;
  onGo: (tab: HomeTarget) => void;
  onOpenAsset: (id: string) => void;
  onEditAsset: (id: string) => void;
  onImport: () => void;
  onPalette: () => void;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Late night pixels' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};


/**
 * The cast on a shared baseline, first frame of each (paused, like every player here),
 * scaled as one so the sizes are honest. Click someone to open them.
 */
function CastStage({ projectId, assets, designs, unit, onOpen }: { projectId: string; assets: SpriteAsset[]; designs: CharacterDesign[]; unit: number; onOpen: (id: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [imgs, setImgs] = useState<Map<string, HTMLImageElement>>(new Map());
  const [hot, setHot] = useState<string | null>(null);
  const boxes = useRef<{ id: string; x0: number; x1: number }[]>([]);
  // one of each character: designed ones first, then style references, then the newest;
  // sprites far off the project's scale are the Lineup's business, not the welcome mat's
  const cast = useMemo(() => {
    const linked = new Set(designs.map(d => d.assetId).filter(Boolean));
    const rank = (a: SpriteAsset) => (linked.has(a.id) ? 0 : a.reference ? 1 : 2);
    const seen = new Set<string>();
    return assets
      .filter(a => a.kind === 'character' && (linked.has(a.id) || a.pivot.y + 1 <= unit * 3))
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
      .filter(a => { const k = a.name.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 7);
  }, [assets, designs, unit]);

  useEffect(() => {
    let live = true;
    Promise.all(cast.map(a => loadImage(api.sheetUrl(projectId, a)).then(i => [a.id, i] as const).catch(() => null)))
      .then(list => live && setImgs(new Map(list.filter(Boolean) as [string, HTMLImageElement][])));
    return () => { live = false; };
  }, [projectId, cast]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const W = c.clientWidth, H = c.clientHeight, dpr = window.devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    const shown = cast.filter(a => imgs.has(a.id));
    const baseline = H - 34;
    // ground: a soft light pool and a hairline
    const g = ctx.createRadialGradient(W / 2, baseline, 10, W / 2, baseline, W * 0.55);
    g.addColorStop(0, 'rgba(139,108,255,.20)'); g.addColorStop(1, 'rgba(139,108,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, baseline - 60, W, 120);
    ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fillRect(24, baseline, W - 48, 1);
    if (!shown.length) return;
    const tallest = Math.max(unit, ...shown.map(a => a.pivot.y + 1));
    const widths = shown.map(a => a.frameWidth);
    const z = Math.max(1, Math.min(6, Math.floor((baseline - 18) / tallest), Math.floor((W - 60) / (widths.reduce((s, w) => s + w, 0) + 8 * shown.length))));
    const total = widths.reduce((s, w) => s + w * z, 0) + (shown.length - 1) * 8 * z;
    let x = Math.floor((W - total) / 2);
    boxes.current = [];
    for (const a of shown) {
      const img = imgs.get(a.id)!;
      const r = a.frames[a.animations[0]?.frames[0] ?? 0];
      if (r) {
        const top = baseline - (a.pivot.y + 1) * z;
        // contact shadow
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.beginPath(); ctx.ellipse(x + (a.pivot.x + 0.5) * z, baseline + 1, Math.max(6, r.w * z * 0.28), 3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = hot && hot !== a.id ? 0.55 : 1;
        ctx.drawImage(img, r.x, r.y, r.w, r.h, x, top, r.w * z, r.h * z);
        ctx.globalAlpha = 1;
      }
      boxes.current.push({ id: a.id, x0: x, x1: x + a.frameWidth * z });
      if (hot === a.id) {
        ctx.font = "600 12px 'Geist Variable', sans-serif";
        ctx.fillStyle = '#ececf4'; ctx.textAlign = 'center';
        ctx.fillText(a.name, x + (a.frameWidth * z) / 2, baseline + 22);
        ctx.textAlign = 'start';
      }
      x += a.frameWidth * z + 8 * z;
    }
  }, [cast, imgs, unit, hot]);

  const at = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect(), x = e.clientX - r.left;
    return boxes.current.find(b => x >= b.x0 && x <= b.x1)?.id ?? null;
  };

  if (!cast.length) {
    return (
      <div className="cast-empty">
        <Icon name="users" size={26} />
        <span>Your cast will stand here.</span>
      </div>
    );
  }
  return (
    <canvas ref={canvas} className="cast-stage" style={{ cursor: hot ? 'pointer' : 'default' }} aria-label="Your characters"
      onMouseMove={e => setHot(at(e))} onMouseLeave={() => setHot(null)} onClick={e => { const id = at(e); if (id) onOpen(id); }} />
  );
}

function RecentCard({ projectId, asset, onOpen, onEdit }: { projectId: string; asset: SpriteAsset; onOpen: () => void; onEdit: () => void }) {
  const img = useImage(api.sheetUrl(projectId, asset));
  return (
    <div className="recent-card" data-enter>
      <button className="recent-thumb" onClick={onOpen} aria-label={`Open ${asset.name}`}>
        <FrameThumb img={img} rect={asset.frames[asset.animations[0]?.frames[0] ?? 0]} size={88} />
      </button>
      <div className="recent-meta">
        <strong>{asset.name}</strong>
        <span className="dim small">{asset.animations.length} anim · {asset.frames.length}f · {ago(asset.updatedAt)}</span>
      </div>
      <button className="icon-btn recent-edit" onClick={onEdit} title="Edit in the sprite editor" aria-label={`Edit ${asset.name}`}><Icon name="pencil" size={14} /></button>
    </div>
  );
}

/**
 * The front door: where you are in the pipeline, your cast, and what you touched last,
 * with one obvious next step.
 */
export function Home({ project, style, assets, designs, projectId, onGo, onOpenAsset, onEditAsset, onImport, onPalette }: Props) {
  const root = useRef<HTMLElement>(null);
  useEnter(root, [projectId]);

  // a move counts as animated by code (a program) or by the rig (a keyframe clip)
  const animated = designs.reduce((n, d) => n + new Set([...Object.keys(d.programs ?? {}), ...Object.keys(d.rig?.clips ?? {})]).size, 0);
  const moves = designs.reduce((n, d) => n + d.moves.length, 0);
  const animCount = assets.reduce((n, a) => n + a.animations.length, 0);
  const recent = [...assets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);

  const steps: { tab: HomeTarget; icon: IconName; title: string; detail: string; done: boolean; cta: string }[] = [
    { tab: 'style', icon: 'palette', title: 'Style Bible', detail: `${style.palette.length} colors · ${style.unitHeight}px characters · ${style.perspective} view`, done: style.palette.length >= 2 && !!style.notes.trim(), cta: 'Set the rules' },
    { tab: 'characters', icon: 'users', title: 'Characters', detail: designs.length ? designs.map(d => d.name).slice(0, 3).join(', ') + (designs.length > 3 ? ` +${designs.length - 3}` : '') : 'Describe someone; Gemini draws the reference', done: designs.length > 0, cta: designs.length ? 'Open cast' : 'Create one' },
    { tab: 'characters', icon: 'film', title: 'Animations', detail: moves ? `${animated} of ${moves} moves animated` : 'Walk, attack, idle: rig keyframes or Claude code', done: animated > 0, cta: animated ? 'Animate more' : 'Animate' },
    { tab: 'editor', icon: 'pencil', title: 'Polish', detail: `${assets.length} sprites · ${animCount} animations in the library`, done: assets.some(a => a.tags.includes('edited')), cta: 'Open editor' },
    { tab: 'style', icon: 'download', title: 'Ship to Godot', detail: project?.godot.path ? `Syncs into ${project.godot.path.split(/[\\/]/).slice(-2).join('/')}` : 'Zip download anytime, or sync a project folder', done: !!project?.godot.path, cta: project?.godot.path ? 'Settings' : 'Connect' },
  ];
  const next = steps.find(s => !s.done);

  return (
    <main className="home" ref={root}>
      <div className="home-inner">
        <section className="hero" data-enter>
          <div className="hero-copy">
            <span className="eyebrow"><span className="eyebrow-dot" /> {project?.name ?? 'Project'}</span>
            <h1>{greeting()}.</h1>
            <p>Turn references into game-ready pixel animation. {next ? <>Next up: <button className="linklike" onClick={() => onGo(next.tab)}>{next.title.toLowerCase()}</button>.</> : 'Everything is in place. Make something move.'}</p>
            <div className="hero-actions">
              <button className="primary lg" onClick={onImport}><Icon name="upload" /> Import art</button>
              <button className="lg" onClick={() => onGo('characters')}><Icon name="users" /> New character</button>
              <button className="lg ghost" onClick={() => onGo('editor')}><Icon name="pencil" /> Sprite editor</button>
            </div>
            <button className="kbd-hint" onClick={onPalette}><kbd>Ctrl</kbd><kbd>K</kbd> jump anywhere</button>
          </div>
          <div className="hero-stage">
            <CastStage projectId={projectId} assets={assets} designs={designs} unit={style.unitHeight} onOpen={onOpenAsset} />
          </div>
        </section>

        <section className="pipeline" aria-label="Pipeline">
          {steps.map((s, i) => (
            <button key={s.title} className={`step-card${s.done ? ' done' : ''}${s === next ? ' next' : ''}`} onClick={() => onGo(s.tab)} data-enter>
              <span className="step-top">
                <span className="step-ic"><Icon name={s.done ? 'check' : s.icon} size={16} /></span>
                <span className="step-i mono">0{i + 1}</span>
              </span>
              <strong>{s.title}</strong>
              <span className="step-detail">{s.detail}</span>
              <span className="step-cta">{s.cta} <Icon name="chevronRight" size={12} /></span>
            </button>
          ))}
        </section>

        <section className="recent">
          <div className="section-head" data-enter>
            <h2>Recent sprites</h2>
            <span className="dim small">{assets.length} in the library</span>
            <div className="spacer" />
            <button className="ghost small" onClick={() => onGo('library')}>Open library <Icon name="chevronRight" size={12} /></button>
          </div>
          {recent.length ? (
            <div className="recent-grid">
              {recent.map(a => <RecentCard key={a.id} projectId={projectId} asset={a} onOpen={() => onOpenAsset(a.id)} onEdit={() => onEditAsset(a.id)} />)}
            </div>
          ) : (
            <button className="drop-card" onClick={onImport} data-enter>
              <Icon name="upload" size={22} />
              <strong>Drop your first sprite sheet, GIF or video</strong>
              <span className="dim small">or click to choose files. Anything with a messy background can be cleaned up and pixelized.</span>
            </button>
          )}
        </section>
      </div>
    </main>
  );
}
