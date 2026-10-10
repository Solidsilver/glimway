# Fingersnap build status

> **Historical: a snapshot from 2026-10-04, not kept current.** What the game
> does now is in the README; how to run the tests is in
> [testing.md](testing.md). Since this was written the playtests moved to
> parallel workers with a Go server per worker on free ports, so
> `E2E_API_PORT`, `E2E_HABITICA_PORT` and the one-worker advice below no
> longer apply. Several "not built yet" items (world moves among them) have
> been built since.

Updated: 2026-10-04 (expansion phases 1–6, papers and the library, the
canon pass, the Commons and the Tangle merged on `expansion`).

## Current status

| Area | Status |
|---|---|
| Guest game | The lantern road quest, three curated areas, combat with telegraphed enemies, the settled warden, glims (embers before 0.6.1) and spends, local saves with save codes. |
| Habitica (read-only) | Connect guide with paste/Swap and opt-in Remember; class kits, effective stats, layered avatars, pets and mounts; the approved imported-health policy. |
| Connected play | Go server with login-only token check, allowlist and invites (readable codes), recorded syncs with plausibility checks and checkpoints, revisions and one play lease, offline play and reconnect, guest-save migration. |
| Homes | Hearthwick Commons, plots, campsite → cottage → workshop, 14 decorations with placement, storage and crafting, home rest, read-only visits. |
| Wilds | The Tangle (inner region): camps, nodes, chests, points of interest, trinkets, fallen-hero lanterns; a local Tangle for guests. Beyond it, the Whitequiet (outer region): new land every wick with a look for each Mark, the Turning ("the Wilds shift"), and Echoes of the Six to settle; guests generate both regions locally. |
| Village | Game calendar (one wick = 7 days) with festivals, notice board, six village projects, mail. |
| Papers | 52 papers in eight collections (13 on the shelves from the start, 39 to find, all obtainable in-game), Journal tab, Hearthwick Library with a shared per-world shelf. |
| Presence | `/ws` rooms with avatars, name tags, interpolation and emotes. |

Not built yet: Garden and Hall tiers,
Habitica-driven decoration, co-op combat, world moves, checkpoint rewind,
purchases, music. Real-account Habitica sign-in has only been exercised
against fixtures and a fake Habitica server.

## Verification commands

```sh
npm run verify                     # tsc, svelte-check, unit tests, production build
go vet ./... && go test ./...      # server, shared content, parity vectors
E2E_PORT=5203 E2E_API_PORT=18203 E2E_HABITICA_PORT=18303 npm run test:e2e
                                   # Playwright: Vite + real Go server + fake Habitica, one worker
npm run vectors && npm run vectors:wilds && npm run vectors:calendar && npm run papers
                                   # regenerate shared data; no diff means it is current
```

Last run (2026-10-04, `exp/connected` at the merged `expansion`):
`npm run verify` — svelte-check 0 errors / 0 warnings, 373/373 unit tests,
build OK; `go vet` clean and `go test ./...` OK in all seven packages; the
four generators leave no diff. Playwright (84 tests, one worker, 16.7 min):
81 passed, 3 failed, all in `e2e/review-fixes.spec.ts`. "Findings 5 and 7"
passed on rerun. Two fail every time on the merged tree:

- **"finding 2: the Wilds arch is overgrown"** still expects the old blocked
  arch, but b62291c deliberately lets connected players into the Wilds. The
  test needs updating to the new behaviour.
- **"finding 1: a purchase and an upgrade whose answers are lost resolve on
  reconnect"** no longer sees the paper "Orrin's Drift-Slap Foundation
  Standard" after the lost cottage upgrade resolves. It passed before the
  Tangle and homestead review-fix merges, so one of those regressed it.

The playtests run with one worker (real-time movement drops frames when two
browsers compete). On a heavily loaded machine an occasional 90-second
timeout can happen; `npx playwright test --last-failed` reruns just those.

## History: milestones 2–3 (October 2–3, 2026)

The notes below are kept as the record of the first playable demo and the
read-only Habitica import. Some details have since changed. The warden is
now settled rather than fought to defeat. The route to Brackenwood is the
east gate. Touch controls are a joystick plus roll, ✦ and action buttons.

Result at the time: everything in M3 (read-only Habitica import, four class kits,
effective equipment stats, layered avatars, pet followers, outdoor riding,
approved health policy) plus the delivered NPC/guardian/class-effect art pass:
NPC breathing animations (bob removed, feet planted), the guardian's five
discrete native poses wired into the combat state machine (hurt flash that
never cancels a lunge, telegraph tell that survives hits, defeat pose held
through the dissolve, corpse physics frozen), and per-class delivered FX
(animated bolts/cleave/dash-trail/heal-pulse; static aliased basics with
cardinal rotation). Coordinator/root independently ran `npm run verify`:
TypeScript clean, Svelte 0 errors/warnings, 140/140 tests, production build
successful. Browser evidence and remaining test limits:
`docs/playtest-runtime-art.md`.

### Kickoff blocker — resolved

`BUILD_KICKOFF.md` "Current blocker" (October 2, 2026: coordinating session
could not reach the herdr socket; OpenCode could not open its log; sandbox
policy rejected the approved herdr command; no agents started, no application
code) is **outdated and resolved**.

Resolution: both agents are now running inside Herdr-managed panes in this
workspace (runtime agent `snap_runtime`, shared-logic agent `snap_state`,
with a coordinating Codex pane). The herdr socket is reachable from these
panes (`HERDR_ENV=1`; `herdr agent list` shows all three). Application code
has been generated by both agents; the demo is being browser-playtested.
No sandbox or permission changes were needed from the code side — the
earlier failure was in a different session context.

### Shared-logic work (owned here) — complete for milestone 2 slice

| Deliverable | Status |
|---|---|
| `src/lib/state.ts` — types, `createNewGame`, `validateSave`, `advanceQuest`, `questObjective`, `recoverFromDefeat` | done |
| `src/lib/save.ts` — queued IndexedDB v1 saves, `loadGame`/`saveGame`/`exportSave`/`importSave`/`clearSave`, corrupt-save protection, import limits | done |
| `src/content/world.ts` — dialogue for `mara/pip/orrin/clue/lantern`, journal, locations, `DEMO_CHARACTER` | done |
| `tests/` — 35 tests, Node test runner, fake IndexedDB | done, 35/35 pass |
| `docs/runtime-contract.md` — API surface, NPC ids, quest-event ownership, defeat rule | done |
| `docs/habitica-foundations.md` — dated research record (read API, stats double-counting, licenses, CORS limits, purchase uncertainties) | done |
| `ASSETS.md` — asset register (generated packs, prompts, pending art, license pending) | done |
| `src/game/expansion.ts` — typed port of delivered `integration.js` (four helpers) | done; runtime integration cast-checked, flagged in playtest notes |
| Content geography fix (north gate → west gate, 5 sites in `src/content/world.ts`) | done; matches demo map west exit |

### M3 slice 1 — Habitica import foundation (shared-logic side complete)

| Deliverable | Owner | Status |
|---|---|---|
| `src/lib/habitica/types.ts` — Credentials (in-memory only), Profile (+costume/useCostume/selectedPet/selectedMount, hair slots), Client (fetchProfile only), CombatKit, save-v2 shapes | snap_state | done |
| `src/lib/habitica/client.ts` — read-only GET /user, x-api-user/x-api-key/x-client, minimal `userFields` (incl. costume/companions), 429 Retry-After backoff, timeout, typed `HabiticaApiError`; default gear lookup = catalog `gearStatsFor` | snap_state | done |
| `src/lib/habitica/mapping.ts` — `toHabiticaProfile` + `effectiveStatsFor` (statsComputed formula, class bonus once per matching item, costume never counts), `validateHabiticaProfile`, `MAX_HEALTH` (maxHealth F1 fix) | snap_state | done |
| `src/lib/habitica/fixtures.ts` — lowLevel/highLevel/classless/lowHp/variedEquipment, realistic projected payloads (no fabricated computed stats) | snap_state | done |
| `src/lib/habitica/sync.ts` — `syncProfile` reconciliation (village-only, one-time deltas w/ baseline advance, clamp-down, account-switch reject), `applyImportedProfile`, `resolveDefeatRecovery` (imported caps, zero stays zero), `passiveRegenAllowed`; zero writes | snap_state | done |
| `src/lib/combat.ts` — `getCombatKit` (class kits, diminishing-returns bounds, healer = pulse + heal, starter bolt) | snap_state | done |
| `src/lib/save.ts` — save v2 (`vitalsSource` + `importedProfile`), v1 migration, `importedProfile: null` explicit baseline clear, `loadSaveRecord`/`importSaveDocument` | snap_state | done |
| `src/lib/habitica/gear.ts` + `avatar.ts` + catalog + asset docs | snap_assets | done |
| `docs/import-contract.md`, `docs/m3-implementation.md`, tests (35 at M2; 140 total now) | snap_state / snap_assets | done |
| Connect Habitica panel (normal UI), in-memory credentials, cancellation | snap_runtime | done |
| `docs/runtime-import-notes.md` — vitals/abilities/appearance consumption design | snap_runtime | done |
| Wiring pass: `syncProfile`, durable rollback/reset/restore, regen gate, combat kits, creator X-Client tag | snap_runtime | done |
| Avatar/costume, pet follower, correctly aligned cached mounts, fallback notices | snap_runtime / snap_assets | done |
| Desktop, phone touch, production preview, delayed network and IndexedDB completion checks | snap_runtime | verified; see `docs/playtest-m3.md` |

Decisions: credentials via local `.env` (`HABITICA_USER_ID`/`HABITICA_API_TOKEN`, gitignored, Node/dev-only — never `VITE_*`, never bundled); production path is runtime form entry with in-memory-only credentials. One GET per explicit sync press — no polling, no per-frame calls, no writes ever. Approved imported-health policy (village-only sync, one-time external-heal credit, defeat caps) recorded in `docs/m3-implementation.md`.

### Commands

- Tests: `npm test` (i.e. `node --test tests/*.test.ts`) — no test deps. 140/140 pass.
- Full verification: `npm run verify` — TypeScript and Svelte clean, tests
  green, production build successful. Build retains a large-bundle warning.
- Note for runtime: source/test imports use explicit `.ts` extensions;
  `allowImportingTsExtensions` is already set in `tsconfig.json`.

### Runtime-art pass (delivered October 3, 2026)

| Deliverable | Owner | Status |
|---|---|---|
| `assets/generated/runtime-pass/` (27 transparent frames, measured manifest, prompts, integration.js) + runtime copies in `public/assets/fingersnap/runtime-pass/` | snap_assets | done |
| `src/game/runtime-art.ts` — typed helper (`preloadRuntimeArt`/`createRuntimeArt`/`installRuntimeAliases`), manifest types, Node-safe | snap_assets | done |
| `tests/runtime-art.test.ts` — manifest contract (27 frames, rects in bounds, native sizes/origins, 7 anims, 7 aliases, PNG dims/alpha) | snap_assets | done, 140/140 total |
| ASSETS.md Register E + docs/runtime-asset-spec.md runtime-pass contract | snap_assets | done |
| BootScene wiring (preload → fallback generateTextures → native helper → alias replacement → World) | snap_runtime | done |
| WorldScene: NPC breathing (no bob), guardian 5-pose state machine, hurt/telegraph-tint/defeat/corpse fixes, per-class FX with fallbacks, `__fsEnemies`/`__fsDebug` read-only additions | snap_runtime | done; see `docs/playtest-runtime-art.md` |

### Demo decisions recorded

- Demo defeat rule: return to village spawn, full demo HP/mana recovery,
  story progress kept (`recoverFromDefeat`). Imported characters follow the
  user-approved policy in `docs/import-contract.md`.
- Art direction: Habitica-aligned pixel art; all delivered art is original
  generated work with in-repo prompts (`ASSETS.md` registers).
- Distribution license for original art **not selected** → no public
  deployment yet.

### Limitations / open items

- A **read-only** Habitica adapter exists (`src/lib/habitica/client.ts`,
  `fetchProfile` only — no write methods by construction). No live
  credentials are used in tests or the demo; no Habitica writes anywhere.
  Live import has not been exercised against a real account (pending test
  credentials); all mapping verification is fixture/catalog-based.
- Purchase design remains research-only; exactly-once claims are explicitly
  withheld (`docs/habitica-foundations.md`).
- Imported HP policy was approved by the user: no passive refill, village-only
  external-heal reconciliation once per baseline, defeat capped by last import.
- X-Client uses the configured public creator id
  (`5abfd539-22eb-457f-8e2a-9fb3d66731f1-fingersnap`).
- Browser playtesting **complete** — full keyboard quest playthrough, defeat
  recovery, reload resume, and phone touch layout all verified
  (`docs/playtest.md`); 10 playtest bugs found and fixed. M3 has its own
  fixture-based desktop/mobile/production pass in `docs/playtest-m3.md`.
- Avatar art cache contains 41 official PNG layers; uncached pieces are
  skipped with notices. Uncached mounts cannot grant invisible riding.
- Guardian encounter shape and spawn-position mapping decisions recorded in
  `docs/runtime-contract.md` and implemented.
- `docs/runtime-asset-spec.md` is runtime-owned; this file does not track it.

### Wrap-up state (M3 implementation complete; real-account check outstanding)

`npm run verify` independently green: tsc clean, svelte-check 0/0, 140/140
tests, production build ok. Real-account authentication is untested; phone
coverage is a touch smoke test, not a full quest (and the runtime-art pass
could not verify touch press-and-hold through the automation bridge — taps
only). Remaining art needs: none blocking — the October 3 runtime pass covers
NPC idle/breathing, guardian poses, and class-effect FX. Possible future
wants: enemy walk/attack move sets beyond idle, and audio. No audio yet;
original-art distribution license remains unselected. Purchases remain M4.
