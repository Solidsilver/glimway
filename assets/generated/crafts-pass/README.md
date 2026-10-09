# 0.5 Crafts art pass

Generated on 2026-10-09 with the built-in image generation tool from the request in `docs/art-request-crafts.md`. The pass contains 64 normalized transparent frames in `frames/`, seven preserved source sheets in `sheets/`, exact-size frame metadata in `manifest.json`, and source rectangles in `atlas.json`. `prompts.json` records the generation prompts and source image IDs. No game files were wired or changed.

All frame canvases use 64 texels per 16 px world tile. `build_pass.py` removes edge-connected neutral checker pixels, finds effect frames from connected-alpha bounds, and centers them on exact canvases with a consistent anchor. The Ward-light redraw also clears neutral checker grey trapped inside its open ring; warm pale Kindle pixels remain intact. Stable backs preserve the source silhouette and fill stall interiors behind the removable doors; front layers carry the half doors, posts and stone feet. Every frame records its source crop, exact canvas, and foot/hand anchor.

## Contents

- 20 ability icons, grouped into four class palette families; the manifest marks the eight 0.5 abilities.
- Stand's four ground-ring frames, Kindle's four hollow-light frames, and Ward-light's base plus three pulse frames.
- Stable west end, repeatable bay, and east cap from one continuous-building source; backs and front door/post layers have exact-size canvases and documented 4×3 or 2×3 footprints.
- Fishing rod icon and two held states, six float frames, three water-ring frames, four landing splashes, mill roach, Miller's fry, and recipe-card icons.
- Companions, saddle and go-home HUD icons, plus three rising pet-heart frames.
- Echo, lead rope, yard-pet nap z, and placement ghost are code-drawn and have no art files.

## Fit and review notes

The mount fit uses the same measure documented in `docs/art-request-crafts.md`: each Habitica mount layer is a 135×135 source canvas drawn at 22/90, or 33×33 game px (132×132 texels). The bundled Wolf-Base alpha union is about 97×82 texels at game scale. The 2×3 bay is 128×192 footprint texels and the 128×320 canvas is 80 game px tall. The 9.2 canvases remain unchanged.

The stable uses one continuous 10.5×5-tile source sheet. The entire source is scaled uniformly to 320 texels high; its 671-texel scaled width is padded by one transparent texel to the 672-texel module run. Cuts at texels 0, 256, 384, 512, 640, and 672 place the 256×320 west end, repeated 128×320 bay, and 32×320 east cap at shared post centerlines. Back layers replace door slabs with same-scale plank backing and straw-detailed floor, and retain posts and stone feet. The front shut frame adds the 44-texel chest-height half door; the open frame leaves the interior visible. `stable-preview-1-bay.png` and `stable-preview-5-bays.png` show both requested lengths, with one open bay and a mount-sized placeholder in each against mid-grey. `stable-composite-preview.png` is the five-bay preview. Repeated pieces use native scale with no horizontal or vertical stretch. Source frames are more finely shaded than the hand-authored Commons sprites. Review ability icons at 16 px; several source symbols are intricate and may need simplification to hold their meaning at HUD size.

The fish, Stand, Kindle and Ward-light strips are extracted by individual content bounds and centered consistently. Kindle is now a low hollow patch; Ward-light is an open calm rim with a subtle outward pulse. Motion remains approximate; avoid using the checkerboard-bearing source sheets directly. Only normalized PNGs in `frames/` have transparent alpha.

## Rebuild

Run `python3 assets/generated/crafts-pass/build_pass.py` from the repository root. This only rebuilds the crops and metadata from the preserved `sheets/` images.
