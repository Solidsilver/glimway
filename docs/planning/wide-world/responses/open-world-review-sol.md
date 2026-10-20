# Open-world merge review — Sol

Reviewed `git diff c5f2c111 a5f1ef0a`, against the brief, lane notes and synthesis. Source line numbers below refer to `a5f1ef0a`; this worktree's subsequent commit only adds the lane notes. Review only: no implementation changes or commits.

I would fix the two P1 findings before release. The migration preserves the protected rows, but preserving rows does not preserve all of their meaning on regenerated terrain.

## Findings, ranked by severity

### 1. P1 — Regeneration ignores a held neighbour from the current wick

**Locations:** `server/internal/store/migrations/039_open_world.sql:8`; `server/internal/store/chunks.go:366`.

039 keeps a held chunk's old body and deletes its unheld neighbours. However, the query collecting kept neighbours explicitly requires `epoch_id!=e.Id`. A hold taken during the current wick therefore disappears from the generator's kept-neighbour input when those neighbours are regenerated under that same epoch. The old assumption—same epoch means matching generation—stops being true at this migration.

**Failing scenario:** set a way-lamp this wick, then upgrade before the turning. The held land retains its old river, ground and openings, but the adjoining land uses LandformV1 without mirroring that held edge. Openings out of a camp or lot backland can face solid terrain; the mismatch remains until the adjoining land turns again.

**Reproduced on SQLite:** generated a database using the first-parent code, seed `seed-world-a`, time `1795000000`, with 135 real wick chunks, the nine still chunks, and a current-wick hold at `(-3,1)`. After 039, the held body survived. On its west side, the regenerated chunk `(-4,1)` blocked **three previously open mirrored tiles** in the two edge columns, excluding corners. Generating that neighbour with the same-epoch hold explicitly supplied blocked **zero** of those tiles.

**Suggested fix:** supply all held neighbours as kept terrain, including same-epoch holds, when making an unheld chunk. Retain the protection against generating over the held chunk itself. Add an upgrade test using real pre-change terrain and a hold taken in the still-current wick; test edge access, not only row retention. If staging has already generated these neighbours, changing the query alone will not repair their stored bodies: those affected unheld bodies also need invalidating.

### 2. P1 — The sight anchor can jump anywhere in one report

**Locations:** `server/internal/api/sight.go:34`; `server/internal/api/report.go:66`; `server/internal/api/report.go:113`; `server/internal/api/op.go:107`. Related generation path: `server/internal/api/presence_fights.go:387` and `:582`.

The new sight check measures from the saved position, but reports accept any finite position inside the border. There is no six-chunk displacement limit, elapsed-time movement allowance, or corresponding generation budget. `sightLag` limits a read relative to whatever position the client has just submitted; it does not limit how far a report can move that anchor. Successful keyed operations can also supply a new `where`.

**Failing scenario:** a signed-in crafted client sends one valid report from home naming chunk `(4095,4095)`, then requests its near window and chunk body. It can repeat at unrelated coordinates without walking or waiting ten seconds. This is considerably stronger than the notes' acknowledged “hop 6 chunks per report.” It permits arbitrary materialisation of the roughly 67 million possible chunks per world, with generation and writes sharing the gameplay database connection.

**Reproduced through HTTP:** `/api/report` accepted that single jump, then both `/api/wilds/near/4095/4095` and the chunk read returned 200. No position was injected directly into the database for this jump.

Presence is another path to account for: the socket accepts in-border positions, and fight wake uses that physical position to generate its 3×3 without consulting HTTP sight. Fixing only `chunkRead` or the report handler will leave that path open.

**Suggested fix:** maintain a server-validated exploration/movement anchor with an elapsed-time allowance and explicit resets for server-authorised travel. Apply it consistently to reports, operation `where` and presence-driven generation. Bound new chunk generation per player/world over time as an additional resource limit. Preserve legitimate travel and reconnect recovery; a fixed per-request six-chunk hop alone still permits rapid crawling.

### 3. P2 — Old entity state attaches to different regenerated objects

**Locations:** `server/internal/store/migrations/039_open_world.sql:8`; `server/internal/wilds/gen_v3.go:158`; `server/internal/api/wilds.go:151` and `:422`.

039 changes bodies without changing their epoch identity. Entity IDs are kind/chunk/index, not a hash of the generated object. They are reused even when the new terrain changes placement, resource material or camp composition. Retained state is therefore not merely orphaned state for vanished IDs, as the notes suggest: it also becomes state for different objects.

**Failing scenario:** harvest an amber node or defeat a camp before upgrading. The new body at that ID can be a stone node or a camp with different enemies, yet inherits the old depletion/cycle or fall/claim history. Personal claims similarly remain attached to regenerated chest/POI slots rather than to their former bodies. A player can encounter new-looking objects already unavailable or claimed; outstanding camp completion history describes the old fight, while the claim route reads the new body.

**Reproduced:** the same real-terrain upgrade reused 181 entity IDs with changed position/material/POI fields. `node:-4:-8:1` changed from amber to stone. `camp:-2:-8:0` moved from local `(4,17)` to `(9,20)` and changed from two wisps to one beetle, while its seeded entity-state row survived under the same epoch and ID.

**Suggested fix:** give regenerated unheld bodies a new revision/epoch identity and scope entity state and claims to that identity, retaining held/still identities. Alternatively, postpone the terrain change until a normal turning and explicitly handle the affected state as part of that transition. Do not clear all epoch state indiscriminately: the same epoch can still contain protected held land. Add an upgrade assertion for the meaning of a retained claim/depletion, rather than just its row count.

### 4. P2 — Sight refuses terrain needed by the honest map

**Locations:** `server/internal/api/sight.go:50`; `src/game/wilds/map-data.ts:35` and `:178`.

The map asks for every walked chunk and always includes the Tangle. The server allows distant chunk reads only for fixed footprints or holds. The Tangle is generated still-epoch land, so it is not covered by either exemption. Previously explored unheld land also has no read permission once it is more than eight chunks away.

**Failing scenario:** travel far from home and reload with IndexedDB unavailable, cleared, or evicted. Local exploration can still name previously walked chunks, but their terrain reads fail with `beyond-sight`. Even a new browser at the far saved position cannot fetch the supposedly always-visible Tangle. `loadMap` catches the failures and leaves blank/partial land; it cannot repair this by flushing the current position.

This is especially visible at this upgrade: the contract bump intentionally invalidates all old terrain cache keys, while walked records remain keyed by the unchanged wick ID.

**Reproduced through HTTP:** from `(4095,4095)`, the current still epoch's `(0,-1)` chunk was refused. After returning home, the already-generated `(4095,4095)` body was refused, while the map-status request describing that explored key succeeded.

**Suggested fix:** allow the still footprint explicitly, and provide an authorised way to retrieve explored map detail without materialising arbitrary unseen terrain. For example, use server-recorded exploration and serve only already-stored bodies, or return compact map snapshots from a separate endpoint. A submitted device-local `explored` list alone is not proof of exploration.

### 5. P2 — Returning home clips distant explored land out of the map

**Locations:** `src/lib/wilds/map-model.ts:188`; `src/lib/wilds/map-model.ts:246`.

`mapBounds` unions only the current glimpse window, fixed footprints and glimpses. `mapFrame` first includes walked chunks, ways and known places, then clamps that extent back to those bounds. The current window has replaced the former whole-frontier extent, so that clamp now discards legitimate exploration.

**Failing scenario:** walk east to chunk `(100,0)` and return home in the same wick. Even if every body remains cached and the status read succeeds, the home-centred window ends at `cx=32`. The map frame cannot reach the explored eastern endpoint, its landmarks or paths; panning is clamped before them.

**Reproduced in the actual map model:** input containing an explored chunk at `(100,0)`, hero at home and a `[-32,32]` window returned a frame with `maxCx=32`.

**Suggested fix:** include explored chunks and known marks/ways in the navigable bounds, clipped only to the world border. Keep the glimpse window as the limit on background knowledge, not on navigation through explored knowledge. The viewport renderer already avoids allocating a full world-sized bitmap. Add a walk-out-and-return map-model case.

### 6. P2 — The shared LRU can evict the terrain currently being played

**Locations:** `src/game/wilds/chunks.ts:158`; `src/game/wilds/chunks.ts:51`; `src/game/wilds/map-data.ts:178`. Consumers: `src/game/wilds/ground-view.ts:24`; `src/game/wilds/window.ts:828`.

Only `loadChunk` refreshes an entry's age; frame-by-frame `cachedTerrain` reads do not. The new eviction loop has no protection for the attached scene or its paint neighbours. The map loads historical chunks through that same cache.

**Failing scenario:** explore more than 1,024 chunks, backtrack to an early visited chunk, then open the map. Its historical scan loads later entries from IndexedDB and can evict the active 5×5. The scene still has attached objects, but ground/entity lookups consult the cache and now find no terrain. Open tiles report solid, entity bodies disappear from store lookups, and the next near-version change can destroy attached chunks because `refreshChanged` interprets a missing cache entry as changed terrain. This can recover by refetching, but causes disruption while a panel is open or play resumes.

**Reproduced with the actual client modules:** loaded an active chunk, repeatedly read it with `cachedTerrain`, and loaded 1,024 other chunks. The active chunk was evicted and `solidAt` changed from false to true for its previously open tile.

**Suggested fix:** pin the active window and required neighbours, or give the scene an authoritative reference independent of the disposable map/cache entries. Treat eviction separately from an epoch change. Also, the 1,024-entry limit does not bound total decoded terrain memory: `map-data.ts:194` retains terrain in `cache.built`, and `ground-view.ts:34` retains base/effective terrain. Bound or compact those long-walk caches too.

## Checked and fine

- **Migration deletion scope:** the SQL targets only wick chunk bodies. Held bodies are protected by epoch/layer/coordinate, including released holds awaiting their turning. Still bodies survive. It does not delete epochs, town layouts, player saves, holds, home pieces, entity-state rows, claims, discoveries, lanterns or world changes. No child table cascades from the deleted chunk bodies. The existing upgrade test and the real-terrain SQLite upgrade both passed their retention checks. These are row-preservation conclusions; findings 1 and 3 describe the semantic gaps.
- **Tangle and town:** existing Tangle bodies remain in the still epoch; regeneration supplies actual stored still neighbours and fixed neighbours. Town and lots come from their authored/pseudo-epoch sources, outside 039's deletion. Older-wick held neighbours are also supplied correctly. Same-wick holds are the exception in finding 1.
- **A player standing in regenerated unheld land:** the saved position remains. It may become solid (7,509 formerly open tiles did so in the fixture), but the normal hero build uses `outdoorStandAt` to find nearby open ground. The server's border settlement is not terrain settlement and does not run merely because land became solid. I found the client recovery path rather than a guaranteed upgrade soft-lock; no interactive browser validation was performed.
- **Paid ground changes:** rows and ownership survive. Both effective-terrain implementations apply laid stone/plank and clearing to the same coordinates on the new body; laid tiles remain walkable. This can leave old work on a different river or beneath a different generated feature. It is a consequence of the stated same-coordinate migration policy, not proof of preserved geography. The normal turning's `carries` validation is not applied by 039.
- **Contract 11 → 12:** the HTTP contract gate returns `409 reload-needed` before dispatch, including chunk routes. The shared client transport invokes its reload handler for the refusal. Cache prefixes include the contract number and pruning removes old prefixes, so old unheld terrain is not silently reused. Existing contract tests passed. Cache invalidation exposes finding 4 rather than hiding it.
- **Honest movement/travel sight:** the six-chunk near-centre allowance and eight-chunk body allowance include the near read's radius of two. The client retries `beyond-sight` after flushing its live report. Server ways home write the destination before the subsequent near read; ordinary warps/reconnects have the flush recovery path. Following a nearby friend does not itself require a remote sight centre. Current indoor rooms are town/home rooms; I found no implemented distant Wilds-hearth interior to validate. The room-to-gate rule will need an exterior anchor when such rooms are added.
- **Border and numeric range:** server and client use the same inclusive chunk square, `[-4096,4096]`, with pixel interval `[-1572864,1573248)` on each axis. Operation/report positions, gathering targets, path targets, holds, chunk making and fight-wake candidates enforce that grid. Client physics bounds and unloaded/off-grid walls cover all four sides. The expanded finite-position bound reaches the edge; signed tile/pixel protobuf coordinates fit in int32. `geom.go` promotes squared-distance/cross products to int64, and the fixed-point extent at this border leaves headroom, including the segment-projection multiplication by 1,024. Client coordinate/physics arithmetic uses numbers; remaining bitwise uses here are bounded coordinates, indices or intentional hashes. This was a source/unit-test audit, not a GPU precision playtest.
- **South and Wend:** places/routes no longer stop at row seven. The river tail adds five six-chunk steps beyond home; the finite tail ending after 30 chunks is explicit in the lane, not an accidental south wall. The far-land tests cover southern regions and border corners with open terrain and entities; they passed.
- **Storage lifecycle:** chunk bodies still persist on first generation; the server's decoded-body LRU is 512. Turning cleanup retains holds and trims their unheld old neighbours. Growth logging measures ended-wick and world totals without generating chunks. This is observability, not a growth limit: finding 2 remains a generation/storage exposure, and device walked/map caches still scale with exploration.

## Validation

Ran at reduced priority (`nice -n 10`):

```sh
go test ./server/internal/store ./server/internal/api ./server/internal/wilds \
  ./server/internal/location ./server/internal/chunks ./server/cmd/glimway-server
```

All six packages passed. The existing focused client tests also passed: **79/79** across `world-border`, `wilds-coords`, `wilds-map`, `wilds-map-data`, `wilds-chunks`, `wilds-runtime`, `wilds-map-render`, and `proto-contract`.

Additional probes used only `/tmp`: extracted the first parent with `git archive`, generated the old SQLite database with its real generator/store, upgraded a copy using the reviewed code, and used Go file overlays for upgrade/HTTP probes. Client probes exercised the actual map/cache modules. Existing installed JavaScript dependencies were supplied through a temporary loader because this worktree has no `node_modules`. The probes asserted the observed failures; passing probe commands do not mean those behaviours are fixed.

No Playwright, Vite, live service, `/var/lib/glimway-server`, or `/etc/nixos` was used. Only this review document was added to the worktree.
