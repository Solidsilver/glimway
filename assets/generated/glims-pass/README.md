# 0.6.1 Glim art pass

Generated on 2026-10-10 with the built-in image generation tool from `docs/art-request-glims.md`.
The three preserved source PNGs are in `sheets/`; normalized transparent frames are in `frames/`.
`manifest.json` records each exact canvas, source crop, center anchor and four-texel gutter.
`atlas.json` mirrors source and frame coordinates; `prompts.json` records prompts and generated
source image IDs. These files are prepared for later integration; no game files were wired or
changed.

All art uses 64 texels per 16 px world tile, upper-left light, stepped pixels and dark warm-brown
outlines. The single glim is a round faceted amber bead with a bright core and small glint; it is
coin-adjacent in size and weight, but has no stamp or token face. The grouped icon contains three
beads as requested.

## Contents and small-size review

- `glim.png` (64×64): single bead, intended for a 16×16 game-pixel display.
- `glim-hud.png` (32×32): deliberately simplified rendering, intended for an 8×8 game-pixel HUD
  display. At 8×8, the internal facets and small glint may merge; simplifying the facets and
  keeping a single highlight cluster may improve readability.
- `glims-few.png` (64×64): three beads together for the log, letters and toast.

`contact-sheet.png` places every exact frame canvas over a review-only checker backing and shows an
8×8 game-pixel preview of the HUD frame enlarged with nearest-neighbor pixels. Checker pixels are
not part of the frame files. The 64×64 bead and three-bead icon retain their silhouette and warm
core at their full canvases; the HUD bead is the only frame that may need further simplification at
its requested 8×8 display size. All frame canvases, alpha channels, gutters and center anchors are
rechecked by the build script.

## Rebuild

From the repository root, run:

```sh
python3 assets/generated/glims-pass/build_pass.py
```

The script rebuilds frames, `manifest.json`, `atlas.json` and `contact-sheet.png` from the preserved
sources in `sheets/`.
