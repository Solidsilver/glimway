# The location seam

2026-10-13. Design for the agreed seamless path, step 1 ([seamless-world.md](seamless-world.md#owner-decisions-2026-10-11)), written against `exp/location-seam` at `31b4144` (dev with refactor stages 1–4). No source changes.

This is the exploration's **lane 1, "Geography and location contract"**, made concrete: its sections ["Keep physical space separate from named places"](seamless-world.md#keep-physical-space-separate-from-named-places) and the dependency table under them are the starting point. Section 6 is the detailed build plan for its **stage 2, "Small crossing playtest"**: Commons ↔ Tangle. The village layout and its rationale stay in [continuous-village.md](continuous-village.md); the fight rules that this seam must keep are in [shared-fights.md §1.11](shared-fights.md#111-seams-for-a-seamless-world). This doc does not repeat either.

## 0. Owner decisions (2026-10-13)

Decisions 1–9 were agreed in the design conversation for this lane; 10 and 11 answer §7 later the same day.

1. **The server owns the world; the client renders and interacts.** Authored outdoor places become **layout data in `content/`**, which the server reads, composes and serves. The client keeps no world-building code, only drawing, interaction and prediction, keyed by object kind. The TypeScript Commons builder goes.
2. **Everything outdoors reaches the client as chunks.** The server's chunk composer picks one source per chunk, in this order: **fixed** (authored layout) → **held** (a kept epoch; Lamps) → **generated** (still or wick). Mixed chunks (a generated fill with an authored stamp over it) come later, when something actually mixes. The Commons fills whole chunks, so step 3 needs only the fixed source.
3. **The saved area `wilds` becomes `outdoors`.** A clean break; presence rooms become `outdoors:<cx>:<cy>`. Every `== 'wilds'` check moves to the place lookup.
4. **Step 3 uses today's Commons**, moved onto the grid at the trial origin (continuous-village §9) and **frozen at a fixed size**. Home gates and the village exit stay transitions.
5. **Order after this:** Commons/Tangle join → **one town**: village and Commons redesigned together, with the town sitting in the middle of the Wilds, roads out in several directions, and generated outskirts where players build → **holds engine, then Lamps** → **hearths**.
6. **Lamps dim.** Extension lamps burn oil and go dark unless tended; anyone may tend or refuel. A craftable **oil store** placed near your lamps buffers oil for the lamps linked to it. Upkeep bounds how much land a player can keep. A lamp warns for a wick before its land turns; things built there return to home storage. *(Changes [lamps.md](lamps.md) decision 7, "for good"; numbers later.)*
7. **Homes.** A home's **hearth** holds its core plot for good. Existing homes **migrate into a dedicated plot area by the town**: a fixed set of indexed lots, gate *n* → lot *n*, keeping every home, member and item. Later a household can take up its deed and move to a hearth site in the Wilds (the harder H3 move). Smart players settle beside the town and light their way out.
8. **Access survives the turning, its direction need not.** New wick land beside held land must connect at least one of the held patch's openings to the walkable network. The homing turncap is the fallback.
9. **Long term:** the town feels set *in* the Wilds, open on several sides. Story places (Brackenwood, Ashwatch) and later quest sites may become **fixed outposts** out in the Wilds, reached through changing land under the same access rule.
10. **Commons capacity: 8 gates** (§7 #1, decided later on 2026-10-13). The live server has 3 homes, and a Habitica party holds at most 30. The frozen Commons keeps the four designed gate rows (y = 9, 13, 28, 33): eight gate spots in two chunk rows. Growth past eight comes from shared plots or Wilds claims, not more Commons rows.
11. **§7 #2–6 accepted as recommended** (owner, 2026-10-13: "Yes to all"). Off-grid drift south of and beside the Commons for now. The safety boundary runs across the gate mouth at y = 24. Riding is unchanged. There is no flag: S1–S5 merge to `dev` as a clean break. S2's served-Commons-behind-portals step stays.

These reopen two continuous-village decisions for the town redesign: "the Commons stays its own district" and the eight fixed H1 envelopes. They change nothing in step 3.

## 1. The location model

### 1.1 Terms

| Term | Meaning | Where it lives |
|---|---|---|
| **world** | The invite world. Never in a `Where`; it comes from the lease/session. | as today |
| **space** | The coordinate frame a position is in: `outdoors`; a curated place not yet joined (`village`, `woodland`, `ruin`); `home:<g>`; `in:<room>`. **The saved area is the space.** | `player_place.area`, `Where.area`, `Place.area` |
| **realm, layer** | Of `outdoors`: `hearthwick`, `0` ([world.md](world.md#coordinates); `content/wilds.json` `realm`). Other spaces have none. | content |
| **chunk** | `(cx, cy)` = floor(tile / 24) in `outdoors`. Chunk (0,0) is the Tangle gate's. | `wilds` coords helpers |
| **source** | A chunk's ground: `fixed(layout, revision)`, `held(epoch)` (later), `generated(still \| wick epoch)`. | server composer |
| **epoch** | Only held and generated chunks have one. Fixed chunks have none: no fight room, no wick, no expiring rows. | `wild_epochs` |
| **place** | The named region a position is in: `commons`, `tangle`, `whitequiet`, `beyond`; later town districts, lots, outposts. **Derived by lookup, never stored.** | `location.At` |
| **anchor** | A stable id resolved to a `(space, x, y)`: `commons:arch`, `commons:yard-door`, `commons:west-path`, `commons:gate:<g>`, … Doors, arrivals and recovery refer to anchors, never coordinates. | layout data |

Interiors stay transitions and keep their own coordinates (decision from [seamless-world.md](seamless-world.md#owner-decisions-2026-10-11)).

### 1.2 Types and data

**Content** (new; proto `proto/glimway/content/v1/places.proto`, loaders `content/places.go`, `src/lib/places.ts`):

- `content/places.json` (built in S1): `fixed` footprints, the `generated` rules and the `spaces` rules.
  - Each **fixed** footprint has an id (`commons`), a layout id and revision, an **origin tile** (the world tile of layout tile 0,0), a **chunk-aligned rect** (`cx`, `cy`, `width`, `height`, as Wilds footprints spell it), its own **rules** (`safe`, `ride`, `sync`, `rest`), optional **zones** (layout-tile rects with a `place` id and rules; the first zone holding a tile wins, else the footprint's rules) and its **anchors** (`{id, tx, ty}` in layout tiles; `commons:gate:<g>` is the anchor `gate:<g>`, one per gate of the frozen capacity). Zones and anchors stay inside the footprint; footprints keep apart from each other and from the Wilds footprints and never take a Wilds footprint's or a space's id (loader rules, Go and TS).
  - **generated** is the one rule set every generated place shares. Generated places keep coming from `content/wilds.json` footprints (Tangle: still; Whitequiet: wick); everything else generated is `beyond`.
  - **spaces** holds the rules of `village`, `woodland`, `ruin` and every `home:<g>`. A room `in:<…>` takes its root's rules (`content.RootArea`; a fixed place's own rules for `in:commons:…`) with riding off.
  - `rest` is `none`, `village` (spend `rest`) or `home` (`home-rest`). Road-lantern rest is a light rule, not a place's. Sync needs safe (schema rule).
  - The schema bounds every coordinate (S1 review P2): fixed chunks to ±32768, origins, zones and anchors to ±2^20 tiles, and zone sides to 384 tiles. With those bounds, every world tile and pixel the lookup computes is exact in int32 and float64, so Go and TypeScript agree.
- `content/layouts/commons.json`: the layout. Ground as a palette-indexed tile grid, a solid grid, and **objects**. Each object has a stable id, kind (`tree`, `lamp`, `board`, `well`, `gate`, `door`, `exit`, `npc-post`, `repair`, `gather`, `sign`, `shelf`, `prop`), tile, footprint, variant and optional festival tag. It is exported once from today's `buildCommons(capacity)` by a script, then edited as data.

**Go**, new package `server/internal/location` (pure, content only, no store):

```go
type Space string                 // "outdoors", "village", "home:3", "in:commons:yard"
const Outdoors Space = "outdoors"

type Source struct { Kind SourceKind; Layout string; Revision int32; EpochKind string } // None (off the grid) | Fixed | Generated (| Held later)
type Place struct {
    ID                    string // "commons", "tangle", "beyond", or the space id for non-outdoors spaces
    Safe, Ride, Sync      bool
    Rest                  RestKind
    Source                Source // outdoors only
}

func At(space Space, x, y float64) Place        // the lookup (shared-fights §1.11's "one function")
func SourceOf(cx, cy int) Source                // fixed footprint, else generated (held: a store-backed wrapper later)
func OnGrid(world string, cx, cy int) bool       // frontier.Inside(world, cx, cy) || fixed footprint covers it
func Anchor(id string) (Space, float64, float64, bool)
func Resolve(area string, tx, ty int) (Space, int, int) // area-local content tile → space tile (commons → outdoors + origin)
```

`At` on a fixed place's own id as the space (`commons`, until the join) reads layout pixels through the origin, so the answer is the same before and after S5. A space nothing names (including `wilds`, until S3 renames it) allows nothing.

**TypeScript** mirror in `src/lib/location.ts`, same names in camelCase (`at`, `sourceOf`, `onGrid`, `anchor`, `resolve`; `onGrid` takes no world, as `insideFrontier` doesn't), each taking the places as an optional last argument; the loader is `src/lib/places.ts`. A shared vector file (`content/vectors/location.json`, read by `server/internal/location/location_test.go` and `tests/location.test.ts`; loader refusals in `content/vectors/places-loader.json`) covers both sides: tiles either side of y=24, the arch mouth, the footprint margins, negative chunks, each Wilds footprint, each anchor, and `Resolve` for every content position with `area: "commons"`. Both tests walk `content/*.json` and refuse a Commons position with no vector. "Outside solid ground" splits two ways: a **stand** position (pickup, seller, resident spot, door step, anchor) is open ground reached from the village path; a **target** (the hame, the board, the Yard's door tile) is the object itself and borders open ground. The node test checks this against `buildCommons` at the frozen capacity; Go gets the same check from the served layout in S2.

`Resolve` is the step-3 bridge for content that names Commons positions in Commons-local tiles: `items.json` pickups, `repairs.json` (hame), `residents.json` spots (Elara, Silas), `papers.json`, `story.json`, `gathering.json`. Those files stay unchanged in step 3. The town redesign moves them to anchor ids in layout data and deletes `Resolve`.

`frontier.Inside` keeps its meaning, "generated land may be made here". `OnGrid` is the new question, "this outdoors chunk exists". Presence, `Where` validation, near reads and the client window ask `OnGrid`.

### 1.3 What is authoritative where

| What | Server | Client |
|---|---|---|
| Chunk ground and objects | Composes per source and serves | Caches and renders; never builds |
| Place lookup | Decides eligibility: sync, profile report, ops, rest, world arrival, fights' safe ground | Predicts the same answer for cues, mounts, the zero-HP barrier and map labels |
| Saved location | Persists `(space, x, y)`; `place_set_version` barrier unchanged | Reports; follows server relocations |
| Presence room | Validates the chunk room is `OnGrid` and positions are on the grid | Joins the room of the chunk it stands in (as in the Wilds today) |
| Fights | One sim per generated chunk with camps (`fights.Key`) | Interpolates, predicts hits |
| Anchors | Resolves recovery, relocation and world arrival | Resolves door and gate returns |

### 1.4 On the wire (contract 11, one bump)

- **`Where{area, x, y}`** (`proto/glimway/v1/op.proto:10`) and **`Place`** (`:19`): unchanged shape; `area` carries the space, and `outdoors` replaces `wilds` and `commons`. The server derives the place from `location.At`. It stays in the idempotency hash as today.
- **Presence**: room grammar `outdoors:<cx>:<cy>` for any `OnGrid` chunk. The subprotocol moves to `glimway.presence.v4` (`api/proto.go:65`, `src/lib/presence-codec.ts:5`) so old clients reload. `FightRoomKey` (`proto/glimway/v2/presence.proto:127`) is unchanged: realm `hearthwick`, generated chunks only.
- **Chunks**: `WildsChunk` (`proto/glimway/v1/wilds.proto:25`) is renamed **`WorldChunk`** and gains `source` (fixed/generated), `layout_revision` and `repeated Placed objects`. A fixed chunk's `epoch_id` is the pseudo-epoch `fixed:<layout>@<revision>`. That keeps the client's chunk cache key (`<contract>:<gen>:<epoch>:<cx>:<cy>`, `src/game/wilds/chunks.ts`) and the server LRU working unchanged, and a layout revision invalidates both. `chunks.Validate` accepts the fixed source.
- **Near read** (`/api/wilds/near/`, `api/open_map.go:98`; routes renamed `/api/world/…`): accepts `OnGrid` chunks and lists each fetched chunk's source and epoch. Live state of Commons objects (repairs, gates, boards) keeps coming from today's curated reads (`/api/commons`, village/repairs reads) in step 3.

## 2. Who runs what, and the hand-off

| Component | Owns | Key |
|---|---|---|
| Fight rooms (`server/internal/fights`, `api/presence_fights.go`) | Camps on generated chunks, woken by 3×3 coverage of an `outdoors` position | `fights.Key{World, Realm, Epoch, Layer, CX, CY}` |
| Presence hub (`api/presence.go`) | One room per `OnGrid` outdoors chunk, 3×3 visibility (`sharedRoom`); one room per other space | room label |
| Commons state | **No sim.** Gate views (`api/commons.go`), repairs and projects (worldchange curated keys, realm `commons`), board. Resident schedules stay clock-derived. | unchanged keys |
| Epochs | Tangle still; Commons none | `wilds.EpochKindAt`, `location.SourceOf` |

**The hand-off at y = 24 is a chunk crossing like any in the Wilds today:** the client joins the next chunk's presence room, `scanFightRooms` recomputes coverage from the position, and the window recentres. There is no scene restart, no extra save write and no fight leave. Only the lookup's `safe` flips.

Two rules keep the seam safe:

- **Fights never enter safe ground.** `loadFightChunk` sets `fights.Geometry.Safe` (`fights/geometry.go:19`, already a stub for exactly this) from `location.At`. A player whose capped position is safe is not a target: their position still reaches rooms in their 3×3 for coverage and claims, but aggro, targeting and bolts skip them. Bolts stop at safe tiles (`CanBoltFly`). Camps keep the chunk-edge leash. Fixed chunks never wake a room, because `scanFightRooms` already skips chunks where `frontier.Inside` is false.
- **The Commons' north edge is solid except at the mouth.** The Tangle's stored south edge (chunks −1..1, row 0) may have open tiles anywhere. The layout's top row is hedge or fence except at world x = 1..3, so the arch is the only crossing. Stored Tangle chunks are not touched.

## 3. Today's places on the grid

| Today | Step 3 | Town redesign (step 4) | Later |
|---|---|---|---|
| Tangle, Whitequiet, Beyond (`wilds`) | `outdoors`, generated; coordinates unchanged | unchanged; frontier opens south around the town | held chunks (Lamps) |
| Commons (`commons`, local px) | `outdoors`, **fixed** footprint `commons`: origin tile (−21, 24), so the arch lane x = 22..25 lands on world x = 1..4 under the gate's x = 1..3. Footprint chunks cx −1..1, cy 1..2 (x −24..47, y 24..71); authored verge fills the margins. | merged into one town layout | — |
| Commons arch exit, Tangle south-gate exit | **removed**: walk-through | — | — |
| Commons → village west exit | transition, unchanged | village joins; exit removed | — |
| `village`, `woodland`, `ruin` | separate spaces | village joins as fixed chunks; story places stay transitions or become fixed outposts | outposts (decision 9) |
| `home:<g>` and its exit | separate space; its exit returns to anchor `commons:gate:<g>` | lots in the plot area; gate *n* → lot *n* | hearths in the Wilds |
| `in:commons:yard`, `…:deeds` | rooms; the door's return becomes anchor `commons:yard-door`: the doorstep (the door's `entry`, layout 53,18), since `outside` (53,17) is the door tile itself (`content/rooms.json` ~:647) | anchors move with the layout | — |
| Arrival recovery, removed-room recovery | Commons fallback becomes anchor `commons:arch` (`world-arrival.ts:28`, `store/rooms.go:22`) | town anchor | — |

**Commons capacity: 8 gates** (decided, §0 10). The frozen layout is `buildCommons(8)`: the four designed gate rows at y = 9, 13, 28, 33, so H = 42. It sits in two chunk rows (world y 24..65 of the footprint's 24..71), and the rest of the footprint is verge. Two chunk rows could hold a fifth row (10 gates, H = 47 ≤ 48), but the owner chose not to grow the Commons. More homes come from shared plots or Wilds claims. `places.json` holds anchors `gate:0`–`gate:7`. The loader refuses gate anchors that skip a number, so the capacity is the gate-anchor count. A gate past the frozen capacity is refused at claim, which is today's `home_deeds.go` path with a new limit (S2/S5 add it).

## 4. The Commons/Tangle join, concretely

**Server.**
- *Data:* `places.json`, `layouts/commons.json`, `location` package and vectors (§1.2).
- *Composer:* `server/internal/chunks/fixed.go` slices the layout into `WorldChunk`s at load. `store.Chunks.Chunk` (`store/chunks.go:202`) branches on `location.SourceOf` **before** the `wild_epochs` lookup. Fixed chunks are never written to the chunk table; they come from content.
- *Space:* `wildsArea` → `location.Outdoors` (`api/wilds.go:34`). `validArea` (`api/payload_validation.go:56`) drops `commons` and `wilds` and adds `outdoors`. `validPresenceRoom`/`wildsRoomChunk`/`positionInsideFrontier` (`api/presence_socket.go:22–56`) and `wildsWhereInside` (`api/op.go:~220`) use `OnGrid`.
- *Migration 036:* `player_place` `commons` → `outdoors` (+ origin × 16 px: x − 336, y + 384); `wilds` → `outdoors`; bump `place_set_version`. Migration 028's historical mapping stays as it is.
- *Rules:* §5.
- *Fights:* `Geometry.Safe` and the safe-target filter (§2). `scanFightRooms` (`api/presence_fights.go:365`) gates on the space `outdoors`, not `wildsRoomChunk`.
- *Reach:* `nearTile` (`api/item_slots.go:20`) resolves its content tile through `location.Resolve` and compares spaces. That one change fixes pickups, repairs, wear, residents (`nearResident :236`) and market reach. `together` (`api/item_presence.go:12`) uses same space plus `sharedRoom` plus distance instead of exact room equality. `presence.near` (`api/presence.go:470`) serves only the deeds table, which is indoors: unchanged.

**Client.**
- *Window:* `planWindow`'s `inside` (`src/game/wilds/window-plan.ts:22`) becomes `OnGrid`. Fixed chunks load through `loadChunk` like generated ones. The drift veil covers only off-grid chunks.
- *Fixed ground:* `AttachedChunk` (`window-chunk.ts:183`) paints a fixed chunk through the curated tile path (`area/terrain.ts:164–174`, the separate paint path), with collision from the chunk's solid grid.
- *Objects:* a new per-chunk attacher (beside `WildsEntities.attach`, `wilds/entities.ts:324`) draws layout objects and registers their interactions: props, lamps (`area/lanterns.ts`), board, well, gates (`HomesteadLayer`), doors and exits (`checkExits` over attached exits, in world tiles), repair sites, gathering spots, festival dressing (`entities/village-life.ts`, by festival tag), and NPC posts (`ResidentCycle`, with Elara's camp spot from `residents.json`; the builder's static Elara goes; continuous-village §1). **One owner per object:** the chunk holding its anchor tile, which also draws its overhang. `HomesteadLayer`, `ResidentCycle`, `Doors` and village-life gain attach/detach per chunk. Today they are built once per scene (`WorldScene.ts:366, ~397`).
- *Scene:* the outdoor scene is today's open-world scene (`buildWildsWorld`, `wilds-world.ts:36`). Its bounds and `view` span frontier ∪ fixed footprints. `transitionTo`'s Commons↔Wilds branches (`WorldScene.ts:1055–1066`), `COMMONS_FROM_WILDS`, `gateArrival*`/`wildsReturnTile` (`wilds/coords.ts:61–90`), `buildCommons`/`commonsForeground` and the `commons` entry in `AREA_KINDS` (`worlds.ts:828`) are deleted. Entering from the village or a home lands on an anchor in `outdoors`.
- *Camera:* `frameCamera` (`scenes/world-camera.ts:72`) already uses `open.view`. Widening the view to include the Commons is enough. There is no edge fade at the join; the off-grid sides keep the drift look.
- *Map:* the hero shows whenever the space is `outdoors` (`wilds/map-data.ts:184`, `ui/WorldMap.svelte:73–87`). Fixed chunks always draw, independent of walked records. "Commons gate" becomes anchor `commons:arch`. The "outside the Wilds" state applies to other spaces only.
- *Mounts:* `rideRefusal` (`lib/companions.ts:141`) asks `location.At(...).ride`. The Commons and the Tangle both allow riding, as today, so nothing changes in feel. The village's on-foot rule moves into the town's zones at step 4.
- *Zero HP:* today's exit lock (`WorldScene.ts:1013–1017`) becomes a **barrier**. While `zeroHpLocked`, tiles where `At(...).safe` is false are solid to the hero when stepping from safe ground. That's the mouth at y = 23/24.
- *Saves:* contract 11 drops old cache entries and old outbox records (decision Q in the [refactor plan](../reviews/2026-10-13-refactor-plan.md#owner-decisions-2026-10-13)). Walked-map records keep their wick keys; generated coordinates don't move.

## 5. Area rules to re-check

Each moves from comparing area strings to the lookup at the position (`At(space, x, y)`). **Gen** means `Source.Kind == Generated`.

| Rule | Where (server / client) | At the seam |
|---|---|---|
| Safe set, sync boundary | `rules/rules.go:15,36,289`; `lib/habitica/sync.ts:68`, `game/sync-safety.ts` | `At().Sync` / `At().Safe` |
| Profile report needs safety | `api/profile_report.go:68` | `At().Safe` |
| World party/prompt/arrival in safe area | `api/worlds.go:519,589,652` | `At().Safe`; until S5, refuse moves from homes (including rooms) and reset home arrivals to the village spawn; S5: arrival reset → destination anchor |
| Zero-HP exit lock | `WorldScene.ts:1013,1017` | barrier (§4) |
| Unmoored: deep-Tangle timer, lamplight clears in safe areas | `entities/unmoored.ts:68,127–153` | unchanged timer; clearing via `At().Safe` |
| Riding | `lib/companions.ts:141–155`, `entities/avatar.ts:160,406,472` | `At().Ride` (Commons/Tangle unchanged) |
| Wilds-only ops: `nearWithin`, rewards, fallen lantern, `PlaceFallen` | `api/wilds.go:245,695`, `api/item_rewards.go:54,122`, `api/story_ops.go:205` | space `outdoors` **and** Gen |
| Wick record on report/op | `story.Rules.Record` (`story/story.go:302`) | Gen wick only |
| Gathering: offered areas, wilds tile vs curated spots | `api/gathering.go:89–133`; `lib/gathering.ts:112`, `entities/gathering.ts:267` | Gen → chunk tile; fixed → layout `gather` objects (Commons spots via `Resolve`) |
| Paths and ground tools | `api/open_map_paths.go:43–65,195–303` | refused off Gen chunks |
| Commons paper rule, board papers | `story/story.go:109–111`; `content/papers.ts:287` | `At().ID == "commons"` |
| Story step `at`, marks, quest talk/use/reach | `api/story_ops.go:42,136,142`, `api/quest_rules.go:62–85`; `lib/quests.ts:252`, `game/goal-route.ts:29–34`, `entities/goal-guide.ts:46,146–187` | place id from lookup; the goal route's area graph treats `commons`/`tangle` as adjacent places |
| Reach: `nearTile`, `nearResident`, pickups, repairs, wear, market | `api/item_slots.go:20,236`, `item_pickups.go:17`, `repairs.go:375`, `item_wear.go:114`, `market.go:37`; `lib/items.ts:323,344`, `lib/repairs.ts:45` | `Resolve` + same space + distance |
| Gifts (`together`), witnesses (`beatRoom` echo: `wilds`) | `api/item_presence.go:12`, `api/witness.go:22` | same space + `sharedRoom` + distance; echo beat Gen |
| Presence room cap counts exact label | `api/presence_socket.go:324`, `presence.go:452` | unchanged (per chunk room; the Commons crowd now splits) |
| Server enemies drawn only in `wilds` | `entities/enemies.ts:170` | space `outdoors` |
| HomesteadLayer only for commons/home | `WorldScene.ts:366`, `entities/homesteads.ts:94` | per-chunk gate objects |
| Location cards, display names, heirloom conditions | `content/world.ts:175,244`, `content/heirlooms.ts:219,256` | place id from lookup |
| Dev warp, e2e area helpers | `scenes/world-dev-hooks.ts:149`; `e2e/helpers.ts`, `e2e/room-helpers.ts`, `e2e/home-helpers.ts` | warp by anchor or world tile |

Unaffected in step 3: village-only rules (passive HP, village rest `spend_op.go:29`, dismount on entering the village), woodland/ruin story fights, `in:` room rules, home placement and rest.

## 6. Build plan for step 3

Six lanes. Each ends in something the owner can play, or in Go-only behaviour proven by tests. Built on the refactor stages: the new chunk and near routes go through stage 4's route specification; the lookup is pure, so stage 6's projectors may call it; Link's single operation helper (stage 5) is where `where` gets its space.

| Lane | Kind | Delivers | Depends on |
|---|---|---|---|
| **S1. Location contract** | Go + TS libs | `places.proto`/`places.json`, `location` package (Go, TS), shared vectors, anchors, `OnGrid`, `Resolve`. No behaviour change. | — |
| **S2. Commons as served layout** | Go, plus a small client adapter | Export script, `layouts/commons.json` (frozen capacity), fixed-source composer, `WorldChunk` rename and fields, near read for fixed chunks. Client: assemble the six fixed chunks into a `WorldData` so **today's separate Commons scene renders from served data**; delete `buildCommons`. | S1 |
| **S3. Outdoors space and rules** | Go + client | `wilds` → `outdoors` rename, `validArea`, presence v4 grammar, migration 036's `wilds` part, every §5 rule through the lookup (Commons still its own space). | S1 |
| **S4. Fights and presence at the seam** | Go | `Geometry.Safe`, safe-target filter, bolt stop, `scanFightRooms` on `outdoors`, `together`/witness by space + distance, `OnGrid` presence rooms. | S1, S3 |
| **S5. The join** | Client, plus a little Go | Fixed chunks in the window, per-chunk object attach, exits/doors/gates from layout, camera, map, zero-HP barrier, anchor returns; Go: migration 036's `commons` part, `commons` out of `validArea`, anchor resolution for rooms and recovery. Delete the S2 adapter and the portal code. | S2, S3, S4 |
| **S6. Measure and playtest** | Client/perf | `npm run perf:walk` Commons ↔ Tangle scenario, phone walk, two-player walk, fixes. | S5 |

S2, S3 and S4 can run in parallel after S1 (S4 after S3's rename). S5 is the long lane.

### Acceptance

- **S1.** Go `location` tests and node `location` tests read the same vectors and agree. Every content position with `area: "commons"` resolves on the grid and outside solid ground.
- **S2.** Go: fixed-chunk bytes are stable for a layout revision; the store LRU and client cache keys differ per revision; still and wick chunk hashes are unchanged (generator untouched); `Validate` rejects a fixed chunk whose layout is unknown. Client: unit test that the adapter's `WorldData` equals today's `buildCommons(capacity)` (grids, objects, exits, spawn). E2E: `presence.spec` "screens: … the Commons" and `yard.spec`/`homestead.spec` gate walks pass unchanged, plus a **pixel comparison** of a Commons screenshot before and after.
- **S3.** Go: migration upgrade fixture (`wilds` rows → `outdoors`, version bumped), presence join grammar tests, rule tests per §5 row (sync in Commons, rewards only on Gen). E2E: `wilds.spec`, `open-map.spec`, `wilds-outer.spec` and `world-map.spec` pass with the renamed area.
- **S4.** Go: a fight replay where a wisp's target steps onto safe ground and is dropped, and a bolt stops at a safe tile; coverage across row 0/1 wakes Tangle rooms for a Commons player and never a Commons room; `together` across a chunk edge. `fights-shared.spec` unchanged.
- **S5.** Client units: attach/detach of every object kind leaves no listeners, tweens, bodies or textures (extend the `open-map.spec` "leave nothing behind" pattern to fixed chunks); one owner per object; zero-HP barrier. Go: migration fixture for `commons` positions; room and recovery anchor resolution. **E2E, new `e2e/seam.spec.ts`:** walk Commons → Tangle → Commons with no scene restart (scene identity and window kept); turn back across the mouth repeatedly and cross diagonally; two players see each other across y = 24; a Tangle wisp never steps or shoots past the mouth; reload on either side; Yard door and a home gate return to their anchors; zero HP stops at the mouth. **Changed specs:** `wilds.spec` ("arch leads into the Tangle"/"leads back" become the walk), `presence.spec` (village/Commons screens), `camera.spec` (corners on the joined bounds), `world-map.spec` (hero in the Commons), `homestead.spec`/`e2e/home-helpers.ts`, `yard.spec`, `goal.spec`, `e2e/helpers.ts` warps; `e2e/changed-map.json` maps the new files.
- **S6.** The four place questions in continuous-village §9 on the owner's phone, plus frame time, pop-in and memory over repeated crossings, and slow-network arrival.

### Risks

- **S2:** the export misses something the builder computes at runtime (noise patches, gate-count-dependent framing). The equality test and pixel comparison catch it before S5 builds on it.
- **S3:** a missed `== 'wilds'` check. The rename makes old string literals fail typecheck/vectors in TS. In Go, grep the literal and `wildsArea` and leave none.
- **S4:** targeting changes subtly alter fights near the mouth. Keep the replay tests and the shared-fights spec.
- **S5:** per-chunk attach for systems built once per scene, and dense Commons chunks on phones. Collision goes in first, as for Wilds chunks; measure the Commons chunk build against `BUILD_MS` (`wilds/window.ts:55`). This is the lane most likely to grow: split it into S5a (ground, collision, props, exits/doors, camera, map) and S5b (gates, residents, repairs, festival dressing) if needed. S5a alone is already walkable for a playtest.
- **All:** one contract bump at S3 or S5. Land S3's rename and S5's join in the same release so `outdoors` never means "Wilds only" in a shipped build.

## 7. Decisions for the owner

| # | Decision | Recommendation | Status |
|---|---|---|---|
| 1 | **Commons capacity** for the frozen layout | Count homes in the live world (owner runs the query). 2 chunk rows (10 gates) if homes + 2 spares fit, else 3 rows (20). | **Decided 2026-10-13: 8 gates** in two chunk rows (3 live homes; parties max 30). Growth comes from shared plots or Wilds claims, not more rows (§0 10). |
| 2 | **What lies south of and beside the Commons footprint** in step 3 | Off-grid drift look, as at the frontier today. The town redesign fills it. | **Decided 2026-10-13:** as recommended (§0 11). |
| 3 | **Safety boundary** | Across the gate mouth at y = 24 (continuous-village §4). The whole Commons footprint is safe; the Tangle is not. | **Decided 2026-10-13:** as recommended (§0 11). |
| 4 | **Riding** | Unchanged: the Commons and the Tangle allow it. The town's on-foot zones arrive with step 4. | **Decided 2026-10-13:** as recommended (§0 11). |
| 5 | **Playtest gate** | No flag. S1–S5 merge to `dev` as a clean break and the owner playtests there (only the owner plays). | **Decided 2026-10-13:** as recommended (§0 11). |
| 6 | **S2's intermediate step** (served Commons still behind portals) | Keep it. It proves the export with a pixel comparison before the join depends on it, at the cost of a small throwaway adapter. | **Decided 2026-10-13:** as recommended (§0 11). |
| 7 | **Later steps** (decisions 5–9 in §0): lamp fuel and oil store numbers, hearth plot size, plot-area lot count, outposts | Design with the town redesign and the Lamps re-plan; none blocks step 3. | Open. |
