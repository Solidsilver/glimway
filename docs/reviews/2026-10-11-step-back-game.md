# Step-back review after 0.8: the game, the UI and the client libraries


## Map: what changed since 2026-10-09

Snapshot **a5005c3**, v0.8.0 **The open map**. Review of `src/game`, `src/ui`, `src/lib`,
`src/content`, `tests/` and `e2e/`; server and tooling implementation belong to the other reviews.
This follows `2026-10-09-step-back-game.md` at afa8363. Review only: no implementation changes.

**The earlier cleanup mostly landed.** The caster's Ward-light number is relayed; magic has shared
vectors; the report barrier reuses its accepted acknowledgment; the camera snaps in device pixels;
Go home walks a mount into its bay on its own land; the duplicated offsets/heal application were
removed; a dead-export guard now runs with the unit tests. The report pump was extracted, but the
outbox still lives in Link. The large UI splits remain outstanding.

**0.6–0.7 changed the ownership and shopping boundaries.** The wardrobe reads owned gear from the
server, with `GridPicker.svelte` shared by Wardrobe and Companions. The purse subsequently became
glims in 0.6.1, rather than exposing Habitica gold as another client balance. Silas's Yard collects
Build and Furnish, with a separate deed panel in Pell's office. Those are useful domain boundaries;
the old request to add owned gear and gold to the browser's Habitica mapping is superseded by the
server-owned reads, not an omission to reopen.

**0.8 changed the Wilds' lifetime.** Generated chunks now come from the server into one scene with a
moving 3×3 rendered window and a wider near-read window. Ground paints on a worker in world pixels.
Paths predict immediately and settle by outbox key; first finds, named ways and the Map tab use the
server's geometry and discoveries. A turning rebuilds the land in place. The walk-perf pass added
bulk display-list/body operations, attachment-order BuildQueue, chunk-edge slack, sliced builds and
performance spans. This reduces scene churn but increases overlapping asynchronous work: the
remaining high-payoff defects are about ownership, ordering and readiness, rather than another
large rewrite.

### Status of the previous findings

These are the **previous review's** F numbers; the findings below have their own numbering.

| Previous | Status | Evidence at this snapshot / remaining work |
|---|---|---|
| F1 — friend's Ward-light amount | **done** | `src/lib/combat-moves.ts:120` owns the pulse formula; `src/game/entities/moves.ts:198` uses the hub's relayed amount. `e2e/abilities.spec.ts:164` checks a real second player's healing and subsequent persisted HP. |
| F2 — camera rounding | **done** | `src/game/scenes/world-camera.ts:31` wraps prerender with camera snapping; the camera tests cover device-pixel framing. |
| F3 — one-shot assertions after actions | **partly** | Polls and `steady()` (`e2e/helpers.ts:323`) replaced many original races. The six cases below retain weaker readiness/targeting assumptions; `e2e/abilities.spec.ts:204` still follows a first-pulse poll with a separate exact HP read, assuming the next command returns within 50 ms. |
| F4 — shared magic vectors | **done** | `content/vectors/magic.json`, `scripts/magic-vectors.ts`, `tests/combat.test.ts:159` and `server/internal/rules/magic_vectors_test.go` pin the same Mend/Ward numbers. New shared damage rules will need their own parity net; this is not a failure of the completed heal change. |
| F5 — redundant report barrier | **done** | `src/lib/api/report-pump.ts:141` settles a capture and checks `standing()` before forcing another report; `:166` validates generation, sequence, basis and unchanged live state. Report-count tests cover this. |
| F6 — mount walks off own land | **done** | `src/game/entities/avatar.ts:347`, `led-mount.ts:212` and `homesteads.ts:195` provide the bay walk. `e2e/companions.spec.ts:392` exercises Go home on your land. |
| F7 — wardrobe/purse seams | **done** | Implemented through server-owned reads, explicitly documented at `src/lib/wardrobe.ts:5`. Shared picker use: `src/ui/WardrobeTab.svelte:151`, `CompanionsPicker.svelte:37`. The glims supersession is recorded at `docs/design/purse-and-wardrobe.md:3`. Do not add a second client-owned gold/ownership model. |
| F8 — Link extraction | **partly** | Report pump extracted; record, fence/channel ownership, durable queue, replay and lease/reconnect still share `src/game/link.ts`. It grew from 2,255 to 2,398 lines. Current F8 carries the remaining extraction. |
| F9 — dead exports and stubs | **done** | The named deletions and retired defeat stubs are gone. `tests/dead-exports.test.ts:40` runs in `npm test`; deliberate exceptions are listed at `:19`. It is a word scan, so a passing scan is a useful guard, not proof of complete reachability. |
| F10 — offsets and heal duplication | **done** | `src/lib/companions.ts:17` owns `MOUNT_FEET`; remote players import the avatar's hand offset; `healHero` and the pure pulse helpers share the healing path. |
| F11 — large UI subsystems | **not done** | App 1,352, InventoryPanel 1,510, Hud 1,259, ConnectGuide 1,048 lines, versus 1,335 / 1,430 / 1,255 / 1,026. New Yard/picker boundaries help, but the requested connected-flow and HUD/card extractions remain. See current F9. |
| F12 — slow real-time waits | **partly** | Fishing's 8.5-second recast wait now advances both clocks (`e2e/fishing.spec.ts:111`); the far-ward test observes a near friend's positive pulse; slow specs are reported (`playwright.config.ts:66`). Accepted fishing casts still wait real bite time (`e2e/fishing.spec.ts:76`), and route retries can spend two minutes without progress. |
| F13 — 0.5 coverage gaps | **partly** | Stand/Kindle/Echo relay drawing is covered at `e2e/abilities.spec.ts:140`; the stable spec now checks the no-stable refusal, village dismount and both homeward routes. Fishing band mapping/empty-water behavior has unit coverage. There is still no focused two-player fishing depletion check or client-visible check that ward credit spends only the HP rise needed; the persisted-heal check is weaker than that. |

### Checks and size

`npm ci` ran once. `npm test`: **2,021 passed, zero failed, 39.7 s**. Both TypeScript checks and
`npm run check` passed, with zero Svelte errors/warnings. The unit run overlapped Go/check work, so
its wall time is not a comparable regression measurement against the previous review's ~10 s.

Both requested Go commands ran: root `go test ./...` and the same command from `server/`. Both
failed only `TestChunkTimeHeadroomV3`: p95 **26.867 / 26.286 ms**, over its 25 ms ceiling. They were
running concurrently. An uncontended `go test ./server/internal/wilds -run
'^TestChunkTimeHeadroomV3$' -count=1` passed in **0.342 s**. This is a contention-sensitive budget
result for the server/tooling reviewers, not evidence here of a deterministic generator regression.

Six focused E2E cases ran against the real server, headless Chromium, **E2E_PORT=5393**, two workers.
All passed; **none of the reported CI failures reproduced**. Four cases took **42.7 s** wall time;
paths + drift took **26.0 s**. Individual case times:

| Case | Time |
|---|---:|
| Inventory home goods | 11.1 s |
| Wilds claim persistence | 7.1 s |
| Joint deed | 34.3 s |
| Chop tree | 20.2 s |
| Clear thicket / lay / peer / lift | 23.1 s |
| Frontier drift | 11.0 s |

The commands selected those test names from the six specs; the full suite was **not** run. Local
launch needed `GOFLAGS=-buildvcs=false` for this worktree's Go VCS-stamping failure and terminal
sandbox escalation for Chromium's macOS bootstrap. No computer-use tools or apps were opened.
Listing tests reports **278 tests in 69 files**, versus 248 in 62 previously; this is an inventory,
not a measurement of full-suite wall time.

`WorldScene.ts` is **1,151 lines** (was 1,058); `link.ts` **2,398** (was 2,255). Combat remains
Hero 653, EnemySystem 516, Creatures 216, MoveFx 253 lines. The scene's growth is mostly composition
of the open map's new parts; Link still contains several independent owners of long-lived state.

## 2. Findings (payoff relative to risk)

### F1. Fence Wilds reads to their world/store lifetime; overlapping reads can revive discarded land. M

**Evidence:** `src/game/wilds/store.ts:117` holds a module-global view and one in-flight slot keyed
only by center. `resetWilds()` at `:210` clears those references but invalidates no outstanding
request. `refreshNear()` at `:432` awaits the raw operations API and unconditionally applies its
answer at `:445`, loads bodies, bumps the store and can emit a turning. A different center starts
another concurrent read. `applyNear()` at `:277` treats any differing wick ID as a turning; it
cannot distinguish a newer wick from a late answer naming the older one. These reads bypass the
normal Link read wrapper (`src/lib/api/operations.ts:92`).

The reset is a real runtime boundary: leaving a world calls it (`src/App.svelte:481`), and an
in-place turning calls it (`src/game/scenes/world-turning.ts:162`). The window already checks
`gone`/paint signature before adopting worker output (`src/game/wilds/window.ts:315`); the store
does not have the corresponding guard for its network work.

**Reproduced:** using the actual store with a deferred near response, start `refreshNear`, call
`resetWilds`, then release the old response. The cleared global view is repopulated with
`wick-epoch`. This does not require a browser or an invalid response.

**Change:** capture a world/session and store-generation token for each read. Reset/turning/world
move invalidates that token; check it before every adoption and after body loading, including the
error path so an old failure cannot mark the new view stale. Coalesce by owner plus center, and
order overlapping windows so a late older response cannot replace newer state or reverse a
turning. Preserve useful non-overlapping reads; a single global “last center wins” is insufficient.

**Guards:** delayed near → reset → new-world read → old answer; two overlapping centers answered
backwards; old-wick answer after the new wick; old failure after reset. Extend
`tests/wilds-chunks.test.ts`, where the ordinary merge and turning contracts already live.

### F2. The worker's error fallback repaints from buffers it has already transferred away. S

**Evidence:** `src/game/wilds/paint-worker.ts:72` packs the tiles, saves a closure reading those
arrays at `:78`, then transfers their buffers in `postMessage` at `:79`. `failAll()` at `:36`
calls those closures on worker error. Transfer detaches the sender's arrays; unpacking them at
`src/game/wilds/ground-paint.ts:459` reads no tile data. Constructor failure is safe because it
occurs before transfer; failure after posting is not. A synchronous `postMessage` exception also
rejects without clearing the waiting entry; the caller has only `.then()`
(`src/game/wilds/window.ts:314`).

**Reproduced:** a fake Worker performs a real `structuredClone(..., { transfer })`, then emits
`error`. The saved ground array has byteLength **0**. On a 32×32 water patch, fallback says
`thread: 'main'` but differs from `paintHere` in **3,072 of 4,096 channel bytes**. The existing
packed-paint parity test (`tests/wilds-paint.test.ts:101`) never transfers the buffers.

**Change:** retain an immutable tile snapshot for fallback and transfer a separate copy, or clone
these small input arrays without transferring them. Catch posting errors and settle/remove the
pending job through the same fallback path. Do not reread mutable current ground under the old
paint signature.

**Guards:** constructor failure, failure after transfer, synchronous posting failure and a late
worker reply after fallback. All must settle once and match the normal painter's pixels.

### F3. Extend late-read protection beyond paths: claims, home views and pack views can move backwards. M

**Evidence:** the new path ordering is good: `src/game/wilds/store.ts:319` retains ground, ways and
balances changed after a near request began. However, `:311` deletes/replaces entity states and
personal claims, `:316` replaces lanterns, and `:318` overwrites Echo settlement with no equivalent
ordering. `applyClaim()` at `:483` advances only the material sequence, not the entity/claim's;
`applyLanterns()` and `applyEchoSettled()` at `:497` / `:504` advance neither. Claim application
also receives no originating epoch to check, unlike `applyDiscovery()` at `:635`.

**Reproduced:** apply an available-node near fixture, capture `readMark()`, apply a harvested-node
claim with nine stone, then apply that earlier near snapshot with the captured mark. Stone stays
**9**, but the harvested state disappears and `thingOf` falls back to **available** (`:405`). One
screen now combines a new reward balance with an old actionable resource.

The same adoption pattern exists outside the Wilds: `src/game/homestead.ts:242` blindly replaces
home/materials from a read; `:252` adopts newer action homes without an ordering mark.
`src/game/items.ts:56` allows concurrent loads; both `load()` and action answers (`:85`) assign
`view` through `adopt()` at `:69`. Link compares an optional PlayerState version at
`src/game/link.ts:1753`, but that does not order these domain views.

**Change:** extend the existing sequence pattern to entity/claim, lantern and Echo changes, with
epoch/world checks for answers. Give Home and Items their own adoption ordering and a clearly
defined “fresh read after mutation” path. Coalescing a pending read alone does not make its snapshot
fresh. Keep server outcomes authoritative; these guards prevent an earlier read from undoing them.

**Guards:** near → claim/relight/settle → old near; home/item read → successful action → old read;
two pack reads answered backwards. Assert the whole visible domain state, not just PlayerState's
version or balances. This also makes the UI extractions safer.

### F4. Make E2E target selection and readiness match the open map, then shorten the slow flows. M

**Evidence:** `waitForWilds()` (`e2e/helpers.ts:262`) promises a settled scene and the hero's chunk
in `attached`. It does not promise `ready`, no unfinished builds, or the neighboring target's chunk.
Those are separate observable states (`src/game/wilds/window.ts:449`). Attachment creates a sliced
build: scenery, gathering registration and entity registration are separate jobs
(`src/game/wilds/window-chunk.ts:220`). Scene settlement finishes the initial window, but later
warps/recentering still need the target's build readiness. Several selectors also reimplement older
interaction geometry rather than observing the actual ranked target.

The following are **likely causes from source inspection**, not diagnosed CI traces. The local
passes above do not establish which branch caused each historical failure.

| Reported failure | Likely cause and evidence | Focused fix |
|---|---|---|
| Inventory: wooden stool absent from Home | SQL inserts goods after a live claim (`e2e/inventory.spec.ts:177`). Opening inventory asks Items and Homes independently (`src/ui/InventoryPanel.svelte:88`); its placed goods come from `homes.mine.items` (`:117`). `Homesteads.load()` joins an existing load (`src/game/homestead.ts:200`), including reads started by scene creation (`src/game/entities/homesteads.ts:173`). Joining a pre-seed home read can preserve the old home forever in this panel. Supplies succeeding proves only the separate Items model. Home status becomes ready before `fetchHome` finishes (`homestead.ts:218`). | After seeding, drain the earlier read and explicitly await a fresh home read, asserting the stool in that model before opening the panel; alternatively seed then reload into a fresh page. Guard late adoption as in F3. Polling the missing cell longer cannot repair a stale snapshot with no new fetch. |
| Wilds: claim not kept on revisit | `e2e/wilds.spec.ts:193` signs in directly, chooses the first node from one dump, then uses `warpToEntity` (`:19`), which scores only other claimable entities, ignoring real solidity and creatures. `act()` (`:35`) does not wait for live input or verify the target ID. The sign-in helper's comment promises parked creatures (`:43`) but its body does not park them. After reload `:215` does a one-shot target read; the center being attached does not prove the chosen neighbor is built. | Use a fixed node fixture; wait for its chunk to be whole, park spawned creatures, and require live input plus that node's actual target ID before E. Poll that exact node's committed state before reload and again after reentry. Drop the unrelated total-claims-length assertion for node persistence. |
| Joint deed | `e2e/homestead.spec.ts:297` waits for peer IDs, not peer positions at the table. Deed candidates use the positional roster and reevaluate every two seconds (`src/ui/DeedPanel.svelte:30`). Invites/myGate/member polls at `:304` / `:311` / `:312` use default timeouts, even though neighboring assertions allow 15–20 s. The test combines both signatures, shopping, screenshots and leaving into a 180 s flow. | Wait for the candidate at the table and live input on both pages; poll invitations and adopted home membership with the shared server-answer timeout. Complete the time-limited signing segment promptly. Split the pack-preservation/leave scenario from signing, and close the extra context in `finally`. F3's adoption guards address genuine late-home-read regressions. |
| Chop tree | `e2e/gathering.spec.ts:258` makes one candidate pass on a random world, requiring a canopy that fades. Its strict picker compares all spots, including those unavailable to the held tool (`:88`). It uses `(ty+1)*16` and `hero.y-8` (`:60` / `:84`); real Interactables measures hero feet directly (`src/game/entities/interactables.ts:65`) and gathering points sit at tileBottom+8 (`src/game/entities/gathering.ts:142`). It can exclude every valid tree before the later real-prompt check runs. | Pin a generated fixture with the canopy/tree the test needs. Wait for target-chunk gathering/art registration; use the real registered target to validate candidate standing spots, with the held tool, rather than a second nearest-spot algorithm. Retain the actual refusal/art/wear/regrowth assertions. |
| Paths: fern steals Clear thicket | The newer exclusion already names fern (`e2e/paths.spec.ts:92`) but rejects digging decor only within a 5×5 tile square (`:96`). A fern three rows north is outside that square while its tileBottom+8 prompt anchor is only **32 px** from a tile-center standing point, inside gathering's 36 px reach. Gathering has default rank 0; clearing has rank **−1** (`src/game/wilds/paths.ts:115`), so the fern wins even if the thicket is nearer. | With the spade held, validate that the actual selected target is `wilds:path-clear`; continue searching otherwise. Pin the fixture's thicket/fern geometry. Add a small interaction regression for the three-rows-north fern; expanding an arbitrary square is another copy of the rule. |
| Open map: north-edge walk stalls | `route()` (`e2e/open-map.spec.ts:30`) finds a path through nonsolid tiles; it does not model the hero body's footprint, attached physics or later-spawned creatures. `walkTo()` parks creatures only before each attempt (`:72`), then polls the whole route for 20 s, six times. Dev steering advances only within **3 px** of each waypoint (`src/game/scenes/WorldScene.ts:757`): an unreachable waypoint can hold forever. Also, “not walking” is accepted without checking final position. The drift test can skip on an unsuitable random north edge (`open-map.spec.ts:160`). | Use a pinned reachable north-edge corridor for the drift behavior test. Wait for its physical build and suppress creatures as new chunks attach. Check actual goal arrival; detect no position/waypoint progress quickly and log position, body, waypoint, nearby solids and window/build state. Keep a separate varied-seed walking test, using body-aware routes. Do not spend 120 s retrying the same geometric blockage or silently skip the frontier assertion. |

**Change across the helpers:** distinguish “scene settled”, “target chunk whole” and “input live”;
reuse those named conditions. Share target observation, not six local copies of reach, rank and
tool availability. Keep fixture-seeded behavior checks separate from varied-world exploration;
log the seed/epoch/target whenever exploration fails so the same geometry can be replayed.

**Runtime:** the joint deed is the slowest case measured here, but these six successes do not rank
the full suite. Retain the slow-test report. Advance both clocks *after the server accepts a cast*
for most fishing bite/hold checks (`e2e/fishing.spec.ts:76`), retaining one real-time integration
check. Replace retry loops with progress checks before raising timeouts. For Ward-light's exact
first-pulse value (`e2e/abilities.spec.ts:204`), observe the pulse event/value directly or freeze a
controlled phase; a poll followed by another read is not atomic under renderer stalls.

**Guards:** the six focused cases on pinned fixtures, then repeated runs at the CI worker/GPU
settings; a few deliberately delayed home/near/presence responses. Fixing the fixtures must not
hide the product races in F1/F3. Keep existing multi-player assertions.

### F5. Shadowstep treats an unobstructed vertical dash as a blocked dash. S

**Evidence:** `src/game/entities/hero.ts:437` saves only the starting **x**. After the dash,
`:442` calculates travel from x alone, and `:455` chooses reach **34** for travel versus **22**
otherwise. Up/down travel with unchanged x always takes the shorter strike radius.

**Change:** capture both coordinates and measure actual displacement in two dimensions. Put the
small travel/reach decision in a pure helper so the later server implementation can pin the same
cardinal and collision-shortened behavior. Do not carry this asymmetry into shared hit judging.

**Guards:** equal-distance horizontal and vertical travel give the same reach; a genuinely blocked
dash gives the short reach. An enemy 28 px away distinguishes the two outcomes.

### F6. A camp's fight lifetime is its rendered attachment, not its epoch and respawn cycle. M

**Evidence:** `src/game/wilds/entities.ts:810` spawns once per **entity ID**; `:814` skips an ID
already in `spawnedCamps` even when its near-read cycle advances. `campCleared()` at `:470`
combines that set with absence of locally alive enemies. The set is cleared only when the chunk
detaches (`:342`), which also removes its enemies. Render-window/slack decisions therefore decide
when fights reset. A depletion read changes the camp's art/claimability without reconciling its
existing local creatures.

**Reproduced:** invoke the actual camp-spawn/clear methods with an already-cleared ID and the same
ID now available in cycle 2. **Zero** new enemies spawn; `campCleared` remains **true**. Staying
near the camp permits the next cycle's claim without another local fight.

**Change:** explicitly reconcile local camps by epoch, entity and cycle, including depletion and
cycle advance. Separate that state transition from attaching/detaching sprites. Keep the local
behavior for curated story fights; make generated-camp claim eligibility an explicit source of
fight outcome that shared fights can replace. The server lane will eventually require the real
fight, but this current bug and ownership boundary can be fixed without designing that protocol.

**Guards:** clear → depletion → next cycle while the chunk remains attached; a depletion read from
another player; detach/reenter; wick change reusing an entity ID. Verify creature lifetime as well
as claim labels. Avoid a large stopgap local simulation framework before the server prototype.

### F7. Separate combat input/effects from deciding hits, and observation from paused local play. L, staged

**Evidence:** Hero selects enemies by Phaser positions, rolls crits and calls `damageEnemy`
inside delayed animation callbacks (`src/game/entities/hero.ts:355`, `:452`). EnemySystem mutates
HP/death and emits reward/feedback alongside animation (`src/game/entities/enemies.ts:169`), while
its update reads the local Hero's field and owns contact decisions (`:197`). Creatures' timers,
steering, aim locks and collisions are implemented through Phaser bodies
(`src/game/entities/creatures.ts:65`). MoveFx relays Stand/Kindle/Echo as effects (`moves.ts:186`),
but relayed Ward pulses also change the local session (`:217`); it is not wholly a renderer.

`WorldScene` has a useful composition boundary, including the lazy `XxxDeps` closures. However,
its early return at `src/game/scenes/WorldScene.ts:696` stops EnemySystem, projectiles, the window,
Wilds reconciliation and turning whenever a menu/dialogue/placement holds input. Remote players
already keep updating above that return (`:687`). Shared enemy observation/interpolation must
have the latter lifetime: another player's fight cannot stop being drawn because this player
opened a menu. The persistence-write freeze at `:681` also needs an explicit boundary rather than
accidentally suppressing incoming shared state.

**Change:** first isolate attack/cast intent and immediate effects from target/damage/death
decisions; isolate enemy state/positions from sprite/body presentation. Keep the present local
implementation behind that boundary for curated fights. Partition the scene tick into world
observation/presentation and this player's gated input/local mutation. For WorldScene's new size,
extract open-map assembly/lifetime (`:414`–`:471`, shutdown, reload and update ownership) only if
that reduces the number of independently managed lifetimes; another bag of callbacks is not a win.
Do these as narrow extractions before routing the first shared camp through them.

The server-first rule does **not** mean deleting all client formulas. `CombatField` and pure kit
rules are useful for prediction and drawing. What needs one authority is the durable outcome.
New shared damage tuning currently sits in TS literals (`src/lib/combat.ts:145`) and enemy tuning
inside a Phaser module (`src/game/entities/enemies.ts:71`). Move the numbers needed by both sides
into content/pure rules and extend the shared-vector pattern as each rule is ported; do not create
an untested Go transcription of these values and timing boundaries.

**Guards:** current local combat and ability checks, plus two clients at one camp observing the
same enemy/death while one has a menu open, delayed/jittered snapshots and chunk entry/exit. Keep
the signature effects immediate. Those shared cases belong to the upcoming prototype; this
review specifies the blocking boundaries, not a new wire format, reconciliation algorithm or
lag-compensation design.

### F8. Finish extracting durable outbox ownership from Link before another transport lands. M

**Evidence:** `src/game/link.ts:904` acquires record ownership/fences, `:972` persists state,
`:1091` submits durable operations, `:1162` drives the pump, and `:1172` enforces head-of-line
ordering. Domain methods and lease/reconnect still share the same 2,398-line class. The completed
`ReportPump` demonstrates a testable extraction with an explicit host contract, but report
scheduling and queue lifetime remain coupled in `drain()`.

**Change:** retain Link's public façade and extract record/fence/channel ownership and durable
queue save/replay/expiry as one coherent owner, in small PRs. Keep lease state and snapshot
adoption responsibilities explicit at its boundary. Do not put real-time swings on this durable,
serialized economy queue: it can be paused by a lost purchase answer and is intentionally replayed
after reconnect. Presence already provides the separate live-session transport seam. The shared
fight design session should use that separation rather than growing Link's mutation registry.

**Guards:** `tests/link-durability.test.ts`, `link-failures`, `link-reports`, `link.test.ts` and the
domain rigs. Preserve persist-before-visible behavior, one sender/fence, exact-key replay and
barrier ordering; a mechanical file split that weakens those guarantees is not worth doing.

### F9. Finish the UI splits, starting with the inventory card rather than the whole menu. M

**Evidence:** sizes are above. `src/ui/InventoryPanel.svelte:155` owns selected/hovered card
resolution, tool slots and action/chooser state in the same component as the grid, filtering,
counts, keyboard focus and measurement. App still owns bus wiring (`src/App.svelte:159`) and
connected session entry (`:496`). Hud combines gains, goal/chips, action controls and their layout
(`src/ui/Hud.svelte:137`, desktop action-bar CSS at `:1023`).

**Change:** one component per PR: extract the inventory detail/action card with an explicit
selected-entry/action contract; then Hud's action/touch cluster; then App's connected-play
lifecycle. Keep item/home models outside those components and fix F3's adoption contracts first.
YardPanel already provides the shopping boundary, so the old proposal to pull shopping out of
Inventory is less useful now. These splits can proceed independently after the first shared
camp; they are maintenance work, not prerequisites for friends fighting together.

**Guards:** inventory and touch E2E, keyboard/hover/card focus behavior, camera/inset tests,
onboarding/connect layout. Keep the measured panel/header/inset behavior intact.

## 3. Keep as is

- **Server-owned geometry and validated chunk identity.** Decode checks, generated signed
  coordinates and epoch-keyed chunk caching give shared fights a usable map input. Keep drawing
  based on served chunks; do not add a second client generator.
- **Path/discovery operations tracked by outbox key** (`src/game/wilds/ops.ts:32`) and the existing
  loss/replay/turned-wick tests. Extend their ordering discipline to older domains (F3).
- **The window's paint-signature checks, BuildQueue attachment order and bulk operations.**
  `e2e/window-order.spec.ts:19` verifies actual Phaser display order/pixels for patch and relay
  mid-build; that is stronger than a mocked list-order test. Keep it alongside the pure tests.
- **Lazy `XxxDeps`, scene-scoped DEV hooks and pure node-tested helpers.** `CombatField`, tile
  coordinates, kit data, `PeerTrack`, the report book/pump, wardrobe grouping and path prediction
  are useful seams, not extraction debt merely because the scene wires them together.
- **GridPicker and the new Yard/deed/purse panels.** Reuse these domain boundaries rather than
  creating another general picker or another shopping flow.

## 4. Cross-area notes

### Shared fights: what helps, what blocks, what goes first

The chunk-based room selection and 3×3 nearby presence membership already match the open map.
`PresenceFeed` is node-testable with injected socket/timers, and `src/lib/presence-interp.ts:32`
offers pure interpolation with injected time. Reuse that experience, but its samples are stamped
at receipt and a 300 ms gap inserts a synthetic still pose (`:36`): it is player-pose policy, not
automatically the right timing/state policy for enemy attacks. The current authority/renderer
coupling, camp cycle identity and paused observation described in F6/F7 are the blockers.

**Cleanup first:** store lifetime/order and the deterministic target fixtures, then the small
camp/attack/presentation boundaries. **Prototype next:** the already proposed single camp with
two players, including a phone/latency check. Let that validate the seams before a broader combat
port. Finish the remaining Link/UI extractions incrementally; neither should hold the prototype
hostage. Prioritize seeing and fighting the same creatures, then ownership clarity. The server's
hit/claim decision is part of shared behavior; additional anti-cheat work can wait under the
friends-only model.

Docs need a small accuracy pass before that design session: `docs/design/layers.md:179` says
presence carries only pos/emote, although it now relays abilities, Ward healing, gifts and more.
Its guest-play explanation at `:203` also predates server-first removal of local guests
(`docs/design/server-first.md:9`, `e2e/fixtures.ts:12`).
`src/game/presence-feed.ts:15` says presence touches no gameplay, although the Ward relay drives
healing through MoveFx. Update those ownership descriptions; leave the chosen server-per-chunk,
about-10-Hz direction and the prototype-first plan intact. No transport redesign is justified by
the evidence in this review.

### 0.8 coverage and runtime

Coverage is substantial: signed coordinates and validation; chunk decoding/cache/near merges;
map/planning/paint seam parity; predicted path debits, lost answers, exact-key replay, turned-wick
answers, refusals, removed ways and rumour epoch binding; real Phaser build interruption order;
and E2E walking without scene restart, position reload, neighboring-player visibility, retained
counts after churn, slack, motes, paths and named ways on the Map. Examples:
`tests/wilds-chunks.test.ts:112`, `tests/wilds-ops.test.ts:57`, `:115`, `:150`,
`e2e/open-map.spec.ts:90`, `:176`, `:240`, `:278`, `:308`, `e2e/paths.spec.ts:237`.

The most useful additions are failure/lifetime cases, not more happy-path screenshots: F1's late
reads across reset/turning, F2's real buffer transfer then worker failure, F3's non-path late reads,
F6's camp-cycle change without detachment, and a live turning while path work is pending or the
Map holds input. Some pure op tests cover ended epochs; they do not exercise the whole scene/store/
worker lifetime together. Add those narrow checks with the corresponding fixes.

The walking E2E starts a **2.5 s** frame sample before each potentially much longer route
(`e2e/open-map.spec.ts:111`) and checks only p95 below **120 ms** (`:126`). A late crossing or a
single build hitch can escape that sample/percentile. Keep it as a coarse integration guard, but
sample the actual crossing/build interval and retain maximum gap plus the relevant perf spans for
diagnosis. Do not call it proof of the phone's frame budget. Route-progress fixes in F4 remove
wasted failure time without relaxing performance assertions.

### Calendar/date-bomb check

No fixed-future expiry asserted against real time was found in the reviewed client/tests. The
2026 timestamps in rule fixtures are inputs, not deadlines: e.g. `tests/api-client.test.ts:166`
passes the matching fixed `now` to Retry-After parsing; room/quest tests use fixed clocks;
calendar tests calculate from the configured epoch. Do not “refresh” those dates merely because
they look old.

There **are calendar-boundary flakes and calendar-dependent coverage** worth making deterministic:

- `e2e/gathering.spec.ts:330` seeds a cap for the wall clock's UTC day. A run crossing UTC midnight
  before its chops uses another server day and loses the expected cap refusal. Set a controlled
  server time away from midnight and derive the seeded day from it.
- `e2e/seasons.spec.ts:79` fixes the client's Quiet day but decides whether the server should grant
  or refuse from real `Date.now()` **after** pressing E (`:97`). At a seasonal boundary the branch
  can disagree with the request's server season; most days it also covers only refusal. Use the
  server clock helper and separate deterministic grant/refusal cases, moving both clocks when
  testing a valid season and intentionally diverging them only for refusal.
- `e2e/fishing.spec.ts:57` already searches forward to a requested mark and re-signs in between
  jumps under the 30-day session limit. Keep that protection; replacing it with a fixed Quiet
  timestamp would create a real date bomb. Choose a safe point within the requested mark rather
  than an instant at its end. Outer-Wilds/path fixtures likewise need their wick held steady while
  a test seeds changes (`e2e/paths.spec.ts:304`) or compares epoch ends to real time.

These are recurring clock-boundary risks, not a prediction that the entire suite fails on one
specific future date. Make the affected E2E clocks explicit and add near-midnight/mark-boundary
cases to pure rule tests where appropriate; do not globally freeze performance/wait clocks.

## 5. Proposed order

Each step should be independently reviewable, with the indicated regression rather than a broad
simultaneous rewrite.

1. **F1 + F3's Wilds guards** — generation/world fencing and complete late-read ordering, pinned
   by delayed answers. This protects the new open-map lifetime and the upcoming fight snapshots.
2. **F2, then F5** — repair worker fallback and vertical Shadowstep; both are small reproduced or
   directly demonstrable defects with focused guards.
3. **F4 + F3's Home/Items ordering** — deterministic fixtures, whole-target readiness, real target
   observation, fresh model reads and fast progress diagnostics. Fix the six CI candidates, then
   shorten fishing waits and isolate calendar branches.
4. **F6, then the first parts of F7** — fix camp cycle reconciliation and separate attack intent,
   result authority and drawing/input pause. Validate with the first shared camp before a larger
   port; extend content/vectors as shared rules actually move.
5. **F8, then F9** — remaining Link owner extraction and one UI component at a time. Preserve
   durable queue guarantees; keep these cleanups moving without delaying shared play.
6. **Coverage/docs notes alongside their changes** — especially worker failure, turning with work
   in flight, both seasonal outcomes and accurate presence ownership descriptions.

## Done
