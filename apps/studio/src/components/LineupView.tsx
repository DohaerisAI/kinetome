import { useEffect, useMemo, useRef, useState } from 'react';
import { lintAsset, type LintReport, type SpriteAsset, type StyleBible } from '@sprite/core';
import { api } from '../api.ts';
import { loadImage, toPixels } from '../pixels.ts';

interface Loaded { asset: SpriteAsset; img: HTMLImageElement; report: LintReport }

const pickAnim = (a: SpriteAsset) => a.animations.find(x => /idle/i.test(x.name)) ?? a.animations[0];

/**
 * Every sprite side by side at the same scale on a shared baseline, the way an art
 * director checks a cast. Odd-one-out problems (wrong size, off palette) are obvious here.
 */
export function LineupView({ projectId, assets, style, paletteFor, onOpen }: {
  projectId: string; assets: SpriteAsset[]; style: StyleBible; paletteFor: (assetId: string) => string[]; onOpen: (id: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded[]>([]);
  const [onlyChars, setOnlyChars] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [zoom, setZoom] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all(assets.map(async asset => {
      const img = await loadImage(api.sheetUrl(projectId, asset));
      const extra = paletteFor(asset.id);
      const eff = extra.length ? { ...style, palette: [...new Set([...style.palette, ...extra])] } : style;
      return { asset, img, report: lintAsset(toPixels(img), asset, eff) };
    })).then(l => live && setLoaded(l), () => {});
    return () => { live = false; };
  }, [projectId, assets, style, paletteFor]);

  const shown = useMemo(() => loaded.filter(l => !onlyChars || l.asset.kind === 'character'), [loaded, onlyChars]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const gap = 12;
    const above = Math.max(style.unitHeight, ...shown.map(l => l.asset.pivot.y + 1));
    const below = Math.max(0, ...shown.map(l => l.asset.frameHeight - l.asset.pivot.y - 1));
    const totalW = shown.reduce((s, l) => s + l.asset.frameWidth, 0);
    const z = zoom || Math.max(1, Math.min(8, Math.floor(260 / (above + below)), Math.floor(1100 / Math.max(1, totalW + gap * shown.length))));
    const pad = 40;
    c.width = Math.max(320, totalW * z + gap * z * Math.max(0, shown.length - 1) + pad * 2);
    c.height = (above + below) * z + pad * 2 + 16;
    const ctx = c.getContext('2d')!;
    const baseline = pad + above * z;

    let raf = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const t = (now - start) / 1000;
      ctx.fillStyle = '#15151f';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.imageSmoothingEnabled = false;
      // unit height guide + baseline
      ctx.strokeStyle = 'rgba(120,200,255,0.35)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, baseline - style.unitHeight * z + 0.5); ctx.lineTo(c.width, baseline - style.unitHeight * z + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(120,200,255,0.6)';
      ctx.font = '11px monospace';
      ctx.fillText(`unit ${style.unitHeight}px`, 6, baseline - style.unitHeight * z - 4);
      ctx.strokeStyle = 'rgba(255,90,140,0.5)';
      ctx.beginPath(); ctx.moveTo(0, baseline + 0.5); ctx.lineTo(c.width, baseline + 0.5); ctx.stroke();

      let x = pad;
      for (const l of shown) {
        const anim = pickAnim(l.asset);
        const seq = anim?.frames ?? [0];
        const fi = playing && anim ? seq[Math.floor(t * anim.fps) % seq.length] : seq[0];
        const r = l.asset.frames[fi];
        const top = baseline - (l.asset.pivot.y + 1) * z;
        if (r) ctx.drawImage(l.img, r.x, r.y, r.w, r.h, x, top, r.w * z, r.h * z);
        const bad = l.report.issues.some(i => i.severity !== 'info');
        ctx.fillStyle = bad ? '#ffb454' : '#9aa0c8';
        ctx.fillText(l.asset.name.slice(0, 14), x, c.height - 14);
        x += (l.asset.frameWidth + gap) * z;
      }
      if (playing) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [shown, style, playing, zoom]);

  return (
    <main className="lineup">
      <div className="viewer-toolbar">
        <strong>Lineup</strong>
        <span className="dim">Same scale, shared baseline: anything off-style stands out.</span>
        <div className="spacer" />
        <label className="toggle"><input type="checkbox" checked={playing} onChange={e => setPlaying(e.target.checked)} /> Animate</label>
        <label className="toggle"><input type="checkbox" checked={onlyChars} onChange={e => setOnlyChars(e.target.checked)} /> Characters only</label>
        <select value={zoom} onChange={e => setZoom(Number(e.target.value))} aria-label="Zoom">
          <option value={0}>Auto</option>
          {[1, 2, 3, 4, 6, 8].map(n => <option key={n} value={n}>{n}×</option>)}
        </select>
      </div>
      <div className="lineup-stage"><canvas ref={canvas} /></div>
      <table className="report">
        <thead><tr><th>Asset</th><th>Kind</th><th>Colors</th><th>Height</th><th>Style check</th></tr></thead>
        <tbody>
          {shown.map(l => {
            const errs = l.report.issues.filter(i => i.severity === 'error').length;
            const warns = l.report.issues.filter(i => i.severity === 'warn').length;
            return (
              <tr key={l.asset.id} onClick={() => onOpen(l.asset.id)}>
                <td>{l.asset.name}</td>
                <td className="dim">{l.asset.kind}</td>
                <td className="mono">{l.report.stats.colors}</td>
                <td className="mono">{l.report.stats.contentHeight}px</td>
                <td>
                  {errs > 0 && <span className="badge err">{errs} error{errs > 1 ? 's' : ''}</span>}
                  {warns > 0 && <span className="badge warn">{warns} warning{warns > 1 ? 's' : ''}</span>}
                  {!errs && !warns && <span className="badge ok">on-style</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
