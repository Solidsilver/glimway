# Fingersnap Commons and Wilds art pass

Delivered 2026-10-05 from `docs/art-requests.md`: 21 transparent source PNG sheets, 173 named frames and 11 looping animation definitions. Includes all priorities and the optional Hazel, Ada, and Wilds sets. Original artwork generated with the built-in image generation tool; prompts are in `jobs.json` and `portrait-job.json`. No Habitica artwork was copied into this pack.

## Start here

- `manifest.json`: exact native dimensions, individually measured `sourceRect`, native `destinationRect`, origin, animation membership, aliases, and source image paths.
- `integration.js`: Phaser preload, native canvas creation, and placement helpers.
- `preview.html`: native-size frame and animation gallery. Serve this directory locally; opening it directly as a file may block JSON loading.
- `COVERAGE.md`: requested art mapped to sheet and frame keys.
- `*.atlas.json`: source-resolution atlases for tools that accept irregular rectangles. These alone do not normalize frames to game sizes.

Source PNGs are high-resolution irregular atlases. Do **not** use `frameWidth`, a fixed grid, CSS scaling of a whole sheet, or source-resolution sprite dimensions in physics. Use the measured rectangles and render into the supplied native slots with nearest-neighbour filtering. Preserve source PNG bytes and alpha; transparent pixels can contain backdrop RGB.

## Phaser integration

Load the manifest before preload, then use:

```js
preloadCommonsArt(scene, manifest);
// After the scene's loader finishes:
const artKeys = createCommonsArt(scene, manifest);
const silas = placeCommonsArt(scene, manifest, 'silas', x, y);
silas.play('commons-art:silas-breathing');
const cottage = placeCommonsArt(scene, manifest, 'cottage', cottageX, cottageY);
```

The helper creates namespaced textures such as `commons-art:wooden-stool`. `artKeys['wooden-stool']` returns that key; `artKeys.silas` resolves the initial idle frame. This lets the runtime agent switch existing call sites explicitly while retaining fallbacks. It does not replace live scene textures or modify game code automatically. Keep existing authored collision bodies, interaction zones, depth rules, and state transitions.

All standing sprites and props use their manifest origin. Resident pairs share one scale and a bottom-centre foot baseline. Resource and echo variants retain common scale within each pair. Portraits are 64×64 dialogue slots. The resting warden is `guardian-settled`, separate from defeat.

Cottage frames share scale so the workshop version does not enlarge its base house. `cottage-workshop` is a complete tier-2 visual; `workshop-addon` is an independent lean-to for layering and may need a scene-specific attachment offset. Do not stack the complete tier-2 house on top of tier 1. The fireplace flames are separate from the empty interior fireplace, with four frames; campsite composites have three frames, and small flames are separately available.

## Tile and effect placement

Path directions indicate the material-filled side or the direction an end connects: `edge-n` has material on its north half; `corner-ne` occupies the northeast quarter; `end-n` connects toward north. These are transparent overlays over existing grass, not complete terrain tiles. The frame's `destinationRect` intentionally places its crop within a 16×16 slot. Choose neighbors through the game's terrain mapping; joins with the older expansion texture need visual tuning in the actual map.

For the plank floor, use alternating `flipX`/`flipY` orientations in a 2×2 arrangement (`floorTileOrientation(column,row)`) when exact repeated edge matching matters. Hedge/fence pieces are modular art, but endpoint alignment and rotation are scene decisions. Ember/light overlays keep their generated alpha; use the existing game light system for stronger atmospheric glow.

## Validation and limits

Verified RGBA transparency, frame bounds, destination bounds, native slot sizes, animation references, source checksums, and the local browser gallery. See `validation.json`. This is an art handoff; scene wiring and in-game terrain adjacency were not changed or tested here. Small canon details are readable on source sheets and portraits but inevitably simplify at 16px. The generated sheets are editable source material for future pixel-level polish.
