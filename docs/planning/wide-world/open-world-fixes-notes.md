# exp/open-world-fixes notes (Sol's open-world review, six findings)

Review: docs/planning/wide-world/responses/open-world-review-sol.md. Brief: .agent/BRIEF.md.

## 1. Same-wick holds ignored by regeneration (P1)
- Fix: `store/chunks.go` make(): the kept-neighbour query no longer excludes this epoch's holds; every
  held neighbour is passed as kept (`Held: true`). The self check stays (a chunk held under another
  epoch is never made here; one held under this epoch is read before make). `wilds/gen_v3.go` Kept
  doc updated (the generator already treated any `Held` neighbour as kept).
- Migration `040_open_world_fixes.sql` (039 untouched) drops unheld wick bodies again: anything made
  between 039 and this fix beside a hold is remade. Same set with or without 039 having run.
- Test: `store/open_world_fixes_upgrade_test.go`, fixture `store/testdata/open_world_old_chunks.txt`:
  real terrain from the pre-change generator (c5f2c111, seed "seed-world-a", season
  t:1795000000:1795604800), held chunk (7,2) taken this wick, its west neighbour (6,2) remade; checks
  every open tile in the held chunk's two west columns (corners aside) is open in the mirror. Run as
  039+040 together (live) and 040 after 039 (staging, with a wrongly-made neighbour stored).
  Without the store fix it fails (4 held open tiles face solid ground). Note: Sol's own pair
  (-3,1)/(-4,1) didn't reproduce with my season (the old and new edges happened to agree), so I
  scanned old chunks for a pair where they don't; plenty exist.

## 3. Old state on new objects (P2)
- 040 also deletes, for generated objects (id kind:cx:cy:n) of unheld wick chunks: entity_state,
  fight_falls (+ fight_fall_witnesses, explicitly), camp_claims, personal_claims and discoveries.
  Kept: held chunks' everything, the still epoch, town/lots (not wild_epochs), places found
  ("place:x:y", 3 parts), the rumour's find ("rumour:x:y"), ground changes and their owners.
- DIFFERENT from the brief: I also clear `discoveries` for those object ids (a remade point of
  interest would otherwise read as already charted by someone, with an old poi id). Places and the
  rumour keep theirs. World_changes "fishery" stock rows stay (water stock, not an object).
- Test: same upgrade test: every remade object in (6,2) has no state/claim/fall/chart row, every old
  id of that chunk lost its state; the held chunk's state, claims, charts, falls, witnesses and
  camp claims are all intact; still state, place discovery, rumour claim and ground change kept.
- The older 039 test now expects the unheld camp's state cleared.

## 2. Sight anchor jumps (P1)
- `api/sight.go` rewritten. New table `player_sight` (in 040): anchor (outdoors px), travel saved
  (px) as of `at`, and the last client claim seen (area, x, y), per account and world.
- Travel: saves up at sightSpeed = 260 px/s (client: walk 110, ride 155, ×1.15 on laid stone = 178,
  riding dodges average ~210; dash 430 for 0.15 s), from 15 s' worth after a reset to at most 10
  minutes' worth. A claim (report place, op `where`) spends the distance it moves.
- CHOICE: clamp, not refuse. Past the allowance the anchor moves toward the claim by what was saved
  (and saved drops to 0); it never moves further. Refusing would leave an honest client that
  outran its budget (a long network outage while walking) stuck forever on a far anchor; clamping
  lets it catch up over its next reports (260 > 178), and a crafted client travels no faster than a
  rider. The saved place itself is still the claim (it's the reload position; clamped points could
  sit inside walls); only sight lags. No per-request free slack (that would let a client crawl a
  little every request); the speed margin plus the saved budget are the slack.
- Server-authorised travel resets the anchor without listing every path: any saved place that isn't
  the last claim seen is the server's own (ways home, the fall to the well, rooms' doors, world
  moves, border settling, dev warps). A claim also writes player_place at once so a chunk made
  later in the same op measures from it. A room: sight round chunk 0,0 (as before).
- Generation guard (`chunks/make_guard.go`, used by `store.Chunks.make`): ServeHTTP puts a guard in
  every request, `begin` names the reader. Making a chunk needs it within sightChunks (8) of the
  anchor, or the still epoch's (Tangle), and a token from the reader's budget (burst 300, 5/s,
  in memory; an honest rider makes ~3/s). Refused → 409 beyond-sight. This covers chunk reads,
  near reads and ops' reads alike. Background work (turnings, world lab) has no guard.
- Presence: fight wake builds its own guard for the peer (same anchor, same budget); a chunk it may
  not make is skipped (no room until the player is near), not an error.
- Tests (`api/sight_test.go`): a jump to (4095,4095), (-4000,3000), (20,200) refused for near and
  chunk reads, nothing stored there; walking and riding (5 min on laid stone, then walking
  diagonally, then riding south) with reports every 10 s, near + edge chunk reads all 200; the
  client's retry (15 s unreported riding → beyond-sight → report → 200); server moves (a direct
  place write as rooms/MovePlace do; a real turncap way home from far out to the arch) and a
  reconnect an hour later; guard unit test (within/past sight, Tangle); budget unit test.
- Not tested end-to-end: an op `where` jump (same claimSight call as reports) and the fight wake
  skip through a socket (guard tested directly).

## 4. The map's reads (P2)
- Chunk read: no sight check before reading. A stored body (walked land, held, the Tangle, fixed)
  reads from anywhere; an unstored one past sight hits the guard → beyond-sight, nothing made.
  The Tangle may be made from anywhere (still epoch).
- Near read and the map window use the anchor.
- Tests: `TestChunkReadsPastSight` (Tangle from far, stored walked chunk from far, unwalked refused
  and not made); `TestHeldChunkReadsFromAnywhere` updated (its stored neighbour now reads).

## 5. Map clamp (P2)
- `src/lib/wilds/map-model.ts` mapBounds: window ∪ fixed ∪ glimpse ∪ walked chunks ∪ hero ∪ ways ∪
  seen/found places, each kept to the map grid (border or fixed). Also feeds the renderer's walked
  drawing range, which had the same clamp.
- Test: tests/wilds-map.test.ts walk-out-and-return (walked (100,0), place at 110, way at row 40,
  home window ±32: bounds and frame reach them) and a past-border chunk is clipped at 4096.

## 6. LRU evicting the played terrain (P2)
- `src/game/wilds/chunks.ts`: pinAround(cx, cy, r) / unpinChunks(); eviction skips pinned chunks
  (any epoch) and the one just kept. The window pins 3 round the hero's chunk at each recentre
  (3×3 + slack + paint neighbours) and unpins on destroy.
- window.ts refreshChanged: a chunk missing from memory while its epoch is unchanged is not a change:
  it stands and its body is loaded again. An epoch change still rebuilds.
- Other caches: ground-view's effective terrain capped at 256 chunks (oldest out, recomputed when
  read); map-data's built cache no longer keeps the decoded body (only the drawn ground) and a
  built chunk isn't loaded again (the map no longer pushes every walked chunk through the LRU).
- Walked list (lane follow-up): capped at WALKED_MAX = 8192 most recent a wick (hours of riding).
  The map still holds every walked chunk's ground grid for drawing (inherent; could compact to
  typed arrays later).
- Tests: tests/wilds-chunks.test.ts real modules: near read, active chunk pinned and read each step,
  1,024 others loaded: it stays, solidAt stays open, oldest unpinned went (fails without the pin);
  walked cap test in tests/wilds-map.test.ts.

## Dev warps (found while wiring finding 2)
- The dev warp (`__fsDevWarp`, the dev panel, the world lab's "go here") and `__fsDevPlace` are
  client-only moves the server learns from a report: the anchor would clamp them (E2E and staging
  warps would read beyond-sight). New dev-build route `POST /api/dev/warp {x, y}`
  (`api/dev_warp.go`, mounted for callers with the hooks or the world lab): moves only the
  caller's sight anchor there, with the full ten minutes of saved travel (so a report from before
  the warp, landing after it, can't strand it); saved place and version untouched. The client
  calls it (`src/game/wilds/dev-warp-sight.ts`, best effort: 404 elsewhere) before warpWilds'
  near read and before `__fsDevPlace` on the open map (the hook now returns a promise there).
- Test: `api/dev_warp_test.go` (dev tag): far near read refused, warp, then 200; saved place and
  version unchanged; past the border 409.
- Risk for CI: E2E specs that move the hero far by other means (none found besides those two
  hooks) would see beyond-sight.

## Checks run (all green)
- `nix develop -c npm run verify` (typecheck ×3, svelte-check, 2790 node tests, build).
- `go vet ./...`, `go vet -tags dev ./...`, `go test ./...`, `go test -tags dev` for api, store,
  chunks, wilds, cmd/...
- CI run 39494716473 on 3adcce36: all green; E2E 171+5 tests (the changed-spec selection), 168 passed, 1 flaky, 0 failed.
