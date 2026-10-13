# Step-back review after 0.9: tests, tooling, CI and docs

Snapshot: `268c9b4` — the step-back round after 0.9 (shared server-run camp fights, presence v3
frames, the sharded fight scheduler, the opt-in tick flush). Review only: no source files changed.
This is the tests/tooling/CI/docs lane; the server and game lanes are the other two reviews. It
follows `2026-10-11-step-back-server.md` and `2026-10-11-step-back-game.md` at `a5005c3`.

No P1 in this lane. The one player-facing defect the window produced — the phone hero standing
under the belt at village (40,24) (`e2e/camera.spec.ts:70`, four runs red, both attempts each time)
— was a real layout bug and is fixed (`c4a7195`, "Keep the phone hero clear of the belt in
portrait"). It first went red on the empty-hands belt change (`88cba9f`), which is likely its
cause; the follow-up commit fixed the clearance.
Everything below is test dependability, CI observability or documentation.

## Map: what changed since 2026-10-11

**The previous round's fixture work mostly landed.** `b439eac` named readiness (chunk whole,
window whole, input live), gave e2e the game's own target choice (`__fsTarget`, `Interactables.pick`),
added stall diagnostics, and fixed the six flaky specs on pinned seeds. `909401c` added `wickSlack`
and `calendarOnServer` so wick-land fixtures hold a day before a turning. `3f4c051` made the
inventory smoke test take the fresh home read. `4e28526` made world playtest positions and resident
timing explicit. `f32964d` holds a day of the wick for the rumour and Whitequiet-reload specs.

**The 0.9 lanes added a second generation of race-prone specs, then fixed them late.**
`fights-shared.spec.ts` (a CI-only two-client gate), `fights-server.spec.ts`, `window-order.spec.ts`
and `review5-fixes.spec.ts` are new, along with unit tests (`fight-feed`, `fight-interp`,
`fight-rules`, `fight-strike`, `fights-content`, `fights-wire`, `camp-fights`, `dev-fight-fall`,
`enemy-owner`) and server-side `presence_flush_test.go` / `presence_flush_regression_test.go`.
`5e12968` settled the hero before the Whitequiet reload check and `b880aa3` ("Make the shared-fight,
Whitequiet, lantern and Yard specs race-free") repaired the worst of the new races after dev CI
showed them. The suite inventory is now **286 tests in 72 files** (278 in 69 at the last review).

**Tooling grew around the fights.** `scripts/fight-load.sh` drives `TestFightBotLoad`; `perf/fights.perf.ts`
measures server-enemy observation beside `perf/walk.perf.ts`; `?perf=1` gained a fights section and
`lag`/`jitter` injectors; `presence` went to protocol v3 with coalesced frames (`36f06bf`) and an
opt-in tick-aligned flush (`-presence-flush-ms`, `GLIMWAY_PRESENCE_FLUSH_MS`, `a7f4f00`, `7e7c91c`).
Changed-test selection gained rules for the open map (`6b9e5f0`) and purse/fishing/abilities
(`24b0d97`). CI itself is unchanged in shape: `verify` (~12.8 min), `e2e smoke` (~3.5 min on
GitHub's software renderer), `e2e full` (~17.5 min on the self-hosted GPU runner), and the
manual-dispatch `generator-performance` job.

### Status of the previous round's findings in this lane

| Previous finding | Status | Evidence at this snapshot |
|---|---|---|
| Server 5 — fixture readiness and prompt selection | **mostly done** | Named readiness, pinned seeds, `wickSlack`, `targetAt`/`standFor`/`pressOn` and `diagnose` are in `e2e/helpers.ts`. The remaining offenders are new or untouched: the Silas helper (finding 2), `paths.spec.ts:260` (finding 5), `open-map.spec.ts` snapshots (finding 6). |
| Server 7 — changed-test selection | **partly** | The open-map, purse, fishing and ability mappings landed, and `tests/e2e-changed.test.ts` pins them. The whole 0.9 fights domain is unmapped; see finding 1. |
| Server 12 — timing thresholds in a measured job | **partly** | The Go generator budgets are opt-in and run in `generator-performance` (`.github/workflows/ci.yml:231`). `e2e/first-paint.spec.ts:84` still asserts a 400 ms long-task budget in every full run; see finding 7. |
| Server 9 / game F12 — stale prose, slow waits | **partly** | `docs/testing.md` is now accurate about commands and tiers (its `vectors:wilds` ghost is gone). `docs/scaling.md`, `docs/design/layers.md` and `docs/server-behavior.md` are behind the 0.9 code; see findings 13–14. |
| Game F3 — one-shot assertions after actions | **not done in the new specs** | Polls replaced most original races, but the specs written for 0.9 reintroduced one-shot snapshots: `inventory.spec.ts:128`, `open-map.spec.ts:405`, `review-fixes.spec.ts:126`, `fights-shared.spec.ts:110`. |

## CI history, 2026-10-11 22:31 → 2026-10-13 07:10 (35 full runs, 36 smoke runs)

Read from `gh run view <id> --log` summaries for every run in the window (`failed` and `flaky`
blocks; a "flaky" entry is a test that failed and passed on the one CI retry, `retries: 1` at
`playwright.config.ts:63`). **67 adverse events: 16 hard failures and 51 retry passes**, spread
over 30 of the 35 full-suite runs and 5 of the 36 smoke runs; 12 full runs and 2 smoke runs went red.

| Spec:line | hard / retry | Failure modes seen | Likely cause in the spec |
|---|---:|---|---|
| `e2e/onboarding.spec.ts:93` | 0 / 7 | "Remembered on this device." still visible after *Disconnect and forget* (`:133`) | One-shot `toBeHidden()` on the Menu line with Playwright's default 5 s expect budget, right after a click whose store clear and Menu re-render land on later frames under load. Not reproduced here. |
| `e2e/paths.spec.ts:260` | 2 / 7 | strict-mode `[data-label="way"]` resolved to 2–3 elements; the same locator found 0; "the lift landed" / "the lay landed" | The map's way labels are a culled, zoom-dependent label layer (`:366`), so `toContainText` on a bare `[data-label="way"]` is strict-mode racy in both directions. `landed()` (`:63–67`) allows 15 s for a queued path operation. |
| `e2e/inventory.spec.ts:119` | 0 / 6 | "Tab 4/9/14/19 stays in the bag" at a random iteration | 60 one-shot `document.activeElement` reads (`:124,128,132`); one frame where a late read or toast re-renders the bag blurs focus to `<body>`. |
| `e2e/camera.spec.ts:70` | 4 / 0 | hero under `button.bslot` at village (40,24), identical coordinates | Real product bug: identical on both attempts, absent on branches without the empty-hands belt; fixed in `c4a7195`. |
| `e2e/open-map.spec.ts:160` | 1 / 4 | reload lands >17 px off in y (`:225`); once "no way to {"maxTy":-3}" | The walk runs on a fresh varied seed (the spec says so at `:179`), and the reload check samples without the settle barrier `5e12968` added to `wilds-outer.spec.ts:139`. |
| `e2e/homestead.spec.ts:276` `:300` `:456`, `e2e/village.spec.ts:108`, `e2e/review-fixes.spec.ts:30` | 1 / 7 | "Silas is neither by the sawhorse nor at his counter"; `> 203` `.prompt` lacks "Talk to Silas" | All five call `bySilas` (`e2e/home-helpers.ts:195–203`); see finding 2. |
| `e2e/wilds-screens.spec.ts:141/142` | 0 / 4 | `.prompt` has no /lantern/i after the fall | The lantern prompt is elected after the chunk is whole and the hero stands at the lantern; the old check sampled earlier. Addressed in `b880aa3`; see finding 8 for its documentation. |
| `e2e/wilds-outer.spec.ts:139` | 2 / 2 | reload position >17 px (`:160–161`); "a toast saying /turned since you were last here/" | Mid-arrival capture while the server held an older position, and a turning landing mid-test. Fixed in `5e12968` + `b880aa3`; no events after them. |
| `e2e/fights-shared.spec.ts:17` | 2 / 0 | duplicate enemy ids (`:71`, now `:110`); "both screens draw the same wisp wind-up"; "the target is wilds:camp:0:-1:0: not met within 3 s of game time" | The wind-up was sampled once a second and missed the telegraph (fixed in `b880aa3`); the duplicate-id check is still two separate reads (finding 1); the target wait is 3 s of game time against a live two-client fight. |
| `e2e/first-paint.spec.ts:66` (assert at `:84`) | 1 / 2 | longest long task ≥ 400 ms | Wall-clock budget on a runner where 4 workers share 12 CPUs at `cpu-shares: 256`; finding 7. |
| `e2e/playtest1.spec.ts:265` | 0 / 1 | reading-chair seating mismatch | One-shot `expect(s.seat…)` after `frames(page, 10)` (`:281`); the seat snapshot can precede the sit animation's end. Not reproduced here. |
| `e2e/village.spec.ts:62`, `e2e/connected.spec.ts:172` | 0 / 2 | `apiRequestContext.get: read ECONNRESET` | The per-worker Go server's keep-alive connection reset under load; finding 10. |
| `e2e/open-map.spec.ts:370` `:403` `:471` | 1 / 3 | "after four trips" (`:405`); "south of the edge" (`:412`); "nothing in the Wilds tweens with motion reduced" (`:479`) | One-shot scene snapshots against in-flight window work; finding 6. |
| `e2e/review-fixes.spec.ts:100` | 0 / 1 | `after.gateDraws - loaded.gateDraws ≤ 4` (`:126`) | A redraw-count budget sampled once; an extra async redraw under load exceeds it. |
| `e2e/paths.spec.ts:119` | 0 / 1 | `stepTo` tile rounding (`:59`) | Dev walk arrives within a tile but not on the exact expected tile. |
| `e2e/inventory.spec.ts:170/183` (smoke) | 1 / 3 | `locator.click: Test timeout of 120000ms exceeded` | The runner, not the test: the spec itself records 52/66/90 s on dev and 16 s on the GPU runner, and `:189` now sets 240 s in CI. The stale-read race it once had was fixed in `3f4c051`. |
| `e2e/rumour.spec.ts:37` | 1 / 0 | Elara's sentence missing from `said` (`:60`) | One occurrence on `exp/c08-client`, which predates `f32964d`'s wick slack; no recurrence after it. |

Everything else in the window passed first time. `38323703609` is worth separating: its e2e jobs
were green and the run is red on a Go unit flake (`server/internal/api/homes2_test.go:623`,
"land fixture: one lit tree"); see finding 9.

## Findings

### 1. Changed-test selection does not know the fights domain (P2)

**Evidence:** `e2e/changed-map.json` has no rule whose `specs` include `fights-shared.spec.ts` or
`fights-server.spec.ts`, and no `paths` for `server/internal/fights/**`, the fight messages under
`server/internal/api/`, `src/lib/fight-*.ts` or `content/enemies.json`. Exercised in listing mode
(`E2E_CHANGED=… npm run test:changed -- --list`, no tests run):

- `server/internal/fights/rooms.go` → "not in e2e/changed-map.json (adds the smoke tier)" → smoke;
- `server/internal/api/presence_fights.go` → `connected.spec.ts`, `connected-screens.spec.ts`,
  `onboarding.spec.ts`, `polish.spec.ts` (a broad API glob);
- `src/game/entities/enemies.ts` → `combat.spec.ts`, `quest.spec.ts`, `naming-screens.spec.ts`,
  `coop.spec.ts`;
- `content/enemies.json` → smoke;
- `e2e/fights-shared.spec.ts` → itself.

So a change to the server fight sim or the shared fight rules selects exactly none of the two specs
written to gate them. This is the same defect as the last review's finding 7, in the newest domain.

**Change:** add a fights rule mapping `server/internal/fights/**`, the fight/presence-fight API
files, `src/lib/fight-*.ts`, `src/game/**/fight*`, `content/enemies.json`, `content/combat*` and the
fight content to `fights-shared.spec.ts` and `fights-server.spec.ts` (keep `fights-shared` out of the
smoke tier: it is a two-browser gate). Extend `tests/e2e-changed.test.ts` (34 lines today) with
these representative paths so the next domain cannot arrive unmapped. While in the spec, fix the
non-atomic sample at `e2e/fights-shared.spec.ts:110`: `expect(new Set((await enemies(...)).map(e => e.id)).size)
.toBe((await enemies(...)).length)` reads the live fight twice, so a wisp dying between the two awaits
fails a check of the spec's own making. Take one read and derive both numbers from it.

**Size/risk:** **S**, low.

### 2. `bySilas` chases a schedule-driven NPC with three-second polls (P2)

**Evidence:** `e2e/home-helpers.ts:195–203`. `silasPresent` reads `__fsNpcs()` and is `false` while
Silas walks between the sawhorse and his counter. The helper goes to one spot, polls `present` for
3 s (`:198`), falls back to the other, polls 3 s more (`:201`), then asserts `.prompt` contains
"Talk to Silas" once (`:203`). Across the window this cluster produced **10 events** (1 hard
failure, 9 retry passes) in five different tests: `homestead.spec.ts:276/:300/:456`,
`village.spec.ts:108`, `review-fixes.spec.ts:30`. Both failure modes appear: "Silas is neither by
the sawhorse nor at his counter" and `element(s) not found` for `.prompt`.

**Interleaving:** the two `go()` calls plus two polls take several seconds on a loaded worker;
if his hour turns during them he is walking when both samples land, and if the hero arrives while
the prompt election is still settling, `:203`'s one assertion sees no `.prompt` at all.

**Change:** drive the wait from his schedule instead of racing it — poll `silasPresent` with one
budget across both spots (15 s), and pin his hour as `village.spec.ts:39` and
`connected.spec.ts:172` already do (`setHour`), so the test knows where he is. Assert the prompt
with `expect.poll` and a message naming the hero's tile and his `present` state. Keep the refusal
to talk to "whichever Silas answers".

**Size/risk:** **S**, one helper; every caller benefits.

### 3. The remember/forget test asserts a hidden line with the default expect budget (P2)

**Evidence:** `e2e/onboarding.spec.ts:93` — after `page.getByRole('button', { name: 'Disconnect and
forget' }).click()`, `:133` runs `await expect(page.getByText('Remembered on this device.')).toBeHidden()`
(the second one, after the reload, at `:150`). Seven retry passes in the window — tied with
`paths.spec.ts:260` for the most of any spec; the failing line is always `:133`, never `:150`. `expect` has no explicit timeout here, so Playwright's 5 s
default applies while `actionTimeout` is 60 s (`playwright.config.ts:77`).

**Interleaving:** the click clears the remembered store and re-renders the Menu; under load that
takes longer than 5 s of wall clock (the game clock also slows with the frame rate). Whether the
product can leave the line up forever is unverified — the traces were not available (finding 11).

**Change:** wait on the observable store state (a read-only hook, as the repo's own guidance
prescribes) rather than the DOM line, then assert the line hidden with an explicit budget and a
message. If the store is already clear and the line persists, that is a product bug and the test
should say so.

**Size/risk:** **S**.

### 4. The focus-trap loop takes 60 one-shot samples of `document.activeElement` (P2)

**Evidence:** `e2e/inventory.spec.ts:119–132`: 30 `Tab` presses, each followed by
`expect(await inside(), \`Tab ${i + 1} stays in the bag\`).toBe(true)`, then 30 `Shift+Tab`.
Failures land at random iterations (4, 9, 14, 19) — six events in the window. A single frame in
which the active element is `<body>` fails the iteration; a late home/items read re-rendering the
bag grid, or a toast taking focus, produces exactly that.

**Change:** let the bag settle first (the spec already has `seedPack`; wait for the expected cells
and no pending reads, as `inventory.spec.ts:190,209` does with `homeReads(page).idle()`), and record
focus escapes per frame instead of sampling: a tiny dev hook or `page.evaluate` rAF recorder (the
same shape as `__e2eGaps` in `open-map.spec.ts:150`) that flags any frame whose active element left
the dialog, then assert the recorded list is empty. That proves the stronger property and cannot
flake on one unlucky frame.

**Size/risk:** **S**.

### 5. The named-way spec's map-label selector is strict-mode racy (P2)

**Evidence:** `e2e/paths.spec.ts:260` (two hard failures, seven retry passes). At `:366`,
`expect(page.locator('[data-label="way"]')).toContainText("Tansy's way")` fails in both directions:
"strict mode violation: … resolved to 2 elements" / "3 elements" when several way labels draw at
the opening zoom, and `element(s) not found` when the label is culled or its midpoint sits outside
the viewport (the spec's own comment at `:359` notes the endpoint problem). The same test also
loses "the lift landed" / "the lay landed" (`landed()`, `:63–67`, 15 s for a queued path operation)
twice.

**Change:** assert on the label layer's content, not on a bare `[data-label]` locator: filter by
the way's name (or wait until a label containing "Tansy's way" is visible at a zoom where labels
return), and keep `map-ways` in Details as the non-graphic check. Give `landed()` a named budget
that reports the queue state and `diagnose(page)` on expiry instead of a bare 15 s.

**Size/risk:** **S**.

### 6. `open-map.spec.ts` samples scene state without a settle barrier (P2)

**Evidence:** four sites, seven events.

- `:160` "walk from the gate … reload in place": `:225` allows 17 px after `reenter`; it checks the
  server's saved position (`:214–218`) and forces a save, but not that the hero has stopped moving,
  which is exactly what `5e12968` fixed in `wilds-outer.spec.ts:139`. Once it failed earlier, with
  "no way to {"maxTy":-3}" — the walk planner on a fresh varied seed (`:179` says the world is its own).
- `:370` "after four trips" (`:405`) compares `{ tweens, statics, drawn }` before and after eight
  chunk moves, with only a 500 ms pause before each sample.
- `:403` `expect(Math.floor(south.ty / S), 'south of the edge')` (`:412`) after `openNear`.
- `:471` reduced motion: `expect((await sceneSize(page)).tweens).toBe(0)` (`:479`) is a one-shot.

**Change:** reuse the settle pattern from `5e12968` (steady samples plus a matching saved position)
before the reload comparison; before the `:405` and `:479` snapshots, wait for `windowWhole` and
zero in-flight tweens (or `expect.poll` the snapshot until two consecutive samples match). Give
the varied-seed walk its own budget and a `diagnose` on stall, per `docs/testing.md`'s own rule to
pin the world for behaviour checks (`pinWorld`) and keep varied-seed walks as their own tests.

**Size/risk:** **S–M**, four small barriers.

### 7. The 400 ms long-task budget runs in every full suite (P2)

**Evidence:** `e2e/first-paint.spec.ts:66–84`: `expect(longest(commons.tasks)).toBeLessThan(400)`
runs in the ordinary suite (only the phone variant is `PERF`-gated at `:88`). It failed both
attempts on `38350543497` and needed the retry twice more. The suite runs four workers inside a
container capped at 12 CPUs and `cpu-shares: 256` (`.github/workflows/ci.yml:156–159`), and the
spec's own comment says the budget is "generous for a loaded test machine".

This is the same class the last review moved out of the Go tests: a wall-clock threshold is a
measurement, not a correctness property, and `generator-performance` (`ci.yml:231`) now exists for
exactly that.

**Change:** keep the tileset-hash and worker/main-thread parity checks (deterministic) in the suite,
and move the long-task threshold to the measured job — or keep a much looser ceiling in the suite
with the number recorded as an annotation (it already pushes one at `:82`), so a regression shows
in the report rather than as a red run.

**Size/risk:** **S**.

### 8. `docs/testing.md` documents quarantines that do not exist (P2)

**Evidence:** `docs/testing.md:290` ("Quarantined") says tests that catch unfixed product bugs
are marked `test.fixme`, and names three: `presence.spec.ts` "come to rest exactly where you
stopped", `wilds-screens.spec.ts` "the fallen-hero lantern", `wilds.spec.ts` "the Commons arch
leads into the Tangle". There is **no `fixme` anywhere under `e2e/`** (grep), and all three tests
run: `wilds.spec.ts:65` appears in passing run summaries, `presence.spec.ts:97` runs, and
`wilds-screens.spec.ts:145` flaked four times in this window on the very prompt check
(`> 133 | .prompt` contains `/lantern/i`). The section's promise — "the full suite stays green for
everyone else" — is not in effect, and a reader chasing a lantern flake will look for a `fixme`
that is not there.

**Change:** decide per test: re-quarantine the lantern case with `test.fixme` and the bug written
above it (or keep it and delete the entry), and rewrite the section to describe what is actually
quarantined today. `b880aa3` changed this spec's readiness; the doc should say which state it is
in now.

**Size/risk:** **S**, docs plus at most one attribute.

### 9. A Go unit fixture depends on the generated home land (P2)

**Evidence:** `server/internal/api/homes2_test.go:616–623` searches the home's generated land for a
*second* lit, clearable tile (different from the tree already cleared) to exercise a zero-price
clearing, and fails with `land fixture: one lit tree` when the land has only one. The land is
generated from the world id (`server/internal/land/land.go:38–44`, `Generate(Seed(worldID, gate, cfg))`),
and each rig makes a fresh world, so the shape varies per run. It failed `verify` on `38323703609`
while both e2e jobs were green — the run is red on a fixture accident.

**Change:** pin the land for this test (a fixed world id or seed, as the e2e specs now do), or
derive the free-clearing case from a deterministic fixture; and print the seed and the lit/clearable
tile list in the failure message so the next one is diagnosable.

**Size/risk:** **S**.

### 10. `page.request` to the worker's server intermittently resets (P3)

**Evidence:** `e2e/village.spec.ts:62` (`apiRequestContext.get: read ECONNRESET` on `/api/calendar`)
and `e2e/connected.spec.ts:172` (the same on a state read) — two events, two specs, unrelated to
what they test. `page.request` reuses a keep-alive connection to the per-worker Go server
(`e2e/server/backend.ts`); a reset when the server closes an idle connection as the client reuses
it presents exactly as `ECONNRESET`.

**Change:** wrap the contract-carrying request helper with one retry on connection-reset errors (the
game's own API client already classifies network failures), or set the e2e server's keep-alive
behaviour to match the deployed proxy. Do not raise the specs' timeouts.

**Size/risk:** **S**.

### 11. CI leaves no trace of a flake, and nothing at all when the run is green (P3)

**Evidence:** `playwright.config.ts:78` records `trace: 'on-first-retry'` — precisely the trace of
the interesting attempt. `ci.yml:219–229` uploads artifacts only `if: failure()`, and only
`test-results/**/*.png` and `error-context.md` (traces were cut after a 2.6 GB upload blew the job
timeout). So a run that is green thanks to a retry uploads nothing (the flake exists only as a log
line), and a red run gets screenshots but not the recorded traces. Compounding it,
`e2e/fights-shared.spec.ts:53` skips outside CI (`test.skip(!process.env.CI)`), so the flakiest
two-browser gate cannot be replayed locally, and this window's two hard failures of it had neither
trace nor local reproduction.

**Change:** a bounded upload — only `*-retry1/trace.zip` directories for tests that took a retry,
capped and zipped, uploaded `if: always()` with a few days' retention; or, cheaper, a JSON reporter
summary uploaded always. Let `fights-shared` run locally behind an explicit env flag (`FIGHTS_E2E=1`)
so a red gate can be replayed without CI.

**Size/risk:** **S**, mostly workflow wiring.

### 12. One self-hosted runner serialises every branch's full run (P3)

**Evidence:** `ci.yml:140–143` gives `e2e-full` concurrency per ref, so a dev merge and an exp push
queue against each other on the single `glimway-e2e` runner. Run durations of 34–51 minutes in the
window (`38282751537`, `38298483275`, `38202888419`, `38200454332`) are queue time: `38202888419`'s
e2e job started 33 minutes after the push while its own `verify` had finished 20 minutes earlier.
The suite itself is a steady 15.8–17.4 minutes.

**Change:** nothing structural is wrong — the risk is that a red run looks slow for the wrong
reason. Record queue time in the run (a first-step timestamp), and consider letting a newer push on
any `exp/` ref release the runner from an older queued exp run (never from `main`, per the existing
comment at `ci.yml:141–142`).

**Size/risk:** **S**.

### 13. The load/perf documentation is one release behind the code (P2)

**Evidence:** `docs/scaling.md:52` says "Next real step is frame coalescing (several queued frames
in one socket write), which needs a wire change". Frame coalescing *is* the change: every
server-to-client presence message is now one `PresenceFrame` (`36f06bf`, protocol
`glimway.presence.v3`, `src/lib/presence-codec.ts:5`). The newest knob is documented nowhere but a
commit message: `-presence-flush-ms` / `GLIMWAY_PRESENCE_FLUSH_MS` (`a7f4f00`, hardened in
`7e7c91c`) holds peer events for the next 50/100 ms sweep and writes one frame — with measured
numbers at 4,200 players (writes/s 84k → 58k → 41k, position age p50 31 → 119 ms) that belong
beside `docs/scaling.md`'s "Measured: shared camp fights" section, which itself predates both the
coalescing and the flush. `docs/testing.md:240–241` ("Three tools … None of them runs in CI") does not
mention `perf/fights.perf.ts`, `scripts/fight-load.sh` or the fights section of `?perf=1`, and its
generated-data table (`:45`) omits `npm run vectors:fights-wire`.

**Change:** one pass over `docs/scaling.md` and the `docs/testing.md` performance section: record
the coalesced-frame write pattern and the flush flag with its numbers and its default (off), mark
the older write-cost numbers as pre-coalescing, add the fights perf/load tools to the testing doc's
tool list (cross-referencing `docs/shared-fights-testing.md`, which is current and good), and add
the missing vector script.

**Size/risk:** **S**, prose only.

### 14. Small doc drift against the code (P3)

**Evidence:** each verified at this snapshot.

- `docs/design/layers.md:178–180`: "Presence relays positions, emotes, abilities … but no enemies"
  and "the expansion design's sketch for co-op … was never built" — shared server-run camp enemies
  shipped (`a7e5ae5`); the surrounding design text is fine but this status sentence now misleads.
- `docs/server-behavior.md:483` "Send the lease in the first JSON message" and `:494` "stationary
  clients send a JSON heartbeat" — the wire is protobuf (`PresenceMessage`, `FightSwing` on the
  same envelope; `src/lib/presence-codec.ts:5–8` says "presence never passes through JSON"), and the
  wire types are generated (`src/lib/gen/glimway/v2/presence_pb.js`), not hand-written in
  `src/lib/presence.ts` as `:487` says.
- `docs/README.md:23–42` indexes `testing.md`, `server-behavior.md` and `scaling.md` but has no
  entry for `docs/shared-fights-testing.md`.
- `README.md:454` "default half the cores, 2 to 6" — `playwright.config.ts:52–54` gives 2–3;
  `README.md:444` "verify # all four of the above" — `verify` runs five commands.

**Change:** edit the four passages. **Size/risk:** **S**.

## Keep as is

- **The readiness vocabulary** (`chunkWhole`, `windowWhole`, `waitForLive`, `targetAt`, `standFor`,
  `pressOn`, `waitFrames`, `expectToast`, `diagnose`) and its table in `docs/testing.md`. The
  findings above ask for its use in the specs that bypass it, not for new helpers.
- **Pinned worlds and wick slack** (`pinWorld`, `wickSlack`, `seasonOf`, `calendarOnServer`). Keep
  varied-seed walks as their own named tests.
- **Retries at 1, `reportSlowTests`, and the trimmed artifact paths.** The 2.6 GB trace upload was a
  real problem; finding 11 asks for a bounded addition, not the old behavior.
- **The manual `generator-performance` job** and the opt-in `GLIMWAY_PERF` budgets. Finding 7 asks
  to finish that move for the browser-side threshold.
- **`docs/shared-fights-testing.md`** — the load scenario's constraints (pong timeout, warm-up
  budget, `FIGHT_LOAD_MAX_CONNECTIONS`) are documented where someone will read them.
- **The smoke tier's size** (5 tests) and its GitHub-hosted placement. The inventory spec's 240 s
  CI timeout (`e2e/inventory.spec.ts:189`) is an accepted runner-speed accommodation; split the
  spec only if it grows again.
- **The unit suites.** `npm test` (2,329 tests) and `go test ./...` both pass at `268c9b4`; the
  fight unit tests are dense and deterministic. Fix the one land fixture (finding 9) and leave the
  rest.

## Proposed order

1. **Cheap dependability:** findings 2, 3, 4, 5 (four helpers/selectors that account for 32 of the
   67 events), then 6 and 7.
2. **Feedback loop:** finding 1 (changed-test selection, with selector tests) and finding 11
   (bounded trace/flake artifacts, local `fights-shared`).
3. **Hygiene:** findings 8, 9, 10, then the prose in 13 and 14. Finding 12 only if the queueing
   annoys the next round.

## Verification

Only this document is an authored repository change. No source files were edited, no commit was
made, and no `git` command that changes state ran. `npm ci`/`npm install` and the e2e suite were
not run. Everything ran through this terminal.

**Checks at `268c9b4`:** `npm test` — 2,329 passed, zero failed, 28.3 s. `go test ./...` (with
`GOFLAGS=-buildvcs=false`, `nice -n 10`) — all packages passed; api 35.1 s, store 23.1 s, wilds
46.1 s. `npx playwright test --list` — 286 tests in 72 files (an inventory, not a run).

**CI data:** 36 runs read via `gh run list` and `gh run view <id> --log` (2026-10-11 22:31 →
2026-10-13 07:10); job timings via `gh api …/actions/runs/<id>/jobs`. The per-spec table counts the
`failed` and `flaky` blocks of each run's own summary, so "retry passes" means exactly one failed
attempt followed by a pass on the CI retry. Claims about a spec's cause come from reading the spec;
where I could not confirm the mechanism (the onboarding `:133` line, `playtest1.spec.ts:265`, the
ECONNRESET source) it is marked as likely or unverified in place.

**Probes:** the changed-test selector was exercised in `--list` mode only (finding 1); no tests were
started for it. No e2e spec was run, so none of the flaky tests was reproduced locally this round —
the counts are CI history, and the fixes are sized from the spec code and the successful repairs
already in `5e12968` and `b880aa3`.

## Done
