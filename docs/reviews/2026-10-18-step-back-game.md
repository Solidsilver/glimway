Snapshot: `190a9d38`

## Map: what changed

Since the last step-back (`268c9b42`), the game moved to one outdoor space with served
town/lot chunks, a location seam, fixed-ground arrival barriers and streamed town life.
The emphasis here is the work after `v0.11.2`: pinned held epochs and lot backland;
oil-fed camps and their build permissions; Common paths and communal lamps; the Keeper's
hand and naming; weekly sap, ways home, the trowel, recovery crates and carried plants;
and the land chip, dimming notices and map lamp marks. Staging dev grants now control
the browser hooks. Place-report recovery and the Turning's initial fade received fixes.

`WorldScene.ts` is **1,391 lines**, up from **1,190** at the last review; `link.ts` is
**2,427**, up from **2,416**. The new lamp controllers are outside the scene, but their
read ownership does not follow the stronger Wilds/Home store conventions. The main
risks are at those asynchronous boundaries and in land-status invalidation.

Read the previous game/server reviews, the consolidated review's accepted/rejected
findings, and `docs/decisions-overnight.md`. This review keeps the owner's decisions:
dimming begins on the last oil wick; the wire's `dimming` flag means the later guttering
wick; camps use oil; held reach may form islands; lot recovery and Pell's recovery have
different destinations. None of those calls needs reopening.

## Findings

### G1. The Turning still discards authoritative relocations

**P1 · M · Confirmed.** `src/game/scenes/WorldScene.ts:683` uses `transitioning` for the
Turning's play hold. `onRelocate` drops every relocation while that flag is set
(`:1112`), with no pending destination. This is also the delivery path for a successful
turncap/pouch operation (`src/game/link.ts:2041`): `Session.applyServer` first changes
the saved position and emits `EV.relocate` (`src/game/session.ts:362`, `:379`).

A ways-home answer arriving after the Turning starts therefore spends the item and
updates the session, but leaves the sprite at the departure point. The Turning lands
from that sprite's position (`src/game/scenes/world-turning.ts:187`), releases the hold
(`:197`), and the next position sample overwrites the destination with the departure
point (`WorldScene.ts:985`). For another-area relocation, save and scene can disagree
about their coordinate space as well.

**Probe:** extracted and transpiled the actual `onRelocate` and `notePosition` methods
into a Node VM with a minimal sprite/session. With a Turning hold, a destination of
`(1000,1000)` was ignored; lifting the hold and sampling wrote `(100,100)` back. This
verifies the mechanism, not its frequency in a browser. The recent `FadeHold` fix is
present; it fixes the dark start, not delivery of this event. A dev warp being ignored
while input is held is not the player-facing finding here.

**Fix:** distinguish a play hold from an actual scene departure. Retain the latest
authoritative relocation during a Turning and consume it before sampling resumes;
cancel or finish the old Turning safely if that destination requires a rebuild.
Add a deferred ways-home answer/Turning regression and a relocation into another area.
The three `FadeHold` unit cases do not cover this interaction.

### G2. The camp cache crosses worlds, and naming callbacks outlive their scene

**P1 · M · Confirmed.** `src/game/wilds/camps-state.ts:9` exports a single mutable
camp list/account/member list, with no session or world key. Only the camp controller
writes it (`src/game/wilds/camps.ts:119`). Shutdown removes listeners/art but leaves
the cache intact (`:75`); the world-leaving hook clears Wilds, not camps
(`src/App.svelte:509`). A new controller draws that cached list before starting its
first read (`camps.ts:92`–`:100`). Inventory also uses it to decide whether a camp
exists here and whether building/planting is offered (`src/ui/InventoryPanel.svelte:368`).

**Probes:** populated the first world's cache, shut its controller down, then
constructed a controller with a different account/link and held its first GET. Its
first update drew the old world's camp list and retained the old account. Until the
new GET succeeds, players can see/interact with another world's camps at matching
coordinates; offline/failed reads extend that window. Server validation prevents an
unauthorized build, but the sprites, prompts and inventory choices are wrong.

There is also no scene-build check after the naming landmark read
(`src/game/wilds/camps.ts:330`, `:335`; the communal equivalent is
`src/game/wilds/communal-lamps.ts:277`). A deferred real `beginNaming` probe emitted
shutdown before resolving the GET: it still emitted `lampNamingOpen` for the departed
scene's lamp. Walking through a door while that read is pending needs no server
mutation and can produce this stale panel.

**Fix:** scope the inventory-facing camp model to session/link/world and clear or
swap it before the new scene draws. Fence post-await panel/toast callbacks to their
scene build; a scene can restart on the same Phaser object, so an active-scene check
alone is insufficient. Reuse the generation/link pattern in
`src/game/wilds/store.ts:614`. Add tests for first draw after world replacement,
failed initial reads and naming completion after shutdown/restart.

Same-link HTTP reads and mutations are serialized by `src/lib/api/queue.ts:19` and
`src/game/link.ts:1223`. An earlier fake-link probe allowed a GET to finish after a
newer fill/post; that interleaving does not model the production queue and is excluded
from this finding.

### G3. The land chip does not recover or invalidate for several ordinary land changes

**P1 · M · Confirmed.** `LandHere` records a status request before it completes
(`src/game/wilds/land-here.ts:48`) and refuses another request for the same chunk/wick
while stationary, even after its age limit or a store-version change (`:33`, `:46`).
`refreshLand` silently retains old status on failure (`src/game/wilds/store.ts:547`).

Several successful mutations never replace or invalidate that status:

- Lot-lantern filling reloads Home and Items, but not the backland's status
  (`src/game/entities/homestead-talk.ts:399`). From the backland side of the stake,
  the lamp can say it burns while the chip still says Dimming.
- Communal relight/post/lift updates only the controller's lamp list
  (`src/game/wilds/communal-lamps.ts:320`). A first communal lamp can leave the chip
  saying Turning; removing the last can leave it saying Common.
- Path answers update ground/materials/ways and bump the store, but leave `view.land`
  unchanged (`src/game/wilds/store.ts:837`, `src/game/wilds/ops.ts:160`). The first
  laid path or last lifted path can likewise leave the wrong tier underfoot.
- Camps explicitly refresh status for set/fill/pack, but omit taking down an empty
  lamp (`src/game/wilds/camps.ts:385`), whose released hold has a different outlook.

**Probe:** drove the actual communal `act` method and actual `LandHere` with a known
Wild chunk. After a successful post, 120 seconds of stationary updates, including
store-version bumps, made no second status request; the chip stayed Turning. A failed
initial status read has the same stationary retry cutoff. Crossing away/back or an
unrelated near read may heal this, so it is not permanent server-state corruption.

**Fix:** invalidate affected chunk status after every tier/upkeep/visit-changing
operation and refresh it through one coalesced store path. Track request success and
allow bounded retries while stationary after failure or invalidation. Extend
`tests/land-chip.test.ts:88` beyond manually replacing `view.land`: exercise real
mutation completion and one failed read followed by recovery without walking away.

### G4. New content references are unchecked, and naming validation already differs across languages

**P2 · M · Confirmed.** New fields have protobuf range/pattern checks, but the semantic
loaders were not extended like the older stable/post rules. The TypeScript loader
returns immediately after stable validation (`src/lib/homestead.ts:148`–`:152`). Go
adds only naming-list checks after that point (`content/homestead.go:246`, `:251`).
The WickSap schema even promises code checks for its item, oil and seller
(`proto/glimway/content/v1/homestead.proto:67`), which neither loader performs.

**Probes on both real loaders:** each accepted an unknown lot-lantern oil, an unknown
way-lamp piece, an unknown sap refiner, and `wayLamp.maxWicks=1` with
`wicksPerOil=2`. Those configurations can pass content loading while making fuel,
construction or refining unusable, or creating a store outside its declared capacity.
Separately, TypeScript accepted a duplicate naming ordinal and a side/fallback id
collision; Go rejected both. These are malformed-content risks, not defects in the
currently shipped IDs. The shipped-content tests pass.

**Fix:** validate item existence and suitable kinds, the camp-only lamp furnishing,
seller existence, usable oil capacity, and the promised sap/lot-oil relationship.
Bring naming checks into the TypeScript twin. Add all these mutations to
`content/vectors/homestead-loader.json` and run them through both loaders; that shared
file currently has no cases for the new lamp/sap/naming fields. Keep production
browser validation disabled as already decided; strengthen the CI/server gate.

### G5. The single dimming rule is still several derivations; new reach/upkeep twins lack shared vectors

**P2 · M · Confirmed maintenance risk.** `landDimming` correctly drives the chip and
map marks from `nextTurning` (`src/lib/wilds/map-lamps.ts:11`). Lamp art/text separately
derive the phase from oil and the wire flag (`src/lib/camps.ts:16`, `:74`;
`src/lib/lot-lantern.ts:14`, `:24`). The server separately predicts next upkeep
(`server/internal/api/map_tiers.go:54`) and implements the same oil transition twice
(`server/internal/api/camps.go:676`, `server/internal/api/lot_lanterns.go:239`).

Even precedence differs: the map/server say held when oil is positive, whereas both
art helpers say dimming when the guttering flag is true. `tests/land-chip.test.ts:46`
explicitly tests the first interpretation. Normal fills clear the flag, so this is
not evidence of a currently reachable display bug; it shows that the advertised
single rule does not enforce agreement. The old/new meanings of “dimming” make future
changes particularly easy to apply to only some views.

Held reach has a similar test seam: the client computes the union in
`src/lib/wilds/coords.ts:113` and `:119`, and Go in
`server/internal/frontier/frontier.go:74`. Their dedicated suites pass, but the shared
`content/vectors/wilds-coords.json` has no held/slack inputs. The new frontier tests
independently restate expectations rather than replaying one cross-language matrix.

**Fix:** one pure upkeep/phase function per language, with shared transition vectors
used by both holder adapters, map projection and client presentation adapters. Cover
last wick, guttering, refill, release and dark; keep display dimming distinct from the
stored guttering bit. Extend shared coordinate vectors for overlapping holds, south
clipping, negative coordinates, released-hold retention and disconnected islands.
Do this before adding the permanent-core/paid-extension hearth holder in 0.14.

### G6. WorldScene still owns both system assembly and the movement state machine

**P2 · L · Confirmed.** The scene gained a net **201 lines** since the last review.
`create` begins at `src/game/scenes/WorldScene.ts:231`; the open-map assembly alone
wires entities, fixed life, the window, paths, marks, camps and communal lamps
(`:433`–`:512`). Observation/play ordering lives at `:735` and `:809`; position,
presence and frontier policy at `:981`–`:1042`; relocation, exits, warps, doors,
rebuilds and the fade/restart primitive at `:1111`–`:1381`. The cost is visible in G1:
a flag shared by these responsibilities is easy to interpret differently at each use.

**Fix:** first fix G1 in a focused patch. Then extract a scene-travel owner for
relocation, pending destinations, door/exit/rebuild requests and fade/restart lifetime;
give the Turning an explicit play-hold interface to it. Separately extract an
open-map installer that owns those controllers and their observation/play/shutdown
hooks. Keep the scene as the assembly point for the hero, camera and frame. Existing
`world-arrival`, `world-camera`, `world-controls`, `world-actions`, `world-frame` and
`FadeHold` are useful boundaries; preserve them. Node-test the travel owner against
deferred arrivals, not just its fade-token helper. This is staged refactoring, not a
prerequisite for fixing G1–G4.

### G7. Link's durable sender remains the carried extraction

**P3 · M · Confirmed; carried from the previous game F3 / consolidated C18.** The
2,427-line class still owns record takeover (`src/game/link.ts:927`), record creation
and saving (`:970`, `:992`), submit/enqueue/drain (`:1082`, `:1115`, `:1163`), outcome
settlement and queue expiry. Mixed-domain routing/serialization is another coherent
block at `:111`–`:249`, alongside the newer schema-derived operation registry.

There has been useful progress: `src/lib/api/queued-operation.ts:10` derives fields
and results from the route schemas, and the new lamp operations use it. The record
store and report pump are also already outside Link. Do not reopen this as a newly
discovered durability failure; the passing durability/report suites are valuable.

**Fix:** move the mixed-domain route/body adapters out first, then give one durable
sender ownership of record/fence/queue/replay/expiry behind Link's existing facade.
Keep lease/server-state adoption and domain-facing methods in Link. Preserve
persist-before-visible, one fenced sender, immutable operation keys/bodies and ordered
replay. Use the existing durability/failure/report rigs as the acceptance net.

## Verification

All commands used `nix develop -c …`, without background shell jobs. No Playwright,
Vite, implementation edits or commits.

- **Node: 2,633 passed, 0 failed**, 64.1 s. This worktree has no `node_modules`; the
  initial plain `npm test` failed to resolve packages. A temporary Node resolver used
  `/data/code/fingersnap/node_modules`, whose `package-lock.json` is byte-identical,
  and the full suite then passed. No dependency link/install was made in this worktree.
- **Go:** `go test -count=1 ./content ./server/internal/frontier` passed.
- **Throwaway probes:** `/tmp/step-back-game-probes.mjs` transpiles the real lamp
  controller classes/selected scene methods with inert drawing/network dependencies;
  it also imports the real chip/content helpers. A Go `-overlay` test, entirely in
  `/tmp`, verifies the content mutations against `DecodeHomestead`. All reported
  mechanisms reproduced. These are terminal probes, not browser reproductions.

## What's healthy

- **The two place-report repairs are present and covered.** Same-area ignored
  positions mark the next report changed (`src/game/link.ts:1554`,
  `src/lib/api/reports.ts:157`); scene arrival forces the first page report
  (`link.ts:1527`). `tests/link-places.test.ts:124` and
  `tests/link-reports.test.ts:218` exercise resend/settle and reload arrival. Those
  tests passed; neither old bug is reported again here.
- **The dark-start repair is appropriately small.** `FadeHold` uses one build token
  and one lift (`src/game/scenes/fade-hold.ts:21`); the Turning no longer suppresses
  that fade-in just because play is held. G1 concerns a different event boundary.
- **The Wilds store has the right ordering/lifetime machinery.** Near reads check
  generation and link after awaits (`src/game/wilds/store.ts:614`); pinned epochs,
  frontier and per-chunk land status have ordering marks. Reuse this for G2/G3.
- **Map presentation uses the owner's last-wick rule.** The chip, hatch, ledger and
  lamp icon agree on `nextTurning`; real endpoint fixtures cover lamp-only Common
  chunks (`tests/map-lamps.test.ts:64`). Reach islands are intentional and the new
  dedicated client/Go tests pass. No change to those rules is proposed.
- **Previous combat cleanup landed.** Camp reward recovery continues every five
  seconds with one request in flight (`src/game/wilds/camp-fights.ts:82`), and enemy
  colliders have an explicit sprite lifetime (`src/game/entities/collider-lifetime.ts:2`).
  The pure crate-picker, trowel, carried-plant, sap and naming helpers also have useful
  unit coverage. Their missing coverage is runtime interleaving, not basic copy/math.

## Seams for 0.14

Fix G1–G4 before growing the land/building surface. They need no new product decisions.
For the contract freeze, settle a typed holder/claim status that can describe a
permanent hearth core and oil-fed extensions without treating an unknown hold as an
empty oil lamp. Pin the coordinate spaces and identities of placed pieces, planted
versus carried plants, pinned epochs and recovery ownership with shared fixtures.

Keep a session-scoped land/camp/lamp model separate from Phaser rendering and inventory
affordances. It should own read ordering, lifecycle cancellation and invalidation;
0.14's building pieces and stalls should consume that model. Preserve the current
server-computed `builder` permission instead of copying claim-rule membership logic
into more client surfaces.

The owner needs to choose how much of G6/G7 to schedule before feature work. The useful
minimum is the travel boundary and shared rule vectors; a wholesale scene/Link rewrite
would add risk without being necessary to fix the confirmed player-facing defects.
