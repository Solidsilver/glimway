# Testing

How Glimway is tested, which tier to run when, and how to chase a flaky
playtest. This is the one reference for the test workflow; the README's
"Tests" section is the short version, and older notes (`build-status.md`,
playtest records) describe how things ran at the time.

## Prerequisites

Node 24+ (the unit tests run TypeScript directly) and `npm ci`,
plus a few programs that aren't npm packages:

| Program | Needed for | Called from |
|---|---|---|
| Playwright's Chromium | every playtest | `npx playwright install chromium` once |
| `go` (the version in `go.mod`) | `go test`, `npm run server`, and every playtest: the run builds the server first | `e2e/global-setup.ts` |
| `sqlite3` | connected playtests that set up server state with `sql()` | `e2e/connected.ts` |
| `cwebp` and `dwebp` (`brew install webp`) | `npm run atlases` only (encoding and checking the packed art) | `scripts/build-atlases.ts` |

`npx knip` lists these as "unlisted binaries": that's expected.

## The tiers

| Command | What runs | When |
|---|---|---|
| `npm run verify` | typecheck, svelte-check, unit tests, build | every change |
| `npm test` | unit tests | while working |
| `go test ./...` | server, shared content, parity vectors | server or shared-data changes |
| `cd server && go test -race -timeout 30m ./...` | the server with the race detector | server changes, before handing back |
| `npm run test:smoke` | the `@smoke` playtests (7 tests, a few minutes at most) | while working, often |
| `npm run test:changed` | the playtests mapped to what this branch changed | at the end of a work session |
| `npm run test:e2e` | the full Playwright suite | CI on the self-hosted GPU runner, on pushes to `main`, `expansion` and `exp/**`, or manual dispatch ([ci-runner.md](ci-runner.md)) |
| `npm run test:screens` | everything, saving screenshots to `.agent/screens/` (the `*-screens` specs only run with it) | visual reviews |

Under `-race`, `internal/api` alone takes about 7–8 minutes, so on a busy
machine it can pass Go's default 10-minute test timeout while still working.
Keep the `-timeout 30m`.

Generated shared data has its own scripts. Run the one for what you changed;
the unit tests fail when the committed output has drifted from its inputs:

| Command | Writes |
|---|---|
| `npm run vectors` | economy and sync parity vectors (`content/vectors/`) |
| `npm run vectors:wilds`, `vectors:homestead`, `vectors:calendar`, `vectors:items` | the other parity vectors the Go tests read |
| `npm run papers` | `src/content/papers-text.ts` and `content/papers.json` from `docs/lore/texts` |
| `npm run atlases` | the packed art in `public/assets/fingersnap/packed/` (needs `cwebp`/`dwebp`) |

While working, run `npm test` (or `npm run verify` when the change warrants
it). At the end, run `npm run test:changed`. In CI, every push and pull
request runs `verify`, the Go tests, the Docker smoke test and the smoke tier
on GitHub's runners. The full suite runs on a self-hosted runner with an
NVIDIA GPU, for pushes to `main`, `expansion` and `exp/**` and for manual
dispatch, never for pull requests ([ci-runner.md](ci-runner.md)). Push an
`exp/` branch to run it before main moves.

Unit tests can load rune modules (`*.svelte.ts`, such as
`src/ui/account-flow.svelte.ts`): import `tests/helpers/svelte-runes.ts`
first, then the module with `await import(…)`. Keep such modules free of
Phaser and of imports without a `.ts` extension, and hand them their
collaborators (an API, a session) so a test can pass fakes.

**Agents:** run `test:smoke` and `test:changed` while you work. The full suite
runs once per merge batch, not once per agent. `test:changed` itself runs the
full suite when shared test code changed (see below).

### Smoke

Tagged `{ tag: '@smoke' }` in the specs: guest exits and walking, a guest
Tangle claim, the connected sign-in (fresh, and bringing a guest quest along),
a homestead deed with home goods in the inventory, picking up an item, and a
connected Wilds claim kept across a reload. Keep it to a handful of tests that
cover the critical paths: tag a test only when nothing in the tier covers its
path yet.

### Changed

`npm run test:changed` (script: `scripts/e2e-changed.ts`) collects the files
changed since the merge base with `expansion` (`E2E_BASE=<branch>` for another),
plus uncommitted and untracked files, and maps them through
[`e2e/changed-map.json`](../e2e/changed-map.json):

- a changed spec runs itself;
- a file under a rule's `paths` runs that rule's `specs` (rules marked
  `smoke` also run the smoke tier, e.g. `src/game/scenes/**`);
- a file in the `full` list (fixtures, helpers, the e2e servers, the
  Playwright and Vite configs, `package.json`) runs the full suite;
- a source file no rule covers adds the smoke tier, and the script names it.
  Add a rule when that happens;
- docs, unit tests and other `ignore` paths run nothing.

`npm run test:changed -- --list` prints the plan without running it. Other
arguments go to Playwright (`-- --workers=2`, `-- -g "deed"`).

## Workers, servers and ports

The suite runs in parallel with `fullyParallel`, so tests from one spec spread
across workers. Local runs default to 2–3 workers. In CI the smoke tier uses 2
workers, and the full suite on the self-hosted runner uses 4
(`E2E_RUNNER_WORKERS`, sized to its memory budget in
[ci-runner.md](ci-runner.md)).
Set `E2E_WORKERS` or pass `--workers=N` to override. To reduce its impact on a
busy Mac, run it as `nice -n 10 npm run test:e2e` (or use the same prefix with
`npm run test:changed`).

- **Vite** (one, shared): `E2E_PORT` (default 5199). Give each git worktree
  its own, or two worktrees share one Vite. HMR is off in the playtest Vite, so
  editing a file mid-run doesn't reload the pages under test (new code is
  still served to the next page load).
- **Per worker:** a Go server with its own SQLite database, and a fake
  Habitica (`e2e/server/backend.ts`). Both start the first time a worker runs a
  `server: true` test, on free ports, so worktrees and workers never collide.
  `E2E_API_PORT` and `E2E_HABITICA_PORT` are no longer used. The Go binary is
  built once per run by `e2e/global-setup.ts`, into the run's own directory.
- **Routing:** each browser context of a worker carries a `fs-e2e-api=<port>`
  cookie, and the playtest Vite (`GLIMWAY_E2E_ROUTING=1`,
  `e2e/server/vite-routing.mjs`) sends `/api` and the `/ws` socket to that
  port. Contexts a test makes itself with `browser.newContext()` get the cookie
  too.
- **On disk:** each run has `.e2e-server/run-<pid>/` (the binary, and a
  `w<N>/` folder per worker with its database, `server.log` and `server.json`:
  ports and pid; `N` is the worker's parallel index). `.e2e-server/latest`
  points at the newest run. Two runs in one worktree keep separate files (they
  still need separate `E2E_PORT`s); finished runs' folders are cleared at the
  next start.
- **GPU:** on macOS the browsers render WebGL on the GPU (`--use-angle=metal
  --enable-gpu`). Headless Chromium otherwise uses SwiftShader, software GL on
  the CPU: on a busy machine the game drew about 8 frames a second that way,
  against 60 on the GPU, and most "timing" flakes came from that. On Linux
  with an NVIDIA GPU, `E2E_GPU=nvidia` renders through ANGLE on Vulkan
  (`E2E_GPU_ANGLE=gl-egl` for EGL); that's how the self-hosted CI runner
  runs. `E2E_GPU=0` turns the GPU off for comparisons.
  `node scripts/webgl-renderer.ts` prints the renderer the current settings
  get, and `E2E_LOG_RENDERER=1` logs it from `first-paint.spec.ts`.
- **baseURL** is `http://127.0.0.1:<E2E_PORT>`, not `localhost`: `page.request`
  resolves the host in Node, and under load a `localhost` lookup has stalled
  for seconds.

Guest tests block `/api` in the browser, so they play as if no server existed.

## Writing a playtest

Use `test` and `expect` from `e2e/fixtures.ts` (they fail a test on any
uncaught page error).

**Isolation.** Every test makes its own player (`newUser()`, `freshPlayer()`)
and therefore its own world. Never depend on another test, on test order, or
on what else is in the database: other tests run at the same time against the
same worker server.

**Server state.** Inside `test.use({ server: true })`:

- `allow`, `adminInvite`, `setHabitica`, `fund`, `giveInstance` work as before;
- `sql(statements)` from `e2e/connected.ts` runs SQL against this worker's
  database; `habiticaURL()` is the fake Habitica;
- never hard-code `.e2e-server/glimway.sqlite` or a server port. (An old
  spec that still passes that path to `execFileSync` is pointed at its
  worker's database, with a warning, so branches written before this change
  keep working.)

**Wait on the game, not the clock.** A worker on a busy machine can draw a
few frames a second, and the game clock slows with it (each frame advances
it at most 50 ms). A fixed pause is either too short (flaky) or too long
(slow). Use:

| Instead of | Use |
|---|---|
| `waitForTimeout` after a warp | `warp` / `go` / `waitForArea` (they wait until the area is built, its fade-in done, and a few frames drawn) |
| a pause before pressing E | `waitForLive(page)` (no dialogue or panel, past the grace after a conversation) or `openTalk(page, prompt)` |
| E-and-sleep dialogue loops | `talkThrough`, `talk`, `readDialogue`, `untilChoices`, `untilLine`, `talkText` |
| a reply list check | `untilChoices(page)`, then the `.choice` locators |
| holding a key for N ms | `holdUntil(page, key, check)` |
| sampling every N ms | `frames(page, n)` |
| "X happens within N seconds" for game behaviour | `waitFrames(page, predicate, arg, { seconds })` (checked every frame in the page, timed in game time) or `waitGame` (Node-side reads) |
| `expect(toast).toBeVisible()` | `expectToast(page, text)` (shown, even if already faded; each call needs a newer toast than the last with that text), or `toastCount` before and `toastAfter(page, mark, text)` after |
| `expect(dialogue).toContainText(…)` | `expectLine(page, text)` (the whole current line; the typewriter can lag far behind under load) |
| `.area .title` on screen | `expectAreaCard(page, title)` |
| a pause for a banner to clear | poll `__fsBanners().current` until it is `null` (see `coop.spec.ts`) |
| a pause before a screenshot | `animationsDone(page)` (running transitions and fades finished, then two frames) |
| a pause before editing or reloading a guest save | `savedToDisk(page)` |

**Proving something does *not* happen.** Wait for an observable state that
rules it out, and record what the page does in the meantime:
`page.on('request')` or `page.on('websocket')` from before the action, then
assert the list is empty (`presence.spec.ts` waits for the old tab's link to
show the takeover, after which no socket can reopen; `review-fixes.spec.ts`
checks no placement was sent after 30 frames). Keep a fixed wait only when
nothing observable exists, and say why in a comment.

**Dev hooks** (read-only, dev builds only) used by these helpers:
`__fsFrame()` (frames since the area was built, fade, transitioning, whether
input is live), `__fsDialogue()` (line, typing, replies, and every conversation
opened so far), `__fsToasts()` and `__fsBanners()` (everything shown so far),
and `__fsDevSaved().pending` (a debounced save still to land). Add a read-only
hook behind `import.meta.env.DEV` when a test needs to wait for something new;
don't change game behaviour for a test.

**Tiers.** Put the new spec in `e2e/changed-map.json` (the rule for the system
it covers, or a new one). Tag it `@smoke` only if it covers a critical path
nothing in smoke covers. Screenshot-only specs skip themselves without
`SCREENS=1`.

## Debugging a flake

1. Re-run just the test, several times, in parallel with itself:
   `E2E_PORT=5231 npx playwright test e2e/x.spec.ts -g "title" --repeat-each=5 --workers=5`.
   Add `--workers=1` to see whether it only fails under load.
2. Open the trace: `npx playwright show-trace test-results/<test>/trace.zip`
   (local failures keep traces; CI records only the first retry). The actions
   and network tabs show which step waited, and for how long.
3. The worker's server log is `.e2e-server/latest/w<N>/server.log`
   (`server.json` in the same folder has its ports).
4. Look for a wall-clock assumption: a fixed pause, a `{ timeout }` on
   something the game does on its own clock, a check of something short-lived
   (a toast, a card, a wind-up) that a slow poll can miss, or a key held for a
   fixed time. Replace it with one of the helpers above.
5. Random worlds: the Wilds are generated per world. A failure that depends on
   the seed (a camp by the entry, an epoch without a point of interest) can be
   pinned with `sql("UPDATE worlds SET seed='…' WHERE id='<worldId>' AND id NOT
   IN (SELECT world_id FROM region_epochs)")` before the first Wilds read, as
   the handoff test does.
6. `npx playwright test --last-failed` re-runs what failed.

## Quarantined

A test that catches a real product bug which isn't fixed yet is marked
`test.fixme` with the bug written out above it, so the full suite stays green
for everyone else. Remove the `fixme` with the fix.

- `presence.spec.ts` › "the others see you come to rest exactly where you
  stopped": the server drops a position that arrives under 1/`positionHz`
  after the previous one, and the client paces at exactly that interval, so
  the final stop is sometimes lost (the others see you a few pixels short).
- `wilds-screens.spec.ts` › "wilds screens: the fallen-hero lantern": a
  connected fall in the Tangle sends the defeat report and a progress upload
  together, and about one fall in ten the hero comes to in the Tangle at 0 HP
  instead of in the village.
- `wilds.spec.ts` › "connected: the Commons arch leads into the Tangle": the
  exit check and the once-a-second position sample can run in the same frame,
  storing the Commons spot as a Tangle position in chunk (0,0) (about one
  crossing in 60 at 60 fps). The return trip is still tested.
