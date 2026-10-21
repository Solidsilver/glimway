# Terrain, regions and the first three biomes — Sol

*2026-10-21. Independent design response to `terrain-brief.md`, against branch
`exp/terrain-design-sol` at `2b536e8f`. Design only; numbers below are proposed starting values,
not benchmark results. I read the two earlier ideas files specified by the brief, not the
other terrain response. Neither AGENTS.md nor CLAUDE.md was present in this worktree, its
ancestors, or the source checkout; `docs/agent-workflow.md` supplies the workflow rules.*

## Recommendation

Build a lasting terrain plan underneath the weekly generator. It owns regions, contours,
cliff footprints, ramps, passes and guaranteed access. The weekly pass adds plants and things
within its constraints. Keep the height lab's screen-space geometry and matching-edge walking
rule. Make woods genuinely permeable, make the Tops a few long ridges with broad shoulders,
and make the Whitequiet pale country with ordinary terrain rules for now.

The first deliverable should be an ugly but exact, held-land-aware reachability view in the
existing world lab. The hardest part is preserving every old opening while cliffs consume
ground rows, not painting a mountain. Prove that before commissioning the full art set.

This brief supersedes the older iteration order: terrain and these three biome definitions
now; caves immediately afterward; then water. No lake-country biome, cave generator, new
creatures, Whitequiet disorientation or new traversal ability in this round.

## 1. Fields, regions and pins

### Lasting inputs

All coordinates below are world tiles; one chunk remains **24×24 tiles**. Use integer/fixed-point
noise on the server, with named salts independent of the weekly seed. Sample beyond the world
border normally. No field depends on the current ±4,096-chunk limit.

| Field / plan | Starting scale | Purpose |
|---|---|---|
| Upland `U` | 32–64 chunks, secondary variation 8–16 chunks | Broad low country and uplands; no one-hill-per-chunk rhythm |
| Wetness `M` | 16–32 chunks | Dry/moist ground and canopy potential; not a water-placement mask |
| Warmth `T` | 64–128 chunks | Retained climate coordinate for future biomes; slight vegetation bias now, no snow rule |
| Quiet affinity `Q` | 32–64 chunks | Sparse Whitequiet regions; independent of wetness and danger |
| Ridge owners | 16-chunk grid; bounded footprint up to 24×12 chunks | Elongated, bent ranges, shoulders, saddles and valley walls |
| Local relief / hollow owners | 1–4 chunks; small bowls 8–32 tiles | Broad benches, shallow valleys and future pond/tarn sites |
| Grove / exposure potential | 12–48 tiles, derived exposure over 8–24 tiles | Coherent vegetation and treeline, with weekly occupants |

Use a small number of octaves, not all fields at every octave. Keep `U/M/T/Q` in a versioned
`WorldFields@1` recipe. Exposure comes from resolved ridge/height geometry. A later pressure
field belongs alongside these, not inside biome selection; lamps never change biome or height.

### Ownership without circular borders

Separate **biome regions** (roughly 32 chunks across) from woods/meadow patches (roughly 1–8
chunks). Today's land cells are smaller: `content/wilds.json:885` sets `landCellChunks` to 7.
The two scales should not become one mechanism.

Give each 32-chunk lattice cell a stable region id `(world, rx, ry)` and a jittered site within
±6 chunks of its centre. Region ownership uses nearest-site squared distance **without dividing
by site size**, after a bounded coordinate warp (up to 4 chunks, wavelengths 8 and 24 chunks).
Tie-break by signed `(ry, rx)`. Evaluate a bounded 5×5 site window, including for negative
coordinates. Equal-distance boundaries before warping are straight; a smooth warp bends them
without the size-weighted circles in `lands.go:176–199`. Do not retain the forced hem whenever
two same-kind patches meet (`lands.go:257–276`): adjacent woods can remain woods.

The site lattice/id/warp recipe is frozen separately from the catalogue of available biomes.
At pin time, sample a fixed 5×5 set of field points around the site and select, initially:

- `whitequiet@1` if mean `Q > 0.80` and a stable eligibility draw passes;
- otherwise `tops@1` if mean `U > 0.62`;
- otherwise `hearthwick-woods@1`, including meadow as its open land cover.

Tune thresholds against area coverage, starting near **65% woods/meadow, 25% Tops, 10%
Whitequiet** across large atlases. These are tuning targets, not quotas forced into each map
window. Adjacent same-biome regions form larger country. The existing named Whitequiet
footprint remains and seeds a Whitequiet neighbourhood outside its protected boundary.

Height is world-wide: a Whitequiet can have a low scarp, and a woods valley can run through
the Tops. Biome selection chooses ground, canopy and the character of relief; it must not
multiply height by a categorical biome switch and create a wall along the region edge.

### What a pin must freeze

Proposed persisted records, outside wick epochs:

```text
world_region_pins(world, rx, ry,
  biome_id, biome_version, fields_version, landform_version,
  catalogue_revision, recipe_digest, pinned_at)
world_terrain_plans(world, owner_kind, owner_x, owner_y, revision, digest, plan_blob)
world_terrain_legacy(world, layer, cx, cy, geometry_blob, source_digest)
```

The pin names immutable content **and** the generating code/parameters. `tops@1` cannot mean
whatever today's mutable `content/wilds.json` says. Versioned entries expose a small interface:
`GroundPalette`, `CoverWeights(fields, geometry)`, `DecorWeights(habitat)`, and policy such as
`AllowCamp`. Keep general height/access generation shared. New entries get new version names;
new biome kinds enter only unpinned regions.

Before serving a chunk or a visible map glimpse, atomically pin every region whose recipe can
affect it, including blend and bounded feature support. Start with the containing region and
its eight lattice neighbours; prove the support bound, extending this set if the geometry says
it is insufficient. Pinning metadata does not recursively generate those neighbours' chunks or
their neighbours' plans. Shared boundary contracts use only these direct inputs, not recursively
resolved neighbouring interiors. Sort ids before insertion, resolve concurrent inserts with a
unique key, then generate from the rows that actually won.

A cheap glimpse may therefore pin country without storing chunks. Lab previews use a disposable
pin manifest and never pin the real world. Serving order within the same catalogue revision
must produce identical geometry. Across a release, first exposure intentionally decides which
available biome version a region receives.

**Cost of the promise:** larger areas freeze than players walk; old recipes/code remain
supported; content fixes that move terrain need a new version; plans and legacy constraints
survive epoch deletion. At most roughly 66,000 lattice cells cover today's whole border, so pin
metadata is manageable, but terrain-plan blobs need explicit storage accounting. Keep stored
chunks for this round. Do not combine terrain with the proposed storage-elision optimisation.

### Blending

One pinned region owns each tile. Compute a signed border-distance band from the shared
ownership map, width **16 tiles total** initially (tune 12–20). Freeze the two biome versions
and blend recipe involved. Mix compatible ground and canopy using coherent 3–6-tile patches,
not independent per-tile coin tosses. Do not blend categorical gameplay, blocked edges or height.

Woods → Tops: bracken and trees thin into grass, heather and exposed stone, following height
and shelter. Woods → Whitequiet: a readable pale margin, at most 4 tiles, with the quiet
region's palette staying distinct; never tint the hero pale. A cliff provides a justified sharp
edge. At three-region junctions use normalized local material weights but retain one owner and
its policies. Pinning neighbouring recipes in advance prevents a newly added biome from
repainting the already-seen side of a blend.

## 2. Height, routes and proof of access

### Geometry, before paths

Keep a single surface at layer **0**, flat levels **0–3**, and fractional heights on ramps.
Layer and elevation are separate: the future cave is layer **−1**, with its own elevations;
surface level 1 does not become another layer. No extra actor `z` authority is needed: derive
it from position and the terrain. Position/presence validation still needs to use the same
geometry when it checks interactions.

Construct an initial continuous structural field, for example
`H = 0.20 + 0.60*U + ridgeLift + localRelief - hollowDepth`, with ridge lift up to 2.4 levels,
local relief ±0.20, hollow depth 0.15–0.45. Quantize at 0.8, 1.6 and 2.4 into levels 0–3.
The exact formula is a lab control, frozen with the terrain recipe after tuning. Ridge plans
use bent polylines and several shoulders, not stretched circular blobs. Valleys remain wide:
start with 8–24 walkable tiles at the foot, shoulders 12–40 tiles, isolated level-3 crowns.

Resolve tiny terrace slivers in the **owner plan**, with at least 4 tiles of usable bench where
a bench is intended. This is not a per-chunk smoothing pass. Bowl floors can remain at one
level; retain their continuous relief as a drainage tie-breaker for the water round.

Use the lab's actual screen-space convention: a south-facing drop consumes **3 ground rows per
level**, up to 9 rows for 3→0. Those rows are faces, not hidden walkable valley. North edges
get a dark rim; east/west edges get side treatment; all block mismatched edges. The lab states
this contract at `src/game/height-lab/levels.ts:5–15`, and derives south faces in
`src/game/height-lab/area.ts:186–209`.

Derive face footprints from structural tops over a **12-tile minimum halo**, then allocate
ramps/approaches; never derive only inside the target chunk. If faces overlap or erase a
bench, settle the contour in the owner plan before clipping. A later chunk cannot independently
resurrect the floor. Keep both structural top and resolved surface kind, so the water round
can distinguish a hillside from the face drawn in front of it.

### Ramps and the walking contract

Use four edge heights per tile in the logical model. Closed is a sentinel; crossing requires
both edges open and **exactly equal in the fixed-point encoding**. `solid` still says whether
the tile has any usable floor; it cannot say whether a particular edge is passable. The lab's
`step` implements the rule at `levels.ts:127–138`; its foot-box checks at `levels.ts:194–230`
also matter. Point connectivity alone does not prove a wide hero or mount fits.

Plan passes before routing trails. Start with a low saddle or a route around a range's end;
refine with contour-biased A*: flat step 1, climb cost 6 per level, ramp construction surcharge,
and infinite cost for protected land, uncut faces and reserved incompatible footprints. A
route can request a new ramp on editable terrain; repainting path ground never opens a cliff.

Initial main approaches are 2 tiles wide, widening to 3 where two players should pass. Ramps
rise no faster than **one level in 4 tiles**; longer multi-level ramps are allowed. Rough
switchbacks may narrow to 1 tile if the real foot-box test passes, with a 2×2 passing bay near
a bend. Built stairs and rough ribs/scree are material/style choices over identical topology.
Use the lab's `trail` and `ramp` semantics (`area.ts:213–264`): adjacent switchback legs do not
connect sideways merely because they touch.

For a 16–24-chunk range, start with one principal saddle crossing and a second route around
an end or over another saddle. Do not force a notch every chunk or every ridge segment.
Climbs and ways home last across turnings; only minor path wear and optional lesser tracks turn.

### A bounded connectivity plan, not a flood fill of the world

Proposed hierarchy:

1. **Region access graph.** Every region has a transit anchor. Its lattice id chooses a parent
   closer to `(0,0)` in Manhattan distance (stable hash chooses among reducing axes). This
   gives a connected backbone with a decreasing-distance proof. Add a deterministic subset of
   other cardinal neighbour links, starting at one third, and promote links until each interior
   region has at least two incident regional links. The region around home joins its anchor to
   real town gates. Minimum degree alone does not prove loops: explicitly close a small cycle
   around each principal range crossing, and verify its alternative route on the realized graph.
   Border regions still join inward. Regions are access domains, not cages. If jittered sites
   make a selected lattice pair nonadjacent in the ownership map, realize its link across the
   intervening region with explicit boundary contracts; never invent a shared border.
2. **Shared link owner.** The sorted pair of region ids owns one crossing contract: tile/world
   position, floor/edge heights, width, approaches and recipe digests. Choose low-cost crossings
   on the shared warped border, not its midpoint. Route through valleys, around ranges or through
   chosen saddles. Existing roads, fords, lamps, held exits and fixed gates are mandatory anchors.
3. **Region plan.** Route these links on an 8-tile coarse grid (roughly 96×96 samples per nominal
   region) against structural terrain; select ramps and connected-component assignments. Exact
   geometry includes the region's bounded fringe. A region may cross several chunks without
   opening any particular chunk edge.
4. **Exact refinements.** Split storage/work into 4×4-chunk cores (96×96 tiles), with a 24-tile
   halo and shared crossing contracts between cores. A core can have several components; each
   must map to a connected regional component, not necessarily join the others locally. Otherwise
   the partition would force a pass every four chunks. Solve shared core boundaries first;
   refinements cannot change them. Final connected-component certificates use the actual edge
   and foot-clearance graph, and union through identical boundary portals.
5. **Repair before publication.** Join isolated usable ground with a ramp, bench or scrub
   opening. Reject a decorative isolated shelf if connecting it would destroy the range. Never
   delete a mandatory anchor or its approach. Recheck the exact graph after every repair.

The parent construction proves global access only **if every planned link is realized**. A
coarse A* line is not that proof. Publish a terrain plan only when its exact component summary
shows every walkable surface component attached to the regional graph, and every mandatory
anchor attached through its required existing opening. Traversal is bidirectional; no one-way
slides or mandatory jumps. Decoration may not invalidate this certificate. Recheck the final
weekly collision graph and remove offending new blockers, never silently carve a new cliff.

Weekly blocking cover is settled by the same refinement owners and shared boundary contracts,
not repaired independently inside each chunk. Reserve the certified access forest and its
clearance mask before placing trees. For each refinement, reject optional blockers that leave
any remaining floor component without a connection to that forest or its certified portals.
Boundary blockers are decided once by their shared owner. Cache the result for the wick and
clip it into chunks; no per-chunk repair can change a shared edge after its neighbour is served.

Remove `gapAt` and chunk-interior path carving only when this replacement ships with its proof.
Today's `dryReach` starts at open chunk edges (`detail_v3.go:171`), and `ensureReach` joins or
closes local ground (`detail_v3.go:745`); neither proves region access with height. The existing
lab treats cropped render boundaries as reachable (`worldlab/render.go:279–284`); label that
view “local components”, not a home-reachability certificate.

**Cold planning is the budget risk.** A region has about 590,000 tiles before its warped fringe;
do not run its exact solve inside each chunk generation. Persist compact plan geometry and
certificates, share refinements, and prefetch upcoming regions inside the existing sight/make
guard. Prepare at low priority with bounded work, no unbounded recursive neighbour generation.
An unexpected first arrival waits for a completed plan; it never gets temporary flat terrain.
Measure cold-plan latency separately *and* include it in end-to-end first-read percentiles.
Provisional cold-region target: 250 ms p95, warm chunk generation: the existing 5 ms p95. The
cold target is a proposed additional allowance needing the owner's decision, not a claim that
it meets today's budget. If the first spike cannot meet acceptable first-read latency, reduce
plan size/work before proceeding; do not hide it by reporting only cache hits.

### Held land and saved players

Copying two ground/solid columns, as `base_v3.go:698` does today, is insufficient for height.
Treat old held chunks, still Tangle terrain, authored chunks, lamps, camps and player overlays
as protected constraints. Old bodies lacking heights decode as level 0. Keep the old interior
and every existing open edge; create compatible landings and connectors entirely on the new
side. At corners solve all affected sides together, not first-neighbour-wins.

At the one-time conversion, snapshot legacy geometry and edge contracts permanently, including
any new-side apron needed to connect it. Pin the affected owners before generating the rest.
A normal new hold freezes already-certified geometry, so it adds no new terrain dependency;
when it lapses, that same skeleton remains. Legacy constraints must not disappear with a hold,
or regeneration would change neighbouring seen terrain. Large legacy islands can force a
level-0 valley through a new range; access wins, and the lab shows that compromise.

Before conversion, enumerate saved outdoor positions and active sessions. Protect each old
valid foot position with a connected landing in the new plan, including space for its foot box;
use a short connector if it would otherwise become a face. Reload clients at the new contract
before movement resumes. For an already invalid save, use the existing arrival recovery, but
find ground in a certified home-connected component, not just the nearest zero solid bit.
Never relocate a valid saved player to a random bank or use teleportation to conceal failed
terrain access. Player-laid ground and objects also reserve their actual footprints/approaches.

### Leaving room for water and caves

Export a server-side `TerrainSample` with structural top, resolved kind, geometric elevation,
flat-floor residual relief, hollow owner, face lip/toe, ramp footprint, protected approaches and
low-point/spill candidates. Water will work from the **resolved** geometry, not the obsolete
raw noise. Within a flat terrace residual relief orders drainage; it can never justify flowing
up an actual level or against a ramp's rise. Face spans expose ordered lip-to-toe elevations
for future waterfalls. Do not solve drainage or preselect lakes now.

Leave broad troughs, closed bowls and outlet notches; do not fill all depressions to make A*
easy. A path avoids a bowl floor when a modest contour detour exists. Candidate hollows are
not future guaranteed water: a new hold or placed building can disqualify one. Water may later
fill compatible unheld hollows and add shallow channels, but may not move pinned levels, ramps,
held land or required access. If it cuts a required route, it must supply a lasting valid
crossing or choose another water feature. This keeps the terrain intact while allowing the
next round's visible water additions; “seen land never changes” freezes the skeleton, not the
absence of as-yet-unbuilt systems.

Keep the existing Wend/ford geometry as a protected level-0 reach during this round, sampling
its frozen V1 recipe; route new relief around it. Do not leave the current infinite-cost water
strip painted across high plateaus. The water round can integrate it as an existing reach and
honour its fords. A discretionary Wend move should happen before terrain pins are released,
not become another later reroll of seen heights.

For caves, retain face identity, bounds, orientation, structural cover height and approach masks.
Reserve suitable unoccupied south faces and occasional east/west faces; a north-side opportunity
is a future sink on a flat/slope, never a hidden north-facing mouth. Surface access must work
without a future tunnel. Do not allocate cave rooms, mouths or cave pathfinding in this round.

## 3. Three biomes and the land near home

| Biome | Land and height | Initial cover and plants |
|---|---|---|
| `hearthwick-woods@1` | Green low country, mostly 0, some level-1 shelves; broad meadows and wooded valleys | Existing oak, birch, pine, bracken, flowers and turncaps in stands. Woods are walk-through forest with dense pockets, not solid land cut into corridors. |
| `tops@1` | Broad level-1 moor and benches, level-2 ridges, rare level-3 crowns, low valleys between | Valley copses; sparse pine/birch on sheltered shoulders; heather and grass high up; bare rock/lichen on crowns. Dry talus below faces; no snow assumption. |
| `whitequiet@1` | Pale, open, hushed country, mostly 0–1; an occasional stone shoulder | Restrained ivory grass and grey soil, sparse pale birch silhouettes and bare snags. Warm heroes and lamps remain legible. No new forage, memory rewards or special movement yet. |

Provisional Tops height-area mix: 20/45/28/7 percent at levels 0/1/2/3 before face consumption.
Low country should be over 85% level 0. Judge usable floor as well as raw height histograms:
a nice contour image can conceal an unwalkable mass of faces.

Implement the minimum of rules 8–17 needed to make these biomes honest now:

- **8, country before paths:** replace `woods.thicketPermille = 1000`
  (`content/wilds.json:683`) with grove-based cover. Start at 15–25% blocked forest floor,
  with denser pockets, and let certificates settle exact access. Meadow blockers start at 3–8%.
  Ordinary walking connections need not all be painted paths.
- **9, restraint:** quiet stretches are normal. Stop automatically placing a special in every
  place cell in new terrain. Start with at most one optional landmark per 8×8-chunk owner;
  reserve plot/approach shape first. Do not add encounters for scenic density.
- **10–11, edges and groves:** use the blend band and lasting canopy potential, with weekly
  small trees/scrub inside it. Reuse existing silhouettes; avoid a new mother-tree stamp.
- **12–14, room and landmarks:** preserve old named places. New landmarks are optional and
  reject bad sites rather than flattening cliffs. Count dry 6×6 and 8×8 usable footprints with
  two approaches; tune for a few plausible homes per region, not a clearing every chunk.
- **15, treeline:** a smooth exposure/height multiplier, roughly 1.0/0.55/0.15/0 at levels
  0/1/2/3 in the Tops, modified by shelter. Do not use four literal vegetation stripes.
- **16–17, stone and toes:** outcrops follow actual ridges; sparse loose stone within roughly
  4 tiles beyond a face's visible foot. A dry face stays dry. Wetness permits a little moss;
  springs, reeds and wet-foot lushness wait for real water. Access/readability masks win.

Generate habitat tags such as grove, sheltered hollow, exposed ledge, dry toe and safe approach
from this same geometry. Keep them server-side or recomputable from plans until the life lane
uses them; do not add a creature simulation or new roster. Existing encounters require reachable
flat space and must not block a pass. **Suppress fight camps in Whitequiet** as the already
settled owner policy; zero weights alone are unsafe because `gen_v3.go:279–283` falls back to
tier weights. Do not implement the ideas partner's slips, looping coordinates, glades or penalties.

Let new biomes reach the unheld surrounds of Hearthwick and the Tangle at the authorised 0.14
conversion. Preserve Hearthwick's fixed layouts and lots, every still Tangle body, fixed story
sites, holds and player things. There is no blanket old-country ring, but keep the gate apron
level 0 for at least one chunk, with no cliff concealing the way out. Retain the existing
soft/feather/keep-out intent (`seams.go:30–38`), extended by actual sprite bounds. Put the first
modest shoulders within roughly 3–6 chunks so dev walks can reach height quickly; locate a
Tops showcase further out without forcing a full mountain against town walls.

## 4. Wire, versions, storage and migration

### A compact height contract

Extend **WorldChunk**, not deprecated WildsChunk. Slots 2/12/15 and the old names `region`,
`exits`, `spawn` are reserved (`proto/glimway/v1/wilds.proto:40–63`). Proposed new fields,
using fresh numbers 25 onward after checking at implementation time:

```text
25 TerrainHeight height     // omitted => legacy flat level 0
26 uint32 landform_version
27 repeated BiomeRef biome_palette  // id + version + pinned region id
28 bytes biome_index        // 2 bits/tile, max 4 region owners/chunk
TerrainHeight:
  bytes tops                // 2 bits/tile, structural top 0..3
  bytes kinds               // 2 bits/tile: flat, face, slope, reserved
  repeated HeightOverride overrides
HeightOverride:
  uint32 tile_index
  uint32 open_mask          // N/E/S/W; includes blocked flat edges if necessary
  sint32 north_q, east_q, south_q, west_q
  uint32 style              // natural / built
```

`q` is **1/256 level**; absolute edge values, not local interpolation fractions. Flat floors
derive four equal edges from their level; faces derive four closed edges. Overrides provide
the exact final edges for slopes and exceptional restrictions. Adjacent plan segments quantize
their shared edge once; independently rounding each ramp length is forbidden. Derive south
face rows/top from the halo's tops; validate against kinds. If compact derivation cannot
represent an owner-plan face unambiguously, add a sparse face record, not a second height guess
in the renderer. Reserve signed heights for caves later without spending full float arrays
on the wire now.

At 576 tiles, tops/kinds/biome indices cost **144 bytes each**, 432 bytes total. About 48
overrides at roughly 16–24 bytes each add 0.75–1.1 KiB, plus palette/header overhead. A compact
whole chunk should remain below **6 KiB encoded protobuf**, not compressed HTTP size. These
are estimates: measure dense ramps, triple blends and legacy aprons. Do not truncate required
ramps to meet a quota. Reduce optional decor first, simplify a plan before pinning second; if
mandatory geometry still breaks budget, revisit encoding. Cap sparse complexity in generation,
not by losing movement data on serialization.

Keep ground's existing 4-bit per-chunk palette (`wilds/proto.go:45–59`), with a hard ≤16-ground
validation and curated compatible biome combinations. Do not silently overflow it in a three-way
blend. The four-owner limit also needs validation; the bounded site jitter/spacing makes it
plausible but is not a proof. If the spike disproves it, use byte biome indices from the start
(another 432 bytes) rather than merging distinct region identities.

Validate lengths, enum ranges, tile ordering/uniqueness, override masks, height bounds and
`solid` consistency on both ends. Missing height on an old stored body means flat zero; missing
height on a new terrain generator's body is an error. An unknown new height format must fail
loading, not be played as flat. Border/chunk seam comparisons use decoded edge values.

### Versions and migration

Keep **LandformV1 frozen at 1** (`epoch_v3.go:72–82`). Add a new selectable `LandformV2`
terrain recipe; do not change the old constant and globally rehash everything. New-region
plans record V2; legacy islands explicitly retain V1 geometry, including the old Wend source.
`GeneratorVersion` becomes V4 for the changed weekly chunk assembly. A later dressing V5
must reuse those terrain plans byte-for-byte. Biome version, terrain version and weekly
generator version solve different problems.

The epoch table currently selects by generator version, and replacing a same-season epoch
can cascade old data (`store/chunks.go:116–126`, `229–234`). Therefore a safe migration is
more than deleting unheld chunk bodies as 039/040 did:

1. Prepare and dry-run against a disposable database copy. Inventory held/still chunks,
   player positions, lamps/camps, fixed openings and persistent overlays, including same-wick
   holds. Save source digests and baseline connectivity fixtures.
2. In the actual conversion transaction, write world-level legacy geometry/approaches, protect
   all player-built overlays, pin affected regions, and preserve old still/held bodies and
   their state. A generator bump must not create a newly generated Tangle over the preserved one;
   composition resolves the existing permanent source explicitly.
3. Retire eligible unheld old bodies for the one authorised change. Clean state belonging to
   replaced generated object ids, following 040's distinction between generated ids and named
   places. Transfer retained player overlays and their epoch references explicitly before stale
   epochs can cascade. Preserve named discoveries and held object state. Never reuse old
   positional entity ids for different new objects with old claims attached.
4. Build and validate legacy transition plans and saved-position access before switching active
   composition to V4. A failed mandatory connection aborts the conversion, not the next player's
   walk. Fresh unrelated regions are planned on demand.
5. Bump the content/client cache contract; clear affected in-memory caches and invalidate browser
   chunk/paint caches. Include terrain revision in plan, paint and effective-ground cache keys.
   Reconnect old clients; do not let mixed contracts walk through new cliffs.

After conversion, pins and plans outlive turnings. Continue storing per-wick bodies until
regeneration with held neighbours and lasting geometry has independent evidence. Today the
store passes all nearby holds, including same-wick holds (`store/chunks.go:366–399`); keep
that coverage and add the terrain-plan constraint manifest rather than guessing an old neighbour
with current code. Missing held blobs remain an error (`store/chunks.go:299–306`).

## 5. Bringing the height lab into the game

Reuse the pure edge-height, `zIn`/`zAt`, ramp/trail and foot-box algorithms as a shared terrain
module, with matching Go vectors. Reuse procedural cliff/stair/rough-slope art functions after
separating them from the authored lab area. The lab's finite `Layer[]` world and its scene are
not the streaming-game architecture.

The real client currently decodes ground/solid arrays in `wilds/terrain.ts:95–115`; chunks
attach ground, merged solid collision and sliced scenery through `wilds/window-chunk.ts:3–25`.
Extend that pipeline rather than replacing WorldScene with the lab scene:

- Decode compact terrain into typed arrays for attached chunks plus halo. Add world-coordinate
  `edgeAt`, `step`, `zAt` and `fits` lookups; unavailable neighbour terrain is closed until loaded.
  Preserve the pinned active-window cache behaviour. Sweep dash/ride movement in small steps so
  it cannot skip an edge. Apply the rule to click routes, remote interpolation and arrival recovery.
- Keep static solid bodies for trees/faces where useful, but make edge-aware foot-box movement
  authoritative for hero traversal. Update all flat-only `solidAt` consumers that decide access.
  Server fight-room terrain, line-of-effect, melee reach, knockback, spawning and interaction
  checks must agree: matching x/y on different floors does not create a fight or gather reach.
  Treat levels along a connected ramp continuously; do not simply compare rounded actor levels.
- Bake ground and faces per chunk with a halo in the paint worker. Use bounded per-level ground
  masks for surface fog, continuous height for movers, and correct world-y sorting for cliff
  lips and trees. Do not vertically translate the hero again: the lab already gives cliffs
  their screen-space footprint. Approaches and screen-projected sprite bounds protect readability.

Copy the accepted look: fog at levels above **and below** the hero, with medium starting curve
`clamp((abs(dz)-0.3)*0.42, 0, 0.72)` (`height-lab/look.ts:86–96`), continuous ramp transitions,
and the lab's restrained climbing haze/zoom. Fog reveals silhouettes; it must not conceal
the next ramp step. Per-level baked masks avoid a second live sprite for every tuft. Tall
moving actors can use the lab's overlay treatment at a bounded count.

Reuse `height-lab/lighting.ts` as the lighting core: ambient plus light sources, one multiply
pass, tile-cached occlusion with a separately updated continuous height penalty. Rewrite its
finite-world backing maps as bounded per-chunk static bakes and a viewport-sized compositor;
do not allocate a lightmap for the world. Adapt outdoor carried/communal lamps to its source
interface and avoid layering an old darkness effect over the new pass. Rooms/windows can
migrate separately; don't expand this lane into day/night work.

**Cave compatibility to preserve, not build now:** opaque cave material; brightness-only depth
darkening, cap initially 60%; live-lit floor clipped through a mouth; Even entry with a 3-tile
view fade; None/Close/Wide own-light modes; built/rough slopes; round-4c wall-corner distance
fix. Keep the lab's dev controls. Cave topology, portals and their streamed view come in the
next round, using these interfaces, not an interim incompatible fade.

Phone acceptance targets: terrain/lighting incremental CPU **≤2 ms p95** on a representative
phone, no large attach-frame stall, bounded textures released on chunk/scene removal. A
384×384 RGBA chunk image is about 0.56 MiB; four fully allocated level images are 2.25 MiB
per chunk, about 20 MiB across the attached 3×3 before other art. Crop sparse levels, omit
empty images, and measure zoom-out/window pressure. The lab's sub-millisecond CI light time
is evidence of feasibility, not a phone result. No per-tuft animation, new decorative lights
or whole-region CPU crossfade.

## 6. World-lab views and evidence

Extend the existing glim-dev world lab and CLI; no new lab application. Keep isolated worker
processes, cancellation and existing concurrency/resource limits (`worldlab/lab.go:23–48`).
The current render path calls `GenerateV3(..., nil)` (`worldlab/render.go:145`), so a pretty
seed render currently says nothing about stored held-land compatibility.

| View / overlay | What it should answer |
|---|---|
| Atlas: biome ownership, region ids/pins, fields | Are regions broad enough? Are borders still arcs? Where are old/new recipes? |
| Region: structural contours and resolved levels | Do long ridges, valleys and bowls survive face consumption? Show level area and usable floor separately. |
| Faces, ramps, pass owners and approaches | Which plan caused this cliff/ramp? Are slope styles/readability masks correct on all orientations? |
| Exact components and access graph | Which certified route gets this floor, lamp, gate and held opening home? Show broken links red; cropped/unknown connectivity grey. |
| Legacy / overlays / saved positions | What was preserved, where did a transition valley get forced, and can each saved foot box leave? |
| Hollow/low-point/residual relief | Is there room for a future pond/tarn/outlet? No blue water that the generator has not actually made. |
| Cover, habitat and build footprints | Is forest walkable away from painted paths? Are ramps/mouth candidates clear? Where do 6×6/8×8 homes fit? |
| A/B geometry diff | Changed levels, edges, solid, biome owner, approaches and persistent objects, separately from weekly decor changes |

Add explicit generator/landform/biome recipe selectors: today's diff compares seed/content,
not executable generator versions (`worldlab/lab.go:128–144`). Use two retained version
implementations or separate versioned workers. Export a complete pin/legacy/plan manifest with
seed, digest and rules so an agent can reproduce the image. Support a read-only actual-world
snapshot; workers never mutate the gameplay database. Pure-seed and actual-world modes must be
labelled clearly. “Go here” lands only on certified open ground and uses the existing dev warp.

Acceptance evidence per candidate: 256×256-chunk atlases, 32×32-chunk region crops, tile views
across seams, JSON metrics and PNGs at reproducible coordinates. Include negative coordinates,
border corners, long north/south/east/west cliffs, triple biome junctions, long/turning ramps,
an old same-wick hold fixture, diagonal held corners, gate apertures, saved-player-on-new-face
fixtures, and two weekly seeds over the same terrain. Check generation in shuffled chunk order,
concurrent first pins, cold/warm processes and across a turning.

Required counters: all mandatory links realized; unreachable walkable components **0**;
changed protected geometry **0**; saved valid players without egress **0**; mismatched shared
edges **0**; encoded bytes p50/p95/max; chunk generation p50/p95/p99/max; cold region preparation
and end-to-end first-read time; plan storage; optional repair count/area; gate-to-pass detours.
Report path detour relative to straight distance, but don't impose a global low ratio that
would remove meaningful ranges. Walks in the actual game at phone size remain the readability
test; a map screenshot cannot prove rule 5.

## 7. Build lanes and gates

Sizes are focused engineer-days, excluding owner review and art iteration; roughly **16–25
days total effort**, with parallel work reducing elapsed time. Split large lanes into small
reviewable commits. Each lane has something the owner can see or walk.

| Order / lane | Rough size | Viewable or playable result and gate |
|---|---:|---|
| A. Exact geometry/access spike | 3–4 days | Lab shows one generated ridge, all four cliff orientations, multi-chunk ramps and real legacy hold fixtures. Establish encoded format, cold cost and exact component certificates first. Fail fast on inaccessible held exits or hidden floors. |
| B. Fields, regions and immutable pins | 2–3 days | Lab atlas with three biomes, no circular size-weighted arcs, disposable pins, A/B manifests. Prove pin races, catalogue updates and unchanged seen blends. |
| C. Bounded terrain plans and lasting access | 4–6 days | Lab region plans with ridges, bowls, two route choices and final weekly cover. Replace edge gaps only when exact links and component unions pass. Meet measured budgets or resolve the cold-plan allowance. |
| D. Wire and streaming client | 4–6 days | Walk A's saved terrain fixture, then C's server terrain in-game: cliffs stop every movement mode, ramps rise continuously, proper fog/light and level-aware interactions. Phone evidence and no seam/cache regressions. |
| E. Biome dressing and art integration | 2–4 days | Actual game woods/meadow, Tops and pale Whitequiet, restrained cover and safe approaches; lab habitat/build plots. Existing art first, a small cliff/ramp/ground palette next. |
| F. Conversion and release evidence | 1–2 days | Upgrade a disposable old-world snapshot, walk every protected fixture, compare before/after, repeat at turning; owner playtests on dev after the orchestrator merges. |

B can start while A proves geometry. After A freezes edge/wire semantics, D can work against
exported fixtures while C implements plans; art work can proceed against the same fixtures.
E depends on B/C's masks. F's migration rehearsal starts early, but active conversion waits
for C/D/E. One lane owns protocol semantics; independently changing quantization or collision
in two branches is the main avoidable integration risk.

Use the project's dev shell and low-priority checks. Generator lanes run Go correctness tests,
meaningful property tests and cold/warm benchmarks; client lanes run shared-vector tests and
`npm run verify`. Browser movement/screenshots run in CI, not on this development host. Push
each exp lane, watch its CI to completion, then the orchestrator reviews/merges; only the owner
deploys. Terrain sign-off unblocks the cave round, then the water round. Neither is smuggled
into the terrain lanes to make the first mountain walk seem more complete.

## 8. Risks and owner decisions

| Risk / question | Recommendation |
|---|---|
| Does 5 ms p95 include the first exact region plan? | Keep 5 ms for chunk generation; explicitly allow a bounded prefetched preparation stage, provisionally 250 ms p95 cold, and report full first-read latency. A proves whether these sizes are viable before the architecture commits to them. |
| What does “seen land never changes” mean while water/caves are still arriving? | Freeze biome identity, levels and access now. Add later systems only where compatible; held/player land and required routes win. If the promise instead forbids any later visible addition, defer permanent pins until the terrain/water combination is signed off. |
| How much old unheld terrain gets its authorised 0.14 change? | Convert all eligible unheld surrounds once, including near home; preserve still/fixed/held/player-built land. Keep saved valid positions as connected landings. Show a migration diff before release. |
| Legacy preserves can make awkward flat cuts through mountains. | Accept a visible transition valley. Never alter a hold or close an existing opening for prettier relief. |
| Can the initial map be mostly low country, with rare level-3 tops? | Yes: start at 65/25/10 biome area and 7% level-3 area within Tops. Tune long walks and skyline readability, not a mountain in every screen. |
| Is Whitequiet mechanics-free in this slice? | Yes: pale terrain, distinct region, no fights as already settled. Leave disorientation, fog limits, waking islands and memory rewards to their own brief. |
| Can a ridge have a principal pass and a longer alternative, rather than many ways up? | Yes. Require regional loops and two route choices around major ranges; not two climbs to every summit or an opening on every chunk edge. |
| Should the Wend move before these pins become permanent? | Keep its existing reach this round. If the owner wants a move, decide and include it in the same one-time conversion before sign-off; don't promise a later unrestricted reroute. |
| Quantization, face footprint and phone cost may disagree with the pretty lab. | Matching Go/TS movement vectors, exact geometry fixtures and a phone walk are release gates. Simplify decoration and optional contour complexity before changing the accepted height model. |

The main calls are the cold-plan allowance and the scope of permanence while water is pending.
My recommendation is to settle both after lane A's measured spike, then commit to the pinned
terrain plan: broad country, a few memorable ridges, and a provable ordinary walk home.
