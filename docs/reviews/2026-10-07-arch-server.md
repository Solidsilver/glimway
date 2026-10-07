# Server and shared-rules architecture review

Snapshot: `f83ccde`. Scope: `server/`, `content/`, and the TypeScript HTTP contract. Estimates: S = one focused change; M = several focused changes; L = staged extraction. Findings are ordered by expected payoff relative to risk.

## Map

- `server/cmd/fingersnap-server/main.go` configures HTTP, Habitica, SQLite, shutdown and mail maintenance, and implements operator commands. Some CLI queries live here; others live in `store/admin.go` and `store/parties.go`.
- `server/internal/api/` contains **21 production files / 11,125 lines**, plus **26 test files / 12,831 lines**. This package owns routing, authentication, transaction coordination, SQL repositories, gameplay services, response DTOs, presence and the sprite proxy. File boundaries are descriptive, but package boundaries do not distinguish these roles.
- `store/` opens one SQLite connection with immediate transactions, WAL and foreign keys, applies 24 embedded migrations (numbered through 025), assembles/persists snapshots, and implements administration and unattended mail returns. Most gameplay SQL actually lives in `api/`.
- `rules/` contains progress/profile validation, XP accounting, sync, spend and merge rules. `land/` and `wilds/` contain deterministic generators. `content/` embeds canonical JSON, validates it at initialization, and exposes typed definitions and derived helpers. Dependencies flow toward rules/content; no existing import cycle was found.
- Login verifies Habitica **outside** the gameplay transaction, rechecks admission inside it, then creates a player/session or holds a pending sign-in for world choice. HTTP authentication slides session expiry. Play grants a per-player lease. Most gameplay writes use `keyedMutation`: authenticate/load → lease → replay → revision → optional progress → gameplay → persist → cache response → commit → notifications.
- `store.Load` reconstructs server-owned balances, flags and carried inventory from normalized tables. `Persist` strips them from writable progress and increments revision. Progress uploads accept stale story merges; sync requires a current revision. Origin and library donation have separate idempotent workflows.
- Presence is an in-memory WebSocket hub in `api/presence.go`; it reads authentication without sliding sessions or writing progress. Some social actions depend on live presence. GETs can perform maintenance writes: `begin` returns due mail, and item/home reads settle time-dependent state. With one connection, these reads serialize with writes.
- Client HTTP plumbing is `src/lib/api/{client,queue,errors,parse,types}.ts`; library HTTP has its own implementation in `src/lib/papers/library.ts`. Go types and TypeScript validators are handwritten. Shared JSON avoids duplicated balance data; algorithms still exist in both languages, guarded partly by committed vectors.

## Findings

### 1. Repair the error registry: existing UI messages are unreachable

**Evidence:** `src/lib/api/errors.ts:9` has 196 entries but only 183 unique codes. It omits `recipe-unknown`, `desk-required`, `woodpile-required`, `invalid-page`, `page-not-held`, `nothing-ready`, and `invalid-action`, emitted by `server/internal/api/crafting.go:47,67,104,170,177,359,377`. `errors.ts:294` maps unrecognized codes to `unknown`; `src/game/village.ts:123` already has specific messages for these failures. `api.go:397` also emits missing `login-user-rate-limited`. The test at `tests/api-client.test.ts` iterates the client list, so it cannot detect omissions.

**Change:** add the missing codes and remove duplicates first. Introduce an authoritative HTTP error catalog with Go constants and generated TypeScript codes, including dynamically forwarded rules/Habitica errors. Explicitly distinguish library, WebSocket and sprite errors; library currently handles its codes separately, so its missing entries are not the same UI bug.

**Size/risk:** S for the fix, M for catalog generation; low. **Guards:** feed every catalog code through `errorFromResponse`; exercise the desk/hearth/woodpile failures through their real client methods; fail on duplicate catalog entries.

### 2. Consolidate HTTP test plumbing, keeping scenario setup explicit

**Evidence:** near-identical request/recorder/JSON/status machinery appears in `api_test.go:84`, `expansion_test.go:56`, `phase5_test.go:42`, `items_test.go:48`, `crafting_test.go:31`, `repairs_test.go:36`, `worlds_test.go:38`, and `library_test.go:22`. Some helpers fail on malformed JSON; `request` and `craftReq` ignore decoding errors. `body` lives in expansion tests, `refresh/share` in homes2 tests, `keySeq/conserved` in items tests; unrelated suites depend on these files. `op` and `mend` even retain no-op `x.now.Add(0)` calls.

**Change:** create `test_helpers_test.go` for the rig, checked raw HTTP execution, a generic typed decoder, envelopes, keys and conservation assertions. Keep endpoint response types and specialized setup near their scenarios. Give mutation helpers an explicit choice about refreshing revision so stale-write tests cannot accidentally erase their precondition. Move historical `fix*/round*/phase*` cases into domain suites in separate mechanical changes.

**Size/risk:** M, low. **Guards:** run the entire API suite; preserve raw-byte replay assertions, malformed requests and injected-failure paths. Do not combine subtly different tests merely because their names look similar.

### 3. Split files by current responsibility, without changing package structure first

**Evidence:** `api.go` is 1,153 lines (routing at 114, login at 357, mutation support at 680, sync at 788, spend at 924, origin at 1011). `items.go` is 2,152 lines (instance persistence/wear, views, slots, gathering, planting, sellers and story rewards). `homestead.go` is 1,703 lines (deed lifecycle, queries, geometry, social membership and shelf transactions). `presence.go` is 900 lines. `newServer` unexpectedly lives in `login_limits.go:82`; common mutation/ledger helpers live in the historically named `expansion.go`.

**Change:** first make same-package moves: routes, sessions/login, sync/origin, mutation infrastructure; item persistence/wear versus gathering/plants/rewards; home lifecycle versus placement/shelves; presence hub versus authentication/protocol loops. Rename `expansion.go` to `mutation.go` and move construction out of login limiting. Route logging and dispatch currently maintain separate path lists (`api.go:119,178`); derive safe fixed log labels from the routing definition when touching routes.

**Size/risk:** S–M per split, low if mechanical. **Guards:** Go tests/vet; routing tests must retain fixed log labels and unknown-route privacy. Avoid introducing interfaces or new packages just to shorten files.

### 4. Make gathering validation as strong as the other content loaders

**Evidence:** `content/gathering.go:83` checks positive chop caps but not break/dig caps, and checks nonempty actions/yields without validating action membership, yield item IDs, numeric ranges, chances or seed definitions. Some missing checks exist only in `gathering_test.go:25`. `api/items.go:1639` rolls `y.Max-y.Min+1` and ignores the success result of `content.ItemFor(y.Item)`. TypeScript uses a cast at `src/lib/gathering.ts:54` rather than a loader. Other content modules expose `ValidateItems`, `ValidateCrafting`, etc.

**Change:** add `ValidateGathering`, apply it during loading, and validate all caps, actions, known definitions, seeds, ranges and probabilities. Share malformed-data cases across Go/TypeScript, or validate canonical content once in a build check with equivalent runtime bounds. Keep current valid data unchanged.

**Size/risk:** S–M, low. **Guards:** negative fixtures for each omitted check plus existing gathering/season tests. This prevents future content edits from failing during gameplay or creating invisible unknown stacks.

### 5. Reuse the keyed commit boundary for spend, preserving its contract

**Evidence:** `api.go:924` repeats lease/replay/revision/upload/persist/cache/commit logic already in `expansion.go:13`. Spend uses operation name `spend` and top-level `outcome`; generic mutations use URL operation names and `result`. Inside item mutations, `items.go:1000` settles slots, then `keyedMutation` settles them again at `expansion.go:46`.

**Change:** separate the shared commit coordinator from response assembly, allowing spend's existing operation name and response shape. Separate settlement from projection so the item response is built after one settlement. Document the intentional workflows: origin has no play lease, library donation changes no gameplay revision/ledger, progress merges stale story, and sync applies verified-profile accounting.

**Size/risk:** M, medium. **Guards:** preserve exact replay bytes, replay under a replacement lease, stale-revision rejection, all-or-nothing uploaded progress/rewards, and notifications only on newly committed actions. Do not rename stored idempotency namespaces or force the exceptions into a flag-heavy universal handler.

### 6. Share item movement primitives across HTTP and unattended mail

**Evidence:** `api/assets.go:113,169,353,386` owns stack and asset transfers with ledger updates; `store/mail.go:16` separately restores stacks, moves instances/decorations, checks Warden conflicts and writes ledger/revision rows. `api/items.go:453` and `store/mail.go:203` contain the same remember-fitting SQL-list builder. Currency ownership strings are assembled in `workshop.go:106`, `homestead.go:256,1614`, and `store/mail.go:111,145`.

**Change:** extract narrow transaction-level item primitives and currency construction into a package usable by both API and store, depending only on content/SQL. Start with definition lookup and stack restoration; migrate one transfer path per change. Keep return policy explicit: unattended second-Warden returns go to the personal chest, while ordinary receipt can refuse; unattended returns bump sender revision without touching last-seen time.

**Size/risk:** M–L, medium/high; high payoff but after mechanical cleanup. **Guards:** existing maker/fitting conservation, mail recall/expiry/removal, lost-deed and world-move tests; check both participants' revisions and all relevant location currencies, not only pack totals. The current `conserved` helper at `items_test.go:155` covers pack/fittings, not every transit/chest/shelf currency.

### 7. Extend rule parity to decisions, not just generated data

**Evidence:** `api/homestead.go:1048` mirrors `src/lib/homestead.ts:233` for placement; `homestead.go:682` mirrors `homestead.ts:323` for names. Go rejects every Unicode control with `unicode.IsControl`; TypeScript only rejects U+0000–001F and U+007F, so U+0080 is accepted locally and rejected remotely. Existing homestead vectors replay land rows and post prices (`server/internal/land/land_test.go:14`), not placement/name results. Quest stages/items and presence close codes also repeat in Go/TypeScript (`rules.go:38`, `src/lib/state.ts:79`, `presence.go:26`, `src/lib/presence.ts:41`).

**Change:** extract pure Go placement decisions from HTTP failures, then replay shared fixtures for placement/removal/name cleaning, disconnected post chains, plants and bounds. Choose and document one Unicode naming policy. Put stable enums/constants in shared content or generate both definitions. Retain separate language implementations where runtime needs justify them.

**Size/risk:** M, medium. **Guards:** vectors checked for freshness in TypeScript and replayed in Go; preserve existing backend/land/wilds/calendar/items vectors. Name-policy changes need explicit accepted/rejected Unicode cases.

### 8. Make migration history independently verifiable

**Evidence:** `store.go:93` applies ordered migrations atomically and rejects late insertion below the newest applied name: good safeguards. However, `schema_migrations` stores only names/times, so changed SQL under an applied name is silently skipped. Migration 003 additionally calls Go backfill code (`store.go:139`, `loss_reference.go:13`). Migration 010 explicitly deletes decoration parcels and resets homes (`010_homesteads_v2.sql:1`). Upgrade fixture builders repeat raw-SQL migration loops in `items_test.go:24`, `mail_test.go:19`, `gifts_test.go:18` and `party_worlds_test.go:23`; `store_test.go:50` hardcodes 24.

**Change:** add a checked-in immutable history manifest, including the Go backfill, and a reusable fixture builder that invokes registered backfills. Freeze historic files; use forward migrations for new behavior. Verify expected migration names against the manifest rather than only a count. Add a populated pre-010 fixture documenting precisely what that deliberate reset loses/preserves. A skipped number is not itself a fault; do not renumber or squash shipped history.

**Size/risk:** M, low for fixtures/manifest, medium for runtime checks. **Guards:** existing upgrade/concurrent-open/out-of-order tests; fresh-versus-upgraded schema comparison, foreign-key checks, and preserved balances/ledger/replay responses. Existing databases have no checksums, so do not pretend newly backfilled hashes prove their original SQL.

## Keep as is

- One immediate transaction contains authorization, asset changes, audit and cached response. Replay precedes revision validation but follows lease validation, with only lease excluded from the request hash (`api.go:891`). Preserve these semantics.
- Canonical JSON plus deterministic cross-language vectors is a strong model. Typed content loaders fail early; normalized server authority is reconstructed rather than trusted from uploaded saves.
- Habitica verification happens before opening the gameplay transaction; credentials are cleared and not persisted. Privacy tests deliberately use recognizable secret markers.
- Presence keeps database queries outside its mutex, bounds ingress/queues, checks account generations, and owns hijacked-socket shutdown. Keep it advisory and read-only; a file split should not simplify away these concurrency protections.
- Fault injection, concurrency races, exact replay assertions and ledger conservation tests are valuable behavior coverage, not redundant bulk.

## Cross-area notes

- UI/game: repair missing error recognition before changing existing messages. `parse.ts` (998 lines) and `types.ts` (842) can be grouped by contract domain. Future tests should feed actual Go response fixtures into TypeScript parsers; most client tests hand-build JSON.
- Client networking: `papers/library.ts:121` duplicates fetch, timeout, cookies, JSON decoding and error handling from `api/client.ts:215`. Share transport while retaining library-specific result parsing, including the entry on a 409; its current “any 409 means already shelved” mapping also hides idempotency/world-choice conflicts.
- Tooling: define a supported server version before removing older-server defaults and legacy invitation normalization. Those compatibility paths are intentional, not proven dead code.

## Proposed order

1. Add missing HTTP error codes, deduplicate the list, and add failure-path client tests.
2. Extract common test HTTP execution/decoding without altering scenario behavior.
3. Split `api.go`; rename mutation infrastructure and relocate construction.
4. Split item/home files by responsibility, one mechanical move per review.
5. Add complete gathering validation and malformed-data fixtures.
6. Add naming/placement parity fixtures and extract pure placement decisions.
7. Consolidate spend's commit coordination, retaining its wire shape and stored operation name.
8. Add migration manifest/fixture support; begin shared item-transfer extraction afterward.

## Verification

All Go server/content package tests passed; API/Habitica tests required sandbox-approved temporary localhost listeners. `go vet ./server/... ./content/...` passed. `golangci-lint` with only `unused` enabled reported zero issues. The installed standalone Staticcheck could not read the Go toolchain's export-data version. Six focused TypeScript suites passed **73 tests** (API client/progress, items, homestead content/land and Wilds vectors). No Playwright, apps, source edits or commits.
