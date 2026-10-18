# Step-back review after 0.12–0.13: tests, tooling, CI, deployment and docs

Snapshot: `190a9d38` — dev after the E2E health merge, before the 0.13.0 release commit. Review
only: this document is the only repository change. Paths are repository-relative. This is the
tooling lane (prefix **T**). It follows `2026-10-13-step-back-tooling.md` at `268c9b4`, and it
avoids re-raising calls already settled in `docs/decisions-overnight.md` (#18–#59).

No P1 in this lane. The flakes cost the owner and the lanes time, and the release gate reads
"green" while every dev run still leans on retries (T2–T4). Nothing in this lane breaks ordinary
play.

## Map: what changed in this area since v0.11.2

- **CI** (`.github/workflows/ci.yml`):
  - `exp/*` pushes now run only the changed specs (`scripts/e2e-changed.ts` against `origin/dev`,
    `:238–245`). `dev` and `main` run the full suite. A `full` dispatch input overrides this.
  - The first-paint long-task budget moved out of the suite into a manual `browser-performance`
    job (`:273–368`), which closes last round's finding 7.
  - Bounded evidence (`scripts/e2e-artifacts.mjs`: report, summary, capped traces) uploads
    `if: always()` from both E2E jobs. This closes last round's finding 11.
- **Changed-spec map** (`e2e/changed-map.json`):
  - Grew by about 300 lines: fights, lamps, camps, land chip, map tiers, ways home and sap.
  - Gained `!`-exclusions and `fallback` rules.
  - `tests/e2e-changed.test.ts` (83 lines) pins the plan for representative paths.
- **E2E**:
  - Five new specs: `camps`, `land-chip`, `lot-lantern`, `map-tiers`, `lamp-art`.
  - `e2e/paper-totals.ts` counts `content/papers.json` (after #46).
  - `e2e/read-retry.ts` retries a safe read once on a connection reset (last round's 10).
  - `bySilas` now pins his hour (last round's 2).
  - The focus-trap test records each sample with in-flight reads (last round's 4).
  - The way label is filtered by name (last round's 5).
  - `scripts/netif-shim.cjs` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` let the NixOS host run
    Playwright (#32).
  - Inventory: 79 spec files and 281 tests in a full dev run (273 on 10-16).
- **Unit tests**: about 25 new node test files (camps, communal lamps, crate picker, frontier
  reach, land chip, lot lanterns, map lamps, trowel, ways home, wick sap, web settings,
  dev-hooks gate…), plus Go tests per new API file and upgrade tests (for example
  `store/lasting_geography_upgrade_test.go`). `npm test`: **2,633 passed, 0 failed** at this
  snapshot. `npm run verify` passes.
- **Deployment**:
  - `deploy/nixos/instance.nix` (312 lines) makes the module instance-aware: `glimway.nix` is the
    live instance and `glimway-dev.nix` the staging one.
  - The new settings system is `server/internal/settings` and `deploy/glimway.example.toml`, which
    is generated, has a test and is reloaded on SIGHUP. Nix renders the file through
    `services.<name>.settings` (RFC 42) and checks it at build time with `check-config`.
  - Compose and the Dockerfile gained `GLIMWAY_DEV_TOOLS` and `GLIMWAY_CONFIG`.
  - `nix/module-check.nix` grew to 144 lines.
- **Migrations**: 038 to 048, all recorded in `server/internal/store/migrations/history.json`,
  hashed and append-only by test.
- **Docs**:
  - `docs/design/lamps.md` was rewritten.
  - `docs/design/server-settings.md` is new, and `docs/home-server.md` has a "Dev Glimway
    (staging)" section.
  - The changelog has its `[Unreleased]` section for 0.12 and 0.13 together, matching #51.

### Status of the 2026-10-13 findings in this lane

| Previous finding | Status | Evidence |
|---|---|---|
| 1. Fights unmapped in the selector | **done** | `fights-shared`/`fights-server` rules in `e2e/changed-map.json`. The same defect is back for the 0.13 domains: see T1. |
| 2. `bySilas` | **done** | Pins the hour with `setHour(…, server: true)` and polls with a message (`e2e/home-helpers.ts`). Silas has not appeared in the CI tally since. |
| 3. Remember/forget `toBeHidden` | **open, quiet** | `e2e/onboarding.spec.ts:130` still uses the default 5 s budget, but there were no events in the last two days. |
| 4. Focus-trap one-shot samples | **done** | Samples carry focus and in-flight reads (`e2e/inventory.spec.ts:169,174`). No events. |
| 5. Way-label strict mode | **done** | `e2e/paths.spec.ts:469` filters by name. |
| 6. `open-map` settle barriers | **partly** | `open-map:318` and the motes tween check (`:528`) still flake: see T4. |
| 7. Long-task budget in the suite | **done** | `browser-performance` job (`ci.yml:273`). |
| 8. Quarantine prose | **done** | `docs/testing.md:394–398` says there are none. |
| 9. Go land fixture | **done** | No Go failure in 56 verify runs. |
| 10. ECONNRESET | **done** | `e2e/read-retry.ts`, `e2e/connected.ts:366`. |
| 11. Flake evidence | **done** | `scripts/e2e-artifacts.mjs`, `if: always()`. |
| 12. Single runner queueing | **open** | Now measured: see T5. |
| 13. Scaling/perf prose | **done** | `docs/scaling.md:59–61`, `docs/testing.md:63,390`. |
| 14. Small doc drift | **partly** | `docs/server-behavior.md:490,494,501` still say JSON presence and name `src/lib/presence.ts`. `README.md:444` says "all five" but `verify` runs six commands (`package.json:16`). |

## CI history, 2026-10-16 00:00Z → 2026-10-18 ~11:00Z

The data is 58 `CI` runs, all from pushes: 33 dev, 21 `exp/*` across 12 branches, 3 main and 1
tag. Durations come from `gh api …/runs/<id>/jobs`. Flake counts come from each E2E job's
Playwright summary. "Flaky" means the test failed and then passed on the one retry
(`playwright.config.ts:63`). "Hard" means both attempts failed.

| Job | Runner | Median | Range | Notes |
|---|---|---:|---|---|
| `verify` | GitHub | 17 min | 11–21 | 56 green, 1 cancelled. **No** Go, disk or hash failures in the window. |
| `e2e smoke` | GitHub | 3.4 min | 2–6 | 3 red. Since 10-17 15:22 about half the runs carry the `items:161` flake (T2). |
| `e2e full`, main | self-hosted | 18.8 min | 18.4–19.1 | 3 green. |
| `e2e full`, dev | self-hosted | **25.1 min** | 18.3–**41.3** | 12 green, 11 red, 9 cancelled by a newer push. 39044754368 used 41 of its 45 minutes. |
| `e2e` changed, `exp/*` | self-hosted | 15 min | 1–17 | 6 more `exp` runs escalated to the full suite (25–40 min) because they touched shared E2E files. |
| Queue before `e2e full` | self-hosted | dev 3 s, **exp 9 min** | up to **48 min** (dev, 39076086333) and **55 min** (exp, 39099709416) | GitHub-hosted jobs start within seconds. |

Totals: 103 adverse entries, 72 flaky and 31 hard. Most hard failures were regressions that a
later commit fixed:

- `paths:148` and `camps:65` (#26, #30);
- the logout and atlas failures (#35, #41);
- the stale paper totals on `connected:173`, `inventory:36/225` and `papers:29` (#46);
- `lot-lantern:19` (#49);
- `rumour:37`, with 5 hard failures, fixed by `exp/rumour-fix`.

The persistent flakes are in T2–T4.

**After the E2E health merge:** both dev runs (`3a1c40b2`, `190a9d38`) are green, but **7 flakes
in 2 runs**, against 1.4 a run over the window. At `190a9d38` the flaky tests were `items:113`,
`playtest1:189`, `presence:107`, `seam:303`, `version:109` and `wilds-outer:139`, plus `items:161`
in smoke. Two runs is a thin sample. Still, the lane's own runs reached zero flakes, and that did
not carry over to dev.

## Findings

### T1. The changed-spec selector misses most of 0.13, and the shared content files only run smoke

**P2 · S · Confirmed** (exercised with `E2E_CHANGED=… node scripts/e2e-changed.ts --list`; no
tests run).

**Evidence:**

- **Shared content JSON has no rule.** `content/papers.json`, `items.json`, `crafting.json`,
  `quests.json`, `story.json`, `homestead.json` and `furnishings.json` each plan "→ the smoke
  tier". Only `content/wilds*`, `places.*`, `layouts*`, `repairs`, `enemies`, `combat`,
  `abilities` and `contract` are mapped (`grep -o '"content/[^"]*"' e2e/changed-map.json`).
- This is #46's failure, waiting to happen again. The Keeper's hand added a paper, the paper
  totals in `connected`, `inventory` and `papers` went stale, and only dev's full run caught it.
  Today `e2e/paper-totals.ts` itself maps to those four specs, but the file it reads,
  `content/papers.json`, does not. The way-lamp recipe (`crafting.json:572`), the trowel
  (`:196`) and the lamp items in `homestead.json:604–684` are equally invisible to an `exp/*` run.
- **The 0.13 server files fall into the broad API catch-all.** These files all plan →
  `connected`, `connected-screens`, `onboarding`, `polish`, never the spec that exercises them:
  - `server/internal/api/common_ways.go` (the common path test is `paths.spec.ts:297`);
  - `frontier_reach.go`, `claim_rules.go` (`camps`/`lot-lantern`);
  - `store/holds.go`, `store/reach.go`, `store/commons.go`.

  `server/internal/holds/**` goes to smoke only.
- **Unmapped, smoke only:**
  - `src/content/quests/keepers-hand.ts` (which gates setting a camp, #36);
  - `src/lib/lamp-naming.ts`, `src/content/lamp-naming.ts`, `src/ui/LampNamingPanel.svelte`;
  - `src/lib/crate-picker.ts`;
  - `server/internal/settings/settings.go`, `src/lib/web-settings.ts`, `src/lib/dev-tools.ts`.

  Settings and dev tools gate the hooks that every spec drives, so smoke is at least a real
  check there.

**Cost:** an `exp/*` lane that changes a recipe, a paper, a quest or a hold rule gets a green
15-minute run that tested none of it, and the break surfaces on dev, where it blocks everyone's
full run (as in #46).

**Fix:**

1. Add rules: papers JSON → `papers`, `papers-screens`, `connected`, `inventory`; `items`,
   `crafting` and `homestead` JSON → `items`, `crafting`, `camps`, `lot-lantern`, `homestead`,
   `inventory`; `quests` and `story` JSON plus `src/content/quests/**` → `quest`, `camps`,
   `rumour`; `common_ways*` → `paths`; `frontier_reach*`, `claim_rules*`, `holds/**`,
   `store/{holds,reach,commons}.go` → `camps`, `lot-lantern`, `land-chip`, `paths`;
   lamp naming → `camps`; crate picker → `camps`.
2. Make `tests/e2e-changed.test.ts` enforce coverage. Every non-test file under `src/`,
   `server/` and `content/` must be matched by a non-fallback rule, `full` or `ignore`, with an
   explicit allowlist for the rest. Then the next domain cannot arrive unmapped. This is the
   third round running with this finding.

### T2. The smoke tier's `items:161` flake runs on every push, and #49's fix did not cure it

**P2 · S · Confirmed** (CI history; the mechanism is from the spec).

**Evidence:**

- `e2e/items.spec.ts:161` (`@smoke`): **10 retry passes and 1 hard failure** since 10-17 15:22,
  across 11 commits on dev and `exp/*`, including `190a9d38`.
- It always fails at `:179`: the bucket's state is `undefined` after 5 s, meaning it was never
  picked up.
- #49 added `waitForLive` before the press (`:177`). The press is still a bare
  `keyboard.press('e')` (`:178`), with no check that the game's target is the bucket. The rope
  step a few lines up has the same shape but asserts the prompt *after* arriving.
- `pressOn(page, id, tile)` (`e2e/helpers.ts:343`) exists for exactly this: chunk whole, live
  input, `expectTarget`, then press.

**Cost:** smoke runs on GitHub for every push and pull request. Half of them now spend a retry
here, and the one hard failure turned a whole run red.

**Fix:**

- Use `pressOn(page, '<bucket pickup id>', { tx: 12, ty: 19 })` in place of `waitForLive` + press.
- Or poll "press E until the bucket is in the bag", with the target and the hero's tile in the
  message.
- Do the same for the rope at `:169`.

### T3. `version:109` compares the server's saved position with a dev placement that may not have landed

**P2 · S · Plausible** (5 retry passes from 10-16 to 10-18, including on main `613c70c9` and
`190a9d38`; not reproduced).

**Evidence:**

- `stepAside` (`e2e/version.spec.ts:25–30`) calls `__fsDevPlace(x + 40, y)` and returns the
  *requested* point at once.
- The test then clicks Reload and asserts `serverState().position` `toEqual(to)` (`:126–127`).
- The failure is always `x` differing (128 in one run). Either the report raced the placement,
  or the placement was adjusted (collision, or the place-report dedupe that the E2E health lane
  touched).

**Fix:**

- In `stepAside`, wait until `player(page)` reports the new point (or the nearest open tile) and
  return *that*.
- Then assert that the server holds the hero's position at the moment of the click, with a
  message naming both.

### T4. Dev is green only on retries: the persistent flakes and the release gate

**P2 · M · Confirmed** (CI history).

**Evidence:** persistent flakes over the two days:

| Spec:line | Flaky / hard | Failure |
|---|---:|---|
| `wilds-outer:139` (Whitequiet reload) | 4 / 1 | `toContain` after the reload. Last round's settle fix holds only partly. |
| `wilds:98` (harvest, camp, chest, reload) | 4 / 0 | `toBe` / `toBeLessThanOrEqual` |
| `open-map:318` (neighbouring chunks see each other) | 4 / 1 | `toEqual` on the remote list. Also #58's "fails hard". |
| `open-map:528` (Whitequiet motes, "and so do their tweens") | 4 / 0 | A one-shot tween count. The same check flaked in #18 and was raised as last round's finding 6. |
| `party-worlds:50` | 3 / 0 | 60 s `waitForFunction` |
| `gifts:32` | 2 / 1 | `toBeEnabled` on the shelf |
| `seam:303`, `purse:307`, `review5-fixes:40`, `residents:131`, `coop:119`, `rooms:108`, `items:113` | 2 each | |

#58 set the bar: "Dev must be reliably green before the release". The two post-merge runs meet it
only by Playwright's definition. Each needed 1 and 6 retries respectively.

**Fix:**

1. Put the flaky count in the run's summary (`scripts/e2e-artifacts.mjs` already has
   `retry` per result) and in the job's step summary, so "green with 6 retries" is visible
   without opening a log.
2. Give `wilds-outer:139`, `open-map:318`, `open-map:528` and `version:109` (T3) one
   focused lane. They are the same class: a one-shot read after a reload or a window move. Use
   the settle pattern from `5e12968` and `expect.poll` until two samples agree.
3. **Owner decision:** whether the 0.13.0 gate is "no hard failures" (met) or "N consecutive dev
   runs with no flakes" (not met).

### T5. Dev runs got 35% longer in two days, and the 45-minute timeout is close

**P2 · S · Confirmed** (timings). The cause is plausible.

**Evidence:**

- The full suite went from "273 passed (17.4m)" on 10-16 to "281 passed (23.7m)". That is 8 more
  tests and 6 more minutes.
- The new lamp specs are long by design: `land-chip.spec.ts:63` sets 300 s, and `camps` walks
  turnings.
- The dev median is now 25 min. 39044754368 took 41 min against `timeout-minutes: 45`
  (`ci.yml:147`), and #35 notes that the runner shares the host with agents.
- `exp/*` lanes wait a median of 9 min (up to 55) behind dev for the single runner.
- `reportSlowTests` lists ten tests over 60 s (`playwright.config.ts:68`), but only in the log.

**Fix:**

- Write the ten slowest tests and their durations into the evidence summary, so the next growth
  has a name.
- Raise `timeout-minutes` to 60 before a slow host turns a green run into a cancelled one.
- Consider the last round's suggestion: a newer `exp/*` push cancels an older *queued* `exp`
  run, never main.
- **Not recommended:** making `e2e full` wait on `verify` (no `needs:` today). Verify never failed
  in the window, and waiting would add its 17 min to every run.

### T6. The release flow for 0.13.0 lacks a migration rehearsal step and still tells agents to run E2E locally

**P2 · S · Confirmed.**

**Evidence:**

- **The live database jumps eleven migrations at once.** Live runs 0.11.2, which ends at 037.
  0.13.0 applies 038–048 in one start:
  - 038 is the lasting-geography reset, with refunds;
  - 040 rebuilds the lot tables;
  - 047 has a Go backfill (`migration_047_backfill.go`).

  The upgrade tests cover pieces (`store/lasting_geography_upgrade_test.go:12`), not the
  real database.
- The open "live DB check" before the release has no documented procedure.
  `docs/releasing.md` has no step for it. `docs/home-server.md:182–186` says "review migrations
  before upgrading" and names only migration 010.
- There is no `migrate`-only command. In practice any admin subcommand that opens `-db` migrates
  it (`server/cmd/glimway-server/main.go:61`).
- `docs/releasing.md:34–35` ("the playtests that matter (`npm run test:smoke` at least)")
  contradicts the E2E-only-through-CI rule (#46).
- **The hashes are fine today.** `nix run nixpkgs#prefetch-npm-deps -- package-lock.json` gives
  the committed `npmDepsHash` (`nix/web.nix:26`). The bump to 0.13.0 must recompute it
  (`docs/releasing.md:30–32`).
- CI still builds no Nix derivation. `nix/module-check.nix` passes here
  (`nix build .#checks.x86_64-linux.nixos-module`, 38 s), but only by hand. A stale hash shows up
  only at the owner's `nixos-rebuild`.

**Fix:**

1. Add a "Rehearse the upgrade" step to `docs/releasing.md`:
   - copy the newest *verified* live snapshot;
   - run the new binary against the copy (`glimway-server -db copy.sqlite allowlist list`, or a
     new `migrate` subcommand that only opens and migrates);
   - run `verify-backup copy.sqlite` and compare its account, world and home counts with the
     original;
   - record the result in the release notes.
2. Replace the local smoke step with "CI green on the release commit".
3. Optionally, a `workflow_dispatch` or main-only job that runs `nix build .#glimway-web
   .#glimway-server .#checks.x86_64-linux.nixos-module` on a GitHub runner with Nix. This was first
   asked on 10-09. It would catch a stale `npmDepsHash` before the deploy, not during it.

### T7. `buf-breaking.sh`'s "latest release" baseline is a pre-release tag

**P2 · S · Confirmed.** This is a seam for the 0.14 freeze.

**Evidence:**

- `scripts/buf-breaking.sh` picks the baseline with `git describe --abbrev=0 --match 'v*'`. At
  this snapshot that returns `v0.12.0-alpha.1`, not `v0.11.2`.
- Its own comment says the baseline is "the contract the last release shipped".
- Today the `origin/main` check (main is `fe0aab12`, 0.11.2) covers the gap. But after 0.13.0,
  any `-alpha` tag cut on dev during 0.14 becomes the baseline.
- After the contract freeze, a break against the *released* contract would then pass whenever
  an alpha already carried it.

**Fix:** `git describe --abbrev=0 --tags --match 'v*' --exclude 'v*-*'`, plus a line in
`docs/proto-migration.md`. Do it before the freeze.

### T8. Process docs contradict the E2E-only-through-CI rule

**P2 · S · Confirmed.** Agents read these first.

**Evidence:**

- `docs/agent-workflow.md:30` says "Keep `exp/*` branches local. Don't push them." The same file
  at `:64–68`, and #46, say push `exp/<lane>` and wait for CI.
- `docs/testing.md:49` says run `test:smoke` "while working, often". `:67–68` and `:90–92` tell
  agents to run `test:changed` at the end of a session. `:22–37` is a local-run recipe without
  "owner only".
- `docs/testing.md:50,70–71` say the full suite runs on `exp/**` pushes. It runs changed specs
  (`ci.yml:242–244`), as `testing.md:136` itself says.
- `docs/ci-runner.md:14` lists `main`, `expansion` and `exp/**`. `expansion` is retired, and
  `dev` is missing.

**Fix:**

- Delete `agent-workflow.md:30`.
- In `testing.md`, mark the local recipe as owner-only and say that agents push and watch CI.
- Correct both trigger tables: full on `dev`/`main`/`-f full=true`, changed on `exp/*`.

### T9. Design and status docs lag what 0.12–0.13 built

**P2 · M · Confirmed** (each item checked against code or content).

**Evidence:**

- **`docs/design/lamps.md`:**
  - `:3–5` still says "design for the build … proposed unless listed in §2.1".
  - `:57`, `:80`, `:469` and `:558` describe a "linked store". The lamp holds its own oil
    (`:34–35`, `:328`), and #51 cut the linked store.
  - `:80–82` and `:324` describe extra lanterns extending a five-tile radius. One lantern lights
    the whole backland chunk (`server/internal/api/home_placement.go:198`, #11).
  - `:323` describes a "Lot fitting" item that does not exist (#11).
  - `:153` says stable geography is "work for 0.12". It shipped in migration 038.
  - `:241` and `:750–757` still list islands and the landing rule as open. #52 answered them.
  - `:620–622` says the map uses the `item-way-lamp` placeholder. The
    `map-lamp-lit`/`map-lamp-dimming` icons are wired (`src/lib/wilds/map-lamps.ts:39`).
- **Other design docs:**
  - `docs/design/hearthwick-2.md:313–344` (§6) still says "no new tables" and "lasts for good
    inside lamplight". Migration 040 rebuilt the tables, and the oil rule replaced lasting for
    good.
  - `docs/design/plan.md:62–64` says the same about lasting for good.
  - `docs/design/art-request-lamps.md:83` still says the map uses the item icon.
- **Roadmap:**
  - `docs/roadmap.md` carries no release status. It doesn't say 0.12 folds into 0.13.0, or give
    #51's in/out list.
  - `:81` still says "the oil store".
  - Rule 9 (`:41`) asks for the 0.14 design docs during 0.13. Neither the roadmap nor the plan
    shows that lane as open.
- **Changelog:** `CHANGELOG.md` `[Unreleased]` lacks the E2E health lane's player-facing fixes
  (`3a1c40b2`):
  - an ignored place is reported again, so a reload no longer starts you steps back;
  - an arrival after a reload is reported, so a turning is no longer recorded about 10 s late;
  - the shelf no longer stalls;
  - duplicated tabs no longer share a play id.

  The `full` dispatch input is missing from the technical lines too.
- **Index and guides:**
  - `docs/README.md` indexes nothing under `docs/design/` (23 files, including `lamps.md`,
    `server-settings.md` and `plan.md`). It also lacks `decisions-overnight.md`,
    `ci-runner.md` and the 10-09 to 10-13 reviews.
  - `README.md:341–352` says dev tools exist only on the same machine and never in release
    packaging. Staging dev mode now exists (`Dockerfile:29`, `settings.dev.enable`).

**Fix:**

- One docs pass before the release commit:
  - add as-built notes and strike the superseded rows in `lamps.md`, `hearthwick-2.md §6` and
    `plan.md`;
  - add a status line per release in the roadmap;
  - add the four changelog lines;
  - add a design table to `docs/README.md`;
  - add a README pointer to `home-server.md`'s dev mode section.
- The changelog lines matter most, because the game shows them as "What's new".

### T10. Duplicated helpers and hand-typed hooks in the new specs

**P3 · S · Confirmed.**

**Evidence:**

- `standInTheWilds` is copied verbatim, at 23 lines, in `e2e/camps.spec.ts:30–52` and
  `e2e/land-chip.spec.ts:38–60`. So are `const S = 24`, `SEED = 'e2e-camps'`, `camps()` and a
  local `Hooks` type.
- `remotes()` is redeclared in 7 specs (`coop:16`, `presence:13`, `open-map:316`, `seam:33`,
  `wardrobe:25`, `party-worlds:13`, `companions`) and inline in 3 more (`abilities:185`,
  `items:231`, `purse:445`).
- The specs hold **324** `window as unknown as {…}` casts. `e2e/hooks.d.ts` already types
  `Window` as `Partial<FsHooks>` from `src/game/dev-hooks.ts`.
- The hand-written types drift: `camps.spec.ts`'s `Camp` lacks the `plants` that `__fsCamps`
  returns (`dev-hooks.ts:95`).

**Fix:**

- Move `standInTheWilds`, `camps` and the lamp seed into an `e2e/lamp-helpers.ts`.
- Move `remotes` into `e2e/party-helpers.ts`.
- New and touched specs call `window.__fsX!()` through the global typing instead of casting.
  Then a hook's shape change fails `typecheck:e2e` instead of a CI run.
- Map the new helper file to the lamp specs in `changed-map.json`, not to `full`.

### T11. Settings and Nix module: small convention gaps

**P3 · S · Confirmed.**

**Evidence:**

- **The example file misstates the dev tool defaults.** `deploy/glimway.example.toml:47,51,55,64`
  shows `# grant = false`, `clock`, `fight_fall` and `hooks` "at its default". These are `*bool`,
  and nil follows `dev.enable` (`settings.go:52–56,88–91`), so turning dev mode on turns all four
  on. A reader copying the example expects them off.
- **The `[web]` doc text has the wrong sign-in rule.** `settings.go:30` says the server hands the
  table "to each signed-in player". `api/web_settings.go:10` says the route needs no sign-in.
  The example file is generated from that doc text.
- **Restart triggers are hand-listed.** Restart-only tables are listed by hand in
  `instance.nix:231–234` (`restartTriggers` covers `server.login` only), while the Go struct
  already tags each key `apply:"restart"`. A new restart-only setting will reload instead of
  restart unless someone remembers this line.
- **The static unit is hardened less than the backend.** The `caddy file-server` unit
  (`instance.nix:253–267`) lacks `RestrictAddressFamilies`, `LockPersonality`,
  `ProtectKernelLogs` and `UMask`, which the backend's `hardening` set has (`:49–68`).
- The rest follows convention:
  - RFC 42 `settings` with a freeform TOML type;
  - a build-time `check-config`;
  - `reloadTriggers` on an `/etc` path;
  - instance-derived names;
  - assertions that keep dev packages, variables and flags off the live instance;
  - backups verified before pruning.

**Fix:**

- Have the generator print `# grant = (follows dev.enable)`.
- Correct the `[web]` doc tag.
- Have `check-config` (or a tiny generated Nix file) emit the restart-only key paths for
  `restartTriggers`.
- Copy the missing hardening keys into the static unit.

### T12. CI YAML repeats the GPU container block

**P3 · S · Confirmed.**

**Evidence:**

- `browser-performance` (`ci.yml:281–351`) repeats `e2e-full`'s container image, the eight
  resource options, volumes, env, the apt/Git install step and the Vulkan/EGL detection
  (`:153–233`). That is about 60 lines kept identical by comment only.
- The Playwright image tag (`v1.63.0-noble`) appears twice and must track `package-lock.json`.

**Fix:** a local composite action (`.github/actions/gpu-e2e-setup`) for the steps, and YAML
anchors for the container block. A test or `verify` step could check that the image tag matches
the locked `@playwright/test` version.

## What's healthy

- **Changed-spec CI works as designed when the map is right.** `exp/*` runs take 15 min instead
  of 25, and shared-infrastructure changes escalate to the full suite correctly (six times in
  the window). T1 is about the map, not the mechanism.
- **The previous round landed.** 11 of 14 findings are done (table above). Silas, the focus trap,
  the way label, ECONNRESET, the long-task budget and the trace evidence produced no events in
  this window.
- **Verify is solid.** It was green in 56 of 56 non-cancelled runs: the race detector over the
  API package, the dev-tag tests, buf breaking, the Nix fileset check and the container smoke
  test. `npm test` has 2,633 tests and all pass.
- **Migration history is tamper-evident.** `history.json` hashes every SQL file and backfill, and
  tests forbid edits.
- **The dev/live split in the Nix module** is enforced by assertions, not convention, and
  `nix/module-check.nix` proves the live unit unchanged. It passes at this snapshot.
- **The settings system** is a single tagged Go struct. It generates the example file (with a
  test), checks at Nix build time and reloads on SIGHUP.
- **Upgrade tests from a 0.11.2-shaped database exist** for the riskiest migration (038's path
  refunds).

## Seams for 0.14

- **The contract freeze needs a true release baseline** (T7) and, ideally, a test that the
  generated example settings and the `/api/web-settings` shape are part of the frozen contract
  (`tests/web-settings.test.ts` is the place).
- **The selector coverage ratchet** (T1, step 2) should exist before 0.14's hearths, stations and
  market stalls add a new domain per lane.
- **Upgrade rehearsal as a command** (T6): after the freeze, every release is a preserving
  migration on real data. A `migrate`/`upgrade-check` subcommand that opens a copy, migrates it,
  verifies it and prints counts makes that a single CI-able step.
- **Restart-only settings derived from Go tags** (T11), before 0.14 moves more knobs into the
  TOML. Note that module-set `GLIMWAY_*` variables pin a setting over the file, so any setting
  that moves from a module option into the TOML must drop its environment line in
  `instance.nix:218–229` and `compose.yaml:21–41` at the same time.
- **Runner capacity** (T5): the suite grew 6 minutes in two days. A second runner label, or
  sharding the dev run, is the next lever if 0.14 adds as many long specs as 0.13 did.

## Proposed order

1. Before the 0.13.0 release commit: T6 (rehearsal step and release doc), T9's changelog lines,
   T8, then T7.
2. Dependability: T2 (one helper call), T3, then the T4 lane, plus T4's flake count in the
   summary.
3. Feedback loop: T1 with its ratchet test, then T5's slow-test summary and timeout.
4. Hygiene: T10, T11, T12, and the rest of T9.

## Verification

Only this document is an authored repository change. No commit was made. `npm ci` populated
`node_modules` in this worktree; it is ignored by Git.

**Checks at `190a9d38`:**

- `npm run verify`: passed, including the build.
- `npm test`: 2,633 passed, 0 failed (64 s).
- `go test ./server/internal/settings ./server/cmd/glimway-server`: ok.
- `nix build .#checks.x86_64-linux.nixos-module`: ok.
- `nix run nixpkgs#prefetch-npm-deps -- package-lock.json`: matches `nix/web.nix:26`.
- The full `go test ./...` and Playwright were not run (host load; E2E only through CI).

**Probes:** the selector was run in `--list` mode only, with `E2E_CHANGED` set to single files
and to every file added since v0.11.2 (T1). The helper duplication comes from greps over
`e2e/*.spec.ts`. The `buf` baseline comes from `git describe` at this snapshot.

**CI data:** `gh run list` / `gh api …/jobs` / `gh run view --log` for every run from
2026-10-16 00:00Z to about 11:00Z on 10-18 (58 runs; 39121755316 was in progress and is
excluded). The per-spec counts are from each run's Playwright summary. Spec lines that shifted
between commits (`open-map:317/318`, `:528/537`) were merged by hand. Causes are read from the
spec code, and T3's mechanism is marked plausible.
