import { useState } from 'react';
import type { SpriteAsset } from '@sprite/core';
import { Icon } from '../icons.tsx';
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
  const [q, setQ] = useState('');
  const shown = assets.filter(a => !q || `${a.name} ${a.kind} ${a.animations.map(x => x.name).join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <aside className="panel asset-list">
      <div className="panel-title">Library <span className="dim">{assets.length}</span></div>
      {assets.length > 4 && (
        <div className="search">
          <Icon name="search" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter sprites" aria-label="Filter sprites" />
        </div>
      )}
      <div className="scroll">
        {shown.map(a => (
          <Row key={a.id} projectId={projectId} asset={a} active={a.id === selectedId} onClick={() => onSelect(a.id)} />
        ))}
        {!assets.length && (
          <div className="empty-inline col">
            <Icon name="upload" size={22} />
            <span>Drop sprite sheets, images, GIFs or videos anywhere, or create a character.</span>
          </div>
        )}
        {assets.length > 0 && !shown.length && <p className="dim pad small">No sprite matches "{q}"</p>}
      </div>
    </aside>
  );
}
