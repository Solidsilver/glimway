# Fingersnap open-map art pass

This pass supplies the non-code art for the 0.8 open map. It follows the Tangle's crisp pixel-cluster style and the 64-texel-per-16-pixel tile density. All props are front-facing in the residents' three-quarter view. The ground pieces are flat, fully opaque top-down tiles. No game wiring is included.

## Contents

- `source/`: retained generated prop, landmark, veil, ground and ford sheets, plus the round-1 map icon source and round-3 replacements.
- `frames/`: one native-size PNG per requested frame (45 frames total).
- `manifest.json`: full source catalog, frame canvases, source rectangles, footprints, prop foot points, and animation groups.
- `atlas.json`: frame-to-source mapping plus canvas, footprint, and foot-point metadata.
- `animations.json`: slow ripple loops for the horizontal/vertical fords and the frontier veil.
- `prompts.json`: generation prompt and notes on derived art.
- `contact-sheet.png`: the frames laid out from their native canvases for a quick inventory view.
- `build_pass.py`: rebuilds exact frame crops from retained source sheets, normalizes ground-family edge profiles for seamless variants, and refreshes metadata and the contact sheet.

Run from the repository root with:

```sh
python3 assets/generated/open-map-pass/build_pass.py
```

## Frame keys and canvases

Every listed key is present in both JSON indexes. The numbered groups use zero-based suffixes.

| Keys | Canvas each | Footprint | Use |
|---|---:|---:|---|
| `meadow-grass-0..2`, `meadow-flowers-0..2` | 64×64 | 1×1 | Walkable meadow decor |
| `meadow-outcrop-0..1` | 128×160 | 2×2 | Solid lichen outcrops |
| `meadow-oak` | 160×256 | 2×1 | Solid trunk at the bottom-centre foot point |
| `meadow-stone-0..1`, `bank-stones-0..2` | 64×64 | 1×1 | Solid fallen stones; walkable bank stones |
| `landmark-split-oak` | 192×320 | 2×1 | Tall woods landmark, split trunk and hollow roots |
| `landmark-standing-stone` | 64×224 | 1×1 | Tall lichen stone with a carved ring |
| `rumour-find-closed`, `rumour-find-open` | 64×64 | 1×1 | Closed parcel and the same bundle open and empty |
| `way-sign` | 64×128 | 1×1 | Blank roadside signpost |
| `ford-h-0..2` | 192×64 | 3×1 | Horizontal crossing; slow ripple loop |
| `ford-v-0..2` | 64×192 | 1×3 | Vertical crossing; slow ripple loop |
| `path-stone-0..3`, `path-plank-h-0..1`, `path-plank-v-0..1` | 64×64 | 1×1 | Player-laid path tiles |
| `road-paving-0..3`, `road-verge-0..1` | 64×64 | 1×1 | Lantern Road surface and edge |
| `lamp-stone-dark` | 64×128 | 1×1 | Unlit road landmark; collision at its base |
| `frontier-veil-0..3` | 192×64 | 3×1 | Looping boundary overlay |
| `icon-map-tab` | 32×32 | 1×1 | Journal tab icon |

Each frame records a bottom-centre `footPoint`. For props it marks the base anchor; collision should use the base footprint, not the full image bounds. Ground tiles and the UI icon carry a conventional bottom-centre point for complete metadata, though they are painted by tile origin or as UI.

## Palette and style

Generated tiles use warm moss greens, grey-gold path stone, iron-oak browns, and the Tangle's dark teal river family from `wilds-looks.ts`. The meadow decor is lighter and more straw-warm than the woods floor; flowers stay muted. Road paving is larger and paler than player-laid stone, with moss in the joints. Wood has grain, knots, uneven ends, and visible nails. Ford water is dark, slow grey-green, with rounded lit stone tops and wet dark sides. Prop backgrounds are transparent; terrain frames are opaque.

## Real-size review

The exact-size frames are collected in `contact-sheet.png`. `.agent/open-map-comparison.png` places every new frame in a three-column review beside a reference crop from the existing `fingersnap-wilds-nature` Tangle atlas and a prop/ground reference from `playtest1-pass`. New art is shown at its listed texel canvas size; the older references are fitted to that same canvas for style and relative-footprint review. `.agent/open-map-ground-tiling-test.png` shows the five ground families repeated 4×4; the paired-edge check measures 0 RGB difference at every family seam after edge normalization.

The meadow oak canopy, split landmark oak, and outcrop foliage contain many small clusters and may need simplifying at normal game zoom. The grass tufts are also dense for walkable decor. The generated frontier veil has delicate mist threads; if they collapse at 16-pixel world display size, simplify them to fewer, thicker strands. These are the frames most likely to benefit from cleanup at game zoom.

## Build notes

The source prop atlas returned two flower patches; `meadow-flowers-2` remains a mirrored muted recolor of the first patch. `meadow-outcrop-1`, `meadow-stone-0`, `meadow-oak`, and `bank-stones-1..2` discard disconnected neighboring fragments at their crop edges. Round 3 replaces the standing stone and sign with isolated full-height portrait sources. The ford is rebuilt from a clean water texture and three generated flat stones; the builder masks to one stone per tile, then shifts water beneath the fixed stones for the ripple loop. The map icon remains the round-1 code-drawn icon.
