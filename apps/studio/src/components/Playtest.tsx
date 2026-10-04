import { useEffect, useMemo, useRef, useState } from 'react';
import { tintVariant, type CharacterDesign, type PixelImage, type Rect, type SpriteAsset, type StyleBible } from '@kinetome/core';
import { EFFECTS, type EffectAnimation } from '@kinetome/pixel';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { useImage } from '../pixels.ts';
import { PageHeader } from './PageHeader.tsx';

type State = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'attack' | 'hurt';
const STATES: State[] = ['idle', 'walk', 'run', 'jump', 'fall', 'attack', 'hurt'];
const GUESS: Record<State, RegExp> = {
  idle: /idle|stand|breath/i, walk: /walk/i, run: /run|dash|sprint/i, jump: /jump|rise/i,
  fall: /fall|drop|air/i, attack: /attack|slash|punch|kick|strike|cast|shoot|swing/i, hurt: /hurt|damage|hit$|flinch/i,
};
const RESOLUTIONS = [[320, 180], [384, 216], [480, 270], [640, 360]] as const;

interface Settings {
  res: number; crt: boolean; boxes: boolean; walk: number; runMul: number; jump: number; gravity: number;
  effect: string; dummy: string | null; map: Partial<Record<State, string>>;
}

const key = (projectId: string, asset: string) => `kinetome.playtest.${projectId}.${asset}`;
/** Speeds and jump scale with the character's own height (feet line ~ its pixel height), not the project's. */
const heightOf = (asset: SpriteAsset | null, fallback: number) => (asset ? Math.max(12, Math.round(asset.pivot.y * 0.9)) : fallback);

function defaults(asset: SpriteAsset | null, unit: number): Settings {
  const h = heightOf(asset, unit);
  const base: Settings = { res: 0, crt: false, boxes: true, walk: Math.round(h * 1.6), runMul: 1.8, jump: Math.round(h * 1.4), gravity: 900, effect: 'auto', dummy: null, map: {} };
  if (!asset) return base;
  const names = asset.animations.map(a => a.name);
  const guess = (st: State) => names.find(n => GUESS[st].test(n) && !(st === 'attack' && GUESS.hurt.test(n)));
  base.map = Object.fromEntries(STATES.map(st => [st, guess(st)]).filter(([, v]) => v)) as Settings['map'];
  return base;
}

function loadSettings(projectId: string, asset: SpriteAsset | null, unit: number): Settings {
  const base = defaults(asset, unit);
  if (!asset) return base;
  const names = asset.animations.map(a => a.name);
  try {
    const saved = JSON.parse(localStorage.getItem(key(projectId, asset.id)) ?? '{}') as Partial<Settings>;
    // saved choices win, but only for animations that still exist; new animations get guessed
    const kept = Object.fromEntries(Object.entries(saved.map ?? {}).filter(([, v]) => v && names.includes(v as string)));
    return { ...base, ...saved, map: { ...base.map, ...kept } };
  } catch { return base; }
}

const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
const toCanvas = (img: PixelImage) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0); return c; };

/** Deterministic value noise for the procedural level. */
function noise(seed: number) {
  let s = seed >>> 0;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pts = Array.from({ length: 64 }, r);
  return (x: number) => { const i = Math.floor(x), f = x - i, a = pts[((i % 64) + 64) % 64], b = pts[(((i + 1) % 64) + 64) % 64]; return a + (b - a) * (f * f * (3 - 2 * f)); };
}

/** Parallax layers from the Style Bible palette: sky, far peaks, near hills, ground. */
function buildLevel(palette: string[], W: number, H: number, worldW: number, groundY: number) {
  const sorted = [...palette].sort((a, b) => lum(a) - lum(b));
  const pick = (t: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(t * (sorted.length - 1))))];
  const sky = document.createElement('canvas'); sky.width = W; sky.height = H;
  const sc = sky.getContext('2d')!;
  const bands = [pick(0.02), pick(0.08), pick(0.16), pick(0.24)];
  bands.forEach((c, i) => { sc.fillStyle = c; sc.fillRect(0, Math.round((i * H) / bands.length / 1.6), W, H); });
  const star = pick(0.95);
  const rs = noise(7);
  for (let i = 0; i < 40; i++) { sc.fillStyle = star; sc.fillRect(Math.floor(rs(i * 3.7) * W), Math.floor(rs(i * 5.3 + 11) * H * 0.45), 1, 1); }
  const layer = (color: string, top: string, base: number, amp: number, scale: number, seed: number, w: number) => {
    const c = document.createElement('canvas'); c.width = w; c.height = H;
    const g = c.getContext('2d')!, n = noise(seed);
    for (let x = 0; x < w; x++) {
      const h = Math.round(base - n(x / scale) * amp - n(x / (scale / 3) + 9) * amp * 0.25);
      g.fillStyle = top; g.fillRect(x, h, 1, 1);
      g.fillStyle = color; g.fillRect(x, h + 1, 1, H - h);
    }
    return c;
  };
  const far = layer(pick(0.18), pick(0.3), groundY - 26, 40, 60, 3, Math.ceil(worldW * 0.3 + W));
  const mid = layer(pick(0.3), pick(0.44), groundY - 6, 26, 34, 5, Math.ceil(worldW * 0.6 + W));
  const ground = document.createElement('canvas'); ground.width = worldW; ground.height = H - groundY;
  const gg = ground.getContext('2d')!, gn = noise(13);
  gg.fillStyle = pick(0.22); gg.fillRect(0, 0, worldW, ground.height);
  gg.fillStyle = pick(0.5); gg.fillRect(0, 0, worldW, 2);
  gg.fillStyle = pick(0.66);
  for (let x = 0; x < worldW; x++) { if (gn(x / 3) > 0.7) gg.fillRect(x, -1 + 1, 1, 1); if (gn(x / 5 + 40) > 0.82) gg.fillRect(x, 0, 1, 1); }
  gg.fillStyle = pick(0.14);
  for (let y = 5; y < ground.height; y += 5) for (let x = (y * 7) % 11; x < worldW; x += 11 + Math.floor(gn(x + y) * 9)) gg.fillRect(x, y, 2, 1);
  return { sky, far, mid, ground };
}

interface Actor { x: number; y: number; vx: number; vy: number; facing: 1 | -1; grounded: boolean; state: State; t: number; lastFrame: number }
interface Spawn { anim: EffectAnimation; canvases: HTMLCanvasElement[]; x: number; y: number; t: number; facing: 1 | -1 }

/**
 * The playtest room: your character at true game resolution in a little parallax level,
 * driven by keyboard or gamepad. Feel the walk speed against the animation, the jump
 * arc, the attack's reach against a dummy, hitboxes and frame events firing.
 */
export function Playtest({ projectId, assets, style, designs, active }: { projectId: string; assets: SpriteAsset[]; style: StyleBible; designs: CharacterDesign[]; active: boolean }) {
  const chars = useMemo(() => {
    const linked = new Set(designs.map(d => d.assetId));
    return assets.filter(a => a.animations.length).sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)) || Number(b.kind === 'character') - Number(a.kind === 'character'));
  }, [assets, designs]);
  const [heroId, setHeroId] = useState<string | null>(null);
  const hero = chars.find(a => a.id === heroId) ?? chars[0] ?? null;
  const [s, setS] = useState<Settings>(() => loadSettings(projectId, hero, style.unitHeight));
  useEffect(() => { setS(loadSettings(projectId, hero, style.unitHeight)); }, [projectId, hero?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (hero) try { localStorage.setItem(key(projectId, hero.id), JSON.stringify(s)); } catch { /* storage off */ } }, [s, hero, projectId]);
  const set = (p: Partial<Settings>) => setS(x => ({ ...x, ...p }));

  const dummy = chars.find(a => a.id === s.dummy) ?? null;
  const heroImg = useImage(hero ? api.sheetUrl(projectId, hero) : null);
  const dummyImg = useImage(dummy ? api.sheetUrl(projectId, dummy) : null);
  const [running, setRunning] = useState(false);
  const [hud, setHud] = useState({ state: 'idle', anim: '', frame: 0, speed: 0, hits: 0, events: [] as string[] });
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 900, h: 520 });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (!active) setRunning(false); }, [active]);

  const [W, H] = RESOLUTIONS[s.res];
  const scale = Math.max(1, Math.floor(Math.min(box.w / W, box.h / H)));
  const groundY = H - 22;
  const worldW = W * 4;
  const level = useMemo(() => buildLevel(style.palette, W, H, worldW, groundY), [style.palette, W, H, worldW, groundY]);
  const fxColors = useMemo(() => [...style.palette].sort((a, b) => lum(a) - lum(b)).filter((_, i, all) => i >= all.length * 0.45), [style.palette]);

  // the dummy's white hurt flash, prepared once
  const dummyFlash = useMemo(() => {
    if (!dummy || !dummyImg) return null;
    const r = dummy.frames[dummy.animations[0]?.frames[0] ?? 0];
    const c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(dummyImg, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const d = g.getImageData(0, 0, r.w, r.h);
    return toCanvas(tintVariant({ width: r.w, height: r.h, data: d.data }, 'hurt'));
  }, [dummy, dummyImg]);

  const actor = useRef<Actor>({ x: 60, y: 0, vx: 0, vy: 0, facing: 1, grounded: true, state: 'idle', t: 0, lastFrame: -1 });
  const keys = useRef(new Set<string>());
  const pressed = useRef(new Set<string>());
  const spawns = useRef<Spawn[]>([]);
  const dummyHit = useRef(0);
  const hits = useRef(0);
  const events = useRef<{ name: string; t: number }[]>([]);

  const reset = () => { actor.current = { x: 70, y: groundY, vx: 0, vy: 0, facing: 1, grounded: true, state: 'idle', t: 0, lastFrame: -1 }; spawns.current = []; hits.current = 0; };
  useEffect(reset, [hero?.id, W, H]); // eslint-disable-line react-hooks/exhaustive-deps

  // keyboard (only while playing)
  useEffect(() => {
    if (!running) return;
    const game = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'a', 'd', 'w', 'j', 'k', 'x', 'z', 'Shift'];
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, textarea, select')) return;
      if (e.key === 'Escape') { setRunning(false); return; }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (game.includes(k)) { e.preventDefault(); if (!keys.current.has(k)) pressed.current.add(k); keys.current.add(k); }
    };
    const up = (e: KeyboardEvent) => { keys.current.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); keys.current.clear(); };
  }, [running]);

  // the game loop: fixed 60 Hz steps, drawn at game resolution then scaled by an integer
  useEffect(() => {
    const c = canvas.current;
    if (!c || !hero || !heroImg) return;
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const g = off.getContext('2d')!;
    const out = c.getContext('2d')!;
    const animOf = (st: State) => {
      // a missing state borrows its closest sibling: walk <-> run, fall -> jump, then idle
      const name = s.map[st] ?? (st === 'run' ? s.map.walk : st === 'walk' ? s.map.run : st === 'fall' ? s.map.jump : undefined) ?? s.map.idle ?? hero.animations[0].name;
      return hero.animations.find(a => a.name === name) ?? hero.animations[0];
    };
    const frameMeta = (i: number) => hero.frameData?.[String(i)];
    const spawn = (id: string, x: number, y: number, facing: 1 | -1) => {
      const def = EFFECTS.find(e => e.id === id);
      if (!def) return;
      const anim = def.make({ size: Math.max(24, Math.round(style.unitHeight * 0.9)), colors: fxColors.slice(-3), direction: facing > 0 ? 'right' : 'left', seed: Math.floor(Math.random() * 1e6) });
      spawns.current.push({ anim, canvases: anim.frames.map(toCanvas), x, y, t: 0, facing });
    };
    const heroBox = (a: Actor, r: Rect, b: { x: number; y: number; w: number; h: number }) => {
      const fx = a.facing > 0 ? b.x : r.w - b.x - b.w;
      const left = a.facing > 0 ? a.x - hero.pivot.x : a.x - (r.w - 1 - hero.pivot.x);
      return { x: left + fx, y: a.y - hero.pivot.y + b.y, w: b.w, h: b.h };
    };
    const dummyRect = () => {
      if (!dummy) return null;
      const r = dummy.frames[dummy.animations[0]?.frames[0] ?? 0];
      const dx = actorDummyX(), meta = dummy.frameData?.[String(dummy.animations[0]?.frames[0] ?? 0)];
      const hb = meta?.hurtboxes?.[0];
      return hb ? { x: dx - dummy.pivot.x + hb.x, y: groundY - dummy.pivot.y + hb.y, w: hb.w, h: hb.h } : { x: dx - dummy.pivot.x + r.w * 0.2, y: groundY - dummy.pivot.y, w: r.w * 0.6, h: dummy.pivot.y + 1 };
    };
    const actorDummyX = () => 70 + Math.max(80, style.unitHeight * 3);
    const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

    let raf = 0, last = performance.now(), acc = 0;
    const step = (dt: number) => {
      const a = actor.current, k = keys.current, p = pressed.current;
      const pad = navigator.getGamepads?.()[0];
      const axis = pad ? pad.axes[0] : 0;
      const left = k.has('ArrowLeft') || k.has('a') || axis < -0.4, right = k.has('ArrowRight') || k.has('d') || axis > 0.4;
      const run = k.has('Shift') || !!pad?.buttons[5]?.pressed || !!pad?.buttons[1]?.pressed;
      const jumpPress = p.has(' ') || p.has('ArrowUp') || p.has('w') || (pad?.buttons[0]?.pressed && a.grounded && a.state !== 'jump');
      const attackPress = p.has('j') || p.has('k') || p.has('x') || p.has('z') || !!pad?.buttons[2]?.pressed;
      p.clear();
      const atk = animOf('attack');
      const attacking = a.state === 'attack' && a.t < atk.frames.length / atk.fps;
      if (attackPress && !attacking && s.map.attack) { a.state = 'attack'; a.t = 0; a.lastFrame = -1; if (s.effect !== 'none' && s.effect !== 'auto') spawn(s.effect, a.x + a.facing * style.unitHeight * 0.5, a.y - style.unitHeight * 0.55, a.facing); }
      // a character with a run but no walk runs whenever it moves
      const fast = run || (!s.map.walk && !!s.map.run);
      const speed = s.walk * (fast ? s.runMul : 1);
      const dir = (right ? 1 : 0) - (left ? 1 : 0);
      if (dir) a.facing = dir > 0 ? 1 : -1;
      a.vx = attacking && a.grounded ? 0 : dir * speed;
      if (jumpPress && a.grounded) { a.vy = -Math.sqrt(2 * s.gravity * s.jump); a.grounded = false; }
      a.vy += s.gravity * dt;
      a.x = Math.max(12, Math.min(worldW - 12, a.x + a.vx * dt));
      a.y += a.vy * dt;
      if (a.y >= groundY) {
        if (!a.grounded && a.vy > 180) spawn('dust', a.x, groundY, a.facing);
        a.y = groundY; a.vy = 0; a.grounded = true;
      }
      const next: State = a.state === 'attack' && a.t < atk.frames.length / atk.fps ? 'attack'
        : !a.grounded ? (a.vy < 0 ? 'jump' : 'fall')
          : dir ? (fast ? 'run' : 'walk') : 'idle';
      if (next !== a.state) { a.state = next; a.t = 0; a.lastFrame = -1; } else a.t += dt;
      for (const sp of spawns.current) sp.t += dt;
      spawns.current = spawns.current.filter(sp => sp.t < sp.anim.frames.length / sp.anim.fps);
      dummyHit.current = Math.max(0, dummyHit.current - dt);
    };

    const draw = () => {
      const a = actor.current;
      const cam = Math.max(0, Math.min(worldW - W, Math.round(a.x - W / 2)));
      g.imageSmoothingEnabled = false;
      g.drawImage(level.sky, 0, 0);
      g.drawImage(level.far, -Math.round(cam * 0.3), 0);
      g.drawImage(level.mid, -Math.round(cam * 0.6), 0);
      g.drawImage(level.ground, -cam, groundY);
      // dummy
      if (dummy && dummyImg) {
        const r = dummy.frames[dummy.animations[0]?.frames[0] ?? 0];
        const dx = actorDummyX() - cam;
        const shake = dummyHit.current > 0 ? Math.round(Math.sin(dummyHit.current * 90) * 1.5) : 0;
        if (dummyHit.current > 0.12 && dummyFlash) g.drawImage(dummyFlash, dx - dummy.pivot.x + shake, groundY - dummy.pivot.y);
        else g.drawImage(dummyImg, r.x, r.y, r.w, r.h, dx - dummy.pivot.x + shake, groundY - dummy.pivot.y, r.w, r.h);
        if (s.boxes) { const d = dummyRect()!; g.strokeStyle = 'rgba(80,200,255,.9)'; g.strokeRect(Math.round(d.x - cam) + 0.5, Math.round(d.y) + 0.5, Math.round(d.w) - 1, Math.round(d.h) - 1); }
      }
      // hero
      const anim = animOf(a.state);
      const loop = a.state === 'attack' || a.state === 'jump' || a.state === 'fall' ? false : anim.loop;
      let fi = Math.floor(a.t * anim.fps);
      fi = loop ? fi % anim.frames.length : Math.min(anim.frames.length - 1, fi);
      const sheetIndex = anim.frames[fi];
      const r = hero.frames[sheetIndex];
      if (fi !== a.lastFrame) {
        a.lastFrame = fi;
        const meta = frameMeta(sheetIndex);
        for (const ev of meta?.events ?? []) {
          events.current.push({ name: ev, t: performance.now() });
          if (ev.startsWith('spawn:')) spawn(ev.slice(6), a.x + a.facing * style.unitHeight * 0.5, a.y - style.unitHeight * 0.55, a.facing);
          if (ev === 'footstep' && a.grounded) spawn('dust', a.x - a.facing * 4, groundY, a.facing);
        }
        // hits: the frame's hitboxes against the dummy's body
        if (meta?.hitboxes?.length && dummy) {
          const d = dummyRect()!;
          const hit = meta.hitboxes.map(b => heroBox(a, r, b)).find(b => overlap(b, d));
          if (hit && dummyHit.current <= 0.05) { dummyHit.current = 0.28; hits.current++; spawn('spark', hit.x + hit.w / 2, hit.y + hit.h / 2, a.facing); }
        } else if (a.state === 'attack' && fi === Math.floor(anim.frames.length / 2) && dummy && s.effect === 'auto') {
          // no hitboxes drawn yet: a rough reach check so the dummy still reacts
          const d = dummyRect()!, reach = { x: a.facing > 0 ? a.x : a.x - style.unitHeight, y: a.y - style.unitHeight, w: style.unitHeight, h: style.unitHeight };
          if (overlap(reach, d)) { dummyHit.current = 0.28; hits.current++; spawn('spark', d.x + d.w / 2, a.y - style.unitHeight * 0.55, a.facing); }
        }
      }
      if (r) {
        const left = a.facing > 0 ? a.x - hero.pivot.x : a.x - (r.w - 1 - hero.pivot.x);
        const sx = Math.round(left - cam), sy = Math.round(a.y - hero.pivot.y);
        g.save();
        if (a.facing < 0) { g.translate(sx + r.w, sy); g.scale(-1, 1); g.drawImage(heroImg, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h); }
        else g.drawImage(heroImg, r.x, r.y, r.w, r.h, sx, sy, r.w, r.h);
        g.restore();
        if (s.boxes) {
          const meta = frameMeta(sheetIndex);
          g.strokeStyle = 'rgba(80,200,255,.9)';
          for (const b of meta?.hurtboxes ?? []) { const q = heroBox(a, r, b); g.strokeRect(Math.round(q.x - cam) + 0.5, Math.round(q.y) + 0.5, q.w - 1, q.h - 1); }
          g.strokeStyle = 'rgba(255,70,110,.95)';
          for (const b of meta?.hitboxes ?? []) { const q = heroBox(a, r, b); g.strokeRect(Math.round(q.x - cam) + 0.5, Math.round(q.y) + 0.5, q.w - 1, q.h - 1); }
          g.fillStyle = 'rgba(255,90,140,.9)'; g.fillRect(Math.round(a.x - cam), Math.round(a.y), 1, 1);
        }
      }
      // effects
      for (const sp of spawns.current) {
        const f = Math.min(sp.canvases.length - 1, Math.floor(sp.t * sp.anim.fps));
        const cv = sp.canvases[f];
        g.drawImage(cv, Math.round(sp.x - sp.anim.anchor.x - cam), Math.round(sp.y - sp.anim.anchor.y));
      }
      // scale up by an integer, centred
      const dpr = window.devicePixelRatio || 1;
      c.width = W * scale * dpr; c.height = H * scale * dpr;
      out.setTransform(dpr, 0, 0, dpr, 0, 0);
      out.imageSmoothingEnabled = false;
      out.drawImage(off, 0, 0, W * scale, H * scale);
      const now = performance.now();
      events.current = events.current.filter(e => now - e.t < 1200);
      return { anim: anim.name, fi, sheetIndex };
    };

    let hudT = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (running) { acc += dt; while (acc >= 1 / 60) { step(1 / 60); acc -= 1 / 60; } }
      const info = draw();
      hudT += dt;
      if (hudT > 0.1) { hudT = 0; setHud({ state: actor.current.state, anim: info.anim, frame: info.fi + 1, speed: Math.round(Math.abs(actor.current.vx)), hits: hits.current, events: events.current.map(e => e.name) }); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hero, heroImg, dummy, dummyImg, dummyFlash, s, running, W, H, scale, level, groundY, worldW, fxColors, style.unitHeight]);

  if (!chars.length) {
    return (
      <main className="playtest">
        <PageHeader icon="gamepad" title="Playtest" sub="Try your characters in a little level at real game size." />
        <div className="empty"><div className="empty-card"><Icon name="gamepad" size={28} /><h2>Nothing to play yet</h2><p>Import or animate a character first, then come back to run and jump with it.</p></div></div>
      </main>
    );
  }

  return (
    <main className="playtest">
      <aside className="pt-side">
        <PageHeader icon="gamepad" title="Playtest" sub="Your sprite at true game size. Feel the speed, the jump, the reach." />
        <label className="field"><span>Character</span>
          <select value={hero?.id ?? ''} onChange={e => { setHeroId(e.target.value); setRunning(false); }}>
            {chars.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <h3>Animations</h3>
        <div className="pt-map">
          {STATES.map(st => (
            <label key={st} className="pt-map-row"><span>{st}</span>
              <select className="compact" value={s.map[st] ?? ''} onChange={e => set({ map: { ...s.map, [st]: e.target.value || undefined } })}>
                <option value="">{st === 'run' ? '(walk, faster)' : st === 'walk' && s.map.run ? '(none: moving runs)' : st === 'fall' ? '(jump)' : st === 'idle' ? '(first)' : '—'}</option>
                {hero?.animations.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
              </select>
            </label>
          ))}
        </div>
        <div className="pt-head"><h3>Feel</h3><button className="ghost small" onClick={() => { const d = defaults(hero, style.unitHeight); set({ walk: d.walk, runMul: d.runMul, jump: d.jump, gravity: d.gravity, map: d.map }); }} title="Speeds sized to this character and animations matched by name">Reset to defaults</button></div>
        <label className="pt-slider"><span>Walk</span><input type="range" min={10} max={300} value={s.walk} onChange={e => set({ walk: +e.target.value })} /><span className="mono">{s.walk} px/s</span></label>
        <label className="pt-slider"><span>Run ×</span><input type="range" min={1} max={4} step={0.1} value={s.runMul} onChange={e => set({ runMul: +e.target.value })} /><span className="mono">{s.runMul.toFixed(1)}</span></label>
        <label className="pt-slider"><span>Jump</span><input type="range" min={8} max={240} value={s.jump} onChange={e => set({ jump: +e.target.value })} /><span className="mono">{s.jump} px</span></label>
        <label className="pt-slider"><span>Gravity</span><input type="range" min={200} max={3000} step={50} value={s.gravity} onChange={e => set({ gravity: +e.target.value })} /><span className="mono">{s.gravity}</span></label>
        <h3>Scene</h3>
        <label className="field"><span>Game resolution</span>
          <select value={s.res} onChange={e => set({ res: +e.target.value })}>
            {RESOLUTIONS.map(([w, h], i) => <option key={i} value={i}>{w}×{h}{i === 0 ? ' (classic)' : ''}</option>)}
          </select>
        </label>
        <label className="field"><span>Training dummy</span>
          <select value={s.dummy ?? ''} onChange={e => set({ dummy: e.target.value || null })}>
            <option value="">None</option>
            {chars.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Attack effect</span>
          <select value={s.effect} onChange={e => set({ effect: e.target.value })}>
            <option value="auto">From frame events</option><option value="none">None</option>
            {EFFECTS.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className="toggle block"><input type="checkbox" checked={s.boxes} onChange={e => set({ boxes: e.target.checked })} /> Show hitboxes and pivot</label>
        <label className="toggle block"><input type="checkbox" checked={s.crt} onChange={e => set({ crt: e.target.checked })} /> CRT screen</label>
      </aside>
      <section className="pt-stage" ref={wrap}>
        <div className="pt-screen" style={{ width: W * scale, height: H * scale }}>
          <canvas ref={canvas} style={{ width: W * scale, height: H * scale }} onClick={() => setRunning(true)} tabIndex={0} aria-label="Playtest" />
          {s.crt && <div className="pt-crt" aria-hidden />}
          {!running && (
            <button className="pt-start" onClick={() => setRunning(true)}>
              <Icon name="play" size={20} />
              <strong>Click to play</strong>
              <span><kbd>←</kbd><kbd>→</kbd> move · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump · <kbd>J</kbd> attack · <kbd>Esc</kbd> pause · gamepad works too</span>
            </button>
          )}
          <div className="pt-hud mono">
            <span>{hud.state}</span><span className="dim">{hud.anim} · f{hud.frame}</span><span className="dim">{hud.speed} px/s</span>
            {dummy && <span className="dim">hits {hud.hits}</span>}
            {hud.events.map((e, i) => <span key={i} className="pt-event">{e}</span>)}
          </div>
        </div>
        <p className="dim small pt-foot">{W}×{H} game pixels shown at {scale}× · 1 sprite pixel = 1 game pixel, exactly as in your game</p>
      </section>
    </main>
  );
}
