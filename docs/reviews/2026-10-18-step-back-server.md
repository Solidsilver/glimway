Snapshot: `190a9d38`

# Step-back review: the server (Go), 0.12–0.13

The server/proto diff from v0.11.2 contains 173 files, about 18,200 added lines and 540
removed lines, including tests and generated Go. The main additions are lasting geography,
holds and oil-fed backland/camps; Common paths and communal lamps; naming and ways home;
weekly sap, trowels and carried plants; frontier reach, map status and dimming notices; and
live TOML settings with staging-only dev tools. Migrations 038–048 establish these tables
and refund old paid paths. Since the previous step-back, the fight fall handoff and bounded,
invalidated ground caches also landed.

I read the 2026-10-13 reviews, decisions-overnight.md and the release plan first. The findings
below preserve the settled calls: islands remain reachable, bare clearing turns weekly,
lot-backland plants lapse to seeds in home storage, portable names follow their lamp,
and a permanent hearth core is different from its oil-fed extensions. This is a review
only. Citations refer to this snapshot, with repository-relative paths.

## Findings

### S1 — A refused camp publishes reach for a hold that was rolled back

**P2 · M · Confirmed.**

`server/internal/api/camps.go:403` takes the hold before checking the target ground
(`:420`), communal-lamp overlap (`:423`) and oil (`:426`). Taking it calls
`server/internal/store/reach.go:60`, which immediately changes the process-wide frontier.
The ordinary refusal rolls SQL back to the gameplay savepoint
(`server/internal/api/op.go:154`). Response maintenance reads the epoch in that **same**
transaction, but `confirmReach` explicitly skips that transaction
(`server/internal/store/reach.go:71`). The rolled-back hold therefore survives in the cache
until a later transaction confirms it. Socket checks also consume that globally published
view without acquiring the SQL connection.

**Verified failure:** a throwaway overlay test attempted to put a lamp on the fake generator's
blocking thicket at the north frontier. The real camp endpoint returned `land-blocked`;
SQL contained zero holds, but `frontier.Inside` admitted land three chunks beyond the edge.
The next near request for that land returned **200**: its centre check uses the stale cache
before `openEpochs` repairs it (`server/internal/api/open_map.go:121`, `:136`). After the
request the cache correctly excluded the centre it had just accepted. A separate store probe
confirmed that even an explicit `Current` after savepoint rollback leaves the phantom reach.

**Fix:** make staged reach belong to its transaction and publish committed reach for socket
readers. At minimum, refresh dirty reach after rollback-to-savepoint and full rollback, and
confirm the current view before request boundary checks. Preserve the transaction's ability
to generate land against its own newly acquired hold. Moving `Hold` later reduces ordinary
refusals after publication but does not cover failed commits. Guard refused placement,
insufficient oil, savepoint rollback, failed/full rollback, and a concurrent socket reader.

### S2 — The home trowel can act before an already-due backland lapse

**P2 · S · Confirmed.**

`server/internal/api/plants.go:154` settles the turning before planting and checking
`ownLand`. The new `uprootHomePlant` instead goes straight to `ownLand` (`:208`) and
then lifts the plant (`:222`). The item dispatcher does not settle the turning before this
branch (`server/internal/api/items.go:58`). Response maintenance runs only after persistence
(`server/internal/api/op.go:188`, `server/internal/api/projection.go:92`).

**Verified failure:** with a dimming, empty lot lantern, advance across its lapse boundary
and send a raw uproot request as the first request afterward. The endpoint returns **200**,
the whole plant is in `carried_plants`, and only afterward has maintenance removed the hold.
If a state read runs first, the plant is already archived and its seed is in storage instead.
This changes the outcome according to polling order and bypasses the owner's explicit
seed-only recovery for dark backland (`docs/design/lamps.md:541`). No missing-item claim is
made; the incorrect result preserves the whole plant when the land should already have turned.

**Fix:** settle the turning before `ownLand` in this action, as planting already does. Add a
boundary test that bypasses `opRefreshing`: that helper issues a state GET first
(`server/internal/api/items_test.go:72`), which masks this class of bug. More broadly, give
land actions one explicit pre-apply upkeep entry point; retain the separate response phase
for refused/replayed operations. Include first-action-after-turning cases for each new land
mutation, rather than only tests preceded by a refreshed state.

### S3 — A lot-lantern notice in one world suppresses another world's notice

**P2 · S · Confirmed.**

The once-per-episode outcome key is `lamp-dimming:<kind>:<id>:<episode>`
(`server/internal/api/lamp_notices.go:80`), scoped to the account. A lot lantern's `id` is
only its gate number (`:165`). Gate zero repeats in every world; neither the world nor the
home's identity reaches the outcome key. Camp instance IDs do not have this collision.

**Verified failure:** a probe created distinct lit, empty gate-zero lanterns in two worlds.
It called the actual notice builder for Alice in the first, then changed her household and
snapshot world to the second at the same clock. The second world's `keptDimming` returned
its lantern, but the notice builder returned no notice because the first world's outcome
already existed. This is a function/database reproduction of the identity collision, not an
end-to-end test of the world-move UI.

**Fix:** key lot episodes by a durable home identity, with world scope, while keeping the
wire's gate number for locating the stake. Guard moving worlds during one episode and a
replacement household/lantern at the same gate. Keep the accepted rule that standing beside
a dimming light records it as seen without showing a toast.

### S4 — Packing and oil judgement are duplicated at the exact seam 0.14 will extend

**P2 · L · Confirmed maintenance cost.**

`camps.go` is 836 lines; its `packCamp` spans `:715` through `:815` and mixes collecting
objects, choosing beneficiaries, aggregating refunds, building JSON state, allocating a crate,
moving instances, deleting plants and deleting the claim. `crateLostDeed` independently does
the same kind of collection/application in `server/internal/api/home_deeds.go:498` through
`:648`, even repeating the local `entry` struct. The camp and lot oil state machines are
also separate copies (`server/internal/api/camps.go:676`, `lot_lanterns.go:239`).

The shared primitives already exist in `server/internal/api/recovery.go:28` and `:58`,
but `common_ways.go:179` and `communal_lamps.go:453` allocate crates and insert entries
directly. Path-cost aggregation and sorting repeat in `common_ways.go:158` and
`camps.go:764`. Each new recovered asset/metadata field must be audited in several producers,
not just the collector. The recent reason, mover-name and plant-age additions already cross
these boundaries. This is a demonstrated change cost, not evidence that current packing
loses goods.

**Fix:** extract a typed recovery entry/state representation and a shared crate writer;
keep source-specific beneficiary selection separate. Share path refund calculation and the
pure oil/dimming transition. Split camp queries/views, actions and lifecycle packing at those
boundaries. Keep lot seed-to-storage recovery and camps' whole-plant recovery as explicit
policies. Keep historical migration refund rules frozen rather than calling live catalogue
helpers from the backfill. Use conservation and rollback cases across camp lapse, pack-up,
communal posts and lost deeds as the extraction guards. This is several coordinated patches,
not a prerequisite for the three focused correctness fixes above.

### S5 — Ordinary API fixtures pay production disk-sync costs on every transaction

**P2 · M · Confirmed; measured on this host.**

The fixture already copies a migrated database (`server/internal/api/test_helpers_test.go:115`),
so rerunning migrations is not the main unaddressed setup problem. It then opens every copy
with production `synchronous(FULL)` (`:135`, `server/internal/store/store.go:46`). Scenario
helpers also issue frequent state GETs; these use immediate transactions and update session/
lease state, so nominally read-heavy tests still commit writes.

The unchanged API suite passed in **249.97 s** here; I did not reproduce seven minutes.
A profile of `TestOutdoorLotServices`, `TestPlotServicesRequirePrivateGround` and
`TestWickSapOneTapAWick` took 17.31 s with only 1.85 s of sampled CPU. An unprofiled baseline
of the same three took **11.30 s**. A /tmp-only Go overlay changed only the copied fixture
connection to `PRAGMA synchronous=OFF`: the same three passed in **2.56 s**. These are
single-run host measurements, not a CI budget or a promise of a proportional full-suite gain.
They establish a substantial avoidable disk-durability cost in ordinary scenario fixtures.
The unchanged store suite also took 287.96 s; that suite was not part of the durability A/B,
so its possible speedup remains unmeasured.

**Fix:** give disposable API scenario databases an explicit cheaper durability policy, or put
them on an appropriate memory-backed filesystem. Keep production opens and a small dedicated
set of file/reopen, backup, migration, concurrency and durability tests on the real settings.
Preserve the migration-template optimization. Do not add blanket `t.Parallel`: store opening
resets the process-global frontier (`server/internal/store/reach.go:108`), so fixture isolation
must be addressed before parallel test execution is safe. Measure the whole suite after the
fixture change; retain socket timing tests and their lifecycle assertions.

### S6 — Unreleased migrations are treated as frozen deployment history and rebuild one table three times

**P3 · M · Confirmed.**

The independent `deployedMigrationHistory` list includes every migration through 048
(`server/internal/store/migrations_test.go:56` through `:66`), although the release boundary
for this review is 037. Its append-only comment (`:17`) does not distinguish deployed history
from the explicitly editable 038–048 development sequence.

That sequence copies/drops/reindexes `homestead_items` in 040 (`:13`), again in 041
(`:21`) and again in 043 (`:40`). It creates an interim naming schema in 043 and replaces
it in 046, and creates the recovery entry schema in 041 before replacing it in 047. These
are valid sequential migrations, but they preserve feature-lane intermediate designs as
permanent upgrade work before anyone needs that release compatibility. The SQL and the extra
checksum list make a coordinated correction more cumbersome than the roadmap's cheap-break
window intends.

**Fix:** distinguish the truly shipped freeze through 037 from integrity checking of pending
migrations. Before 0.13.0, fold redundant pending table shapes/rebuilds together where useful,
update the manifest, and retain a populated 037-to-final upgrade test covering pieces, tools,
fittings, plants, shelf goods and path refunds. Existing path-refund and geometry-preservation
upgrade tests are valuable and should remain. Decide explicitly whether any staging/alpha
database needs to survive the reshaping; an already-applied migration is not rerun just because
its source changes (`server/internal/store/migrations.go:125`). This does not propose rewriting
001–037 or introducing a generic migration framework.

### S7 — The error enum is centralized, but refusal policy still grows independently of it

**P3 · M · Confirmed maintenance cost.**

The release adds 22 codes, 231–252 (`proto/glimway/v1/errors.proto:245`). The catalogue and
AST guard are useful, but production still supplies strings and HTTP statuses independently
(`server/internal/api/http.go:19`), and replay policy is a separate string switch whose
fallback makes every new 403/404/409/422 refusal terminal
(`server/internal/api/op_idempotency.go:294`). The same `no-camp` code is emitted as both
404 and 409 (`server/internal/api/camps.go:449`, `:476`). The coverage test establishes
that strings exist in the enum, not that a new code has a reviewed retry/replay policy
(`server/internal/api/error_codes_test.go:18`).

**Cost:** adding a 0.14 market/charter refusal requires coordinating the enum, emitters,
terminal exceptions and client handling. An omitted replay decision silently inherits policy;
there is no exhaustive check. This is not a claim that the current 22 codes are wrong, nor a
request to erase useful distinctions such as a packed versus unlit bound lamp.

**Fix:** use typed codes at emitters and make replay classification explicit and exhaustive
for emitted codes, with endpoint-specific status exceptions documented where needed. Audit
synonyms and unused entries before freezing the vocabulary; reserve retired numbers/names
instead of reusing them. Keep the existing wire adapter and source-coverage guard. Coordinate
client copy coverage with the UI lane rather than duplicating its wording here.

## Verification

All Go tests, profiles and probes ran through `nix develop -c`, in foreground processes.
The sandbox could not start (bwrap NETLINK_ROUTE failure), so terminal inspection/testing
used the approved execution
fallback. No Playwright, Vite, source edits or commits were performed.

- Unchanged API suite: `go test -json -count=1 ./server/internal/api`, passed, 249.97 s.
- Four throwaway Go-overlay probes, stored outside the repository under
  `/tmp/glimway-stepback-server`: late uproot, cross-world notices, savepoint reach and the
  real rejected-camp/next-near sequence all confirmed the behavior described above.
- Three-test CPU profile and fixture-only durability A/B: all passed; artifacts stayed in /tmp.
- Unchanged sequential package checks passed: store (287.96 s), frontier (0.14 s), story
  (0.15 s), fights (0.55 s), settings (0.004 s), and the production command package (7.79 s).
- Staging command package: `go test -p 1 -tags dev -count=1 ./server/cmd/glimway-server`,
  passed, 4.65 s.

## What's healthy

- Response upkeep and projection remain separate. `maintainState` reloads changed snapshots
  before decorating (`server/internal/api/projection.go:109`); reach recovery uses a focused
  place/version update (`server/internal/store/reach.go:124`) rather than broad `Persist`.
  The pure projection tests remain useful. Lamp notices deliberately avoid a PlayerState
  envelope (`server/internal/api/lamp_notices.go:42`), which keeps this polling read out of
  place/vitals maintenance. S2 concerns missing pre-action upkeep, not a demand to re-save reads.
- Holds keep their pinned blob/epoch; missing held terrain fails instead of regenerating.
  Unknown holder kinds retain land, and released holds keep their reach until the turning.
  The catch-up cursor and Common visit checks cover missed weeks. The earlier same-lamp,
  different-chunk packing bug has a concrete regression in `review_server_test.go:56`.
- Recovery collection updates the uncollected row and moves its goods in the same transaction
  (`server/internal/api/recovery.go:203`). The current tests cover own-piece retrieval despite
  rule changes, keeper pack-up attribution, selective collection and plant identity/age.
- The previous fight fixes are present: damage paths hand falls off before answering, and
  cache invalidation prevents stale in-flight wakes from restoring old ground. The review's
  rejected Kindle-origin change is not re-raised. Client-selected held/tool mode remains the
  previously identified contract choice, not a new 0.13 finding.
- Settings use one tagged schema, reject unknown keys, swap validated reloads atomically and
  preserve restart-only values. Production builds refuse dev enablement; configured staging
  tools use session/account gates. I found no new blocker in this system.

## Seams for 0.14

1. **Give world upkeep a transaction boundary that caches also obey.** S1 and S2 show why
   response-time upkeep alone is insufficient. Keep ordinary reads from claiming authorship
   over player place/vitals, and test first requests at boundaries without fixture pre-reads.
2. **Model permanent hearth cores separately from fueled extensions.** A holder kind and
   `claimKey` are good existing seams (`server/internal/store/holds.go:54`,
   `server/internal/api/claim_rules.go:36`); an oil-counter special case should not become
   the definition of permanence. Keep permission policy and own-item recovery separate.
3. **Extend recovery before adding market ownership states.** Typed recovery entries and one
   application path should carry beneficiary, instance, maker, plant age, mover and reason.
   Specify how listed/reserved goods interact with lapse, charter surrender and collection;
   preserve the atomic inventory/ledger boundary.
4. **Finish the pending migration and error-vocabulary audits before contract freeze.** Resolve
   staging upgrade support for any rewritten pending migrations. Classify new refusal replay
   behavior explicitly, and retain the intentional packed/unlit/elsewhere travel distinctions.
5. **Use the measured fixture cost to shorten feedback.** Keep a fast scenario lane and real
   file/durability coverage. A faster suite is useful only if boundary and conservation tests
   continue exercising the actual operation and maintenance ordering.
