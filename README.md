# Sprite Studio

AI-backed 2D pixel sprite engine: import, inspect, and generate sprites that all obey one project Style Bible.

```
npm install
npm run dev        # server :4317 + studio (Vite prints the URL)
npm test           # core tests
npm run typecheck
```

## Layout

- `packages/core`: canonical sprite format (zod), importers (Aseprite, TexturePacker/Phaser, row-based, native), slicing (grid, auto-detect islands), palette tools (Oklab snap, alpha harden, mode-pool downscale), and the style linter.
- `apps/server`: Hono API. Projects are plain folders under `workspace/` (`project.json`, `style.json`, `assets/<id>/asset.json + sheet.png`).
- `apps/studio`: React UI. Library (viewer, timeline, onion skin, inspector, style check + fixes), Lineup (whole cast on one baseline), Style Bible editor.
- `samples/`: the code-drawn wizard (reference asset) and `offstyle-wizard.png`, a deliberately broken import for testing the style fixes.
- `spikes/wizard`: the procedural wizard renderer that produced the sample sheet.

## Consistency model

1. **Style Bible** per project: locked palette, unit height (pixel density), outline, light, perspective, notes.
2. **Style check** on every asset: off-palette pixels, semi-transparency, color budget, scale vs unit, baseline jitter; one-click fixes.
3. **Lineup**: every sprite at the same scale on a shared baseline.
4. **References**: approved assets are flagged and will be fed to generators.
