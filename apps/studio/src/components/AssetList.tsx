import type { SpriteAsset } from '@sprite/core';
import { api } from '../api.ts';
import { useImage } from '../pixels.ts';
import { FrameThumb } from './FrameThumb.tsx';

function Row({ projectId, asset, active, onClick }: { projectId: string; asset: SpriteAsset; active: boolean; onClick: () => void }) {
  const img = useImage(api.sheetUrl(projectId, asset));
  const first = asset.frames[asset.animations[0]?.frames[0] ?? 0];
  return (
    <button className={active ? 'asset-row active' : 'asset-row'} onClick={onClick}>
      <FrameThumb img={img} rect={first} size={40} className="thumb" />
      <span className="asset-meta">
        <span className="asset-name">{asset.name}{asset.reference && <span className="badge ref" title="Style reference">REF</span>}</span>
        <span className="dim">{asset.kind} · {asset.frames.length}f · {asset.animations.length} anim</span>
      </span>
    </button>
  );
}

export function AssetList({ projectId, assets, selectedId, onSelect }: {
  projectId: string; assets: SpriteAsset[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  return (
    <aside className="panel asset-list">
      <div className="panel-title">Assets <span className="dim">{assets.length}</span></div>
      <div className="scroll">
        {assets.map(a => (
          <Row key={a.id} projectId={projectId} asset={a} active={a.id === selectedId} onClick={() => onSelect(a.id)} />
        ))}
        {!assets.length && <p className="dim pad">Drop a sprite sheet anywhere to import it.</p>}
      </div>
    </aside>
  );
}
