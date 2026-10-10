# 0.6 Purse and wardrobe art pass

Generated on 2026-10-09 with the built-in image generation tool from `docs/art-request-purse.md`. The source sheet is preserved in `sheets/purse-icons.png`; six normalized transparent frames are in `frames/`. `manifest.json` records exact canvases, anchors and source rectangles, `atlas.json` records atlas entries, and `prompts.json` records the generation prompt and source image ID. The files are prepared for later game integration; no game files were wired or changed.

All canvases use 64 texels per 16 px world tile, crisp pixel edges, upper-left light and a 4-texel transparent gutter. The original coin is one round brass-gold coin with a lamp stamp and worn rim. It is Glimway art and does not use or reproduce Habitica's stacked-coin icon. Silas's timber, stone and fiber bundles remain code-badged existing art, as requested.

## Contents and small-size review

- `gold-coin.png` (64×64): coin icon, intended for a 16×16 game-pixel display.
- `gold-coin-hud.png` (32×32): same coin crop on the smaller HUD canvas; the requested HUD display is 8×8 game pixels. The lamp stamp and worn rim may need further simplification at 8×8.
- `purse.png` and `wardrobe.png` (64×64): purse card/log and wardrobe tab icons, respectively; coat, hat, drawstring and coin details may need simplification if shown below 16×16 game pixels.
- `price-tag.png` (32×32): paper tag for shelf slots; its string and outline may need simplification at an 8×8 game-pixel display.
- `gold-letter.png` (64×64): folded letter with a coin pressed into the wax seal; the coin detail may need simplification if shown below 16×16 game pixels.

`contact-sheet.png` shows each actual frame canvas enlarged with nearest-neighbour pixels over a review-only checker backing. The HUD coin also has an 8×8 game-pixel preview. Frame files themselves contain transparent backgrounds. Frame dimensions, alpha, anchors and 4-texel gutters were checked against the requested canvases; the frames are static with no animation groups.

## Rebuild

From the repository root, run:

```sh
python3 assets/generated/purse-pass/build_pass.py
```

The script rebuilds frames, `manifest.json`, `atlas.json` and `contact-sheet.png` from the preserved sheet in `sheets/`.
