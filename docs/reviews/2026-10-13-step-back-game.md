# Step-back review after 0.9: the game client


## Map: what changed since 2026-10-11

Snapshot **268c9b4**. This follows `2026-10-11-step-back-game.md` at **a5005c3**. Review of
`src/game`, `src/lib`, `src/content` (the client half of the shared-fight lanes and their
neighbours); the server, e2e and UI reviews are the other reviewers'. Review only: no
implementation changes; `npm test` and one `vite build` to a temp directory were run (below).

**Shared fights landed on the client, and they took the seams with them.** F-A's splits are in:
`src/game/entities/fight-rules.ts` owns what a blow reaches and does (pure, node-tested, numbers
from `content/enemies.json` and `content/combat.json` through `src/lib/enemies.ts` and
`src/lib/combat-timing.ts`), `EnemyOwner` separates behaviour/hit authority from sprites
(`src/game/entities/enemies.ts:74`), and the frame is split into observation and this player's
gated play (`src/game/scenes/world-frame.ts`, `WorldScene.ts:673`). F-B's contract 10 wire and
shared maths are `src/lib/fight-math.ts` (Go twins, shared vectors) plus the v3 codec
(`src/lib/presence-codec.ts`, `PRESENCE_PROTOCOL = 'glimway.presence.v3'`, server frames carrying
several events each). F-D's screen is `src/lib/fight-interp.ts` (tick-stamped poses, adaptive
delay, events from their start time, knock blending, seeded crits), `src/game/entities/fight-strike.ts`
(press-time selection, one shared swing counter, predicted rows) and
`src/game/entities/server-enemies.ts` (one sprite per enemy life, deaths only on the room's event).
Every generated camp is now a server room: `src/game/wilds/camp-fights.ts` makes the near read's
`camp_claimable` for the exact epoch and cycle the claim's word, with the room only hurrying it
along. The `?fights=server` flag is gone (no local fallback), and the local camp spawner is gone
from `src/game/wilds/entities.ts`.

**The open map's ordering work landed too.** `src/game/wilds/store.ts` fences every near read to
its store generation and link (`refreshNear`, `:545`), and orders reads and answers with marks per
entity/claim, lantern, Echo, chunk ground, way and the balances (`:420`–`:460`,
`src/game/materials-order.ts`); Items and Home adopted the same ordering (`src/game/items.ts:31`).
The paint worker's fallback keeps its own tile copies (`src/game/wilds/paint-worker.ts:83`). The
world map (open-map rounds 1–3) added `src/lib/wilds/map-model.ts` and `map-view.ts` (pure) with
scoped loads in `src/game/wilds/map-data.ts:99`. Small owner-playtest lanes: empty hands on the
belt, the map on M (riding on V), map zoom/pin-pinch.

### Status of the previous findings

These are the **2026-10-11 game review's** F numbers; the findings below have their own numbering.

| Previous | Status | Evidence at this snapshot |
|---|---|---|
| F1 — fence Wilds reads to their lifetime | **done** | `src/game/wilds/store.ts:545` (`current()` = generation and link), `:562`–`:573` (adoption and body loading checked again after `await`), `:576` (an old failure can't mark the new view stale), `:324` (per-chunk/entity ordering marks, a late older answer dropped). |
| F2 — worker fallback from transferred buffers | **done** | `src/game/wilds/paint-worker.ts:83` keeps `tiles`, transfers `copies`, `:92`–`:97` settles once (posting failure and a late reply included). |
| F3 — late reads moving domain views backwards | **done** | `store.ts:420`–`:460` orders entities, claims, lanterns, Echoes, ground and ways; `materials-order.ts` + `items.ts:31`–`:105` order Items/Home; `homestead.ts` grew its own marks (c08-client rounds 2–3). |
| F4 — e2e readiness and fixtures | **largely** (tests lane) | `Interactables.pick`/`debugTarget` (`src/game/entities/interactables.ts:202`, `:216`) give e2e the game's own target rule; c08-tests/c08-client rounds pinned the named flakes. Not re-run here (the brief excludes e2e). |
| F5 — vertical Shadowstep reach | **done** | `src/lib/combat.ts:156` (`snapstrikeReach`, 2D), `hero.ts:485` picks the reach from it. |
| F6 — camp lifetime by epoch/entity/cycle | **done** | `camp-fights.ts` (`CampNow`, `ServerCampOutcome`), `entities.ts:479`/`:489`; local camp spawning and `spawnedCamps` are gone. |
| F7 — combat seams and the paused frame | **done** | `fight-rules.ts`, `EnemyOwner` (`enemies.ts:74`), `world-frame.ts` (`playHold`, observation always), `WorldScene.ts:673`–`:745`; server enemies run in `observe`. |
| F8 — durable outbox still in Link | **not done** | Carried forward, see F3 below. |
| F9 — UI splits | **not done** (UI lane) | InventoryPanel 1,511, Hud 1,295, App 1,393 lines (was 1,510 / 1,259 / 1,352). |

### Checks and size

`npm test` (`nice -n 10`): **2,329 passed, zero failed, 11.9 s**. No `npm ci`/install, no git state
changes, no e2e. One `vite build --outDir /tmp/fsbuild` (5.7 s) was used only to read the shipped
bundle: no `__fs*` hook string survives in it (the `import.meta.env.DEV` gate in
`src/game/dev-hooks.ts:238` holds, so the hook doc's claim is true), while `?perf=1` does — which
`docs/testing.md:243` documents ("in any build"). Two focused repros are described in F1 and F4.

`WorldScene.ts` is **1,190** lines (was 1,151), `link.ts` **2,416** (was 2,398). New fight client:
`fight-interp.ts` 274, `fight-rules.ts` 255, `fight-math.ts` 119, `server-enemies.ts` 162,
`fight-strike.ts` 65, `camp-fights.ts` 82. `tests/fight-interp.test.ts` (233 lines),
`fight-feed.test.ts` (162), `fight-strike.test.ts` (137) and `server-enemies.test.ts` cover the
socket, prediction and rendering paths with injected clocks — the strongest test net of this round.

## Findings (payoff relative to risk)

### F1. A cleared camp's claim prompt can be missing for its whole cycle. M

**Evidence:** `src/game/wilds/camp-fights.ts:32`–`:33` budgets **4** fresh near reads, **1.5 s**
apart, and `won()` (`:59`–`:72`) asks only while the room shows the camp dead, the store has no
word and `k.tries < CAMP_READ_TRIES`. Once those four are spent nothing asks again: `k.complete`
stays true while the rows stay corpses, so `:67` never re-arms the budget for this cycle. The
prompt is entirely the store's word (`src/game/wilds/entities.ts:479`, `campClaimable`,
`store.ts:285`), and the action press is gated by the same predicate (`entities.ts:524`), so an
unworded camp offers no interaction point at all (`:731`) — pressing E near it does nothing, with
no toast.

**Interleaving:** two players clear a camp; the room's rows are all dead from tick N on. The fall
record is written off the tick by the fall writer (`docs/design/shared-fights.md` 1.2/1.3) and
lands later than the four reads (server busy — exactly the load the sharded scheduler was built
for; or the four near read answers all arrived before the fall's transaction committed). Standing
at the camp, no further near read is asked: `window.recentre` re-reads only on a chunk crossing and
only when that centre is older than `NEAR_MAX_AGE_MS` (10 s, `store.ts:121`), and `showStale`
retries only for a failed view. If the camp's next cycle begins first (`entityCycle`,
`store.ts:275`) the stored word is for the old cycle and `campClaimable` turns false: that fall's
claim for this account is never offered.

**Reproduced:** the real `ServerCampOutcome` with `read` = "the room shows every row dead" and the
store's word never true: exactly **4** asks in 120 s (at 0/1.5/3/4.5 s), then none; with the word
flipping true at t = 10 s the prompt would show only if something else reads.

**Change:** while the room still shows the camp won and no word has landed, keep asking on a slower
backoff instead of stopping (say 5 s, bounded per cycle by time, not count); and let a press
attempt the claim when the room shows it won even without the word — the server's completion seam
already answers `not-defeated` when no fall is stored, and `entities.ts:535` deliberately keeps
that case open. Keep the store's word as the prompt's authority.

**Guards:** `tests/camp-fights.test.ts` and `tests/fight-feed.test.ts` — a fall that lands after
the old budget still offers the claim; a press before the word is answered `not-defeated`, is not
latched by `claimed()`, and the next cycle starts over.

### F2. The presence latency injector ships in production builds. S

**Evidence:** `src/lib/fight-options.ts:8` reads `?lag=`/`?jitter=` from `location.search`
unconditionally, `src/game/presence-feed.ts:101` makes it the socket's latency, and
`src/lib/presence-client.ts:621` delays every message in both directions through it. Verified in
the built bundle (`vite build` to `/tmp`): the `"lag"` parameter read and both `jitter` strings are
present, while every `__fs*` hook is stripped. The prototype's docs describe the injector only as a
playtest knob (`docs/design/shared-fights.md:395`, `docs/shared-fights-testing.md:19`), unlike
`?perf=1`, which `docs/testing.md:243` explicitly supports "in any build".

Two smaller edges ride with it: `raw()` counts a queued-but-not-yet-sent fight message as delivered
(`presence-client.ts:606`–`:608`, `return sent || queued`), and a queued frame cancelled by
`clearTimers()` is dropped without the `unsentFight` report (the pending entry then relies on the
status change clearing `FightInterp`). Both are latent without the injector.

**Change:** gate `fightOptions` on `import.meta.env.DEV` (the same shape as `dev-hooks.ts`), or
declare it a supported diagnostic next to `?perf=1` in `docs/testing.md`. Either way, make
`raw()`'s answer truthful (return whether it was handed to the socket, and report the queued case
through `unsentFight` when it is cancelled). `perf/fights.perf.ts` runs against the Vite dev
server, so the DEV gate breaks nothing.

**Guards:** the bundle check from the map (no `lag`/`jitter` read in the build output) as a line in
the web-fileset or build check; keep `tests/fight-feed.test.ts`'s injected-latency cases, which
pass `latency` through deps rather than the URL.

### F3. The durable outbox still lives in Link (carried from the last two rounds). M

**Evidence:** `src/game/link.ts:915` (Web Lock + fence claim), `:951` (record take-over), `:1016`
(record write), `:1028`/`:1050` (the cross-tab channel), `:1062` (settle), `:1187` (drain) and the
domain dispatch/mutation registry share one **2,416-line** class (was 2,398, 2,255 two rounds ago).
The extraction has progressed: the record and store live in `src/lib/api/outbox.ts` (`claim`, 445
lines) and the report pump in `src/lib/api/report-pump.ts`, but the queue's save/replay/expiry and
its ownership still play out inside Link.

What the last round asked for *did* hold where it matters now: real-time swings and casts never
touch this queue — they ride presence (`fight-strike.ts:16`, `presence-feed.ts:183`–`:201`), and
Link's durable work stays economy. That separation is why this is no longer urgent.

**Change:** as before — one coherent owner for record/fence/channel and the durable queue
(save, replay, expiry), in small PRs, with Link keeping its public façade and lease/snapshot
responsibilities. A mechanical file split that weakens persist-before-visible, one sender/fence,
exact-key replay or head-of-line ordering is not worth doing.

**Guards:** `tests/link-durability.test.ts`, `link-failures`, `link-reports`, `link.test.ts` and
the domain rigs.

### F4. The interpolation's gap statistics read coalesced frames as jitter. S

**Evidence:** `src/lib/fight-interp.ts:116`–`:122` measures a snapshot gap as `now − room.received`
whenever the ticks are consecutive, and grows the delay to `100 + |gap − 100|` (capped at 200) on
any deviation; `:166` decays it back over ~5 s. But the v3 wire coalesces events into one frame
(`presence-codec.ts:51`–`:56`), and the server's writer batches what is queued per write
(36f06bf), so two consecutive ticks routinely reach `onFrame` in the same task: their measured gap
is ~0 ms.

**Reproduced:** join at tick 100, deltas for ticks 101 and 102 delivered in one frame —
`interpolationDelay` pins at **200**, `snapshotGapP95` records a **0 ms** sample, and only five
seconds of clean 100 ms gaps bring the delay back to 100. Both numbers are the `?perf=1` fights
section's headline measures (`perf.ts:320`) and the prototype's pass criteria
(`docs/design/shared-fights.md`, section 2), so a batched frame flatters gap p95 and exaggerates
the settled delay.

**Change:** measure a gap from the stamps (the ticks' own spacing × 100 ms) or ignore a sub-tick
gap when consecutive ticks arrived in one frame, so growth means what design 1.8 says it means;
and reset the measure buffers in `clear()` (`:265`), which today keeps `gaps`, `confirmations`,
`predictedRows` and the refusal counters across reconnects and room changes. Keep the policy
itself: growing on genuinely uneven arrival is intended.

**Guards:** a node case with two consecutive-tick deltas in one frame (delay stays settled, no 0 ms
gap sample), and one asserting `measures()` after `clear()` reflects the new session only.

### F5. Two fight-era descriptions are now wrong. S

**Evidence:** `docs/design/layers.md:178`–`:182` still says "Today every fight is local: two
players at the same Tangle camp each fight their own copy … the … sketch for co-op … was never
built", although every generated camp is now a server room and presence v3 carries FightSwing,
FightJoin, FightDelta, FightEvent and FightSwingResult (`presence-codec.ts:62`–`:73`). And
`src/game/entities/fight-rules.ts:119` says "Math.random today; fightCritRoll(seed, counter) once
the server judges", although the server judges now: the press path passes the seeded roll
(`fight-strike.ts:26`, `feed.fights.crit`). The presence half of the last round's docs pass landed
(`src/game/presence-feed.ts:6`–`:16`); the fights half did not.

**Change:** update both passages (keep layers.md's "chosen: the server runs them" and the curated
fights paragraph). Small, but these are the documents the next lane reads first.

## Keep as is

- **One swing counter, one crit roll, unsent swings withdrawn.** `fight-strike.ts` selects and
  stamps at the press from that frame's `fights.seen()`; `presence-feed.ts:195` allocates the
  counter; `presence-client.ts:611`–`:615` reports undelivered work; `FightInterp.result`
  accounts confirmations, refusals and timeouts. `tests/fight-feed.test.ts` pins the wire, the
  withdraw path and the reconnect reset.
- **The observation/play split** (`world-frame.ts`, `WorldScene.ts:673`–`:745`): friends, server
  enemies, the window, camps and the Turning keep running under a menu; input, contact damage and
  the local fights hold. This is the shape shared fights needed.
- **Server enemies as rows, sprites as one life each** (`server-enemies.ts`): resyncs keep a life,
  spawns/respawns draw a new one, deaths play only on the room's event, corpses on a fresh join are
  never resurrected (`fight-interp.ts:80`).
- **The claim's word is the server's** (`camp-fights.ts`' header): dead rows only hurry a read and
  hide a prompt they contradict; a down socket keeps the last word. F1 extends this, it does not
  replace it.
- **Store fencing/ordering and scoped map loads** (`store.ts:545`, `map-data.ts:99`): generation +
  link tokens checked after every `await`, per-kind ordering marks, and each map load owning its
  scope. Keep extending this pattern rather than adding ad-hoc "last write wins" guards.
- **Shared numbers in content with Go twins and vectors** (`lib/enemies.ts`, `lib/combat-timing.ts`,
  `lib/fight-math.ts`, `content/vectors/fights.json`): the client's own path is the pinned one.

## Not verified here

- `EnemySystem.spawnEnemy` registers an arcade collider per sprite (`enemies.ts:396`), now including
  every server-enemy life, and deaths destroy the sprite (`showDeath`, `server-enemies.ts:120`).
  Whether Phaser retires a collider with its destroyed sprite was not established in this review
  (no browser run). If it does not, a long camp fight accumulates colliders. One check in the fight
  perf scenario (`perf/fights.perf.ts`) would settle it; treat this note as a question, not a claim.
- The two-client spec `e2e/fights-shared.spec.ts` and the fight perf scenario exist
  (`docs/shared-fights-testing.md:123`–`:146`) but were not run (the brief excludes e2e).

## Cross-area notes

- **A paused hero takes no hurt.** Contact is judged in the play half (`enemies.ts:229`–`:247`), so
  a lunge that visibly passes through a hero with a panel open does nothing to them, while the room
  keeps attacking. That matches "a menu stops only this player's play" and the friends-only trust
  model (a server check on hurt is explicitly deferred, `shared-fights.md` §5) — but it is now an
  invulnerability window with an animated enemy in it. Worth the owner's word before 0.10, not a
  silent change.
- **Frame batching is the server's new normal** (36f06bf, a7f4f00): client code that reasons about
  arrival spacing should reason in ticks (F4). Anything else the flush writer changes about pacing
  belongs to the server review.

## Proposed order

1. **F1** — the claim prompt's recovery path; small, player-facing, and it protects the fall-record
   work the server lane just landed.
2. **F3** — the Link/outbox extraction as its own cleanup lane; nothing depends on it now.
3. **F2, F4, F5** — small fixes and two comment/doc corrections, each with the guard named above.

## Done
