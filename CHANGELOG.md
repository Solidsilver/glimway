# Changelog

What changed in each release of Glimway. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (0.x for now: anything may still
change). How to cut a release: [docs/releasing.md](docs/releasing.md).

Each release has two parts, always in this order and with these headings, so
the game can show the first part as "What's new":

- `### For players`: short, plain lines about what you'll notice in play.
- `### Technical`: what changed for people who run or work on Glimway.

## [Unreleased]

### For players

- Signing in, reloading and stepping outdoors no longer freeze the game for a moment as the world appears.
- The Wilds keep their shape across the turning: the Wend runs the same course and woods and meadows stay where they are. Only the living detail (trees, forage, camps, chests, places and paths) changes each wick.
- The Wilds turn early once, when this version arrives: the current wick's land is replaced. The Tangle keeps everything.
- Light your lot lantern: fill the lantern on your lot's back line with hearth oil and the woods behind your lot hold still through the turning. While it burns, that land is part of your yard: set pieces out there and plant in it. Each flask burns for a wick, up to three; anyone may top up a neighbour's lantern. Run dry, it gutters for a wick, then goes dark, and the woods turn; anything you set out there comes home to your storage, and planted seeds come back to your chest.
- The chandler by the square sells hearth oil, so you can keep your light without amber.

### Technical

- Added `lantern-stake-2` as a generated 64×96 Hearthwick 2 frame, packed at 64 texels per tile; it is registered as a texture only and is not used by lot layouts.
- Arrival has no long frame: boot builds its art a slice a frame (8 ms budget; the heavy passes yield a texture at a time, `Steps` in `src/game/art-pass.ts`), each frame's texture is uploaded once instead of twice, and the packed atlases boot only copies out of are staged as decoded images instead of GPU textures (`loadStaged`). Portraits and UI icons are drawn once per game during boot, and the open map no longer paints an empty area tileset. Desktop (GPU), longest arrival frame: sign-in ~480–680 → ~80–85 ms, reload ~560–660 → ~85–105 ms, door-out ~110–120 → ~60 ms; at a 4× CPU throttle, ~2.4–2.7 s → ~0.3 s. No change in what's drawn.
- New `glimway-server verify-backup FILE`: opens a snapshot read-only (writing nothing to or beside it, and never opening `-db`), runs SQLite's integrity check, confirms the schema is this version's or an older one it can migrate, and prints the schema plus account, world and home counts. Non-zero exit on any failure. The NixOS backup service now verifies each new snapshot and fails the unit if the check fails; the bad snapshot is renamed `.sqlite.unverified` and no old snapshots are pruned. A Go test runs the documented restore (back up, verify, copy to a new path, open, read back). [docs/home-server.md](docs/home-server.md) adds it to the NixOS, Docker and manual routes and before upgrades. No migrations.
- Lasting geography (overturns open-map decision 18): land cells and their sizes, the border warp and the Wend hash the world seed, generator version and pass, without the season or epoch kind (`wilds.Epoch.landform`). Living detail keeps the seasoned hash. Still-epoch output is byte-identical (its goldens are unchanged), so the generator version stays 3; the wick goldens, the pinned rumour counts and the client's ford fixtures are regenerated.
- Migration 038 ends the current wick (clean break, as 037 did): wick epochs, their chunks and world changes go, fallen way-lamp markers are archived to `one_town_lantern_archive`. The still epoch and the Tangle's changes stay.
- The holds engine (migration 039, `holds`; `store/holds.go`): a generated wick chunk pinned to one wick epoch, served from that epoch's stored chunk through any number of turnings, with its ground changes kept. `Hold`, `Release` and the turning's judge (`Holder` per holder kind, asked once when the next wick epoch is made; a released hold turns at the next turning; `Released` is the hook for sending placed pieces home). Epoch cleanup keeps pinned epochs, trimmed to their held chunks. No player action creates holds yet.
- New wick land beside a held chunk copies its edge, as at the Tangle, and opens dead-end seam pockets so each held patch keeps an opening onto the network (location-seam decision 8).
- Lot lanterns (hearthwick-2.md §6): `POST /api/homestead/lantern {gate}` pours one `hearth-oil` into a lot's lantern (a member lights it, holding the backland chunk at its current wick; anyone tops it up; `lotLantern` in `content/homestead.json`: 3 wicks, 1 a flask). The `lot-lantern` holder (`api/lot_lanterns.go`) burns a wick at each turning, dims for one wick when empty, then lets the hold go; `Released` sends backland pieces to home storage and archives backland plants with a seed refund, as 037 did. While lit, the backland joins the lot's service bounds (`lotLit`): arrange and plant in lot-local x -24..-1 (west) / 24..47 (east), checked against the held chunk's effective ground; posts and the stable stay on the lot; Wilds clear and lay there are the lot's members' only. `HomeView.lantern` (field 20) carries lit, oil and dimming; the stake draws `lantern-stake-0/1/2`. New error codes `lantern-full`, `no-home`, `cannot-hold`.
- Migration 040: `lot_lanterns` (oil and dimming per homestead), and `homestead_items` / `homestead_plants` rebuilt to accept x ≥ -24 for west backland. No data changes. Deed loss now also releases the lot's hold and clears its lantern and land-archive rows (the archive's foreign key would otherwise block deleting the homestead).
- The chandler is a fixed-spot seller of `hearth-oil` (4 glims, 3 a day).
- The near read lists held chunks with source `held` and their pinned epoch, and names the older epochs in a new `WildsNearResult.held` field; the client reads held chunks, their ground and entity states under that epoch.
- Held chunks are full Wilds land: a place in one is discovered in its pinned epoch (`WildsDiscovery.epoch`; the client keys a held place `place:x:y@<epoch>`, as place ids repeat across wicks), its camps fight in a room keyed by the pinned epoch that lives to the current turning (a held room was closed at once as ended), and a fall there leaves its lantern under the pinned epoch (it left none). Falls, camp claims, loot and respawn timers key on the pinned epoch. Footprint chunks (the Whitequiet) can't be held: their story sites turn.

## [0.11.2] - 2026-10-16

### For players

- Every river crossing shows its stepping stones again. Where a path met the river at a bend or an angle, the stones were missing, so the path seemed to stop at open water.

### Technical

- The client's `fordLines` (`src/game/wilds/soft-tiles.ts`) joins a ford's dry banks with a path through its connected tiles, instead of using one straight middle row or column. About 11% of generated crossings had no stones before; the ford tiles were walkable throughout. The 256-tile scan cap is gone.
- Only drawing changes: no layout revision, no generator version and no migrations.

## [0.11.1] - 2026-10-15

### For players

- Nothing changes in play. This release makes Glimway quicker for its host to download and update.

### Technical

- GitHub's source archive (the Nix flake input) is 45 MB instead of about 400 MB: the art-pass images in `assets/generated/` are `export-ignore`. The build never read them, and the large streamed archive could arrive truncated (`Truncated tar archive detected`). The images in `public/` are still included.
- No changes in play, and no migrations.

## [0.11.0] - 2026-10-15

### For players

- **Hearthwick is one town, part of the open map.** Walk from the Tangle into town, through its lanes and out to the Wilds with no loading screens or portals.
- **A market town round the Wick Tree.** A great old oak stands in the round square with the town's hearth-stone at its foot. Around it are shops, the inn, the smithy, the guildhouse, Pell's land office and rows of cottages, with Southfields' farm, barn, mill and spring to the south.
- **Your lot is at the edge of the woods.** The eight homestead lots stand in two rows of four either side of town, their gates on the Lot Rows and their backs open to the Wilds. Footpaths run between neighbouring lots, and plot services work inside your fence.
- **The town looks like the Wilds.** The town and the lots share the Wilds' painted ground and follow the seasons. The north edge thins into the woods; the south opens into meadow, with the roads running on as paths.
- Residents walking their rounds stop to talk when you come near.
- Brackenwood and Ashwatch are reached through a living portal in a glade off Lantern Road.
- Pip's garden has its hedges and flowers back, and Silas has a new farmhouse.
- Stepping onto the open map is about a second faster.
- Fixed: pressing E at your gate shelf or mailbox could do nothing right after something changed around you.

### Technical

- **Deploy note:** migration 037 runs once at startup and can't be redone, so back up the database first.
  - Saved places (`village`, `commons`, legacy outdoor places and `home:<g>`) move onto the outdoors grid: the town spawn, or your lot's doorstep in the new west and east lot columns.
  - Outdoor homestead furniture, clears, stumps and plants shift into the new lot frame. Pieces that don't fit, stand on blocked ground or lose connected light go to home storage; displaced plants return a seed, and their history is archived. Stored stables keep their stalls and mounts.
  - The current wick epoch expires: unclaimed camp falls, camp claims, personal claims and discoveries reset as at a season change. Fallen way-lamps are kept in `one_town_lantern_archive`. Still-epoch (Tangle) state is untouched.
  - Live homestead gates must be below 8. Let clients sync before updating.
- `village` and `home:<g>` are retired as outdoor areas in favour of `outdoors`. Hearthwick is a 3×4-chunk fixed place (`hearthwick@4`), and the lots are `lots-west`/`lots-east` (`@5`, `PLOT_REVISION` 5).
- Fixed chunks (town and lots) are painted by the Wilds ground painter in the paint workers, from one ground source shared with generated chunks. The eager tileset build at scene start is gone. Paint jobs settle on worker errors and after a 2 s deadline.
- The generator mirrors open fixed edges, feathers woods back beside them, keeps camps 6 tiles from every mouth, leans to woods west and meadow east and south of the block, and runs routes out of every gate, lane end and verge.
- E2E specs read positions from content (`e2e/positions.ts`). The full E2E job has 45 minutes.
- Fixed: two plants could share a tile when an older plant was boxed in.
- Fixed: a refresh of the fixed chunk under the hero dropped its interaction points between sliced build frames, so E did nothing. Such a refresh now finishes in one turn, and interactables pick their target again as soon as points change. (In the `v0.11.0` tag, `613c70c9`.)

## [0.10.0] - 2026-10-14

### For players

- **The Commons and the Tangle are one walk.** Step through the Commons' north
  arch straight into the Tangle and back, with no loading screen. Too hurt to
  fight, you can't step out of the Commons into the Tangle.
- **The Commons is safe ground.** Tangle creatures can't reach or shoot you
  there, and you can't start a fight from it. You can sync on the Commons even
  with creatures close by across the mouth.
- **Homes open onto the Commons.** Moving out of a home leaves you at its gate.
- **The world map shows the Commons**, and you on it.
- Commons residents keep their hours and walk to the Yard door when their hour
  changes. Festival dressing and readable exit posts come and go with the
  ground around you.
- On a slow connection you wait at the edge of the Commons until it arrives.

### Technical

- **Deploy note:** the server refuses to start if any homestead has a gate of 8
  or more (the Commons holds eight gates). Check live homes before upgrading.
- Location seam S6: `perf/seam.perf.ts` (crossings, two players, slow arrivals,
  desktop and throttled phone). The hero is held off fixed ground that hasn't
  attached, and positions there are never saved; the zero-HP barrier and that
  guard share one predicate. Row teardown drains one chunk per frame;
  build stages check deadlines per object and contain a throwing stage;
  `window.destroy()` tears down every chunk.
- Location seam S5b: residents and their bodies, repairs, pickups, papers, festivals and Commons interactions attach and detach with fixed chunks. Calendar redraws use the window build budget. Commons layout revision 3 removes the dead arch exit; contract 11 and presence v4 are unchanged, with no migration.
- Location seam S5a: the Commons' fixed chunks attach to the open map's window (one scene; the arch portal, the S2 adapter and the frozen builder are gone). Migration 036 also moves `commons` places onto the grid (−336, +384) with a barrier bump; `commons` is no longer a saved area. Room recovery and world moves from homes land on Commons anchors. Residents, repairs and festival dressing per chunk follow in S5b.
- Location seam S3: saved area `wilds` becomes `outdoors` (clean break), contract 11 and `glimway.presence.v4` chunk rooms. Migration 036 preserves world pixels and raises placement barriers. Safety, sync, riding, named-place rules and generated-ground eligibility use the shared location lookup. Commons remains a separate space until S5; S3 and S5 must ship in the same release.
- Location seam S4: safe-ground target drop and bolt stop; no fighting from safe
  ground; safe players don't scale camps; presence rooms per `OnGrid` chunk.
- Location seam S2: the Commons is a served fixed layout (frozen at eight
  gates). Presence defers a join that arrives inside its cooldown instead of
  dropping it.
- Location seam S1: `content/places.json`, the `location` package in Go and TS,
  and shared vectors.
- Refactor stages 1–6 (first slices): honest typed tests, verified dead code,
  shared helpers, one queued-operation path in Link, explicit server phases.

## [0.9.1] - 2026-10-13

### For players

- **Beetles scuttle.** After pawing the ground, a beetle now comes at you in
  quick zig-zag dashes. Roll sideways once it locks on.
- **No more snapping home.** Camp enemies stop at the edge of their camp and
  walk back, even after a shove.

### Technical

- Soft 160 px camp leash with 8 px return hysteresis; attacks clip into recovery, while obstacle crashes still daze beetles. Content-tuned 108 px scuttle shares Go/TS movement vectors and existing fight states/events.

## [0.9.0] - 2026-10-13

### For players

- **Fight together.** Wisps and beetles at Wilds camps now share their movement,
  health, wind-ups and deaths. Friends nearby when a fight begins bring extra
  enemies, up to five. Everyone who watched the fight can claim their own reward.
- **Your workings are shared too.** Cleave, Fingersnap, Shadowstep, Mend,
  Kindle, Stand and Echo affect the same camp enemies for everyone; Ward-light
  keeps mending nearby friends.
- **Empty hands.** Press 0 or choose the hands at your belt to put your weapon
  away. On phones, the camera keeps you clear of the belt buttons.

- **The world map.** Press **M** (or the new Map button at the top right) for
  a full-screen map of the Wilds you've walked this wick. Drag it, zoom it
  with the wheel, a pinch or + and −, and it opens close up on you. The
  Journal is back to Quests, Papers and How do I…?, and the ways and places
  lists are in the map's Details.
- **Riding is on V now** (M opens the map). The saddle button works as before.
- **Smoother fights.** A camp you lost can be claimed again once it falls,
  cooldowns show with reduced motion on, a refused claim no longer looks like a
  network error, and "remember this device" waits until your sign-in is saved.

### Technical

- Presence subprotocol `glimway.presence.v3`: every server frame is a
  `PresenceFrame` carrying the events queued when the socket's writer woke, so a
  loaded server batches without adding latency (`docs/proto-migration.md`,
  "Presence v3"). Open tabs on the old protocol are asked to reload.
- Generated camp combat runs in per-chunk server rooms, delivered to each
  player's surrounding window, with prediction, interpolation and a 250 ms
  rewind cap. Every camp uses this path by default; curated story fights remain
  personal. Prototype camp-selection flags are removed.
- Migration 035 stores camp falls, witnesses and per-cycle claims. Fallen camps
  survive sleeping rooms and server restarts; claims require server completion
  and a recorded witness. Live fights reset after 30 seconds without observers.
- Signature tuning is shared content with Go/TypeScript vectors. Room lifecycle,
  beetles, abilities, camp scaling, completion and client lifetimes have regression
  coverage. Profiling and fight metrics use an optional loopback admin listener;
  near reads and claims expose request timings. An isolated socket load tool,
  phone performance scenario and real two-client CI gate measure shared fights.

- `src/ui/WorldMap.svelte` is an App panel (`'map'`), drawn by a bounded
  renderer (`src/ui/map-renderer.ts`: a viewport-sized canvas, cached chunk
  rasters, an overview for far-out views) through pure view maths
  (`src/lib/wilds/map-view.ts`). `loadMap()` replaces `mapInput()`: it loads
  eight chunks at a time and keeps the last picture of a chunk that fails. A
  read-only live position (`src/game/map-position.ts`) is published by the
  running WorldScene. Design: docs/design/world-map.md.
- Fight rooms run on a sharded scheduler with one shared tick, and the hub
  sweeps idle sockets and pings in one pass (about 3,000 players clean on 4
  cores in the fights load test). An opt-in presence flush
  (`-presence-flush-ms` / `GLIMWAY_PRESENCE_FLUSH_MS`, off by default) batches
  writes per tick at the cost of position latency.
- Step-back review fixes: stale enemy colliders and fight caches are cleared,
  nested confirm dialogs keep their shortcuts, test selection and fixtures are
  honest, timing checks no longer gate passes, and CI keeps evidence from
  failed attempts. Reviews and the refactor plan are in docs/reviews/.

## [0.8.0] - 2026-10-11

### For players

- **The open map.** Out through the Commons gate the Wilds now run on
  without doors: no fades between chunks, just walking. The Tangle comes
  first, the Whitequiet north of it, and new land all round past them.
- **The Tangle is new once.** Same iron-oaks, the plank and the papers where
  they were, but new paths and camps. Its camps, nodes and chests start
  fresh. Your pack, home chest, story and Echoes are kept.
- **New land:** woods that thin into **meadow** (open grass, wildflowers,
  stone outcrops, a lone oak), and **the Wend**, a wide dark river you cross
  at **fords**, wading slowly.
- **The Lantern Road** runs north from the Whitequiet, old paving with
  **dark lamp stones** beside it. Look at one; Mara might know what they
  were for.
- Everything past the Tangle **turns every wick**: the land, the river's
  course, the places. When it turns while you're out there, you stay where
  you are and the land changes round you. If you were standing in something
  that's now solid, you step to open ground.
- **The drift** closes the way three chunks out. You can see a little of
  the land beyond it, pale through the veil, but you can't walk in.
- Further out is harder: the camps hit harder and the chests are better.
- **Make paths.** With a spade in hand, clear a thicket; with an axe, a
  fallen trunk. Then lay **stone** (one stone a tile) or **plank** (one
  timber a tile) under your feet: L for stone, P for plank, held down to keep
  laying as you walk. Paths are a little faster to walk on. Out past the
  Tangle they go when the land turns, and the game asks before your first
  one each wick. L on your own path lifts it and gives the stone back.
- **Named ways.** Lay stone all the way from one place to another and it
  becomes "<your name>'s way", with a sign at each end.
- **The Map** is a new page in the journal: the land you've walked this
  wick, the road and the river, your paths and ways, the places you've seen,
  who found them, and you.
- **Landmarks** stand over the trees: a split oak, a standing stone, a lone
  oak in the grass, an outcrop. You can see them from a chunk away.
- **First to find.** Reach a place before anyone else in your world this
  wick and you get a small find, and your name stays on that place on
  everyone's map until the turning.
- **A rumour each wick.** Ask Elara in the library what she's heard from
  the drift. Something is tucked under a landmark out there; everyone can
  open it once.
- The place name at the top of the screen says when you're in the meadow or
  by the Wend.
- Friends out in the Wilds show up from the next chunk over, not only in
  the same chunk.

### Technical

- **Contract 8.** `content/wilds.json` v3: footprints (`places`), `lands`,
  `landSizes`, `tiers`, `frontier`, `paths`, `river`, `road`, `placeKinds`,
  `cells`, `words` and the `rumour` phrase tables; ground and decor ids moved
  from Go constants into content. The 3×3 `regions` are gone.
- **Generator v3** (`server/internal/wilds`): one world on signed chunk
  coordinates, cells with one place each, lands by weighted points with soft
  borders, the Wend with a ford on every route, the Lantern Road and its lamp
  stones, routes between places, landmarks, the rumour's site, and
  `Glimpse` past the frontier. Integer math, pinned by `golden_v3.json`. v2,
  its goldens and fixtures are deleted.
- **The server world:** migration `034_open_map.sql` (a clean break:
  `wild_epochs` with a `still` and a `wick` kind replace `region_epochs`;
  Wilds entity state, claims, discoveries and lanterns cleared; saved Wilds
  positions moved to the Commons arch; `last_outer_epoch` →
  `last_wick_epoch`). Chunks are made on demand inside
  `frontier.Inside`; the Tangle's nine come with the still epoch.
- `GET /api/wilds/near/<cx>/<cy>` replaces the region read: epochs, the
  frontier, and for the 5×5 window entity states, claims, discoveries,
  lanterns, Echo assignments, ground changes, the glimpse and named ways.
  `GET /api/wilds/region/<id>` is gone.
- **The world-changes layer** for paths: `POST /api/wilds/clear`, `/lay`,
  `/lift` (ground changes per chunk and epoch in `world_changes`), named
  ways (`WildsWay` with path and sign tiles) made and broken by lays and
  lifts; `POST /api/wilds/discover` (first insert wins, rolls `discovery`);
  the rumour in `PlayerState.rumour`, opened through `POST /api/wilds/claim`
  with `rumour:<cx>:<cy>`.
- `where` on the open map is area `wilds` in world pixels. Presence rooms
  are `wilds:<cx>:<cy>`, shared with the 3×3 around them.
- **The client:** one Wilds scene with a moving 3×3 window
  (`src/game/wilds/window.ts`), ground painted in world pixels on a worker,
  landmarks drawn from a chunk away, the drift and the glimpse at the edge,
  walk speed by ground (laid ×1.15, ford ×0.5), the turning in place.
  `regions.ts`, `wildsRegion` and the chunk-scene area ids are gone.
- Paths on the client (`src/game/wilds/paths.ts`, rules in
  `src/lib/wilds/paths.ts`): predicted in the store and confirmed by the
  server through the outbox (`wilds-clear`, `wilds-lay`, `wilds-lift`,
  `wilds-discover`); a changed chunk is patched in place and repainted off
  the frame. Way signs and finders' names (`src/game/wilds/marks.ts`), the
  rumour's bundle in `sites.ts`, Elara's rumour talk, the Map tab
  (`MapTab.svelte`, `src/lib/wilds/map-model.ts`).
- The open-map art pass (`assets/generated/open-map-pass/`, packed as
  `openMap`): meadow pieces, landmarks, bank stones, fords, road paving,
  laid paths, the dark lamp stone, the frontier veil, the rumour's bundle,
  the way sign and the Map tab's icon.
- **Walking without stalls.** The Wilds window adds and removes a chunk's
  images, static bodies and interaction points in one pass
  (`src/game/area/bulk.ts`), draws things per chunk, blits flat decor, keeps
  the row behind until you're 8 tiles past an edge, and builds the rest of a
  chunk in ~4 ms slices (collision first, in attachment order). A tween leak
  on things and lanterns is fixed. At 4× CPU throttling the worst frame went
  from ~970 ms to 50 ms.
- Performance tooling: `?perf=1` (stage timings, long frames, an overlay,
  `__fsPerf()`), `npm run perf:walk` (a pinned walk, normal and throttled,
  never in CI) and `scripts/trace-hotspots.mjs` for DevTools traces; see
  "Performance" in `docs/testing.md`.

## [0.7.0] - 2026-10-10

### For players

- Silas's cottage on the Commons is now **Silas's Yard**, a shop you walk
  into under the sign of the fox and the saw.
- Talking to Silas is short now: his line, **See the Yard**, and Just
  passing. Brack's felling axe and the fox still come up when they apply.
- The Yard panel has four tabs: **Build**, **Furnish**, **Materials** and
  **Mend**. The timber rack, the display corner and the mending bench each
  open their own tab.
- Silas keeps hours: about forty minutes at his counter, then twenty out by
  the sawhorse. While he's out, the counter's tin still sells; mending waits
  for him.
- Silas mends for glims now (3 or 4 a tool), and so does Orrin.
- **Pell**, the under-clerk from the Count House, keeps the deeds in a small
  office through the Yard's side door. Buy a deed, take back one you gave
  up, or sign an invite at Pell's deed table.
- **Manage your deed** (from Pell) shows who's on your deed, lets you offer a
  place to someone at the table, and is where you give up your place.
- The guide arrows lead to Pell for deeds and follow Silas to wherever he is.

### Technical

- Content: the rooms `in:commons:yard` and `in:commons:yard:deeds`, with a
  new `inner` door kind for a side doorway between rooms of one building and
  named side-room ids. Silas's resident cycle (counter and yard) and Pell's
  single spot.
- `commons.silasTable` became `commons.deedTable` `{ area, x, y, radius }`
  (`HomeDeedTable`, field 7; field 6 and `silas_table` reserved). `atTable`
  checks Pell's office.
- Menders can name a resident (`ItemMender.with`); `nearMender` follows the
  cycle, and Silas mends anywhere in the shop while he's at the counter.
  Sellers can name a `shop` room (the honesty tin). Mender bills are
  `menderGlims`.
- Story marks and papers tied to an area also hold in that area's rooms
  (`content.RootArea`).
- The Yard panel (`YardPanel.svelte`, replacing `SilasShop.svelte`), the
  deed panel (`DeedPanel.svelte`), the talk builders (`src/game/yard-talk.ts`)
  and the shared deed table module (`src/game/deed-table.ts`).
- The Yard art pass (`assets/generated/yard-pass/`): the shop and office
  furniture, the cottage's sign, and Pell.

## [0.6.1] - 2026-10-10

### For players

- Embers and the purse's gold are now one currency: glims. A glim is a bead
  of amber holding a glint of light. You earn them from Habitica XP as you
  earned embers, 10 XP to a glim.
- The gold you had in your purse was turned into glims, two gold for each
  glim.
- One counter on the screen, glims, on desktop and phones.
- In the Menu, **Turn gold into glims** spends Habitica gold, two gold for
  each glim. You pick the glims and the card shows the gold. **Max** fills in
  the most you can get. You can get up to 30 glims a day this way, in up to
  two top-ups.
- The purse log is now the **Glim log**.
- Every good has one price, in glims. Silas's bundles cost 3 or 4 glims.
- Shelf prices, letters and gifts by hand use glims. Glims you get from a
  friend or a top-up can't pay for a rest at 0 HP; only glims earned from XP
  can.

### Technical

- Contract 7: `PlayerState.glims` (a new `Glims` message), glims fields on
  quest steps, buys, gives, mail and the purse (`Purse.glims_left`,
  `PurseTopUp.glims`). The old ember and gold fields are reserved. A buy has
  no `pay`.
- Error codes `insufficient-glims` (225) and `top-up-cap` (226). The
  `insufficient-embers` and `insufficient-gold` codes are deprecated and no
  longer sent.
- Migration 033 `glims`: balances and the ledger move to one `glims`
  currency. Purse gold is turned in at 2:1 with a `currency-merge` ledger
  row, gold letters become glim letters (the mail rebuild), and
  `purse_topups` gains `glims`.
- A top-up credits one glim for every two gold, with a cap of 30 glims per
  UTC day across up to two top-ups (`top-up-cap`). Glims from top-ups,
  shelves, letters and gives are never XP-earned.
- The client's game state, content keys, vectors and words say glims; the
  Ember Charm keeps its name. The glim art is packed for the HUD.
- `buf.yaml`'s breaking rules let a field go only once its number and name
  are both reserved (`docs/proto-migration.md`).

## [0.6.0] - 2026-10-10

### For players

- You can move gold from Habitica into a purse here. Find it in the Menu,
  under your Habitica hero. It spends Habitica gold, and you're asked each
  time.
- Purse gold buys goods from Hazel, Finn and the fair stall, and timber,
  stone and fiber from Silas.
- Put a price in gold on things you leave on your gate shelf. Friends pay you
  when they buy them.
- Send gold to a friend in a letter, or hand it over when you're standing
  together.
- Wear any Habitica gear you own. Choose it in the Character panel's new
  Wardrobe tab. Your stats and your Habitica outfit stay as they are.
- What you carry in your off hand is now "at your belt".

### Technical

- The purse in the game: the Menu's purse card with Top up (it syncs first,
  then the consent card; the token rides in that one request, never the
  outbox), the purse log sheet (`GET /api/purse`), gold in the HUD on desktop,
  gold choices at the sellers, shelf prices and Buy, gold letters, gold gives
  and the gold gift toast. Gold buys, letters and gives are predicted from the
  outbox entry's stored purse change. The purse pass's icons are packed
  (`purse.webp`).
- The purse on the server: gold is a second ledger currency
  (`balances.gold`, `store.CreditGold`/`DebitGold`); a top-up spends
  Habitica gold through a temporary reward, keyed per account and checked in
  a detached worker (balance checks at 2, 5, 10, 20 and 35 s, then settled
  lazily), at most two a day, with `GET /api/purse` for the log. The token is
  used for that one request: never stored, logged or returned.
- Gold between players: shelf prices and Buy, gold at sellers, gold letters
  and gives, with a conservation test per account and by reason.
- The wardrobe: `player_gear` filled only from the server's own reads of
  Habitica, `rules.Look`/`Resolve` with shared vectors
  (`content/vectors/wardrobe.json`), and a changed look that tells friends in
  the room after its commit.
- Contract 6: the purse and wardrobe protos, error codes 220-224, and
  migration 032 (with the mail rebuild).
- A `dev` branch holds the next release for playtesting; `main` gets only
  releases, tagged and published automatically once CI passes.

## [0.5.2] - 2026-10-09

### For players

- Send your mount home on your own land and it walks back into its bay in
  the stable.
- A friend's Ward-light heals you as much as it heals them.
- Friends see the moves you make while walking or riding.
- A hero who comes back from the Orb of Rebirth keeps their class moves.
- The picture holds still when the camera follows you on a plain screen.
- Mend shows how much it healed, as the ward does.

### Technical

- The step-back reviews after 0.5 (`docs/reviews/2026-10-09-step-back-*.md`)
  and the two cleanup lanes that acted on them.
- Presence: `PresenceAbility.pulse_heal`, filled by the hub from the
  caster's Mend; the reach check allows for movement only while the caster
  walks or rides; no cast before a position. Ward credit is reserved per
  report and settled at commit.
- `sync_baselines.class_mark` is written at sign-in, at account creation
  and before a sync.
- The idempotency cache refuses any request with a credential-shaped field,
  checked over every keyed request type.
- Shared magic vectors (`content/vectors/magic.json`), replayed in Go and
  TypeScript. Pulse times come from the ability's own numbers.
- Tests: the Go rig starts on a fixed date (`GLIMWAY_RIG_START` overrides
  it), store functions take the clock, ward pulses fire by hand (the api
  package runs in 13 s, not 30), and e2e polls what's still settling. CI
  runs `go vet` and `-race` on the api package; dev-tagged tests are named
  `TestDev…`.
- A connected operation holds the world from the moment it's taken, not
  from its send: an input in between (an M right after Saddle up, a second
  operation) no longer slips through.
- A refused fishing keep closes the line; a water missing from content
  closes its casts. The report pump moved out of `link.ts`; dead exports
  are removed and guarded by a test.

## [0.5.1] - 2026-10-09

### For players

- A fix for servers that build Glimway with Nix. Nothing changes in play.

### Technical

- The Nix web package includes the crafts pass's manifest, which the
  stable's layout reads; 0.5.0 failed to build with Nix.
- Releasing: a release commit's full e2e run on `main` is never cancelled
  by a later push (so the right commit is tagged), the tagger runs one at a
  time, and "Publish GHCR image" can be run by hand for an existing tag.

## [0.5.0] - 2026-10-09

### For players

- Riding has moved home. Build a stable after the Workshop, stall a
  mount, and set out from there: M to ride or get down, and it follows
  you on a lead through the village.
- Choose which of your pets walks with you, and up to three to live at
  home, in the Character panel's new Companions tab. Friends' pets follow
  them now too, and you can pet any of them.
- At level 20 each class learns a second move: Stand, Kindle, Ward-light
  or Echo. It's on R, and the second ✦ on phones.
- Heroes without a class fight with what's in hand. Fingersnap is the
  mage's.
- Fishing at the mill pond. Ask Finn about the rod by his door.
- Silas's Yard has a Buildings section near the top. The stable is
  there, and says it needs the Workshop until you have one.
- Walk without a pet if you like: No pet is a choice in the Companions
  tab.
- A mount you're riding leaves its bay empty, and walks back into it when
  you send it home on your own land.
- After a catch, Keep it with E or Let it go with Q; the prompt names
  both.
- A click swings only a weapon or a sturdy tool (axe, pick, spade). A rod,
  can or pair of shears isn't for fighting.
- Esc ends a talk, unless there's a choice you have to make.
- What your quest step needs glows softly when it's on screen, and the
  top bar says when it's here rather than pointing at a way out.
- The gate signs at the village's edges are signposts you can see.

### Technical

- 0.5 Crafts (`docs/design/crafts.md`), contract 5. Companions:
  `POST /api/companions` (`companions`) stores the follower and up to three
  yard pets (`player_companions`, `yard_pets`, migration 030); a
  `follow_pet` of `none` means no follower, empty means Habitica's current
  pet. The stable: `stall`, `mount-out`, `mount-home` and `stable-extend`
  operations; `HomeView.stalls` shows a stall empty while its mount is out.
  Presence carries `avatar_change` and `ability` events to contract-5 tabs.
- Magic: `content/abilities.json` (with its proto) is the ability table
  both sides read. The level-20 moves unlock by the level mark,
  `sync_baselines.level_mark` (migration 031), and the report allows each
  move against its own budget; Ward-light's heal credit is spent after the
  commit.
- Buildings carry a `building` flag in `content/homestead.json`. What a
  click does with each belt kind is `SWING` in `src/lib/belt.ts`. The quest
  goal's route and target glow share `src/game/goal-route.ts`.
- The container's base images come from `mirror.gcr.io` (same digests),
  after Docker Hub rate limits failed CI builds.
- Releases tag themselves: when CI passes on `main` and `package.json`
  holds a version with no tag yet, `tag-release.yml` tags that commit and
  publishes the image (`docs/releasing.md`).
- Fishing in the game: the mill pond's three banks come from
  `content/fishing.json` and sit on the interactions path (Cast, Pull in,
  Reel, then Keep or Let it go in the context buttons). The rod is a new
  belt kind, `fish`. `fish-cast`, `fish-settle` and `fish-cancel` are
  keyed outbox operations that need a connection; `GET
  /api/fishing/waters` gives each water's band. A reload puts an open
  line back from `PlayerState.fishing`, and presence carries the
  `fishing` pose.
- A Line in the Race opens the Quests page's Crafts shelf. A quest
  already under way now speaks before another quest's start when both
  want the same person.
- The crafts pass's fishing frames (rod, float, rings, splash, roach, fry,
  recipe card) are baked into the items pack.

## [0.4.0] - 2026-10-09

0.3 (Server-first) shipped only as pre-releases; its changes are part of 0.4.0.

### For players

- Hazel's sponge rises in its washtub, Finn's hoist works when it's
  fixed, and Elara sits writing at her desk while she keeps the library.
- The library's section signs are small plaques on the shelves now, so
  the books show.
- Step inside. Hazel's kitchen, Finn's mill with its sack loft up the
  stairs, the library's reading room and your own cottage are rooms you
  walk into, furnished and lived-in.
- Hazel and Finn keep their hours: Hazel bakes for forty minutes of each
  hour and steps out for twenty; Finn works the stones, the loft and his
  door. Knock when nobody's home and you'll hear where they've gone. You
  buy from them wherever they are.
- Elara keeps the library half of each hour. Talk to her to read or to
  give a paper; the shelves are sorted into Stories, Histories, Recipes
  and Field notes, and there's a reading nook by the window.
- A Quests page in the journal lists every quest you've found, with its
  notes. Pin one and its goal leads the top bar.
- A new beginning with Orrin and Mara, and three small quests in the
  rooms: Set to Rise with Hazel, The Stuck Hoist in Finn's loft, and A
  Seat by the Lamp in the library.
- People say their own piece first; a quest's request follows.
- Closing the tab right after a fight keeps what happened in it.
- When someone speaks the warden's naming, the warden you're watching rests
  for its few seconds and no longer, even on a slow or background screen.
- Coming back online after playing offline sends your health and place to
  the world at once, instead of up to ten seconds later.
- Opening and closing a conversation or a panel is quiet again: the
  zip it made is gone.
- Felling a tree takes all of it: trees leaning over a path in the Wilds
  sometimes left their top standing over the stump, or didn't fall at all.
- Mara, Orrin and Pip have painted portraits in conversation, like the
  rest of Hearthwick, and Silas's shows too.
- Your world lives on the server now. Everything you do is checked and kept
  there, so a second device picks up exactly where the first left off.
- Glimway plays with a Habitica account only: playing without signing in
  is gone.
- Lost your connection? Keep playing nearby. What you do waits on this
  device and goes up as soon as you're back; spending embers and anything
  in the Wilds waits for the connection.
- The Tangle and the outer Wilds are drawn fresh by the server, so the
  Tangle you know looks different.
- Glimway has sound: footsteps that change with the ground (grass, path,
  stone, wooden floors), the thunk of an axe, a pick on stone, a spade in
  the earth, doors, coins, and the knocks and swishes of a fight. The Menu
  has a sound switch and a volume slider, kept on this device.
- Phones and high-resolution screens draw the world at their full
  resolution: the art is sharper, and you see the same stretch of it as
  before.

### Technical

- One schema: everything the server and the client both type or load is
  on protobuf. The remaining hand-typed routes (homestead, items, library,
  mail, storage, crafting, commons, projects, repairs, world, operation
  results, invites) have generated request and answer types, decoded
  strictly on both sides; client requests are built through the generated
  schemas. Every content file both sides load has a schema in
  `proto/glimway/content/v1` (files stay JSON; a few reshaped where proto
  can't express them), field rules as protovalidate constraints, and
  cross-entry rules in code once per language, pinned by shared vectors
  with a rule id per refusal. The production client skips content
  validation (CI and the server validate the bundled files). See
  `docs/proto-migration.md`.
- The reconciliation read answers an operation's actual result.
- 0.4 Indoors (`docs/design/indoors.md`), contract 4: rooms are places
  (`content/rooms.json`, `in:<parent>[:floor]` ids, per-room presence),
  residents on an hourly cycle (`content/residents.json`, `residentAt`,
  the server's clock via `X-Glimway-Now`), quests by id on the server
  (triggers, gates in order, `reached_at`/`gate_at`, migration 029).
- Furnishings: one catalogue (`content/furnishings.json`, 76 pieces,
  the home goods moved in) and one placement rule (`canPlace`, Go and
  TS, shared vectors); rooms place pieces by id with a facing and a
  parent; collision is each piece's base.
- The indoors art pass, round 2 (176 frames) and a shared interior kit,
  under design 7.0's interior style rules.
- Reports: closing the tab sends the newest steps under the next
  sequence instead of resending the report in flight.
- Dev mode for local playtesting (dev builds only, which `npm run server`
  now makes): `POST /api/dev/grant` gives the signed-in account embers,
  items or home goods through the real store paths, never anything from
  Habitica; the dev panel (`` ` `` or the Menu's Dev row) exists only under
  `vite` dev. Production binaries and bundles don't contain either.
- e2e waits for a server answer allow 15 s (`SERVER_ANSWER_MS`): the first
  answers of a session take 3-5 s on the software-rendered smoke runner.
- Everything drawn for a tile registers in one place
  (`src/game/area/tile-art.ts`), so felling removes the foreground canopy
  too; a dev-only `__fsArtAt(tx, ty)` hook lets e2e read what's drawn.
- Dialogue busts for Mara, Orrin and Pip on a new sheet
  (`fingersnap-portraits-residents`); every speaker maps to a bust, and the
  sprite crop is only the fallback.
- Server-first (`docs/design/server-first.md`): the server owns all state
  and rules. `PUT /api/progress` and the uploaded progress document are
  gone; the client sends operations (`proto/glimway/v1/op.proto`,
  `operations.proto`), predicts their answers and rolls back a refusal.
  Every operation is idempotent on its key, replays the current state, and
  runs in a savepoint. Contract 3, sent as `X-Glimway-Contract`; an older
  client gets a reload notice.
- Accounts: random account ids, looked up from Habitica sign-ins
  (`sign_ins`). Migrations 026 (accounts), 027 (normalized state,
  `wilds_chunks`, the Wilds reset) and 028 (moves the old progress
  documents into the new tables).
- The Wilds generator is in Go (integer-only, v2) and pre-generates nine
  chunks per epoch; the client generator is gone and reads served chunks.
- The client keeps an outbox in IndexedDB per account and device, behind a
  Web Lock, so offline play queues operations and replays them with the
  same keys. Reports carry generations and sequence numbers; places and
  vitals have their own version watermarks.
- Local (guest) play is removed, and with it the client-side progress
  save.
- Dev builds only (`-tags dev`, and only with `-dev-clock`):
  `POST /api/dev/clock` moves a test server's clock forward, so e2e can
  cross a season end. Production binaries don't contain the route.
- CI: the full suite uploads screenshots and error context only on
  failure; `go test -tags dev` covers the dev clock.
- Sound effects from Kenney's CC0 packs (`public/assets/audio/kenney/`,
  43 MP3s, about 121 KB, in Git LFS; register in `ASSETS.md`). One sound
  module (`src/game/sound.ts`) plays them from the event bus; new bus events
  `sound:cue`, `sound:footstep` and `sound:work`. It stays silent under
  automated browsers (`navigator.webdriver`), so e2e runs fetch no audio.
  The setting moved to `glimway:sound` (`fingersnap:muted` is no longer read).
- The canvas renders at the device pixel ratio, capped at 3 (Phaser's NONE
  scale mode, sized by `src/game/main.ts`); the camera zooms in canvas px
  (`canvasZoomFor`) and everything the interface reads or writes (insets,
  the hero's spot, the dev hooks) stays in CSS px through `canvasRatio`.
  Phones above a ratio of 1 keep the whole 4× art: about 44 MB of textures
  instead of 16 MB.

## [0.2.0] - 2026-10-08

### For players

- When a new version of Glimway is ready, a small notice offers to reload.
  Your progress is saved first, and if it can't be saved just then, the
  notice says so and waits.
- The Menu shows which version you're playing, with a link to this list of
  what's new.
- After an update, a short card says what's new since you last played. The
  Menu's "What's new" brings it back any time.
- Prompts are steadier: the nearest thing you can reach always shows its
  prompt, and a click reaches exactly as far as the action itself.

### Technical

- `package.json` is the one source of the version; the Nix packages read it
  too. Each build also gets a build id: the short git commit of a clean
  checkout, the `GLIMWAY_BUILD` it is given (the Docker build argument the
  release workflow fills, the flake's revision), or else a hash of the build's
  inputs (`scripts/build-version.mjs`).
- The client gets both at build time (`__GLIMWAY_VERSION__`,
  `__GLIMWAY_BUILD__`), and `vite build` writes `dist/version.json`. Open tabs
  check it when they come back into view and every ten minutes; a different
  build id brings up the reload notice. Its Reload stops the world (input,
  enemies, physics, timers), saves until the stored copy is the live game,
  waits for every server write in flight (including ones queued behind the
  upload, and a superseded tab's orphan copy), and only then reloads; if
  anything can't be saved, play resumes and the notice says why.
- The server is built with its version and build id (`-ldflags -X`, `dev`
  otherwise), reports them in `GET /api/health` and logs them at start-up.
- `version.json` is served with `Cache-Control: no-store`.
- The release workflow stops early when the tag doesn't match
  `package.json`'s version.
- This changelog, and the release steps in `docs/releasing.md`.
- The "What's new" card reads each release's `### For players` lines from
  this file when the game is built (`virtual:whats-new`,
  `scripts/whats-new.mjs`), never at runtime. A device remembers the build it
  last caught up to (`glimway:whats-new` in localStorage); a device that
  never saw the card catches up without one. `CHANGELOG.md` is now a build
  input (the build hash, the Docker context, the Nix web package).
- Interface cleanup: one panel shell (`Panel.svelte`) and notice card
  (`NoticeCard.svelte`), shared panel styles and colour tokens in `app.css`,
  the panel action and bus helpers (`panel-state.svelte.ts`), one table of
  what each overlay holds back (`layers.ts`), the camera insets measured
  from marked elements (`play-insets.ts`), connected play's state machine
  out of `App.svelte` (`account-flow.svelte.ts`, unit-tested), and the
  refusal copy in `src/content/errors.ts`. Node tests can import rune
  modules through `tests/helpers/svelte-runes.ts`.
- The client no longer falls back when a server has no mail recall: every
  server since the first deploy has it.
- A shared contract in protobuf (`proto/`, generated with `buf` into
  `server/internal/gen` and `src/lib/gen`, checked in): the error codes are
  one enum on both sides, calendar and invites are served from generated
  types with today's JSON shape, and CI regenerates the code and runs
  `buf breaking` against `main`. Plan for the remaining domains:
  `docs/proto-migration.md`.
- Presence is binary protobuf over the `glimway.presence.v1` subprotocol;
  a broadcast is encoded once for every recipient (about 7.5 times faster).
  A tab from an older build is told to reload (close code 4005).
- Game cleanup: one typed, Phaser-free event bus; `lib/tile.ts` and one
  hash module; one interactions path (each point carries its verb, label,
  marker and reach) with one nearest-wins loop; `WorldScene` split into
  controllers (unmoored, the Turning, dialogue actions, moves); homesteads
  and enemies split by concern; the superseded placeholder drawers retired
  and the art-pass loaders collapsed into `art-pass.ts`.
- Server cleanup: `api.go`, `items.go`, `homestead.go` and `presence.go`
  split by responsibility (`expansion.go` is now `mutation.go`), shared
  HTTP test helpers, `internal/itemmove` for item transfers (API and mail),
  and a pinned migration history (`store/history.json`) with upgrade
  fixtures that carry data.
- Playwright uses at most 3 local workers by default.

## [0.1.0] - 2026-10-07

The first public release.

### For players

- Walk the old lantern road: meet Mara in Hearthwick, follow the Brackenwood
  Path, settle the stone warden at Ashwatch Ruin, and light the lanterns
  again.
- Light, fair combat: every attack is telegraphed, and you have a basic
  attack, a signature ability for your class and a dodge roll.
- Play as a guest, with everything saved in your browser, or as your own
  Habitica hero: every 10 XP you earn on Habitica becomes an ember to spend
  on warm rests, road lanterns and the Ember Charm.
- Join a small, invite-only world with friends: raise a homestead in
  Hearthwick Commons from a campsite to a cottage and a workshop, arrange
  your furniture, gather in the shared Tangle, give to village projects, send
  mail, and see each other walk around and wave.
- Gather and craft: chop, quarry, dig and plant, then make things at the
  hearth, the desk and the crafting bench.
- Glimway keeps its own calendar, with festivals that change the village for
  a day.
- Find 52 papers (letters, ledgers, songs and more), read them in your
  journal, and share them in the Hearthwick Library.
- Plays on phones too, with touch controls.

### Technical

- Browser game in Svelte 5, TypeScript, Phaser 3 and Vite; an optional Go
  server with SQLite for shared worlds, with presence over a WebSocket.
- Habitica access is read-only: one `GET /user` per connect or sync, from
  the browser.
- Three ways to deploy: a NixOS service flake, Docker Compose with images on
  GHCR (`ghcr.io/solidsilver/glimway`, amd64 and arm64), or by hand
  ([docs/home-server.md](docs/home-server.md)).
- Code under AGPL-3.0-or-later, the game's own art under CC0, Habitica's art
  under its own licence; contributions under the DCO.
- Unit tests, Go tests and Playwright playtests.

[Unreleased]: https://github.com/Solidsilver/glimway/compare/v0.11.1...HEAD
[0.11.1]: https://github.com/Solidsilver/glimway/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/Solidsilver/glimway/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Solidsilver/glimway/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/Solidsilver/glimway/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Solidsilver/glimway/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Solidsilver/glimway/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Solidsilver/glimway/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Solidsilver/glimway/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Solidsilver/glimway/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/Solidsilver/glimway/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Solidsilver/glimway/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Solidsilver/glimway/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Solidsilver/glimway/compare/v0.2.0...v0.4.0
[0.2.0]: https://github.com/Solidsilver/glimway/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Solidsilver/glimway/releases/tag/v0.1.0
