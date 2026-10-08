# Art request: the 0.4 indoors pass

For the image-generation agent. Follow the style of the last round in
`docs/art-request-playtest2.md` and the existing generated art in
`assets/generated/`. Deliver to `assets/generated/indoors-pass/` with
`manifest.json`, `atlas.json`, README and `prompts.json` notes. This request is
made from section 7 of `docs/design/indoors.md`.

## Global spec

- **Density:** 64 texels per 16 px world tile. Use the listed texel canvases
  exactly; every piece records its tile footprint and the bottom-centre foot
  point of that footprint.
- **View and style:** three-quarter top-down RPG view, not isometric; crisp
  pixel art, 1 px dark warm-brown outlines at this density; upper-left light;
  warm lived-in woodland palette, amber lights, russet wood and golden stone;
  no soft gradients, blur or antialiasing.
- **Delivery:** transparent backgrounds for sprites and overlays; seamless
  floor tiles. Animated pieces are horizontal strips, frames left to right,
  with the same canvas for every frame.
- **Placeable art:** interiors should read at game scale beside existing
  Commons furniture. Outside overlays must fit the existing windows/buildings.

## 1. Interior kit

| Piece | Footprint | Canvas | Frames / states | Notes |
|---|---:|---:|---|---|
| Plank floor | 1×1 | 64×64 | 4 variants | Warm worn east–west boards; seamless in any order |
| Flagstone floor | 1×1 | 64×64 | 4 variants | Golden stone, hearth aprons and wet mill end |
| Back wall | 1×2 | 64×128 | 3 variants | Timber frame and plaster; top row is the wall's top edge |
| Back wall, window | 1×2 | 64×128 | 1 | Small daylight paned window; lit sill |
| Side and near walls | 1×1 | 64×64 | 8 pieces | Left, right, near, four corners and near-wall doorway end |
| Doorway | 2×1 | 128×64 | 1 | Near-wall gap, threshold boards and a little daylight |
| Stairs up | 2×2 | 128×128 | 1 | Wooden stairs rise toward the back wall, with a rail |
| Stairs down | 2×2 | 128×128 | 1 | Upper-floor opening, rail and steps descending out of sight |
| Ladder | 1×2 | 64×128 | 1 | Cellar ladder |
| Trapdoor | 1×1 | 64×64 | 2 | Shut and open |
| Rug | 3×2 | 192×128 | 2 designs | Rag rug and braided round rug |
| Counter | 3×1 | 192×128 | 1 | Rises one tile above its footprint |
| Room surround | 1×1 | 64×64 | 1 | Dark wood beyond the walls |

## 2. Hazel's kitchen

| Piece | Footprint | Canvas | Frames / states | Notes |
|---|---:|---:|---|---|
| Oven and hearth | 3×2 | 192×192 | 4 fire states | Brick bread oven, hearth, hanging pot and crane; rises one tile into back wall |
| Worktable | 4×2 | 256×128 | 1 | Scrubbed table, flour drifts and dough on a board |
| Shelves of crocks | 2×1 | 128×128 | 1 | Crocks, jars and salt pig; rises one tile |
| Tallow pot on stand | 2×1 | 128×128 | 3 steam states | Rises one tile |
| Sponge bowl on stool | 1×1 | 64×128 | 2 | Cloth over the bowl; flat and risen dough |
| Bread rack | 1×1 | 64×128 | 1 | Loaves and twists, one with burnt ends |
| Hazel kneading | — | Resident canvas | 4 | Optional; existing sprite with working arms |

## 3. Finn's mill and loft

| Piece | Footprint | Canvas | Frames / states | Notes |
|---|---:|---:|---|---|
| Millstones under hopper | 2×2 | 128×192 | 4 turning | Rises one tile; flour dust at the eye |
| Gear train | 3×2 | 192×192 | 4 turning | Wooden pit wheel and wallower on east wall; match outdoor wheel pace |
| Chute and meal bin | 2×2 | 128×128 | 1 | — |
| Flour sacks | 2×2 | 128×128 | 2 variants | Tied; one slumped |
| Counting stool and window | 1×1 | 64×64 | 1 | Three-legged stool; tally scratches on sill |
| Sack hoist and hatch | 2×2 | 128×192 | 2 hoist states + 3 rope swings | Pulley above hatch; seized state has frayed, kinked rope |
| Roof beams | 12×1 | 768×64 | 1 | Foreground overlay across loft top, drawn over player |

## 4. Library reading room

| Piece | Footprint | Canvas | Frames / states | Notes |
|---|---:|---:|---|---|
| Tall shelf | 2×1 | 128×192 | 3 | Sparse, half and full; shows village shelf count |
| Reading table with lamp | 4×2 | 256×160 | 2 lamp states + 3 flame frames | Two chairs either side; visible tin note tag |
| Donation shelf | 2×1 | 128×128 | 3 fill states | Lower shelf, slot box and card |
| Window seat | 2×1 | 128×128 | 1 | Cushion and open book |

## 5. Outside: smoke and lit windows

| Piece | Canvas | Frames | Notes |
|---|---:|---|---|
| Chimney smoke | 64×128 | 6-loop | Soft grey curls rise and thin; bakery and mill chimneys |
| Bakery lit window | 64×64 | 1 | Fit the delivered west-house window, index 4, row above door |
| Mill lit window | 64×64 | 1 | Fit the mill-house window |
| Library lit window | 64×64 | 1 | Fit the Hearthwick Library window; softer reading-lamp glow |

Windows are drawn over existing building art; match the exact window shape and
position recorded in the building atlas.

## 6. Quest icons and opening

| Piece | Canvas | Frames | Notes |
|---|---:|---|---|
| Shelf icons: road, village, craft | 64×64 each | 1 each | Lantern on post; loaf and cup; mallet and bowl |
| Pin mark | 64×64 | 2 | Brass map pin: unpinned and pinned |
| Gate marks | 64×64 each | 1 each | Sand hourglass; small ember; padlock with ledger ribbon |
| Signpost plumb, east finger missing | Existing signpost canvas | 1 | Straight version with a gap |
| East finger in bracken | 128×64 | 1 | Painted `ASHWATCH`, older `SALLOW FD` underneath, half in bracken |
| Keepsake icons: east finger, tally token | 64×64 each | 1 each | Inventory icons; token is a punched wheel-tax receipt |

## Order of value

1. Interior kit and Hazel's kitchen.
2. Finn's mill and loft, then the library reading room.
3. Smoke, windows, quest icons and keepsakes.

The runtime art pass makes frames available in the packed atlas; room wiring is
owned by the 0.4 code lanes.


## Round 2b delivery: shared furnishing kit and room refinements

Applied the interior rules in design section 7.0 and the furnishing data contract in section 2.8. The detailed deliverable is catalogued in `assets/generated/indoors-pass/README.md` and `furnishings.json`. Every piece records its facings, state frames, tile footprint, normalized floor-contact base, size, mount, and offered surfaces/slots. Stable frame names are keyed by piece, facing, state, and loop index where needed. Art uses 64 texels per 16 px tile; individual crops preserve aspect ratio on transparent canvases.

The generic kit can dress any building and later be reused for player homes: three rugs; front and side shelving; wall pegs/tools; crate, barrel, sacks, basket; two plants; oil lamp, candle holder, candle stick; picture, calendar, curtains; side table, front and side chairs, stool, and chest. These pieces carry no owner-specific decoration. The library shelves and four section plaques, reading nook, and desk are library signatures. Kitchen signatures cover the oven/hearth, worktable, washtub, cauldron, bread rack, jar shelf, flour mark, and oven peel. Mill signatures cover millstone/hopper, sifter, gear wheels, sacks, wall stairs, loft opening, hoist, and tally board.

Only the cauldron steam, millstone, and gear wheel use slow loops; all other states are static. Each room has a contact sheet and an in-room mock-up in `.agent/screens/`. The five mock-ups include the library, Hazel's kitchen, Finn's mill, the sack loft, and a cottage dressed from the shared kit.

The cut-edge review checked all 176 pass frames. Round 2b crop files now have a 4 px transparent gutter; five small detached edge fragments in legacy frames were cleared. Refreshed contact sheets and mock-ups are in `.agent/screens/`, and `edge-audit.json` records the frame audit.

### Replaced frame families

Round 2b's room-scale pieces supersede these earlier art families for interior placement: `oven-hearth-fire-0..3`, `worktable`, `crock-shelves`, `tallow-pot-steam-0..2`, `sponge-bowl-flat/risen`, `bread-rack`, `millstones-0..3`, `gear-train-0..3`, `chute-meal-bin-0..3`, `flour-sacks-0..1`, `counting-stool-window`, `sack-hoist-seized/working/swing-0..2`, `library-shelf-0..2`, `reading-table-unlit/lit`, `reading-lamp-flame-0..2`, `donation-shelf-0..2`, and `window-seat`. Use the Round 2b names in the README and manifest. Floor, wall, doorway, surround, exterior overlays, and quest icons remain from the first pass. The old keys remain in the manifest for compatibility and history; lane B can switch room placements to the replacement families.
