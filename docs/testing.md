# Testing

How Glimway is tested, which tier to run when, and how to chase a flaky
playtest. This is the one reference for the test workflow; the README's
"Tests" section is the short version, and the older playtest records
describe how things ran at the time.

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

### On the NixOS dev host (agent sandboxes)

Two things fail there, and each has a fix:

- **Vite can't start:** the sandbox blocks netlink, so `os.networkInterfaces()` throws
  (errno 97). Preload the shim with `NODE_OPTIONS=--require=./scripts/netif-shim.cjs`.
- **Playwright's downloaded Chromium won't launch on NixOS.** Point it at the nixpkgs build:
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(ls -d /nix/store/*-chromium-1*[0-9] | tail -1)/bin/chromium`.
  `playwright.config.ts` and `npm run atlases` both read it.

Run one spec at a time inside `nix develop`:

```sh
NODE_OPTIONS=--require=./scripts/netif-shim.cjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=… \
npx playwright test e2e/camps.spec.ts --workers=1
```

## The tiers

| Command | What runs | When |
|---|---|---|
| `npm run verify` | typecheck (app and e2e), svelte-check, unit tests, build | every change |
| `npm test` | unit tests | while working |
| `go test ./...` | server, shared content, parity vectors | server or shared-data changes |
| `cd server && go test -race -timeout 30m ./...` | the server with the race detector | server changes, before handing back |
| `npm run test:smoke` | the `@smoke` playtests (5 tests, a few minutes at most) | while working, often |
| `npm run test:changed` | the playtests mapped to what this branch changed | at the end of a work session |
| `npm run test:e2e` | the full Playwright suite | CI on the self-hosted GPU runner, on pushes to `main`, `dev` and `exp/**`, or manual dispatch ([ci-runner.md](ci-runner.md)) |
| `npm run test:screens` | everything, saving screenshots to `.agent/screens/` (the `*-screens` specs only run with it) | visual reviews |

Under `-race`, `internal/api` alone takes about 7–8 minutes, so on a busy
machine it can pass Go's default 10-minute test timeout while still working.
Keep the `-timeout 30m`.

Generated shared data has its own scripts. Run the one for what you changed;
the unit tests fail when the committed output has drifted from its inputs:

| Command | Writes |
|---|---|
| `npm run vectors` | economy and sync parity vectors (`content/vectors/`) |
| `npm run vectors:homestead`, `npm run vectors:calendar`, `npm run vectors:items`, `npm run vectors:magic`, `npm run vectors:fights-wire` | the other parity vectors the Go tests read |
| `npm run papers` | `src/content/papers-text.ts` and `content/papers.json` from `docs/lore/texts` |
| `npm run atlases` | the packed art in `public/assets/fingersnap/packed/` (needs `cwebp`/`dwebp`) |

While working, run `npm test` (or `npm run verify` when the change warrants
it). At the end, run `npm run test:changed`. In CI, every push and pull
request runs `verify`, the Go tests, the Docker smoke test and the smoke tier
on GitHub's runners. The full suite runs on a self-hosted runner with an
NVIDIA GPU, for pushes to `main`, `dev` and `exp/**` and for manual
dispatch, never for pull requests ([ci-runner.md](ci-runner.md)). A push
that changes only docs (`docs/**` and Markdown files, except `CHANGELOG.md`,
which the build reads) skips both E2E jobs; `verify` still runs. Each E2E
job writes its health to the run's step summary: passed, flaky (failed, then
passed on the retry) and failed tests by name, and the ten slowest tests. It
also uploads a JSON attempt summary (a lane run's two passes, its specs and
then the smoke tier, each keep their own report and traces); up to three retry
traces are retained within a 50 MiB cap. The first retry is traced, so it can
show a successful attempt while the JSON summary preserves the original
failure. To keep the failing attempts' traces instead, set the repository
variable `E2E_TRACE=retain-on-first-failure` (every test is traced then, which
slows the run), with `E2E_TRACE_FILES` and `E2E_TRACE_MB` to keep more. A separate
manual browser-performance job measures first paint and sparse-map rendering.
Push an
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

Tagged `{ tag: '@smoke' }` in the specs: quest exits and walking, the
connected sign-in and first world, a homestead deed with home goods in the
inventory, picking up an item, and a connected Wilds claim kept across a
reload. Keep it to a handful of tests that cover the critical paths: tag a
test only when nothing in the tier covers its path yet.

### Changed

`npm run test:changed` (script: `scripts/e2e-changed.ts`) collects the files
changed since the merge base with `dev` (`E2E_BASE=<branch>` for another),
plus uncommitted and untracked files, and maps them through
[`e2e/changed-map.json`](../e2e/changed-map.json):

- a changed spec runs itself;
- a file under a rule's `paths` runs that rule's `specs` (rules marked
  `smoke` also run the smoke tier, e.g. `src/game/scenes/**`). A path
  starting with `!` takes files back out of its rule
  (`"!src/game/wilds/camps.ts"` under `src/game/wilds/**`);
- a rule marked `fallback` is a catch-all: it applies only to files no other
  rule covers. `server/internal/api/**`, `server/internal/store/**`,
  `src/lib/api/**` and the generated code are fallbacks to the sign-in specs,
  so a server or client file with its own rule runs only that rule's specs
  (every playtest signs in against the Go server anyway);
- a file in the `full` list (fixtures, helpers and what they re-export, the
  e2e servers, the Playwright, Vite and Svelte configs, `package.json`,
  `go.mod`) runs the full suite;
- a source file no rule covers adds the smoke tier, and the script names it.
  Add a rule when that happens;
- docs, unit tests (Go `_test.go` files, `testdata` and `storetest` too) and
  other `ignore` paths run nothing.

The wire contract maps by message family: `camps.proto`, its Go output and
its TS output together run the camps specs, `items.proto` the item-route
specs, and so on. Each family's API client (`src/lib/api/items.ts`) sits in
the same rule. Content schemas (`proto/glimway/content/v1`) run the specs of
the loader that decodes them. `state_pb` loads most families at start-up, so
family rules also run the smoke tier. A dialogue hub such as
`homestead-talk.ts` has its own rule naming one spec per branch it routes to;
its `about` says which spec covers which branch.

CI does the same on lane branches: a push to `exp/*` runs `test:changed`
against `origin/dev` on the self-hosted GPU runner, so lanes don't queue behind
each other's full runs. Pushes to `dev` and `main` run the full suite, and
so does a manual run with `full`: `gh workflow run ci.yml --ref exp/<lane> -f full=true`.

The fight selector maps server fight/fall code, v2 presence protobuf output,
interpolation, the server enemy renderer, camp outcome polling and fight
content to `fights-server.spec.ts` and `fights-shared.spec.ts`. The two-client
gate runs in CI; set `E2E_SHARED_FIGHTS=1` to opt in locally.

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
  Habitica (`e2e/server/backend.ts`). Both start with the worker's first
  test, on free ports, so worktrees and workers never collide.
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
- **Read resets:** the test helper retries a safe `/api/state` or calendar
  GET once on `ECONNRESET` and logs its path, worker port/pid and server log.
  Mutations are never retried by this helper. Unexpected Go-server exits are
  written to that worker's `server.log`.
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

Every browser context of a worker reaches its server; there is no
guest/no-server mode in the tests (the game has no guest play).

## Writing a playtest

Use `test` and `expect` from `e2e/fixtures.ts` (they fail a test on any
uncaught page error).

**Isolation.** Every test makes its own player (`newUser()`, `freshPlayer()`)
and therefore its own world. Never depend on another test, on test order, or
on what else is in the database: other tests run at the same time against the
same worker server.

**Server state.** Every test has a server (the fixtures' `backend` fixture
starts the worker's and routes every context to it):

- `allow`, `adminInvite`, `setHabitica`, `freshPlayer`, `fund`, `giveInstance`
  (e2e/home-helpers.ts) and the rest of `e2e/connected.ts`;
- `sql(statements)` from `e2e/connected.ts` runs SQL against this worker's
  database; `habiticaURL()` is the fake Habitica; direct `page.request` calls
  to `/api` carry the contract header (`CONTRACT`);
- a story state on an account comes from `seedStory(accountId, { quest,
  marks, questItems, place })` (TODO(B): the new story tables replace the
  progress document);
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
| `waitForWilds` before using something on the open map | `chunkWhole(page, tile)` (that tile's chunk attached *and built whole*: its pieces and things registered) or `windowWhole(page)` (the whole 3×3); `waitForWilds` only promises the scene settled and the hero's chunk attached |
| working out which prompt wins (reach, rank, the tool in hand) in the spec | the game's own election: `targetAt(page, feet)` (the target those feet would get), `standFor(page, id, spots)` (stand where it is `id`), `expectTarget(page, id)`, and `pressOn(page, id, tile)` (chunk whole, input live, exactly `id` elected, then E) |
| a stall that just times out | a progress check that fails fast with `diagnose(page)` (hero, body, target and what is in reach, the dev walk's next waypoints, the window's build state, the epoch) |
| land from a random world for a behaviour check | `pinWorld(page, seed)` (e2e/connected.ts) right after signing in: the Tangle is then the same every run (the wick's land, within a wick); keep varied-seed walks as their own tests, and name the seed/epoch when they fail |
| a fixture on the wick's land (the Whitequiet and beyond) | `wickSlack(page)` before the Wilds are first entered: both clocks a day or more from the turning (the world's moved into the next wick if needed); `calendarOnServer(other)` for each further page. Crossing a turning is its own test (wilds-outer.spec.ts) |
| a date or season from `Date.now()` | `seasonOf(page, id, mark, { outside })` (both clocks, a day of slack before the mark changes and before the wick's turning), or a server time set away from the boundary (`moveServerClock`) |
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
| a reload that must carry the tab's writes (the old `savedToDisk` wait) | `reenter(page)` (e2e/connected.ts): the server's revision matches the tab's, then reload and Continue |
| a poll of the server's saved place after a move within one area (`__fsDevSaveSoon` sends no report) | `{ timeout: PLACE_REPORTED_MS }` (e2e/connected.ts): the link reports the place on a 10 s deadline; only an arrival in another area goes at once |

**Proving something does *not* happen.** Wait for an observable state that
rules it out, and record what the page does in the meantime:
`page.on('request')` or `page.on('websocket')` from before the action, then
assert the list is empty (`presence.spec.ts` waits for the old tab's link to
show the takeover, after which no socket can reopen; `review-fixes.spec.ts`
checks no placement was sent after 30 frames). Keep a fixed wait only when
nothing observable exists, and say why in a comment.

**Dev hooks** (read-only, dev builds only) used by these helpers:
`__fsFrame()` (frames since the area was built, fade, transitioning, whether
input is live), `__fsTarget(x?, y?)` (the action button's target, now or for
feet at x, y, and what is in reach), `__fsWildsWindow()` (attached, building, ready), `__fsDialogue()` (line, typing, replies, and every conversation
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

## Performance

Walking the open map is the game's heaviest work on the main thread: every
chunk edge attaches a row of chunks and drops one. Three tools keep it
measurable. None of them runs in CI.

**`?perf=1`** (src/game/perf.ts) turns on the instruments in any build: a
small overlay (top right: frame times, long frames, display list, tweens,
DOM size), User Timing spans named `fs:<stage>` around the window's work
(`recentre`, `fetch`, `paint-landed`, `attach` and its parts `tile-art`,
`collision`, `scenery`, `gathering`, `things`, `sites`, `detach`,
`things:render`), a `long-animation-frame` observer that notes which stages
ran in each long frame, and a sample of the scene a second. In a dev build
`__fsPerf()` returns all of it as JSON. `&without=bulk,bake,slack,spread`
turns parts of the window's work off, to measure what each buys (see
`perfWithout`).

**The walk** (perf/walk.perf.ts, its own config) signs in a fresh player on
a pinned world, enters the Wilds with `?perf=1` and walks the same route
each time: about eight new chunks, back and forth over one edge ten times,
then two minutes over ground already walked. It runs once at normal speed
and once with the CPU throttled 4× (CDP), and writes a JSON summary per run
(long frames by phase, frame-time percentiles, display list and tweens at
the start and end of the loop, DOM nodes and listeners) to
`test-results/perf/`. A third test photographs fixed spots for a look check.

```sh
E2E_PORT=5390 PERF_LABEL=before npx playwright test -c playwright.perf.config.ts
E2E_PORT=5390 PERF_LABEL=after  npx playwright test -c playwright.perf.config.ts
node scripts/png-diff.ts test-results/perf/screens/before test-results/perf/screens/after /tmp/diff
```

`--grep throttled` (or `normal`, `look`) runs one of them; `PERF_TRACE=1`
records a Chrome trace beside the summary; `PERF_WITHOUT=…` passes
`without`. Nothing else heavy should run beside it, and Vite reloads the
page when a source file changes, so don't edit while it walks.

**The Commons–Tangle seam** (`perf/seam.perf.ts`) uses the same config and a
pinned seed (`perf-seam`). It walks straight, diagonally and with turn-backs
at the mouth (at least twelve crossings per pattern), then walks beyond the
window's slack and returns ten times, without restarting the scene. Desktop
and phone emulation (390×844, DPR 3, touch, 4× CPU throttle) record frame
percentiles, independent long tasks, fixed/generated build stages against
`BUILD_MS = 4`, and collected heap, display objects, bodies, listeners and
textures. Forced collection is labelled `resources`, outside walking phases.
Two-client walks sample mutual visibility in transit and check both presence
rooms on every crossing. Cold arrivals cover boot, home and Tangle with
200 ms latency / 500 KB/s download / 100 KB/s upload, and separately hold
only fixed reads until six seconds after the scene appears (boot also fails
the first read). Arrival reports include positions while waiting and time
from delivery to the whole window; they check the local and server saves.

```sh
E2E_PORT=63827 GOFLAGS=-buildvcs=false PERF_LABEL=before npm run perf:walk -- --grep seam --workers=1
E2E_PORT=63827 GOFLAGS=-buildvcs=false PERF_LABEL=after npm run perf:walk -- --grep seam --workers=1
```

Set `PERF_OUT` to keep raw reports outside Playwright's cleared results
directory. `PERF_SEAM_LAPS=2` is a short incremental probe; the acceptance
run uses the default ten laps. Phone emulation is CPU/render evidence; the
owner's physical-phone place and movement checklist remains separate.
The seam's stage names are `attach:fixed:*`, `attach:generated:*`, and
`build:slice`; synchronous ground/collision attachment is reported separately
from the drawing queue. One drawing operation can overrun the deadline.

**Recording a trace by hand.** Open the game with `?perf=1`, open DevTools ›
Performance, tick *Screenshots* off and *JavaScript samples* on, record while
walking, and save the profile (a `.json.gz`). Then:

```sh
node --max-old-space-size=8000 scripts/trace-hotspots.mjs Trace.json.gz
node --max-old-space-size=8000 scripts/trace-hotspots.mjs Trace.json.gz --callers Add
node --max-old-space-size=8000 scripts/trace-hotspots.mjs Trace.json.gz --share "update phaser.js"
```

It lists the main thread's long tasks (with the `fs:` stages inside each),
self and total time per function inside them per thread (`--all`: the
whole trace), who calls a function (`--callers`, as chains of the game's
own frames) and a function's share of the main thread over time (`--share`,
in `--bucket` seconds: a share that climbs is a leak).

**The first-paint budget** is separate from correctness CI. It checks that
worker-painted tiles match the main-thread result in ordinary CI and records
the longest browser task as an annotation. The manual `browser-performance`
workflow job uses one GPU worker, checks the 400 ms default budget, and uploads
the measurement JSON so runs can be compared. Run locally with
`PERF=1 FIRST_PAINT_LONGTASK_BUDGET_MS=400 E2E_PORT=5470 npx playwright test -c playwright.first-paint.perf.config.ts`.

The sparse-map renderer unit fixture always checks output correctness, cache
bounds and overview dimensions. Its drag and zoom p95 budget is opt-in with
`MAP_PERF=1`; the manual browser-performance job records it with the browser
measurement. Set `MAP_RENDER_P95_BUDGET_MS` to override the 16 ms target.

**Fight load tools:** `sh scripts/fight-load.sh` measures multi-client server
fight load; `docs/shared-fights-testing.md` records its settings and output.
The load run is a measurement, not part of the correctness gate.

## Quarantined

There are no quarantined Playwright tests at present. Keep real product
regressions in the gate when possible; if one must be marked `test.fixme`,
record the current reason and remove the quarantine with the fix.

Generator wall-clock thresholds are opt-in: `GLIMWAY_PERF=1 go test -count=1 -v ./server/internal/wilds -run '^TestChunkTime(Budget|Headroom)V3$'`. CI runs them in the manual-dispatch measured job. Ordinary tests retain size, connectivity and golden invariants.
