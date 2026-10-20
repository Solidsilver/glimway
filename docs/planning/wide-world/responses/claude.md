# The wide world: Claude's answer

*2026-10-20, from the brief at dev `8f60f2ca`. Includes the owner's update of the same day: lake
country is one of 0.14's first biomes, and the biome layer must be easy to extend.*

How sure I am: **(sure)** I checked it in code or by running it; **(fairly sure)** reasoned from
the code, worth one more check; **(guess)** judgement, open to argument.

## The short version

1. **The maths isn't the limit. The rules are.** I generated chunks out to 80 million chunks from
   home: each takes about 1.5 ms and comes out sane. What breaks today is the south limit: every
   chunk south of `southLimit` 7 comes out **fully solid** (576 of 576 tiles), because the places
   and routes passes stop there. Put the border at **±4096 chunks** (about 98,000 tiles, roughly
   4 hours' walk from home to the edge). The reason for that number is in §1.
2. **Freeze geography, not detail.** Wild detail is made again every wick anyway. Only the
   lasting landform and held chunks have to survive an upgrade. So split the generator version
   in two: a **landform version**, pinned per biome region, and a **detail version**, which can
   change at any turning. Today `Epoch.landform()` hashes `GeneratorVersion`, so any bump of the
   version re-rolls every river and ridge. That has to change before 0.15.
3. **Biomes are interpreters of frozen fields.** A few world-wide noise fields (height, wet,
   warm) are frozen for ever. A biome is a content entry plus a small Go function that reads
   those fields inside its **biome cells**. A biome cell is pinned to `biome@version` the first
   time anyone comes near it, **together with its eight neighbours**. A biome added later can
   only claim cells nobody has been near, so land already seen never changes.
4. **Height: one surface with levels, like A Link to the Past, plus a cave layer below.** The
   surface is a heightfield: every (x, y) has exactly one level (0–3). Cliffs are drawn wall
   tiles; trails and ramps are the only way between levels. Caves are layer −1 chunks at the
   **same x, y**, so a cave under a mountain really is under it. Because the surface has one
   level per tile, presence, fights, lamps, holds and paths keep their `(layer, x, y)` positions
   unchanged. That is the cheapest way to get real climbing.
5. **First playable slice: "walk any way".** Drop the reach and south limit, add the border, map
   as a window, regenerate instead of storing every chunk, tiers past 3, and world lab v0. Then
   lake country, then the Tops (mountains), then caves.

---

## 1. Endless

### What limits distance today

| Limit | Where | Breaks at | Matters? |
|---|---|---|---|
| `Hash` folds ints as int32 | `hash.go`, `src/lib/hash.ts` | world tile 2³¹ (~89 million chunks): tile coordinates wrap and the world repeats | No, far past any border **(sure)** |
| Value noise lattice | `fixed.go` `noise.lattice` truncates to uint32 | 2³² lattice steps | No **(sure)** |
| `hypot256`, `(dx²+dy²)·fp²` in int64 | `fixed.go` | distances of ~11 million tiles between two points | No, only local distances are measured **(sure)** |
| Generator correctness far out | I ran `GenerateV3` at (30000, 30000), (2²⁰, 2²⁰), (2²⁴, −2²⁴) and (8·10⁷, 8·10⁷) | Nothing broke. North chunks look like normal woods; 1–3 ms each | **(sure)** |
| **The south limit** | `cells.go` `place()` returns nil for `cy0 > southLimit`; `routes.go` too | Every chunk at cy ≥ 8 is all thicket: 576 of 576 tiles solid, no entities | **Yes. This is the real wall today (sure)** |
| Reach | `InsideReach`, `frontier.Inside`, `api/open_map.go` (`beyond-frontier` 409) | 3 chunks past the footprints, plus held slack | Yes: rules, not maths |
| The Wend, the road, rumours | `wend.go` (one polyline that must leave at the south limit's row), `road.go` (`roadReachChunks = 40`), `rumour.go` (places inside reach) | Near home only | Yes: content runs out |
| JS numbers | Pixels are doubles, tile·16 | 2⁵³ | No |
| WebGL float32 | Phaser 3 multiplies camera and sprite matrices on the CPU in doubles and uploads screen-space vertices. No custom shaders use world coordinates (I grepped for pipelines and shaders: none). | Only matters if some path puts world pixels into a float32 | Probably no. Keep a margin anyway **(fairly sure)** |
| Float32Array in `noise.ts` and `ground-paint.ts` | Holds field values, not coordinates. But `smoothField` evaluates `(x·cos + y·sin)/scale` in doubles, then value noise. | If the value noise uses `|0` or `Math.imul` on the lattice coordinate, it wraps at 2³¹ lattice steps | No **(fairly sure)** |
| Proto | Chunk keys are `sint32`; home `Coord` is `int32` tiles; presence `double` pixels | 2³¹ | No |
| SQLite keys | INTEGER is 64-bit | – | No |
| Client caches | `chunks.ts` keeps chunks in memory and IndexedDB, pruned by `keepKey` | If `keepKey` is the frontier rect, an endless rect grows with the world | Check it when the rect goes **(guess)** |
| Open map | `api/open_map.go` and `map-data.ts` walk the whole frontier rect | Endless rect = endless work | Yes: must become a window |

### Where the border sits

**±4096 chunks on both axes (fairly sure).** That is ±98,304 tiles, ±1,572,864 pixels.

- 1,572,864 is below 2²¹. A float32 there still resolves 1/8 of a pixel, so even if some Phaser
  path did hold world pixels in a float32, nothing would shimmer. The border is a safety margin
  for code we haven't read, not the maths' last breath.
- The hero walks at 110 px/s (`hero.ts` `PLAYER_SPEED`), so a chunk takes about 3.5 s. 4096
  chunks is about 4 hours of straight walking. Nobody will walk it casually, and anyone who does
  has earned the sight.
- The area is about 67 million chunks. Pins, explored bitmaps and holds all fit easily (below).
- It goes in `content/wilds.json` as `"border": { "chunks": 4096 }`, so it can be widened later
  without a schema change. Widening is safe. Narrowing isn't.

### What the border is in the world

The edge is the **far Whitequiet**: a pale band that thickens over the last ~16 chunks into
solid white you can't walk into. It uses the same veil art as today's drift edge. The lore
choice is the owner's; three options for canon §2.4:

- **A. The Whitequiet breathes out (my pick).** The Whitequiet was never meant to sit at
  Hearthwick's door. It closed in when the road broke: thirty years with no lamps along it, and
  the edge crept to the Tangle. With the road relit and way-lamps burning (0.12–0.13), it draws
  back to where it belongs, at the far rim of the world. Light still pushes it, but the far
  edge is something nobody has enough light to move. It makes 0.14's release a story beat: the
  notice board posts "The Whitequiet has drawn back." Trinkets and Echoes still surface in pale
  pockets (below).
- **B. The Whitequiet is the unseen.** No wall nearby. Land you haven't walked is white on
  *your* map and pale for a moment as you first see it. The rim is the Deep Measure's end:
  "the Sheer", where the bedrock stops. This puts the Whitequiet into the map fog rather than
  the world.
- **C. The Whitequiet becomes weather.** Pale patches drift across the Wilds and turn every
  wick. They are where trinkets surface. The rim is natural: sea to the south-west (the Merrow
  Saltings), high Tops to the west, and so on, like an ordinary map's edge.

A and B combine well: A for the rim, B for the map. The Whitequiet footprint north of the Tangle
stays as a place either way. Its name now marks where the edge *used to be*.

### What replaces the frontier rule

**No reach limit. Two other limits instead (fairly sure):**

1. **The border** (above).
2. **You can only read what's near you.** The near read and chunk reads answer only for chunks
   within the 5×5 window around the player's last position the server trusts (presence or the
   last op's `where`), plus anything held or on their map window at glimpse detail. That stops
   a script from crawling the world through the API, which today's reach does by accident.
   The 409 `beyond-frontier` becomes `beyond-sight`.

Held slack (`heldSlack` 3) and `frontier.go` then have nothing to do. Delete `frontier` as a
rule and keep its held-key index for the map.

### Storage: store, regenerate, prune

Today chunks are "stored when first read" (`store/chunks.go`). Far walkers make that expensive.
A walker crossing a chunk every 3.5 s with a 5×5 fetch window sees about 1.4 new chunks a
second: **about 5,000 chunks an hour**. Generation is cheap (1.5 ms each, so about 2 ms of CPU a
second per walker). Storage isn't: at a few KB a blob, that's tens of MB per walker-hour, gone
at the turning but still churn.

Proposal **(fairly sure)**:

- **Stored:** held chunks (their blob is the hold, as now); chunks with Common or Built state;
  chunks that hold a player-made change (`lasting_geography_paths`, placed items). Biome pins
  (§2). Per-player explored bitmaps (below).
- **Regenerated:** every other wick chunk, on each read, from (epoch, cx, cy). Keep the
  in-memory LRU (`ChunkCacheSize` 512; raise to ~4096). The generator is a pure function and
  the epoch names its generator versions, so a read after a deploy still gets the same chunk as
  long as the old version's code is kept. That's already the rule for goldens.
- **Pruned:** at each turning, as now, unheld chunks of the ended epoch go with it.
  `chunk_visits` rows older than one wick go too.

Entity state (`entity_state`) stays keyed by epoch and entity id; it needs no chunk blob.

### The open map as a window

- The map shows a window of **±32 chunks** round the player at glimpse detail (land and river,
  from `Glimpses`, about 0.1 ms per world build plus a cheap sample per chunk). 4,225 glimpses is
  a few ms; cache by epoch.
- Beyond that it shows only what you have **explored**: a per-player bitmap per 64×64-chunk
  region (512 bytes each, a row per region visited), plus every held chunk and named lamp in
  the world. Unexplored land is white: option B made literal.
- Zooming out past the window draws explored regions from a server-rendered thumbnail per
  region (one pixel per chunk, cached), not chunk by chunk.
- `api/open_map.go` stops walking the frontier rect; the client's `map-data.ts` stops building
  the whole rect.

### Difficulty and tiers past 3

`Tier` today is `min(2 + ring − 1, len(tiers))`, so it hits 3 about six chunks out and stays
there for ever. Proposal **(guess)**:

- Tier by distance from the Commons gate, in bands that widen: tier 3 to 20 chunks, 4 to 60,
  5 to 150, 6 beyond. Cap at 6 for 0.14. Distances in `content/wilds.json` as
  `"tierBands": [6, 20, 60, 150]`.
- A biome can add ±1 (the Tops harder, lake country gentler).
- Content for tiers 4–6 is stat scaling of wisps and beetles plus recoloured "far" variants,
  until a creatures release. Loot tables scale by tier, as chests already do.
- A far camp's lamp doesn't lower the tier. Far land is far.

### The road, the river and rumours, per region

- **The Lantern Road** keeps its line to Sallow Ford (canon, north-east), which becomes a fixed
  place at a set distance (say 60 chunks). Past that, the **old ways**: one waypoint per
  **32×32-chunk road region** (seeded, landform hash), joined to its east and south neighbours
  with some chance, laid as worn tracks with the route machinery in `routes.go`. A road never
  needs to know more than two regions.
- **Rivers**: the Wend stays the one hand-shaped river near home. Elsewhere, rivers come from
  the height field: a river starts at a mountain or high ground in a biome cell and runs
  downhill to a lake or to an **edge point** of its cell. Each cell edge has 0–1 crossing point,
  hashed from the edge's own key (the same trick as `gaps` today), so both neighbours agree. A
  river is lasting geography.
- **Rumours** pick from places within ~12 chunks of the board's reader's *last camp or lamp*,
  not near Hearthwick only. The board shows the nearest few.

### Ways home on a long walk

Walking is always free, and the tools exist: the homing turncap (to the north arch), the
lamp-ash pouch (to your lamp), and way-lamps as places to rest. Add only **(fairly sure)**:

- The map always shows the bearing and distance to Hearthwick and to your nearest lit lamp.
- Today's walked trail on your map, for the session (client-only breadcrumbs).
- No new teleport in 0.14. The point of a far lamp is that it's your way home.

### Costs per far walker

- **Server:** ~2 ms CPU a second for generation; near reads as today; no extra DB writes unless
  something is changed or held. Explored bitmaps: one upsert per new region entered.
- **Client:** the window is constant (3×3 attached, 5×5 fetched), so memory is constant if the
  caches are pruned by distance rather than the frontier. Paint workers per chunk as now.
- **Presence:** players far apart are in different chunk rooms; no new cost.

## 2. Biomes

### The layers

From the bottom up. Each layer reads only the layers below it.

1. **Fields (frozen at 0.15, for ever).** A few world-wide noise fields of world tile and world
   seed only: `height`, `wet`, `warm`, and `rugged` (a sparse ridged mask that says where ranges
   may stand). Integer value noise, as `fixed.go` already does, several octaves. Hashed with
   `fieldsVersion` 1, never with `GeneratorVersion`. The canon lean (the Tops west, lake
   country low and near the Wend, Sallow Ford's country north-east) is a bias added to the
   fields by direction from the gate, as `lands.go` leans land weights today.
2. **Biome cells.** A warped Voronoi partition of the world in cells of about **32 chunks**
   (768 tiles). The partition itself is frozen too: which tile belongs to which cell never
   changes. Each cell has one biome.
3. **Lands inside a biome.** Today's `lands.go` (7-chunk land cells, patches, hems, islands)
   stays, but a land point's kind is drawn from **its biome's** land weights. Today's world
   becomes the biome `hearthwick-woods`, with woods and meadow as now.
4. **Features.** Lakes, ranges, rivers, cave systems: each a biome's call, read from the fields.
5. **Detail.** Today's `detail_v3.go`, seasoned hash, turns every wick.

### Choosing a biome for a cell

Each biome in content says what fields it likes, and a weight:

```json
"biomes": [
  { "id": "hearthwick-woods", "version": 1, "weight": 10,
    "fits": { "height": [0, 600], "wet": [200, 800] },
    "lands": [{ "land": "woods", "weight": 7 }, { "land": "meadow", "weight": 3 }],
    "tierShift": 0 },
  { "id": "lake-country", "version": 1, "weight": 8,
    "fits": { "height": [0, 350], "wet": [550, 1000] },
    "lands": [{ "land": "meadow", "weight": 6 }, { "land": "reedmarsh", "weight": 3 }, { "land": "carr", "weight": 2 }],
    "features": { "lakes": { "waterLevel": 300, "minTiles": 40 } } },
  { "id": "the-tops", "version": 1, "weight": 6,
    "fits": { "height": [450, 1000] },
    "lands": [{ "land": "upland", "weight": 6 }, { "land": "pinewood", "weight": 3 }],
    "features": { "ranges": { "rugged": 500, "levels": 3 } }, "tierShift": 1 }
]
```

A cell takes the mean of the fields at its seed point, keeps the biomes that fit, and draws one
by weight with the cell's landform hash. Close to home, fixed: the cells round the Tangle are
`hearthwick-woods` by rule, so today's near land doesn't move **(fairly sure)**.

### Pinning, and how a later biome is added (the extension seam)

The owner wants many biomes later, each as content plus a small generator piece, without
reshaping land already seen. The seam **(fairly sure; the most important part of this answer)**:

- **A pin table.** `biome_pins(world_id, bx, by, biome, version, pinned_at)`. When any chunk of a
  cell is first generated, the server pins **that cell and its eight neighbours** (only the ids,
  nothing is generated). At most ~65,000 cells inside the border: a tiny table.
- **A cell's content is a function of its own pin and its neighbours' pins.** Edges blend using
  the neighbours' pinned biomes, so nothing on a seen cell's edge can change later either.
- **A new biome** (content entry + Go function registered by id, `biomes/<id>.go`) is chosen
  only for cells with no pin. With pins one ring ahead, new biomes appear at least one cell (32
  chunks) away from anything anyone has seen. In an endless world that's always available.
- **Improving a biome** is `lake-country@2`. Pinned cells keep `@1` for ever; the `@1` code
  stays, like old generator versions do now. Until the 0.15 freeze, just wipe the pins and
  regenerate.
- **Only lasting geography is pinned.** The detail (trees, forage, creatures) of a pinned cell
  may change at the next turning with a new detail version; nobody can tell it from a turning.
  Held chunks are stored blobs and never regenerate.

A biome's Go piece is one interface:

```go
type Biome interface {
    // Lasting: decides the land kind weights, lakes, ranges, cave sites for a cell.
    Landform(c *CellCtx) // reads fields, own pin, neighbour pins; landform hash only
    // Living: entity mixes, decor, forage per land; seasoned hash.
    Dress(d *detail, land int)
}
```

Most of a new biome is content: lands, grounds, decor weights, materials, enemy mixes. The Go
piece is only there for its special landform (lakes, ranges, a sap bog's pools).

### How biomes meet

- **Soft by default.** Land points (7-chunk cells) within ~1.5 land cells of a biome border
  draw their land from both biomes' weights, weighted by distance. Patches interleave across the
  border, with today's hems between them. You walk through a few patches of mixed land rather
  than over a line.
- **Hard where geography says.** A range's foot or a river makes a hard edge; where a biome
  cell edge runs near one, snap the blend to it.
- Never a straight line: the cell partition is warped, like `warpX`/`warpY` today.

### The first biomes, and why

1. **`hearthwick-woods`**: today's land, refactored as a biome. Zero new art, and proof that
   the layering keeps today's near land the same.
2. **`lake-country`** (owner's call): the first new one. It needs no height, uses water and
   bank grounds that exist, and shows off lasting geography. **Lakes** are where `height` dips
   under the biome's water level, with a bank all round and reeds at the shore; river clay on
   bends; meadow and alder carr between. Gathering: reed beds, clay banks, willow
   (`design/world.md` "Lake country first").
3. **`the-tops`**: uplands where `rugged` is high. It carries mountains and cave mouths (§3),
   so it is the height slice.

A note for fishing **(fairly sure)**: `design/fishing.md` says a water gets fresh stock at the
weekly reshuffle and fisheries are `water:<chunk key>:<n>`. With lasting geography, a lake keeps
its shape every wick, so key fisheries by a **lasting lake id** (`lake:<bx>:<by>:<n>`, from the
landform pass) and let stock recover over time, as a held water does. One lake across two chunks
is then one fishery, which is simpler. Fishing itself can stay in 0.17; the generator should
produce the lake ids and areas now.

## 3. Height

### (a) Drawn height: one walkable plane

Mountains are masses of solid tiles drawn as rock, with flat trails cut through them. Caves are
layer −1, entered through a door-like mouth.

- **Storage:** nothing new on the surface; decor and grounds. Caves are layer −1 chunks.
- **Physics, draw order:** unchanged.
- **Presence, fights, creatures, lamps, holds, desire paths, building:** unchanged.
- **Map:** paint rock darker.
- **Transitions:** a fade to black at the mouth works. **Fog below a mountain doesn't**: you're
  never above anything, so there's nothing to fog.
- **Verdict:** cheap and safe, but "climbing a mountain" is walking through a rock-coloured
  corridor. It misses the owner's must-have.

### (b) Real surface levels, per tile, in a 3D sense

Several heights per tile, overlapping surfaces, bridges over paths, level-aware everything.

- **Storage:** per-tile level plus overlaps (a tile may have two walkable heights).
- **Everything** (presence, fights, holds, paths, building) needs a z. The draw order needs
  vertical offsets. Collision needs per-level grids. Big.
- Overlapping surfaces were cut ("no layer above ground").
- **Verdict:** too much for the gain.

### (c) My pick: a heightfield surface with levels, plus a cave layer

Like A Link to the Past: one plane, no vertical offset in coordinates, but each surface tile has
exactly **one** level, 0–3. Cliffs are wall tiles drawn on the faces between levels. Trails,
ramps and stairs are the only ways from one level to the next.

- **Storage:** one more nibble array in the chunk, `level` (288 bytes), from the `height` field
  through the biome's range shapes. Ramps are grounds (`trail-up`, `stair`) with a surface kind
  `ramp`. Cliff faces are solid tiles with a `cliff` ground for art.
- **Physics:** the hero has a level. A tile is walkable for the hero if it is walkable *and*
  (same level, or a ramp joining the two). When the hero's level changes on a ramp, rebuild the
  collision for the 3×3 attached chunks (5,184 tiles, cheap). Arcade physics stays as is.
- **Draw order:** y-sort as now. Cliff faces are tiles south of a higher area, so a plateau's
  face hides what's behind it, as it should. Levels never overlap, so nothing needs a z.
- **Position:** the level is a function of (layer, x, y) on the surface, so **every existing
  position stays `(layer, x, y)`**: presence, ops' `where`, camp pieces, lamps, holds, desire
  paths, entity tiles. This is the big win over (b).
- **Fights:** a fight only joins players and creatures of the same level (or within a ramp's
  reach). Shooting down a cliff: no, for now.
- **Creatures:** a creature keeps its spawn level; its leash and chase are level-aware. Running
  uphill to escape is a legitimate move.
- **Lamps, holds:** a lamp sits on a tile like now; its light circle lights every level it
  covers. Holds are chunks, unchanged.
- **Desire paths:** a path tile is a tile; paths across levels only on ramps, which the reach
  rules enforce.
- **Building (0.15):** placement checks the tile's level and the piece's footprint stays on one
  level. Halls underground (below) are good build sites later.
- **Generator:** the reach pass (`ensureReach` in `detail_v3.go`) becomes level-aware: two tiles
  join when walkable and same level, or one is a ramp to the other's level. Trails up a range are
  laid with `cheapest()` with a cost for climbing and the rule that a level change needs a ramp
  tile; a range gets 1–2 trails up and, sometimes, a pass across (the owner's "sometimes a way
  across a whole range").
- **Map:** hillshade from `level` (procedural), trails drawn, peaks named later.
- **Fog below:** when the hero is on level ≥ 2, tiles two or more levels below get a sky-colour
  tint whose alpha rises with the difference. A per-chunk overlay texture built from `level`;
  tween its alpha as the hero climbs. Cheap on mobile.

### Caves: layer −1 at the same coordinates

- **Cave systems** are a biome feature: 0–2 per biome cell in the Tops (fewer elsewhere), each a
  footprint of 2–6 chunks at layer −1, often under a range. A cave system is **lasting**
  (Deep Measure: stone remembers its shape, canon §2.1); its contents (creatures, forage, amber
  seams) turn with the wick of the surface chunk its main mouth is in.
- **Shape:** one or two **halls** (big open spaces, the owner's "maybe a base someday"), joined
  by tunnels to 1–3 **mouths**. Integer cellular automata for halls, `cheapest()` for tunnels.
- **Mouths:** a mouth is a surface tile (at a cliff foot, or a sinkhole in open ground) and a
  layer −1 tile at the same (x, y). It's a ramp between layers: walking down it flips the hero
  to layer −1 over a few tiles. Some caves have two mouths on opposite sides of a range: the
  underground way across.
- **Layer −1 chunks outside any cave** are solid rock. They aren't generated, stored or fetched;
  the client knows them from the cave index sent with the near read.
- **Seamless:** both layers live in the one scene. Entering a mouth tweens the surface layer to
  black over ~0.5 s, except round the hero's lantern (a black overlay with a radial hole that
  follows the hero; avoid Phaser's Light2D on phones). Inside, you see only layer −1 and your
  light. Coming out, the reverse. No scene change, no loading door.
- **What's at layer −1 already works:** `WildsChunkKey.layer`, `holds.layer`, `chunk_visits.layer`
  and the `wilds_chunks` primary key all carry it **(sure)**. `lasting_geography_paths.chunk`
  is a text key: check that it includes the layer.

### The recommendation

**(c) heightfield levels on the surface + layer −1 caves (fairly sure).** It's the cheapest
design that gives real climbing with fog below and real caves under mountains, and it keeps
every position two-dimensional. The spike (`exp/height-spike`) should test three things first:
cliff art from a small autotile set, level-aware collision swaps on a ramp, and the
fade-to-black overlay on a phone.

## 4. The chunk contract

**Key:** keep `WildsChunkKey { realm, layer, cx, cy }`. Surface is layer 0, caves are −1.
Nothing above ground (cut).

**Payload (`WorldChunk`) additions, all optional fields (fairly sure):**

| Field | Type | What |
|---|---|---|
| `level = 22` | `bytes`, a nibble per tile | Surface level 0–3; in a cave, 0 (floor) or 1 (ledge) |
| `biome = 23` | `string` | `lake-country@1`, the cell's pin |
| `waters = 24` | `repeated WildsWater { string id; uint32 area; string habitat; }` | Lasting lake and river stretch ids that touch the chunk |
| `mouths = 25` | `repeated WildsMouth { string cave_id; uint32 tx; uint32 ty; sint32 to_layer; }` | Cave mouths here |
| `detail_version = 26` | `uint32` | The detail generator, separate from the landform's |

And one change: **make `ground` one byte per tile now** (fairly sure). The nibble allows 16
grounds per chunk. Two biomes blending, plus water, bank, ford, ramps, cliffs, paths and laid
ground, will hit 16. It costs 288 bytes per chunk before compression. Changing it after the
freeze would be a clean break, which we won't have.

**The epoch:** `GeneratorVersion` becomes two numbers: `fieldsVersion` (frozen at 1) for the
landform hash, and `detailVersion` for the seasoned hash. `Epoch.landform()` stops hashing
`GeneratorVersion`.

**Frozen at 0.15:**

- the key shape and coordinate conventions (tile 16 px, chunk 24 tiles, north −y, layer −1 below);
- the fields functions (v1) and the biome cell partition;
- `biome_pins` and the rule that a pin is never overwritten;
- every `biome@version` landform function that has a pin anywhere;
- the payload's existing field numbers (protobuf additions stay free);
- the border can only widen.

**Not frozen:** detail generation (it turns weekly anyway), tier bands, biome weights for
unpinned cells, content (enemies, loot, decor).

## 5. The iteration loop: a world lab

The owner wants generation to be fun to iterate on. Build `server/cmd/worldlab`: a small Go HTTP
server that renders straight from the generator, run locally (or on the dev host's dev port,
never the live service).

- **Three zooms:**
  - *Atlas*: one pixel per chunk, from fields, pins and glimpses only, no chunks made.
    1000×1000 chunks in a second or two. Shows biome cells, lakes, ranges, rivers, roads, tiers.
  - *Region*: one pixel per tile, real chunks made in parallel. 100×100 chunks is 10,000
    chunks at 1.5 ms, about 2 s on 8 cores. Hillshade from `level`.
  - *Chunk*: tiles at 4×, with decor, entities and the reach graph.
- **Live content:** watch `content/wilds.json` and re-render when it's saved. Change a biome's
  weight or a lake's water level and see it in seconds.
- **Knobs in the page:** seed, season, layer (surface / caves), overlays (biome cells, fields as
  heatmaps, tiers, levels, reach, cave footprints), and a "fresh world" button.
- **A/B:** two panes, two git refs or two content files, same seed, with a diff overlay that
  lights changed tiles. The test that a change doesn't move pinned land is a lab view too.
- **Stats:** share of each biome and land, solid share, lakes per 100 chunks, mountains and
  caves per 100 chunks, the longest walk without a change of land (decision 17's cap),
  unreachable tiles. The numbers make tuning rounds comparable.
- **PNG out:** `worldlab png --seed x --atlas -500,-500,500,500 out.png`, so agents can look
  at a change themselves (they can read images) and attach before/after pictures to a lane.
- **Into the game:** a dev-only "go here" link that drops the hero at those coordinates in a
  dev world.

Build on `render_v3_test.go` (`groundColours`, its chunk loop) and `glimpse.go`. Move the
colours into content so a new ground shows up without code.

## 6. Art

The art model's time is scarce. What must be drawn, by part:

| Part | Must draw | Procedural or recolour |
|---|---|---|
| Endless | Nothing | Far-Whitequiet veil (today's drift art, scaled); tier 4–6 enemy variants as palette swaps |
| Lake country | **Reeds** (2–3 props), **willow/alder** (1–2 trees), a **clay bank** prop | Lake water and banks (exist); lily pads, shore pebbles, clay ground (recolours); reed-bed ground (noise in `ground-paint.ts`) |
| The Tops | **Cliff autotile set**: one 16-tile Wang corner set (the one big ask); **ramp/stair** pieces (2–3); a **cairn** at trail tops | Scree and upland grounds (noise); pines (exist); snow on high levels (tint by level); fog below (procedural overlay); map hillshade |
| Caves | **Mouth** in a cliff face, **sinkhole** mouth; 3–4 cave props (stalagmite, amber seam, mushroom cluster) | Cave walls (the cliff set, darkened); cave floor (noise); darkness and lantern light (procedural) |

So four asks to the art model: reeds and willow, the cliff set, ramps and mouths, cave props.
The cliff set is the gate for the Tops slice; ask for it first.

## 7. Slicing

Each slice is playable on `dev`, with an alpha tag and a short playtest list.

1. **0.14-a1 "Walk any way" (the first one).**
   - Drop `reach` and `southLimit`; fix places, routes and the Wend's south rule so the south is
     land, not thicket.
   - Border at ±4096 chunks, drawn as the far Whitequiet.
   - Reads limited to the window round the player (`beyond-sight`).
   - Regenerate unheld wick chunks instead of storing them; bigger LRU.
   - Map as a ±32-chunk window plus a per-player explored bitmap.
   - Tier bands to tier 6 with scaled enemies.
   - Map bearing to Hearthwick and nearest lamp.
   - World lab v0: atlas and region PNGs from the CLI.
   - Split `fieldsVersion` from `GeneratorVersion`.
   - *Playtest:* walk an hour south and west; find land, a camp, a harder fight; get home.
2. **0.14-a2 "Lake country".** Fields, biome cells, pins, `hearthwick-woods` as a biome, lake
   country with lakes, reeds, clay and willow, soft borders, lasting lake ids. World lab live
   page. *Playtest:* find lake country, gather reed and clay, see the border blend.
3. **0.14-a3 "The Tops".** Surface levels, cliffs, ranges with trails and the odd pass, fog
   below, level-aware creatures and fights. Uses the spike's results. *Playtest:* climb, look
   down, get chased up a trail.
4. **0.14-a4 "Below".** Layer −1 caves, mouths, halls, fade to black, caves under ranges.
   *Playtest:* walk into a cave, through a range, out the other side.
5. **0.14-a5 "Far roads" and tuning.** Old ways per road region, rivers per cell, rumours near
   your lamps; two or three tuning rounds with the world lab. Then release 0.14.

a3 and a4 can swap if the spike finds caves easier than cliffs.

## 8. Risks and open questions

Each as a choice, my recommendation first.

1. **Border distance.** ±4096 chunks (recommended: safe margin, hours of walking) / ±1024 (a
   smaller world that feels fuller) / ±2²⁰ (as far as the maths goes; untested code paths).
2. **The Whitequiet (lore).** A, it breathes out to the rim (recommended), with B for the map /
   B alone / C, weather. Owner's call.
3. **Height model.** Heightfield levels + cave layer (recommended) / drawn height / full levels.
4. **Storage.** Regenerate unheld wick chunks (recommended) / keep storing on first read and
   prune at the turning.
5. **Do caves turn?** Shape lasting, contents turn (recommended, fits §2.1) / everything turns
   (repeatable delves) / nothing turns.
6. **Fisheries.** Lasting lake ids with slow recovery (recommended) / `fishing.md`'s weekly
   reshuffle per chunk.
7. **Adding biomes after the freeze.** Pins one ring ahead (recommended) / a world-wide
   generator version per region, Minecraft-style (visible seams where old meets new).
8. **Ground byte.** One byte per tile now (recommended) / keep nibbles and cap grounds per chunk.
9. **Tiers past 3.** Widening bands to 6 with scaled enemies (recommended) / stay at 3 until
   creatures exist.
10. **Near-home sameness.** The cells round the Tangle stay `hearthwick-woods` (recommended), so
    playtesters' known land doesn't move / let near cells draw biomes too (more variety near
    home, but the land round town changes once at 0.14).
11. **Read limit.** Window round the player (recommended) / none.

Risks to watch:

- **Empty far land.** With places only in cells and rumours near home, far land can feel
  samey. The atlas stats should track "chunks without a place or landmark".
- **Mobile cost of overlays** (fog and darkness). Test on a phone in the spike.
- **Old code kept for ever.** Each pinned `biome@version` keeps its code. Fine if the pieces are
  small. That's the reason to keep each biome's Go piece small.
- **The pin race.** Two players entering two neighbouring unpinned cells at once: pin in one
  transaction with `INSERT OR IGNORE` and read back, so the first pin wins.
- **A deploy mid-wick** with a detail change: wick chunks are regenerated, so the epoch must name
  its `detailVersion` and the server must keep that code until the wick ends. Same rule as today.
