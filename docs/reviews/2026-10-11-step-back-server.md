# Step-back review after 0.8: server, shared rules and tooling

Snapshot: `a5005c3` — 0.8.0, **The open map**. Review only; no implementation changes.

## Map: what changed since 2026-10-09

The server now owns substantially more of the game. 0.6 added the purse's reserve → upstream work → settle lifecycle and a separately verified wardrobe. 0.6.1 consolidated the balances into glims. 0.7 added shops, joint deeds and the Yard's membership and repair rules. 0.8 moved generated land into stored protobuf chunks: generator v3, signed world coordinates, a bounded frontier, near reads, effective ground changes, named ways, discovery and the rumour. Migrations 032–034 carry those additions.

The API has grown from 71 production files / about 15,520 lines to 79 / 18,869, and from 60 test files / about 19,751 lines to 68 / 24,488. The store is 20 production files / 3,024 lines; the Go content loaders are 24 / 3,701; wilds is 20 / 4,777. These are counts excluding generated Go and `_test.go` from production. File size alone is not a defect, but the new lifecycle boundaries matter more than another general cleanup pass.

The strongest changes since the last review are the secret-field guard on keyed operations, the verified upstream/wardrobe boundary, deterministic ward scheduling in tests, and the stored-chunk transaction/cache guards. The new risks are crossing boundaries: visible rooms versus healing eligibility, the epoch viewed by a player versus the epoch charged by an operation, and the lifetime of a live purse worker versus lazy recovery.

### Status of all 18 previous findings

Paths in this document are repository-relative. In the following table, “done” describes the requested change, not a claim that the whole subsystem is finished.

| Previous finding | Status | Evidence and remaining work |
|---|---|---|
| 1. Nix crafts manifest | **partly** | `nix/web.nix:18` includes the crafts manifest. There is still no Nix build in `.github/workflows/ci.yml:16`, and the same omission has recurred for open-map animations; see finding 1 below. |
| 2. Class-mark writers | **done** | Sign-in and world choice write the mark (`server/internal/api/login.go:194`, `world_choice.go:132`); profile reporting preserves the previous class before applying the new profile (`profile_report.go:97–108`). The magic report tests cover the rebirth cases. |
| 3. Moving/riding casts dropped | **done** | `presence_abilities.go:228–254` allows movement-dependent slack; ability admission still requires an accepted position. Cast reach tests cover the movement cases. The chunk-boundary Ward-light defect below is a different predicate. |
| 4. Fishing/seller calendar bombs | **done** | The rig defaults to 2026-01-30 (`test_helpers_test.go:27–43`); fishing chooses an open season (`fishing_test.go:121–139`), and the seller test explicitly moves to Plain (`seasons_test.go:358`). The affected tests also passed with a Quiet-season starting clock during this review. |
| 5. Store wall clocks versus API clock | **done** | The invite/admission/party administrative entry points now take `now`; for example `server/internal/store/parties.go:33,59`. The specific old clock split is fixed. A shared projection timestamp is still missing; see finding 6. |
| 6. Planting login limiter | **done** | `gathering_test.go:145` advances the login window in the home-player retry helper. The unchanged Go suites passed. |
| 7. CI/release gaps | **done** | CI now runs vet, race and the development push filter (`.github/workflows/ci.yml:39,45,49`); cancellation is conditional at `:141`. Release tagging has concurrency and release dispatch (`tag-release.yml:15,20`). The missing Nix check is carried under finding 1. |
| 8. Removed water breaks state | **done** | `fishing.go:195–219` closes orphaned casts rather than failing every state read. Unknown content is logged and cleaned up. |
| 9. Cached secret requests | **done** | `op_idempotency.go:36,53,200` rejects secret-bearing protobuf requests recursively before caching. The secret tests exercise nesting. Top-ups have separate idempotency and do not persist their token. |
| 10. Purse/wardrobe preparation | **partly** | The important boundaries landed: the upstream interface and shared budget, work outside transactions, separately fetched owned gear, reserve/settle, glims transfers, currency constructors (`server/internal/itemmove/itemmove.go:85–99`) and the day helper. Recovery is deliberately lazy (`store/purse.go:205`), rather than the proposed startup sweep. Its overlap with live work remains incorrect; finding 4. The old embers/gold proposal was superseded by glims. |
| 11. Ward pulse amount and commit | **done** | Pulse healing is server-set; credit reservations survive until a successful report commit (`report.go:73–105`). Relay and reservation tests cover it. Adjacent-chunk eligibility still needs fixing; finding 2. |
| 12. Real sleeps/performance gates | **partly** | Ward pulses use an injected scheduler (`presence_abilities.go:323`), removing the long ward sleeps. The strict generator budget is opt-in (`server/internal/wilds/budget_v3_test.go:110`). A new always-on wall-clock headroom test remains at `:133–146`, alongside socket timing tests. Keep correctness deterministic and timing in a measured job; finding 5. |
| 13. Route table/logging | **not done** | Dispatch and labels remain separate; operations/result is missing from the label list and removed progress/sync paths remain (`routes.go:20,78`). `http.go:42–47` still discards unexpected error details. Finding 8. |
| 14. PlayerState composition | **partly** | `api.go:103–106,132` now makes the decorator chain explicit. It still mixes settlement and projection, reads several clocks, and leaves `store/fake_composition.go` in production. Finding 6. |
| 15. Shared vectors/loader gaps | **done** | Ward pulse count derives from content (`presence_abilities.go:45`); magic has shared vectors (`content/vectors/magic.json`, `server/internal/rules/magic_vectors_test.go`). Required ability numbers and fishing area/water IDs are validated (`content/abilities.go:38`, `content/fishing.go:71`). |
| 16. Small correctness nits | **done** | Fishing's held-refusal/closing paths, missing-position ability refusal, mount return paths, and deterministic companion slot ordering are in place; see `fishing.go:195`, `presence_abilities.go:279`, `store/companions.go:117–124`. The bounded ready-row lookup remains an intentional choice. |
| 17. Dead code/hygiene | **done** | The listed LanternRoad port, test-only Verify, nullable/avatar/projection duplicates, dead guards and unused replay argument are removed; `op_idempotency.go:292` has the reduced signature. Caddy is pinned (`compose.yaml:52`); the breaking-check accepted-moves list is empty; `store/migrations.go:16–20` explains why upgrade tests freeze live-code backfills. |
| 18. Open-map epoch seam | **partly** | Chunk/epoch addressing and expired world-change cleanup landed (`store/chunks.go:181–188`), with rollback/race/realm isolation tests. Generated fishing waters and epoch-bound casts did not; fishing still uses curated waters. That belongs before generated fishing ships, not before the first shared camp. |

## Findings

### 1. The Nix web package repeats the missing-asset failure

**Evidence:** `src/game/wilds/open-map-art.ts:18` imports `assets/generated/open-map-pass/animations.json`. The Nix source fileset includes `src`, `public`, `content` and the crafts manifest, but not that JSON (`nix/web.nix:13–19`). Docker does include it (`Dockerfile:18` and the `.dockerignore` exceptions). CI verifies the npm build but never builds the Nix web derivation (`.github/workflows/ci.yml:16–70`).

The normal checkout can build while the filtered Nix source cannot resolve this import. This is a source-fileset finding; I did not run a Nix build.

**Change:** add this exact generated JSON to the fileset and give Nix a CI check. If a full derivation build is too expensive for every push, at least check imported build assets against the filtered source and run the actual derivation on relevant changes. Keep the source whitelist narrow.

**Size/risk:** **S**, low. The previous fix repaired one asset, not the recurring mechanism. Do this before a Nix deployment.

### 2. Ward-light is visible across chunk edges but does not credit that friend

**Evidence:** `presence_socket.go:57–70` defines shared Wilds visibility as the same or any adjacent chunk; `presence.go:226–239` broadcasts with that predicate. `presence_abilities.go:317–323` schedules a stationary ward using the caster's area, while `:352–362` admits a receiver only when `q.area == area`.

A friend two pixels across a chunk edge sees the relayed ward but gets no server healing credit. Moving into the adjacent room while staying inside the ward has the same mismatch. This matters directly to shared play, independently of cheat prevention.

**Reproduced:** a temporary Go overlay probe placed the caster at `(383,-10)` in `wilds:0:-1` and the friend at `(385,-10)` in `wilds:1:-1`, with radius 64. The expected-credit assertion failed: the friend's ward credit was absent.

**Change:** use the shared Wilds visibility predicate plus world and physical radius for receivers; preserve isolation for curated rooms. Test both a friend already across the edge and a friend crossing it between pulses. Keep the reservation/commit behavior already fixed.

**Size/risk:** **S**, low. Fix before extending abilities into shared camps.

### 3. A delayed path operation can spend materials on land the player never saw

**Evidence:** clear/lay/lift requests contain coordinates but no target epoch (`proto/glimway/v1/operations.proto:57–62`). `open_map_paths.go:96–118` resolves those coordinates against the current epoch at execution. Lay then debits the pack and writes the change (`:253–258`). Discovery already carries an epoch (`operations.proto:84`).

The client remembers a job's epoch and guards local completion (`src/game/wilds/paths.ts:365–373`), but sends no epoch (`:395–409`, `src/game/link.ts:1976–1989`). That local guard cannot reject a request already in flight when a turning occurs. `story/story.go:308–341` observes the current epoch; it cannot recover the intended one from this request.

**Reproduced:** a temporary overlay probe read the current wick, prepared a lay request, advanced the rig to just after `NextTurning`, and submitted the old request. It succeeded with the new epoch and reduced stone from two to one. The ordinary turnover test does not cover this delayed-command case (`open_map_test.go:202`).

**Change:** carry the target epoch on these operations and reject an ended/mismatched epoch before debiting or generating a new change. Send the job's captured epoch from the client. Preserve keyed replay: retrying an already committed old operation must return its original result without spending again.

**Guards:** delayed clear/lay/lift across a turning; same-epoch success; material conservation on refusal; replay after a turning.

**Size/risk:** **M**, modest contract/client/server work. This is an existing correctness fix and a useful prerequisite for fight-bound claims.

### 4. A live purse worker can outlast the 90-second stale-row deadline

**Evidence:** the nominal worker limit is 60 seconds and each upstream call has a 10-second limit (`purse.go:78–79,319`). Before scoring, it can perform the balance read, up to two leftover deletions, creation, scoring and a rate-limit retry (`:342–431`). After an unknown score, `checkAfterUnknown` creates a context detached from the worker's cancellation with a deadline at least 35 + 10 seconds after that failure (`:458–472`). Final settlement gets another detached 15 seconds (`:516–519`).

Lazy recovery selects working rows at age 90 seconds (`store/purse.go:30,205–206`) on state reads and new top-ups (`api/purse.go:33–44,132`). A score failing near the worker deadline can therefore still have legitimate balance checks running past age 90. A concurrent state read can finalize it as unconfirmed. A later confirmed worker outcome cannot credit it: `store/purse.go:141–152` only settles an unsettled row, and `api/purse.go:541–544` logs that a look won first.

This is a code-derived timing defect, not a reproduced upstream incident. The comment saying the checks remain “well under” 90 seconds (`purse.go:463`) does not hold for the full call chain. The reserved row can also predate the worker's start.

**Change:** define a coherent lifetime for reservation, live work, guaranteed final checks and settlement. Lazy recovery must only take abandoned work, or start after the actual maximum live lifetime with margin. Keep the guaranteed final balance check: simply cancelling it at 60 seconds weakens recovery of an unknown charge.

**Guards:** a controllable upstream stalls the earlier calls, returns an unknown score late, and confirms the debit on a final check while another state read runs. The live row must not be settled by that read, and the eventual glims credit must occur exactly once. Also exercise a genuinely abandoned row.

**Size/risk:** **M**, focused but worth careful conservation tests. Do before more purse recovery changes; no full purse rewrite is needed.

### 5. Fix fixture readiness and prompt selection instead of adding timeout

Five of the six reported flaky scenarios passed in the focused runs; clearing a thicket reproduced the reported competing fern prompt. Passing once does not clear a CI flake. The following separate proven failures from likely causes visible in the helpers.

**Clear a thicket — reproduced prompt-election defect.** `e2e/paths.spec.ts:74–98` searches a random world and excludes nearby gathering decorations by a small square of tile offsets. That is not the actual interaction geometry: gathering measures a 36-pixel reach to decoration feet (`src/game/entities/gathering.ts:68`), relative to the hero's interaction position. A fern outside that tile square can still win. At `paths.spec.ts:133`, this run expected “Clear the thicket” and received “Dig for seedlings”. Fix the candidate predicate to use the actual geometry and interaction priority, then wait for the exact clear action at the actual standing position. Prefer a seeded fixture with a deliberate thicket and no competing prompt; keep randomized generator/prompt tests separately. **S.**

**Server persistence keeps the claim — likely wrong target or incomplete setup.** `e2e/wilds.spec.ts:19–31` scores a candidate against other claimable entities, omitting sites and the actual position reached after warping. `:35–38` accepts a broad harvest prompt. The persistence case (`:193–216`) does not use the available creature-parking helper (`:53`). A nearby node can produce the same toast while the selected node remains unchanged. Shared nodes persist in `entity_state`, whereas personal chests/POIs use `personal_claims` (`api/wilds.go:395–425`); a personal-claim count is not proof that this node was harvested. Fix the helper to select the exact interaction target, park interference, and await a successful claim response naming that entity plus its persisted state before reload. Keep the reload assertion. **S–M.** Passed here in 7.3 seconds; no persistence loss was reproduced.

**Joint deed — likely roster/position readiness race.** `e2e/homestead.spec.ts:292–303` waits for peer IDs, then acts at the table. Joining resets the peer's position and emits a roster (`presence_socket.go:318–321`); a roster does not prove the server has accepted a table position. Position messages are throttled at `:344–350`, with `lastPos` surviving the join. The deed requires both members near the table (`home_membership.go:77–85`, `presence.go:333–341`), not just in the roster. Wait for the partner's accepted position at the table. Make the first position after a room join reliable, independent of the preceding room's throttle, and test roster-before-first-position. **S–M.** Passed here in 33.2 seconds; the race is a hypothesis supported by the join ordering, not a captured failing deed response.

**Home inventory wooden stool — likely seeded database versus in-flight home read.** `e2e/inventory.spec.ts:179–183` directly inserts decorations after earlier home reads. The seed helpers mutate SQL without publishing a new home view (`e2e/home-helpers.ts:325–335`). Opening the panel loads items and homes (`InventoryPanel.svelte:88–95`), but `homes.load` reuses a pending request (`src/game/homestead.ts:200–205`) and then fetches the home (`:210–222`). A pre-seed response can become the view used by `InventoryPanel.svelte:114–124`. The server does query placed and carried goods (`home_queries.go:96,118`); there is no evidence that those queries discard stools. Drain outstanding fixture reads, seed, then await a fresh home response containing both instance IDs before asserting the panel. Version/event invalidation should be explicit in any shared SQL seeding helper; it alone does not replace the fresh home-read barrier. **S.** Passed here in 10.0 seconds; the stale-read explanation needs confirmation in a failing trace.

**Chopping a tree — likely candidate/prompt readiness drift.** `e2e/gathering.spec.ts:53–98` approximates prompt election around a random tree; it does not cover every open-map interactable. `promptOn` retries six times for short frame windows (`:157–166`). The chosen tree/candidate list can become stale while chunks and their interactables attach. The server accepts the exact stored decoration within 48 pixels (`api/gathering.go:80–94,146–176`), wider than the client's 36-pixel gathering reach, so there is no evidence of a server reach limit causing the stall. Use a seeded tree fixture, await settled chunk construction and the actual chop prompt, park creatures, and observe the exact tile/tool response rather than only a toast. The recent chunk-build ordering fix helps but does not turn an approximate candidate into a guaranteed action. **S–M.** Passed here in 15.2 seconds.

**Drift at the north frontier — likely navigation fixture, not frontier rejection.** `e2e/open-map.spec.ts:30–60` plans a route using tile-centre solidity, then `:70–87` can replan six times with 20-second walks. The actual hero has a finite physics body and can stop against seams or newly attached collision, even when a point-based tile route exists. The random-world test (`:150–160`) relies on this exploratory walk to reach a particular edge. Generator dry reach (`wilds/detail_v3.go:158–188`) guarantees tile reachability, not that every such waypoint sequence fits the client body. Use a seeded, known walkable approach to the north boundary; await chunk/collision readiness and derive the boundary from the frontier response. Record the last waypoint, actual position and collision state on a stall. Assert arrival separately from “dev walking stopped.” Keep random connectivity in generator tests. **S–M.** Passed here in 8.2 seconds; the frontier package passed with 100% statement coverage.

**Runtime and dates:** the six focused tests took 58.7 + 36.2 = **94.9 seconds**, including setup, with one failure. Individual passing times were 7.3–33.2 seconds. A failed walking helper can spend 120 seconds before the next assertion; the specs allow 150–240 seconds, and CI retries can multiply that. Higher timeouts would conceal readiness errors. Do not remove reload/two-client behavior to get speed: replace exploratory setup with fixtures and wait for the actual server/readiness condition. The full suite was not run, so this review does not estimate its current duration from six tests.

The old permanent calendar failures are repaired. I found no replacement date bomb in the inspected server tests. E2E still uses the current world/season and can cross a turning or day boundary mid-setup; that is intermittent calendar dependence rather than “fails from date X”. Pin fixture time/seed where appropriate, and keep explicit before/after-turning tests. Run a small seasonal matrix on the affected tests rather than pinning every test so that calendar coverage disappears.

The strict generator timing test is correctly opt-in, but `wilds/budget_v3_test.go:133–146` puts a looser wall-clock assertion back in every ordinary run. Its tolerance is much better than the old strict assertion, yet concurrent CI load is still not a correctness property. Move both timing thresholds into a measured performance job; retain deterministic size/connectivity invariants in unit tests. **Overall size: M**, low risk, six focused fixes rather than a harness rewrite.

### 6. PlayerState projection still performs maintenance and reads several clocks

**Evidence:** `api.go:103–106,132` builds fishing, purse, wardrobe and rumour decorators around `StateComposition`. The interface takes no timestamp (`store/composition.go:17`). Purse settles stale reservations and changes the version before calling the base projection (`purse.go:33–44`). Fishing reads its own clock and lapses casts (`fishing.go:644–655`); rumour reads another clock and obtains the current wick (`open_map.go:494–500`). The operation itself has already sampled time (`op.go:55`), and chunk validity has its own clock checks (`store/chunks.go:219–230`).

This makes “compose an answer” a surprising write boundary. Around a turning or midnight, one response can combine an operation evaluated on one side with decorators evaluated on the other. It also makes it too easy to reuse a heavyweight, mutating projection inside a future room tick. `store/fake_composition.go` remains a production test double.

**Change:** pass one operation/read timestamp through the projection chain. Make maintenance explicit before a pure projection: settle/lapse, refresh the snapshot/version, then project. Keep the decorator list if it is the simplest organization; a monolithic store projection is not required. Move the fake behind test support when changing this seam.

**Guards:** a clock that advances on each read at a turning, fishing lapse plus purse settlement in one state response, and existing version/replay tests. Ensure a settled version and the projected contents agree.

**Size/risk:** **M**, staged by decorator, moderate because held refusals and version semantics matter. Establish this boundary before reusing server state machinery for shared fights; it need not block an isolated camp prototype.

### 7. Changed-test selection does not select the 0.8 tests for 0.8 server changes

**Evidence:** `e2e/changed-map.json:15` ignores all `content/**`, including JSON rules and Go loaders. The Wilds mapping at `:32–34` does not include the new chunks/frontier/wildsgen/worldchange packages. Broad API/store globs (`:156–166`) select connected, onboarding and polish, not paths or open-map coverage.

**Reproduced:** listing changed tests for `server/internal/api/open_map_paths.go`, `server/internal/chunks/effective.go`, `server/internal/store/chunks.go`, `server/internal/wildsgen/wildsgen.go` and `content/wilds.json` selected the generic connected specs; chunks/wildsgen were unmapped and received smoke fallback, and content was ignored. It did not select the relevant paths/open-map/rumour scenarios.

**Change:** add domain mappings for open-map API, chunk storage/effective maps, generator/frontier/world changes and relevant content. Remove the blanket content ignore; distinguish non-runtime fixtures if needed. Add small selector tests asserting the output for these representative paths. Keep a cheap fallback, but do not let it substitute for known domain coverage.

**Size/risk:** **S**, low, high payoff for an agent-heavy repository. Do alongside the flaky fixture fixes so selected coverage is both relevant and dependable.

### 8. Routes and diagnostics still have two sources of truth

**Evidence:** `routes.go:20` contains the independent label list, including removed `/api/progress` and `/api/sync`; dispatch starts at `:78`. `/api/operations/result` remains unlabelled. Stable labels are overwritten by the prefix at `:31`; all Wilds reads and mutations share `/api/wilds/:action` at `:40`. The access log has only status/error class (`:59`), while `http.go:42–47` replaces an unexpected error with `internal` and loses its diagnostic.

This is harder to tolerate now that a Wilds request might read 25 chunks, generate land, flood a named way, or settle a claim. Distinguishing those operations is useful before measuring a shared camp's load.

**Change:** one fixed route-metadata source for handler and label, including explicit Wilds action labels and operation-result lookup. Record trusted, sanitized unexpected server errors on the server side; keep credentials, request bodies and headers out. Preserve response codes and the credential-log tests.

**Size/risk:** **S–M**, low if routing behavior stays unchanged. The original review's fix remains worthwhile; do it before adding another collection of room endpoints/messages.

### 9. Split the boundaries shared fights will actually reuse; update their description

**Evidence:** `open_map_paths.go` combines transactional operations, chunk acquisition, effective-map adapters and pure graph search; `wayPath` begins at `:537`. `wilds/detail_v3.go` is about 1,157 lines of generation stages. `purse.go` and `store/purse.go` combine reservation/recovery, upstream work, projection and wardrobe-related data. The frontier's rectangular policy also appears in generation (`wilds/world_v3.go:122–145`) as well as `frontier/frontier.go`, while most frontier callers currently assume one fixed policy.

Do not split these into many small files solely to reduce counts. The reusable boundaries are effective collision, pure path search, room identity, reward settlement and pure projection. Extract those as they acquire a second consumer, with existing tests following the behavior. Keep generator stages named and locally understandable; a generator rewrite would add risk without making one shared camp easier.

The design prose is already behind the code: `docs/design/layers.md:179` says presence carries only pos/emote, although pose and abilities are implemented. Its server/client comparison and guest references at `:189–204` need reconciling with today's modes. The chosen scope is generated places, with curated story fights local (`:201–208`); retain that explicit distinction when cleaning up the earlier “all enemies” sentence. `docs/testing.md` also names a `vectors:wilds` command absent from `package.json`. Document the actual test commands and measured runtime limits, not historical figures as promises.

**Change/size:** **S** for the stale prose/commands; **M**, staged and only where reused, for the named boundaries. Low payoff for a general reorganization, high payoff for removing a specific second implementation. Keep this behind the correctness and fixture work.

## Seams for shared fights

I read “Fighting together” in `docs/design/layers.md:176` and “Shared fights” in `docs/design/plan.md:245`. The server-simulated chunk, interpolated client and server-judged swings are the agreed direction. This section identifies existing seams and prerequisites; it does not propose the simulation or wire design.

**What helps:**

- Stored, deterministic v3 chunks and the `chunks` source port give the server geometry without porting a second map. `chunks.Effective` already overlays shared ground changes. The generator fake and rollback/cache tests are useful foundations for deterministic room tests.
- Epoch/world/layer/chunk keys exist in storage and world changes. Unique claim/state writes and keyed operation replay already provide once-only settlement. Keep those guarantees when adding a fight-completion precondition.
- Presence has lease/world authentication, scoped visibility, bounded outbound queues, and movement/ability admission. Its mutex does not need to become a database or network lock. The existing socket is a reasonable prototype transport under the stated friends model.
- Content-driven magic rules, shared vectors, server-derived kit and ward-credit reservations provide tested pieces. There is no need to begin with a general anti-cheat framework or a transport replacement.

**What needs a clean boundary first:**

- **Visibility is not simulation ownership.** `sharedRoom` intentionally fans out to the surrounding 3×3 Wilds chunks (`presence_socket.go:57–70`). A room's label contains chunk coordinates but no epoch/layer identity. Define and test the internal identity/lifecycle boundary before tying a loop to that visibility helper; otherwise neighboring visible rooms or ended land can become the wrong owner. Fix the existing Ward-light mismatch in finding 2 first.
- **Reward settlement needs a completion seam.** `wilds.go:405–414` currently accepts a camp claim and changes it to cleared with rewards, without a fight record. Separate the “eligible to finish” decision from once-only reward settlement so the future fight result can supply that decision. This is an architecture prerequisite, not an urgent accusation of cheating in a friends-only game. **M**, preserving current claims until the shared-fight feature supplies its predicate.
- **A tick must not inherit transactional request work.** The store has one connection and immediate transactions (`store.go:46,51`); cold near/path work generates chunks inside transactions. PlayerState also performs maintenance (finding 6). Keep the room's update boundary independent of request projection and chunk creation, and load effective geometry at an explicit lifecycle boundary. Measure the cold path separately from the warm near benchmark before judging capacity.
- **There are already two combat accounting paths.** Socket ability cooldowns/ward credit and report-time vitals bounding serve different purposes. A future server swing must have a clear owner for cooldown/mana/rewards, rather than being charged again by both. Name this authority seam in the design; retain the existing friends-model decisions for client-observed hurt. Likewise, clarify whether private gathering changes affect the shared collision view; `chunks.Effective` currently represents shared ground changes.
- **Protocol limits need measurement, not premature replacement.** The current presence contract has no enemy snapshots/ticks/swings. Its inbound message limit and outbound queue are bounded; batching claims in the design should be checked against the actual direction-specific limits. Preserve protobuf compatibility and measure one camp before broadening the transport or increasing limits.

The cleanup order is adjacent-chunk ward behavior and epoch-bound operations, then the claim settlement/room identity/projection seams needed by the prototype. Large file splits, generated fishing and stricter abuse prevention can follow their actual feature needs.

## Keep as is

- **Reserve → upstream → settle for top-ups.** Do not put Habitica calls back inside keyed transactions. The narrow upstream interface, token handling, no-repeat unknown score and conservation tests are good. Repair the recovery deadline, not the whole design.
- **One glims balance and typed ledger helpers.** Migration 033, the transfer path and the wardrobe's verified owned table remove the previous two-currency drift. Preserve separate fetched proof data from browser profile reports.
- **Stored chunk blobs and transaction-aware cache validation.** `store/chunks_test.go:241,330,404` covers competing creation, rolled-back generation and other-realm changes. A cached blob must still exist in the caller's transaction; do not “optimize” that check away.
- **Generator v3 only.** The removed v2 implementation and the generator/source seam reduce duplication. Keep signed-coordinate, seam, connectivity and size fixtures. Mirror rules through shared vectors where the client truly needs a copy.
- **Keyed operation semantics.** Savepoint refusals, held refusals, replay and after-commit presence effects are useful foundations. The phantom-chunk refusal test (`open_map_test.go:586`) is especially valuable for generated operations.
- **Curated versus generated combat scope.** Do not pull the Warden/story fights into the camp prototype incidentally. The current design distinguishes them; the implementation and tests should keep that boundary visible.
- **Upgrade tests as the backfill freeze.** Migration hashes cannot freeze live content/rules behavior. The new comment tells the truth; retain the old-database upgrade tests when changing those dependencies.
- **A bounded frontier and warm near budget.** The measured warm near p95 was 7.465 ms against the 20 ms test budget. There is no evidence here for adding general caches or changing SQLite merely to prepare for a handful of friends.

## Proposed order

1. **Before the next Nix deployment:** fix the asset fileset and add the recurrence check (1).
2. **Existing behavior:** fix cross-chunk Ward-light (2), bind path commands to epochs (3), and align live purse/recovery lifetimes (4), with their focused regression tests.
3. **Dependable feedback:** fix the six fixture/readiness paths (5), starting with the reproduced thicket prompt, and repair changed-test selection (7). Move timing thresholds to a performance job. These are small parallel implementation lanes, not a reason to rerun the full e2e suite repeatedly during review.
4. **Before the shared camp uses these paths:** establish claim completion versus reward settlement and room identity; thread a shared timestamp through maintenance/projection (6). Add route/error diagnostics (8) for the measurements. Keep the prototype scoped as already described in the design.
5. **As features require them:** extract reused geometry/path/projection boundaries and refresh stale prose (9); add epoch-bound waters before generated fishing. Avoid a broad generator/purse rewrite.

## Verification

Only the review document is an authored repository change. `npm ci` ran once. No source files were edited, no commit was made, and no checkout/reset/stash was used. Everything ran through this terminal; no computer use or app UI was used.

**Unmodified suites and checks:**

- Root `go test -count=1 ./...`: passed. API 38.425 s, store 15.100 s, wilds 77.707 s.
- From `server`, `go test -count=1 ./...`: passed. API 38.841 s, store 15.305 s, wilds 77.642 s. These two runs overlapped, so their package wall times include contention.
- `npm test`: **2,021 passed**, about 34.7 s.
- `go vet ./...` and `node_modules/.bin/buf lint`: passed.
- Targeted API race run for the v3/ward-credit/named-way tests: passed, 13.105 s. This was not a full review-time race run.
- Fishing/seller tests with `GLIMWAY_RIG_START=1795132800` (2026-11-20, Quiet): passed, 0.297 s. The helpers choose their required season rather than depending on that start.
- `GLIMWAY_PERF=1` near budget: passed, p95 **7.465 ms**, median **5.712 ms**. The fixture pre-generates 81 chunks with 40 ground changes each (`open_map_test.go:512–559`); this measures a warm read, not cold generation, concurrent clients or SQLite contention.

**Focused e2e, port 5392, one worker, no full suite:**

| Scenario | Result | Test time |
|---|---|---:|
| Joint deed | passed | 33.2 s |
| Clear a thicket | **failed**, fern gathering prompt won | 14.1 s |
| Claim persists after reload | passed | 7.3 s |
| Chopping a tree | passed | 15.2 s |
| Inventory/Home goods | passed | 10.0 s |
| Drift at frontier | passed | 8.2 s |

The first three ran in 58.7 s, the second three in 36.2 s. Initial attempts could not get through setup: Go VCS stamping hit the shared worktree's git-lfs metadata permissions; sandboxed headless Chromium then hit macOS IPC restrictions. The actual runs used `GOFLAGS=-buildvcs=false` and approved terminal execution outside that sandbox for headless Playwright. Neither setup failure is counted as a game-test failure. A general `git status` also hit the git-lfs metadata restriction; scoped diffs were usable.

**0.8 coverage:** a separate `-coverprofile` run passed for the reviewed packages:

| Package | Statement coverage |
|---|---:|
| api | 84.0% |
| chunks | 81.9% |
| frontier | 100.0% |
| store | 52.8% |
| wilds | 95.7% |
| wildsgen | 36.4% |
| worldchange | 95.0% |
| content | 89.2% |

The new API files are not merely happy-path smoke: `open_map.go` is about 83.2% covered and `open_map_paths.go` 85.8%; store chunk code is about 85.4%, and effective-map code 74.4%. Tests cover negative coordinates/frontier validation, clear/lay/lift refusals and replay, turnover, ways, discovery/rumour, real v3 integration, rolled-back generation and retained-neighbor seams. Own-package coverage understates some adapter execution through API integration, so wildsgen's 36.4% should not be read as the entire generator being untested.

The important missing cases exposed by this review are semantic: a captured path request delivered after turnover, and ability eligibility across adjacent visible rooms. Add those guards rather than chasing a percentage. For shared fights, future coverage will need room lifecycle/epoch isolation and once-only completion, but those features do not exist yet. Cold/concurrent near reads and total CI/e2e runtime remain unmeasured here. The wilds coverage run took 54.8 s; generator correctness sweeps, not the old ward sleeps, now account for substantial Go test time.

**Reproduction probes:** two temporary Go tests were supplied through `go test -overlay` from `/tmp`, leaving repository sources untouched. They intentionally asserted the desired behavior and both failed: cross-chunk ward credit was missing; a late lay used the new wick and spent stone. These failures are separate from the passing unmodified suites. The changed-test selector was also exercised in listing mode and showed the missing domain selection described in finding 7. No Nix derivation, full e2e suite or full review-time race suite was run.

## Done
