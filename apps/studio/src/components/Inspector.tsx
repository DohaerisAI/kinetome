import { useMemo, useState } from 'react';
import {
  AssetKind, downscale, hardenAlpha, lintAsset, snapToPalette, type FixId, type SpriteAsset, type StyleBible,
} from '@kinetome/core';
import { canvasToPng, download, pixelsToCanvas, usePixels } from '../pixels.ts';
import { Icon, type IconName } from '../icons.tsx';
import { History } from './History.tsx';

interface Props {
  asset: SpriteAsset | null;
  img: HTMLImageElement | null;
  style: StyleBible;
  animName: string | null;
  onAnim: (name: string) => void;
  onSave: (a: SpriteAsset, png?: Blob) => Promise<void>;
  onDelete: (id: string) => void;
  /** Colors that are on-style for this sprite beyond the Style Bible (its character design's ramps). */
  extraPalette: string[];
  godotZipUrl: string | null;
  onSyncGodot: (() => void) | null;
  onEdit: (() => void) | null;
  onExport: (() => void) | null;
  projectId: string;
  onRestored: (a: SpriteAsset) => void;
  fail: (e: unknown) => void;
  /** Extra tabs (variants, lighting, export…) rendered by their own components. */
  extraTabs?: { id: string; label: string; icon: IconName; render: () => React.ReactNode }[];
}

type TabId = 'details' | 'history' | string;

export function Inspector({ asset, img, style, animName, onAnim, onSave, onDelete, extraPalette, godotZipUrl, onSyncGodot, onEdit, onExport, projectId, onRestored, fail, extraTabs = [] }: Props) {
  const [tab, setTab] = useState<TabId>('details');
  const pixels = usePixels(img);
  const effStyle = useMemo(() => (extraPalette.length ? { ...style, palette: [...new Set([...style.palette, ...extraPalette])] } : style), [style, extraPalette]);
  const report = useMemo(() => (asset && pixels ? lintAsset(pixels, asset, effStyle) : null), [asset, pixels, effStyle]);
  const [newAnim, setNewAnim] = useState({ name: '', from: 0, to: 0 });
  const [busy, setBusy] = useState(false);

  if (!asset) return <aside className="panel inspector"><div className="panel-title">Inspector</div></aside>;

  const patch = (p: Partial<SpriteAsset>) => onSave({ ...asset, ...p });
  const patchAnim = (name: string, p: Partial<SpriteAsset['animations'][number]>) =>
    patch({ animations: asset.animations.map(a => (a.name === name ? { ...a, ...p } : a)) });

  const applyFix = async (fix: FixId, factor = 1) => {
    if (!pixels) return;
    setBusy(true);
    try {
      if (fix === 'downscale') {
        const k = factor;
        const scaled: SpriteAsset = {
          ...asset,
          frameWidth: asset.frameWidth / k, frameHeight: asset.frameHeight / k,
          frames: asset.frames.map(r => ({ x: r.x / k, y: r.y / k, w: r.w / k, h: r.h / k })),
          pivot: { x: Math.floor(asset.pivot.x / k), y: Math.floor(asset.pivot.y / k) },
        };
        await onSave(scaled, await canvasToPng(pixelsToCanvas(downscale(pixels, k))));
        return;
      }
      // Harden before snapping: the browser stores semi-transparent pixels premultiplied,
      // so their RGB drifts off-palette again if alpha is fixed afterwards.
      const hard = hardenAlpha(pixels);
      const out = fix === 'snap-palette' ? snapToPalette(hard, effStyle.palette) : hard;
      await onSave(asset, await canvasToPng(pixelsToCanvas(out)));
    } finally { setBusy(false); }
  };

  const fixLabel = (fix: FixId, factor?: number) =>
    fix === 'snap-palette' ? 'Snap to palette' : fix === 'harden-alpha' ? 'Harden alpha' : `Downscale ÷${factor}`;

  const addAnim = () => {
    const name = newAnim.name.trim();
    const max = asset.frames.length - 1;
    const from = Math.max(0, Math.min(max, newAnim.from)), to = Math.max(0, Math.min(max, newAnim.to));
    if (!name || asset.animations.some(a => a.name === name)) return;
    const frames: number[] = [];
    for (let i = from; from <= to ? i <= to : i >= to; i += from <= to ? 1 : -1) frames.push(i);
    patch({ animations: [...asset.animations, { name, frames, fps: 10, loop: true }] }).then(() => onAnim(name));
    setNewAnim({ name: '', from: 0, to: 0 });
  };

  const exportAsset = async () => {
    if (!img) return;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d')!.drawImage(img, 0, 0);
    download(`${asset.id}.png`, await canvasToPng(c));
    download(`${asset.id}.json`, new Blob([JSON.stringify({ ...asset, image: `${asset.id}.png` }, null, 2)], { type: 'application/json' }));
  };

  return (
    <aside className="panel inspector">
      <div className="panel-title">{asset.name}</div>
      <div className="insp-tabs" role="tablist">
        {[{ id: 'details', label: 'Details', icon: 'info' as IconName }, { id: 'history', label: 'History', icon: 'undo' as IconName }, ...extraTabs].map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'insp-tab on' : 'insp-tab'} onClick={() => setTab(t.id)} title={t.label}>
            <Icon name={t.icon} size={14} /><span>{t.label}</span>
          </button>
        ))}
      </div>
      {tab === 'history' && <div className="scroll pad"><History projectId={projectId} asset={asset} onRestored={onRestored} fail={fail} /></div>}
      {extraTabs.map(t => tab === t.id && <div key={t.id} className="scroll pad">{t.render()}</div>)}
      {tab === 'details' && <div className="scroll pad">
        {onEdit && <button className="primary block-btn" onClick={onEdit}><Icon name="pencil" /> Edit in the sprite editor</button>}
        <label className="field">
          <span>Name</span>
          <input key={asset.id + asset.name} defaultValue={asset.name}
            onBlur={e => e.target.value.trim() && e.target.value !== asset.name && patch({ name: e.target.value.trim() })} />
        </label>
        <div className="row2">
          <label className="field">
            <span>Kind</span>
            <select value={asset.kind} onChange={e => patch({ kind: e.target.value as SpriteAsset['kind'] })}>
              {AssetKind.options.map(k => <option key={k}>{k}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Pivot</span>
            <span className="mono dim">{asset.pivot.x},{asset.pivot.y} · {asset.frameWidth}×{asset.frameHeight}</span>
          </label>
        </div>
        <label className="field">
          <span>Description (Prompt Kit uses this)</span>
          <textarea key={asset.id} rows={2} defaultValue={asset.description} placeholder="What it looks like: body, clothes, colors, details"
            onBlur={e => e.target.value !== asset.description && patch({ description: e.target.value })} />
        </label>
        <label className="toggle block" title="Approved assets are fed to generators as style references">
          <input type="checkbox" checked={asset.reference} onChange={e => patch({ reference: e.target.checked })} />
          Style reference for this project
        </label>

        <h3>Animations</h3>
        <ul className="anims">
          {asset.animations.map(a => (
            <li key={a.name} className={a.name === animName ? 'active' : ''} onClick={() => onAnim(a.name)}>
              <span className="anim-name">{a.name}</span>
              <span className="dim mono">{a.frames.length}f</span>
              <input type="number" min={1} max={60} value={a.fps} title="fps" className="num"
                onClick={e => e.stopPropagation()} onChange={e => patchAnim(a.name, { fps: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })} />
              <label className="toggle" onClick={e => e.stopPropagation()} title="Loop">
                <input type="checkbox" checked={a.loop} onChange={e => patchAnim(a.name, { loop: e.target.checked })} />↻
              </label>
              <button className="icon" title="Delete animation"
                onClick={e => { e.stopPropagation(); patch({ animations: asset.animations.filter(x => x.name !== a.name) }); }}>×</button>
            </li>
          ))}
        </ul>
        <div className="add-anim">
          <input placeholder="new animation" value={newAnim.name} onChange={e => setNewAnim({ ...newAnim, name: e.target.value })} />
          <input type="number" className="num" value={newAnim.from} min={0} title="first frame" onChange={e => setNewAnim({ ...newAnim, from: Number(e.target.value) })} />
          <span className="dim">→</span>
          <input type="number" className="num" value={newAnim.to} min={0} title="last frame" onChange={e => setNewAnim({ ...newAnim, to: Number(e.target.value) })} />
          <button onClick={addAnim}>Add</button>
        </div>

        <h3>Style check {report && <span className={report.issues.some(i => i.severity === 'error') ? 'badge err' : report.issues.length ? 'badge warn' : 'badge ok'}>
          {report.issues.length ? `${report.issues.length} issue${report.issues.length > 1 ? 's' : ''}` : 'on-style'}</span>}</h3>
        {report && (
          <>
            <p className="dim small">{report.stats.colors} colors · content {report.stats.contentHeight}px tall · unit {style.unitHeight}px</p>
            {report.issues.map((i, n) => (
              <div key={n} className={`issue ${i.severity}`}>
                <div>{i.message}</div>
                {i.colors && <div className="swatches small">{i.colors.map(c => <span key={c} className="sw" style={{ background: c }} title={c} />)}</div>}
                {i.fix && <button disabled={busy} onClick={() => applyFix(i.fix!, i.factor)}>{fixLabel(i.fix, i.factor)}</button>}
              </div>
            ))}
          </>
        )}

        <h3>Godot</h3>
        <p className="dim small">SpriteFrames + a ready AnimatedSprite2D scene (nearest filter, feet on the origin).</p>
        <div className="btnrow">
          {godotZipUrl && <a className="button" href={godotZipUrl}>Download .zip</a>}
          {onSyncGodot && <button onClick={onSyncGodot}>Sync to Godot project</button>}
          {onExport && <button onClick={onExport}>Other engines…</button>}
        </div>

        <h3>Asset</h3>
        <div className="btnrow">
          <button onClick={exportAsset}>Export PNG + JSON</button>
          <button className="danger" onClick={() => onDelete(asset.id)}><Icon name="trash" size={14} /> Move to trash</button>
        </div>
      </div>}
    </aside>
  );
}
