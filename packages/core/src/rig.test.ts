import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipPoses, partOwnership, renderClip, renderPose, rigCanvas, solvePose, type PixelImage, type RigPart } from './index.ts';

/** A stick figure: 3px-wide torso column, an arm sticking out to the right. */
function figure(): PixelImage {
  const W = 12, H = 16, img: PixelImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const put = (x: number, y: number, c: [number, number, number]) => img.data.set([...c, 255], (y * W + x) * 4);
  for (let y = 2; y < 16; y++) for (let x = 4; x < 7; x++) put(x, y, [200, 60, 60]);   // body
  for (let x = 7; x < 11; x++) put(x, 5, [60, 60, 200]);                              // upper arm
  put(11, 5, [60, 200, 60]);                                                           // hand
  return img;
}
const parts: RigPart[] = [
  { name: 'body', poly: [[3, 1], [8, 1], [8, 16], [3, 16]], pivot: [5, 15], parent: null, z: 0 },
  { name: 'arm', poly: [[7, 4], [11, 4], [11, 7], [7, 7]], pivot: [7, 5.5], parent: 'body', z: 1 },
  { name: 'hand', poly: [[11, 4], [12, 4], [12, 7], [11, 7]], pivot: [11, 5.5], parent: 'arm', z: 2 },
];

test('rig: every opaque pixel has exactly one owner, the front-most part', () => {
  const own = partOwnership(figure(), parts);
  assert.equal(own[5 * 12 + 11], 2, 'hand');
  assert.equal(own[5 * 12 + 8], 1, 'arm');
  assert.equal(own[10 * 12 + 5], 0, 'body');
  assert.equal(own[0], -1, 'transparent');
});

test('rig: the neutral pose reproduces the reference exactly; a rotated parent carries its child', () => {
  const ref = figure(), c = rigCanvas(ref);
  const same = renderPose(ref, parts, {}, c);
  for (let y = 0; y < ref.height; y++) for (let x = 0; x < ref.width; x++) {
    const a = ref.data.subarray((y * ref.width + x) * 4, (y * ref.width + x) * 4 + 4), b = same.data.subarray(((y + c.pad) * c.width + x + c.pad) * 4, ((y + c.pad) * c.width + x + c.pad) * 4 + 4);
    assert.deepEqual([...b], [...a], `pixel ${x},${y}`);
  }
  // arm rotated 90° clockwise: it now hangs down from the shoulder, and the hand follows
  const t = solvePose(parts, { arm: { angle: 90, dx: 0, dy: 0 } });
  assert.deepEqual(t.get('hand')!.at, [7, 9.5], 'hand pivot swung below the shoulder (4px arm, now vertical)');
  assert.equal(t.get('hand')!.angle, 90);
  const down = renderPose(ref, parts, { arm: { angle: 90, dx: 0, dy: 0 } }, c);
  const at = (x: number, y: number) => [...down.data.subarray(((y + c.pad) * c.width + x + c.pad) * 4, ((y + c.pad) * c.width + x + c.pad) * 4 + 3)];
  assert.deepEqual(at(7, 8), [60, 60, 200], 'arm now vertical');
  assert.deepEqual(at(7, 9), [60, 200, 60], 'hand at the end of the arm');
  assert.equal(down.data[((5 + c.pad) * c.width + 10 + c.pad) * 4 + 3], 0, 'old arm position is empty');
});

test('rig: in-betweens ease between keys, holds hold, loops wrap back to the first key', () => {
  const names = ['arm'];
  const clip = { frames: 5, fps: 8, loop: false, keys: [{ frame: 0, pose: { arm: { angle: 0, dx: 0, dy: 0 } }, ease: 'linear' as const }, { frame: 4, pose: { arm: { angle: 40, dx: 4, dy: 0 } }, ease: 'linear' as const }] };
  assert.deepEqual(clipPoses(clip, names).map(p => p.arm.angle), [0, 10, 20, 30, 40]);
  const held = clipPoses({ ...clip, keys: [{ ...clip.keys[0], ease: 'hold' as const }, clip.keys[1]] }, names);
  assert.deepEqual(held.map(p => p.arm.angle), [0, 0, 0, 0, 40]);
  const loop = clipPoses({ frames: 4, fps: 8, loop: true, keys: [{ frame: 0, pose: { arm: { angle: 0, dx: 0, dy: 0 } }, ease: 'linear' as const }, { frame: 2, pose: { arm: { angle: 20, dx: 0, dy: 0 } }, ease: 'linear' as const }] }, names);
  assert.deepEqual(loop.map(p => p.arm.angle), [0, 10, 20, 10]);
  const frames = renderClip(figure(), parts, clip);
  assert.equal(frames.length, 5);
  assert.notDeepEqual(frames[0].data, frames[4].data);
});
