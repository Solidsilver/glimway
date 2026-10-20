# Review: twelve rules for land that feels real

2026-10-20. Review only, against HEAD `8b4b5d8e`; direction check against cached
`origin/exp/open-world` at `2066af79`. `wilds/` means `server/internal/wilds/` throughout.

Retain all twelve intentions, but change most absolutes. The largest missing rule is to make
walkable country first, then lay trails through it. Better ecology around today's carved woods
network will still look like corridors with a room at each junction. Water and contour routes
need shared plans, not scatter constraints.

**What the real generator establishes**

`wilds/gen_v3.go:GenerateV3` checks the epoch and footprint, then `world.chunk` builds the base,
clears places/sites/entities, connects paths, adds woods features, repairs reach, and dresses
the result. Chunks are 24×24 tiles. `content/wilds.json` gives woods a `thicketPermille` of
1000, meadow 80, place cells three chunks across, and landmark clearings of radius three or
four. Each eligible place cell gets one landmark. `wilds/routes.go` links every pair of
neighbouring place cells and attempts one three-tile gap per chunk edge. `detail_v3.go:layPaths`
connects mouths and points to a network or hub. Those are strong sources of the repeated
junction/clearing rhythm, even with jitter. The south cutoff in `cells.go` and `routes.go`
removes places, routes and gaps beyond it; open meadow can still exist there. It is specifically
woods that loses its access network.

I built this checkout's database-free lab at `nice -n 10`, with two build workers. Renders used
one worker, seed `map`, epoch `t:1795000000:1796209600` and current content (SHA-256
`f99e11efed031881c63c2ace1455c5418988796d7e0cc4bb66431429fdb20601`):

- North, inclusive chunks `-8,-12,7,-1`: 192 generated chunks, 32.51% solid, 61.46 camps and
  9.38 places per 100 chunks; reported render time 405.9 ms.
- South, `-8,5,7,12`, place-cell/reach overlays: 128 chunks, 33.09% solid, 47.66 camps and 4.69
  places per 100 chunks; reported render time 203.2 ms.

I inspected both PNGs. The northern woods visibly have a dense branching corridor mesh; the
southern sample has broad dark woods with connections stopping below the old limit. Both report
zero locally unreachable walkable tiles. The lab treats components touching the image boundary
as reachable, so this does not prove access from town or a pleasant walk. These are diagnostic
samples, not population estimates or p95 timings; render times include encoding and the jobs
overlapped. PNG/JSON: `/tmp/land-rules-sol-{north,south}.png`.

The open-world branch removes those south checks, replaces reach with the ±4,096 border, and
introduces `LandformV1` in `epoch_v3.go`. It keeps the four-way place links and edge gaps. Its
Wend also gets a finite southern tail; it is not yet a drainage network. Opening the south
therefore fixes access, but does not itself fix the corridor rhythm.

**Constraints shared by every proposal**

- A chunk can sample world-coordinate fields and bounded feature plans outside its box; it need
  not generate or fetch neighbouring chunks. Give each feature a coordinate-based owner and id,
  enumerate every owner whose bounded footprint can overlap the chunk, resolve overlaps by a
  stable order, then clip to the chunk. Use floor division west/north.
- Base geometry already samples context: `base_v3.go:fill` uses a five-tile pad. Its two-tile
  edge band is immutable to local carving. New cliffs, shores, ramps, groves and halos must be
  decided by shared fields/plans where they cross that band. Do not merely clip an interior pass
  and hope its neighbour makes the matching half.
- Strict purity is the target, with an existing exception: `GenerateV3` accepts stored `Kept`
  edges, including held chunks from another wick. `base_v3.go` mirrors them and repairs held
  corners. Keep staged storage; do not discard chunks on an assumed new purity proof. Lab
  renders pass no persisted held edges and cannot validate that case.
- Lasting climate, rock, water, height, passes and cave plans use the landform seed/version;
  living populations and decoration use the wick seed. Current `Epoch.landform` still includes
  `GeneratorVersion`; the open-world split is the necessary first correction.
- Biome pins are resolved inputs to generation, not permission for first-reader randomness. Pin
  the dependency halo too, as the synthesis requires. Shared rivers/pass contracts need their
  own lasting version and ownership across `biome@version` boundaries; a new neighbour's biome
  implementation must not rewrite a previously pinned shore or crossing.
- The border limits service and walking, not field sampling. Evaluate required halos past ±4,096
  without serving those chunks. Do not seed geography from distance to the current border:
  widening it must not relocate seen land. Audit 64-bit intermediate products in `geom.go`,
  especially long segments; local segments beat a line spanning the whole world.
- Bound work by tiles and nearby owners, never distance walked or explored-world size.
  `budget_v3_test.go` has an opt-in p95 target of 5 ms/chunk and a 6 KiB raw size check. Treat
  these as existing constraints to revisit explicitly for heights, not measured headroom for
  twelve new passes. Measure cold plans, warm plans, allocations and bytes.

**1. Water obeys gravity and carves its bed — change.**

Keep connected, intelligible water; replace “exclusively downhill” with “never uphill, with
level reaches and named sinks.” Four visible levels cannot express a fall every tile. Lowland
springs and closed lake sinks are valid; oxbows and a sea are not prerequisites for rivers in
0.14. Today `wend.go:newRiver` makes one lasting midpoint-displaced polyline with smooth noisy
widths; it knows no elevation, tributaries or outlet lake. `base_v3.go` paints its banks and
makes fords where turning routes intersect it. Width currently expresses noise, not upstream
flow. `landform_test.go` deliberately groups water and ford together.

For iteration 2, prefer river-first design: each bounded lasting lake plan may own a few inlet
lines with explicit spring endpoints. Store a finer water-head value along each line,
non-increasing toward the lake; rendered levels are a coarse quantisation of it. Constrain the
surrounding heightfield to put the channel below its banks, permitting flat reaches. Select
waterfall drops and their screen-space face corridors in that same plan. Never paint water over
independently finished terraces. Confluences share one head, endpoint and feature id; widths
depend on planned branch weights, not new dice. A feature may span several chunks and biome
regions; all use the same owner plan. This is authored drainage logic, not erosion simulation.
It is enough for credible lakes.

If far rivers need actual catchments in iteration 5, use a bounded coarse drainage solve: start
with independent 64×64-chunk drainage domains, unrelated to 32-chunk biome regions. At one node
per chunk, about 4,096 nodes cover a domain. Give each one an interior terminal lake and shared
high watershed boundaries. Run a deterministic flood outward from the lake, raising depressions
to their spill head and recording a parent toward the lake. Break equal-head ties by flood order
and coordinates: every parent has an earlier rank, so flat drainage cannot cycle. Accumulate
coarse rainfall in reverse parent order, once, then retain sufficiently large branches. Carve
channels to that drainage head; the solve's filled surface alone is not evidence that the
original rendered terrain drained downhill. Branches may cross ordinary chunk and biome
boundaries; they terminate inside their own drainage domain. Rasterise the resulting lasting
lines through bounded segment lists.

Initially this forbids cross-domain rivers, risking excessive closed basins and visible
watershed squares. Warp shared divides, query nearby owners and inspect a large atlas. Do not
independently solve overlapping windows: changing the window changes the outlet. A later
inter-domain network needs a coarser acyclic outlet graph with shared boundary ports and known
inflow summaries; two neighbouring “pick the lowest exit” rules can cycle. Do not claim global
tributary widths by recursively visiting an unbounded upstream tree. The existing Wend needs an
explicit compatibility plan, not an unexplained splice.

Cost: the coarse flood is O(N log N), accumulation O(N), with roughly hundreds of KiB of
arrays/heap per plan depending on representation. Those are estimates, not timings. Cache a
bounded number by seed, lasting version and domain; cold reconstruction must remain bounded and
identical. Warm chunks sample only overlapping segments and local masks. A slow cold solve needs
bounded preparation or simpler lines; caching alone is no fix. At the world edge, clip the view
behind the border veil, not the underlying plan; widening reveals the continuation without
rerouting it. Lab: add flow arrows, finer head, lake ids, catchment ids and terminal markers.
Probe every retained edge for rising head, cycles, unmatched seam endpoints and unlabelled dead
ends; check confluence widths and horizontal lake surfaces, then time cold/warm generation.

**2. Rain shadows and wet toes — change to conditional wetness.**

A cliff foot can collect seepage and scree, but need not be wet. South/east orientation alone is
not a rainfall model. A rain shadow belongs to a large ridge and prevailing wind; a local rock
face does not justify adding another climate simulation. Today `lands.go` has directional land
weights and river meadow lean, not climate or relief; `detail_v3.go:wetNear` checks nearby
water/blocked tiles and is not a soil-moisture field. Build a lasting moisture modifier from
wetness, shore distance, concavity and cliff-toe position; dry rock toes remain dry. A cheap lip
exposure modifier supplies the contrast. Take these from shared height/feature samples before
turning moss and ferns are scattered; cache masks once per chunk plus halo, rather than
searching every cliff for every tuft. Do not flatten toes for plants. Cost is a few local
samples per tile, with the shared halo. Lab: wetness/toe/exposure overlays; compare fern density
at equally wet toes, lips and control flats, and count lush patches with neither water nor a wet
climate explanation.

**3. Treelines thin with height and wind — keep, with biome-relative height.**

Today `detail_v3.go:tree` selects tall decor by land weight, uses more snags outside, and
substitutes oak when an iron-oak would overhang a path. There are no height data in
`wilds/chunk.go:Chunk`, so there is no actual treeline. Use a lasting canopy-potential mask from
continuous upland, climate and exposure before quantising levels. Level 1 is not inherently
alpine; a low plateau can remain wooded. Taper density and silhouette size together; retain
sheltered copses and lasting habitat. Cost is local sampling. Apply the mask to base solidity
too: removing tree sprites from solid “forest” leaves invisible walls. Make rock faces
explicitly rock. Use shared halo samples for edge stands. Lab: canopy/solid share and tree-size
counts by height and exposure, plus treeline seams and several epoch comparisons. Look for a
smooth thinning rather than three striped belts.

**4. Mother-trees and saplings — change to mixed-age groves and correlated scatter.**

One parent per stand makes another repeated stamp; retain lone trees, dead gaps and coppice.
Today `base_v3.go:thicketAt` already clumps meadow solids. `detail_v3.go:dress` selects many
trees tile by tile, but also attaches roots to oaks, aligns logs beside paths and favours
undergrowth at woods edges. It is not wholly independent random confetti. Make lasting grove
potential and a few exceptional old-tree anchors on a coarse owner grid; draw turning
sapling/scrub patches within it, with broad wind bias rather than fixed arcs. Sample
neighbouring owners within a bounded maximum crown/grove radius, including across chunks; stable
candidate priorities prevent overlap outcomes depending on generation order. Shade plants use an
agreed art-light direction and moisture, not an unexplained north rule. General trees may turn;
only deliberately named old anchors belong to the lasting skeleton. Replace existing clutter
with groups instead of adding saplings on top of every tree. Cost: a small owner list and local
density samples; caps on tall sprites and colliders. Lab: grove centres/canopy masks, tree
pair-distance and empty-gap distributions, and count correlation peaks at 24 tiles. A seam
should not reveal where a grove was clipped.

**5. Clearings form around old things — change to specific, asymmetric reservations.**

`detail_v3.go:clearPlace`, `clearSite`, `clearEntity`, `bare` and `blocked` already do much of
this. Landmarks are excluded from ordinary scatter by `landmarkKinds`. Today's clearings also
help create the “room at every junction” look; universal flower circles amplify it. Separate
collision clearance, approach visibility and optional decorative edge treatment. A tree wants
shade, a ruin can have bushes behind, and a lamp needs a legible approach. Stamp bounded
approach masks before paths and decor, shaped by purpose and terrain. Reject an unsuitable
landmark candidate instead of flattening a shore, face or ramp. Lasting landmarks have lasting
reservations; turning camps reserve only turning detail. Cross-edge reservations must use owner
plans, not today's interior-only `clearPlace` loop. Lab: footprint/approach overlays, blocked
approaches, art overlaps, clearing area by kind, and repeated ring-shape counts. Inspect
silhouettes as well as collision footprints.

**6. Trails and roads are lazy walkers — change the scope and the graph.**

`routes.go:newRoute` currently displaces a line between place-cell endpoints, avoids kept boxes,
and lets `base_v3.go` ford the Wend at intersections. Local `stepCost`, `layOne` and
`fixed.go:cheapest` already do weighted routing, but without height or regional saddles. Plan
sparse destinations and shared pass/ford ports first, from lasting terrain. Route between them
on a small coarse graph in a canonical bounded region-pair corridor; sort endpoints and
tie-breaks identically. Refine to tiles only along that corridor using the actual
edge-height/ramp graph. The height spike's open-edge rule matters: equal tile centres alone do
not prove a step is legal. Reserve switchback faces and passing landings. Use hard prohibitions
for deep water and shut cliff edges, costs for slopes/wet soil. Choose or construct an explicit
ford, bridge or pass rather than letting every intersection turn deep water into shallows. If no
legal route fits, reject that link/candidate and select a bounded fallback already allowed by
the macro access plan; never carve an arbitrary ramp. Lasting roads/crossings keep their
alignment; animal trails and unheld footpaths may turn. A 32-chunk region is 768 tiles wide:
coarse search first is a budget requirement. Query all corridor owners overlapping a border
chunk; neither chunk chooses its own exit. Lab: route cost, ascent, detour ratio, junction
degree, crossings/pass ids, failed links and cliff-edge violations. Probe town-to-region access
and report repairs separately.

**7. Ecotones, not hard biome lines — keep, with one owner and compatible mixtures.**

`lands.go` already warps patch borders, inserts other-land hems between same-land patches, and
leans rivers toward meadow. `dress` still picks one land's weights at a tile. This is a strong
starting point, but hems are not moisture-driven woods-to-shore succession. Retain one pinned
biome owner per location; derive a lasting blend weight from the shared boundary and use it for
compatible ground/decor probabilities and gradual canopy density. Try 12–20 tiles as a tuning
range, not a universal width; wet shore follows lake geometry, and a rock scarp can justify an
abrupt edge. Do not blur deep-water collision into meadow. Use world-coordinate patch noise for
small incursions, with no per-chunk boundary RNG. Read both pinned biome versions and their
shared transition contract through the dependency halo. New catalogue entries must not change a
seen neighbour's weights on the next read. Cost: bounded nearby biome samples and a small
compatible palette, not running both full generators. Keep Whitequiet recognisable; a readable
sharp boundary can be intentional. Lab: owner/blend overlays, transition width and sprite mix by
boundary distance, same-land hem density, plus seams between old/new pinned versions and across
negative coordinates.

**8. Geology comes in seams and erratics — change “exclusively” and “diagonal”.**

`content/wilds.json` weights boulders, stones and outcrop landmarks by land; `dress` places low
blocking meadow decor and bank stones. There is no bedrock/strike or talus model. Use one
lasting coarse rock field with a slowly varying direction shared by ridges and outcrops. Bands
can curve and stop; fixed diagonal stripes would be conspicuous on a map. Talus clusters belong
below exposed rock faces, modified by slope and wetness; rounded water stones belong on banks;
occasional isolated erratics are exactly the exception. Try four tiles of talus measured from
the screen-space face foot, below its face rows. Lasting large outcrops constrain solidity and
building; small loose stones can turn. Shared line owners and toe halos make this seam-safe and
border-independent, with local sampling cost. Keep talus clear of reserved ramps and cave
approaches; do not add blockers in the final dressing pass after reach has been certified. Lab:
strike/toe masks, boulder orientation against ridges, talus distance histogram, isolated-rock
frequency and extra detour introduced by rock footprints.

**9. Animals and monsters live near food and shelter — keep; coordinate with the life lane.**

`gen_v3.go:placeEntities` draws per-chunk counts, tries dry interior positions, relaxes spacing
and adds place-specific entities. `fillEntity` combines land and tier weights. Creatures are
chosen before final tree/log dressing, so “spawn near deadwood” cannot just inspect the current
output at that point. `wetNear` also excludes many waterside spots. Generate cheap lasting
habitat masks first: reed edge, grove/deadwood potential, ledge, sheltered hollow, exposed
slope. Use turning candidates weighted by these masks and pressure. Then dress their
surroundings consistently. Actual fallen logs can alternatively be planned before both passes.
Avoid a circular creature-needs-log-needs-creature rule. Use coarse population owners with
bounded neighbour competition and regional caps. A reed bed need not have a camp per chunk;
absent habitat should mean fewer spawns. Keep safe approaches, combat space, layer/level reach
and escape routes as hard checks. Whitequiet's no-fights direction overrides tempting “dark
hollow” monster weights. Cost is mask lookup plus capped candidate trials; live movement/ecology
is separate. Lab: habitat suitability and pressure overlays, rejected candidates, density per
habitat area rather than per chunk, habitatless spawns, and threats at ramps/mouths/return
routes.

**10. Human ruins follow logistics — keep, without compulsory sightline spacing.**

`cells.go:place` chooses a spot clear of river/road, then a land-compatible weighted kind; it
knows no resource history. Generic POIs in `fillEntity` draw from one flat list. `road.go`
already orders lasting lamp stones along a road, spaced every two chunks in content, but the
road has no terrain-cost model and a finite 40-chunk reach past its bend. “Never two dark in a
row” concerns people tending lamps, not generated darkness: all these generated lamp stones
begin dark. Do not silently relight some to satisfy realism. Choose a sparse lasting historical
purpose from resource/terrain potential, then reserve its site and access. A saw-pit needs
haulable wood and dry working space, not mandatory placement in a floodplain. Use likely
enduring resources rather than this wick's trees. Route stones refer to road/pass/ford ids and
facing direction. Use bends and occasional reassurance, without requiring every stone in sight.
Use terrain/resources → destinations → roads → roadside remains, with shared owners/plans. Few
candidates keep this cheap; border widening must not re-seed existing sites. Lab:
purpose/resource/access links, orphan ruins, stones facing the wrong connection, walked spacing
distribution and encounters per minute. Empty stretches are allowed.

**11. Screen-space readability at cliff lips — keep; replace fixed two-tile setbacks.**

`detail_v3.go:overhangs`, `tree` and `Decor.Overhang` already recognise art over a walkable
tile. `vocab.go:DecorArt` records pixel width/height; `src/game/wilds/window-chunk.ts:scenery`
registers fading occluders and batches flat decals. There are no generated cliff faces yet. Use
sprite bounds/approach direction, including crowns anchored in the chunk south, to protect
ramps, cliff feet, fords, mouths, heroes and telegraphs. Two tiles is only a guess. Ivy must not
suggest a traversable edge where collision says no. Faces need their whole southward extent: at
levels 0–3, a drop can consume nine rows. Build the necessary height/feature and art halo;
today's five-tile base pad is not a blanket proof that future face/occlusion queries have enough
context. A mask from lasting geometry filters turning decor candidates; moving the hero should
not regenerate the terrain. Cost is local rectangle/mask checks and capped tall props. Both
height reports describe fog twins as a prototype cost; round 2 has about 2,900 objects in its
mountain scene and no phone GPU measurements. Naturalism should not multiply those objects with
dense ivy. Lab: projected art/face/entrance bounds, hidden approach tiles and prop counts. Its
present flat-colour PNG cannot judge the final game art, fade, fog or phone draw time; those
need an in-game walk. Cave daylight should follow walked distance from mouths as in round 2.

**12. Lasting skeleton, turning skin — keep; make the skeleton include access.**

`epoch_v3.go` and `landform_test.go` preserve land patches, border warp and Wend water across
seasons; `road.go` keeps its road by seed. Places, routes, gaps and decoration currently use
turning hashes, and the generator-version coupling remains in this checkout. A memorable saddle
waterfall also needs its stable outlet, waterfall id, pass and reliable crossing. Otherwise the
view lasts but the route home disappears each week. Put lakes, channel geometry, bedrock,
heights, carved ramps, principal passes, cave masks, mouths and major historical landmarks on
lasting plans. Let lesser paths, ordinary trees, forage and populations turn. A bridge being a
player structure is a separate persistence rule; generated geography must not consume or move
it. Store player changes as overlays. Keep cave depth as heights within one cave layer by
default, as round 2 recommends; extra layers are for genuine overlapping passages. Do not
confuse floor height with layer. Versions and shared boundary dependencies must be fixed
together; a biome pin alone cannot protect a river plan whose algorithm or content tables
changed. Retain old implementations. Immutable plans cost storage/cache. Clean breaks before 1.0
are allowed; promise no automatic preservation across arbitrary upgrades. Retain held/fixed land
exceptions. Lab: a skeleton-only multi-epoch diff and a separate living-detail diff. Probe
unchanged lake ids, water/ford distinctions, ramps, mouths and crossing connectivity, including
held neighbours. Today's full tile diff changes decor/entities too, so is not this proof.

**What the twelve miss**

- **Scale and restraint.** Give each walk broad masses, smaller subareas and sparse accents.
  Keep empty meadows and ordinary woods; a wonder every junction erases significance. Measure
  spacing, screen-scale contrast and encounter-free walking time, not just content density.
- **Country before corridors.** Build broad traversable forest floor from shared fields,
  with dense pockets and occasional obstacles, then lay a sparse trail network. Replace the
  four-exit guarantee with region/pass access checks explicitly; simply deleting gaps strands
  people. This matters more than mother-tree silhouettes.
- **A landmark vocabulary for navigation.** Distinguish silhouette, colour, ground and route
  role: a rock tower, shoreline hook or crooked old tree should explain a turn. Repeating the
  same “special” prop in every cell makes it ordinary. Probe landmark repetition and have
  someone describe a route home without chunk coordinates or an overlay.
- **Negative space for play and building.** Reserve some connected, dry, reasonably flat patches
  with useful views and more than one approach. Nearby resource variety can make a home
  desirable without a mandatory ruin. Measure distributions of usable footprints (for example
  6×6 and 8×8, pending the building kit), not a plot promised in every chunk.
- **Topology before dressing.** A pretty ford must actually cross, a pass must reach both
  flanks, and a cave branch must have a readable return. Some dead ends and inaccessible islets
  are fine if intentional and signalled. Measure detours and required destinations on the actual
  edge/layer graph; surface 4-neighbour reach is insufficient for 0.14.
- **One visual grammar across directions.** South faces occupy rows; north drops are thin rims.
  The same height is not equally legible from every side. Reserve mouth orientations or use
  explicit sinkhole art; show ramp sides and cave drops consistently. Avoid walkable ground
  hidden by projection. These are top-down composition rules, not physical realism.
- **Change needs continuity.** Keep bearings/routes while living detail changes. Compare
  several epochs around the same lamps and held seams, not just fresh isolated chunks.

**Where good rules fight each other or the game**

Wet toes, talus and shade plants all compete for the cliff foot that rule 11 must keep clear.
Groves and big halos compete for the same space. Make hard access/visibility masks win, then
choose a few ecological accents within the remaining area; do not stack passes. Soft ecotones
must not blur water depth, cliffs, danger or Whitequiet identity. Restrict palette mixtures and
keep collision boundaries readable at ordinary play zoom. A plausible narrow saddle is a
multiplayer choke point: keep passing/rest space near it, and avoid unavoidable camps on
one-tile switchbacks. Fighting and fleeing need the same level-edge rules as walking. A
terrain-looking escape that cannot be walked is unfair. Shortest routes can funnel every trip
alike; add loops and alternative crossings. Opening every chunk edge cheapens ranges and rivers:
guarantee region access, not all local links. A permanent map can still have temporary paths;
its stale-detail presentation must explain that distinction. Building candidates and persistent
laid routes should be checked against the lasting terrain, not granted because a clearing
happened to be open in this wick. Denser ecological detail increases sprite count, overdraw,
fade work and chunk attachment time. Prefer coherent ground patches, flat baked decals and fewer
distinctive tall pieces. Server speed does not prove client speed; avoid per-tuft animations,
moss sprites and lights.

**Build order within 0.14**

Iteration 1 is the prerequisite already in flight: open the south, border/read window,
`LandformV1`, lab and staged storage. Verify the new access baseline before changing it.

For **iteration 2, lake country and richer woods**, establish lasting wetness/upland fields,
biome pins and their halo contracts, lake ids, dry/shallow/deep shore masks and reservations.
Ship rules 7, 4 and restrained 5, plus the lowland part of 9 and sparse logistics cues in 10.
Prototype broad walkable groves here; measure how far the corridor rhythm actually recedes. Use
self-contained lake/inlet plans for 1; settle their future height interface now, but postpone
tributary simulation. No existing version should promise outlets it cannot keep.

For **iteration 3, the Tops**, build lasting height/face/ramp plans and their access graph; then
3, local 2, 8 and 11, followed by coarse contour routing from 6. Test water-head/height
compatibility, south-face footprint cost and both flanks of passes before adding scenery.

For **iteration 4, caves**, extend 12 to masks, floor heights, mouths and reverse portals;
extend 11 to entrances and world-fixed light. Reserve readable returns, approach landings and
occasional usable chambers. Caves move across the map as they descend; avoid stacking floors at
one screen tile in one layer. Do not require underground hydrology to ship caves.

For **iteration 5, far roads and tuning**, generalise the sparse regional graph, 6 and 10, and
only then assess whether coarse drainage adds enough beyond lasting planned lines. Use habitat
evidence from the life work, tune rest gaps and audit multiple seeds/epochs. Delay erosion,
oxbows and rain shadows if they threaten the roadmap's playable promise.

The **three best returns for the least work** are (7) shared shore/ecotone bands, because one
boundary can explain ground, plants and collision; (4) correlated grove/undergrowth masks that
replace scatter rather than add it; and (5) purpose-shaped landmark approaches, reusing existing
clear/bare machinery. Rule 12 is foundational work, not an optional cheap visual win. Once
cliffs exist, 3 is the next inexpensive, very visible improvement. The woods-floor change is
separate and higher-impact; water and region A* are not cheap.

**How to decide whether the result is better**

Add the per-rule fields, owner ids, reservations and graph overlays to the lab; keep atlas
inspection free of full chunk generation. A sprite-bound preview would help assess readability.
Use several seeds and three wicks: woods, shores, a whole catchment, both range flanks and a
whole cave. Include negative coordinates, four-chunk corners, mixed pins, held/fixed seams,
border sides/corners and out-of-border halos. Generate alone, in opposite orders, warm/cold:
geometry and ids must agree. Require zero accidental uphill water, unmatched portals or shut
mandatory approaches; report fallback/repair counts and repetition/detour distributions.
Keep JSON provenance, cap workers and use `nice -n 10` for heavy probes. Measure cold/warm p95,
allocations, encoded bytes, prop count and client attachment cost. Then have the owner describe
a place, return after a turning, cross a range and pick a building spot. That walk judges the land.
