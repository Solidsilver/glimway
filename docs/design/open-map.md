# Design: 0.8 The open map

Status: **agreed with the owner, 2026-10-10**; ready for lanes. Docs only; nothing is built yet.
Follows [world.md](world.md) ("The open map") and replaces the frontier band in
[lamps.md](lamps.md), which moves to 0.9.

Rules kept: the server owns state; never grant or duplicate Habitica items; no placeholder art;
never call a running instance "official".

## 0. Owner decisions

2026-10-10:

1. **Seamless walking.** The hero's scene holds the 3×3 chunks around them and loads the next
   row while they walk. Chunk scenes, exit gaps and region-wide pixel coordinates go.
2. **New land in 0.8:** woods, a meadow kind, and the Wend as one river with fords where routes
   cross it. The Lantern Road carries its old lamp stones, dark. Lakes, reeds, clay, footbridges
   and pottery stay with lake country.
3. **The bound before lamps:** the frontier is 3 chunks past the Tangle and the Whitequiet's old
   3×3. The Tangle stays permanent; the Whitequiet and the new ring past it turn every wick, as
   the Whitequiet does today. Lamps push the frontier out in 0.9.
4. **A clean break for the Tangle.** The new generator makes it again, with its story sites,
   papers and Echo hooks at fixed coordinates. Wilds entity state and chest claims are cleared;
   packs, home chests, story and Echo progress are kept. No migration shim.
5. **Paths players make:** clear brush with a tool, then lay stone or plank on the cleared tile.
   A laid tile is walkable, a little faster, and shows on the map. It lasts until its chunk
   turns, or for good inside lamplight (in 0.8, only the Tangle, which never turns).
6. **Chunk edges go.** Land runs across them; thickets, trunks and the river cross freely, and
   the generator's routes always leave a way through. The only visible edges are seams where a
   kept chunk meets newer land (with 0.9's lamps).
7. **Making a path, in numbers:**
   - Clear brush or a thicket tile with a spade, a fallen trunk with an axe. Free, no glims, a
     short action.
   - Lay a stone path for 1 stone a tile, or a plank path for 1 timber a tile (the one for wet
     ground).
   - Walking on a laid tile is 15% faster. Laid tiles show on the map.
   - Anyone can do it; no class gate.
8. **A small map in 0.8:** a "Walked land" tab in the journal, a plain drawn grid from chunk
   data. It shows the chunks you've been in this epoch, the fixed places, the road, the river
   and laid paths. 0.9's Lamps tab grows from it. No new art.
9. **Difficulty by rings from the Commons gate:** the Tangle is tier 1 and the Whitequiet tier 2;
   every 3 chunks past the Whitequiet adds a tier. In 0.8 it caps at today's top tier, with
   better loot further out. Real numbers come with 0.9's lamps.
10. **Turning under your feet:** the land changes the next time your chunks load. If you stand on
    something now solid, you move to the nearest open tile, with a line: "The drift turned while
    you stood in it." You're never thrown home.
11. **Echoes stay in the Whitequiet's old 3×3**, dealt across its 9 chunks each epoch as today.
    The ring past it gets ordinary camps, nodes, chests, the road and the river.
12. **The river is crossed only at fords in 0.8:** 3-tile shallows where a route meets it, waded
    at half speed. Every route gets a ford. No plank paths on water; footbridges come with lake
    country.
13. **The meadow gives what the Wilds already have:** open ground rich in fiber, stone outcrops,
    little timber. No new materials, item art or recipes in 0.8.
14. **One release**, with an alpha tag as soon as the generator and seamless walking are merged
    on `dev`, so the owner walks the new land while paths and the map are built.
15. **Kinds of land don't follow rings.** The fields decide the land anywhere, leaning by
    direction as the canon says; a meadow or a lake can sit close to home or far out. Rings
    decide only difficulty and rewards. So a kind of land is data (its ground, nodes, camps,
    decor, later its creatures), and each ring scales what that data yields.
16. **Patch sizes follow a distribution:** usually middling (about 3 to 8 chunks across),
    sometimes very small, now and then very large. Edges between lands are soft: one thins into
    the next over a chunk or so.
17. **New land is guaranteed**, as two rules of the generator from 0.8 on, each with a test:
    whichever way you walk, the land changes within the patch cap (20 chunks); and nothing is
    walled off (every route has its ford, later every cliff its pass). Because the 0.8 frontier
    is shorter than the cap, 0.8 also leans the Wend and its meadow into the first ring past the
    Whitequiet.
18. **Everything in the Beyond turns at the wick,** the lie of the land included: which land is
    where, the Wend's course, the places and routes. Only the Lantern Road and the fixed story
    sites stay put.

## What exists today

The two searches behind this section are summarised here; file:line facts are as of `dev` at
`0b4e8e7`.

**Already done (world.md build step 1, mostly):**

- Go generates every chunk (`server/internal/wilds/gen_v2.go`, `woods_v2.go`); the client draws
  only. All generator math is integer (`fixed.go`), pinned by goldens
  (`wilds/testdata/golden_v2.json`, `TestGoldenChunks`).
- The wire chunk is already protobuf with the open map's key: `WildsChunk` has realm, layer and
  signed `sint32 cx, cy`, a ground palette, packed ground and a solid bitset
  (`proto/glimway/v1/wilds.proto:19`).
- Chunks are fetched one by one (`GET /api/wilds/chunk/<epoch>/<layer>/<cx>/<cy>`, which already
  parses signed ints, `api/wilds.go:318`), cached in a 512-chunk LRU on the server
  (`store/chunks.go:27`) and in IndexedDB on the device (`src/game/wilds/chunks.ts`).
- Budgets exist: `TestChunkTimeBudget` (p95 ≤ 5 ms, only with `GLIMWAY_PERF=1`), 6 KiB raw a chunk
  (`wilds/size_v2_test.go:80`).
- `worldchange` (`server/internal/worldchange`, table `world_changes` in `030_crafts.sql:32`) is
  already keyed by world, realm, layer, chunk, epoch and entity, with `ends_at`. Only the fishery
  writes to it.
- Homestead clearing (`api/home_placement.go:313` `clearTile`, `homestead_cleared`) and lamplight
  (`land.Lit`, `land.Effective`) are the precedent for an overlay on generated land.

**Region-shaped, all of it to change:**

- Two 3×3 regions (`content/wilds.json:5`), each with one epoch (`region_epochs`,
  `UNIQUE(world_id, region_id, season)`), all nine chunks made at once (`store.Chunks.Create` →
  `wilds.GenerateRegion`).
- Bounds 0..2 everywhere: `GenerateChunk` (`gen_v2.go:184`), `chunks.Validate` and its exit regex
  (`chunks/read.go:13`, `:83`), `entityChunk` (`api/wilds.go:453`), `nearWilds` (`:363`),
  `PlaceFallen` (`:765`), `validPresenceRoom` (`api/presence_socket.go:20`), and on the client
  `parseChunkArea` (`src/game/wilds/regions.ts:67`) and `validateChunk` (`src/lib/api/chunks.ts:55`).
- Seeds carry the region (`wilds/hash.go:82` `Epoch.RegionID`, `ChunkSeed`, `LootSeed`).
- Chunks meet only through hashed exit gaps (`edgeOffset`, `chunkExits`); the woods noise
  (`woods_v2.go:182`) is sampled in chunk-local tiles, so nothing is continuous across an edge.
- The region read (`GET /api/wilds/region/<id>`, `wildsService.Region`, `api/wilds.go:165`)
  returns every entity state in the region, and the client loads the whole grid with it
  (`store.ts:255` `refreshWilds`).
- Story code names the Whitequiet by region: Echoes in its east column (`story/story.go:51`),
  `Record` writing `player_place.last_outer_epoch` (`story.go:237`), `deepCountry`
  (`api/wilds.go:865`).
- The client: one Phaser scene per chunk (`WorldScene.moveTo` restarts the scene on every
  crossing, `WorldScene.ts:1025`); positions are region-wide pixels (`regions.ts:10`); ground is
  painted per chunk with fake trees in a fogged margin (`tangle-art.ts:590`, `paintMarginTrees`),
  its noise seeded by the area id in chunk-local pixels; physics and camera bounds are one 24×24
  chunk (`WorldScene.ts:423`, `world-camera.ts:100`); presence rooms are per chunk with
  chunk-local positions (`WorldScene.ts:695`).

**Missing:** world-coordinate fields, lands, the river, cells and routes; per-chunk epochs; a near
read; seamless walking; per-tile walk speed (`hero.ts:269` has one speed); a map (none exists);
any list query on `worldchange`; any movement check on the server (there is none; nothing here
adds one).

## 1. The player's view

1. You walk out of the Commons gate into the Tangle as before, but there are no more chunk
   doors. The woods run on; the screen never fades between chunks.
2. The Tangle is new once (decision 4): same iron-oak look, same story sites (the plank, the
   papers), new paths and camps. It never turns.
3. North of the Tangle the Whitequiet lies where it always did, its Echoes and finds as before,
   and it still turns every wick.
4. Past the Whitequiet, and around both, there is new land for three chunks in every direction
   but south (the village is south). Woods thin into **meadow**: open grass, wildflowers, stone
   outcrops, a lone tree. The **Wend** winds through the west, wide and dark, and you cross it at
   **fords**, wading slowly.
5. Paths join real places: a camp ruin in a glade, a chest under an outcrop, a ford, and north
   of the Whitequiet the **Lantern Road**, old and paved, with **dark lamp stones** beside it. You
   can look at one; Mara would know what it is for (0.9).
6. Further out is harder: the new ring's camps hit harder and its chests are better.
7. At the edge of the frontier the drift closes: pale threads across the way and leaning
   turncaps. You can't walk on.
8. With a spade you clear a thicket tile; with an axe a fallen trunk. On cleared or open ground
   you lay **stone** (1 stone) or **plank** (1 timber). Laid tiles are a little faster to walk.
   Outside the Tangle they last until the land turns; the game says so before you lay one.
9. The journal has a **Map** tab: the chunks you've walked this wick, the Tangle and the
   Whitequiet, the road, the river, laid paths and the edge of the frontier.
10. At the wick the Beyond turns. If you're out there, the land changes the next time your chunks
    load; if you were standing in something now solid, you step to open ground: "The drift turned
    while you stood in it."

## 2. The build

### 2.1 Coordinates and the first map

- **Key:** `(world, realm, layer, cx, cy)`, realm `hearthwick`, layer 0. Tile `(x, y)` in world
  tiles, chunk `(floor(x/24), floor(y/24))`; positions in world pixels, signed. North is −y.
- **Origin:** the chunk the Commons gate opens into is (0,0); the gate is on its south edge.
- **The Tangle** is the 3×3 at cx −1..1, cy −2..0. **The Whitequiet** is the 3×3 north of it, cx
  −1..1, cy −5..−3. Both are named footprints in content (`places` in wilds.json), not regions.
- **Nothing lies south of cy 0.** The village and the homesteads are hand-made and south.
- **Rings:** Near = the Tangle (never turns). Beyond = everything else (turns every wick).
- **The 0.8 frontier** (decision 3): chunks within Chebyshev distance 3 of the Tangle or the
  Whitequiet, with cy ≤ 0. That is cx −4..4, cy −8..0: 81 chunks, 63 of them new. It lives in one
  function, `frontier.Inside(world, cx, cy)`, which 0.9's lamps extend (lamps.md 2.1).
- **Tiers** (decision 9), `wilds.Tier(cx, cy)`: the Tangle 1, the Whitequiet 2, then 2 + ⌈d/3⌉
  where d is the Chebyshev distance to the Whitequiet or the Tangle, capped at 3 in 0.8.

### 2.2 The generator, version 3

All in `server/internal/wilds`, integer math on `fixed.go`'s noise, Go only (the client never
generates). A chunk is a pure function of `(world seed, epoch, cx, cy)` plus, at a seam, its kept
neighbour's stored edge (2.3). The passes, coarse to fine:

1. **Cells** (`cells.go`). The world is cut into cells of 3×3 chunks, aligned so the Tangle is
   cell (0,0) and the Whitequiet cell (0,−1). A cell has at most one **place**: a camp glade, a
   ruin with a chest, an outcrop, a lone-tree rest. The two footprint cells hold their fixed
   sites instead. In 0.8 the frontier holds 9 cells: 2 fixed, 7 with a place each.
2. **Lands** (`lands.go`, decisions 15 and 16). Seeded points, one per land cell of 8×8 chunks,
   each with a land kind (drawn from the content weights and the canon lean by direction) and a
   size weight drawn from a log-normal-like table: median about 5 chunks across, about 1 in 10
   under 2, about 1 in 20 over 12, hard cap 20. A tile's land is the point with the least
   distance/weight, with a little world-coordinate noise on the distance so borders are soft.
   With the cap, a chunk looks at a bounded set of points (the 7×7 land cells around it). The
   Tangle footprint is always woods with the Tangle look; the Whitequiet always woods with the
   outer look.
3. **The Wend** (`wend.go`). One river per wick: a seeded polyline that enters the frontier from
   the north or west and leaves at the south edge west of the Tangle (cx ≤ −2, cy 0), toward the
   mill, as the canon has it. Never into the Tangle; at most the Whitequiet's west column. 2 to 4
   tiles of water; land within 2 chunks leans to meadow (decision 17).
4. **The Lantern Road** (`road.go`). One line per world (decision 18: it doesn't turn): from the
   Whitequiet's north edge at cx 0, north, then bending east. Paved, 3 tiles wide. A **dark lamp
   stone** every second chunk along it, a site with a fixed id (lamps.md relights them).
5. **Routes** (`routes.go`). Each place links to the places of its east and north neighbour cells
   and the footprints' fixed openings, with a seeded midpoint-displaced polyline (so it bends
   but is computable in pieces). A chunk computes only the routes of the 3×3 cells around its
   own. Where a route meets the Wend there is a **ford**: 3 tiles of shallows, walkable.
6. **Detail** (`detail_v3.go`, the woods_v2 passes kept and fed new inputs). Per land kind:
   ground palette, thicket density, decor mix, node materials, camp mixes (all from content).
   `openFixed`, `layPaths`, `addGlades`, `dress` and `ensureReach` keep their jobs, with route
   tiles in place of exit throats. Entities are placed as now (`placeEntities`), with tier from
   `Tier(cx, cy)`.

**Edges** (decision 6). There are no exits. The two tiles each side of a chunk edge are decided
only from world-coordinate fields and the epoch's lands, routes and river, which both
neighbours compute the same way, so they always agree. `ensureReach` never edits those tiles; it
carves inward from every open edge tile to a route. So every edge opening leads somewhere, from
both sides.

**Not baked into the chunk:** the frontier. It moves in 0.9 while chunks are immutable, so the
drift at the edge is drawn and enforced at run time (2.5, 2.6), never generated.

**Ids:** entity ids stay `<kind>:<cx>:<cy>:<i>`, now signed. Fixed sites keep their ids (`plank`,
`given`, `echo:<n>`); new repeated sites carry their chunk (`lamp-stone:<cx>:<cy>`). `Epoch` loses `RegionID` and gains `Kind`
(`still` or `wick`); `ChunkSeed` and `LootSeed` follow.

**Version:** generator version 3. v2, its goldens and fixtures are deleted with the clean break
(only the owner plays, so there's nothing to keep).

### 2.3 Epochs, seams and storage

- **Two epoch kinds** in 0.8. The **still** epoch (one per world, never ends) for the Tangle; the
  **wick** epoch (one per world per wick) for everything else. `chunkEpoch(world, cx, cy)` picks
  it. 0.9 adds held chunks that keep an older wick epoch (lamps.md's `held_chunks`).
- **Seams.** Where two neighbours have different epochs (in 0.8 only along the Tangle's edge),
  the newer chunk reads the kept chunk's stored edge and copies its two edge tiles: open where it
  is open, solid where it is solid, and its own river or lake water there becomes bank. A route
  that meets a solid kept edge bends along the seam to the nearest kept opening. In the world it
  reads as the edge of the light.
- **On demand.** The chunk read (and the near read, 2.4) generates a chunk the first time it is
  asked for in its epoch, if `frontier.Inside`, stores the blob, then serves it. The Tangle's nine
  are made at world creation so seams always have their kept side. A unique key on
  `(epoch, layer, cx, cy)` makes two racing requests store one blob.
- **Tables** (migration **034_open_map.sql**, the next free number; 015 stays missing):
  - `wild_epochs` replaces `region_epochs`: id, world_id, kind, season, generator_version,
    starts_at, ends_at; unique `(world_id, kind, season)`.
  - `wilds_chunks` stays (PK `epoch_id, layer, cx, cy`) and references `wild_epochs`.
  - `entity_state`, `personal_claims`, `discoveries` stay epoch-keyed; their rows are cleared.
  - `lanterns` loses `region_id`; one fallen lantern per owner per world.
  - `player_place.last_outer_epoch` becomes `last_wick_epoch` (the `wilds:turned` flag reads it).
  - Saved positions in the Wilds move to the Commons arch, as `migration_028_backfill.go` did.
- **Store** (`store/chunks.go`): `Current` and `Create` take an epoch kind, not a region;
  `GenerateRegion` goes; `deleteStaleEpochs` deletes ended wick epochs and their chunks (and in
  0.9 keeps those a hold names). The LRU stays.

### 2.4 The near read and operations

- **`GET /api/wilds/near/<cx>/<cy>`** replaces the region read. It returns the still and wick
  epochs, the frontier (in 0.8 a rectangle; in 0.9 a chunk set), and for the 5×5 chunks around
  (cx, cy): entity states, your personal claims, discoveries, fallen lanterns, Echo assignments
  where it overlaps the Whitequiet, and the ground changes (section 3). Chunk bodies still come
  from the immutable chunk read.
- **`where`:** area `wilds`, x and y in world pixels. `validArea` (`api/payload_validation.go:56`)
  accepts `wilds`; `nearWilds` checks `frontier.Inside` instead of a region grid; `entityChunk`
  parses signed coordinates; `PlaceFallen` works in world tiles.
- **Story:** the Whitequiet becomes a footprint. `story.Echoes` deals over its nine chunks and its
  east column (cx 1); `Eligible` loops the footprints, not a grid; `Record` writes
  `last_wick_epoch`. Papers' `site`, `east` and `mark` fields keep their meaning.
- **`deepCountry`** becomes `Tier(cx, cy) ≥ 2`, or the Tangle's far chunks as now.
- **Presence:** rooms `wilds:<cx>:<cy>`, signed (`validPresenceRoom`); positions in world pixels.
  The client joins its own chunk's room and its eight neighbours'. If the socket allows only one
  room a client, the lane makes the room the 3×3 cell instead and says so.
- **Gathering** (`api/gathering.go:128`) already works in floor-divided tiles; it loses its
  region parse.

### 2.5 The client: seamless walking

The biggest lane. All of `src/game/wilds/` and parts of the scene code.

- **One Wilds scene, a moving window.** `WorldScene` gets a Wilds mode: the world is unbounded;
  the scene keeps the 3×3 chunks around the hero attached (ground image, collision, props,
  entities, sites) and the ring around that fetched and decoded, attaching a row as the hero
  nears an edge and dropping the far one. No scene restart between chunks; `moveTo` is used only
  for the Commons gate.
- **Positions** in world pixels; the save keeps `area: 'wilds'` and drops `wildsRegion`
  (`src/lib/state.ts:57`). `regions.ts` becomes a coordinates module (`chunkOf`, `tileOf`,
  `localOf`); `parseChunkArea`, `wildsSceneEntry` and the `chunk:<region>:…` area ids go.
- **Ground painting** (`tangle-art.ts` `buildTangleGround`): sample noise in world pixels with the
  world seed, so neighbouring chunk images join; no fake-tree margin except at the frontier,
  where the margin becomes the drift. Meadow, water, bank, ford and laid-path painters join the
  woods painter. Painting stays per chunk and off the walking frame (a chunk is painted when it
  enters the outer ring, before it's attached).
- **Physics and camera:** bounds follow the attached window and stop at the frontier, which is
  also solid in the collision (`collision.ts` gets a frontier edge).
- **Store** (`store.ts`): one view keyed by chunk; `refreshWilds` becomes a near read on entering
  a chunk (at most every 10 s per chunk) and before claims as now. The turning keeps its veil
  (`world-turning.ts`) but no longer sends you home (decision 10): it reloads the window and moves
  the hero to the nearest open tile if needed.
- **Walk speed by ground** (decisions 7 and 12): `Hero.move` (`hero.ts:269`) reads the ground
  under the hero; laid stone or plank × 1.15, ford × 0.5. The server doesn't check movement today
  and this adds no check.
- **Validator** (`src/lib/api/chunks.ts`): drops regions, exits and the 0..2 bounds; checks
  identity, sizes and palette.
- **Unchanged in kind:** camps fight client-side and are leashed to their chunk; claims still
  prove fights to the server.

### 2.6 The frontier at run time

- The server refuses a `where` outside `frontier.Inside`, and generates nothing outside it.
- The client treats chunks outside it as solid and paints the **drift** along its edge: the
  `frontier-veil` art over the boundary, the fogged margin past it.
- Walking into it: the hero stops; a line the first time: "The drift is thick here. Not without a
  lamp." (0.9 gives the lamp.)

### 2.7 Content and contract

- **`content/wilds.json`, version 3:** `generatorVersion: 3`; `regions` go; new:
  - `places`: the Tangle and Whitequiet footprints, their looks and fixed sites.
  - `lands`: `woods` and `meadow`, each with ground palette ids, thicket density, decor weights,
    node material weights, camp-mix weights and a direction lean.
  - `landSizes`: the patch-size table and cap (decision 16).
  - `tiers`: per tier, chest tier range, camp-mix weights, node yield bonus.
  - `frontier`: reach 3, south limit 0.
  - `paths`: clear tools by decor kind, lay costs, walk multipliers.
  - `river`, `road`: widths, lamp-stone spacing.
- **Protos:** `content/v1/wilds.proto` follows; `v1/wilds.proto`'s `WildsChunk` drops `region`,
  `exits` and `spawn`, gains `tier` and `land` (the chunk's main land, for the map);
  `WildsEpoch.region_id` becomes `kind`; a `WildsNearResult`; `GroundChange` and the two
  operations in section 3. `op.proto`'s `Place.outer_epoch` becomes `wick_epoch`.
- **Contract number 8.** Ground and decor ids move from Go constants (`woods_v2.go:35`, `:60`) and
  `decor.ts` into content, so new lands are data.

### 2.8 The map tab

- `src/ui/JournalPanel.svelte` gets a fourth tab, **Map** (`MapTab.svelte`); the `Tab` unions in
  `JournalPanel.svelte:14` and `App.svelte:680` grow.
- Drawn from chunk data, no new art beyond a tab icon: each walked chunk as a 24×24 block of
  ground colours from its palette, laid paths on top, the road and river, the footprints' names,
  the frontier's edge, and you.
- "Walked this wick" is kept on the device per wick epoch (IndexedDB, beside the chunk cache);
  it's a convenience, not server state. The Tangle is always shown.
- 0.9's Lamps tab grows from it.

### 2.9 Words

- The drift at the frontier (2.6), the turning under your feet (decision 10).
- The dark lamp stone's look text, pointing to Mara without promising when.
- Clearing and laying: tool missing ("You'd need a spade for this."), not enough stone or
  timber, can't lay on water, and the confirm before laying on turning land: "This land turns in
  N days. A path here goes with it."
- The meadow and the Wend in the area cards (`src/content/world.ts`), the map tab's labels.
- `world.md` "Today" rewritten (it still says the client generates the Wilds).

## 3. The world-changes layer

One overlay over generated land, built on `worldchange`. Its first users are paths in 0.8; lamps
(0.9), footbridges (lake country) and magic's workings come after.

**How long a change lasts, without extra code.** A change is stored under its chunk's epoch.
When the chunk turns it gets a new epoch and the old changes are simply not read (and are
deleted with the ended epoch). The Tangle's still epoch never ends, so changes there last for
good; 0.9's held chunks keep their epoch, so changes inside lamplight last for good. Magic's
changes (later) also set `ends_at` to the next turning, which `worldchange.Get` already honours.
That is world.md decision 10, by construction.

**Storage.** One `world_changes` row per chunk and epoch, entity `ground`, kind `ground`, state a
`GroundChanges` message: a list of `{tx, ty, change, by, at}` with change `cleared`, `stone` or
`plank`. At most 576 entries; in practice a few dozen. `worldchange` gains `ListChunks(world,
realm, layer, epoch, chunks)` for the near read.

**Operations** (both in one transaction, both refused outside the frontier):

- **`wilds-clear`** `{where, x, y}` (a world tile, within 2 tiles of you). The tile must be a
  clearable decor kind in the chunk with its changes applied: thicket and brush need a spade in
  your pack, a fallen trunk an axe (`paths.clearTools`). Sites, entities, water, fords and the road
  can't be cleared. It costs nothing and yields nothing: gathering stays at nodes, so clearing
  can't become a farm.
- **`wilds-lay`** `{where, x, y, kind}`: the tile must be walkable after changes, not water or a
  ford, and not already laid. Debits 1 stone or 1 timber from your pack.
- **`wilds-lift`** `{where, x, y}`: only a tile you laid; gives the stone or timber back in the
  same transaction, so nothing is duplicated.

**What the server applies.** `wilds.Effective(chunk, changes)` (the land.go `Effective` pattern):
cleared tiles become walkable, laid tiles carry their ground. The server uses it to validate
clears and lays, and to answer "is this tile open" when it moves a hero after a turning. The client
applies the same changes on top of the chunk it drew.

**What "making paths" adds up to.** Clearing opens new ways; laying marks and speeds the ways
you use. Both show on everyone's map. Outside lamplight they're for this wick; with 0.9's lamps,
a stretch of held land with a laid road becomes the first thing a world builds together that
lasts.

**Later users, same layer:** footbridges (a `bridge` change on water tiles, lake country), magic's
heave, brace and pin (kind per working, `ends_at` at the turning), and lamps.md's mage-lit lamp
stones (already designed as `worldchange` rows with `ends_at`).

## 4. Budgets and tests

**Budgets** (each a Go test; the slow ones under `GLIMWAY_PERF=1` as today):

- Generation: p95 ≤ 5 ms a chunk, including lands, river, routes and detail
  (`TestChunkTimeBudget` moves to v3). A whole 0.8 frontier (81 chunks) in under 0.5 s.
- Size: ≤ 6 KiB raw a chunk, as now. Ground changes ≤ 4 KiB a chunk.
- Near read: one query per table, ≤ 20 ms p95 on a warm world with a full frontier.
- Client: painting a chunk ≤ 8 ms on the owner's phone, done before the chunk is attached; no
  dropped frames crossing an edge (an e2e check on frame time while walking across four chunks).

**Go tests** (`server/internal/wilds`, `store`, `api`, `worldchange`):

- `golden_v3.json`: chunk hashes for fixed seeds, epochs and coordinates, including negative ones.
  "A change is a new generator version, never an edit" stays the rule.
- Determinism: a chunk made alone equals the same chunk made in any order.
- **Seam continuity:** for every pair of neighbours in one epoch, the two edge tiles agree.
- **Epoch seams:** for each Tangle edge chunk and several wick epochs, the newer side copies the
  kept edge; no water touches a kept edge.
- **Reach:** from the Commons gate, every place, every route and every open edge tile in the
  frontier is reachable; every route crossing the Wend has a ford.
- **Land guarantees** (decision 17, over 500 seeds): patch sizes match the table within
  tolerance; along any straight line the land changes within the cap; the Wend and some meadow
  are inside the first ring past the Whitequiet.
- `frontier.Inside`, `Tier`, `chunkEpoch` tables, including the south limit.
- Store: on-demand create, two racing creates store one blob, ended wick epochs deleted, still
  epoch kept.
- Near read: shape, 5×5 window, refusal outside the frontier.
- World changes: clear and lay rules, tools, debits, lift refunds only your own, changes vanish
  with the epoch and stay in the Tangle.
- Migration 034 from a 0.7 database: epochs, chunks, positions moved, packs and home chests
  untouched.

**TS tests** (`tests/`): the coordinates module (signed floor-division everywhere), the
validator, the store's chunk-keyed view, walk-speed lookup, the map's walked set, and the updated
`wilds-runtime`, `wilds-chunks`, `presence-client`, `gathering`, `link` and `outbox` tests that
name regions today.

**e2e** (only changed specs per lane; the full suite once at merge):

- New `e2e/open-map.spec.ts`: walk from the gate through the Tangle into the Whitequiet and out
  into the new ring without a scene change; cross the Wend at a ford; meet the drift; reload in
  place.
- New `e2e/paths.spec.ts`: clear with a spade, lay stone, see it on a second account's screen,
  lift it, the turning-land confirm.
- Updated: `wilds.spec.ts`, `wilds-outer.spec.ts`, `wilds-screens.spec.ts`, `gathering.spec.ts`,
  `party-worlds.spec.ts`, `art-screens.spec.ts`, and the helpers (`waitForWilds`, `exitTo`,
  `warp`, `WildsDump`) in `e2e/helpers.ts`.

## 5. Art

Request: [`docs/art-request-open-map.md`](../art-request-open-map.md), Codex Luna, delivered to
`assets/generated/open-map-pass/`. Ground stays code-painted (`tangle-art.ts`); the request
covers pieces the painter can't make well, all straight-on, final art, no placeholders:

- Meadow decor: tall grass clumps, wildflower patches, a stone outcrop (2×2), a lone meadow oak
  (2×3), a fallen stone.
- The Wend: bank pieces (reed-free; reeds are lake country), ford stepping stones (3 frames of
  a slow ripple loop around them).
- Laid paths: stone and plank tiles with variants, which the painter joins.
- The Lantern Road: paving pieces and a road verge.
- From lamps' request, moved here because 0.8 uses them: `lamp-stone-dark` and
  `frontier-veil-0..3`.
- The map tab icon.

## 6. Lanes

| Lane | What | Who | Size | After |
|---|---|---|---|---|
| O-A | Contract and content: wilds.json v3, protos, contract 8, ids into content, vectors | Opus | M | first |
| O-B | The generator v3: cells, lands, the Wend, the road, routes, detail, goldens, budgets | Opus | L | O-A |
| O-C | The server world: epochs, on-demand store, migration 034, near read, `where`, story footprints, presence, the frontier, the world-changes layer and its operations | Opus | L | O-A (O-B for its fixtures) |
| O-D | Seamless walking: the Wilds scene window, coordinates, save, ground painting in world pixels, store, presence, the validator, the turning | Opus | L | O-A; against O-B/O-C on `dev` |
| O-E | Paths and the map: clear, lay and lift UI, walk speed, the Map tab, the drift line, all words | Opus | M | O-C, O-D |
| O-F | Art | Codex Luna | M | anytime |

- **Order:** O-A, then O-B, O-C and O-D side by side, then O-E. O-F runs alongside from the start.
- **The alpha** (decision 14): tag `0.8.0-alpha.1` when O-B, O-C and O-D are merged on `dev`, and
  hand the owner a short walking list. O-E and the art land after.
- **Splits if a lane runs long:** O-C splits world changes out; O-D splits ground painting out.
- No MiMo build lane. Version 0.8.0.

## 7. Later, on purpose

- **Creatures by kind of land** (owner, 2026-10-10): each new land brings its own friendly
  creatures and enemies. They hang off the land's data entry (decision 15), so adding a land
  adds its creatures with it.
- **Lamps and holds** (0.9, lamps.md): `frontier.Inside` and `chunkEpoch` grow held chunks.
- **Lake country:** lakes, reeds, clay, footbridges as world changes, fishing waters.
- **Height bands and the Tops:** cliffs, scree, passes, cave mouths.
- **Shared, server-run enemies** (layers.md): camps stay client-run and chunk-leashed until then.
- **Difficulty past tier 3:** numbers come with lamps.
- **More place kinds per cell,** story sites past the Whitequiet.
- **Painting off the main thread** (OffscreenCanvas in a worker), if the phone budget needs it.
