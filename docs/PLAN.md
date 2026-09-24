# Sprite Studio — The Plan

> One sentence: **a consistency compiler for game art.** You describe a world once, and every sprite in the project — generated, imported, recorded, or drawn — compiles into that world's style, animated, sliced, hitboxed, and dropped straight into your game.

Status: foundation done (canonical format, importers, style linter, lineup, Style Bible) plus Godot export (zip + folder sync). This doc is the road from here to the big vision.

---

## 0. Decisions (2026-09-24)

| Topic | Decision | Consequence |
|---|---|---|
| Engine | **Godot 4 first** (the user's game is in Godot) | Godot exporter pulled forward and already built: SpriteFrames `.tres` + a ready `AnimatedSprite2D` `.tscn` (nearest filter, feet on the origin), zip download or direct sync into the Godot project folder |
| Perspective | **Side-view platformer first** | Platformer moveset, hitboxes and a `CharacterBody2D` template come first. Top-down, 3/4, isometric and 2.5D are recorded in [FUTURE.md](FUTURE.md) with rules that keep today's code compatible |
| Claude access | **The user's Claude subscription**, not an API key | See §0.1. The Agent SDK is API-key only, so we drive Claude Code itself |
| GPU | None on the dev machine; RTX 3050 laptop (4 GB) elsewhere | See §0.2. Nothing core depends on a local GPU |

### 0.1 Using the subscription: Claude Code is the brain

Claude Code headless mode (`claude -p`) runs on the subscription login; the Agent SDK does not. So the architecture inverts: **the studio exposes tools, and Claude Code calls them.**

```
 ┌──────────────── Claude Code (your subscription) ───────────────┐
 │  interactive in a terminal / in your Godot repo   OR           │
 │  headless `claude -p` spawned by the studio's Generate button  │
 └───────────────┬────────────────────────────────────────────────┘
                 │ MCP (stdio)
 ┌───────────────▼────────────────────────────────────────────────┐
 │  apps/mcp  → studio server                                     │
 │  get_style_bible · list_assets · view_asset (PNG path to Read) │
 │  render_sprite_program(code) → frames + lint report            │
 │  save_asset · pixelize(image) · export_godot / sync_godot      │
 └────────────────────────────────────────────────────────────────┘
```

- **Mode A: conversational.** You chat with Claude Code (optionally inside your Godot project). It reads the Bible, writes sprite programs, renders them, looks at the PNGs (vision via the Read tool), fixes defects, saves, and syncs to Godot.
- **Mode B: the Generate button.** The studio server spawns `claude -p --output-format stream-json --mcp-config … --allowedTools …` and streams progress into the UI. The same tools, just with a button instead of a chat.
- **Caveats:**
  - The server must strip `ANTHROPIC_API_KEY` from the child environment, otherwise it overrides the subscription.
  - Never pass `--bare`, which disables subscription auth.
  - Headless calls count against the same 5-hour and weekly limits as interactive use, so keep prompts tight and renders small.
- **What the subscription does not cover:** image and video generation (Claude doesn't make images). The **code-drawn** and **rig** routes need nothing but the subscription, so they become the main engine. Image and video providers (Phase 4) are optional add-ons with their own cost, decided by the provider spike.

### 0.2 GPU reality check (RTX 3050 laptop, 4 GB VRAM)

| Workload | On 4 GB? |
|---|---|
| Background removal, segmentation (small models), MediaPipe pose | ✅ Easily; most of these also run in the browser via WebGPU/WASM on any laptop |
| Pixelize pipeline, rig renderer, code-drawn sprites | ✅ CPU only |
| SD 1.5 + a pixel-art LoRA at 512px | ⚠️ Works, a few seconds per image |
| SDXL | ⚠️ Only with heavy CPU offload; roughly 1–2 min per image |
| Flux | ❌ Practically no (quantized + offload is very slow) |
| Training a per-project LoRA | ⚠️ SD 1.5 barely; SDXL/Flux no |
| Video models | ❌ They need 12–24 GB or more |

Conclusion: design for **no GPU**. Heavy ML runs in the browser (small ONNX models) or through hosted APIs. The 3050 laptop can later act as an optional **LAN worker** running ComfyUI + SD 1.5 for cheap local drafts.

---

## 1. The core ideas (what makes this different)

Tools already exist in pieces: Aseprite (manual pixel editing), PixelLab and Retro Diffusion (AI pixel generation), Scenario (style-trained image models), Spine (skeletal animation). None of them own the whole loop, and none of them treat consistency as a hard guarantee. Six ideas set this apart:

### 1.1 Sprites are recipes, not pictures
Every asset stores **how it was made** (`asset.recipe`): the code that draws it, the rig + motion that animates it, or the source file + pixelize settings that imported it. Pixels are a build artifact.
Consequence: change the Style Bible (new palette, 32px → 48px density, winter biome) and **re-render the whole game**. Nobody else can do this.

### 1.2 The Style Bible is law, enforced by code
The model is never trusted to "remember" the style. Palette, density, outline, light, and materials are checked mechanically on every asset (already built: style check + Lineup). Generators get the Bible as input; the linter rejects what drifts; fixes are deterministic.

### 1.3 Materials, not colors
The palette is organised into **ramps** (skin, cloth-purple, metal, foliage, magic), each dark→light. Sprites reference `material + shade index`, not hex values. That gives:
- one-click recolors, team colors, enemy variants (fire slime / ice slime);
- day/night and biome palette swaps across the entire project;
- a lint rule that shading actually follows the light direction (shade index should rise toward the light).

### 1.4 Characters have DNA
A structured spec per character: silhouette, proportions (heads tall), part list, material map, signature features ("left-eye scar, red scarf, always"). Every generator, every animation, and every variant reads the DNA. **Breeding**: mutate DNA to make families (slime → king slime → slime mage) that belong together.

### 1.5 Motion is data, separate from art
Animations are motion curves on a skeleton (walk, run, jump, attack, hurt, die, cast), **retargetable to any rigged character**. Generate a walk once and every humanoid in the project can walk. Animation principles become buttons: *add anticipation, add a smear frame, more weight, snappier timing, add hit-stop.*

### 1.6 An agentic art director, not a prompt box
Claude plays director and critic: turns your intent into specs, drives the generators, **looks at every render** (vision), lists concrete defects ("frame 5: staff hand detaches; frame 7: hat 1px taller"), gets them fixed, and only shows you candidates that pass the style gates. It also learns **your taste**: picks and rejections are stored per project and fed back.

---

## 2. "How do I put in stuff from elsewhere and get animated sprites?"

This is the ingest system. **Anything in → on-style animated sprite out.** Six input types, one output format.

```
                       ┌──────────────── INPUTS ─────────────────┐
  sprite sheet ──┐     │ static image  (concept art, photo, AI   │
  GIF / APNG ────┤     │               illustration, screenshot) │
  video / MP4 ───┤     │ you on webcam (act out the move)        │
  3D model+anim ─┤     │ text description                        │
  static image ──┤     └─────────────────────────────────────────┘
  webcam ────────┤
  text ──────────┘
          │
          ▼
  ┌───────────────┐   ┌───────────────┐   ┌────────────────┐   ┌──────────────┐
  │  1. EXTRACT   │ → │  2. ANIMATE   │ → │  3. PIXELIZE   │ → │  4. GATE     │
  │ bg removal,   │   │ (if static)   │   │ ALL frames     │   │ style check, │
  │ segmentation, │   │ rig+motion /  │   │ together:      │   │ Claude       │
  │ frame decode, │   │ video model / │   │ shared crop,   │   │ critic,      │
  │ pose extract  │   │ code-drawn /  │   │ shared palette,│   │ lineup,      │
  │               │   │ per-frame gen │   │ unit height,   │   │ your pick    │
  └───────────────┘   └───────────────┘   │ outline rules  │   └──────────────┘
                                          └────────────────┘          │
                                                                      ▼
                                                    canonical asset + recipe → game
```

### 2.1 Sprite sheets & asset packs → *Restyle*  (partly done)
Import works today (Aseprite, TexturePacker/Phaser, grid, auto-detect). Next: **Restyle** a downloaded pack into your Bible: palette remap via material ramps (not just nearest-color), density conversion, outline normalization (add/remove/recolor outlines to match your rule), orphan-pixel cleanup.

### 2.2 GIF / APNG / animated WebP / MP4 → sprite animation
Decode in the browser (`ImageDecoder` for GIF/WebP, `<video>` + WebCodecs for MP4). Then:
- **Loop finder**: finds the best loop points by frame similarity, so a 3s clip becomes a seamless 8-frame cycle.
- **Stabilizer**: aligns every frame on the feet/pivot, which removes camera drift.
- **Frame picker**: picks the N most distinct key poses for a target frame count (e.g. an 8-frame walk).
- **Batch pixelize** with one shared crop and palette. That's the insight from @yonsan434343's tool: per-frame conversion jitters, batch conversion doesn't.

### 2.3 Any static image → animated character  (the big one)
Four routes; the studio picks one automatically, and you can override it:

| Route | How | Best for |
|---|---|---|
| **A. Auto-rig** | Pixelize → Claude vision + a segmentation model split it into parts (head, torso, arms, legs, weapon) → inpaint hidden areas (the arm behind the body) → propose joints → you adjust in the rig editor → apply the motion library | Humanoids and creatures that need many animations |
| **B. Video model** | Image-to-video ("walks in place, side view, flat background") → route 2.2 | Fluid, organic motion; capes, hair, effects |
| **C. Code-drawn clone** | Claude studies the image and writes a parametric sprite program that reproduces it (like the wizard) | Simple or iconic sprites; perfect consistency |
| **D. Reference frames** | Image model makes keyframes conditioned on the character sheet + pose guides, then cleanup | Unusual or complex poses |

### 2.4 Act it out → animation  (new; nobody does this for pixel art)
Record yourself on webcam or phone doing the move (sword swing, kick, victory dance). Pose tracking (MediaPipe, runs in the browser) → skeleton motion → retarget onto your character's rig → render at pixel resolution with pixel-art timing: hold frames, snap to 8–12 fps, exaggeration pass.
*You perform it once; your knight, your goblin, and your skeleton all get the move.*

### 2.5 3D models → pixel sprites
Load a glTF (or any rigged model plus Mixamo-style animations), render orthographically in Three.js from 4 or 8 directions with toon shading, then pixelize with the Bible. This is the classic Dead Cells technique, and it unlocks huge free animation libraries and perfect 8-direction consistency for top-down games.

### 2.6 Text → sprite
"A goblin archer, cowardly, oversized ears, 6-frame idle + 8-frame shoot." Claude expands this into DNA, picks a route (code-drawn / rig / image), generates 3 candidates, gates them, and shows you the survivors.

---

## 3. Creative features (the "nobody has made this" list)

1. **Style Proof Sheet.** Drop 3–5 screenshots of games you love. Claude extracts palette, density, outline, and shading rules, proposes a Style Bible, and renders a standard test set in it (a humanoid, a slime, a tree, a chest, a floor tile, a UI button). You approve the sheet and the project style is locked. This is the onboarding flow.
2. **Language edits across all frames.** "Make his hat red," "give her a scar," "longer beard." Edits go to the material map or DNA, so they apply to every frame of every animation at once, consistently. Hand-edit one frame and the studio suggests propagating it to the rest.
3. **Breeding & variants.** Generate an enemy family from one DNA: elemental variants via material swaps, tiers (small/big/boss) via proportion mutation, equipment variants via paper-doll layers.
4. **Paper-doll equipment.** Helmets, weapons, and armor as separate layers attached to rig points. Any combination renders correctly in every animation. RPG gear becomes free.
5. **Game-aware sprites.** Hitboxes and hurtboxes derived per frame automatically (the sword part is a hitbox during active frames), plus animation events (footstep on frames 2/6, spawn projectile on frame 4) and root motion. Exported with the sheet.
6. **Playground.** Test a character in context inside the studio: a mini platformer or top-down sandbox with an input state machine (idle→run→jump→attack), your tiles as background, adjustable zoom. You feel the animation before it reaches the game.
7. **Readability suite.** Silhouette test (fill black: is it still readable?), contrast against your actual background tiles, 1× thumbnail test, colorblind simulation, and a motion-clarity check that the attack reads within 3 frames.
8. **Sprite time machine.** Every asset is versioned with visual diffs (flip, onion, pixel diff). Because assets are recipes, you can fork a character or roll back an animation.
9. **World pieces.** Autotiling tilesets (the 47-tile blob and Wang sets, seam lint), prop families, VFX (code-driven particle effects rendered to sheets: slashes, explosions, spells), 9-slice UI kits, and **pixel fonts** generated in your style. Dialogue portraits at higher resolution from the same DNA.
10. **Whole-project transforms.** Winter version, night palette, "make everything 48px," "GBA-style 4-shade mode." Re-render from recipes; ramps remap raster assets.
11. **Taste memory.** Your approvals and rejections become project rules ("prefers chunky outlines," "rejects dithering on faces") that feed every future generation.

---

## 4. Architecture evolution

```
packages/
  core/        format, schemas, importers, lint           ← exists
  pixel/       pixelize pipeline: grid detect, downscale, palette/ramp mapping,
               outline normalize, orphan cleanup, batch-shared crop+palette
               (port the relevant parts of PixelRefiner, MIT)
  rig/         skeleton + parts + attachment points, pixel-clean renderer
               (nearest-neighbor + RotSprite-style rotation), motion curves,
               retargeting, animation-principle modifiers
  gen/         provider adapters + agent loops (director, critic, fixer)
  motion/      pose extraction (MediaPipe), video decode, loop finder, stabilizer
  exporters/   Godot, Unity, Phaser, Aseprite, Defold, GameMaker, generic JSON
apps/
  server/      API + job queue (long generations) + SSE progress + content-hash cache
  studio/      the interface                            ← exists
  cli/         `sprite build`, `sprite gen "…"`, `sprite export godot`
  mcp/         MCP server so Claude Code can request sprites while you code the game
```

**Provider adapters** (swappable; model quality changes every few months):
- **LLM / director / critic:** Claude (via API) for specs, sprite programs, motion scripting, and vision critique.
- **Image:** whichever image model tests best in our spike (hosted API, or local ComfyUI/Flux with a per-project LoRA later).
- **Video:** image-to-video providers behind one interface.
- **Vision utilities:** background removal and segmentation (hosted or local ONNX via transformers.js in the browser).

**Every model call is cached by content hash** and costed; the studio shows a spend meter per project. Retries and variants are cheap to re-view.

**The sprite program sandbox** (used for code-drawn sprites): Claude writes JS against a tiny pixel API (`px`, `rect`, `line`, `ramp(material, shade)`, `mirror`, `part()`, pose params). It runs in a Web Worker with no network or DOM access. Output: frames plus a recipe. The wizard proved this works; the API makes it palette-safe by construction.

---

## 5. Roadmap

Each phase ships something usable on its own.

### Phase 1: Ingest anything (≈2 weeks)
- Pixelize pipeline: any PNG/JPG/WebP, clipboard paste, drag from browser → bg removal → auto-crop → downscale to unit height → palette/ramp snap (optional ordered dithering) → outline normalize → orphan cleanup.
- Animated input: GIF/APNG/WebP/MP4 decode, loop finder, stabilizer, frame picker, **batch-shared** crop and palette.
- Restyle for imported packs.
- Pixel editor basics: pencil/eraser/picker restricted to the palette, per-frame undo, onion skin (edits land as a new asset version).
- **Done when:** a random GIF of a character from the internet becomes an on-style, looping, correctly pivoted sprite in under a minute.

### Phase 2: Claude as art director (≈2–3 weeks)
- Material ramps in the Style Bible (with auto-grouping of an existing palette into ramps).
- Character DNA schema + editor.
- Generate panel: text → DNA → sprite program (sandbox) → render → lint → **vision critique loop** (N rounds) → 3 candidates → pick.
- Style Proof Sheet onboarding.
- Language edits ("make the hat red") via DNA/material changes.
- Job queue + SSE progress + cache + spend meter.
- **Done when:** "goblin archer, idle + shoot" produces an on-style animated goblin that passes the lineup next to the wizard, with no hand-editing.

### Phase 3: Rig & Motion engine (≈4 weeks, the moat)
- Rig model: parts, joints, attachment points, draw order per frame.
- Pixel-clean rig renderer (RotSprite-style rotation, sub-pixel-free placement, frame-rate snapping).
- Auto-rig from a static sprite (Claude vision proposes parts/joints; segmentation refines; inpaint occluded areas), plus a rig editor to adjust.
- Motion library: idle, walk, run, jump (up/fall/land), attack ×3, hurt, die, cast. Retargeting across proportions.
- Animation-principle modifiers (anticipation, smear, weight, timing presets).
- Paper-doll equipment layers. Auto hitboxes/hurtboxes + events.
- 4/8-direction output for top-down.
- **Done when:** one static character image becomes a full moveset (8+ animations) that stays consistent and on-model.

### Phase 4: Model-powered pipelines (≈3 weeks)
- Image-model route: character turnaround sheet → keyframes with references → cleanup + gating (palette, silhouette overlap vs reference, embedding similarity).
- Video-model route: image-to-video → Phase 1 animated ingest.
- **Act it out:** webcam or phone video → MediaPipe pose → retarget to rig.
- 3D → pixel: glTF + animations, 4/8 directions, toon shading, pixelize.
- **Done when:** you can film yourself doing a kick and your character does that kick in-game.

### Phase 5: Game integration (≈2 weeks)
- ✅ Godot basics (pulled forward): SpriteFrames `.tres`, `AnimatedSprite2D` `.tscn`, zip download, direct folder sync.
- Godot next: a platformer `CharacterBody2D` template (collision capsule sized from the idle bounding box), `AnimationPlayer` with per-frame hitbox/hurtbox `CollisionShape2D` tracks and method tracks for events (footsteps, spawn projectile), and an editor plugin for one-click re-sync.
- Other exporters later: Unity, Phaser, Aseprite, generic JSON.
- `sprites.yaml` manifest in the game repo + `sprite build` CLI (missing assets are generated or get placeholders).
- **MCP server:** Claude Code in your game repo can call `generate_sprite`, `animate`, `export` directly.
- Live link: hot reload into a running game. Playground sandbox in the studio.
- **Done when:** while coding a game you say "add a bat enemy with a swoop attack," and it appears in-game, animated and on-style.

### Phase 6: World building (ongoing)
Tilesets with autotile rules and seam lint, props, VFX generator, UI kits, pixel fonts, portraits, whole-project transforms (biomes, day/night, density change), taste memory, breeding/variants.

---

## 6. Honest risks

| Risk | Mitigation |
|---|---|
| Image/video models drift across frames | They never write final pixels unchecked: batch pixelize + style gates + critic loop; rig route for anything needing many animations |
| Auto-rigging messy art is hard | Human-in-the-loop rig editor; Claude proposes, you adjust in seconds; code-drawn fallback |
| Pixel-clean rotation looks mushy | RotSprite-style upscale-rotate-downscale, limited angle sets, hand-drawn override frames |
| Cost of model calls | Content-hash caching, cheap previews first, code/rig routes are free after creation |
| Licensing of imported art and of model outputs | Track provenance per asset (`source`, origin URL, license field); restyle ≠ right to use; check provider terms |
| Scope explosion | Each phase ships standalone; ingest + director alone are already a better tool than exists for solo devs |

---

## 7. Next steps (concrete, in order)

1. **MCP server + sprite program sandbox** (`apps/mcp`, the sandbox runtime). This unlocks generation on the subscription right away: Claude Code can draw, render, check and save sprites into the studio.
2. **Platformer moveset spec:** idle, run, jump-up, apex, fall, land, dash, attack, hurt, die, as a standard template generators fill in.
3. **Pixelize pipeline** in `packages/pixel` (port PixelRefiner's grid detection + AA removal; add the batch-shared mode).
4. **Animated ingest:** GIF/WebP via `ImageDecoder`, MP4 via `<video>`; loop finder + stabilizer.
5. **Material ramps** in the Style Bible + auto-ramp grouping.
6. **Godot platformer template:** a `CharacterBody2D` scene + hitbox tracks.
7. The image/video provider spike stays on hold until the subscription-only routes are strong.
