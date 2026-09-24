# Kinetome

*A living book of moving sprites.* An AI-powered 2D pixel sprite studio: design characters with their lore, draw reference sprites with Gemini, and let Claude animate them with code, all locked to one project Style Bible, with clean exports to Godot 4.

```
npm install
npm run dev        # server :4317 + studio (Vite prints the URL)
npm test           # core tests
npm run typecheck
```

## Characters: the AI workflow (no drawing skills needed)

**Characters** tab, per character:

1. **Design:** lore, personality, build, outfit, signature details, and a color per part (hue-ring picker). Each color becomes a 3-shade hue-shifted pixel ramp; those exact hex values go into prompts and lock imports. **Write with Claude** turns the notes into a short visual brief (~1.5k tokens).
2. **Reference:** copy the prompt → paste into [Gemini](https://gemini.google.com/app) → download → **Import result**. It becomes the character in the library.
3. **Moves:** add a move (attack, walk, …), describe how *this* character does it, **Draft with Claude** (frame-by-frame key poses, ~2k tokens), edit or **Revise**, copy the prompt → Gemini with the reference attached → **Import result**. It merges into the character with the same palette, size and feet position.
4. **Draw with code** (alternative): Claude writes a palette-locked sprite program, the server renders it, Claude reviews the render and fixes it. Measured: ~45k output tokens / ~8 min for 2 animations (10 frames) with one review round. Best for simpler characters, enemies and effects; detailed heroes look better via Gemini.

Claude runs through the Claude Code CLI in headless mode on your subscription (no API key). Every call is locked down: replaced system prompt, no tools (Read only when reviewing a render), no MCP, no settings, structured output. Usage is logged per project (`workspace/<project>/claude-usage.jsonl`) and shown in the top bar.

The importer copes with what generators do anyway: fake checkerboard "transparency", white backdrops, text labels and watermarks, uneven spacing, poses drawn at different sizes, JPEG noise. Every import shows a quality score and flags suspicious frames.

## Player shortcuts

Space play/pause · ←/→ step · Home first frame · [ / ] previous/next animation · + / − / 0 zoom · O onion skin · G grid · P pivot · ? help. Speed ¼×–2×, loop / ping-pong / once, scrubber, custom background.

## Pixelize: images, GIFs, video → animated pixel sprites

Drop any of these on the studio (or use **Import…**):

| Input | What happens |
|---|---|
| JPG / PNG / WebP illustration | Background removed, downscaled to your unit height, shared palette, cleanup, optional outline. Then pick an idle motion (breathe, hover, squash) or a hurt effect |
| "Fake" pixel art (AI output, upscaled screenshots) | The hidden pixel grid is detected (non-integer scales, blur and JPEG noise are handled) and the true pixels are rebuilt |
| Animated GIF / WebP / APNG | All frames decoded; background, crop, anchor and palette are decided once for **all** frames, so nothing jitters or flickers |
| MP4 / WebM / MOV | Sampled at 12 fps; **Find loop** suggests seamless cycles |
| Several numbered PNGs | Treated as a frame sequence |

Frames are anchored on the feet by default, which turns a character walking across a clip into a walk-in-place cycle. Everything runs in the browser in a worker; no uploads, no AI calls, no tokens.
For full moves (walk, attack) from a single still: turn it into a short clip with any image-to-video tool, then drop the clip here.
Try it with `samples/pixelize/`.

## Using sprites in Godot 4

1. In the studio, pick an asset and click **Download .zip** (or **Export all → Godot** in the top bar).
2. Unzip into your Godot project root. Files land in `res://sprites/<asset>/`:
   - `<asset>.png`: the sheet
   - `<asset>.tres`: a `SpriteFrames` resource with every animation (fps and loop included)
   - `<asset>.tscn`: a ready `AnimatedSprite2D` (nearest filtering, autoplays idle, **feet on the node origin**)
3. Instance the `.tscn` in your player scene, or assign the `.tres` to your own `AnimatedSprite2D`, then call `play("run")` etc.

If the studio runs on the same machine as the Godot project, set the project folder under **Style Bible → Godot export**. **Sync** then writes the files straight in, and Godot re-imports when you switch back to it.

## Layout

- `packages/pixel`: the pixelize pipeline (background removal, grid detection, downscale, shared palette, anchoring, cleanup, outline, loop finder, idle motions).
- `packages/core`: canonical sprite format (zod), importers (Aseprite, TexturePacker/Phaser, row-based, native), slicing (grid, auto-detect islands), palette tools (Oklab snap, alpha harden, mode-pool downscale), and the style linter.
- `apps/server`: Hono API. Projects are plain folders under `workspace/` (`project.json`, `style.json`, `assets/<id>/asset.json + sheet.png`).
- `apps/studio`: React UI. Library (viewer, timeline, onion skin, inspector, style check + fixes), Lineup (whole cast on one baseline), Style Bible editor.
- `samples/`: the code-drawn wizard (reference asset) and `offstyle-wizard.png`, a deliberately broken import for testing the style fixes.
- `spikes/wizard`: the procedural wizard renderer that produced the sample sheet.
- `docs/PLAN.md`: vision and roadmap. `docs/FUTURE.md`: top-down, isometric and 2.5D notes.

## Consistency model

1. **Style Bible** per project: locked palette, unit height (pixel density), outline, light, perspective, notes.
2. **Style check** on every asset: off-palette pixels, semi-transparency, color budget, scale vs unit, baseline jitter; one-click fixes.
3. **Lineup**: every sprite at the same scale on a shared baseline.
4. **References**: approved assets are flagged and will be fed to generators.
