import { packGrid, type Animation, type PixelImage, type SpriteAsset } from '@sprite/core';

export interface NewAnimations {
  frames: PixelImage[];
  pivot: { x: number; y: number };
  animations: Animation[]; // frame indexes into `frames`
}

/**
 * Adds animations to an existing character. Every frame (old and new) is re-seated into a
 * common cell with all pivots (feet) at the same point, so switching animations in-game
 * never shifts the character. An animation with the same name as an existing one replaces
 * it (regenerated "walk" swaps out the old walk); unused old frames are dropped.
 */
export function mergeIntoAsset(sheet: HTMLImageElement, asset: SpriteAsset, add: NewAnimations): { canvas: HTMLCanvasElement; asset: SpriteAsset } {
  const replaced = new Set(add.animations.map(a => a.name));
  const keptAnims = asset.animations.filter(a => !replaced.has(a.name));
  const usedOld = [...new Set(keptAnims.flatMap(a => a.frames))].sort((a, b) => a - b);
  const remap = new Map(usedOld.map((old, i) => [old, i]));

  const fw = asset.frameWidth, fh = asset.frameHeight, op = asset.pivot;
  const nw = add.frames[0]?.width ?? 0, nh = add.frames[0]?.height ?? 0, np = add.pivot;
  const left = Math.max(op.x, np.x), right = Math.max(fw - op.x, nw - np.x);
  const up = Math.max(op.y, np.y), down = Math.max(fh - op.y, nh - np.y);
  const W = left + right, H = up + down;

  const total = usedOld.length + add.frames.length;
  const layout = packGrid(total, W, H);
  const c = document.createElement('canvas');
  c.width = layout.width; c.height = layout.height;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  usedOld.forEach((old, i) => {
    const r = asset.frames[old], d = layout.rects[i];
    ctx.drawImage(sheet, r.x, r.y, r.w, r.h, d.x + left - op.x, d.y + up - op.y, r.w, r.h);
  });
  // putImageData ignores compositing, so go through a scratch canvas to keep transparency
  const scratch = document.createElement('canvas');
  add.frames.forEach((f, i) => {
    const d = layout.rects[usedOld.length + i];
    scratch.width = f.width; scratch.height = f.height;
    scratch.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
    ctx.drawImage(scratch, d.x + left - np.x, d.y + up - np.y);
  });

  const animations: Animation[] = [
    ...keptAnims.map(a => ({ ...a, frames: a.frames.map(f => remap.get(f)!) })),
    ...add.animations.map(a => ({ ...a, frames: a.frames.map(f => f + usedOld.length) })),
  ];
  return {
    canvas: c,
    asset: { ...asset, frameWidth: W, frameHeight: H, frames: layout.rects, pivot: { x: left, y: up }, animations },
  };
}
