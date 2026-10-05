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
