# Frontend architecture and code-quality review

Snapshot: detached `dev` at `66b851e`, October 13, 2026. Scope: `src/game`, `src/lib`,
`src/content`, `src/ui`, `src/App.svelte` and entry glue, the unit-test helpers, the e2e
helper layer and fixtures as code, and build config (`vite.config.ts`, tsconfigs). This is
a review only. S = one focused change; M = several related changes; L = an extraction
that needs several independently reviewable stages. Line numbers refer to this snapshot.

## Summary

The frontend is in better shape than the size of the codebase suggests. Since October 7
the parallel lanes have paid off most of the earlier review's debt: there is one typed,
Phaser-free bus; dev hooks are DEV-only and scene-scoped; there is one tile and hash
module; art passes share `art-pass.ts`; `Panel.svelte`, the panel-state helpers and
`layers.ts` exist; and content loads through generated schemas, with Go/TS vectors for
nearly every rule family. `tsc`, `svelte-check` (801 files, 0/0) and 2,329 unit tests
pass. Literal copy-paste is still low: jscpd finds 0.19% in TypeScript and 1.6% in
Svelte, and most of the Svelte share is CSS. No rewrite is needed.

What remains is mostly **two generations of the same idea living side by side**. Lanes
added a new, better path and kept the old one. The five biggest structural problems:

1. **Two client operation pipelines.** Typed Envelope operations and the older
   Snapshot domain mutations are routed, encoded, decoded and trusted differently. Five
   mutation kinds still go out untyped, even though generated schemas exist for them.
2. **Link's façade is ~20 copies of one method.** Each typed operation hand-writes the
   same key/body/submit/result-case boilerplate. Callers get four different outcome
   shapes for "succeeded or refused".
3. **Guest play is gone from the product but not from the code.** Production always
   builds `Session` with a Link, yet `link` is still nullable. That leaves 132 no-link
   branches in 46 files, a 420-line local save module, a local Habitica sync path and 14
   `TODO(C1/C2/D)` markers. Tests keep the dead mode alive.
4. **The API decoding layer is hand-projected.** About 85 hand-written view types mirror
   generated messages, and every domain answer is also projected into the old
   `GameState`, which Link then discards. Decode helpers are copied across five files.
   A pass-through `ApiClient` layer re-declares every raw call.
5. **The test layer is untyped where it matters.** `tests/` is in no tsconfig (80 type
   errors today). e2e ignores the exported `FsHooks` type, redeclares hooks in 332
   inline casts, and redefines the same helpers across specs.

Start with the cheap, behavior-preserving work: type-check the tests, give e2e the
`FsHooks` type, type the five untyped mutations and drop the decode copies. Then
collapse Link's façade onto one operation table. Retiring guest mode is a deletion with
a test migration, and it unblocks shrinking Session and the API layer. Avoid a generic
store framework, a client-side "repository" layer and a big-bang folder move.

## Frontend map

Counts are physical lines of `.ts`/`.svelte` files. Generated code (`src/lib/gen`, 88
files / 31,752 lines, and `src/content/papers-text.ts`) is excluded from the hand-written
rows.

| Area | Files / lines | Responsibility | Notes |
|---|---:|---|---|
| `src/game/scenes` | 9 / 2,659 | Boot, WorldScene (1,190) and its extracted `world-*` modules | `create()` (`WorldScene.ts:224–654`) is now mostly composition: 25 entity constructions. |
| `src/game/entities` | 41 / 11,315 | Hero, enemies (split into creatures/warden/server-enemies), homesteads (split into art/talk/placement/stable/yard), interactables, gathering, fishing, presence views | The `XxxDeps` lazy-closure pattern holds; nothing imports a scene. |
| `src/game/wilds` | 32 / 8,229 | Open-map window, chunks, paint workers, sites, paths, the Wilds store (853) | `store.ts` keeps ~20 module-level mutable variables. |
| `src/game/area` | 14 / 2,388 | Generic `WorldData` renderer: terrain, collision, props, foreground | Healthy. |
| `src/game` top level | 78 / 16,074 | **Mixed:** Phaser art installers, *plus* the client domain: `link.ts` (2,416), `session.ts` (647), `village.ts`, `homestead.ts`, `items.ts`, `papers.ts`, `event-names.ts`, `dev-hooks.ts` | 92 of the 174 `src/game` files (17,674 lines) never touch Phaser. |
| `src/lib` (excl. gen) | 99 / 16,670 | Pure rules mirrored from Go (vectors), content loaders, presence client/codec, Habitica, papers | No `lib → game/ui` imports remain. |
| `src/lib/api` | 24 / 4,418 | HTTP client (`client.ts` 662), typed operations (`operations.ts`), outbox (445), report pump, predictor (278), domain decoders (`homestead`, `items`, `village`, `world`), legacy `types.ts`/`parse.ts` | Two client surfaces: `RawApi`/`ApiClient` and `OperationsApi`. |
| `src/ui` + `App.svelte` | 85 + 1 / 21,678 | Svelte 5 runes: panels, HUD, gates, stores, account flow | 43% of Svelte lines are CSS. `src/ui` is still flat. |
| `src/content` | 33 / 6,405 | Copy, lore, error tables, paper design data | Includes build-only paper find rules (finding 7). |
| `tests` | 167 / 25,090 | 156 node test files, `tests/helpers/*` rigs | Not type-checked. |
| `e2e` | 83 / 15,782 | 73 specs, `helpers.ts` (894), `home-/room-/party-helpers`, fixtures, per-worker Go server | 250 spec-local helpers. |

**How a player action reaches the server today.** There are two paths, chosen by when
the domain was migrated:

- **Typed operation** (story, spend, fall, Wilds, fishing, companions, stable,
  wardrobe): entity or store → `Link.wildsClaim()` etc. (hand-written per op) →
  `submit(kind, TYPED[kind].path, …)` → outbox → `TYPED[kind].send(ops, req)` →
  `OperationsApi` (`operations.ts`, one more path table) → `decodeEnvelope` → Link
  checks `result.case` and adopts `state`.
- **Domain mutation** (homestead, storage, craft, hearth, desk, woodpile, shelf, mail,
  projects, items, mend, world move/leave, donate): store → `Link.mutate({kind, fields})`
  → `mutationBody` → outbox (stores only the path) → `routeFromPath` regex →
  `dispatchMutation` switch → `ApiClient`/`RawApi` → per-domain `parse*` → **`Snapshot`
  incl. a `GameState` projection** → Link adopts `res.player`; the projection is unused.

**What a newcomer won't expect.**

- The network client and its durable queue (`link.ts`) live in `src/game`, while the
  outbox record, report pump and predictor live in `src/lib/api`.
- `Session.link` is typed nullable, but nothing in production makes a Session without
  one (`ui/account.ts:108–134` is the only constructor).
- `src/game/village.ts:52–55` says "there is no guest play" and asserts `link!`, while
  `session.ts`, `ConnectGuide.svelte` and 44 other files still branch on its absence.
- `content/papers.ts` holds find rules the build script turns into `content/papers.json`.
  The runtime reads the JSON, so the TypeScript copy is a build input shipped in `src/`.

## What the October 7 round already addressed

| Earlier finding | Status at this snapshot |
|---|---|
| Game F1 red tests / F12 dead code | Done. `tests/dead-exports.test.ts` now guards against unread exports (a word scan; see finding 8 for what it can't see). |
| Game F2 dev hooks | Done in the game: `dev-hooks.ts` `expose()` is DEV-only, scene-scoped and typed by `FsHooks`. The UI and e2e sides don't use it (finding 5). |
| Game F3 typed bus | Done. `events.ts` is a Phaser-free `Bus<EventMap>` with one registry in `event-names.ts`. |
| Game F4 WorldScene split | Largely done: `world-actions/-arrival/-camera/-controls/-dev-hooks/-frame/-turning` exist; 2,047 → 1,190 lines. |
| Game F5 interaction paths | Done: `dialogue.ts` `openDialogue()`; one `setDynamic` registration path. |
| Game F6 homesteads/enemies split | Done (`homestead-art/-talk/-placement/-stable/-yard`, `warden`, `creatures`). |
| Game F7 tile/hash module | Done: `lib/tile.ts`, `lib/hash.ts`. `ui/map-renderer.ts:77,183` keeps two private FNV loops (finding 7). |
| Game F8/F9 placeholder art, art passes | Done in shape: `art-pass.ts` adopted by nine passes. Five passes still repeat the same body (finding 7). `depths.ts` was never made: 51 literal `setDepth` numbers remain. |
| Game F10 explicit area build / F11 `wildsFor(session)` | F11 not done: the Wilds store is still module state with `resetWilds()`; Village/Items/Homesteads use `xxxFor(session)`. F10 not re-checked. |
| UI F1–F3, F6, F9, F12 | Done (step-back UI table). |
| UI F4 account flow | Done in substance: `account-flow.svelte.ts` (508). |
| UI F5 bus mirrors / polling | Partly: App still polls the pack every 1.5 s (`App.svelte:589`) and GuidesTab ticks at 1 Hz. |
| UI F8 library client | The second fetch client is gone; the local half remains behind `TODO(C2)` (finding 3). |
| UI F10 big components | Not done; carried by step-back C18 and not repeated here. |
| UI F11 colour tokens | Barely moved: 259 raw hex + 220 `rgba(` against 779 `var(--` (was ~509 raw). |
| UI F14 folders | Deferred by owner decision ("last"). Still flat: 85 files. |
| Cleanup decision 2: pre-deploy compat | Not done for storage names (finding 3). |

The October 13 step-back findings (camp-claim recovery, reduced-motion cooldowns, claim
refusal copy, enemy colliders, Link outbox extraction, the three big UI components) are
not repeated as findings. Where a structural problem below caused one of them, it says so.

## Findings

### 1. Two operation pipelines with different routing, typing and trust rules

**Evidence.**

- Link has two operation registries. `TYPED` (`link.ts:306–332`, 21 kinds) holds schema,
  path, result case and sender. The mutation side holds `ROUTE_PATHS` (`:126–143`), a
  reverse regex parser `routeFromPath` (`:146–157`), a dispatch switch
  `dispatchMutation` (`:159–200`) and a body switch `mutationBody` (`:207–238`), all
  for 16 kinds.
- The same paths are declared twice. Each typed path appears in `TYPED` and again in
  `operations.ts:85–138`. Each mutation path appears in `ROUTE_PATHS`, again in
  `routeFromPath`, and again in `client.ts:270–395`. (`'/api/fishing/cast'`, for
  example, is in `link.ts` and `operations.ts`.)
- `sendHead` trusts the two paths differently (`link.ts:1238–1257`). A typed answer is
  trusted only when `env.result.case === typed.result`. A mutation answer sets
  `trusted = true` unconditionally, because the mixed `{state, result}` envelope has no
  case to compare.
- Five mutations bypass their generated request schemas. `woodpile`, `mend`,
  `world-move`, `world-leave` and `donate` go out as `body as Envelope & any`
  (`:161`, `:177`, `:191–197`) and are built by spreading untyped fields (`:220`,
  `:236`). Yet `WoodpileRequestSchema`, `MendRequestSchema`,
  `WorldMoveRequestSchema`, `WorldLeaveRequestSchema` and `LibraryDonateRequestSchema`
  all exist in `src/lib/gen`. The `api-client.test.ts:402` type error (finding 5) sits on
  exactly this untyped woodpile shape.
- Every domain-mutation answer is projected into a `Snapshot` with a full `GameState`
  (`parse.ts:49–60`, `parseSnapshot` called from `homestead.ts` ×6, `village.ts` ×13,
  `items.ts` ×2, `world.ts` ×2). Link then reads only `res.player` (`link.ts:1243`). The
  file still carries `// TODO(C2): remove the retained domain document projection with
  the old Link.`

**Impact.** Adding an operation means first choosing a pipeline, then editing three or
four tables in two packages. The mutation path can't verify that an answer belongs to the
operation it replays, and its untyped bodies are never checked against the schema at
compile time. Each answer also pays for a `GameState` projection nobody reads. This is
the client half of the server's finding 4 (two envelopes): the server keeps two
envelopes for compatibility, and the client mirrors that split all the way up into
Link's routing.

**Before → after.**

```
// before: four tables for one mutation kind, plus client.ts and parse
ROUTE_PATHS.mend, routeFromPath(/repairs\/…\/mend/), dispatchMutation case 'mend' (req as any),
mutationBody case 'mend' (spread fields), client.ts repairMend, village.ts parseMend → Snapshot
// after: one row per route, shared by Link and the client
const ROUTES = { mend: { method: 'POST', path: (id) => `/api/repairs/${id}/mend`, request: MendRequestSchema,
                         answer: 'mixed', result: MendResultSchema } , … }
```

Start with the shared route table (path, request schema, envelope style). Build
`OperationsApi`, `TYPED` and the mutation dispatch from it, and store the route key in
outbox entries rather than reverse-parsing paths. Next, type the five untyped bodies
through their schemas. Then let domain parsers return `{ state: PlayerState, result }`
instead of `Snapshot`, and delete `parseSnapshot`/`gameStateOf` from the answer path
(`gameStateOf` stays for the predictor's view).

**Effort/risk:** M. Medium risk at the outbox boundary. Stored outbox entries hold a
`path` (`outbox.ts`). Keep reading old paths during the change, or accept a clean break
of queued entries: with no players besides the owner, the latter is acceptable but must
be a decision. Preserve exact request bytes (stored bodies replay verbatim), the
`sameRequest` equality rule (`link.ts:338–342`), report barriers on `items/use`, and
`resolved`/`pending` semantics. Do not force mutations into the Envelope oneof; that is a
server wire change (server finding 4 rejects it too). Guards: `link*.test.ts`,
`api-client.test.ts`, `link-durability`, and the village/homestead/items e2e.

### 2. Link's façade repeats one operation body ~20 times and returns four outcome shapes

**Evidence.** `link.ts` is 2,416 lines. Its sections are: views of companions, purse,
rumour and wardrobe (`:627–907`); ownership and persistence (`:908–1096`); the outbox
(`:1097–1518`); reports (`:1519–1582`); operations (`:1583–1745`); domain reads and
mutations (`:1746–1851`); the Wilds (`:1852–2027`); fishing (`:2028–2073`); and
lease/reconnect (`:2074–2416`). Across the operation methods:

| Repeated fragment | Count |
|---|---:|
| `toJson(XSchema, create(XSchema, { op: { lease: '', key }, … }), { alwaysEmitImplicit: true }) as Record<string, unknown>` | 21 |
| `if (!s) return { ok: false, code: 'unknown' }` session guard | 12 |
| `r.code === 'resolved' ? 'unknown' : r.code` | 11 |
| `if (res?.case !== '…' \|\| !res.value) return { ok: false, code: 'bad-response' }` | 15 |
| `where: req.where ?? whereOf(s.state)` | 11 |

`wildsClaim` (`:1961–1973`), `wildsRelight`, `wildsDiscover`, `fishCast`, `fishSettle`
and `fishCancel` (`:2031–2068`) differ only in schema, field list and result case. The
outcome types differ by method: `HomeRead<T>` is `{ok, value}` (`:89`), `MutateResult<R>`
is `{ok, res}` (`:240`), `WildsOutcome<T>` is `{ok, result}` (`:247`), and `Result<T>` in
`lib/api/errors.ts:36` is `{ok, value}`. `QuestStepOutcome` and `RemoteSpendResult`
return `null | code`. The error-code union `ApiErrorCode | 'offline' | 'superseded' |
'busy' | 'pending' | 'resolved'` is spelled out 13 times.

**Impact.** Every new server operation adds ~12 lines of copied plumbing to the largest
client file. A deviation (a forgotten `where`, a different `resolved` mapping, a missed
case check) looks like every other line, so review can't spot it. Callers switch between
`.value`, `.res` and `.result`. The step-back's optional outbox extraction (C18) is
harder while the queue shares a class with this façade.

**Before → after.**

```ts
// before (×20)
async fishCast(req) { const s = this.session; if (!s) return {ok:false,code:'unknown'}; const key = newKey()
  const body = toJson(FishCastRequestSchema, create(FishCastRequestSchema, {op:{lease:'',key}, …, where: req.where ?? whereOf(s.state)}), {alwaysEmitImplicit:true}) as Record<string,unknown>
  const { outcome: r } = await this.submit('fish-cast', TYPED['fish-cast']!.path, key, body, {offline:false})
  if (!r.ok) return {ok:false, code: r.code === 'resolved' ? 'unknown' : r.code}
  const res = r.result as {case?:string; value?:FishCastResult}; if (res?.case !== 'fishCast' || !res.value?.cast) return {ok:false,code:'bad-response'}
  return {ok:true, result: res.value} }
// after
fishCast(req) { return this.operation('fish-cast', { water: req.water, bank: req.bank, rod: req.rod }, { where: req.where, valid: (v) => !!v.cast }) }
```

`operation<K>(kind, fields, opts)` is typed from `TYPED[K]`'s schema and result case. It
fills the header and `where`, submits, maps `resolved`, checks the case and returns
one `Outcome<T>`. Methods with real extra behavior keep their bodies: `fall`
(report boundary), `mountOut` (saddling), `spend`/`questStep` (code narrowing),
`profile`. Once `operation()` exists, converge the outcome shapes onto `Result<T>`, one
caller group at a time.

**Effort/risk:** S–M for `operation()`, low risk if each conversion keeps its exact
`offline`, `barrier` and `key` options (`wildsPath` and `wildsDiscover` accept a caller
key; keep that). M for outcome-shape convergence: purely mechanical, but it touches many
callers. Do this **before** the outbox extraction: the extraction then moves ~1,000 lines
that no longer contain domain code. Guards: `link-fishing`, `link-companions`,
`link-failures` and `camp-fights` tests.

### 3. Guest play is unreachable in production but still shapes the code

**Evidence.**

- `Session` is constructed only in `ui/account.ts:132` (always with a Link). Tests
  construct it 10 times, and 6 test files build linkless "guest" sessions
  (`tests/stores.test.ts:53`, `quests-session.test.ts:15`, `unmoored.test.ts:44`, …).
- `Session.link: Link | null` (`session.ts:58`) keeps alive: local IndexedDB saves via
  `lib/save.ts` (420 lines; `session.ts:121`, `:546`, `:592–597`, `:640`), `applySynced`
  (`:115`), and the `syncInFlight`/`pendingSave` machinery.
- `ConnectGuide.svelte:284` returns to `remoteSync` whenever a link exists. The
  remaining ~70 lines (`:286–354`) run the local Habitica sync through
  `lib/habitica/sync.ts` `syncProfile` (283 lines). `Session.defeat()`'s linkless half
  (`session.ts:478–487`) uses `resolveDefeatRecovery` from the same module. Outside these
  guest paths, only `isSafeArea` and `passiveRegenAllowed` (plus `isSafeBoundary` in a
  test) are used.
- There are 132 `!link`/`link?.` branches in 46 files: `entities/fishing.ts` 8,
  `wilds/paths.ts` 7, and 5 each in `wilds/sites.ts`, `map-data.ts`, `wilds/entities.ts`,
  `homestead.ts`, `avatar.ts` and `WorldMove.svelte`. Meanwhile `village.ts:52–55` and
  `items.ts:69,102` assert `link!`. Both conventions coexist.
- 14 `TODO(C1)`/`TODO(C2)`/`TODO(D)` markers name lanes of `docs/design/server-first.md`
  that have merged: `parse.ts:49`, `papers/library.ts:11,52,57`, `progress.ts:7`,
  `inventory.ts:96,100`, `keepsakes.ts:133`, `homestead.ts:48`, `nudges.ts:5`,
  `content/world.ts:74`, `ui/hero.ts:7`, `echoes.ts:64` and `heirlooms.ts:111`.
  `progress.ts` is now one constant.
- Old-name storage compatibility: `fingersnap` IndexedDB (`save.ts:30`) and
  `fingersnap:*` keys for settings, inventory-seen, heard-day, client-id and pinned guide
  (`settings.svelte.ts:20`, `inventory.svelte.ts:11–13`, `heard.ts:33`,
  `client.ts:511–512`, `guide-pin.ts:27`). Also `GLIMWAY_API || FINGERSNAP_API`
  (`vite.config.ts:11`) and `installLegacyDbPath()` (`e2e/fixtures.ts:4`).

**Impact.** Every feature author has to decide what a linkless session should do, and
the answer differs by file. Tests exercise a mode players can't reach, so a test suite
can pass on the guest branch while the connected branch, the only one that ships, goes
uncovered. Session's persistence rules (frozen/sealed/syncInFlight/pendingSave) are
harder to reason about than they need to be. The step-back's "durable outbox in Link"
extraction is easier once Session has one persistence path.

**Before → after.** `Session(state, provenance, link: Link)`, with `link` non-null.
`save()`/`settle()`/`destroy()` each lose their guest half. Tests construct sessions
through `tests/helpers/link-rig.ts` (already used by 14 files) or a small
`offlineLink()` fake. Delete `save.ts`'s game-save half (keep export/import only if the
title still offers it), `syncProfile`/`applyImportedProfile`/`resolveDefeatRecovery`,
ConnectGuide's local branch, the library's local donation half and `progress.ts`. Move
`isSafeArea`/`passiveRegenAllowed` to `lib/rules` or similar. Replace each `TODO(Cx)`
with the deletion it promised, or with a plain comment if it is deliberately kept.

**Effort/risk:** M (deletion is mechanical; migrating ~6 test files is the work). Low
production risk, because no production path constructs a linkless Session; prove it
by making `link` non-null first and letting `tsc` list the branches. The storage-key
renames are a **separate clean-break change**: they reset the owner's local settings and
"seen" markers once, and should be an explicit owner decision (memory: no players yet,
clean breaks preferred). Guards: `tsc`; `stores`, `quests-session`, `unmoored`, `rollback`
and `sound` tests ported to a link rig; onboarding, connected and papers e2e.

### 4. The API decoding layer re-projects generated messages and copies its helpers

**Evidence.**

- Five decoder modules declare about 85 exported view types on top of the generated
  messages: `homestead.ts` 17, `items.ts` 10, `village.ts` 24, `world.ts` 6, `types.ts`
  30. Each converts with `GeneratedX → XView` functions (tuples, nulls, renamed fields).
  The newer typed operations (fishing, Wilds, stable, wardrobe) use generated types
  directly (`link.ts:1961–2068`), so the two styles sit side by side.
- The same decode helpers are copied: `decoded`/`validated` (`homestead.ts:188`,
  `items.ts:123`, `operations.ts:68`); `int` (`homestead.ts:192`, `items.ts:127`,
  `parse.ts:172`); `num` (`homestead.ts:197`, `items.ts:132`, `parse.ts:44`);
  `countMap` (`homestead.ts:202`, `items.ts:137`); `obj` (`parse.ts:34`,
  `village.ts:46`). jscpd flags `homestead.ts:184–208` ≈ `items.ts:119–143` (25 lines).
- `parse.ts:23–30` re-exports 14 village parsers "for the one import site". `client.ts`
  imports them from `village.ts` directly, and knip finds no importer of the re-exports.
  The `Progress` interface and the `progress?` fields (`types.ts:24`, `:153`, `:176`)
  describe a document the server no longer accepts.
- `ApiClient extends RawApi` (`client.ts:195`) and re-declares every raw call as
  `x: (…) => run((r) => r.x(…))` (`:401–446`). `client.ts` also hosts invite-code
  formatting (`:487–503`) and the cross-tab client-id claim with BroadcastChannel
  (`:511–662`).
- `lib/api/ports.ts` is a hand-written quest/paper content model (`PaperRule`,
  `QuestStep`, …) placed in the API folder. A second, field-for-field identical
  `PaperRule` lives in `content/papers.ts:216`. The server review finds the Go twin of
  `ports.go` dead; here it is live, via `quests.ts` and `story-tables.ts`.

**Impact.** A field added to a proto needs a hand edit in a view type and a projection
function, or it silently stays invisible to the game. Three copies of "integer ≥ 0 or
throw" can drift on edge cases (`items.ts` and `homestead.ts` take `undefined`,
`parse.ts` takes `unknown`). Newcomers looking for "the API client" find two client
interfaces and a wrapper layer.

**Before → after.** One `lib/api/decode.ts` holds `decoded`, `int`, `num`,
`countMap` and `pair`. Delete the `parse.ts` re-exports, `Progress`, and the second
`PaperRule`. Move `ports.ts` beside its consumers as `lib/story-types.ts`. Move the
client-id claim to `lib/api/client-id.ts` and invite codes to `lib/invites.ts`. Then
narrow the view types per domain as finding 1 touches them: keep a projection only
where it changes representation in a way the game needs (`[x, y]` tuples, `null` for
absent homes) and otherwise expose the generated message. The `ApiClient` wrapper can
become `run` plus the handful of session-only calls the UI makes.

**Effort/risk:** S for the helper/re-export/move steps (low risk; `tsc` proves them). M
for view-type narrowing, done per domain alongside finding 1. Preserve the
`bad-response` mapping, ProtoJSON spelling refusals (`wire.ts`) and the validation each
`validate*` performs. Don't swap a projection for a generated type where the
null-vs-default distinction matters to callers. Guards: `api-client.test.ts`, the
domain decoder tests, `server-first-contract.test.ts`.

### 5. Tests and e2e don't share the source's types

**Evidence.**

- `tsconfig.json` includes `src/**` and `vite.config.ts`; `tsconfig.e2e.json` includes
  `e2e/**` and `perf/**`. **`tests/` and `scripts/` are in neither.** `npm test` runs
  `node --test`, which strips types without checking them. A scratch config over
  `tests/`+`src/`+`scripts/` reports **80 errors, all in `tests/`**: 33 TS2345, 18
  TS2322, 13 TS18048, 7 TS2339 and others. The worst files are
  `interactables.test.ts` (14), `habitica-assets` (10) and `items` (6). Most are
  un-narrowed unions or hand-built fakes. Some are API drift: `api-client.test.ts:402`
  passes a `lease` the woodpile type doesn't have, and `enemy-owner.test.ts:14` sets an
  `owner` the enemy type doesn't declare.
- `dev-hooks.ts:1–9` says "`e2e/` can import it (`import type { FsHooks } …`)". No e2e
  file does. `e2e/helpers.ts:19–33` declares its own `Hooks` type for 13 hooks. Its
  `ExitView` (`:18`) has lost the `side`/`kind` fields that `dev-hooks.ts:30` has. Specs
  reach hooks through **332** `window as unknown as {…}` casts (32 in `helpers.ts`, 21
  in `paths.spec`, 20 in `open-map.spec`, …).
- Seven UI-side hooks bypass `expose()` and hand-roll the cast: `DialoguePanel.svelte:227`,
  `Toasts.svelte:10`, `Banners.svelte:84`, `update.svelte.ts:69`, `WorldMap.svelte:445`,
  and `App.svelte:778,780`. Four of them (`__fsWorldMap`, `__fsQuests`, `__fsDevLibrary`,
  `__fsDevVersionCheck`) are missing from `FsHooks`.
- Spec-local helpers are redefined across specs: `remotes` ×6 (an identical one-liner
  with its own `Remote` type), `shot` ×9, `quests` ×4, `twoPlayers` ×3 (three different
  signatures, `presence.spec.ts:21`, `items.spec.ts:200`, `purse.spec.ts:99`), and
  `claim`, `carryTo`, `gather`, `enemies`, `seat`, `dialog` ×3 each. There are 250
  spec-local helper functions against 98 shared ones. jscpd on tests+e2e finds 1.2%
  duplication, so this is semantic duplication, not paste.
- Historically named suites: `e2e/review-fixes.spec.ts`, `review5-fixes.spec.ts`,
  `playtest1.spec.ts`, `tests/review-fixes.test.ts`, `phase5-content.test.ts`.

**Impact.** A refactor in `src/` can break a unit test's assumptions without a compile
error, which matters for findings 1–4. Every hook change needs a text search through 332
casts, and a hook's return type can drift unnoticed (as `ExitView` did). The step-back's
spec flakiness work (C12) is slower when each spec has its own "two players" or "wait
for remote" helper. Domain-named suites help `test:changed` select the right specs; a
`review5` suite can't be selected by domain.

**Before → after.** Add `tsconfig.tests.json` (`tests/**`, `scripts/**`, `types:
["node"]`) and run it in `verify`, after fixing the 80 errors: mostly `assert.ok(r.ok)`
narrowing and typed fakes. In e2e, add `e2e/hooks.ts` with `hook<K extends keyof
FsHooks>(page, name, ...args)`, typed by importing `FsHooks`. Move the UI hooks onto
`expose()` and add the four missing names. Promote `remotes`, `twoPlayers` (one
signature with options), `quests` and `shot` into helpers. Move cases from the
review-/phase-named suites into domain specs as they are next touched.

**Effort/risk:** S for the tests tsconfig plus fixes, no runtime risk. S–M for the hook
helper and migration, which can go spec by spec. Keep hook reads inside
`page.evaluate`, because the hooks don't serialize closures. Don't run the full e2e
suite per step (memory: e2e load); run the changed specs, and the full suite once at
merge.

### 6. Read ordering is solved four times, by hand

**Evidence.** Domain reads and answers can arrive out of order, so each store invents
order marks:

- `items.ts:36–37,74,90` has its own `++this.order` counter and a `viewSeq`.
- `homestead.ts:144–153` keeps `laneSeq`, a `homeSeq` map and a `rowSeq` map of
  per-row-group maps, on the shared `nextMark()` clock.
- `wilds/store.ts:452–473` keeps `readSeq`, `entitySeq`, `lanternSeq`, `echoSeq`,
  `chunkSeq`, `waySeq`, `frontierSeq`, `startedAt` and `goodSeq`, with `forgetOrder()`.
- `materials-order.ts` keeps one clock and per-material marks shared by two mirrors.

That is 21 `nextMark()` call sites in 4 files, plus Items' private counter. The
2026-10-11 game review's F3 ("late reads moving domain views backwards") was this
class of bug, fixed store by store (step-back game table, F1/F3 "done").

**Impact.** Each new store or read repeats the "take a mark when asked, keep whatever is
newer" pattern by hand. Items alone uses a counter that doesn't compare with the shared
clock: harmless while Items keeps no shared mirror, surprising if it gains one. The
ordering rules are correct, but they are expensive to verify.

**Before → after.** A ~30-line `LatestByKey<K>` (or `Marks<K>`) in `materials-order.ts`:
`ask()` returns a mark, `accept(key, mark)` reports whether it is newer and records it,
and `forget()` clears. Items and Homesteads adopt it first. The Wilds store adopts it
for its simple per-id maps only; its `startedAt`/`goodSeq` rules stay explicit.

**Effort/risk:** M, medium. Ordering is subtle: preserve "a read marks with its asking
mark, an answer with its landing mark", per-row-group granularity in Homesteads, and
the Wilds' "an older read's failure doesn't make it stale". Don't merge the clocks
unless a test shows why. Guards: `materials-order`, `home-items-order`,
`wilds-runtime` and `stores` tests, all of which have injected-order cases. This is
worth doing only when one of these stores is next changed; it is not a standalone
priority.

### 7. Small repeated shapes with concrete users

**Evidence.**

- **Icon art passes.** `glims-art.ts`, `purse-art.ts`, `indoors-art.ts`, `crafts-art.ts`
  and `wilds/open-map-art.ts` each have `createXArt` (manifest lookup, `perPx`, frames,
  `explodeFrames`) and `xIconUrls` (a loop with try/catch). Glims and purse differ only
  in keys (`glims-art.ts:30–51` vs `purse-art.ts:35–56`). BootScene calls them one by
  one (`BootScene.ts:62–80`).
- **Svelte cards.** These are CSS plus markup, by jscpd: `GuidesTab.svelte` ≈
  `QuestsTab.svelte` step-list card (3 clones, 78 lines); `LibraryPanel` ≈ `PapersTab`
  (4 clones, 73 lines); `HearthPanel`/`DeskPanel`/`WoodpilePanel` ≈ `WorkshopPanel`
  (7 clones, ~120 lines); `WorldChoiceGate:205` ≈ `WorldMove:319` option card.
- **Content read around its catalog.** `lib/homestead.ts:13` re-reads `items.json`
  with a cast instead of `ITEMS`. `workshop.ts:91,98` scans raw `papersRaw`.
  `rooms.ts:77` reads raw `story.spots`, and `clock.ts:58` raw `residentRaw`. All of
  these bypass validated loaders that exist (`items.ts:151`, `story-tables.ts:291–293`).
  The same issue is server finding 7 (papers).
- **Build inputs in `src/`.** `content/papers.ts:216–315` (`FIND_RULES`,
  `designedRule`) is read only by `scripts/papers.ts`. `game/ground-heal.ts` is read by
  `scripts/build-atlases.ts` and a test. The October review asked to move it.
- **Leftovers.** `ui/map-renderer.ts:77,183` has two private FNV loops beside
  `lib/hash.ts`. There are 51 literal `setDepth(4001|5000|9000…)` calls and no depth
  table. 35 `EV.toast` literals in `src/game` (six in `link.ts:1037–1508`) sit outside
  `src/content`.

**Impact.** Each is small. Together they are the "same idea, new file" pattern in
miniature: a new art pass or panel copies the nearest neighbour, and content consumers
can disagree with the validated catalog.

**Before → after.** An `ICON_PASSES` table (`{packedKey, prefix, icons}`) with one
`createIconPass`/`iconUrls` pair. `StepList.svelte` for Guides/Quests, a shared
shelf-row snippet for Library/Papers, and promoting the workshop family's CSS into
`app.css`. Read `ITEMS`/`PAPER_RULES`/`STORY` instead of raw JSON. Move `FIND_RULES`
into `scripts/` or a `content/papers-design.json`, and `ground-heal.ts` into
`scripts/`. Use `fnv1a32` in the map renderer. Add a `depths.ts` with the dozen values
that repeat.

**Effort/risk:** S each, low. The art-pass table needs an atlas/icon test run
(`atlases.test`, e2e texture hashes). The Svelte extractions need the screenshot specs.
Keep each pass's texture prefix and missing-art fallback. Hash: the map renderer's FNV
must keep its exact output if it seeds anything persistent; check before swapping.

### 8. Dead and vestigial code the guard doesn't see

**Evidence.** `tests/dead-exports.test.ts` fails an export whose **name** appears nowhere
else. That misses re-exports through a shim, exports used only in their own file, and
names that are shared by coincidence. knip (scratch config, `src/lib/gen` ignored)
reports 152 unused value exports and 257 unused exported types. Classified:

- **Unused anywhere (17):** the 14 `parse.ts` re-exports (finding 4), `untrack`
  (`wilds/ops.ts:68`; a coincidental clash with Svelte's `untrack`), and two
  deliberately kept names (`unlockedAbilities`, `ECHO_SETTLED_LINE`).
- **Used only in their own file (~135):** e.g. `link.ts` `dispatchMutation`,
  `retryDelay`; `wilds/coords.ts:22` `chunkOf/localOf/floorDiv`; `fishing.ts`
  `waitSeconds/bankTileMid/bandById`; seven `stable-layout.ts` constants. The fix is to
  drop `export`.
- **Types:** most of the 257 are `XxxDeps` interfaces and result types used only beside
  their class. That is fine and should not be churned (see "not worth doing").
- **Vestigial modules** (finding 3): `progress.ts`, `save.ts`'s game-save half,
  `habitica/sync.ts`'s local sync, the library's local half, and `ConnectedCache`'s
  "old cache" comment.
- **Naming leftovers:** `game/expansion.ts` (the art loader) and
  `content/expansion-writing.ts` (15 importers) are named after a retired milestone;
  `fingersnap-*` texture keys (`runtime-art.ts:25–27`, `moves.ts:140`).
- knip's "unused dependencies" `@fontsource/*` are **false positives**: they are imported
  from `app.css:1–3`.

**Impact.** Exported in-file helpers look like supported module API, so newcomers import
them. Re-export shims hide which module owns a parser. The current guard gives a false
sense of completeness.

**Before → after.** Drop `export` from the in-file-only values in one sweep per folder,
and delete the shim. Optionally run knip in CI with a checked-in config that ignores
`gen/`, lists the e2e/scripts entries, and ignores exported types. Rename `expansion*`
when those files are next touched.

**Effort/risk:** S, very low (`tsc`, `svelte-check`, `npm test`). Keep the
`dead-exports` test: it is cheap and catches the common case.

### 9. Folder layout no longer says what is pure, what is client and what is Phaser

**Evidence.**

- 92 of the 174 files in `src/game` (17,674 lines) never import Phaser. They include
  `link.ts`, `session.ts`, `village.ts`, `homestead.ts`, `items.ts`, `papers.ts`,
  `event-names.ts`, `materials-order.ts`, `rumour-watch.ts`, `presence-feed.ts`, the
  Wilds `store.ts`/`map-data.ts`/`ops.ts`, `entities/fight-rules.ts` and
  `world-talk.ts`. 44 UI files import from `src/game`, mostly these.
- **Topics spread by prefix rather than by folder.** Fights span 13 files in 4 folders
  with two prefixes: `lib/combat{,-moves,-timing}.ts`, `lib/fight-{math,interp,options}.ts`,
  `entities/fight-{rules,strike}.ts`, `entities/{server-enemies,enemies,creatures,warden,projectiles}.ts`,
  `wilds/{camp-fights,dev-fight-fall}.ts`. Presence spans 9 files (`lib/presence*.ts`
  ×4, `game/presence{,-feed}.ts`, `content/presence.ts`,
  `entities/{presence-moments,remote-players}.ts`).
- Two `game → ui` imports remain: `entities/interactables.ts:15` (`ui/device`) and
  `scenes/world-controls.ts:10` (`ui/store.svelte`).
- `src/ui` is flat with 85 files (owner decision: folders last).

**Impact.** A newcomer can't tell from a path whether a module may import Phaser, is
unit-testable in Node, or owns network state. The earlier review's "half of src/game is
the client domain" has grown since October 7 (it was ~9.2k lines then).

**Before → after.** Introduce `src/client/` for the Phaser-free client domain: Link,
Session, the per-session stores, the Wilds store, materials ordering, the event
registry and presence feed. Leave `src/game/` meaning "Phaser". Add one README line per
top-level folder. Within `src/lib`, group the fight rules as `lib/fight/` (math, interp,
moves, timing, rules) when the next fight change lands. Fix the two `game → ui` imports
by passing `isTouchFirst` and the UI flag through deps.

**Effort/risk:** M, low technical risk (`tsc` proves the moves), high merge-conflict
cost. Do it as the owner already decided for `src/ui`: last, in one sweep, between lanes,
with no behavior changes mixed in. Moving `link.ts` alone first is reasonable if the
outbox extraction happens anyway.

## Proposed refactor plan

Each row is a stage, and each bullet-sized task in it can be its own PR. No stage
needs a server or wire change. Guards are unit tests plus only the e2e specs that a
change touches; run the full e2e suite once per merge (memory: e2e load).

| Order | Independently shippable work | Value / effort / risk | Review and validation boundary |
|---|---|---|---|
| 1 | Add `tsconfig.tests.json` and fix the 80 test type errors; add it to `verify`. Drop `export` from in-file-only values; delete the `parse.ts` shim, `Progress`, and the duplicate `PaperRule`. One `lib/api/decode.ts`. | Makes every later stage safer; S; low. | `tsc` ×3, `svelte-check`, `npm test`. No behavior change. |
| 2 | `e2e/hooks.ts` typed by `FsHooks`; UI hooks onto `expose()` with the 4 missing names; promote `remotes`/`twoPlayers`/`quests`/`shot`. Migrate specs as touched. | Cheaper e2e maintenance; S–M; low. | `typecheck:e2e`; changed specs only. |
| 3 | Type the five untyped mutations through their generated request schemas. Introduce one route table shared by `operations.ts`, `TYPED`, `client.ts` and the mutation dispatch; store route keys in the outbox. | Ends path drift; M; medium. | `link*`/`api-client` tests; exact stored-body replay tests; village/homestead/items specs. Decide on queued-entry compatibility first. |
| 4 | `Link.operation()` and convert the typed façade methods, then converge outcome shapes on `Result<T>` caller group by caller group. | ~250 lines out of Link; S–M then M; low. | `link-fishing`, `link-companions`, `link-failures`, `camp-fights`; unchanged `offline`/`barrier`/`key` options per method. |
| 5 | Make `Session.link` non-null; port guest-session tests to the link rig; delete local saves, local Habitica sync, the library's local half, `progress.ts`, and resolve each `TODO(C1/C2/D)`. | One persistence path; M; low prod risk. | `tsc` lists every branch; ported tests; onboarding/connected/papers specs. |
| 6 | Domain parsers return `{state, result}`; delete `parseSnapshot` from the answer path; narrow view types per domain. | Removes the second state representation; M; medium. | Decoder tests; domain e2e; no change to the predictor's `gameStateOf`. |
| 7 | Then the step-back's outbox extraction (C18) out of a Link that no longer holds domain methods. Adopt a shared ordering helper in Items/Homesteads when they are next touched (finding 6). | Durable ownership clarity; M; medium. | Existing durability/ordering test suites; as specified in step-back C18. |
| 8 | Small shapes (finding 7) at any time, each alone. Folder moves (finding 9) last, in one sweep between lanes. | S each; folder move M churn. | Atlas/screenshot specs for art and Svelte; `tsc` for moves. |

**Optional clean-break lane (owner decision):** drop the `fingersnap*` storage keys and
IndexedDB name, `FINGERSNAP_API`, `installLegacyDbPath`, and queued outbox entries
written with old paths. These are behavior changes (they reset local preferences once),
not part of the behavior-preserving stages.

## What is not worth doing

- **Don't build a generic client store framework** for Village, Items, Homesteads and
  the Wilds. Their read granularity, mirrors and refusal handling differ for real
  reasons. A shared ordering helper (finding 6) is the only common piece with a proven
  need.
- **Don't split Link mechanically by line count.** The step-back's warning stands:
  persist-before-visible, one sender with fencing, exact-key replay and head-of-line
  order must stay in one owner. Finding 2 removes duplication *around* that core; it
  doesn't cut through it.
- **Don't replace the `as unknown as` narrowing casts in the content loaders** (12
  sites, e.g. `items.ts:59`, `story-tables.ts:237`). They narrow generated `Valid` types
  to string-literal unions after runtime checks ("vocabularies narrowed once, at the
  loader"). An `asserts` function per family would add code without catching more.
- **Don't churn the `XxxDeps` interfaces or result types that knip calls unused.**
  Exported deps types document the entity seam that the October review asked every new
  module to follow.
- **Don't unify presence, fight observation and HTTP operations behind one transport
  abstraction.** Real-time swings and casts deliberately bypass the durable queue
  (`fight-strike.ts`, `presence-feed.ts`). That separation is why the outbox is no
  longer urgent.
- **Don't route session-level UI calls (invites, world view, prompts) through Link.**
  `WorldCard`, `InvitePanel`, `PartyPrompt` and the account flow call lease-free reads
  and writes on the queued API client. That is correct: they don't carry play state.
- **Don't chase a global CSS de-duplication or colour sweep before the big-component
  splits.** Most Svelte duplication is CSS inside components the step-back already
  plans to split (C18). Do tokens and shared cards as each split lands, with screenshot
  specs.
- **Don't consolidate the hand-written predictor rules into generated code.** They are
  deliberate twins of server rules with shared vectors (`crafts-fixtures.json`,
  `combat.json`, `fights.json`…), which is the right tool for "a copy kept only to draw
  before the answer".

## Verification and limits

Only this report was written. No source, configuration, generated output, dependency or
git state in the worktree was changed. Scratch configs and tool installs lived in the
session scratchpad; `node_modules` (symlinked to the main checkout) was not modified.
No e2e, browser, live server or production account was used.

- `npx tsc --noEmit`: exit 0.
- `npx svelte-check --tsconfig ./tsconfig.json`: 801 files, 0 errors, 0 warnings.
- `nice -n 10 npm test`: 2,329 passed, 0 failed (~18.7 s).
- `tsc --noEmit` with a scratch config over `tests/**`, `src/**` and `scripts/**`
  (unused-locals off, Node types): 80 errors, all in `tests/`.
- `knip@5` with a scratch config (entries: `src/main.ts`, tests, e2e, scripts, perf,
  workers; `src/lib/gen` ignored): 152 unused value exports, 257 unused exported types,
  0 unused files. Classified by own-file and repository word counts as described in
  finding 8. Its unused-dependency report for `@fontsource/*` is a false positive, and
  `@bufbuild/buf`/`protoc-gen-es` are used by `scripts/proto.sh`.
- `jscpd@4` (min 6 lines / 60 tokens): `src` TypeScript 0.19% (14 clones, 119 lines);
  `src/ui` + `App.svelte` as markup 1.59% (24 clones, 378 lines); tests + e2e 1.16%
  (59 clones). Token matching, not a measure of semantic duplication.
- Counts of boilerplate fragments, branches, casts, hooks and helper names came from
  `rg` over this snapshot; each cited count names its pattern.
- Not done: no Vite production build, no bundle-size measurement, no madge cycle graph,
  no e2e or screenshot runs. Findings describe maintenance cost and preserved
  invariants. They are not claims of newly reproduced player-facing bugs. The untyped
  mutation bodies and the unconditional mutation trust in finding 1 are structural
  observations, not observed failures.

## Done
