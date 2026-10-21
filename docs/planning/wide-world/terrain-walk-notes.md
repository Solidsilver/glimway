# Walking the new terrain (exp/terrain-walk) — notes

*2026-10-21, Claude Opus 5.5. The owner asked to walk the new terrain rather than only see it in
the world lab, under both of lane A's access strategies at once. Dev only: GenerateV3, the
protocol, the database and the normal game world are untouched; nothing pins or saves.*

## Short answer

- **Height lab → Area → Near home (generated).** A real 15×13-chunk window round home on the
  `map` seed (chunks −3..11 by −9..3; 360×312 tiles), from the north half of Town and the Tangle
  up past the named Whitequiet place to the level-3 wall in the north, and east over the
  shoulders to the Tops. You spawn at Town's north edge.
- **Heights are lane B's fields.** Tops 0–3 come from Upland, roughened by Relief
  (`wilds.TerrainWorld`, the spike's single `TerrainFields.Top` hook). The spike's south-face
  stencil and exact 1/256 edges are unchanged.
- **Both strategies, same samples, switched in place.** Dev panel → *Near home, the way up*:
  **Region plan / Per-chunk repair**. The hero stays where they stand if it's floor under the
  other strategy, else moves to the nearest floor that reaches home.
- **On this real window** the region plan certifies (0 stranded, 6/6 anchors, 288/288 held exits)
  with **8 ramps**; per-chunk repair cuts **64 ramps** and strands **one component of 2,012
  tiles**: the three held chunks on the shoulders, with their landings (3/6 anchors, 0/288 held
  exits reach home). Natural country strands nothing under either strategy here; only the
  held fixtures do. That's a finding (see below).
- **Overlay**: *Near home, stranded ground and chunk lines* tints stranded floor magenta and
  draws chunk lines. The HUD's first line says the strategy, biome@version, region id and level.

## How to walk it

1. glim-dev, open the dev panel → **Height lab** → *Walk the height lab*.
2. **Area → Near home (generated)**. The HUD says "generating the window on the server…" for a
   few seconds the first time (2.7 s in CI); after that, switching is instant.
3. **Near home, the way up → Region plan / Per-chunk repair**: the same country, solved two
   ways. You stay where you stand.
4. **Near home, stranded ground and chunk lines → On** to see what per-chunk repair cuts off
   (magenta) and where the chunk seams are. *Levels overlay* still shows levels, slopes and faces.
5. The HUD's first line: `Near home — <strategy> · <biome@version> · <region> · level <z>`, with
   "· stranded" when you stand on cut-off ground.

Window tiles below are as the lab counts them (origin at world tile −72, −216); world tile =
window tile + (−72, −216). Directions are from home.

| Where | Window tile | World tile | From home | What to look for |
|---|---|---|---|---|
| Home (spawn) | 84, 246 | 12, 30 | — | Town's north edge, Tangle to the north. |
| Whitequiet edge | 84, 167 | 12, −49 | ~80 tiles N, through the Tangle | Woods turning to ivory grass, pale birch and snags. Same under both. |
| Per-chunk ramp | 177, 198 | 105, −18 | ~95 E, ~50 N | **The clearest difference.** Per-chunk repair cuts a short ramp up the level-1 shoulder's face here; the region plan leaves the face whole, so you walk round to its ramp. Per-chunk repair does this along every contour (64 ramps against 8). |
| Held chunks | 215, 179 | 143, −37 | ~130 E, ~70 N | Three old flat chunks sunk into the level-1 shoulder. Region plan: reachable by a ramp. Per-chunk repair: stranded (magenta with the overlay). |
| Ramp to the Tops | 295, 107 → 295, 112 | 223, −109 | ~210 E, ~140 N | A region-plan ramp from level 2 to 3 near the Tops; climb it south. |

## What was built

- **`wilds.TerrainWorld`** (`server/internal/wilds/terrain_fields.go`): `Top(x, y)` from
  `UplandAt`, plus a dissection term (two value-noise octaves, 40 and 14 tiles) scaled by
  `Relief` to ±320‰, cut at 300 / 600 / 780‰ into levels 1 / 2 / 3. Integer field reads; the
  only arithmetic is integer too. Town, the Tangle and a chunk round them are level 0 (Upland is
  0 there), the 3–6-chunk shoulders mostly level 1 (Upland is capped at 480–580 there), and the
  Tops climb to 2 and 3 past six chunks.
- **`wilds.NewTerrainWindow`** (`terrain_window.go`): any chunk-aligned window in world chunk
  coordinates, the spike's `TerrainLocal` stencil read through a world-coordinate offset (so
  seams are the world's), fixtures gathered before landings as in the spike. *Region plan*:
  the spike's repair over the whole window, batched (each pass carves the best ramp per pair of
  components that don't touch, then recomputes the exact certificate). *Per-chunk repair*: the
  spike's per-chunk interior repair (2..21), unchanged.
- **The walk window** (`TerrainWalkSpec`): chunks −3..11 × −9..3. Fixtures: Town's and the
  Tangle's chunks protected flat; three held chunks at (5,−2), (6,−3), (6,−1) (two diagonal
  pairs, lane A's corner case on real ground); a saved 2×2 foot position on a chunk rim inside a
  face (window 28, 120); anchors home, Tangle, the three held chunks, the saved spot.
- **The endpoint**: `POST /api/dev/worldlab/terrain-walk {seed, epoch}` in the world lab
  (`server/internal/worldlab/walk.go`), run in a worker like every render (nice, time and memory
  limits, cancelled with the request, cached). It returns both strategies' kinds, tops, exact
  edges, face rows and flags, plus the shared ground, cover, water, biome@version and region per
  tile, the certificates and named spots. Rules can't be edited for it.
- **Dressing**: each chunk's GenerateV3 ground through `BiomeTileLook` (lane B), so the biome
  grounds and cover are the world lab's. Cover becomes the lab's props (oak, pine, birch, snag,
  boulder, thicket, fern). The woods' thicket maze is thinned to about a third in coherent
  stands, a light dressing; no cover on faces, ramps, the two tiles round a ramp, or protected
  ground. Town is plain meadow with paving (it isn't generated). Water is shut.
- **The lab** (`src/game/height-lab/walk.ts`, `scene.ts`, `art.ts`): the area is built from the
  answer in about 30 ms; it's too big to draw at once, so the scene builds the chunks round the
  hero (ground images per level, faces, props, levels overlay) and drops far ones, at most two
  a frame. The biome grounds are painted with the Wilds painter and tinted toward lane B's
  colours. The climbing haze is lighter here (levels 2–3 are ordinary upland, not a summit; at
  the hand-made areas' strength it greyed out the whole Tops). Every option from cave-levels.md
  "Paused" is still in the panel; the hand-made areas' e2e spec still passes.

## Window and timings

| | |
|---|---|
| Window | 15 × 13 chunks, 360 × 312 tiles (112,320) |
| Region plan solve | 222 ms here, 241 ms on CI |
| Per-chunk repair, whole window | 203 ms here, 213 ms on CI |
| Tops / dressing | 76 ms / 670 ms (GenerateV3 for 175 chunks plus biome looks) |
| Worker total | ~1.2 s; answer 5.1 MB of JSON (base64 planes) |
| First arrival in the browser | 2.7 s (CI), then cached by the server and the page |
| Client build | ~30 ms; first chunks ~0.5–0.8 s ("built in" on the HUD) |

The window was sized for the client, not the solver. The batched region repair is far under the
spike's 0.7 s per 160 chunks because this country is broad terraces with few components to join.

## Stranded counts on this window

| | Region plan | Per-chunk repair |
|---|---:|---:|
| Ramps | 8 | 64 |
| Components | 1 | 2 |
| Stranded components / tiles | 0 / 0 | 1 / 2,012 |
| Anchors reached | 6 / 6 | 3 / 6 |
| Held exits reaching home | 288 / 288 | 0 / 288 |
| Rejected optional floor | 0 | 0 |

The 2,012 stranded tiles are the three held chunks (1,728) and their landing ring: their
landings sit in the neighbouring chunks' two-tile rims, which a chunk's private repair can't
cut through. **Natural country on this window strands nothing under either strategy.** The
saved foot position on a rim is reached under both (it happens to sit in level-0 ground that
reaches home). So on real `map` country the difference you feel is mostly **how many ways up
there are**: per-chunk repair gives a short ramp in nearly every chunk a contour crosses,
the region plan as few as connect everything, so you walk further to climb. The measured region
solver only guarantees reach; a production region plan would also lay ramps along the ways
between places (Sol's design), so its sparseness here is the solver's, not the strategy's.

## Screenshots

From CI run 39681205382 (e2e full, `e2e/height-lab-walk.spec.ts`), in
[lab/terrain-walk/](lab/terrain-walk/), with `summary.json`:

| Image | Shows |
|---|---|
| `overview-region.png`, `overview-chunk.png` | The whole window by level (green 0, light green 1, tan 2, ivory 3), faces dark, ramps orange, held chunks cyan, stranded magenta, chunk lines, the spots as crosses. Made with `EXPLORE=dir go test -tags dev ./internal/worldlab -run TestExploreWalkMap`. |
| `region-home.png` | Spawn: Town's meadow and paving, the woods north of it, Wren. |
| `region-whitequiet.png` | The Whitequiet's southern edge: woods below, ivory grass, birch and snags above. |
| `chunk-chunk-ramp.png` / `region-chunk-ramp.png` | The same face: a per-chunk ramp cut through it / the region plan's unbroken face. |
| `chunk-levels-overlay-chunk-ramp.png` | The same per-chunk ramp with the levels overlay (green slope). |
| `chunk-overlay-stranded.png` / `region-overlay-stranded.png` | A held chunk with the overlay: magenta and "stranded" on the HUD under per-chunk repair; plain under the region plan. Chunk lines dark. |
| `region-ramp-climb-0/2/4.png` | Up the region plan's ramp to the Tops, level 2 → 2.65 → 3, the lower level fading behind. |
| `phone-home.png` | The HUD line on a phone, below the game's top stack, not over its buttons. |

## Notes for production

- Floating-point: none in the new height path (fields and dissection are integer); the lab
  client converts 1/256 edges to floats only to walk them, as the hand-made areas do.
- `TerrainWorld`'s thresholds and dissection are a first guess for feel, not a recipe to
  freeze: they'd need a version (LandformV2) and their own determinism tests across seeds.
- The window is finite: components touching its edge are joined inside it, which a real region
  plan wouldn't assume. The certificate is height only: cover and water don't enter it (the
  dressing keeps them off ramps and landings, and props aren't placed at a cliff's lip or foot).
- The region repair here is the spike's measured solver, batched; it isn't the coarse
  A* / refinement design, and it doesn't lay routes.
- Woods cover is thinned for walking. The dark "woods" ground stays where its thicket was
  thinned, so the woods read darker than their trees.
- At level 2 and up the lab's own "higher land is stonier" tint and per-level fog still grey the
  view; *Levels above and below fade to → Nothing* shows the raw ground.
