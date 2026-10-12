# Shared fights: playtests and measurements

Generated camp wisps and beetles use the server by default in 0.9. Curated
woodland fights, guardians and the Warden remain personal. No camp selection
or `fights=server` URL is needed. Use `?perf=1` to see fight measurements;
`lag` and `jitter` remain available for development latency experiments.

## Player checks

Two different accounts in one world should see the same camp enemies, health,
wind-ups and confirmed deaths. Open one player's menu, cross a chunk boundary,
reload one player, and let each witness claim after the camp falls. Live fights
reset after the room has slept for 30 seconds; fallen camps stay down for their
cycle. A phone over mobile data checks a different network from local Wi-Fi.

Baseline targets: snapshot gap p95 below 150 ms; settled interpolation delay
at most 200 ms; melee confirmation p95 below 250 ms; refused predicted hit rows
below 2%. Collect actual samples: zero confirmations or zero snapshot samples
do not establish a pass. Try `&lag=150&jitter=50`, then `&lag=300&jitter=100`;
the baseline snapshot-gap target does not apply to artificially delayed frames.
Inspect timeouts and whole-swing refusals as well as the row percentage.

## Profiling and room timings

The optional admin listener binds only to loopback and has a separate mux:

```sh
npm run server -- -admin-listen=127.0.0.1:8091
curl http://127.0.0.1:8091/debug/fights
go tool pprof 'http://127.0.0.1:8091/debug/pprof/profile?seconds=15'
```

`/debug/fights` reports awake rooms, connected players, a rolling p95 of the
last 2048 room steps, lifetime maximum step time, and serialized fight bytes
admitted to player queues. The tick measurement excludes socket serialization
and fall persistence: profile the whole process to find those costs. Byte
totals count each recipient separately, exclude WebSocket framing, and do not
include ordinary presence traffic. `Server-Timing: app;dur=...` on near reads
and claims includes request processing through the first response write,
including validation errors; it does not include client network transfer.

## Socket load scenario

```sh
FIGHT_LOAD_GROUPS=3 FIGHT_LOAD_PLAYERS=3 FIGHT_LOAD_SECONDS=20 sh scripts/fight-load.sh
```

This opt-in Go scenario creates isolated fake accounts, a temporary SQLite
database and a real HTTP/WebSocket hub. Three base mixed enemies with three
nearby players exercise camp scaling to five. Each group has its own world and
uses the camp of chunk (3, −4), whose whole 3×3 lies inside the frontier.
Rooms wake one sync at a time, so the observers first wait on the camp's west
side, 150 px out: inside the 160 px scale band, outside the wisps' 90 px and
the beetle's 130 px aggro. Once every bot has the camp room's join, they walk
in to a 65 px orbit, which starts the camp with all of them present, and swing
outward, keeping enemies alive while testing dispatch and results. Each bot
tracks the camp room's rows (join, then spawned/removed), and the run fails
unless every observer saw the camp reach its expected size (five for three
players): `expectedCampSize`, `campSizeMin`/`campSizeMax`, `botsWrongCampSize`.
The warm-up is excluded from the measured interval. Each observer covers that 3×3 window, so a group wakes nine rooms (one
active camp, eight idle): report **actual awake rooms**, not group count.
Increase groups (up to 100) until room-step p95, `cpuBusyPercent` or socket
failures show saturation. `GOMAXPROCS=1` is the script default for the
per-core measurement; set it to compare additional cores. The bots run in the
same process and share those cores; they send and decode raw protobuf frames
only, but `cpuBusyPercent` (the Go runtime's estimate) includes them, so it
overstates the server's own share. Results print as a `FIGHT_LOAD` JSON line.
Setup is excluded from the run interval; total metric counters include startup
work. The run fails if any socket fails, any bot never receives a fight join,
or no swing result comes back. This fixture measures server capacity, not
mobile network latency.

Budgets to compare: room step under 1 ms for five enemies and three players;
changed delta under 100 bytes; fight output under 10 KB/s per player for nine
awake rooms; goal 200 awake rooms per core (measure rather than assume).
The load scenario reports per-observer fight bytes averaged over its run
(`meanBotBytesPerSecond`, and the busiest bot's `maxBotBytesPerSecond`), not a
worst-case one-second burst. Save the CPU/core count, run options and output with results.

## Browser performance and regression

`npm run perf:walk` also discovers `perf/fights.perf.ts`. For the isolated fight
scenario:

```sh
npx playwright test -c playwright.perf.config.ts --grep 'shared fight observation'
```

It measures server enemy observation/rendering on a 390×844 phone viewport,
once at normal CPU speed and once at 4× throttle, while a menu holds local
play. This preserves the enemies and avoids falls changing the scene. Frame
statistics cover only that observation window (the instruments reset at its
start); the fight network measures accumulate from page load. JSON
artifacts go to `PERF_OUT` (default `test-results/perf`); `PERF_FIGHT_MS`,
`PERF_FIGHT_LAG` and `PERF_FIGHT_JITTER` adjust duration and transport delay.
Compare frame samples against a corresponding no-fight baseline before
claiming the added-frame-time budget is met (target under 2 ms at 4× throttle).

`e2e/fights-shared.spec.ts` is CI-only and uses real server messages and Hero
attacks. It checks two accounts, matching wind-ups, menu observation,
reconnects, deaths and both witnesses' personal claim settlement. The older
`fights-server.spec.ts` continues to test rendering/prediction with controlled
packets; it is a separate test of the client adapter.
