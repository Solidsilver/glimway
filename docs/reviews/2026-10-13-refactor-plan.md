# Combined refactor plan — October 13, 2026

The plan makes the tests describe the requests and responses actually used, removes
verified dead code, and gives each operation, maintenance phase and durable queue a
clear owner. It combines the server and client boundary work instead of asking each
side to invent another adapter. There are **14 behavior-preserving stages**. Each
stage has a usable stopping point; larger stages contain a sequence of separately
reviewed patches. Component extraction ships as three stages: inventory card, HUD
actions, then App connected lifecycle. Folder changes come last.

The owner must decide separately whether to retire guest mode, reset old storage
names or queued entries, and remove obsolete schema/configuration compatibility.
Those are clean breaks, not prerequisites for starting the refactors. The default
plan preserves queued work, both public response envelopes, startup fallbacks and
existing acceptance/refusal behavior. **C5 is already decided: the server does not
check held mode.** No stage adds that check.

## Basis and scope

Inputs: [server review](2026-10-13-arch-server.md),
[client review](2026-10-13-arch-client.md), and
[step-back synthesis](2026-10-13-step-back.md), especially C18.
Evidence below was checked against this worktree at
`8c6315339c7b080a86b4c3ef4925a8de0ea7f1d2`; the reviews describe different earlier
snapshots. `B1–B10` denote server findings, `F1–F9` client findings.
Paths and line numbers refer to this worktree, not a future merged dev.

Start implementation **after** `exp/sb-{server,client,ui,tests}` merges into dev.
Re-read affected code and tests then and subtract anything already done, including
any optional C18 extraction that those lanes actually deliver. C1–C17, C19 and C20
belong to those lanes: fight recovery/lifetime/metrics/colliders, storage commit
bugs, cooldown/copy/modal/inertness fixes, E2E fixtures/selectors/performance/evidence,
diagnostic policy and current-state documentation are not new work here. Preserve
their fixes and tests. C17's final diagnostic policy is an input, not a decision to
reopen. The extraction work below does not claim to resolve the unsure layout,
focus, onboarding or transport-reset causes in step-back.

S = focused patch; M = several related patches; L = a multi-patch extraction or
migration. These are scope estimates, not elapsed-time promises. Parallelism below
means separate implementation branches without shared edited files, followed by
independent review; it is not permission to skip dependency validation.

## Verified frontend findings

| Finding | Disposition against code | Evidence, limits and consequence |
|---|---|---|
| **F1: two operation pipelines** | **Confirmed**, with a trust qualification | `src/game/link.ts:126–238` has paths, reverse path parsing, dispatch and body switches; `:306–332` has a second, 21-kind typed registry. `src/lib/api/operations.ts:99–119` repeats typed paths. The five schema-bypassing mutations are woodpile, mend, world-move, world-leave and donate (`link.ts:161–197,220–236`); their generated schemas exist in `homestead_pb.js`, `village_pb.js` and `world_pb.js`. `sendHead` sets mutation `trusted = true`, versus checking the typed result case (`:1238–1257`). **Rejected if read as “no validation”:** domain parsers validate their results/state, and the later state comparison/reconciliation still runs (`:1267–1271`). Mixed answers lack a oneof discriminator; do not invent one silently. Combine with B4 in stage 4. |
| **F2: repeated Link façade and outcome shapes** | **Confirmed** | Link remains 2,416 lines; 21 `toJson(create(...), {alwaysEmitImplicit:true})` façade fragments remain. `HomeRead`, `MutateResult`, `WildsOutcome` and API `Result` use value/res/result, while quest/spend expose narrowed nullable codes (`link.ts:84–98,240–247`; `lib/api/errors.ts:36`). Fishing and Wilds methods repeat key/where/submit/case checks (`link.ts:1961–2068`). Keep fall/report, mount/saddling, profile/credential and caller-key exceptions explicit. Stage 5 precedes C18 queue extraction. |
| **F3: guest mode unreachable in production, live in tests** | **Confirmed reachability; clean-break classification** | Whole-source constructor search finds only `ui/account.ts:134`, after constructing Link at `:108–128`; Session still accepts/defaults a nullable Link (`game/session.ts:58–73`). Linkless constructors remain in stores, quests-session, unmoored and sound tests. Local save/applySynced paths remain (`session.ts:115–160,493–640`), as does ConnectGuide's local sync after `if (session.link)` (`ui/ConnectGuide.svelte:284–354`). This is evidence of no production constructor, not permission to delete every nullable-looking branch: lifecycle/unattached-Link guards have other meanings. Guest retirement needs owner OK (G below). Old-name keys are separate compatibility changes, including held/papers-seen keys omitted from the review's examples. |
| **F4: hand-projected API views, duplicated decoding and pass-through client** | **Confirmed core; rejected blanket deletion** | Homestead/items/village/world contain 17/10/24/6 exported interface/type declarations; `types.ts` adds Snapshot and legacy views. Exact “85 views” mixes declarations/re-exports and is not a useful target. `parseSnapshot` constructs GameState (`api/parse.ts:50–57`), domain parsers call it, and mutation handling reads `res.player` (`link.ts:1242`). Decoder helpers repeat in homestead/items (`:188–208`/`:123–143`); operations' wrapper additionally records HTTP status 200. `ApiClient` repeats raw calls (`client.ts:401–446`); client-id claiming occupies `:511–662`. **Rejected:** the parser shim has no consumers. Tests import `parseItemsResult`, `parseItemsAction`, `parseStorage` and world parsers through it (`server-first-contract`, `api-client`, `items`, `world-moves`). Migrate consumers before deletion. The two PaperRule definitions do match, but TS story ports are live. Stage 4 pairs view narrowing with B4's typed results. |
| **F5: test types/hooks/helper drift** | **Confirmed; scope estimate increased** | Neither tsconfig includes `tests/` or `scripts/`; `npm test` strips types. A fresh no-emit TypeScript probe including src/tests/scripts reproduced **80 diagnostics, all in tests**, including woodpile's stray lease and Enemy fake drift. These span 30 files: M for fixes, not assured S. There are no FsHooks references in E2E and 332 `window as unknown as` occurrences. `e2e/helpers.ts:18–33` redeclares Hooks and an ExitView missing optional side/kind from `game/dev-hooks.ts:30`. The four cited UI hooks are absent from FsHooks; seven UI registration sites bypass expose. Helpers such as twoPlayers/shot repeat. Existing `expose` has scene cleanup, but calling it without a scene supplies **no UI teardown** (`dev-hooks.ts:233–254`): retain explicit component/service disposal. Stage 1. |
| **F6: hand-written read-order marks** | **Confirmed repetition; correctness not re-proved** | Items uses private order/viewSeq (`game/items.ts:36–37,70–90`); Homesteads has lane/home/row-group marks (`homestead.ts:144–153,249–342`); Wilds has six maps plus frontier/start/success marks (`wilds/store.ts:452–473`); materials has a shared clock and per-Link balances (`materials-order.ts:24–74`). Focused order suites pass. That does not establish every ordering rule as universally correct. A helper is optional when a store is touched; it must preserve equal-mark comparisons, partial rows, mirror ownership and reset semantics. No standalone store-framework project. Stage 3, after stage 1. |
| **F7: repeated art/cards/catalog access/build inputs/hash/depth/copy** | **Confirmed examples; rejected some proposed shortcuts; other payoff unsure** | Glims/purse art share manifest/frame/icon loops (`game/glims-art.ts:30–51`, `purse-art.ts:35–56`); Guides/Quests step markup/CSS and crafting panels repeat concrete shapes. Raw catalog access exists in `lib/homestead.ts:2–13`, `workshop.ts:91–98`, `rooms.ts:77`, `clock.ts:58`. **Do not replace these by direct full-loader imports:** items already imports homestead; residents imports clock; story-tables imports rooms/residents. Naive replacements create initialization cycles. FIND_RULES/designedRule are generator/test inputs, but **rejected:** papers design as a whole is build-only. Runtime PAPERS calls designedSection and retains DESIGN/source/hints (`content/papers.ts:340–348`; `ui/PapersTab.svelte:14–15`; `game/papers.ts:32`). Ground-heal is build/test-only. **Rejected:** unconditional map hash substitution. Chunk hashing folds numeric cells, and overview hashing folds JS character codes (`ui/map-renderer.ts:77–81,182–185`); `lib/hash.ts:54–67` hashes UTF-8 strings/array values. Prove equality for the actual input domain first. Depth/copy moves are optional local improvements, not a global sweep. No screenshot/bundle-size benefit was measured. Stage 3 or the relevant UI stage. |
| **F8: dead/vestigial code beyond the word guard** | **Confirmed mechanism/candidates; tool totals unsure** | `tests/dead-exports.test.ts:6–16,53–69` explicitly counts words, including comments/coincidental names. `wilds/ops.ts:68` untrack has no actual call; Link dispatchMutation/retryDelay are used only internally (comments also name dispatchMutation). `game/wilds/coords.ts:22` re-exports names whose real external users import `lib/wilds/coords.ts`. Some proposed “dead” parser re-exports have test consumers (F4), and save/sync/guest code is reachable from tests (F3), so neither is an immediate unused-function deletion. Knip's 152/257 totals were not re-run here and are not an approved delete list. Fonts are imported in `src/app.css:1–3`; do not remove them. Stage 2 verifies symbols by resolved imports/reachability, retaining intentional deps types and guard allowlist entries. |
| **F9: mixed folder ownership and game→UI imports** | **Confirmed navigation problem; counts/purity qualified** | Link/Session/domain stores coexist with Phaser code. Both game→UI imports still exist (`entities/interactables.ts:15`, `scenes/world-controls.ts:10`). There are 174 game TS files; a direct import/export scan finds 95 without direct Phaser imports, rather than the report's 92. That scan is **not proof of transitive Phaser independence**. Fight/presence responsibility legitimately crosses rendering/network/rule boundaries. Re-home modules by dependencies and owner, with folders last; don't move every no-direct-Phaser file automatically. Stage 14. |
| **C18: queue and three UI extractions** | **Confirmed remaining ownership work** | Link owns claim/fences (`:915–978`), records/persistence/channels (`:994–1059`) and drain/send/disposition (`:1187–1295`); existing outbox and ReportPump modules do not own the whole durable lifecycle. InventoryPanel's card/action/selection state is embedded at `:74–90`; HUD duplicates desktop/mobile action clusters; App combines connected session swap, presence/game lifetime and update settlement (`:496–551`). Sizes remain 1,511/1,295/1,393 lines, which alone imply no defect. Stages 10–13, preserving the bug lanes' fixes. |

The rejected parts above narrow the remedies; they do not erase the confirmed
structural findings. No new player-facing bug is asserted by this table.

## One staged plan

The numbering expresses priority and dependencies, not a requirement to serialize
unrelated work. Stage 1 and stage 2 start first. Each patch must leave existing
callers working; remove transitional adapters only after their last consumer moves.
For verification during implementation, run named Node/Go suites with `nice -n 10`
and no dependency installation. Keep existing CI production build, generated-output,
Buf, race and dev checks. Browser/spec references below are **future CI acceptance**
for implemented patches, not commands authorized or run in this report worktree.
Avoid full E2E runs per patch.

### 1. Make test inputs and assertions honest

**Scope:** B2/F5; Go `api/test_helpers_test.go`, `state_bridge_test.go`,
report/profile fixture helpers and consuming tests; `tsconfig.tests.json`, test
fakes, package verify/CI wiring; FsHooks, a typed E2E hook bridge and UI registrations.

**Done:** exact request sender accepts unmodified bytes/bodies with no automatic
report or response repair. Scenario helpers name report-before-rest/SQL seeding;
wire assertions decode generated messages and DB assertions are separate. Introduce
explicitly named legacy adapters, migrate barrier/malformed/replay/reconciliation
cases first, then domains, then delete bridge/enrichment. Fix the 80 diagnostics
without assertions-as-casts or suppressed errors and add a permanent no-emit test/
script check. Add missing FsHooks and typed page.evaluate access; retain DEV gating,
replacement-owner protection and UI cleanup. Consolidate only helpers with matching
semantics; migrate historical suite names later with their domain.

**Size/risk:** L total (Go transport M, TS types M, hooks S–M); no production
rule changes, medium test-meaning/lifecycle risk. Ship these as separate patches.
**Verify:** full API tests after shared rig changes; exact outgoing bytes, raw both-
envelope decoding and explicit report counts; preserve scenario/fault-injection
coverage. Run source/test/E2E tsc, svelte-check, `npm test`, scene-end tests and
changed-spec CI acceptance. **Dependencies/parallel:** starts now after bug-lane
merges. Go tests and TS types can proceed separately; hook work shares UI files with
11–13 and E2E helpers with the tests lane, so serialize those edits.

### 2. Delete only the verified dead set and clarify test support

**Scope:** B8/F8 and stale ownership comments: content/chunks/itemmove/wilds/ports,
unused API declarations; parser re-export consumers; in-file-only value exports,
`wilds/ops.untrack`. Do not touch guest retirement yet.

**Done:** whole-repository and normal/dev/test reachability confirm each deletion;
remove the server review's candidate set only if still unused after merges. Drop
unneeded value exports, migrate test shim imports before deleting the shim, and
keep useful exported deps/result types. Move same-package fight Rig to `_test.go`
only after confirming no cross-package consumer; cross-package fakes go into
`portstest`/`chunkstest` following storetest. Keep historical State.Quest models,
normalization paths, intentional test seams and the current scheduler.

**Size/risk:** S deletion patches, M for support moves; low, with build-tag/import
risk. **Verify:** resolved imports and references, source/test tsc, svelte-check,
`npm test` including dead-exports; normal/dev Go tests and vet. Static tools must
support the current toolchain; their production-only output is not a delete list.
**Dependencies/parallel:** can start alongside 1 in disjoint production files;
serialize test_helpers/parser/test-consumer edits with 1 and codec edits with 4.

### 3. Reuse narrow policy, catalog and local presentation helpers

**Scope:** B7/F7 plus conditional F6; membership/tier/piece checks in API
crafting/assets, store upgrade-range fixtures, API paper-source index; TS decoder
primitives, catalog metadata, icon passes and build-only helpers.

**Done:** reuse the two proven member helpers with original failure precedence;
advance seeded upgrade fixtures through the existing migration runner; derive Go
paper sources from the validated **ordered** list. Share identical decode primitives
while keeping wrapper error/status and filtering behavior distinct. For TS catalog
reads, first isolate a lower-level validated shape/index to avoid items↔homestead,
clock↔residents and rooms↔story-tables initialization cycles. Preserve ordering and
rejection semantics. Move only truly build-only ground-heal/find-rule extras; retain
runtime paper styles, sources, hints and sections. One icon-loop extraction preserves
keys/density/fallbacks. Hash reuse requires equal-output fixtures, including non-ASCII
and cell inputs; otherwise keep the existing folds.

An optional ordering patch, only when Items/Homesteads is next touched, may factor
mark storage/comparison. Characterize `<` versus `<=`, ask versus landing marks,
partial row groups, per-Link mirrors and resets first. Keep Wilds epoch/start/goodSeq
logic explicit. Small card/CSS/depth/copy reuse follows its component change, not a
new global cleanup campaign.

**Size/risk:** S each, M collectively; low for helpers, medium for catalog/order
changes. **Verify:** crafting/papers/upgrade Go suites; API decoder tests,
`papers`, `loader-vectors`, `clock`, `residents`, `atlases`, `runtime-art`,
`wilds-map-render`, `materials-order`, `home-items-order`, `stores`,
`wilds-runtime`; committed vectors unchanged except deliberately added cases.
Art/card changes need texture/screenshot CI acceptance. **Dependencies/parallel:**
after 1 for affected tests. Backend helper patches can parallel frontend stages
4–5 on disjoint files; decoder primitives must land before 4, and ordering/store
edits serialize with 4's caller migration. Independent art work can parallel 6–10.

### 4. Own the operation boundary once, on server and client together

**Scope:** B4/F1/F4; server op/idempotency/reconcile/proto/homestead-wire helpers;
client operations/requests/raw client/domain decoders/Link routing/outbox record
normalization and shared contract fixtures.

**Done, in separately shippable patches:**

1. Pin representative request/result fixtures across both implementations, then
   type the five remaining mutation requests using generated schemas. Preserve
   currently emitted defaults/omissions and request identity; schema conversion is
   not permission to normalize previously frozen bodies.
2. Server retains `proto.Message` plus explicit envelope style until one codec
   encodes it. Share descriptor→case lookup; prepare hash and stored payload once
   using existing canonicalization, secret checks and header removal. Preserve
   stored Type/Value, including mixed results' absence of a stored proto type.
3. Client has one route specification (method, path parameters, request/result
   schema and envelope style) used by the transport and Link, with compile-time
   schema/result relationships. Keep the server's own route registry language-local;
   fixtures prove agreement rather than introducing a cross-language generator.
   Replace the mutation tables/switch duplication incrementally. Add route keys to
   new records while retaining an explicit reader for old path-based entries and
   path parameters. Never rewrite their frozen body/key. Keep compatibility until
   the expiry/upgrade policy permits removal, or seek the separate Q decision.
4. Domain answers carry typed PlayerState/result through adoption, avoiding an
   unused GameState projection. Migrate callers one domain at a time; keep tuples,
   absence/null distinctions and validations that callers actually need. Remove
   unused Snapshot paths only after migrating account/session consumers too.
   Keep predictor `gameStateOf`. Narrow the pass-through ApiClient while preserving
   its serialization queue, raw/unload surface and lease-free session calls.

The mixed `{state,result}` and Envelope oneof remain distinct public encodings.
Do not add a discriminator, migrate all mixed routes into oneof, strengthen malformed
response/request acceptance, or change request bytes/hash under the refactor label.
Mixed results get their existing route-specific validation, not a fictitious case.

**Size/risk:** L (bounded M patches); medium/high at replay, validation and persistence
boundaries. **Verify:** all API tests, `op_test`, reconciliation/secret/proto fixtures;
TS `api-client`, `server-first-contract`, `proto-contract`, `outbox`, all `link*`;
shared raw fixtures for both envelopes, zeros/nulls/empty collections, error spelling,
current-state replay, missing/wrong typed cases, same-version conflict, credentials,
old queued records and dynamic path IDs. Preserve seven-day server/six-day client
retention; `op` excluded and `where` included in server hash; preserve `sameRequest`
(which separately ignores where/header), items/use barriers and pending/resolved
outcomes. Future village/homestead/items CI acceptance; normal/dev/race gates and
Buf/output checks. **Dependencies/parallel:** after relevant 1–3 patches. Server and
client subpatches may run in parallel when fixtures and interfaces are fixed, but
this is one joint review boundary. Serialize with 5, 6, 8 and 10 on shared operation/
Link files; it can parallel component stage 11.

### 5. Shrink Link's façade and converge internal outcomes

**Scope:** F2; Link operation methods and their caller groups, API error/outcome types.
**Done:** one schema-derived operation helper supplies key/header/where, submission,
case validation and refusal mapping. Each migrated method preserves offline/barrier/
key options, result-specific checks (e.g. fishCast.cast) and side effects. Keep fall's
report boundary, mountOut's saddling and profile's ephemeral credentials explicit.
Converge success payload names group by group with temporary adapters; preserve
nullable/narrowed quest/spend behavior at callers until their migration lands.

**Size/risk:** M; low/medium caller and prediction risk. **Verify:** all affected
link suites, especially fishing/companions/wardrobe/failures/reports/durability and
camp-fights; typecheck callers and assert identical event/refusal/pending behavior.
**Dependencies/parallel:** after 4's route/type foundation. Parallel 6–9 backend
work; conflicts with 10 queue and 13 connected-lifecycle edits to Link/callers.

### 6. Make server maintenance, apply and projection phases explicit

**Scope:** B3; mutation/projection/items/item views/repairs/purse/op coordinator.
**Done:** mechanically separate write maintenance from view assembly with identical
transaction/time/order first. Record which maintenance runs before apply, before
refusal/replay output and before projection. Remove only proven duplicate slot/
recovery work. Represent success, rollback refusal and retained-writes fishing
refusal explicitly, initially retaining their current branches. Projectors become
read-only after required maintenance; GET endpoints still maintain where they do now.
Keep StateComposition injection, snapshot reloads and callbacks/notifications.

**Size/risk:** M; high semantic risk despite small mechanical moves. **Verify:**
whole API suite plus turning/projection, repairs/slots, lazy top-up recovery,
fishing held-refusal/replay and conservation/failure tests; compare DB rows, versions,
balances and causal watermarks as well as responses. Capture time after obtaining
the database lock. Run API race and dev gates. **Dependencies/parallel:** after 1
and 4's server coordinator changes; parallel 5 and 11–12. Serialize with 8–9 when
those touch op, projection or fishing helpers. Never move all maintenance to the end.

### 7. Share pure story and placement decisions across representations

**Scope:** B6; API quest mark/home placement, store state reconstruction/persistence,
composition; TS home decision implementation; shared placement/removal fixtures.
**Done:** small mark parse/membership/insertion/projection helpers preserve namespaces,
ordering/deduplication and distinct quest-item row/reference spellings. Pure home
placement/removal returns domain reasons; HTTP maps them to today's status/code.
Extend decision vectors beyond post prices with rotations/stable width/bounds/
reserved tiles/plants/light chains/supporting-post move/removal and refusal precedence.
Go and TS stay independent implementations consuming the same cases.

**Size/risk:** M each, M–L combined; medium at rule precedence/historical upgrades.
**Verify:** homestead/content/quest/story/store suites, TS `homestead-content`,
`homestead-land`, `quests`, `quests-session`, shared vectors and populated upgrade
fixtures including live-rule migration 028. **Dependencies/parallel:** after 1;
mark/composition patch after 6 if those files overlap. Placement-only patch can
parallel 5–6 and 10–12, but serialize TS catalog edits with 3. Does not replace
rules.State by generated PlayerState.

### 8. Type validation/refusals without moving the acceptance boundary

**Scope:** B5 and stage 4's request boundary; OpHeader/ReportBarrier proto constraints,
payload validation, internal HTTP refusal/terminal-retention policy and adapters.
**Done:** first migrate just the two common messages, comparing old/new validators;
retain canonical JSON spelling/numeric rules, finite checks and content's separate
null policy. Preserve optional empty/null behavior and validation/refusal order.
Migrate internal ErrorCode uses through one wire adapter, preserving exact public
strings/statuses and terminal versus retryable policy. Domain decisions stay named;
upstream errors stay mapped at their boundary. If equivalence fails, retain the old
validator for that message; tighter acceptance is an owner-approved change.

**Size/risk:** M; medium/high contract risk. **Verify:** accepted/rejected JSON corpus,
multiple-invalid-field precedence, strictRequestJSON/secret/error-code scanning,
report-barrier/replay fixtures in Go and TS, generated-output and Buf checks. Full
API suite after shared policy changes. **Dependencies/parallel:** after 4, using
honest tests from 1; serialize with 6 on HTTP/op policy files. Parallel 7's pure
placement patch and 10–12 frontend work. Proto changes regenerate committed output
through pinned tooling in implementation, never by hand.

### 9. Extract one bounded backend domain; leave transaction ownership explicit

**Scope:** B1/B10; first fishing storage/stock recovery/cast expiry policy in
`api/fishing.go` into a cohesive internal domain package, plus API adapters/tests.
**Done:** extracted service accepts caller's `*sql.Tx`, captured time and logging;
returns domain values/reasons, with no HTTP dependency. API keeps authorization,
item wear/credits, savepoint/commit, envelope projection and notifications initially.
No nested transaction on the one-connection store. Wardrobe read/resolution can be
a later independent repeat, and pure quest policy can follow stage 7; neither is
required to make the first extraction usable.

**Size/risk:** M for fishing; L if extended to several domains; medium/high refusal,
ledger and version risk. **Verify:** direct policy tests plus full existing fishing/
API scenarios, held refusals, expiry, two accounts, replay and conservation; normal/
dev Go tests and applicable concurrency gates. **Dependencies/parallel:** after
4/6 and 7 if reusing its policy seams. Parallel 10–12. Later path search/ground/
way splits, CLI parse/command/serve splits, room model/AI/projection splits and
presence validation/dispatch extraction ship only when that area is next touched.
Those preserve lock scope/order, publishing after commit and PRNG calls; generators/
validators are not split merely because their complexity scores are high.

### 10. Give the durable queue one owner behind Link

**Scope:** C18/F2; Link ownership/persistence/submit/drain/retry/disposition, outbox
ports/records and ReportPump integration; no real-time fight transport move.
**Done:** a single queue owner manages record claims/fences, Web Lock lifetime,
allocation, immutable entries, committed persistence before prediction/visibility/send,
head order, sent marks, replay/reconciliation decisions and waiter completion. Link
keeps its public façade, adopted snapshot/lease/session responsibilities and delegates
through explicit callbacks. Avoid splitting mutually dependent fence/persist/drain
state across several owners. ReportPump remains the report/barrier owner; preserve
its coordination with the queue and unload keepalive behavior.

**Size/risk:** M–L; high durability/lifecycle risk. **Verify:** `outbox`, all link
suites, particularly durability/failures/reports, `rollback`, `remembered`, camp-fights;
fixtures cover reload of old/current records, aborted storage commits, takeover,
stale fences, sign-out/paused waiters, ambiguous sends, missing/wrong responses,
expiration and read-before-replay. Keep the C8 commit fix. **Dependencies/parallel:**
after 4/5; guest retirement G simplifies it but is optional, so retain guest adapters
unless G is approved/landed. Parallel 7–9 backend work and stage 11; no parallel
Link/client-id/outbox edits or App lifecycle extraction (13).

### 11. Extract InventoryPanel's detail/action card

**Scope:** C18; InventoryPanel and new card component/local action model.
**Done:** card owns detail rendering and chooser actions through explicit inputs/
callbacks. Panel retains grid/roving selection, placement of the card and modal
lifetime. Preserve desktop hover versus picked selection, empty equipment slots,
Escape card-first behavior, focus return, scroll/header measurements, busy/refusal
states, delayed read adoption and phone layout. Retain C3 error-copy/C9 nested-confirm
fixes; do not move unrelated account or HUD logic. Share only card CSS actually used.

**Size/risk:** M; medium keyboard/measurement/reactivity risk. **Verify:** inventory,
panel-state, layers, home-items-order and stores unit suites, tsc/svelte-check; future
inventory/keyboard/phone screenshot CI acceptance on selected/hovered/chooser/empty/
busy states. Existing focus assertions stay strong. **Dependencies/parallel:** after
UI bug-lane merge and 1's hooks in this file; can parallel 4–10 on disjoint files.
If G changes InventoryPanel, land those branches sequentially. Finish before 12.

### 12. Extract the HUD action cluster

**Scope:** C18; Hud and action-cluster component, narrowly shared local styles.
**Done:** desktop/mobile action buttons share a coherent input/callback surface;
HUD retains stats/chips/objective layout and established inset reporting. Preserve
pointer/keyboard ownership, touch differences, objective opening, gain/news indicators,
and map coverage/inertness, including C16's sibling bar fix. Do not change reduced-
motion cooldown or diagnostic behavior established by the bug lanes.

**Size/risk:** M; medium layout/accessibility risk. **Verify:** layers/panel-state/
inventory units, tsc/svelte-check; future HUD/map/phone screenshot and accessibility
CI acceptance, including longest text and narrow landscape. Do not claim that an
extraction resolves U4's unverified 568×320 fit. **Dependencies/parallel:** after
11 to review component changes in sequence; can parallel 6–10 backend/queue work.
Serialize with 1's HUD hook changes if any and with 13's HUD prop/caller changes.

### 13. Extract App's connected lifecycle

**Scope:** C18; App connected session swap/start/stop, presence/game preparation,
account/update callbacks and focused lifecycle module.
**Done:** one lifecycle owner coordinates session replacement/destruction, presence
lease attachment, Wilds/home preparation, game start/stop and update settle/reload.
App retains presentation/layer state and global key ownership. Preserve asynchronous
cancellation, account/world switches, effect/subscription cleanup, focus/insets,
unload reports and queued-work settlement. Retain current pack polling and GuidesTab
clock until a separate event-driven replacement has equivalent coverage; removing
polling merely for elegance changes freshness behavior.

**Size/risk:** M; high lifecycle/race risk. **Verify:** account-flow/link-places/
link-durability/rollback/remembered/layers/scene-end suites, tsc/svelte-check; fixtures
for switch while reads are pending, reconnect/takeover, stopped session callbacks,
failed settle and contract reload. Future onboarding/connected/update/world-switch
CI acceptance. **Dependencies/parallel:** after 10–12; G is optional but its approval
status determines whether linkless paths remain. Parallel 8–9 backend work; conflicts
with App/account/hooks and source-store caller migrations.

### 14. Clarify folder boundaries after semantic work settles

**Scope:** F9/B10 naming only; established client owners into `src/client/`, pure
fight-rule grouping where useful, imports/entrypoints/Nix source filters/selector
mappings; optional UI folders only if owner still wants them.
**Done:** move modules with verified dependency boundaries, not the 95-file scan
result. Inject device/UI flags into the two game→UI seams before or in a small
preceding patch. Rendering remains game, reusable policy lib, connected ownership
client; a short directory guide explains the boundaries. No behavior/schema changes
mixed with moves. Rename milestone files/internal texture keys only with all consumers
and output-equivalence checks; storage keys belong to N, not this stage.

**Size/risk:** M; low runtime risk, high merge/import/build-selection risk.
**Verify:** all three TS checks plus test/script check, svelte-check, unit suite,
web-fileset check and normal CI build/changed-spec mapping. If backend paths move,
normal/dev Go checks too. **Dependencies/parallel:** last, after 3–13 and any elected
clean breaks affecting the same files. **No parallel source branches:** coordinate
one short move window after they land. Queue extraction may place its new module at
its final location earlier; that does not authorize a broad folder sweep.

Coverage: B1→9; B2→1; B3→6; B4→4; B5→8; B6→7; B7→3; B8→2;
B9→2's harmless comments plus N/S clean breaks; B10→9's on-touch splits/14.
F1→4; F2→5/10; F3→G/N; F4→2/3/4; F5→1; F6→3 on touch;
F7→3/11–12 on touch; F8→2/G/N; F9→14. C18→10–13.

## Owner decisions and clean breaks

No decision below blocks stages 1–3 or the preservation defaults in later stages.
Approval must concern a concrete implementation/reset inventory, not a blanket
promise that all compatibility is dead.

| Decision | Proposed scope and default | Approval boundary and verification |
|---|---|---|
| **G — retire guest mode** | Recommended separate M clean-break milestone after 1/2 and before 10/13; may parallel backend 6–9, but serialize with 4/5's Session/store callers. Require non-null Session.link, migrate guest tests to connected/offline Link rigs, remove local game save/sync/donation paths and resolve obsolete TODOs. Keep live safety/regen helpers in a pure module; keep needed save validation and any still-offered export/import behavior. Default without approval: retain those paths. | Owner OK to remove the mode/test API despite its absent production constructor. “Offline” connected play must still work. Verify stores/quests-session/unmoored/rollback/sound, link/outbox/account tests and future onboarding/connected/papers CI acceptance. Reachability/compiler diagnostics guide deletion; lifecycle nullability in Link itself is not guest mode. Ship required-Link/test migration before dependent removal patches. |
| **Q — queued-record format policy** | Stage 4 defaults to reading old path entries alongside new route keys, preserving key/body and replay semantics. A known old-format reader can retire after its supported lifetime with an explicit upgrade policy. Discarding queued entries instead is an optional M clean break; not required for the new registry/codec. | Owner OK must explicitly cover possibly-sent unresolved economy operations and predictions. Inventory entries; settle/reconcile ambiguous work before any reset, specify upgrade/refusal messaging and account/device scope. No automatic new-key retry. Test old-format reload and an unanswered committed mutation. |
| **N — retire old names/config fallbacks** | Separate S patches, M collectively: client fingersnap settings/seen/heard/held/pin/client-id and guest IndexedDB names where still relevant; Vite FINGERSNAP_API, E2E legacy DB-path setup; Go FINGERSNAP_* env/default DB fallback. Default: preserve them. | Owner inventories actual local DB path/environment and accepts preference/seen-marker resets. Client-id/device changes may alter outbox lookup, so preserve or explicitly migrate the durable record identity; do not reset it as cosmetic naming. Keep the DB itself and historical migrations. Verify startup defaults/CLI tests, client-id/outbox/remembered/settings behavior and tooling paths; document the concrete owner's configuration update. |
| **S — retire obsolete schema/request compatibility** | Separate M contract retirement: deprecated v1 presence messages and unused WildsRegionResult; replace old-schema encoder tests with current messages first. Removal of old-upload detection changes its 404 to 400 and is separately behavior-changing. Default: retain schemas/statuses. | Owner OK to schema API/baseline break even though live socket is v2 messages/v3 subprotocol. Check all imports/fixtures and main/latest-release Buf baselines; reserve names/numbers where applicable, document narrowly accepted retirements rather than disabling global breaking checks. Run generation/output checks and current presence/finite-number/error fixtures. No socket protocol rewrite is implied. |

Any proposed one-envelope wire migration, tighter validation, changed GET maintenance,
new response trust discriminator, pause/hurt authority change, or server held-mode
check is outside this plan's authorization. C5 remains “no server check”; the others
need their own behavioral proposal if desired. A second backend-domain extraction
or broad optional card/art/order cleanup is a prioritization choice, not a condition
for shipping the first bounded stage.

## What is not worth doing

Merged from both reviews, with their distinctions retained:

- No generic server repository/permission/content-loader framework or generic client
  store/repository framework. Domain transaction/refusal/read/mirror semantics differ;
  narrow member helpers and mark comparisons have actual multiple users.
- No universal limiter: login fixed-window counts, proof failure/inflight reservations
  and socket token/abuse budgets are different policies. Existing fixed-window reuse
  is enough.
- No common queue for retained fall writes, uncertain credential-bearing purse work,
  fight actors and the client's durable economy queue. Purse idempotency intentionally
  stays separate from payload-retaining keyedOp; live fight swings/casts continue to
  bypass the durable client queue.
- No single transport abstraction for presence, fight observation and HTTP operations.
  Do not route lease-free invites/world prompts/account UI calls through Link.
- No universal epoch cache combining chunk LRU and live fight lifecycle maps. Their
  transaction/row-existence and commit-before-publication guarantees are different.
- No mechanical Link split or line-count/cyclomatic-complexity target. Keep fence/
  persist-before-visible/exact-key/head ordering together. Preserve explicit domain
  policy, complex validators, conservation tests and deterministic generator/PRNG
  order rather than flattening them to improve a score.
- No all-time.Now gameplay-clock conversion, timer framework or unit sweep. Sample
  operation time after the DB lock; socket budgets, durations and recovery waits need
  elapsed wall time. Keep seconds/milliseconds clear at boundaries.
- No migration squash/renumber/reset, deletion of pre-029 State.Quest support or
  runtime-checksum rewrite. Frozen hashes do not freeze live transitive rules/content;
  populated upgrade fixtures remain necessary.
- No new server Go module, hand-edited generated output or report-only schema
  regeneration. Root/internal output placement, pinned tooling, build tags and
  Docker/Nix boundaries remain useful.
- No wholesale domain-model→protobuf conversion or generated predictor rules.
  Pure geometry/method-rich types and the predictor's GameState view are useful;
  shared Go/TS crafts/combat/fight vectors keep deliberate rule twins honest.
- No churn of loader `as unknown as` casts that follow runtime vocabulary checks,
  or entity XxxDeps/result-type exports just because an unused-export tool lists
  them. Preserve intentional seams and the cheap dead-exports guard; fix its blind
  spots with reference analysis, not a sweeping allowlist.
- No global CSS/color/token campaign before component splits, big-bang folder moves,
  speculative removal of fonts/tooling dependencies, or texture/storage renames
  masquerading as unused-code deletion. Shared cards/tokens follow real consumers
  and screenshot acceptance.

## Verification of this plan

Read-only source/contract inspection plus terminal-only probes were used. Only this
plan was authored in the worktree. No source/config/generated/dependency edits, git
mutations, installations, browser/E2E runs, services or app launches were performed.
Scratch logs remained in `/tmp`; no new tool installation was needed.

- A no-emit TypeScript compiler-API probe, using existing config with Node/Vite types
  and tests/scripts included (unused-locals/parameters disabled), reproduced 80 test
  diagnostics; it does not claim that the proposed permanent config already exists.
- `nice -n 10 node --test` over `api-client`, `server-first-contract`,
  `link-durability`, `materials-order`, `home-items-order` and `dead-exports` passed
  **74 tests**, zero failures/skips.
- `nice -n 10 go test ./server/internal/api -count=1` with seven selected tests
  (current replay/atomic refusal, play/report barriers, causal watermarks, actual
  stored result, mismatched payload, report-required retry and secret-free keyed
  requests) passed. This was not a full backend or race run.
- The sandbox denied nice's priority change; the checks still executed successfully.
  No full verification/bundle/layout/Knip rerun is claimed. A git status attempt
  failed because its LFS clean filter tried to write outside the allowed worktree;
  it was not retried with escalation. No clean-status claim depends on that command.

Rebase the plan's evidence on merged dev before implementing. Existing green unit
checks are a baseline, not proof that future extractions preserve every contract;
each stage's fixtures and review boundary are its acceptance criteria.

## Done

## Owner decisions (2026-10-13)

The owner approved all four clean breaks:

- **G — retire guest mode: yes.** Remove the local save/sync paths and the no-Link code. A future
  guest or non-Habitica mode will be server-side, like the Habitica mode is now, not a local game.
- **Q — queued-record format: drop old entries.** No reader for the old path-keyed format; the
  release notes tell players to let the game sync before updating.
- **N — retire old names and config fallbacks: yes.** Including `FINGERSNAP_*` environment
  variables; the release notes carry a deploy note for the server's environment.
- **S — retire obsolete schema/request compatibility: yes**, including the old-upload 404 → 400
  change.
