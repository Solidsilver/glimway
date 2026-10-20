# Sol: the wide world

2026-10-20. Read against this worktree after 0.13.
Includes the owner's update: lake country is an early 0.14 biome.
Confidence labels apply to the recommendations in their paragraph or subsection.
**High** means a strong architectural recommendation; **medium** needs a spike or playtest.
**Low** means an initial tuning number, not an acceptance condition.

My central recommendation **[medium]**: use a mostly flat surface with sparse, real terraces.
Keep underground identity separate from terrace height.
Make cave mouths, tunnels, lakes and mountain trails lasting geography.
Let plants, creatures and other living detail turn around that skeleton.

## 1. Endless

### What actually stops us

`GenerateV3` explicitly leaves the frontier check to its caller.
That does not mean every generation pass is already independent of the frontier.
`cells.go` rejects places south of `southLimit`.
`routes.go` also contains southern limits.
`wend.go` builds its river from `frontierChunks()`.
`road.go` stops its road 40 chunks after the bend.
`rumour.go` chooses from places inside the starting frontier.

**[High]** Replace reach with one bounded-coordinate predicate shared by server and client.
Remove `reach`, `southLimit` and `heldSlack` as generation permissions.
Update `server/internal/frontier/`, `location.OnGrid`, chunk reads and presence validation.
Audit save arrival, operations, path tools, fight wake and cave existence separately.
A hold keeps detail; it should no longer buy permission to walk farther.
Generation inside the border needs no lamp, XP, discovery or contiguous explored trail.
Fetching remains bounded and rate limited; world existence is separate from request cost.

**[Medium]** Start with chunks `-65_536 <= cx,cy < 65_536`.
At 24 tiles and 16 pixels per tile, the square is 3,145,728 tiles across.
Its pixel span is 50,331,648; an axis reaches roughly 25.2 million pixels from zero.
This is a proposed product limit after the arithmetic changes below, not a verified v3 limit.
Make the bound a world-format parameter that can later increase without moving old land.
Do not allocate anything proportional to its area.

`Hash` casts integer arguments to int32 before mixing them.
Coordinates separated by 2^32 in the same argument alias; 32-bit outputs also collide normally.
Protobuf chunk coordinates are already signed 32-bit.
SQLite's INTEGER storage is not the limiting coordinate width here.
JS doubles retain far more precision than this proposal needs.
Presence positions use doubles; fight enemy pixel positions use sint32.
Those fight positions fit this border, but must be included in future border increases.

**[High]** Keep coordinate hashes distinct from persistent identity.
Use full structured coordinates or canonical strings for keys and feature IDs.
A hash collision must never merge two caves, claims or region records.

The fixed-point unit is 256; noise values use 65,536.
`fixed.go:hypot256` squares before multiplying by `fp*fp`, using Go `int`.
`geom.go:dist2Seg` has an int64 `num*tOne` intermediate.
Long global lines are particularly dangerous even when endpoint coordinates fit.

**[High]** Give new generation code explicit int64 arithmetic and bounded local operands.
Subtract region or feature origins before geometry; keep segments a bounded length.
Audit squares, dot products, interpolation and integer conversions, including negative coordinates.
Use bounding boxes to reject distant features before projecting onto their segments.
Require boundary and corner vectors plus the generation halo before enabling the proposed border.
Do not claim that int64 alone makes an arbitrarily large world safe.

**[High]** Rebase the client scene around a chunk-aligned render origin.
Subtract that origin in JS before coordinates reach WebGL or Phaser objects.
Float32 has one-pixel spacing at 2^23 pixels and two-pixel spacing at 2^24.
A far camera subtracting already-rounded GPU positions is too late.
Keep saves, network positions and procedural visual seeds in absolute world coordinates.
Convert input, lights, particles, colliders, enemy interpolation and camera targets at one adapter.
Rebase Arcade bodies, previous positions and spatial indexing together between physics steps.
Keep physics and camera bounds local; do not give them a world-sized rectangle.
Exercise this adapter with negative origins and a rebasing fight, not only terrain pictures.

### What the edge means

**[Medium]** Use distant pale weather and a firm travel boundary at the numerical border.
It cannot be pushed back by oil and should not appear on the normal starting map.
Reserve a narrow decorative apron inside it; reject destinations beyond the legal coordinates.
Do not wrap players to the other side.

Three lore choices for the owner **[medium recommendation for A]**:

- **A: Whitequiet is a condition of unkept land.** It can be crossed; lamps preserve memory there.
  Keep the named northern Whitequiet, its trinkets and Echoes.
  Amend §2.4's impassable moving edge and distinguish the remote travel boundary.
- **B: the edge was local.** The Whitequiet around Hearthwick opens in this release's story.
  Keep earlier accounts true to their time, with a short event or conversation explaining the opening.
  This needs more writing and makes a technical release a historical event.
- **C: Whitequiet occurs in scattered places.** Local pale stretches preserve the visual motif.
  Make them traversable in 0.14; future lore may explain why these places gather impressions.
  This needs another geographical distribution and risks becoming a new biome project.

**[High]** Leave §2.5's Dark distinct from ordinary wilderness and cave darkness.
A black cave mask is a visibility effect, not proof that every cave is corrupted.

### Storage, map and distance cost

Today `store/chunks.go` stores generated bodies on first read and has a 512-entry decoded LRU.
Old wick epochs are pruned, with hold-aware retention and trimming.
`src/game/wilds/chunks.ts` keeps decoded chunks in Maps and bytes in IndexedDB.
Its pruning is by epoch/version, rather than a current-epoch size budget.

**[High]** Separate durable geography identity, disposable bodies and mutable player state.
Durable: world seed, region manifests, feature/portal plans, placed work, holds and recovery records.
Disposable: reproducible unmodified chunk bodies, decoded terrain, painted textures and old previews.
Mutable state: claims, resource timers, fish stock and fight outcomes; evicting bodies never resets it.
Keep held blobs and their exact seam dependencies until release; treat a missing held blob as damage.
Do not silently generate a replacement for a missing held blob.

**[Medium]** Initially retain current-wick bodies, prune them at turning, and measure actual growth.
Then allow cold unheld bodies to be evicted only when reconstruction is proven byte-identical.
V3 accepts kept neighbour edges, so seed plus epoch plus coordinate is not always sufficient.
Record an immutable seam patch or dependency revision before making those bodies evictable.
Never reconstruct a previously served chunk against whatever holds happen to exist today.
Pin active fight geometry and chunks containing persistent mutations during this transition.

**[Low]** Try 128 decoded client chunks and a 64 MiB device byte-cache budget.
Retain attached chunks, in-flight destinations and pinned fight geometry outside eviction.
Use a separate compact map-summary cache; visiting 10,000 chunks must not retain 10,000 textures.
Region manifests grow with discovery, not the whole world; that small growth is intentional.

The brief's whole-frontier warning needs a qualification against current code.
`api/open_map.go:near` already generates only a radius-2 window.
It still sends all held keys and reads entity state across the selected epochs before filtering.
Discoveries, lanterns and ways also have broad reads.
The client map batches status by 256 keys, but loads terrain for the whole walked-key set.
So making the rectangle huge is dangerous even though the near terrain loop is already local.

**[High]** Make both detailed map terrain and status reads viewport bounded.
Start with at most 16×16 chunk summaries per map page; zoom out with precomputed aggregates.
Pan over unknown land without generating detailed chunks or crediting visits.
Intersect requested pages with explored records; fixed places and known lamp pins remain visible.
Index entity state by chunk, and ways by the chunks their paths touch.
Fetch nearby holds and relevant manifests, not every hold on every near read.
Move distant discoveries into a paged index used when the map actually needs them.

**[Medium]** Preserve lasting terrain knowledge across turnings, with stale detail marked separately.
A known lake remains known; its current plants and Common work can become uncertain.
This changes today's wick-scoped walked map and deserves an explicit migration.
Show a north indicator, home bearing, cave-mouth pins and the last walked route.

**[High]** Keep combat tiers capped at 3 for 0.14.
Do not confuse difficulty tier with Wild/Common/Built land status.
**[Medium]** Later dangerous pockets can have explicit threat profiles with readable approaches.
A long walk or high terrace should not silently multiply enemy numbers or lamp upkeep.

**[Medium]** Introduce a 32×32-chunk planning region for bounded feature plans.
Keep the Wend and the existing Lantern Road near Hearthwick as special anchored features.
Other regions receive local river, road and rumour plans, not copies of those proper names.
Shared edges determine connection positions from canonical edge keys.
Give rivers a coarse acyclic drainage plan into downstream exits or finite lake basins.
Do not independently draw rivers in each region and hope their heights agree.
Rumours choose from a bounded region candidate set, using an encountered local reference point.
Keep Elara's first rumour near home; it should not send a new player 20,000 chunks away.

**[High]** Reuse 0.13's homing turncap and lamp-ash pouch before inventing another travel system.
Turncaps already resolve `hearthwick:arch`; pouches already bind stable lamp IDs.
Include layer and standing position in bindings and landing validation.
A failed landing keeps the item, including a destination whose underground space is unavailable.
**[Medium]** Make a first turncap easy to obtain before the first long outing.
Keep walking free; whether to add a free rescue action remains an owner economy choice.

**[High]** Keep resource cost proportional to the moving window and changed state.
A cardinal move of one chunk adds five fresh chunks to a 5×5 fetch window, before reuse.
A diagonal move can add nine; turning and cave prefetch create separate bursts.
At the existing 6 KiB raw chunk budget, five chunks are at most 30 KiB of body payload.
That excludes protocol, state, compression and new height fields; it is not a measured network rate.
Use the existing opt-in p95 5 ms generation target as a baseline, then measure the new workload.
For n straight steps, new unique fetches are roughly `25 + 5n`, not the area walked around.
Avoid persistent writes for every prefetched chunk once reproducible-body caching is available.
Sleeping cave chunks and remote explored terrain should consume no simulation ticks.

## 2. Biomes

### A macro layer that stays extendable

**[High]** Separate biome, local land kind, water and traversable elevation.
A lake-country region may contain meadow, copses, clay banks and a rocky shore.
A mountain can rise within a broader climate without requiring an entire new rules subsystem.
Leave existing woods/meadow land patches as local texture, below the biome selection layer.
A terrain's appearance must not be its only source of walking or fishing rules.

**[Medium]** Use two lasting broad fields: wetness and upland tendency.
Sample them over approximately 24–64 chunks; start biome patches around 20–60 chunks across.
Use broad weighted biome cells biased by those fields, with world-coordinate border warping.
Add a temperature field only when a chosen biome needs it; do not simulate climate for its own sake.
Keep macro wetness/elevation continuous; quantise traversable height in the mountain pass later.

**[High]** Put the extensible catalogue in content, with stable IDs and immutable revisions.
Suggested shape, not an existing file:

```text
BiomeSpec {
  id, revision, label, generatorPiece,
  suitability: { wetnessRange, uplandRange, weight },
  landWeights, terrainPalette, decorWeights,
  materialWeights, encounterProfile, transitionStyle,
  featureRules: [{ kind, density, parameterSet }]
}
```

**[High]** Register small Go generator pieces behind one bounded interface.
For example: `PlanFeatures(context, boundsWithHalo) -> FeaturePlan`.
The context supplies stable fields, named RNG streams and frozen boundary constraints.
Pieces propose lakes, outcrops or groves; shared passes rasterise and validate them.
Pieces cannot alter old regions, place fixed story sites or bypass reachability checks.
A new physical landform can add one piece with bounded extent and explicit connections.
Keep arbitrary executable logic out of JSON; use a small typed parameter schema for each piece.
Do not grow switches on biome ID throughout combat, gathering, drawing and the map.

**[Medium]** Blend neighbouring palettes and scatter over 12–24 tiles.
Blend presentation and vegetation density; keep authoritative water and cliff boundaries crisp.
Choose local transition weights per tile from both neighbouring biomes, not the chunk-centre label.
Avoid forced woods/meadow hems between every pair of broad biomes.
A lake shore, an escarpment and a woodland margin need different transitions.

### Adding biomes after the freeze

**[High]** Pin a region manifest when authoritative terrain is first served, including prefetch.
This deliberately protects slightly more land than the player has physically walked.
A public terrain preview must also pin the geography it promises; a private lab preview need not.
Manifest identity is `(world, realm, rx, ry)`; use floor division for negative coordinates.
Its contents include `landformVersion`, `catalogueRevision`, `parameterHash` and feature plans.
A chunk payload records the manifest revision it was made from.
Content weights, pass order and RNG salts are part of that revision, not live global defaults.

**[High]** Treat a new biome catalogue as an option for unassigned regions only.
Never insert a biome into the candidate list used to reconstruct an assigned region.
An old region may contain unvisited chunks; those chunks still use its pinned recipe.

**[High]** Freeze the shared boundary grammar separately from biome implementation versions.
Persist edge ports for roads, rivers, traversable passes and any cross-border cave feature.
Store a narrow fixed transition collar when a border is first planned.
A new region fits those constraints and may express its new biome further inside.
Commit feature dependencies and touched edge records atomically, with deterministic ownership.
Do not let chunk request order decide whether a river connects or a tunnel exists.
Retain old generator pieces and immutable parameter bundles for every evictable assigned region.
If an old implementation is retired, first materialise all remaining geometry that depends on it.
A generator-version integer without its content recipe does not preserve geography.

### First biomes

**[High]** Start with the existing temperate woods/meadow country and **lake country**.
Lake country includes actual lakes, continuous shores, reeds and clay banks in 0.14.
Use **[medium]** upland country as the third, because it gives the mountain work a landscape.
These test three different silhouettes: canopy, open water and exposed rock.

**[High]** Lakes are bounded lasting features, not per-chunk puddle rolls.
A lake plan owns its outline, constant water level, shore band and drainage links.
Rasterise the same feature on both sides of every chunk boundary.
Reserve a generally walkable 2–3-tile bank; deliberate rock barriers need an alternate route.
Start most lakes at 1–4 chunks across, with fewer larger examples **[low]**.
Place reeds in shallows and clay on suitable exposed banks, with authoritative gathering targets.
Gathering clay changes resource state; it does not excavate terrain or move a shore.

**[High]** Keep a water descriptor seam for fishing from the first lake implementation.
Follow `design/fishing.md`: ID, chunk-local connected water cells, bank tiles and habitat.
A cross-chunk lake has per-chunk fishery descriptors sharing a lasting lake feature ID.
Stock and catch rules belong to fishing, not the biome renderer.
With lasting lakes, weekly living-detail refresh must not accidentally refill depleted water.
Carry stock by stable water identity, or explicitly decide the desired reset rule before fishing ships.
The old fishing/world documents contain obsolete release numbers and frontier assumptions.
The owner's update controls lake geography now; pottery chains and new fishing gameplay are separate slices.
Emit the descriptors now without requiring the kiln, a new fish roster or a new enemy to finish 0.14.

## 3. Height

### A. Drawn height and separate cave layers

**[High confidence in feasibility]** The small model keeps one collision plane per layer.
A chunk stores ordinary ground/solid plus optional mountain-mass polygons and visual relief hints.
Trails cut openings through mountain masses; summits are walkable areas in the same x/y plane.
The mountain picture, exposed cliff faces, trail bends and lower-land fog create apparent ascent.
Caves use layer `-1`, reached through a persistent portal descriptor.
An underground chamber can occupy the same x/y footprint as an impassable mountain above.

Physics and creature navigation stay 2D within each layer.
Depth remains mostly foot-y sorting with explicit foreground occluders.
Presence, fights and interactions still need layer identity; separate cave layers are not cosmetic.
A summit and a valley cannot have distinct walkable positions at the same x/y on the surface.
Fights cannot treat apparent cliff height as a tactical difference unless separate walls block them.
Lamps illuminate their layer; holds cover their existing layer/chunk area.
Desire paths remain ordinary per-layer tile edits; mountain trails are generator geography.
Future building uses the same flat placement checks, with mountain masses unavailable.
The map shows hill symbols, trails and cave entrances, with an underground view when appropriate.

**[Medium]** If choosing A, use a continuous preloaded tunnel corridor for the cave switch.
Fade the occluding surface toward black as the hero passes under the roof.
Reveal the underground floor in place; no scene restart or modal door.
Fade lower ground toward sky colour on the summit approach.
The risk is paying for cave identity changes while still finding mountains too flat.

### B. Sparse real surface levels

**[Medium, preferred]** Keep one walkable surface height per surface tile, mostly zero.
Use four initial terrace values, `0..3`; no jumping, falling damage or free vertical movement.
Use a separate layer `-1` for underground, with its own height if ever needed.
A cave floor beneath a mountain is not a second value in the surface height byte.
A heightfield cannot express arbitrary overhangs or two surface decks at the same x/y.
Do not promise bridges above walkable roads from this representation alone.

**[High]** Store elevation and authorised edge traversal separately from occupancy.
Suggested grids: `height[576]`, `edgeBlock[576]`, and sparse `Ramp` descriptors.
An edge mask has four direction bits; both sides of a shared edge must agree.
A cliff blocks traversal even if both adjacent floor tiles are otherwise open.
A ramp names direction, footprint and its two landing heights.
No differing-height adjacency is traversable merely because the destination tile is not solid.
Reserve trails, ramps and landing clearances before plants, camps and resource placement.

**[Medium]** Keep Arcade bodies in logical x/y and draw feet at a height-adjusted screen anchor.
Try an 8-pixel visual lift per terrace, then compare with 16 pixels in the spike.
Ramp progress interpolates the visual lift; its endpoint tile determines authoritative height.
Input hit testing must invert this projection using the visible surface under the pointer.
An object origin, ground highlight, shadow and collision-debug outline must agree on the same feet.
A drawing offset alone does not supply level-aware collision.

**[High]** Use the same edge/ramp traversal function for server and client movement decisions.
Tile occupancy, cliff edges, ramps and body radius all matter.
Make melee, bolts, dash, aggro and gathering use traversable surface/line-of-sight rules.
For 0.14, block attacks across cliff edges; allow them along valid ramp approaches.
Do not invent height damage bonuses before this is readable.
`server/internal/fights/geometry.go` currently carries only an Open grid.
It and `Ground.Dash` need the edge/ramp topology; checking final height alone permits cliff crossing.
Creature pathfinding uses that same graph, with camps placed clear of ramp bottlenecks.

**[Medium]** Render cliff faces, plateau floors, actors and foreground as explicit occlusion groups.
Within a terrace, retain foot sorting; at a cliff, use the cliff's masking relationship.
Do not sort everything by `height * hugeNumber + y` and expect all overlaps to work.
Use the spike to test north/south/east/west cliffs, concave corners and a creature behind a ledge.
Keep an outline or fade for the controlled hero when an unavoidable foreground piece covers them.
Mist should thin distant lower terrain; the current trail and next ramp stay legible.

**[High]** Presence and saves carry layer and a standing surface reference.
On the heightfield, height is derived from position and ramp, then checked by the server.
A client-supplied level is a claim to validate, not permission to stand on a mountain.
Same-layer nearby players can remain in existing chunk subscriptions, carrying their surface identity.
Filter targets by topology rather than splitting every terrace into an unrelated social room.
Underground players and surface players at identical x/y cannot gift, fight or credit visits together.

**[High]** Keep oil upkeep at layer/chunk granularity for 0.14.
All surface terraces in one held chunk are included; a separate terrace tax adds no useful choice.
Underground holds are independent; a surface lamp does not claim the cavern beneath someone's feet.
Light masks do not shine through solid roofs; cliff light can use a simple blocked-edge rule.
Paths name layer plus tile; their height comes from fixed terrain.
Generated mountain access trails survive turning; player extensions use Common/Built rules.
Future building must name the supporting surface and require a compatible flat footprint.
Reserve structural ramps, portals and evacuation paths against placement in 0.15.
The map shows terrace shading, ramp marks and trails, plus a separate underground toggle.

### Caves and seamless traversal in either model

**[High]** Plan a sparse connected cave as one lasting feature with explicit mouths and extent.
Start with 2–8 underground chunks; cap the first feature format at a 4×4 footprint **[low]**.
Let one chamber cross chunk boundaries; a large room must not be forced into a 24×24 box.
Some features pass under a mountain and leave on the other side.
Guarantee one reachable surface exit; give through-caves two mouths deliberately.
No implicit cave exists under every surface chunk; absent underground is solid rock.

**[High]** Preload the destination and return corridor before allowing the mouth threshold crossing.
A physical tunnel several tiles long supplies time to prefetch and change occlusion gradually.
If fetching is slow, the player stops at the not-yet-ready threshold before disappearing.
Keep the same scene, input stream and camera target throughout.
Send one validated topology transition, save the destination layer, then switch simulation membership.
Use hysteresis so standing at the threshold cannot bounce between layers every frame.
At a wide opening, reveal a substantial underground area immediately, with surrounding rock blackened.
Use a soft visibility mask and roof cutaway; avoid a full-screen black frame.

**[High]** Make cave entrances, connecting tunnels and chamber walls lasting landform.
This deliberately revises `layers.md`'s old whole-cave-follows-the-mouth-epoch proposal.
Living detail still turns; a Built claim pins detail only in the cave chunks it holds.
Pinning a mouth must not silently grant 16 underground chunks of free upkeep.
Releasing an upstairs lamp must never erase an underground neighbour's only exit.
Validate the exit corridor against both weekly dressing and later building placement.
On reconnect or turning, relocate within the same reachable component first.
Use an entrance refuge, then the resolved town anchor only if local recovery truly fails.

**[Medium]** Choose B if the parallel spike proves readable slopes, collision and occlusion.
Use A as the explicit fallback if B still feels ambiguous after a bounded spike review.
Do not ship pretend levels in the contract and leave authoritative movement for 0.15.
Even the fallback must complete layer-aware saves, combat, lamps and portal identity.

## 4. The chunk contract

**[High]** Keep the spatial key `(world, realm, layer, cx, cy)`.
World remains session scoped on the public wire where it already is.
Layer means overlapping physical space: surface 0, underground -1 initially.
Height is within a space; it must not become a fourth spatial chunk axis.
Reserve semantics for deeper layers without generating them now.
Cave feature IDs describe identity and ownership; they need not become another realm.

**[Medium]** Evolve `WorldChunk` along these lines, using additive protobuf fields:

```text
WorldChunk {
  existing key, size=24, source, epoch_id, generator_version,
  geography_ref: { region_id, manifest_revision, landform_version },
  biome_palette[], biome_cells?, dominant_biome,
  ground_palette[], ground, solid,
  height?, edge_block?, ramps[],
  portals[], feature_refs[], waters[],
  decor[], objects[], sites[], entities[], places[]
}
Portal {
  id, feature_id, source_trigger, source_approach,
  destination: { realm, layer, cx, cy, local_x, local_y },
  destination_approach, corridor_ref
}
Water {
  id, feature_id, cells, bank_cells, habitat
}
```

**[High]** Specify row-major dimensions, edge directions, units and unknown-field behaviour.
Ground currently packs two cells per byte, so a palette has a 16-entry representation ceiling.
Use per-chunk palettes first; avoid a single global terrain enum for every future biome.
Define a versioned wider encoding before any chunk actually exceeds 16 grounds.
Height can be a byte per tile; 576 bytes is simple and compresses well when mostly zero.
Use an absent grid to mean flat zero, and absent edges to mean no extra cliff blocks.
Ramp and portal fields need strict bounds, unique IDs and validated reciprocal connectivity.
Keep fixed chunks flat by default; fixed source lookup must include layer before caves under town exist.

**[High]** Preserve the fixed → held → generated composer order per complete spatial key.
Separate source selection from geography recipe selection and current living-detail epoch.
`epoch_id` alone cannot select a regional biome recipe once one wick contains multiple recipes.
Use an immutable body identity or recipe reference in the near read and cache keys.
Include realm and layer in client keys, IndexedDB, presence rooms, map records and lamp bindings.
Today several client keys and reads hardcode layer 0; changing the proto alone is insufficient.
Include layer and validated standing position in `Where`, saved Place and fight action origins.
Bind operation idempotency to those fields so retries cannot act on the other side of a cave roof.

**[High]** Freeze at 0.15: spatial units, key meaning, identity, source precedence and retention promises.
Also freeze the region manifest format, boundary grammar, portal topology and stable ID derivation.
Freeze reconstruction recipes for assigned land, including the content bundles they consume.
Freeze ground-change, claim and placed-object references to supporting surfaces.
Freeze recovery semantics and the no-item-loss guarantee before underground building is allowed.
A schema freeze should permit additive biome definitions and new generator pieces for new regions.
It must not mean overwriting the meaning of an old generator version.
Keep golden fixtures for old assigned regions after the first new biome catalogue is added.

## 5. The iteration loop

**[High]** Build a world lab early, as a developer tool independent of live persistence.
Start from `glimpse.go:Glimpses` and `render_v3_test.go`'s frontier, lands and edge renderers.
Expose one bounded plan/render function rather than duplicating generation in a browser tool.

**[Medium]** Give the lab seed, coordinate, catalogue revision, wick and parameter controls.
Provide three scales: biome overview, region feature plan, and a fully rasterised local window.
Aim for a 128×128-chunk coarse preview in two seconds on the dev host **[low]**.
Fully generate only the inspected 5×5 window; report actual timing instead of hiding work.
Layers show biome weights, lake outlines, drainage, heights, blocked edges, ramps and cave connectivity.
Show fixed footprints, held seams and feature ownership as switchable debugging overlays.
Selecting a tile explains its recipe, feature IDs, walking edges and why its biome won.

**[High]** Support side-by-side versions and a difference overlay with saved parameter presets.
Let the owner bookmark a good shore or bad ramp and reopen the identical seed and revision.
Offer a short set of tour coordinates: lake shore, biome margin, summit, wide cave and mountain tunnel.
Export those bookmarks into a throwaway playtest world without touching a real world's manifests.
Have a deliberate reset action for that disposable world; never silently rebuild player creations.

**[High]** Pair attractive previews with structural checks across a fixed seed gallery.
Check order-independent output, negative coordinates, all four chunk edges and region corners.
Check lakes at equal water level, reciprocal portals, reachable exits and cliff/ramp agreement.
Check old regions remain byte-identical after adding a dummy biome to the catalogue.
Check turning with a held cave room and an unheld mouth, and reconnect in a tunnel.
Run unit/Go checks through `nix develop -c`; ordinary tests should avoid wall-clock assertions.
Keep generation timing opt-in, as the current budget tests already do.

**[Medium]** Add a synthetic window-walk benchmark covering 10,000 chunks without running the game.
Measure unique generation, query rows, allocations, cache size and pruning time.
Compare equal-length walks near home and near the proposed border.
Use the existing 6 KiB raw budget as a baseline, then explicitly revise it for geometry fields.

## 6. Art

**[High]** Spend scarce drawing time on forms that communicate new walking rules.
A convincing cliff edge, ramp landing and cave mouth matter more than another grass texture.
Make an art contact sheet for the two terrace lift values before commissioning a large set.

| Part | Procedural or reused | Needs deliberate drawing | Confidence |
|---|---|---|---|
| Endless land | Existing ground, paths, scattered props | None for basic distance | High |
| Lake country | Water colour/noise, shoreline masks, existing meadow | Reed clumps, a clay-bank motif, shoreline exemplars | High |
| Lake vegetation | Reuse shrubs; recolour some ground | One convincing willow/alder silhouette | Medium |
| Uplands | Stone recolours, sparse scatter, generated scree | Cliff faces/corners and a readable ramp kit | High |
| Caves | Rock floor variation, darkness and soft masks | Wall/lip kit, wide opening, tunnel mouth | High |
| Atmosphere | Fog, sky tint, height shading, light masks | Palette and edge treatment review | High |
| Navigation | Existing lamps and signs | Small cave/height map symbols if needed | Medium |

**[High]** Procedurally assemble irregular shores and cliff runs from reviewed pieces.
Recolour only where silhouette still says the right thing; a grey tree is not an outcrop.
Give cliff kits caps, inside/outside corners and all required facings.
Cave walls need foreground lips that can fade without exposing missing geometry.
Ensure reed beds look walkable and deep water looks blocked at phone scale.
**[Medium]** Start cave inhabitants with existing compatible creatures; no boss-art dependency.
Defer ornamental stalactites, multiple cave-mouth families and biome-specific enemy rosters.
Keep clay gathering's visual change small; it must not look like the player dug a new tunnel.

## 7. Slicing

**[High]** First playable iteration: walk out of Hearthwick in every direction and find lake country.
Include existing turncaps, a local map, bounded caches and the new boundary predicate.
Use one lasting lake feature, continuous bank, reeds and clay targets with existing placeholder art.
Keep terrain flat in this iteration; the parallel height spike supplies the next decision.
The owner acceptance walk is out through a former edge, around a lake, then home by turncap.
No lamp is required to continue; repeated map use and walking do not grow live memory without bound.

**[High]** Build the lab's coarse preview and minimum recipe manifest alongside that first slice.
Do not block the outing on a polished laboratory UI or realistic river network.
Do not expose the full proposed border until rebasing and arithmetic checks are ready.
Early development worlds may use a smaller declared bound, then expand without shifting coordinates.

**[Medium]** Second iteration: refine woods/lake-country transitions and regional connections.
Add the third upland biome, coarse drainage, continuing road legs and local rumours.
Playtest the same seeds with two presets; keep the version the owner wants to walk through.
Acceptance: two different directions feel geographically different, and rivers/roads meet across regions.
A shore crossing must never require a particular class; walkable alternatives remain available.

**[Medium]** Third iteration: one real mountain with a continuous trail, ramp and summit overlook.
Complete server/client cliff collision, combat geometry and draw order before spreading mountains.
Acceptance: two players approach on opposite sides of a ledge, meet by the ramp and fight fairly.
If the spike selected A, explicitly substitute its mountain-mass model at this point.
Keep the acceptance about felt climbing, not whether a debug height field exists.

**[High]** Fourth iteration: one tunnel into a large underground chamber beneath that mountain.
Complete layer-aware saves, presence, fights, map, lamps, holds and return travel.
Acceptance: enter together, separate above/below, reconnect underground, return through another mouth.
Run a turning with one underground hold and confirm both exits remain reachable.
A mouth with deliberately delayed fetch still has no loading door or black-screen jump.

**[Medium]** Fifth iteration: distribute sparse mountains and caves across the wide world.
Try roughly 5–10% mountainous footprint and one cave candidate per 16×16 chunks,
with a one-in-three eligibility draw; all are tuning guesses **[low]**.
Guarantee a curated nearby example in disposable owner playtest seeds.
Acceptance: a relaxed outing has stretches of ordinary country between memorable landforms.

**[High]** Final iteration: persistence rehearsal and the handoff to 0.15.
Add a small test biome using the extension interface, preserving all assigned old regions.
Evict and reconstruct cold land, restore a held blob, upgrade an old catalogue and check its seams.
Recover any player work before a pre-freeze world rebuild; never use iteration as an item wipe.
Document the chosen height model and contract rather than keeping both implementations indefinitely.
The release acceptance remains one journey: walk far, climb, go below ground and come home seamlessly.

## 8. Risks and open questions for the owner

**Height choice [medium]:** real terraces or drawn mountain masses?
Recommend real sparse terraces, conditional on the spike's four-direction collision/occlusion tour.
The fallback is drawn height with complete cave-layer support, chosen before broad biome rollout.

**Whitequiet [medium]:** traversable condition, historical opening, or scattered pale places?
Recommend the traversable condition, preserving the named northern place and its impressions.
The owner decides the words and whether the old barrier needs an in-world explanation.

**Cave persistence [high]:** mouths/tunnels stay, or the whole cave changes each wick?
Recommend lasting geometry with turning living detail and independent underground upkeep.
This protects routes, future bases and friends standing on different layers.

**Known land [high]:** preserve chunks only, or pin the surrounding planning region?
Recommend 32×32 region recipes plus frozen boundary constraints.
This leaves some unseen old land unchanged, but makes future-biome upgrades predictable.

**Exploration memory [medium]:** forget map terrain each wick, or retain geography knowledge?
Recommend retaining lasting terrain and showing current detail/status as a separate freshness layer.

**Lake gameplay scope [high]:** lakes/reeds/clay now, or require fishing and pottery too?
Recommend all lake geography and gathering targets in 0.14, with fishery descriptors ready.
Keep kiln chains and new fishing mechanics in their own agreed release scope.
Existing fishing design decisions remain the reference when that gameplay is scheduled.

**Return safety [medium]:** consumable travel only, or a free rescue fallback?
Recommend keeping turncaps/pouches and supplying an early first turncap for the initial playtest.
If walking home still feels punitive, try a free interrupted rescue before designing a new economy.
No rescue should remove carried items or turn an exploration mistake into inventory loss.

**Depth ambitions [high]:** sparse caves now, or general overlapping surface decks?
Recommend sparse underground spaces and one surface height per tile for this release.
That covers a tunnel under a mountain; arbitrary stacked bridges need a richer surface model later.
Freeze supporting-surface references so that later addition can be additive.

**Biome reach [medium]:** new biomes farther away, or replace unseen pockets in old regions?
Recommend farther unassigned regions, with a guide to the nearest new region when needed.
Do not force old manifests to reconsider their biome just because a catalogue gained an entry.
The extension seam should pass this test before the later future-biome brainstorm starts.

**Pruning [high]:** discard bodies immediately, or prove reconstruction before eviction?
Recommend staged pruning, keeping old seam dependencies and all player state durable.
The current generator's kept-edge input makes naive regeneration a correctness risk.
Keep pruning failures recoverable from backups; no missing blob may become a fresh claimed landscape.

### Basis and limits

This response is based on the brief, roadmap, named design/lore sections and the implementation.
I inspected generation, persistence, coordinate/window code, protobufs and existing preview/budget tests.
I did not run the game, E2E tests or performance measurements, and made no implementation changes.
All timing, density, cache and border targets above are proposals where explicitly labelled.
