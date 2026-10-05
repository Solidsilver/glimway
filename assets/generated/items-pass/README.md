# Fingersnap Items art pass

Generated 2026-10-05 from the expanded art brief: 12 transparent source sheets and 170 measured frames. It covers inventory icons for tools, supplies, keepsakes, home goods, and papers, plus placed sprites for gathering, construction stages, and the Tolley Mill. Items already named as covered in the Commons pass point to their existing texture through explicit aliases.

## Files

- `manifest.json`: source images, unique measured `sourceRect` per sprite, exact native canvas size, placement rectangle, anchor, item ID, state label, and prompt description.
- `integration.js`: Phaser preload, item-state resolution, texture creation, and sprite placement helpers.
- `preview.html`: native-size viewer for the measured frames.
- `COVERAGE.md`: art request IDs mapped to frames, aliases, and omissions.
- `jobs.json`, `request-index.json`: source prompts and the original request metadata, including variant descriptions.
- `*.atlas.json`: irregular source-resolution atlas metadata; use exact rectangles rather than a fixed frame grid.

Source PNGs are not normalized spritesheets. Do not load them with `frameWidth`, resize or crop them in an editor, or use their sheet positions for collision. `createItemArt` draws each measured source rectangle into the specified native canvas with smoothing disabled. Keep state variants discrete; `manifest.stateGroups` is a selector list, never a looping animation. The Tolley Mill wheel and froth are the three authored looping animations.

For previously covered Commons art, the `commons:` alias uses a `commons-art:` runtime texture. Preload and create Commons textures first, then resolve these aliases. Tool-condition icons use explicit state labels such as `whole`, `worn`, `blunt`, and `cracked`. World collision, interaction cells, map placement, and depth ordering remain the game's authored data.

The wheel is authored as four frames per condition. The running waterwheel uses `mill-wheel`, and the repaired smooth wheel uses `mill-wheel-mended`. The native 32×32 images include the mounting context shown in the art, so the runtime agent should position the wheel beside the east wall with its lower edge at water level.
