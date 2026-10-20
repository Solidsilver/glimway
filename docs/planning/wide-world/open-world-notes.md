# exp/open-world notes (0.14 iteration 1, "walk any way")

## State at pickup (2026-10-20)

A previous agent was stopped by a Paseo restart with nothing committed. It had done:
- content: `frontier` → `border` {chunks 4096, veilChunks 4} and `map` {glimpseChunks 32}; protos
  regenerated (content, errors BEYOND_SIGHT/BEYOND_BORDER, WildsBorder on the near read,
  WildsMapRequest.glimpse + WildsMapStatus.window/glimpse).
- wilds: InsideBorder/BorderRect; the old frontier shape kept privately as "home" (homeReach 3,
  homeSouth 7) only for the Wend's course and rumour places; south cut removed from places
  (cells.go) and routes (routes.go); the Wend runs on 30 chunks past home; LandformV1 split
  (road hashes landform too).
- .agent/south.png: a render of the land south of town after the fix: open meadow patches,
  thicket patches, paths through. Looks varied, not one solid forest.
Reviewed: all of this matches the brief; kept.

## Work log

### Server (done, uncommitted at time of writing)
- Package `frontier` deleted; store's reach driver/staging (reach.go, reach tests) deleted;
  `MovePlace` kept in store/place_move.go; store opens plain "sqlite".
- `location.OnGrid(cx, cy)` = `wilds.InsideBorder || fixed`; OnGridPublished gone.
- Every `frontier.Inside` → `wilds.InsideBorder` (ops, gathering, paths, ways, holds, fights wake,
  chunk making, story EntityChunk, lamp naming). Refusals `beyond-frontier` → `beyond-border`
  (positions/ops) and `beyond-sight` (reads).
- FOUND: position bounds were `|x|,|y| <= 1e6` px (op where, reports, presence, abilities); the
  border is ~1.57e6 px. Now `worldPixelBound()` from the border (op.go).
- Sight (api/sight.go): trusted chunk = saved place (rooms → 0,0, the gate). Near read centre within
  sightLag=6 chunks (reports every 10 s; a rider covers ~4.6 chunks), chunk reads within
  sightChunks=8, or a held chunk anywhere, or a fixed chunk.
- Near read: `border` rect replaces `frontier`; its `glimpse` field removed (reserved 13): nothing
  lies past the border to glimpse.
- Map read (`POST /api/wilds/map` with `glimpse: true`): `window` ±map.glimpseChunks (32) round the
  trusted chunk, clipped to the border, + a glimpse per generated chunk (4225 max).
- settleBorder (api/border_settle.go): a saved place past the border moves to open ground inside.
- Storage: store/growth.go logs at each turning: the ended wick's stored chunks, bytes, farthest
  chunk, and the world's totals.
- Vectors: content/vectors/wilds.json `missing-south-limit` → `missing-border`;
  wilds-coords.json `frontier` block → `border` inside/outside cases (script
  scripts/hearthwick-location-vectors.ts still to update).

### Orchestrator asks (2026-10-20)
- Merge origin/dev (world lab, server/cmd/worldlab) before pushing.
- Before/after region PNGs of the south and far east/west/north with the lab, small, under
  docs/planning/wide-world/lab/open-world/.

### Generator
- Tests (server/internal/wilds/open_world_test.go): TestBorder, TestFarLandIsOrdinary (4×4 blocks
  just south, south, far south, south border, east/west/north near and far, all four border
  corners incl. negative near-border; no chunk all solid, ≥35% open, entities present),
  TestLandformVersionSplit.
- FOUND: in today's generator the south was NOT all-solid thicket (lab: 35% solid, same as
  elsewhere). What it lacked was places and paths: 2.8 places/100 chunks and 3.9% path ground vs
  ~10–12 and 12–15% elsewhere. After: 10.4 and 11.7%. See docs/planning/wide-world/lab/open-world/.
- Rumour place counts dropped ~2 a seed (place spots may now fall south of home's row 7 and are
  filtered out of "home"). Ford/road client fixtures moved to new chunks (the river moved).
- Dev's TestToolContentReload reversed `lands` and relied on luck: lands are drawn by weight in
  list order, so their order is part of the world. It now reverses grounds and decor only.

### Client
- coords: insideBorder/borderRect/chunksInFromBorder; held reach gone. location.onGrid = border or fixed.
- store: view.border (wildsBorder, insideNamedBorder); no near glimpse; knownPlaces walks loaded
  chunks (it walked the frontier rect: would be 67M chunks now). chunks.ts memory capped at 1024.
- On `beyond-sight` the near read flushes the report and retries once (a warp, or outrunning the
  10 s report).
- window: drift only past the border (woods in fog, no glimpse); BorderVeil: pale wash over the
  last border.veilChunks (4) chunks inside, thickest at the edge; ~0.85 over the drift past it.
  Placeholder look.
- map: MapInput.window (the map read's window, fallback ±32 round the hero) + glimpse wash over
  parchment, walked land on top, dashed edge only where the window reaches the border.
- Push-back toast on all four sides (the south edge used to be the village's).

### Player text that mentions the edge (owner's words; not changed unless noted)
- content/wilds.json words.drift: was "The Whitequiet closes in here. Only a lit camp pushes it
  back." (now false: camps don't push anything). CHANGED to a placeholder: "The land fades to
  white here, and goes no further." Owner to reword.
- src/content/wilds-errors.ts: 'beyond-frontier' "That place is past the Whitequiet's edge."
  replaced by 'beyond-border' "Nothing lies past the edge of the world." and 'beyond-sight' "That
  is too far off to see from here." (placeholders).
- src/content/open-map.ts map legend: frontier "The Whitequiet's edge" → border "The edge of the
  world"; legendBeyond "Past the Whitequiet's edge" → "The land round you, seen from afar".
- content/wilds.json rumour ring 3 phrase: "Out near the Whitequiet's edge." UNCHANGED (rumours
  stay near home; the Whitequiet place still stands north of the Tangle).
- CHANGELOG 0.13.0 line "the edge of the explored Wilds is now the Whitequiet's edge" (history).
- docs/lore/canon.md §2.4 (Whitequiet as the edge): not touched, owner rewrites.

### What the owner should try on staging
- Walk (or ride) far south from the Commons gate: past the mill the Wend keeps going south;
  woods with clearings and faint paths, places with landmarks, no wall of thicket.
- Walk far east and far west (a few minutes each): land keeps loading, no drift, no refusals.
- Open the map out there: the land round you as a pale wash, what you walked on top.
- Dev panel warp near the border (e.g. outdoors tile -98302, 12) and walk west: the land fades
  white over the last 4 chunks, the hero stops at the edge, the toast says so once.
- Check that held chunks, lamps, camps, lots and town behave as before.
- Server log at the turning: "turning: world … stored N chunks, B bytes, farthest F chunks out".

### Things I'd add next (not done)
- Woods richness (next iteration, with the lab).
- Walked-chunk list for the map grows without bound on a long walk (256-key batches); cap or keep
  as an explored bitmap (later lane).
- IndexedDB keeps a wick's chunks (~2–6 KB each); fine for now.
- Sight is trusted from reports; a crafted client could hop 6 chunks per report. Good enough to
  stop crawling; real movement checks are a separate job.

### Deploy pieces (from the original agent, reviewed and finished 2026-10-20)
- content/contract.json 11 → 12: the client's chunk cache keys carry the contract number
  (src/game/wilds/chunks.ts PREFIX), so old chunks are never read, and pruneChunks (on each page's
  first near read) deletes every key without the current prefix from IndexedDB. E2E and the api
  test helper read the number from content; tests asserting 11 updated (op_test, story-content).
- Migration 039_open_world.sql: deletes stored bodies of unheld wick chunks (nothing references
  wilds_chunks, so entity state, claims, discoveries, lanterns and ground changes are untouched);
  held chunks and the still epoch keep theirs. Upgrade test covers held/unheld/still, entity state,
  ground changes, epochs. Fixed its fixture (needed a players row).
- migrate --dry-run: generic over pending migrations. Its test assumed the newest migration fails
  on re-apply; 039 is idempotent, so the test now marks the newest two unapplied.
- Caveat for the owner: this wick's regenerated chunks may have different entities/ground than
  before; old entity_state rows for vanished ids just stop matching, and laid stones stay on their
  tiles (on new land). They turn at the next wick anyway.

### CI (2026-10-20)
- Merged origin/dev twice (world lab, then the lab web lane c5f2c111: renderer now
  server/internal/worldlab; its overlay is `border`). Fixed dev-only dev_routes.go
  (OnGridPublished); vet with `-tags dev` too.
- Run 39482419774 on ed86e358 (HEAD): all green. E2E full ran 324 tests (changed specs incl. open-map,
  open-map-screens, lamp-art): 295 passed, 1 flaky (map-tiers "Lamps ledger shows your dimming lot"
  failed once, passed on retry; it reads the map, worth a look if it repeats).
