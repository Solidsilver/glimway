# Art requests for the expansion

> **Delivered 2026-10-05** as the Commons pass (`assets/generated/commons-pass/`)
> and wired into the game; see `docs/runtime-asset-spec.md` ("Commons pass")
> for what replaced which placeholder and what was loaded but not placed.

Everything listed here currently ships as **code-drawn placeholder art** (pixel
art painted in TypeScript), mostly in `src/game/commons-art.ts`,
`src/game/wilds/wilds-looks.ts`, `src/game/area/foreground.ts` and
`src/game/entities/papers.ts`. Placeholders keep their texture keys, so a
delivered pack only needs a manifest entry and a loader swap, the same way the
expansion pack and the runtime art pass were integrated
(`docs/runtime-asset-spec.md`).

## House style (match the delivered packs)

- **View**: top-down three-quarter RPG view, facing the viewer; not isometric.
- **Scale**: 16-px world tiles. Characters read at **16×16 native pixels**
  (the hero is ~20 px tall). Props are sized to the tiles they occupy.
- **Line and shading**: ultra simple, chunky pixels; few large flat-colour
  blocks; a dark warm brown outline (`#3a2a28`); lit from the upper left; no
  gradients, no anti-aliasing, no painterly texture, no tiny detail.
- **Palette**: warm and lived-in, matching the existing terrain and NPC sheets
  (`assets/generated/expansion/`, `assets/generated/runtime-pass/`).
- **Delivery**: genuinely transparent PNG sheets with generous gutters, no
  labels or grids; we measure each frame's rect into `manifest.json` (never a
  fixed grid). Feet/bases on a consistent baseline within each cell.
- **Prompt preamble** that produced the current packs (prepend to each item):
  > Asset type: original low resolution RPG sprite for Fingersnap, a cozy
  > lantern-lit pixel-art village RPG. Genuine transparent background, isolated
  > poses, no labels/grid, large transparent gutters. Top-down three-quarter RPG
  > viewpoint, not isometric. STRICT ultra simple chunky pixel style designed to
  > read at its native size, few large flat-colour blocks, dark warm brown
  > #3a2a28 outline, lit from upper left, no gradients, no antialiasing, no
  > painterly detail.

---

## Priority 1: characters

These are the most visible placeholders. Elara and Finn are written into the
canon and the papers; their art unblocked adding them as NPCs (delivered in
the Commons pass; all four residents are in the world now).

| Sprite | Native size | Frames | Description |
|---|---|---|---|
| **Silas** | 16×16 | `silas-idle-0/1` (breathing, feet planted) + a dialogue bust portrait | Retired carter, 64. Flat cap over grey hair, grey moustache, weathered face, leather work apron over a faded blue shirt, a carpenter's pencil in the apron pocket. Stands with his weight off his **left** knee (he limps on it). Kind, tired eyes. |
| **Elara Quill** | 16×16 | idle 0/1 + bust | Forager from the Merrow Saltings, 30s. Practical salt-stained oilskin coat, rolled sleeves, satchel of jars and string, a pencil behind one ear, dark hair tied back with twine, sharp curious look. Fen-country colours (grey-green, reed brown). |
| **Finn Tolley** | 16×16 | idle 0/1 + bust | Miller, 36. Flour-dusted apron and forearms, cap pushed back, sandy hair, slightly hunched and anxious, counting on his fingers. |
| *(optional)* **Hazel Penhallow** | 16×16 | idle 0/1 + bust | Baker, Pip's mum and Joss's sister. Round, warm, floury, a basket of twisted loaves. |
| *(optional)* **Ada Cooley** | 16×16 | idle 0/1 + bust | 88, the twins' mother. Small, upright, shawl, holding a window lamp. |
| **Stone warden, settled** | match `fingersnap-guardian` sheet | 1 pose | The warden **at rest**: seated heap of drift-stone over an iron-oak frame, arms folded or lowered to the ground, head bowed, the amber heart-lamp in its chest glowing low like a coal. Must read as *resting*, not broken or dead. Today we reuse the `guardian-defeat` frame. |

## Priority 2: homesteads and the Commons

### Your home

| Sprite | Size | Description |
|---|---|---|
| **Cottage (tier 1)** | 96×92 px | Timber cottage: slate roof in courses with moss, plank walls, four iron-oak skid ends showing under the sill (it sits like a barge), warm-lit windows with flower boxes, a lamp by the door, and a **carved fox over the door with its long ear on the left** (Silas's mirror-carving). |
| **Workshop add-on (tier 2)** | overlay on the cottage | A lean-to eave along one side sheltering a workbench and tool rack. |
| **Silas's cottage** | 96×92 px | The same build with a **shingle** roof, sawdust on the step. |
| **Interior back wall** | 224×48 px | Timber-framed limewash wall: a window with a small sill, a shelf of jars, a quarried-stone **hearth with an animated fire** (3–4 flame frames) and Silas's fox on the mantel. |
| **Interior floor** | 16×16 tileable | Warm plank floor. |
| **Campsite (tier 0)** | ~32×24 total | Canvas windbreak, a cot on wooden blocks, a stone fire ring with a small flame (3 frames). |

### Decorations (top-down, sized to their footprint at 16 px per tile)

| Id | Footprint | Look |
|---|---|---|
| `wooden-stool` | 1×1 | Three uneven legs, perfectly balanced. |
| `reading-chair` | 1×2 | Overstuffed, slightly frayed armchair. |
| `braided-rug` | 2×2 | Thick braided wool rug, oval. |
| `iron-lantern` | 1×1 | Small indoor iron lamp, lit. |
| `oak-table` | 2×2 | Scrubbed oak table with tea rings. |
| `potted-fern` | 1×1 | Lush fern in a clay pot. |
| `bookshelf` | 2×1 | Short shelf with field journals. |
| `wash-basin` | 1×1 | Enamel basin on a stand. |
| `stone-hearth` | 2×1 | Small stone hearth with embers. |
| `carved-bed` | 2×2 | Carved wooden bed, patchwork quilt. |
| `woven-basket` | 1×1 | Fibre basket. |
| `display-stand` | 1×1 | Little stand holding a whittled fox. |
| `tool-rack` | 2×1 | Wall rack of hand tools. |
| `amber-sconce` | 1×1 | Wall sconce with a warm amber glow. |

Plus the workshop furniture: **storage chest** (1×1, banded), **crafting bench**
(2×1, vise and offcuts), **mailbox** (1×1 post box with a little flag).

### Commons set

- **The hame on the gate**: a polished empty horse collar hung on the Commons
  gate, large and legible enough to recognize at a glance (it's in the canon).
- **Gate posts and crossbar** for the Commons gateway.
- **Hedge** (tileable straight, corner, end pieces) and **post-and-rail fence**
  (tileable pieces, with a little gateway variant for plot fronts).
- **Plot name sign** (blank board on a post; we draw the name).
- **The carters' well** (stone well, wooden roof, bucket).
- **Notice board** (roofed board with pinned papers).
- **Silas's yard**: sawhorse, timber stack, four skids laid on dirt, firebox,
  toolbox, woodpile.
- **Path edges**: a 16-px cobble/dirt-to-grass transition set (straights,
  corners, ends). Today the 32-px expansion path tiles have grass baked in, so
  lanes use hard edges.

## Priority 3: village life

- **Hearthwick Library**: a 5-tile-wide stone-and-timber reading room with an
  **open-book sign** over the door.
- **Carting Day**: two or three market stalls with awnings and bunting.
- **The Breaking**: candle hulls (walnut-shell boats with leaf sails), 8–10 px.
- **Amberwake**: window-lamp glow overlay for cottage windows.
- **Village project completions**: a **well canopy** (slate roof over the
  village well) and the **mended north bridge** (oak and stone).
- **Paper pickups** (8–12 px, with a 2–3 frame glint): a folded page, a tied
  scroll, a child's slate.
- **Tolley mill** (new; code-drawn stand-in in `src/game/mill-art.ts`). Finn
  Tolley's small watermill on the west edge of the village pond, which the
  river Wend feeds. Seen from the front like the other village buildings.

  | Piece | Native size | Frames | Look |
  |---|---|---|---|
  | `mill-house` | 64×64 (4×4 tiles, bottom-centre origin) | 1 | Weathered upright-board timber walls on a coursed stone footing, slate roof gable-end on, a loft door high in the gable with a **sack-hoist beam and rope**, a plank front door in the **second tile column** (the walk-up tile), a small warm-lit shuttered window, two flour sacks by the door, **flour dust on the step**. Damp, mossy stone where the wall meets the water side. |
  | `mill-wheel` | 32×32, centred | 4 (an eighth-turn; 8 paddles, so it loops) | An undershot wheel on the east wall, its lower edge in the pond: grey, weathered paddles, **one split**, the rim patched. It **groans**: the runtime turns it in fits with a catch and a 1 px jolt, so a frame where a paddle visibly drags would help. |
  | `mill-wheel-mended` | 32×32, centred | 4 | The same wheel after the mill-wheel village project: **new pale paddles**, **rope lashings** at every spoke and an iron band round the rim. Turns smooth. |
  | `mill-froth` | ~14×6 | 2 | White water where the paddles bite the pond (blue-white, light). |
  | `mill-hopper` | 16×20 | 1 | A grain hopper on splayed legs beside the west wall, grain heaped in the top, flour at the spout, and **tallies scratched in clusters of five** down its side (Finn's "Forty-One and Holding" count). |

## Priority 4: the Wilds (optional)

The code-drawn Tangle and Whitequiet already look good; real art would add
polish. Items, all at the 16-px tile scale:

- Turncap clusters (leaning east), cairns (with three white river-stones
  variant), tight-ringed iron-oak stump, dead birch carrying turncaps, fallen
  log, mossy boulder, drift-stone, reed pool.
- **Resource nodes**, available and depleted states: timber (fallen trunk),
  stone (outcrop), fiber (reed/bramble clump), amber (sap-weeping stump).
- **Camp**: small tent, cold fire ring, scattered pack.
- **Fallen-hero lantern**, lit and unlit.
- **Echo props**, each with a faint "echo" variant (pale, slightly transparent):
  a kettle on cold stones with a half-whittled fox (Hollis), a yoke peg (Tam),
  a flat-singer's spot with a dropped kerchief (Bett), a leaning surveyor's
  stake and chalked plank (Dorrit), a dented tin whistle (Joss), a lamplighter's
  pole and unlit lamp (Nan).

## UI icons (16×16, same style)

- **Materials**: timber, stone, fiber, amber.
- **Trinkets**: whittled fox (long ear right: Hollis's), beeswax candle with red
  yarn, river-glass bead, spare bootlace, dented tin whistle.
- **Crafted utility items**: lamp wick, oilcloth wrap, wooden peg.
- **Emotes**: wave, nod, cheer, thanks, lantern.

---

## Items pass

New item art requested for the items and crafting expansion (`docs/items/catalogue.md`, `docs/items/crafting-and-repair.md`, `docs/items/overview.md`). Items with art already delivered in the Commons pass (`assets/generated/commons-pass/COVERAGE.md`) are skipped.

Priorities follow the brief:
- **P1**: Tools, the inventory's most common supplies, keepsakes, and early papers/recipes.
- **P2**: Home goods, lantern posts and their parts, and village world sprites.
- **P3**: Seasonal pieces and seasonal materials.

### Tools

All tool items read at **16×16 native pixels** in the inventory. Cheap tools break at zero wear (~30 uses); heirloom tools become blunt or cracked at zero wear (~80 uses) until mended at a bench. Off-hand items provide visual and functional aids while held.

| Priority | Id | Name | Native size | Frames | Look |
|---|---|---|---|---|---|
| P1 | `bench-axe` | Bench axe | 16×16 | 2 (whole, worn) | Short axe, pale haft, dull grey head |
| P1 | `bench-pick` | Bench pick | 16×16 | 2 (whole, worn) | Pick with a pale haft |
| P1 | `bench-spade` | Bench spade | 16×16 | 2 (whole, worn) | Spade, worn wooden grip |
| P1 | `stave-bucket` | Stave bucket | 16×16 | 2 (whole, worn [loosened hoops]) | Small wooden bucket, two dark hoops |
| P1 | `watering-can` | Tin watering can | 16×16 | 1 | Squat tin can with a long spout |
| P1 | `brack-felling-axe` | Brack felling axe | 16×16 | 3 (whole, worn, blunt) | Long axe, dark ash haft, bright bit |
| P1 | `orrins-mason-pick` | Orrin's mason pick | 16×16 | 3 (whole, worn, blunt) | Pick with a notched haft |
| P1 | `ada-garden-spade` | Ada's garden spade | 16×16 | 3 (whole, worn, blunt) | Short spade, dark polished grip |
| P1 | `nans-lamplighter-pole` | Nan's lamplighter pole | 16×16 | 3 (whole, worn, cracked) | Long pole, brass hook at the top |
| P1 | `oak-mark-punch` | Oak-mark punch | 16×16 | 1 (never wears) | Stubby iron punch, wheel-and-wave face |
| P1 | `carters-lantern` | Carter's lantern | 16×16 | 2 (lit, unlit) | Lantern on a short pole, lit |
| P1 | `turncap-jar` | Jar of turncaps | 16×16 | 2 (fresh [tilted caps], dried out) | Glass jar, three pale caps leaning one way |
| P1 | `salve-satchel` | Salve satchel | 16×16 | 1 | Small leather satchel, a jar lid peeking out |
| P1 | `runners-whistle` | Your own whistle | 16×16 | 1 | Tin whistle with a dent |
| P1 | `forager-satchel` | Forager's satchel | 16×16 | 1 | Canvas satchel |
| P1 | `work-apron` | Work apron | 16×16 | 1 | Leather apron |
| P1 | `carting-coat` | Carting coat | 16×16 | 1 | Long brown coat |

### Supplies

Supplies include craft materials, seasonal forage, tool fittings, building parts, seeds, food, remedies, and lamp oils. (Already covered in `COVERAGE.md`: `timber`, `stone`, `fiber`, `amber`, `lamp-wick`, `oilcloth-wrap`, `wooden-peg`.)

| Priority | Id | Name | Native size | Frames | Look |
|---|---|---|---|---|---|
| P1 | `seasoned-timber` | Seasoned timber | 16×16 | 1 | Split log, paler, a crack in the end grain |
| P1 | `drift-stone` | Drift-stone | 16×16 | 1 | Rounded stone with a faint swirl |
| P1 | `iron-oak` | Iron-oak | 16×16 | 1 | Dark tight-ringed log end |
| P1 | `willow-bark` | Willow bark | 16×16 | 1 | Curl of bark |
| P1 | `beeswax` | Beeswax | 16×16 | 1 | Yellow wax block |
| P1 | `storm-grade-drop` | Storm-grade drop | 16×16 | 1 | Amber drop with a bright core |
| P1 | `tallow` | Tallow | 16×16 | 1 | Pale lump in paper |
| P1 | `flour` | Flour | 16×16 | 1 | Small sack |
| P1 | `wild-honey` | Wild honey | 16×16 | 1 | Comb drip |
| P3 | `walnut-shells` | Walnut shells | 16×16 | 1 | Two half shells |
| P3 | `madder-scraps` | Madder scraps | 16×16 | 1 | Red cloth scraps |
| P3 | `amberfall-sap` | Amberfall sap | 16×16 | 1 | Thin amber trickle on bark |
| P3 | `frost-glass` | Frost-glass | 16×16 | 1 | Pale blue shard |
| P3 | `bloom-flowers` | Bloom flowers / dried flowers | 16×16 | 2 (fresh, dried) | Posy (fresh) / brown posy (dried) |
| P1 | `tarrow-edge-strip` | Tarrow-steel edge strip | 16×16 | 1 | Thin bright metal strip |
| P1 | `loose-road-nail` | Loose road-nail | 16×16 | 1 | Single square nail |
| P1 | `iron-oak-wedge` | Iron-oak wedge | 16×16 | 1 | Small dark wedge |
| P1 | `tyre-iron-hoop` | Hoop of tyre-iron | 16×16 | 1 | Small iron ring |
| P1 | `green-ash-haft` | Green-ash haft | 16×16 | 1 | Pale straight haft |
| P1 | `amber-bead` | Amber bead | 16×16 | 1 | Glowing orange bead |
| P1 | `waxed-cord` | Waxed cord | 16×16 | 1 | Coil of cord |
| P1 | `warden-sliver` | Warden-stone sliver | 16×16 | 1 | Grey stone chip with an amber fleck |
| P1 | `fibre-rope` | Fibre rope | 16×16 | 1 | Coiled rope |
| P1 | `split-rail` | Split rail | 16×16 | 1 | Rough rail |
| P1 | `slates` | Slates | 16×16 | 1 | Three stacked slates |
| P1 | `oak-slat` | Oak slat | 16×16 | 1 | Smooth plank |
| P1 | `lamp-head` | Lamp head | 16×16 | 1 | Small iron lamp head, glass panes |
| P1 | `wax-seal` | Wax seal | 16×16 | 1 | Red-brown wax disc, wheel and wave |
| P1 | `hazel-whip` | Hazel whip | 16×16 | 1 | Thin sapling, round leaves |
| P1 | `birch-sapling` | Birch sapling | 16×16 | 1 | White-barked sapling |
| P1 | `rowan-sapling` | Rowan sapling | 16×16 | 1 | Sapling with a red cluster |
| P1 | `comfrey-root` | Comfrey root | 16×16 | 1 | Knobbly root, two leaves |
| P1 | `wild-thyme` | Wild thyme | 16×16 | 1 | Tiny-leaved sprig |
| P1 | `turncap-spawn` | Turncap spawn | 16×16 | 1 | Pale cap on a sliver of wood |
| P1 | `iron-oak-acorn` | Iron-oak acorn | 16×16 | 1 | Dark heavy acorn |
| P1 | `keepers-twists` | Keeper's Twists (butter batch) | 16×16 | 1 | Twisted bread, golden |
| P1 | `oil-twists` | Keeper's Twists (oil) | 16×16 | 1 | Twisted bread, darker, burnt end |
| P1 | `saltings-tea` | Saltings tea | 16×16 | 1 | Cup, grey-green tea |
| P1 | `oatcakes` | Finn's oatcakes | 16×16 | 1 | Stack of round oatcakes |
| P1 | `comfrey-salve` | Comfrey salve | 16×16 | 1 | Small tin, pale salve |
| P1 | `willow-bark-tea` | Willow-bark tea | 16×16 | 1 | Cup, brown tea |
| P1 | `blue-moss` | A pinch of Blue Moss | 16×16 | 1 | Twist of paper, blue moss poking out |
| P1 | `candle-oil` | Candle oil | 16×16 | 1 | Small corked vial, pale amber |
| P1 | `hearth-oil` | Hearth oil | 16×16 | 1 | Squat flask, warm amber |
| P1 | `storm-oil` | Storm oil | 16×16 | 1 | Stoppered flask with a bright core |

### Keepsakes

Trinkets carried in pockets or displayed. (Already covered in `COVERAGE.md`: `whittled-fox` [Hollis's, right ear long], `river-glass-bead`, `tin-whistle`, `beeswax-candle`, `spare-bootlace`.)

| Priority | Id | Name | Native size | Frames | Look |
|---|---|---|---|---|---|
| P1 | `knotted-halter` | Knotted ox-halter | 16×16 | 1 | Rope halter, knotted |
| P1 | `work-glove` | Work glove | 16×16 | 1 | Single leather glove |
| P1 | `road-nails` | Stamped road-nails | 16×16 | 1 | Small bundle of nails |
| P1 | `mirror-fox` | A mirror-wise fox | 16×16 | 1 | Pine fox, left ear long (Silas's carving; distinct from Hollis's right-ear whittled fox) |

### Home goods

Inventory icons (16×16) for new placeable furniture, working pieces, lovely wall pieces, and seasonal festival goods. Placed world sprites are detailed in the World sprites section below. (The 14 original homestead decorations in `content/homestead.json` already have sprites in `fingersnap-furniture.png`.)

| Priority | Id | Name | Native size | Frames | Look |
|---|---|---|---|---|---|
| P2 | `door-fox` | Door-fox | 16×16 | 1 | Small fox over a door, left ear long |
| P2 | `window-lamp` | Window lamp | 16×16 | 2 (lit, unlit) | Warm square of light in a window |
| P2 | `gate-shelf` | Gate shelf | 16×16 | 1 | Small roofed shelf on a post, jars on it |
| P2 | `writing-desk` | Writing desk | 16×16 | 1 | Slant-top desk, inkpot |
| P2 | `keepsake-cabinet` | Keepsake cabinet | 16×16 | 1 | Glass-front cabinet, small shapes inside |
| P2 | `drying-rack` | Herb drying rack | 16×16 | 1 | Wooden rack, bundles hanging |
| P2 | `apothecary-shelf` | Apothecary shelf | 16×16 | 1 | Shelf of jars, some full |
| P2 | `woodpile` | Woodpile | 16×16 | 1 | Stacked split logs under a little roof |
| P2 | `lantern-post` | Lantern post | 16×16 | 2 (lit, unlit) | Timber post, iron lamp head, lit / unlit |
| P2 | `raised-bed` | Raised bed | 16×16 | 1 | Timber-edged bed of dark soil |
| P2 | `naming-frame` | Naming-slip frame | 16×16 | 1 | Small frame with a slip of paper |
| P2 | `pencil-map` | Pip's pencil map | 16×16 | 1 | Pinned map, pencil lines |
| P2 | `pressed-flowers` | Pressed-flower frame | 16×16 | 1 | Frame with flat flowers |
| P3 | `candle-hulls` | Candle hulls | 16×16 | 1 | Walnut-shell boats with leaf sails |
| P3 | `carting-bunting` | Carting bunting | 16×16 | 1 | Red and cream bunting |
| P3 | `empty-chair` | The Empty Chair | 16×16 | 1 | Plain chair, a sap-gold cushion |
| P3 | `closure-lamp` | Closure Night lamp | 16×16 | 2 (lit, unlit) | Frost-glass lamp, pale light |

### Papers

Inventory icons (16×16) for the Papers tab: naming slips from lantern posts, recipe pages and cards copyable at the writing desk, and found document icons. (In-world pickup sprites are already covered in `fingersnap-papers.png`.)

| Priority | Id | Name | Native size | Frames | Look |
|---|---|---|---|---|---|
| P1 | `naming-slip` | Naming slip | 16×16 | 1 | Narrow paper slip with two lines of ink and post name, your own Ledger of the Road |
| P1 | `recipe-page-tea` | Recipe page: Saltings tea | 16×16 | 1 | Rag paper slip with cup sketch, from Elara |
| P1 | `recipe-page-salve` | Recipe page: Comfrey salve | 16×16 | 1 | Aged book leaf with botanical comfrey sketch, via Mara |
| P1 | `recipe-page-candle-oil` | Recipe page: Candle oil | 16×16 | 1 | Neat library slip with oil flask notation, from Mara |
| P1 | `recipe-page-willow-tea` | Recipe page: Willow-bark tea | 16×16 | 1 | Book leaf of Mother Cotta's herbal with curl-of-bark sketch |
| P1 | `recipe-card-twists` | Recipe card: Keeper's Twists | 16×16 | 1 | Flour-dusted bakery card from Hazel's wall |
| P1 | `recipe-card-oil-twists` | Recipe card: Oil twists | 16×16 | 1 | Darker stained bakery card from Hazel with note on back |
| P1 | `recipe-page-hearth-oil` | Recipe page: Hearth oil | 16×16 | 1 | Ruled ledger receipt leaf from Ada Cooley's window fund |
| P1 | `recipe-page-wax-seal` | Recipe page: Wax seal | 16×16 | 1 | Printed page from Brackenwood handbook, wheel-and-wave stamp |
| P1 | `recipe-page-storm-oil` | Recipe page: Storm oil | 16×16 | 1 | Torn margin from Wenna's ledger, dense dark script |
| P1 | `paper-icon-folded` | Found paper: folded letter | 16×16 | 1 | Folded letter with creased edges and broken seal |
| P1 | `paper-icon-scroll` | Found paper: tied scroll | 16×16 | 1 | Rolled parchment scroll tied with twine |
| P1 | `paper-icon-slate` | Found paper: slate | 16×16 | 1 | Small framed slate tablet with chalked letters |

### World sprites

Sprites placed in the world, sized to their tile footprint (16 px per tile). Covers placed home goods, lantern post assembly stages and variants, and gathering nodes/results (stumps, dug patches, herb clumps, bee trees, windfalls).

*(Already covered in `COVERAGE.md`: `woodpile` world sprite in `fingersnap-yard.png`; `bunting`, `candle-hull-0/1/2` water sprites, and `window-lamp-glow` overlay in `fingersnap-festivals.png`; `iron-oak-stump`, `turncaps-east`, `cairn`, `cairn-white-stones`, `dead-birch-turncaps`, `fallen-log`, `mossy-boulder`, `drift-stone`, and `reed-pool` in `fingersnap-wilds-nature.png`; base resource nodes in `fingersnap-resource-nodes.png`.)*

| Priority | Id | Name | Native size | Frames | Look |
|---|---|---|---|---|---|
| P2 | `door-fox` | Door-fox | 16×16 (lintel) | 1 | Small carved pine fox mounted over cottage door lintel, left ear long |
| P2 | `window-lamp` | Window lamp | 16×16 (window) | 2 (unlit pane, lit warm glow) | Warm square of hearth-light set into cottage window frame; bright amber-gold |
| P2 | `gate-shelf` | Gate shelf | 16×16 (1×1) | 2 (empty, stocked with jars) | Small roofed wooden shelf on a post at the plot gate; jars placed on shelf |
| P2 | `writing-desk` | Writing desk | 32×16 (2×1) | 1 | Slant-top wooden writing desk with open inkpot and copy paper |
| P2 | `keepsake-cabinet` | Keepsake cabinet | 16×16 (1×1) | 2 (empty, displaying trinkets) | Glass-front wooden cabinet with tiny keepsake silhouettes displayed inside |
| P2 | `drying-rack` | Herb drying rack | 16×16 (1×1) | 2 (bare rack, hanging herbs) | Upright timber frame rack with bundled herbs hanging upside down to dry |
| P2 | `apothecary-shelf` | Apothecary shelf | 32×16 (2×1) | 2 (half stocked, full shelves) | Two-tier shelf of glass apothecary jars, showing stock of salves and teas |
| P2 | `raised-bed` | Raised bed | 32×16 (2×1) | 3 (dry dark soil, watered soil, sprouting) | Timber-bordered garden bed filled with rich dark planting soil |
| P2 | `naming-frame` | Naming-slip frame | 16×16 (1×1 wall) | 1 | Small timber wall frame holding your first handwritten naming slip |
| P2 | `pencil-map` | Pip's pencil map | 32×16 (2×1 wall) | 2 (crisp pencil, smudged drift) | Wall-pinned route map drawn in pencil; lines smudge and drift over seasons |
| P2 | `pressed-flowers` | Pressed-flower frame | 16×16 (1×1 wall) | 2 (fresh Bloom colors, dried brown) | Small wooden frame enclosing flat pressed blossom arrangements |
| P3 | `empty-chair` | The Empty Chair | 16×16 (1×1) | 1 | Plain wooden dining chair with an amberfall sap-gold cushion, set for Amberwake |
| P3 | `closure-lamp` | Closure Night lamp | 16×16 (1×1) | 2 (unlit, lit pale blue) | Frost-glass outdoor lantern casting pale cold blue light facing the dark |
| P2 | `lantern-post` | Lantern post | 16×32 (1×1 footprint) | 3 (unlit, lit warm amber, Amberwake glow) | Upright green timber post with drift-stone packed base and iron lamp head; lit burns steady amber; Amberwake burns with wider brilliant halo |
| P2 | `lantern-post-footing` | Post footing with drift-stone | 16×16 (1×1 footprint) | 1 | Timber post stub set in excavated ground packed tightly with drift-stone (construction stage 1) |
| P2 | `lantern-post-head-unlit` | Post with unlit lamp head | 16×32 (1×1 footprint) | 1 | Complete timber post fitted with iron lamp head and dry wick, awaiting hearth oil (construction stage 2) |
| P2 | `old-lamp-stone` | Old lamp-stone | 16×16 (1×1) | 2 (intact weathered, pick-broken) | Ancient weathered stone lamp base in the Tangle containing loose road-nails and salvaged lamp head |
| P1 | `dug-patch` | Dug patch | 16×16 (1×1) | 2 (fresh dark earth hole, settled earth) | Churned dark dirt hole left after harvesting saplings, herbs, or turncap spawn with the spade |
| P1 | `tree-stump` | Cleared tree stump | 16×16 (1×1) | 2 (fresh cut with pale sawdust, weathered) | Flat plain tree stump remaining after chopping pine, birch, hazel, or ash on homestead land |
| P1 | `herb-patch-comfrey` | Wild comfrey patch | 16×16 (1×1) | 2 (lush leafy plant, dug earth patch) | Low leafy comfrey clump with knobbly roots and small bell flowers |
| P1 | `herb-patch-thyme` | Wild thyme patch | 16×16 (1×1) | 2 (purple thyme sprigs, dug earth patch) | Low creeping fragrant thyme clump with tiny leaves and mauve flowers |
| P1 | `hollow-tree` | Hollow bee tree | 16×32 (1×1 footprint, 2 tiles high) | 2 (intact tree with hive hole and bees, opened hollow with comb drips) | Gnarled hollow woodland trunk sheltering a wild hive; dug with spade for wild honey and beeswax |
| P1 | `standing-iron-oak` | Standing iron-oak | 32×48 (2×2 footprint, 3 tiles high) | 2 (unmarked ancient trunk, stamped with wax seal) | Massive ancient iron-oak tree; struck with oak-mark punch before warden-felling |
| P1 | `iron-oak-windfall` | Iron-oak windfall | 32×32 (2×2 footprint) | 2 (mossy fallen trunk, harvested stump with 3 leafy branches) | Heavy storm-felled iron-oak log; leaves three leafy branches at stump when felled |
| P1 | `stump-turncaps` | Homestead turncap stump | 16×16 (1×1) | 2 (sprouting caps, mature leaning caps) | Wood stump seeded with turncap spawn that tilt toward the player's home lantern post |
| P2 | `ledger-soup-pot` | Ledger soup pot | 16×16 (1×1) | 2 (bubbling steaming pot over fire, cold/empty pot) | Large black iron cauldron simmering over embers in the village square for project workers |
