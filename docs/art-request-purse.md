# Art request: the 0.6 purse and wardrobe pass

For the image-generation round. This request implements section 9 of `docs/design/purse-and-wardrobe.md`.

## Global spec

- **Density:** 64 texels per 16 px world tile. Use the listed texel canvases exactly.
- **View and style:** crisp, stepped pixel art in Glimway's cozy woodland RPG style; 1 px dark warm-brown outlines at this density; upper-left light; brass gold, warm leather, natural cloth and paper. No blur, antialiasing, painterly texture or soft gradients.
- **Delivery:** transparent backgrounds. Each icon is an individually framed PNG on its exact canvas, with a small transparent gutter and a documented source crop and center anchor. No fake checkerboard pixels.

## Pieces

| Piece | Canvas | Notes |
|---|---:|---|
| Gold coin | 64×64 | Glimway's own round brass-gold coin, small lamp stamped on its face, worn rim. One coin only; must not resemble Habitica's stacked-coin gold icon. |
| Gold coin (HUD) | 32×32 | A simplified version of the same coin, retaining the lamp mark and worn rim; designed to read at 8×8 game pixels in the HUD. |
| Purse | 64×64 | Drawstring leather purse with a coin at its mouth; used for the purse card and log. |
| Wardrobe | 64×64 | A coat and hat on a peg rail; icon for the wardrobe tab. |
| Price tag | 32×32 | Paper tag on a string, for priced shelf slots. |
| Gold letter | 64×64 | Folded letter with a coin pressed into its wax seal, for gold in the mailbox. |

Silas's bundles need no art: timber, stone and fiber icons are reused with a ×4 badge drawn in code. No Habitica art is made or copied.

## Delivery and review

Deliver the listed pieces to `assets/generated/purse-pass/`, with preserved source sheets, normalized transparent frames, `manifest.json`, `atlas.json`, `prompts.json`, `README.md`, `contact-sheet.png` and `build_pass.py`. Record each source crop, exact canvas, pixel dimensions and center anchor. Keep art generation and atlas packing separate from game wiring.
