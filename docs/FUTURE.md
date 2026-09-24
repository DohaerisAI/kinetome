# Future: top-down, 3/4 and 2.5D

Side-view platformers come first. This doc records what top-down, three-quarter, isometric and 2.5D will need, so nothing built now has to be torn up later.

## Rules for today's code (so we don't paint ourselves into a corner)

- `StyleBible.perspective` already includes `three-quarter`, `top-down` and `isometric`. Keep every generator and lint rule perspective-aware and never hardcode "side view".
- Directions will be an **optional** field on `Animation` (`direction?: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'`). Adding it later is additive: existing side-view assets simply omit it (treated as `e`, flippable to `w`).
- The pivot stays "feet on the ground plane". It already means the right thing for y-sorting in top-down.
- Recipes (code, rig, 3D) must take a `view`/`direction` parameter from day one, even if side-view only ever passes `e`.

## Directions

- **4-dir** (S, E, N, W) for classic RPGs; **8-dir** for action games.
- **Mirroring:** generate S, SE, E, NE, N and mirror the west side, unless the character DNA marks it `asymmetric` (sword in the right hand, eye patch, side-parted hair), in which case all 8 are produced.
- **Naming in Godot:** `walk_s`, `walk_se`, … plus a small helper script that picks the animation from a velocity vector (the angle snapped to 4 or 8 sectors).
- **New lint rules:** the same palette and content height across directions; silhouette continuity between neighbouring directions (S→SE→E shouldn't pop); consistent pivot across directions.

## Generation routes by perspective

| Route | Top-down / 3/4 | Isometric | Notes |
|---|---|---|---|
| **3D proxy → pixel** | ★ best | ★ best | Render a glTF (or a Claude-built blockout) orthographically from 8 angles, toon-shade, pixelize with the Bible. Perfect direction consistency by construction |
| **Rig with per-view part sets** | good | ok | Front/side/back part art per character; the rig swaps sets by direction. Motion curves are shared |
| **Code-drawn with a view param** | good for simple sprites | hard | Fine for slimes, props, projectiles |
| **Image model** | risky | risky | Direction consistency is its weakest point; gate heavily against the S reference |

## Tiles and world

- **Top-down autotiles:** 47-tile blob and Wang 2-corner/2-edge sets, exported as a Godot `TileSet` with **terrain peering bits** already configured, so painting terrain just works.
- **Isometric:** 2:1 diamond tiles, height levels, wall/floor/edge variants; Godot TileSet with isometric tile shape and y-sort.
- **Seam lint:** tile edges must match across every adjacency rule.
- **Props:** a base footprint plus a y-sort origin, with collision polygons derived from the footprint.
- **Shadows** as a separate blob-shadow sprite, not baked in, so they stay on the ground when characters jump.

## 2.5D (HD-2D style)

- Pixel sprites inside 3D scenes (the Octopath look): export `AnimatedSprite3D` scenes with `billboard` mode, nearest filtering, and `pixel_size` derived from the Bible's unit height so every character is the same world size.
- **Auto normal maps** generated from sprites (height from shading ramps plus an edge bevel). They work in Godot 2D too, through `CanvasTexture`, so dynamic lights hit pixel art. This is worth pulling forward even for the platformer.
- Depth offsets per part for parallax-ish layering.

## Godot export additions

- `CharacterBody2D` template for top-down (8-way movement + animation picker) alongside the platformer template.
- `TileSet` resources (terrain sets, isometric shapes, per-tile collision).
- `AnimatedSprite3D` / `Sprite3D` scenes for 2.5D.
- Y-sort-ready scenes (`y_sort_enabled`, origin at the feet).

## Open questions for later

- Should an 8-dir character be one asset with directional animations, or one asset per direction? (Leaning towards one asset with a `direction` field, since the lineup and lint stay per-character.)
- A camera-angle parameter for 3/4 (how much top vs front is visible) in the Style Bible.
