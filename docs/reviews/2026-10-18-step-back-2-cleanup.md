# Step-back round 2: cleanup, server and tests

Snapshot: `acdbf0b4df7645980a0de2b0e809feed730ef424` (`review/013-prerelease`).
Compared with round 1's `190a9d38`. Sol, cross-family step-back round 2;
server, game integration, migrations, settings, tests and tooling. Review only.
The client/UI report and A10's two acknowledged bugs are outside this report.

## Round 1 disposition

“Fixed” refers to the assigned cleanup, not to proof that the live database or
release-candidate browser run has passed. Deferred 0.14 work is not silently
counted as completed.

| Id | Package | Status | Evidence at this snapshot |
|---|---|---|---|
| S1 | A1 | **Fixed** | `server/internal/store/reach.go:73` publishes only after successful driver commit, discards on failure/full rollback, and `:121` refreshes staged worlds after savepoint rollback (`server/internal/api/op.go:157`). Socket checks use the published view (`presence_socket.go:29`, `presence_fights.go:394`). Store rollback/failed-commit tests and API refused-camp/near tests cover both views. |
| S2 | A1 | **Fixed** | `server/internal/api/gathering.go:37` settles the Turning inside `ownLand`; uprooting calls it at `plants.go:206`. `upkeep_boundary_test.go:73` sends the trowel request without a preliminary state read, with and without a read-first control. Both lapse to one seed in storage, with no carried plant. |
| S3 | A1 | **Fixed** | `server/internal/api/lamp_notices.go:84` keys by `l.key`; `:171` includes world and durable home identity, while preserving the gate on the wire. The two-world regression is at `lamp_notices_test.go:167`. |
| S6 | A8 | **Fixed** | `server/internal/store/migrations_test.go:17` freezes shipped history through 037 separately from pending integrity. `migrations/038_lamps.sql:103`, `:127`, `:171` rebuild each affected table once. `release_upgrade_test.go:17` exercises populated 037 → final, checks preserved rows, refunds, final writes, schema parity and reopen. |
| G1 | A2 | **Fixed** | `src/game/scenes/travel-hold.ts:48` retains the latest relocation; `WorldScene.ts:691` consumes it on release; `world-turning.ts:199` releases before sampling/collision adjustment. `WorldScene.ts:993` suppresses old-sprite samples while held/leaving. The real Session tests and combined Link/Session/TravelHold probe passed. |
| G2 | A3 | **Fixed** | `src/game/wilds/camps-state.ts:32` reads only the current world/account's list; `src/App.svelte:512` forgets it on departure. Camp and communal naming reads check their controller's shutdown flag and captured link (`camps.ts:346`, `communal-lamps.ts:287`). New controllers have separate flags even when Phaser reuses the scene. `tests/wilds-lifetimes.test.ts:73` covers replacement worlds and late reads; its deferred naming cases also passed. |
| G3 | A3 | **Fixed** | `src/game/wilds/land-here.ts:69` invalidates outstanding status reads and `:103` schedules stationary failure retries; `store.ts:533` returns read success/failure. Mutation invalidation is wired at `camps.ts:401`, `communal-lamps.ts:331`, `ops.ts:166`, `homestead-talk.ts:405`; `window.ts:248` supplies the revision. `tests/wilds-lifetimes.test.ts:234`, `:275`, `:310` cover failed reads, real controller/path completion and invalidation during a read. |
| A2b travel/report race | A2b | **Fixed** | `038_lamps.sql:306` adds `place_moved_version` with default 0; `store/reach.go:169`, `store/rooms.go:86` and `api/ways_home.go:465` mark server choices. `src/game/link.ts:823` follows a new move before reporting it; `:537` respects it on reload. `tests/link-relocations.test.ts:96` and its reload/reconnect cases passed. Existing 037 rows default to 0 in `release_upgrade_test.go:106`. |
| T1 | A7 | **Partly fixed** | `e2e/changed-map.json:89` maps papers, items, crafting, homestead, quests/story, common ways, reach and naming to domain specs. Listing still sends `content/furnishings.json`, `server/internal/settings/settings.go`, `src/lib/web-settings.ts`, `src/lib/dev-tools.ts` and the new `src/content/camps.ts` only to smoke. `src/game/link.ts` does not select the new `ways-home.spec.ts`. The exhaustive mapping ratchet was explicitly deferred to B6. |
| T2 | A7 | **Fixed** | `e2e/items.spec.ts:169`, `:178` use `pressOn`; `e2e/helpers.ts:345` waits for live input and the exact target before one E. The pickup and worn-bucket assertions remain. Browser frequency was not remeasured here. |
| T3 | A7 | **Fixed** | `e2e/version.spec.ts:28`, `:51` return the observed settled position; `:157` compares the saved position with it and still checks report-before-reload ordering. Caveat: the fixture accepts a no-op placement as a “landing”; assert that it actually moved if this test is also meant to guard the placement hook. |
| T4 | A7 | **Partly fixed** | `e2e/open-map.spec.ts:353` uses stable samples with expected-value predicates for remote visibility; `wilds-outer.spec.ts:225` uses the report deadline. `scripts/e2e-artifacts.mjs:170` exposes flaky/hard counts. The two-run release bar is documented at `docs/releasing.md:51`, but helper retries are invisible to it (R2). No current CI streak is certified by this terminal review. |
| T5 | A7 | **Fixed (release subset)** | `.github/workflows/ci.yml:192` raises full-suite timeout to 60 minutes; `scripts/e2e-artifacts.mjs:175` lists the slowest tests including retries. `e2e/land-chip.spec.ts:64` cuts its timeout to 150 s and seeds the prerequisite deed instead of buying it again. Queue cancellation/runner capacity remain explicitly deferred; actual throughput improvement needs CI measurements. |
| T6 | A6, A8 | **Fixed (procedure/tooling)** | `docs/releasing.md:38` moves browser verification to CI; `:56` requires a release-commit rehearsal. `server/cmd/glimway-server/main.go:161` dispatches dry-run before opening `-db`; `store/dry_run.go:31` snapshots read-only input into a private directory, upgrades and rechecks it. CLI and dry-run tests passed. A real live-backup rehearsal is still outstanding. The optional Nix CI build remains deferred. |
| T7 | A6 | **Fixed** | `scripts/buf-breaking.sh:45` excludes prereleases. It selects `v0.11.2` here; actual checks against that tag and `origin/main` passed. `docs/proto-migration.md` records the policy. |
| T8 | A6 | **Fixed (assigned files)** | `docs/agent-workflow.md:31`, `docs/testing.md:26`, `:53` and `docs/ci-runner.md:14` now agree on agent CI-only browser checks and full versus changed runs. README's older local-run advice remains at `README.md:466`; the explicit agent instructions are clear. |
| T9 | A6 | **Partly fixed; assigned changelog portion fixed** | `CHANGELOG.md:60`, `:65`, `:79`, `:80` cover the shelf, place reports, duplicated tabs and manual full dispatch, plus cleanup lines. Its older technical paragraphs still describe the former reach/land implementation (`:74`, `:75`). The broad as-built design/index pass was deliberately deferred to C. |

S4/S5/S7 and G4–G7 were assigned to 0.14/later, not A1–A8. This review does
not reopen those decisions or call their remaining refactors/validation complete.
Round 1's `server/internal/holds/**` selector example names no directory in this
snapshot; it is not evidence of an additional coverage gap.

## New findings

### R1. A source-to-docs rename can skip both E2E jobs

**P2 · S size · Confirmed.**

**Evidence:** `.github/workflows/ci.yml:43` obtains `git diff --name-only`
with rename detection enabled. For a detected rename this lists the destination,
not both paths. The destination-only filter at `:45` treats anything under
`docs/`, or ending in `.md`, as documentation. Both E2E jobs depend on that
result (`:121`, `:181`).

Confirmed in a throwaway repository at `/tmp/step-back-2-ci-RDvRhg`: committed
`src/game.ts`, moved it unchanged to `docs/game.md`, committed again, and applied
the workflow's classification. Git reported `rename src/game.ts => docs/game.md
(100%)`; the name-only list was just `docs/game.md`, and `code=false`. This is a
source deletion from the build, despite the docs-only classification. No browser
or reviewed source was used by the probe.

**Effect:** a code-removing push can get a green run without either browser gate.
`verify` still runs, so this does not bypass compilation/unit checks. It does
bypass the E2E checks that catch behavior those checks miss. The release workflow
also accepts a successful CI conclusion without inspecting E2E job results
(`.github/workflows/tag-release.yml:26`).

**Fix:** use `git diff --no-renames --name-only` for this classification, so the
source deletion is inspected too; add a throwaway-repository rename regression.
Keep the current conservative handling of missing bases, PRs and manual runs.

### R2. In-test input and join retries disappear from the release flake count

**P2 · S size · Confirmed.**

**Evidence:** `e2e/helpers.ts:751` lets `pressToTalk` press E up to three times,
catching a failed conversation wait without recording it. `openTalk` and home
`talk` now use it for fixed prompts as well as moving residents. A VM probe
transpiled the actual helper with inert page dependencies: deliberately dropping
the first E and accepting the second returned success after two presses
(`/tmp/step-back-2-retry-result.json`). This confirms the test behavior, not a
live input-loss defect.

`e2e/fights-server.spec.ts:47` likewise sends another synthetic `fightJoin` on
each poll until an enemy exists. It has no positive barrier that the intended
socket/scene is ready to consume the first join and does not record how many
joins were required. The later menu, delta, prediction and death assertions
remain useful, but this setup no longer proves first-join delivery. Traced the
callback and its subsequent assertions; no Playwright reproduction is claimed.

`scripts/e2e-artifacts.mjs:173` counts only Playwright's `status === 'flaky'`.
Neither loop makes a test flaky when it eventually succeeds, so the owner can
see “0 flaky” after discarded inputs or joins were retried inside a test.

**Effect:** the agreed two-run/at-most-two-flaky release bar has less diagnostic
meaning than before. A green result proves eventual conversation/rendering, not
that ready input or an initial fight picture survived. This is a coverage and
reporting defect; it is not evidence that the production server loses joins.

**Fix:** wait for explicit readiness, then keep one-press/one-join assertions for
fixed targets and the rendering fixture. If moving-NPC retries are retained,
annotate their count and expose helper retries separately in the job summary;
do not present them as evidence of a clean first interaction.

## Combined server/game result

I found no new confirmed data-loss or ordinary-play blocker in the requested
server/proto/content/game diff.

A1 and A2b agree at their seam: upkeep reads staged reach inside its SQL
transaction, `MovePlace` writes both place versions in that same transaction,
and the response is sent only after commit publishes reach. Socket readers use
committed reach. The API reach-lapse regression checks that the moved version
equals the place watermark (`server/internal/api/frontier_reach_test.go:201`).
The passing refused-camp, refused-near, savepoint/full-rollback and failed-commit
guards are stronger than the former next-read repair.

A2b and A2 also work together: a separate terminal probe connected the real
Link, real Session and TravelHold. For both a ways-home answer and a
server-chosen reach move, a report deadline during the hold sent the destination
on the new basis while the sprite stayed held; releasing the hold moved the
sprite and preserved that destination. Probe: `/tmp/step-back-2-travel.mjs`.

A3's per-controller shutdown fences survive A2's rebuilds. The old controller
is marked gone, a new controller reads the correct world's model, and Turning's
pending completion is fenced by its own `ended` flag
(`src/game/scenes/world-turning.ts:89`, `:180`). A plain active-scene check no
longer suffices by itself or allows the old naming read into the next build.
The node lifetime suite exercised shutdown/restart and failed stationary reads.

## Tests and tooling assessment

Most A7 changes improve synchronization without loosening outcomes. The bucket
still needs one exact-target press. Remote visibility still requires the exact
names and later the correct world-pixel position. `steady` itself requires
consecutive equal, ready samples (`e2e/helpers.ts:412`); it is not an action
retry. The motes case's `.catch(() => moteResources(page))`
(`e2e/open-map.spec.ts:569`) does weaken its stability promise on timeout, but
its final exact mote/tween counts still have to pass. Preserve the failure
instead of falling back when this fixture is next touched.

Whitequiet's larger wait matches the 10-second report cadence rather than
allowing an absent effect forever. Seeded deeds remove repeated purchase setup;
the real buying flow remains in the homestead spec. R2 is the substantive
exception to the synchronization improvements.

A9's crate guard exercises real POSTs, holds subsequent reads, checks one collect
and verifies inventory/plant/stack state (`e2e/camps.spec.ts:175`). Its ways-home
guard sends the real operation and delays the answer; the second case explicitly
rewrites the destination/SQL because no actual way home enters an interior.
That is legitimate client seam coverage, not a server feature assertion.
However, `ways-home.spec.ts:121` samples `transitioning` after fulfilling the
route without positively observing client adoption inside the hold. For stronger
race coverage, hold the land read, observe the adopted destination while the
sprite is still held, then release land. Its saved-place poll at `:134` can
already be true from the operation's server commit; observe a later report
sequence before claiming persistence “through the next report.” The node
report/provenance tests provide that stronger assertion today.

The selector improvements are real but incomplete (T1). In particular, include
`ways-home.spec.ts` when `src/game/link.ts` changes, and map `src/content/camps.ts`
to the lamp/camp specs. Dev/main full runs cover these gaps; changed-only lane
green does not. The 038 SQL currently selects connection/world specs, not the
lamp specs; migration safety is principally guarded by Go upgrade tests.

The protobuf check passed with both current baselines. The accepted-move list
is empty; nonempty unexpected output still fails. Prerelease exclusion fixes
the concrete round 1 problem. No new protobuf blocker was found.

## Settings and upgrade safety

The production module preserves the old login defaults (4 concurrent proofs,
10 per IP/minute, 60 global/minute) and existing `cfg.login` overrides through
TOML defaults (`deploy/nixos/instance.nix:204`); it removes generated flags that
would otherwise pin the file. Explicit settings win over those defaults;
environment variables and explicit flags retain precedence
(`server/cmd/glimway-server/main.go:105`). The module validates the file using
the selected binary, supplies its fixed `/etc/glimway/config.toml` path, and
adds SIGHUP reload (`instance.nix:31`, `:228`, `:237`). Production builds reject
dev enablement. I did not inspect the owner's host configuration.

Reload loads/checks a complete replacement before an atomic swap; invalid files
keep running settings, and restart-only login values remain at their running
values (`server/cmd/glimway-server/settings.go:40`,
`server/internal/settings/settings.go:295`). Nix explicitly restarts on login
settings changes (`instance.nix:234`). Thus `docs/releasing.md:117`'s “later
settings changes only reload” is too broad: later **live** settings reload;
login limits still restart. One restart for this deploy is consistent with the
module, but is not a measured downtime promise: migration runs before serving.

**037 → this final 038 is structurally safe on the tested populated databases;
the real live database is not yet certified.** The shipped prefix is unchanged.
SQL and its Go backfill run in one immediate transaction, perform a foreign-key
check before recording completion, and commit together
(`server/internal/store/migrations.go:69`, `:93`). The single migration includes
A2b's column at `038_lamps.sql:306`; there is no missing forward step for a real
037 database. The populated fixture now lives in `release_upgrade_test.go:17`,
with the boundary defined in `migrations_test.go:68`.

038 intentionally discards old wick terrain/changes after staging paid paths,
archives fallen lamps, and leaves still-epoch state alone (`038_lamps.sql:12`).
The backfill freezes 0.11.2 costs and credits existing beneficiaries one stone
or timber per paid tile (`migration_038_backfill.go:15`, `:52`, `:97`). It skips
malformed ground JSON and missing authors rather than failing (`:49`, `:54`):
that is an explicit rehearsal check, not a reason to infer actual live loss.
Dry-run checks database integrity and counts, not semantic item conservation;
`item_stacks` counts rows, not quantities. A successful command alone cannot
certify refunds.

Old alpha migrations are deliberately incompatible and must be reset. Also,
a staging database already upgraded to **an earlier revision of `038_lamps.sql`**
will not gain A2b's column by reopening: applied migrations are skipped
(`migrations.go:125`). Ensure staging's final reset/upgrade includes the column,
not just that its newest migration is named 038. This does not affect live's
037 upgrade.

## Release readiness

No P1 found here. I would ship after A10 lands, R1's small CI classification
fix, and trustworthy release-candidate evidence. R2 should be fixed or its
hidden retries explicitly disclosed when applying the owner's flake bar.
Keep the deferred 0.14 refactors deferred.

The owner/orchestrator's rehearsal must:

1. Use the exact release candidate and a fresh, verified, standalone copy of
   live's 037 backup. Run `migrate --dry-run COPY`; record its successful output,
   applied `038_lamps.sql`, counts and duration. No rehearsal on live itself.
2. Compare accounts/worlds/homes and preserved item-instance, fitting, shelf,
   plant and stack **identities, metadata and quantities**, not just table row
   counts. Check foreign keys and the default-zero move provenance column.
3. Before upgrading a second disposable copy for inspection, inventory wick
   ground JSON, paid tiles and beneficiaries. Afterward, reconcile exact
   stone/timber refunds by account/world/chunk against uncollected
   `land-changed` crate entries; explain missing/deleted authors and reject
   malformed path state. Check fallen-lamp archives, still terrain/state,
   removal of old wick changes, and no duplicate refunds after reopen.
4. Exercise first load and first action after upgrade on the disposable data:
   an outdoor saved place, a home/interior, reporting/reload, a Turning and a
   way home. Playtest final staging with `place_moved_version` actually present.
   Use CI for browser checks. Verify the rendered production settings and
   login values using the intended package/module build before deployment.
5. Meet the two-full-dev-run/no-hard-failure/at-most-two-flaky bar after A10,
   with the release commit's own full run and helper retries visible. Preserve
   a verified predeploy backup: migration is atomic on failure, but successful
   terrain reset is not undone by switching back to an older binary.

## Verification and limits

All test commands and probes used `nix develop`. The sandbox launcher failed
before execution (`bwrap` NETLINK_ROUTE), so commands used the approved execution
fallback. No implementation edits, commits, Playwright, Vite, host settings or
live-service/database access.

- `go build ./...` and `go vet ./...`: passed.
- `go test -timeout 25m ./server/internal/store/`: passed, 348.91 s.
- Focused API tests for reach, refused camp/near, due lapse, notices and ways
  home: passed, 18.17 s.
- Settings, production command/CLI, frontier and content package tests: passed.
- `npm test`: **2,694 passed, zero failed**, 64.95 s. Used a temporary Node
  resolver pointing to `/data/code/fingersnap/node_modules`; the lockfile is
  byte-identical. No dependency install/link was added to this worktree.
- `buf breaking`: passed against `origin/main` and `v0.11.2`, using a temporary
  copy of the reviewed script with only the dependency path adjusted.
- Throwaway CI rename, repeated-input and combined-travel probes: results
  described above. Selector checks used `--list` only.
- No real live backup was supplied or inspected. No claim of browser
  reproduction, new CI timings or a satisfied final release streak.

## Open questions for the owner

No new product decision is needed. The remaining operational confirmations are
that staging was reset/upgraded after the final 038 edit, and that the exact
release candidate passed the real-backup rehearsal above.
