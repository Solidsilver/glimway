# Tests, tooling and docs review

## Map

The root is a small npm/Vite/Svelte app plus a Go server module (`go.mod`). `npm run verify` chains TypeScript, Svelte, Node's built-in test runner over `tests/*.test.ts`, and the production build; Go tests are separate (`go test ./...`, with a longer race-detector command in `docs/testing.md`). `tests/` has 54 focused TS test files, including parity/vector checks. `e2e/` has Playwright specs, shared browser/game helpers, a worker-local Go/fake-Habitica backend, and `changed-map.json`; `scripts/e2e-changed.ts` selects relevant specs or smoke/full tiers from the diff. `playwright.config.ts` runs Chromium workers against one routed Vite instance. The README is the user/developer entry point; `docs/testing.md` has the detailed contributor playbook. Other docs mix current contracts/design with dated reviews, playtest records, and generated-art request history.

Surprise for newcomers: browser tests can quietly depend on the `server: true` fixture to inject a per-worker routing cookie, while guest tests deliberately block `/api` (see `e2e/fixtures.ts`, `e2e/server/vite-routing.mjs`). Another is that screenshot specs skip unless `SCREENS=1`, although they are in the same Playwright project.

## Findings (ranked by payoff / risk)

### 1. Retire obsolete runtime-contract guidance (M, low risk)

`docs/runtime-contract.md:24,103-139,178` still specifies the original quest machine (`guardian-defeated`, defeat event, full restore on defeat) and explicitly calls this a “milestone-2 local rule”; current README describes the warden being settled by speaking and imported health constraints. `docs/import-contract.md:235` also refers to “M2 full restore” without linking the current source. These are operationally misleading, not just historical. Replace the stale contract with a short pointer to current module contracts/tests, or rewrite it against current code; label dated reviews and playtests as historical at the top. Guard with a docs/code consistency review and existing quest/save/health tests.

### 2. Remove unused e2e helper exports and clarify generated assets (S, low risk)

`npx knip` reports 4 unused generated `integration.js` files, 69 unused exports, and 4 unlisted binaries. Verified examples: `e2e/helpers.ts:60,221` (`areaCards`, `frame`), `e2e/home-helpers.ts:10,162` (`OUT`, `SILAS_AT`), and `e2e/party-helpers.ts:12` (`answerWorldChoice`) have no consumers; `e2e/connected.ts:18` and `e2e/server/backend.ts:22,39-40` also have unused exports. Remove dead exports and either remove obsolete generated integration files or mark/relocate these as reference material so they are not mistaken for shipped code. Knip's two “unused dependencies” are false positives: both font packages are imported by `src/app.css:1-3`. Its binary findings (`go`, `sqlite3`, `cwebp`, `dwebp`) are actual external prerequisites worth documenting near the scripts that call them. Guard with `npx knip` and relevant unit/e2e specs.

### 3. Reduce e2e helper surface and residual wall-clock waits (M, medium risk)

`e2e/helpers.ts` is 746 lines and `e2e/home-helpers.ts` 285 lines; the additional helpers are spread across `connected.ts`, `fixtures.ts`, `party-helpers.ts`, and `server/`. This has useful coverage but a newcomer must learn a large bespoke API. `docs/testing.md:111-157` already prescribes condition/frame-based waits, yet there are 47 `waitForTimeout` calls in specs. Many are intentional screenshot pacing, but live behavior waits remain in `e2e/coop.spec.ts:60,95,138,160`, `presence.spec.ts:162,177,189`, and `review-fixes.spec.ts:149`. First group helpers by purpose, document a short “preferred waits” index, and replace the non-visual pauses with observable predicates; leave explicit screenshot timing alone. Guard with repeated/parallel runs of touched specs and the full suite after changing shared helpers.

### 4. Keep the changed-test map aligned with actual coverage (S, medium risk)

`e2e/changed-map.json` is a hand-maintained routing table with broad overlapping rules (e.g. `src/game/area/**` maps to gathering and quest-related specs; API paths map through connected and party specs). The fallback smoke behavior in `scripts/e2e-changed.ts` is a sound safety net, but a path can select too many specs or miss a behavior-specific spec as the map evolves. Add a lightweight `--list` self-check for representative paths or a documented mapping review whenever a system/spec is added. Verify with `E2E_CHANGED=... npm run test:changed -- --list`; no browser run needed for the planner.

### 5. Consolidate documentation around current sources of truth (M, low risk)

There are 25 Markdown docs within the first two levels of `docs/`, plus a 1,056-line `docs/expansion-design.md`, 810-line `docs/home-server.md`, 463-line README, 407-line `ASSETS.md`, and 185-line testing guide. Current architecture is spread across README, milestone records, runtime/import contracts, art specs, and several playtest notes. Some duplication is purposeful (README quickstart vs detailed testing guide), but milestone docs often present old behavior as current: e.g. `docs/build-status.md:29-52` records fixed ports/one-worker timing from Oct 4 while `docs/testing.md:56-76` and current config use per-worker free ports and parallel execution. Make README the user guide, `docs/testing.md` the sole test workflow reference, keep contracts as current invariants, and move dated status/review/playtest artifacts under an explicitly historical index. Guard with link checks and a manual spot-check against package/config.

### 6. Make static analysis reproducible in the documented environment (S, low risk)

Requested command `staticcheck ./...` did not reach analysis: it failed to create `/path/to/glimway`; retrying with `XDG_CACHE_HOME=/tmp` still used that default path. Since the report cannot distinguish code findings from an environment failure, run it in CI or document a supported cache override in the tooling setup. The Go tests remain separate from `npm run verify`; consider a single CI aggregate that runs both without forcing local web work to pay the Go race-test cost. Verify with `staticcheck ./...` in CI and `go test ./...`.

## Tool results

- `npx jscpd src server content --min-lines 8`: 131 clone pairs, 1,725 duplicated lines of 109,378 analyzed (1.58%). Verified hits include repeated panel CSS (`DeskPanel.svelte`/`HearthPanel.svelte`/`WorkshopPanel.svelte`), Go API/store code, and 16 TypeScript clones (191 lines). CSS is the largest area (664 duplicated lines); avoid blanket extraction of small UI variants. Cross-area candidates are noted below.
- `npx knip`: 4 generated `integration.js` files, 69 unused exports, 4 unlisted binaries. Font dependency warnings are false positives due to CSS imports. Verified unused helper examples are above; validate other exports before deleting, since dynamic/test-only use can be invisible to static entry analysis.
- `staticcheck ./...`: not completed; cache initialization was denied as described above.

## Keep as is

- The test tiers are economical and explicit: `verify`, Go tests, smoke, changed, full e2e, and opt-in screenshots. Changed tests have a conservative smoke fallback for unmapped source paths.
- E2e fixtures isolate each test's player/world and each worker's server/database; disabling HMR during the run avoids mutating the tested page. `docs/testing.md` gives practical flake-debug steps and favors game-frame predicates over sleeps.
- Unit tests exercise rules and persistence directly while e2e covers browser integration and cross-system flows. This overlap is valuable at different boundaries; do not collapse browser journeys into unit tests.
- The README clearly separates guest, connected-character, and shared-world modes and points readers to implementation sources.

## Cross-area notes

- The jscpd results include code-level cleanup outside this area: shared panel styles in `src/ui/DeskPanel.svelte`, `HearthPanel.svelte`, and `WorkshopPanel.svelte`; repeated API patterns in `server/internal/api`; and TypeScript duplicates around art loading and world logic. Route those to UI/server/game reviewers rather than extracting from the tooling review.
- Knip's remaining unused-export list is mostly application/API symbols across `src/content`, `src/game`, and `src/lib`; these may be intentional module API or test targets. Each owner should check references and public intent before removal.

## Proposed order

1. Fix or replace `docs/runtime-contract.md` and remove obsolete milestone-era instructions.
2. Remove verified dead e2e helper exports; clarify generated `integration.js` status and document external binaries.
3. Replace behavior-related fixed waits in `coop.spec.ts`, `presence.spec.ts`, and `review-fixes.spec.ts` with state/frame waits.
4. Add a cheap changed-map planner check for representative code paths.
5. Reconcile `docs/build-status.md` and README test setup with current ports, workers, and suite timing; establish a historical-doc index.
6. Make `staticcheck` run reproducibly in CI and record its findings.
7. Ask area owners to review their confirmed jscpd clusters and Knip exports, one focused change per module.
