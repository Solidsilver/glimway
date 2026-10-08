# 0.4 Indoors art pass — Round 2b

Original art generated 2026-10-08 with the built-in image-generation tool.
The first pass and Round 2b art live in `sheets/`; prompts and generation file IDs are in `prompts.json` and `round2-jobs.json`. `manifest.json` records 176 named frames, 90 sources, exact canvases, crop and destination rectangles, footprints, base points, origins, and 16 animation/state groups. `atlas.json` is the source-resolution frame map. `furnishings.json` is the placement catalogue for 48 pieces. Packed frames belong under `indoors.frames` in `public/assets/fingersnap/packed/atlases.json`.

All canvases use 64 texels per 16px tile. The game packs the whole requested
canvases at density 64 so the room lane can consume them without scaling a
whole sheet. No room call sites were changed.

The image tool rendered checkerboard backdrops instead of true transparency. Source sheets preserve sprite pixels while converting edge-connected neutral checkerboard pixels to alpha. Frame crops are hand measured and aspect-contained in native-size transparent canvases; no sprites are stretched. The Round 2b crop files have a 4 px transparent gutter. `audit_frame_edges.py` checks every frame and removes small disconnected alpha fragments at crop edges; five older frames received that cleanup, and `edge-audit.json` records the audit. `render_contact_sheets.py` regenerates the room and kit sheets from the audited manifest. Round 2b sprites were matched to residents in scale, view, shading, and pixel density. The packed plank and flagstone families are seam-healed by the atlas build using the existing minimum-error quilting helper.


## Round 2b furnishing catalogue

Frame keys follow `<piece>-<facing>-<state>[-<index>]`. `furnishings.json` is the machine-readable source for piece IDs, facings, states, footprint in 16 px tiles, floor-contact base box, size, mount, and offered surfaces/slots. The table lists those values per piece. Base boxes are normalized to the footprint as `[x,y,w,h]`, measured from its upper-left; the lower edge touches the floor.

| Piece ID | Footprint | Base [x,y,w,h] | Size | Mount | Facings / states → frame keys | Offers |
|---|---:|---|---|---|---|---|
| `library-shelf-tall` | 2×1 | [0, 0.75, 2, 0.25] | large | floor | front/sparse: `library-shelf-front-sparse`; front/half: `library-shelf-front-half`; front/full: `library-shelf-front-full`; left/sparse: `library-shelf-tall-left-sparse`; left/half: `library-shelf-tall-left-half`; left/full: `library-shelf-tall-left-full`; right/sparse: `library-shelf-tall-right-sparse`; right/half: `library-shelf-tall-right-half`; right/full: `library-shelf-tall-right-full` | shelves (6 slots) |
| `library-shelf-short` | 1×1 | [0, 0.5, 1, 0.5] | medium | wall | left/sparse: `library-shelf-short-left-sparse`; left/half: `library-shelf-short-left-half`; left/full: `library-shelf-short-left-full`; right/sparse: `library-shelf-short-right-sparse`; right/half: `library-shelf-short-right-half`; right/full: `library-shelf-short-right-full` | shelves (2 slots) |
| `library-reading-nook` | 3×2 | [0, 1.5, 3, 0.5] | large | wall | front/default: `library-reading-nook-front-default` | top (2 slots) |
| `library-elara-desk` | 2×1 | [0, 0.5, 2, 0.5] | large | floor | front/empty: `library-elara-desk-front-empty`; front/elara-seated: `library-elara-desk-front-seated` | top (3 slots) |
| `library-section-sign-stories` | 3×1 | [0, 0.75, 3, 0.25] | small | wall | front/default: `library-section-sign-front-stories` | — |
| `library-section-sign-histories` | 3×1 | [0, 0.75, 3, 0.25] | small | wall | front/default: `library-section-sign-front-histories` | — |
| `library-section-sign-recipes` | 3×1 | [0, 0.75, 3, 0.25] | small | wall | front/default: `library-section-sign-front-recipes` | — |
| `library-section-sign-field-notes` | 3×1 | [0, 0.75, 3, 0.25] | small | wall | front/default: `library-section-sign-front-field-notes` | — |
| `rug-woven` | 3×2 | [0, 1.75, 3, 0.25] | large | floor | front/default: `rug-woven-front-default` | — |
| `rug-braided` | 3×2 | [0, 1.75, 3, 0.25] | large | floor | front/default: `rug-braided-front-default` | — |
| `rug-patchwork` | 4×2 | [0, 1.75, 4, 0.25] | large | floor | front/default: `rug-patchwork-front-default` | — |
| `shelf-generic-front` | 2×1 | [0, 0.5, 2, 0.5] | large | wall | front/default: `shelf-generic-front-default` | shelves (6 slots) |
| `shelf-generic-side` | 1×1 | [0, 0.5, 1, 0.5] | medium | wall | left/default: `shelf-generic-left-default`; right/default: `shelf-generic-right-default` | shelves (3 slots) |
| `wall-pegs-tools` | 3×1 | [0, 0.8, 3, 0.2] | medium | wall | front/default: `wall-pegs-front-tools` | — |
| `crate` | 1×1 | [0, 0.75, 1, 0.25] | medium | floor | front/default: `crate-front-default` | top (1 slots) |
| `barrel` | 1×1 | [0, 0.75, 1, 0.25] | medium | floor | front/default: `barrel-front-default` | top (1 slots) |
| `sack-large` | 1×1 | [0, 0.75, 1, 0.25] | medium | floor | front/default: `sack-large-front-upright`; front/slumped: `sack-large-front-slumped` | — |
| `basket` | 1×1 | [0, 0.75, 1, 0.25] | small | floor | front/default: `basket-front-default` | — |
| `plant-leafy` | 1×1 | [0, 0.75, 1, 0.25] | small | floor | front/default: `plant-leafy-front-default` | — |
| `plant-flowering` | 1×1 | [0, 0.75, 1, 0.25] | small | floor | front/default: `plant-flowering-front-default` | — |
| `lamp-oil` | 1×1 | [0, 0.75, 1, 0.25] | small | floor | front/default: `lamp-oil-front-default` | — |
| `candle-holder` | 1×1 | [0, 0.75, 1, 0.25] | small | floor | front/default: `candle-holder-front-default` | — |
| `candle-stick` | 1×1 | [0, 0.75, 1, 0.25] | small | floor | front/default: `candle-stick-front-default` | — |
| `picture-frame` | 1×1 | [0, 0.75, 1, 0.25] | small | wall | front/default: `picture-frame-front-default` | — |
| `calendar` | 1×1 | [0, 0.75, 1, 0.25] | small | wall | front/default: `calendar-front-default` | — |
| `curtains` | 2×1 | [0, 0.75, 1, 0.25] | medium | wall | front/default: `curtains-front-default` | — |
| `side-table` | 1×1 | [0, 0.75, 1, 0.25] | medium | floor | front/default: `side-table-front-default` | top (2 slots) |
| `chair-front` | 1×1 | [0, 0.75, 1, 0.25] | large | floor | front/default: `chair-front-default` | — |
| `chair-side` | 1×1 | [0, 0.75, 1, 0.25] | large | floor | left/default: `chair-left-default`; right/default: `chair-right-default` | — |
| `stool` | 1×1 | [0, 0.75, 1, 0.25] | large | floor | front/default: `stool-front-default` | — |
| `chest` | 1×1 | [0, 0.75, 1, 0.25] | large | floor | front/default: `chest-front-default` | top (2 slots) |
| `kitchen-oven-hearth` | 3×2 | [0, 1.5, 3, 0.5] | large | floor | front/fire: `kitchen-oven-front-fire` | top (2 slots) |
| `kitchen-worktable` | 4×2 | [0, 1.5, 4, 0.5] | large | floor | front/default: `kitchen-worktable-front-default` | top (4 slots) |
| `kitchen-washtub` | 1×1 | [0, 0.5, 1, 0.5] | medium | floor | front/default: `kitchen-washtub-front-default` | — |
| `kitchen-cauldron` | 1×1 | [0, 0.5, 1, 0.5] | medium | floor | front/steaming: `kitchen-cauldron-front-steaming-0`, `kitchen-cauldron-front-steaming-1`, `kitchen-cauldron-front-steaming-2`, `kitchen-cauldron-front-steaming-3` | — |
| `kitchen-bread-rack` | 1×1 | [0, 0.5, 1, 0.5] | medium | floor | front/default: `kitchen-bread-rack-front-default` | shelves (2 slots) |
| `kitchen-jar-shelf` | 2×1 | [0, 0.5, 2, 0.5] | large | wall | front/default: `kitchen-jar-shelf-front-default` | shelves (4 slots) |
| `kitchen-flour-handprint` | 1×1 | [0.4, 0.4, 0.2, 0.2] | small | wall | front/default: `kitchen-flour-handprint-wall-default` | — |
| `kitchen-oven-peel` | 1×1 | [0.4, 0.4, 0.2, 0.2] | small | wall | front/default: `kitchen-oven-peel-wall-default` | — |
| `millstone-hopper` | 2×2 | [0, 1.5, 2, 0.5] | large | floor | front/turn: `millstone-hopper-front-turn-0`, `millstone-hopper-front-turn-1`, `millstone-hopper-front-turn-2`, `millstone-hopper-front-turn-3` | — |
| `mill-sifter` | 1×1 | [0, 0.5, 1, 0.5] | medium | wall | front/default: `mill-sifter-front-default` | shelves (1 slots) |
| `mill-gear-wheel` | 2×1 | [0, 0.5, 2, 0.5] | large | wall | left/turn: `mill-gear-wheel-left-turn-0`, `mill-gear-wheel-left-turn-1`, `mill-gear-wheel-left-turn-2`, `mill-gear-wheel-left-turn-3` | — |
| `mill-sack` | 1×1 | [0, 0.75, 1, 0.25] | medium | floor | front/upright: `mill-sack-front-upright`; front/slumped: `mill-sack-front-slumped` | — |
| `mill-wall-stairs` | 2×2 | [0, 1.5, 2, 0.5] | large | floor | diag/default: `mill-stairs-diag-default` | — |
| `loft-stair-opening` | 2×2 | [0, 1.5, 2, 0.5] | large | floor | front/default: `loft-stair-opening-front-default` | — |
| `loft-hoist` | 2×2 | [0, 1.5, 2, 0.5] | large | wall | front/default: `loft-hoist-front-default` | — |
| `mill-tally-board` | 1×1 | [0.4, 0.4, 0.2, 0.2] | small | wall | front/default: `mill-tally-board-wall-default` | — |
| `mill-gear-small` | 1×1 | [0.4, 0.4, 0.2, 0.2] | medium | wall | left/default: `mill-gear-wall-small-default` | — |

The desk's `elara-seated` state is a composite desk-and-resident frame; normal resident idles remain in the Commons pass. Only `kitchen-cauldron-steaming`, `millstone-hopper-turn`, and `mill-gear-wheel-turn` loop slowly. Static states have no animation; loop frame keys and timing are in `manifest.json`.

## Round 2b preview sheets

- Library: [contact sheet](../../../.agent/screens/library-pass.png), [room mock-up](../../../.agent/screens/library-in-room.png)
- Kitchen: [contact sheet](../../../.agent/screens/kitchen-pass.png), [room mock-up](../../../.agent/screens/kitchen-in-room.png)
- Mill: [contact sheet](../../../.agent/screens/mill-pass.png), [room mock-up](../../../.agent/screens/mill-in-room.png)
- Sack loft: [contact sheet](../../../.agent/screens/loft-pass.png), [room mock-up](../../../.agent/screens/loft-in-room.png)
- Cottage with shared kit: [contact sheet](../../../.agent/screens/shared-interior-kit.png), [room mock-up](../../../.agent/screens/cottage-in-room.png)

## Known limits

- The generated smoke and lit-window overlays are not fitted to the exact
  existing house-window masks; the three windows should be aligned in the
  integration pass using the building art.
- The millstone and gear loops are approximate turns, not mechanically exact quarter-turn sequences.
- Pixel density and scale were brought closer to resident art, though some image-generation source accents remain finer than hand-authored native sprites.
- Round 2b replaces props in every room and supplies a generic furnishing kit; rooms add only signature kitchen, mill, loft, and library pieces.

## Licence

Glimway project, original generated art, CC0 1.0. See `assets/generated/LICENSE`
and the indoors pass entry in `ASSETS.md`.
