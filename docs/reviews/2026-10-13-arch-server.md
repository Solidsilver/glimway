# Backend architecture and code-quality review

Snapshot: detached `dev` at `8acdc3a`, October 13, 2026. Scope: the root Go module,
`server/`, `content/`, protobuf boundaries, migrations, backend test helpers and
build/run scripts. Review only. S = one focused change; M = several related changes;
L = an extraction that needs several independently reviewable stages. Line ranges
refer to this snapshot, not the October 7 snapshot.

## Summary

The backend has sound foundations and much better file organization than it had on
October 7. Transactions, normalized authority, injected clocks, deterministic
generation and contract fixtures are real strengths. All backend/content tests and
both production and dev vet checks passed. This is not a project needing a rewrite.

The remaining mess is mainly **ownership and semantic duplication**, rather than
large copied blocks. The five biggest structural problems are:

1. **`api` is still most of the application.** Its smaller files collectively own
   HTTP, gameplay decisions, SQL repositories, state composition, presence and
   fight lifecycle integration. It has grown from 11,125 to 20,943 source lines
   since the earlier review. File splitting worked; responsibility extraction is
   the next useful step.
2. **The common test rig preserves an obsolete view of the protocol.** It rewrites
   requests, submits extra reports and reconstructs old Snapshot responses. That
   makes old tests convenient but obscures exactly which request and state a test
   actually exercised.
3. **Maintenance and response projection still overlap.** Named reads can write;
   slot settlement and top-up recovery appear at multiple phases. The central
   operation helper has to understand these effects and fishing's special refusal
   semantics.
4. **Generated messages lose their types inside the operation pipeline.** There
   are two legitimate response envelopes, but `any`, early RawMessage conversion
   and several encoders make their distinction implicit. Request payloads are
   also prepared twice for hashing and storage.
5. **Validation ownership is uneven.** Content now has a clear schema/domain split;
   HTTP validation still relies on field-name lists. Story marks and home placement
   remain parallel decision implementations with different representations and
   incomplete shared decision fixtures.

Start with honest test transport, verified deletion and two small policy dedupes.
Then improve phase ownership and extract one domain at a time. Avoid a generic
repository framework, universal actor/cache/limiter library or wholesale conversion
of domain models into protobuf models.

## Backend map

Counts are physical Go files/lines, including comments and alternate build-tag files;
generated code is counted separately. These are size indicators, not estimates of
compiled binary size.

| Area | Source files / lines | Test files / lines | Responsibility and dependencies |
|---|---:|---:|---|
| `server/cmd/glimway-server` | 8 / 737 | 10 / 852 | Flags/env, operator commands, HTTP/static/admin serving, shutdown; imports API, store, Habitica. No root `cmd/` exists. |
| `server/internal/api` | 85 / 20,943 | 84 / 28,931 | Routes/auth, gameplay SQL/services, commit/replay, response composition, presence/fight integration, sprite proxy; imports almost every backend domain. |
| `server/internal/store` | 20 / 3,126 | 23 / 3,334 | SQLite connection, migrations, normalized state, balances, mail returns, epochs/chunk cache, falls, operator persistence; imports rules/content/chunks/wilds/itemmove/profile. |
| `server/internal/rules` | 5 / 1,057 | 10 / 881 | Pure profile/XP/spend, wardrobe/magic and fight math; depends on content. |
| `server/internal/fights` | 6 / 2,318 | 5 / 1,740 | Room simulation, geometry, casting/flights, actor queues and shared scheduler; imports rules/content/chunks and generated presence v2, no SQL/HTTP. |
| `server/internal/wilds` | 20 / 4,777 | 11 / 2,004 | Deterministic generator v3, terrain/routes/detail, geometry, loot, packing; depends on content and generated chunk messages. |
| `content` | 25 / 3,729 | 18 / 1,624 | Embedded canonical JSON, generated type aliases, schema validation, cross-catalog checks and derived rules/indexes. |
| Other backend helpers | 16 / 2,533 | 11 / 1,556 | `chunks` ports/effective terrain/validation, `fakegen`, frontier, generator adapter, land, story, ports, profile, itemmove, worldchange, Habitica and storetest. |
| Generated Go | 43 / 43,926 | — | 24 content files in root `gen/`; 19 wire files in `server/internal/gen/`. Generated bulk is not hand-maintained duplication. |

Totals excluding generated code: **185 source files / 39,220 lines**, and **172
test files / 40,922 lines**. There is one root `go.mod` (`module glimway`); `server/`
is a directory in it, not a separate module. Root `gen/` is necessary because
root `content/` cannot import `server/internal/gen/` under Go's internal rule.
Imports form an acyclic graph; API is the composition point, not an import cycle.

The store uses one connection and immediate transactions (`store/store.go:45–52`).
Most gameplay queries live above it: **377 SQL execution/query call sites in 52
API source files**, versus **126 in 19 store source files**. This includes admin,
maintenance and build-tag code; it is not a count of unique SQL statements.

The ordinary mutation path is authenticate/maintain/load → lease → keyed replay →
report barrier/position → gameplay savepoint → apply → slots/persist →
maintain/project → store result/payload → commit → notifications. Current replay
combines the stored operation result with **current** PlayerState; it does not
replay the whole old response byte-for-byte (`api/op.go:78–101`). This differs from
the October 7 contract and must guide today's refactors.

There are **34 SQL migrations through 035**, three registered Go backfills, an
embedded history manifest and independent frozen-hash tests. Protobuf generation
is pinned by Go/npm tooling and committed output is checked by CI. Docker and Nix
build the same root-module entry point; the local npm server command uses `-tags dev`.

## What the October 7 round already addressed

| Earlier server finding | Current disposition |
|---|---|
| F1 error catalog | Implemented with the proto enum, adapters and source-scanning tests (`api/proto.go:21–36`, `api/error_codes_test.go:16–86`). Do not reopen the missing-code bug. Internal string use is a smaller remaining concern in finding 5. |
| F2 repeated HTTP test plumbing | Shared execution/decoding exists in `test_helpers_test.go`. The new concern is its implicit compatibility behavior, finding 2. |
| F3 giant API files / construction in login limiter | Implemented: `api.go` 193 lines, `items.go` 107, `homestead.go` 206, `presence.go` 491; `expansion.go` became `mutation.go`; construction lives in `api.go`; route metadata supplies log labels. Finding 1 concerns package ownership, not repeating those splits. |
| F4 gathering validation | Implemented: generated schema validation plus cross-family yield/season/seed checks (`content/gathering.go:23–76`). |
| F5 spend duplicates commit coordination | Implemented: `spend_op.go:15–75` uses keyedOp. Duplicate slot settlement survives in a newer pipeline, finding 3. |
| F6 HTTP/mail movement duplication | Substantially implemented in `itemmove`: maker shares, instances/decorations, ledger helpers and Warden definition selection. API and unattended returns now share primitives; keep their different authorization/return policies. Some unused currency wrappers remain, finding 8. |
| F7 naming and placement parity | Unicode control/name vectors implemented (`api/homestead.go:116–129`, `api/post_names_test.go`). Pure placement extraction and shared placement/removal decision vectors are still open, finding 6. |
| F8 migration manifest / upgrade fixture | Implemented (`store/migrations.go:12–88`, `migrations_test.go:17–95`, `upgrade_fixture_test.go:9–55`). Two newer tests still hand-run migration ranges. Live rule dependencies of historical backfills are explicitly documented; preserve the upgrade tests. |

The four October 7 architecture reports and `docs/cleanup-plan.md` were used as
context. The October 13 step-back synthesis was also read so its claim/fight bugs
are not repackaged here as new architecture discoveries.

## Findings

### 1. File boundaries improved; domain ownership is still concentrated in API

**Evidence.** Besides the package/SQL counts above:

- `api/fishing.go:32–268` contains fishery storage, cast rows, stock recovery and
  expiry policy; HTTP starts at `:335`, and PlayerState decoration is at `:634–649`.
- `api/wardrobe.go:26–144` combines SQL readers, pure slot/ownership decisions and
  state decoration; handlers begin at `:178`. Pure wardrobe rules also have their
  own `rules/wardrobe.go`.
- `story/story.go:1` claims ownership of quest/mark/paper/Echo rules, but quest
  prerequisites, triggers, gates and spending remain in the 267-line
  `api/quest_rules.go`; `api/story_ops.go` drives them.
- `api/open_map_paths.go:357–594` mixes a SQL-backed path-world cache and pure
  connectivity/search with route handlers and named-way persistence. Fight wake
  loads epoch/chunks/ground/camps in `presence_fights.go:443–478`.

**Impact.** Features that should be usable in a transaction outside HTTP depend on
private API helpers and transport-shaped failures. A newcomer looking in `story`
will miss quest policy; adding a non-HTTP inventory or fishing action pulls toward
API. Adding more same-package files no longer solves that problem.

**Before → after.** `HTTP handler → private SQL/rule helpers → fail(status, code)`
becomes `HTTP handler → fishing/wardrobe service using caller's tx → domain result
or refusal → HTTP mapping`. Start by giving existing helpers cohesive same-package
homes, then extract a self-contained slice. Fishing storage/recovery can accept
`*sql.Tx`, captured time and an injected log callback; keep item wear/credit/commit
in the caller initially. Wardrobe read/resolution is another small candidate.
Move pure quest decisions toward story/rules only after separating their HTTP
error mapping and item-write dependencies.

**Effort/risk:** M for one bounded extraction; L for several domains. Medium risk
at authorization, ledger and version boundaries. Caller retains transaction,
savepoint, commit and notifications. No service may open a nested transaction on
the one-connection store. Preserve exact refusal order, codes and status. Test the
extracted policy directly and retain existing API scenarios. Avoid creating an
interface per query or moving all gameplay SQL into an enlarged generic store.

### 2. The shared test transport silently repairs requests and reconstructs responses

**Evidence.** The 678-line `test_helpers_test.go` centralizes transport but does more
than its names imply:

- `body`, `:473–488`, converts old `progress` to `where` and old `op` to `action`.
  `rawHTTP`, `:558–575`, also removes progress and automatically calls
  `flushFixtureReport` for rest and selected item-use requests. That submits an
  additional real `/api/report` and mutates the op header (`report_fixture_test.go:13–44`).
- `decodeHTTP`, `:596–602`, runs every response through `testSnapshotJSON`.
  `state_bridge_test.go:14–102` maps generated PlayerState back into old Snapshot
  state, maintains a hand-written list of **33** result cases, flattens fields and
  drops some wrappers. It cannot expose every current field, such as independent
  vitals/place causal watermarks, in the old representation.
- `decodeDomainHTTP`, `test_helpers_test.go:647–675`, additionally reads inventory
  from the database and injects it into the decoded HTTP state. `request`,
  `:384–411`, has another pack-enrichment path.
- `profileBody`, `profile_fixture_test.go:11–33`, writes report acknowledgments and
  place directly into SQL. The helper documents that shortcut, but it is easy to
  mistake an endpoint test using it for report-order integration coverage.

**Impact.** An assertion can pass against state that was never in the response, or
after a prerequisite operation the test did not explicitly name. Missing-barrier
and old-request rejection tests need to avoid the normal rig to preserve their
preconditions. Maintaining a second result registry undermines the generated
contract's benefit. This does not invalidate the raw contract/reconciliation tests
already present; it makes coverage harder to understand and extend.

**Before → after.** `rawHTTP(body) → rewrite / extra report → response adapter / DB
enrichment` becomes `sendHTTP(exact bytes/body) → recorder`, plus explicitly named
scenario helpers such as `reportThenRest`, `seedAcknowledgedProfile` and
`assertPackInStore`. Decode current generated responses with protojson. Keep a
clearly named legacy projection temporarily while migrating one domain's assertions
at a time; delete the bridge after its last consumer. Consolidation of the HTTP
mechanism is already done and should not be redone.

**Effort/risk:** M, low production risk, medium risk of accidentally changing what
tests exercise. First migrate missing-barrier, malformed-input, reconciliation and
replay cases, proving their inputs are unmodified. Retain scenario counts and
existing injected-failure assertions. There are also 13 historically named API
suites (`fix*`, `round*`, `phase*`, expansion/homes2/review cleanup); move cases by
domain separately, not as part of this semantic helper change.

### 3. Give maintenance, apply and projection explicit ownership

**Evidence.** `begin` recovers stale top-ups and conditionally reloads the snapshot
(`mutation.go:15–45`); `maintainState` repeats that recovery before output
(`projection.go:67–97`). `purseTopUp` and `purseRead` also call it
(`purse.go:123`, `:710`). Some repetition is necessary across distinct transactions;
inside a normal begin/projection cycle it is difficult to see which phase owns it.
`itemsMutation` settles slots at `items.go:72–74`, then keyedOp settles again at
`op.go:132–134`. `readItems` dries flowers and refreshes inventory
(`item_views.go:139–145`, `assets.go:534–548`); `readRepairs` creates progression
rows (`repairs.go:48–84`).

The coordinator is a 157-line function with cyclomatic complexity 48
(`op.go:49–206`). Its held-refusal path retains callback/placement SQL but reloads
the snapshot instead of Persist, and explicitly forbids prior glim movement
(`op.go:139–175`, `http.go:21–39`). This is a meaningful fishing rule, not an error
that can simply be treated like ordinary rollback.

**Impact.** A call named read can alter inventory or world rows, and duplicate
settlement can grow each time another feature needs final state. A future callback
can accidentally rely on pre-maintenance data or violate the held-refusal balance
rule. The price is reasoning complexity and repeated queries under the one write
connection; no measured performance regression is claimed.

**Before → after.** Establish explicit `prepareState`, domain `apply`,
`settleDomain`, `persist`, and read-only `project` phases. First mechanically split
readRepairs/readItems maintenance from assembly while invoking both in the same
order and transaction. Document which maintenance must precede apply and which
must happen before output. Once that is visible, remove only demonstrably duplicate
slot/recovery calls. Replace hidden held-error signaling with an explicit internal
operation decision (success, rollback refusal, retained-writes refusal), initially
preserving the current branch implementation exactly.

**Effort/risk:** M; medium/high semantic risk. Preserve maintenance on eligible
refusals/replays, captured transaction time, snapshot reloads, version bumps and
the fishing cast closure. Moving all maintenance to the end is not equivalent.
Keep projection/turning, item conservation, held-refusal and lazy-recovery tests;
compare DB effects as well as responses. Changing whether GET performs maintenance
would be behavior change and is outside this refactor.

### 4. Preserve message types through one operation codec, while retaining both envelopes

**Evidence.** `keyedOp` accepts an `any` request and `any` callback result
(`op.go:33–49`). **11 call sites** use `protoResult` to erase a generated result to
RawMessage; the generic encoder lives unexpectedly in `homestead_wire.go:18–28`.
These serve the established `{state,result}` envelope. Other results use the
Envelope oneof (`op.go:235–260`). Encoding is distributed across `writeProto`,
`protoResult`, `mixedBytes`, `opResultBytes`, `saveOpIdem` and `replayResult`.
Oneof type lookup is repeated in `typedEnvelope` and
`reconcile.go:33–44`.

Request preparation similarly runs `requestBytes` in `opIdem`
(`op_idempotency.go:233–252`) and again in `savePayload`
(`reconcile.go:95–109`). Both remove `op`; one canonicalizes nested keys for a
hash, the other stores the payload. The descriptor/dynamic-key secret check is
thus also repeated on new operations.

**Impact.** The pipeline can no longer see a domain result's descriptor after its
early conversion. A new route author has to choose helpers correctly to get the
right envelope and stored replay representation. Repeated serialization and
reflection are secondary costs; the main cost is distributed contract knowledge.

**Before → after.** Replace implicit `proto.Message` versus RawMessage dispatch for
new internal results with an explicit typed result plus envelope style. A shared
codec validates and encodes it; the outer pipeline controls commit. Move the
generic codec out of homestead wire conversion, and share descriptor-to-oneof
lookup. Prepare a request once into `{hash, storedPayload}` using exactly today's
canonicalization and secret rules; pass those values to idempotency lookup/write.
Keep domain conversion helpers where they belong.

**Effort/risk:** M; medium. Preserve both public envelopes, zero/null/empty fields,
stored `Type`/`Value` representation, seven-day retention, exclusion of `op` from
identity and inclusion of `where`. Domain results currently have no stored type;
adding one without a compatible replay strategy would change persistence behavior.
Return the already validated encoding after commit where possible, instead of
encoding again. Forcing all responses into oneof case names would change the wire
contract and is not proposed. Pure domain types with methods/geometry are useful;
do not remove them solely because protobuf has similar fields.

### 5. HTTP validation and refusal policy still rely on string registries

**Evidence.** Content shape/range rules are in proto and cross-entry references in
loaders (`content/items.go:131–147`, `proto/glimway/content/v1/quests.proto:6–11`).
Fight ingress also runs schema validation (`presence_fights.go:541–548`). HTTP
uses `validatePayload`, a reflection walk keyed on message name, field name and
lists of strings (`payload_validation.go:26–56`): e.g. names `key`, `target`,
`client`, `seq`, `basis` trigger rules, while Habitica/LoginRequest are excluded.
HTTP schemas such as `proto/glimway/v1/op.proto:5–6` and
`operations.proto:11–15` do not describe those field constraints.

Refusals are passed as strings to `fail` (`http.go:12–19`), mapped back into the
generated enum (`proto.go:26–35`) and classified for terminal retention by another
string list (`op_idempotency.go:314–323`). The error catalog is already enforced by
a substantial AST source-scanning test; unknown enum mappings use the global
logger and test-only panic. This is effective protection, but indirect.

**Impact.** Merely renaming a proto field can alter which validation it receives.
Adding a field requires knowing the out-of-schema name lists. A typo in a refusal
is discovered by source tests/runtime conversion rather than the Go compiler.
These are maintenance hazards, not demonstrated missing validation bugs.

**Before → after.** Give common primitives explicit schema constraints where
semantics match, and keep message-specific/domain decisions in named validators.
Start with OpHeader/ReportBarrier rather than a sweep. Preserve `strictRequestJSON`
for canonical JSON spelling/numeric rules and retain the separate content-null
policy (`wire_request.go:9–89`, `content/protojson.go:30–50`); those transport
checks do different jobs. Gradually use typed ErrorCode internally, with one
wire adapter and an explicit terminal/retryable policy for existing codes.

**Effort/risk:** M, medium. Validation order, status/code and acceptance of optional
empty/null values must remain unchanged. Applying protovalidate indiscriminately
could change these; compare accepted/rejected fixtures before switching a message.
Keep upstream error mapping at its boundary. A typed internal refusal should
continue to produce the exact public string, not enum identifiers/numbers.

### 6. Consolidate pure decisions and add parity at decision boundaries

**Evidence.** Story mark knowledge is spread across API `questMark`/`questHasMark`
(`quest_rules.go:14–36`), store reconstruction (`state.go:46–65`), persistence
(`state.go:180–200`) and projection (`composition.go:54–73`). Found/defeated marks
move through separate slices and are recreated as marks on the wire. Each copy
needs to recognize the same namespaces, although stored quest-item rows and
`quest-item:<id>` references intentionally have different spellings.

Home placement is pure geometry/content policy but takes a generated HTTP request
and returns HTTP failures (`home_placement.go:128–210`). It mirrors the independent
TypeScript `checkPlacement`. Shared post-name vectors now exist, but
`scripts/homestead-vectors.ts:1–22` still generates post prices, not placement/
removal decisions; TS placement tests build their own cases
(`tests/homestead-content.test.ts:84–100`). Separate language implementations are
needed, but their examples should describe the same decisions.

**Impact.** Adding a mark namespace needs several representations updated. A home
rule can change locally and remotely without a shared rejected-case fixture
showing the divergence. Current unit tests are useful; this is the remaining
portion of October 7 F7, not another report of the fixed Unicode bug.

**Before → after.** Add small pure helpers for namespace parsing and live-state
membership/insertion/projection, retaining the current slice representation
initially. Extract `placementDecision(home, piece, placement)` returning a domain
reason, then map it to the existing status/code in the handler. Feed the same
fixtures through Go and TS for rotations, stable width, bounds, reserved tiles,
plants, light chains and removing/moving supporting posts. Do not attempt to make
HTTP failures part of a shared content model.

**Effort/risk:** M, medium. Pin ordering/deduplication of marks, rejected-case
precedence and post-chain behavior. Frozen migration 028 calls live rules/content
(`migrations.go:16–20`); keep historical upgrade fixtures separate and verify
them after changing helpers. Replacing all of rules.State with generated
PlayerState would be an L change and is not needed for this benefit.

### 7. A few small local abstractions have concrete multiple users

**Evidence.** Dupl's hand-written scan at a 70-token threshold identifies:

- `cottageHearth` and `workshop` repeat member lookup, tier query and identical
  failures (`crafting.go:14–30`, `assets.go:553–569`), differing only in tier 1/2.
- `writingDeskPlaced` and `woodpilePlaced` repeat the same membership/placed-piece
  query and differ in item/refusal (`crafting.go:34–70`).

The migration runner is shared, but range-advancement loops remain in
`store/indoors_upgrade_test.go:17–36` and `story_upgrade_test.go:115–134`, alongside
`newUpgradeFixture` (`upgrade_fixture_test.go:9–55`). API also reparses
`papers.json` into a private partial struct/index (`wilds.go:267–289`) despite the
validated generated catalog in `content/papers.go:19–56`.

**Impact.** These are small, concrete drift points: membership/query ordering,
future tier prerequisites, migration/backfill registration and paper source names
should not be maintained in parallel.

**Before → after.** Use two narrow helpers, `memberHomeAtTier(..., minTier)` and
`memberHomeWithPiece(..., piece, refusal)`, retaining their wrappers if callers
benefit from the domain names. Extend the existing upgrade fixture helper to
advance an already seeded database through a named range. Derive an ordered
source index from one validated paper list. Preserve JSON paper order: iterating
PapersByID's map instead would introduce nondeterministic grant/result ordering.

**Effort/risk:** S for each, low. Keep membership failure precedence and the same
SQL/backfill sequence. Prefer these proven helpers over deduplicating every short
handler or adding a configurable permission engine. Content loader entry points
share some boilerplate but expose useful family-specific APIs; a generic loader
framework is not justified by those few lines.

### 8. Remove the verified dead set; move test support to recognizable locations

**Evidence.** Deadcode with tests finds the same **11 unreachable functions** under
normal and dev tags. Ten are production declarations; one is the rig's `setDown`.
Manual reference checks also find exported port DTOs superseded by generated content.

| Candidate | Evidence |
|---|---|
| `NextTurning`, `ValidContentID` | `content/clock.go:114`, `content/workshop.go:25`; unreachable including tests. |
| `Unavailable.Chunk`, `WithReadTime` | `chunks/source.go:24`, `chunks/time.go:11`; current call sites use other sources/WithReadClock. |
| `itemmove.Stack`, `Decoration`, `Fitted` | `itemmove/itemmove.go:96–98`; no users including tests, although adjacent comments advertise one constructor per kind. |
| `Chunk.Walkable`, `crossPoint`, `ProtoSiteKind` | `wilds/chunk.go:75`, `geom.go:149`, `proto.go:25`; other effective/packed terrain and direct site-map paths are live. |
| `ports.PaperRule`, `ports.QuestStep` | `ports/ports.go:12–40`; no references outside their declarations, generated content types are used instead. |
| `echoMembers`, `worldChoiceAnswer`, `witnessMessage`, `rig.setDown` | Staticcheck U1000 at `api/witness.go:20`, `world_choice.go:38`, `witness_test.go:14`, `test_helpers_test.go:185`. |

Test-only production files include the delay/loss `fights/rig.go:9–50`, fakes
embedded in `ports/ports.go:78–163`, `chunks/source.go:28–52` and
`chunks/read.go:151–185`; store already offers the clearer `store/storetest` pattern.
`fights.Start` uses the **same** scheduler implementation for single-room tests
(`actor.go:89–95`), not a second actor implementation to delete.

**Impact.** Unused exported models look like supported architectural boundaries;
test fixtures mixed with runtime interfaces make it harder to identify production
responsibilities. The cost is navigation and misleading maintenance, not a claim
that all of this is linked into the release binary.

**Before → after.** Delete the unreferenced symbols after whole-repository checking;
move same-package fight Rig to a `_test.go` file. Put cross-package fakes in
`portstest`/`chunkstest`, depending on their parent package as storetest does.
Replace lane B/C/D ownership comments with domain ownership while touching these
files. Consider an ordinary single-room scheduler fixture instead of the private
`single` mode only if lifecycle tests retain their guarantees; this is optional,
not part of the cheap deletion patch.

**Effort/risk:** S for deletion; M for moving cross-package support, low risk.
Deadcode is reachability from this repository's entries, not proof about unknown
external consumers. Test-only pure functions, dev hooks and migration support are
not automatically dead. In particular, keep historical State.Quest/backfill
models and the actively tested profile/class normalization paths.

### 9. Retire compatibility remnants separately from behavior-preserving cleanup

**Evidence.** `proto/glimway/v1/presence.proto:7–82` retains 17 deprecated messages
and produces a 1,252-line Go file. Live presence uses v2 messages and the v3 socket
subprotocol (`api/proto.go:65`, `presence.go:8`); old messages remain in finite-number
encoder tests (`proto_test.go:21–22`). `WildsRegionResult` explicitly says its
endpoint is gone and it remains for Buf FILE compatibility
(`proto/glimway/v1/wilds.proto:79–87`). The rejection of an old progress-shaped
request retains a specific 404 branch (`decode_op.go:19–23`).

Rename compatibility is still active: `GLIMWAY_*` falls back to `FINGERSNAP_*`,
and default DB selection can choose `.data/fingersnap.sqlite`
(`cmd/glimway-server/main.go:30–58`). Shipped Docker/Nix/compose/deploy configuration
uses the current names; that does not prove the owner's local environment has
already moved. The rules.State JSON comment still describes obsolete ember names
despite the actual glim tags (`rules/rules.go:49–54`, `:73–76`).

**Impact.** Obsolete schemas and aliases imply broader support than the application
needs and add generation/learning surface. The comment gives newcomers the wrong
reason for the current domain model.

**Before → after.** Correct the stale comment in a behavior-preserving patch.
Remove test uses of v1 presence first by testing the same encoder properties on
current messages. Inventory remaining schema imports, reserve removed field names/
numbers where applicable, and account explicitly for main/release Buf baselines
(`buf.yaml`, `scripts/buf-breaking.sh`). Delete obsolete environment/database
fallbacks only in a deliberate clean-break configuration change with the owner's
path/config updated. Keep historical database migrations and valid upstream aliases
such as Habitica's `wizard` spelling.

**Effort/risk:** S per cleanup, M for contract retirement. Low code complexity,
medium operational/contract risk. Removing old proto definitions changes the
schema API even when the live socket is unchanged; removing fallbacks changes
startup behavior; removing old-request detection changes 404 to 400. These are
**behavior/contract changes**, not items for the behavior-preserving refactor lane.
Do not weaken all Buf breaking checks to permit one known retirement.

### 10. Split the remaining mixed hotspots when their domain is next touched

**Evidence.** Biggest hand-written files are `wilds/detail_v3.go` (1,157 lines),
`fights/room.go` (1,048), `api/wilds.go` (900), `presence_fights.go` (801) and
`open_map_paths.go` (775). Gocyclo reports 85 source functions above 20, including
`validateQuests` 101, `wildsRules` 99, CLI `run` 89, generator `dress` 89,
paper `Eligible` 87, login 76, presence reader 71 and `readRepairs` 62.
These are indicators, not a list of defects: data validators and generators
naturally have many branches.

Concrete concern mixing is visible in CLI `run`: flag/default parsing at
`main.go:69–147`, operator dispatch/queries at `:148–333`, and server setup/shutdown
at `:334–367`. `room.go` holds model/lifecycle, enemy AI, projection/diff and
attack/fall logic. Presence reader owns protocol validation, room transitions,
throttling and ability/fight dispatch under one lock (`presence_socket.go:237–431`).

**Impact.** Small changes require reviewing a long control-flow surface; file names
no longer guide readers to policy, persistence or protocol code. Blanket extraction
would also hide important shared invariants.

**Before → after.** Extract plain CLI config parsing and `runCommand`/`serve`
functions in the same main package; retain flag/env validation and command output.
Split room model/lifecycle, enemy stepping and combat/projection into same-package
files. Split paths into ground mutation, path search and named-way persistence
before the extraction in finding 1. For presence, extract validation and individual
dispatch methods with an explicit caller-held-lock convention; keep locking,
ordering and lifecycle ownership in one place. Leave the deterministic generator's
algorithm and validator rule order intact; split by concern only when it helps
an actual change.

**Effort/risk:** S–M per split, low for mechanical CLI/file moves, medium for
presence/room method extraction. Preserve queue order, lock scope and PRNG call
order. Replay/golden fixtures and targeted concurrency tests matter more than a
target line count. Never change generated `.pb.go` files by hand.

## Proposed refactor plan

Each row is a stage; each bullet-sized task within it can be its own PR. Stages
produce usable intermediate states and require no coordinated wire migration.

| Order | Independently shippable work | Value / effort / risk | Review and validation boundary |
|---|---|---|---|
| 1 | Delete the verified unused declarations; correct stale comments. Add a pinned, toolchain-compatible Staticcheck invocation to the existing Go quality workflow if desired. | Immediate clarity; S; low. | Whole-repo references, normal/dev compile/tests, vet. Separate genuine lint fixes from assertion redesign. |
| 2 | Introduce exact test send/decode primitives, leaving the explicitly named legacy adapters in place; migrate barrier/replay tests, then each domain, then remove adapters. | Makes later refactors assessable; M; medium test risk. **Do this before transaction changes.** | Verify exact outgoing bytes and raw current envelopes; API suite; preserve intentionally seeded SQL fixtures and fault injection. |
| 3 | Deduplicate member/tier and placed-piece checks; derive paper sources from validated ordered content; reuse migration-range advancement. | Concrete small wins; S each; low. | Existing crafting/workshop/paper and populated upgrade scenarios; no schema/history changes. |
| 4 | Separate domain maintenance from read assembly; map phase ownership; remove duplicate slot settlement first. Simplify state decorators into one explicit projector if the extraction benefits from it. | Smaller state reasoning surface; M; medium. | Same time, query order where material, versions, balances and refusal/replay effects. Keep the injected StateComposition seam for failure/transaction tests. |
| 5 | Prepare request identity/payload once; centralize operation encoding with explicit envelope style, retaining existing stored representations. | Reduces contract knowledge scattered through helpers; M; medium. | Current reconciliation/hash fixtures, secret checks, both envelope shapes, exact retained domain result bytes and final state watermarks. |
| 6 | Extract pure mark/placement decisions and shared placement/removal fixtures; migrate OpHeader/ReportBarrier validation and internal refusal types in separate changes. | Reduces rule drift; M each; medium. | Rejected-case precedence, TS/Go vectors, no changed accept/reject boundary, historic upgrades still pass. |
| 7 | Extract one bounded domain from API (fishing storage/recovery or wardrobe resolution); then quest policy ownership. Same-package path/room/CLI splits can accompany only their own domain changes. | Durable package clarity; M per domain, L cumulatively; medium. | Caller-owned transaction/commit, no HTTP dependency in extracted policy, preserved item/ledger rules and notifications. |

After touching shared operation/maintenance/presence machinery, run the relevant
race/concurrency suites as well as ordinary backend tests. Existing CI includes
API race testing and dev-route testing (`.github/workflows/ci.yml:39–51`). A shared
helper change deserves the whole API suite; a small pure extraction does not
justify rerunning unrelated end-to-end load scenarios on every iteration.

**Optional clean-break lane:** finding 9's schema/config retirements, after checking
release baselines and actual owner config. It is explicitly outside the
behavior-preserving stages above.

### What is not worth doing

- Do not unify loginLimiter, proofLimiter and presence ingress into a generic rate
  limiter. Fixed-window counts (`login_limits.go:58–92`), failure/inflight
  reservations (`proof_limits.go:21–71`) and socket token/abuse budgets have distinct
  semantics. Global/party budgets already reuse the fixed-window implementation.
- Do not generalize the fall writer, detached purse worker and fight actor into a
  common queue. A retained fall, a credential-bearing uncertain upstream payment
  and a bounded real-time command need different admission, retry and shutdown
  rules. Purse's separate idempotency is intentional (`purse.go:71–76`); putting
  it into the payload-retaining keyedOp pipeline would be the wrong cleanup.
- Do not replace the chunk LRU and fight lifecycle maps with a universal epoch
  cache. Chunk cache hits verify row existence in the caller's transaction
  (`store/chunks.go:198–241`); fight wake commits before publishing live rooms
  (`presence_fights.go:392–434`). Their validity and ownership differ.
- Do not route every `time.Now` through the gameplay clock. Operation time is
  deliberately sampled after the database lock (`projection.go:22–62`), whereas
  socket throttling, latency/duration measurement and upstream recovery waits need
  elapsed wall time. Name/document the clock at a boundary; a timer framework or
  unit conversion sweep is not warranted. Keep seconds versus milliseconds explicit
  at fight/storage boundaries.
- Do not squash/renumber frozen migrations or delete the pre-029 State.Quest path.
  Hashes freeze sources, not transitive live content/rules; populated upgrade tests
  remain necessary. There is no evidence supporting a runtime checksum enforcement
  rewrite or database reset.
- Do not create another Go module under server, hand-edit generated code, or
  regenerate all schemas merely to make this report. The current output placement,
  pinned generation, Docker/Nix source sets and build-tag separation are sensible.
- Do not pursue a global line-count/cyclomatic-complexity target. Preserve useful
  family-specific content loaders, deterministic generation, conservation tests and
  explicit domain policies. Their branch count is often the work being expressed.

## Verification and limits

Only the requested report was authored in the worktree; no source, module files,
generated output or git state was changed. No apps/computer use, live services,
browser tests or production accounts were used. Analysis scratch output and tool
state were kept in `/tmp` and permitted Go caches.

- `nice -n 10 go test ./server/... ./content/...`: passed all packages. The sandbox
  denied setting process priority (`setpriority: Operation not permitted`); the
  tests nevertheless ran and passed.
- `go vet ./server/... ./content/...`: passed.
- `nice -n 10 go test -tags dev -run '^TestDev' ./server/cmd/glimway-server ./server/internal/api`:
  passed; the same priority limitation applied.
- `go vet -tags dev ./server/... ./content/...`: passed.
- `go list` supplied the package dependency map. File/SQL counts came from direct
  source enumeration; SQL counts exclude tests and include alternate build tags.
- Installed Staticcheck could not decode Go 1.27 export data. A temporary
  `go run honnef.co/go/tools/cmd/staticcheck@v0.8.2` completed analysis and exited
  nonzero with **18 diagnostics**: 11 SA4006 unused assignments, five U1000 unused
  declarations, one S1038 test formatting suggestion, one S1011 loop simplification,
  and one SA4000 repeated-expression test warning. Most are test hygiene. The
  fishing repeated-call comparison (`fishing_test.go:1024`) expresses a determinism
  check; the same test also checks a concrete species/weight distribution. Its
  warning alone is not evidence of a broken production roll.
- `deadcode@v0.52.0 -test`, both normal and dev tags: the same 11 unreachable
  functions. Production-entry-only analysis found 39; many additional entries are
  intentional test seams, so they are not all deletion recommendations.
- `dupl@v1.1.0`: 20 groups at threshold 100 including generated output, only six
  groups after excluding generated-file groups (two source-loader groups and four
  test groups). A separate hand-written-only threshold-70 scan found 14 groups,
  including the four home prerequisite helpers. This is token-pattern matching,
  not a measured percentage of duplicated behavior.
- `gocyclo@v0.6.0 -over 20`: 177 function entries including tests; 85 in
  hand-written source. Used to locate mixed responsibilities, not to rank defects
  by score alone.

Go tools initially could not update the default sumdb state outside permitted
roots. Retrying with a temporary GOPATH and the permitted module cache completed
them without disabling checksum verification or changing go.mod/go.sum. Local
toolchain was `go1.27.1 darwin/arm64`; the module/build environment declares Go 1.26.
No Docker/Nix build, full race run, generated-output regeneration or TS/browser
suite is claimed. Findings describe maintenance costs and preserved invariants;
they are not claims of newly reproduced gameplay bugs.

## Done
