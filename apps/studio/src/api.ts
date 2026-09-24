import type { Project, SpriteAsset, StyleBible } from '@sprite/core';

export type AssetDraft = Omit<SpriteAsset, 'version' | 'id' | 'image' | 'createdAt' | 'updatedAt'>;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

function assetForm(asset: unknown, png?: Blob): FormData {
  const f = new FormData();
  f.set('asset', JSON.stringify(asset));
  if (png) f.set('image', png, 'sheet.png');
  return f;
}

export const api = {
  listProjects: () => call<Project[]>('/projects'),
  createProject: (name: string) => call<Project>('/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  getProject: (p: string) => call<{ project: Project; style: StyleBible }>(`/projects/${p}`),
  saveStyle: (p: string, style: StyleBible) => call<StyleBible>(`/projects/${p}/style`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(style),
  }),
  listAssets: (p: string) => call<SpriteAsset[]>(`/projects/${p}/assets`),
  createAsset: (p: string, draft: AssetDraft, png: Blob) =>
    call<SpriteAsset>(`/projects/${p}/assets`, { method: 'POST', body: assetForm(draft, png) }),
  updateAsset: (p: string, asset: SpriteAsset, png?: Blob) =>
    call<SpriteAsset>(`/projects/${p}/assets/${asset.id}`, { method: 'PUT', body: assetForm(asset, png) }),
  deleteAsset: (p: string, a: string) => call<void>(`/projects/${p}/assets/${a}`, { method: 'DELETE' }),
  sheetUrl: (p: string, a: SpriteAsset) => `/api/projects/${p}/assets/${a.id}/sheet.png?v=${encodeURIComponent(a.updatedAt)}`,
};
