# Art request: the 0.6.1 glim pass

For the image-generation round. This request implements section 1.9 of `docs/design/silas-yard.md`;
see section 1.2 for what a glim is.

## Global spec

- **Density:** 64 texels per 16 px world tile. Use the listed texel canvases exactly.
- **View and style:** crisp, stepped pixel art in Glimway's cozy woodland RPG style; 1 px dark
  warm-brown outlines at this density; upper-left light; amber with a bright warm core and small
  glint. No blur, antialiasing, painterly texture or soft gradients.
- **Delivery:** transparent backgrounds. Each icon is an individually framed PNG on its exact
  canvas, with a 4-texel transparent gutter and documented source crop and center anchor. No fake
  checkerboard pixels.

## Pieces

| Piece | Canvas | Notes |
|---|---:|---|
| Glim | 64×64 | One round, faceted amber bead with a bright core and small glint; coin-sized in visual weight, not stamped and not a diamond-cut gem. Replaces the ember icon (`Icon name="ember"`) and the 0.6 gold coin, which is no longer needed. |
| Glim (HUD) | 32×32 | Simplified-size rendering of the same bead for an 8×8 game-pixel HUD display. Preserve a clear silhouette, core and glint. |
| Glims, a few | 64×64 | Exactly three beads together, for the log, letters and toast. |

The story calls a glim a bead of amber cut to the Count House's measure, holding a glint of light.
The icon is coin-adjacent in size and weight, but it is amber that someone has cut and lit, not a
coin. Habitica gold appears only as words on the consent card; no Habitica art is made or copied.

## Delivery and review

Deliver the listed pieces to `assets/generated/glims-pass/`, with preserved source sheets,
normalized transparent frames, `manifest.json`, `atlas.json`, `prompts.json`, `README.md`,
`contact-sheet.png` and `build_pass.py`. Record each source crop, exact canvas, pixel dimensions and
center anchor. Keep art generation and atlas packing separate from game wiring.

Inspect every frame at its actual texel dimensions. In particular, review the 32×32 glim at its
8×8 game-pixel HUD display size and note in the pass README if any details need simplification.
