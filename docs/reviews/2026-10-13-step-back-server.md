# Step-back review after 0.9: the server (Go)

Snapshot: `268c9b4` — the step-back round after 0.9 (shared server-run camp fights, presence v3
frames, the sharded fight scheduler, the opt-in tick flush, plus the 0.8.x fixes). Review only;
this document is the only repository change. Paths are repository-relative.

## Map: what changed since 2026-10-11

The server now runs the Wilds camp fights. `server/internal/fights` (about 2,300 production lines
plus 1,700 of tests) holds the room sim: one `Room` per `(world, realm, layer, cx, cy, epoch)`,
wisp/beetle behaviour, camp scaling and falls, lag-compensated swings and casts, seeded crits,
multi-room bolt `Flight`s, and the `Actor`/`Scheduler` that step every room on one shared 100 ms
grid of worker goroutines. `server/internal/api` grew the hub side: `presence_fights.go` (wake,
coverage, fan-out, swing/cast dispatch and one gathered `FightSwingResult`), `fall_writer.go` (the
single durable fall writer, plus `CampAtWake`), `fight_metrics.go`, `projection.go` (the request
clock and explicit maintenance), and a rewritten `routes.go` route table. `store/falls.go` and
migration **035** add `fight_falls`, `fight_fall_witnesses` and `camp_claims`; `wildsClaim` gained
the completion seam (eligibility from a fall's witnesses, then once-only settlement). Content
gained `enemies.json` and the combat attack/signature geometry, with `rules/fight_math.go` and
`combat_kit.go` as the Go twins of the client's shared maths. Presence v3 carries framed,
coalesced events; the flush writer is opt-in (`-presence-flush-ms`); an opt-in loopback-only
admin listener serves pprof and fight metrics.

Also in this window, the previous round's own findings landed: cross-chunk ward credit
(`presence_abilities.go:357`), epoch-bound path operations (`open_map_paths.go:108`), purse live
reservations (`api/purse.go:167`, `store.SettleStaleTopUps(…, a.topUpLive)`), one operation clock
through the projection chain (`projection.go`, `store/composition.go`), the route metadata table
(`routes.go:77`), the Nix fileset import check (`nix/web.nix:18`, `ci.yml:36`) and expanded
changed-test selection (`e2e/changed-map.json`).

### Status of the 2026-10-11 findings

| Previous finding | Status | Evidence and remaining work |
|---|---|---|
| 1. Nix web package / asset recurrence | **done** | Both generated assets are in the fileset (`nix/web.nix:18–19`) and CI runs `node scripts/check-web-fileset.ts` (`ci.yml:36–37`). The full Nix derivation is still not built in CI; the import check is the recurrence guard that was asked for. |
| 2. Ward-light across chunk edges | **done** | Receiver eligibility uses `sharedRoom` (`presence_abilities.go:357–362`); the relayed cast strips the fight part (`presence_abilities.go:346`). |
| 3. Delayed path operation spent materials across a turning | **done** | `spotFor` rejects a target epoch that is no longer the tile's (`open_map_paths.go:108–112`), before the chunk read and any debit; keyed replay is untouched. |
| 4. Live purse worker versus lazy recovery | **done** | `liveTopUps` covers the interval before the worker starts and the detached checks (`api/purse.go:167–191,208–218`); `SettleStaleTopUps` only takes abandoned rows (`projection.go:58–62`). |
| 5. Fixture readiness and timing thresholds | **partly** | The always-on wall-clock assertion is gone: both generator timings need `GLIMWAY_PERF=1` (`wilds/budget_v3_test.go:114,130–133`) and a `generator-performance` job runs them (`ci.yml:230–243`). The six e2e fixture/readiness fixes are the tests lane and were not checked here. |
| 6. PlayerState maintenance and clocks | **done** | One timestamp through the chain (`store/composition.go`), explicit `maintainState` before projection (`projection.go:57`), the transaction clock sampled after `beginTx` (`projection.go:20–54`), and the fake moved to `store/storetest/composition.go`. |
| 7. Changed-test selection | **done** | The blanket `content/**` ignore is narrowed and open-map/chunks/wildsgen/frontier/worldchange, purse and fishing map to their specs (`e2e/changed-map.json:15,17–21,368–380`). |
| 8. Routes and diagnostics | **done** | One `routeMetadata` table carries handler and label, including `/api/operations/result` and the Wilds actions (`routes.go:77–…`); unexpected errors go to `logUnexpected` (`diagnostics.go:16`). |
| 9. Reused boundaries and stale prose | **not checked** | The fights package is the new consumer of effective geometry and path seams; the docs/prose side belongs to the design lane. |

Nothing in the old list is repeated below.

## Findings

### 1. A killing blow keeps its fall inside the room for up to a tick, and a claim in that window is refused `not-defeated` — a refusal that is terminal for the op key

**Evidence:** `Room.hit` → `campFell` appends the fall to the room's list
(`server/internal/fights/room.go:890–906`). The `Actor` hands falls to the writer in three places:
the tick (`actor.go:357`), the exit (`actor.go:255`), and the dev `Clear` command
(`actor.go:328–332` — which says so explicitly: "The fall goes to the writer now, not at the next
tick"). The normal paths — `cmd.Attack` (`actor.go:300–311`) and `cmd.Cast` (`actor.go:312–327`) —
flush the room's *events* (`w.events`, so the `DEATH` event and the `FightSwingResult` go out at
once) but leave `r.falls` for the next `Step`, up to 100 ms later.

A claim covers that gap only if the fall is already queued: `wildsClaim` waits for queued copies
(`api/wilds.go:366–369`, `fall_writer.go:189–208`) and then reads the store
(`api/wilds.go:489–496`, `store/falls.go:68`). Nothing covers "the room has judged the fall but not
yet emitted it", although `fall_writer.go:6` states the guarantee as "a claim that arrives first,
still sees it".

**Interleaving:** the last enemy dies from a swing judged between ticks at *T* (`actor.go:300`).
The `DEATH` event is written to the socket at *T* (`w.events`) and the gathered
`FightSwingResult` follows within milliseconds; the fall is still in `r.falls`. A
claim request already in flight (the player clicked as the enemy hit 1 HP, or the client claims on
its own predicted kill) arrives at *T + 20 ms*. `await` finds nothing queued, `campEligible` finds
no fall, and the operation is refused `409 not-defeated`. `terminalRefusal` treats that code as
terminal (`op_idempotency.go:315–323`), so `saveRefusedOp` stores it (`op.go:168–172`) and every
retry with the same op key replays the refusal — including retries that land after the fall has
been written a tick later. A fresh user action (a new key) succeeds, so the visible symptom is a
claim that fails once and then refuses to recover on retry.

**Change:** hand the fall to the writer where the blow lands — take `r.takeFalls()` in `apply`
after the attack/cast branches exactly as the `Clear` branch already does (`actor.go:332`). The
Fall callback is documented as non-blocking and the queue is unbounded, so this is safe on the
worker. Keep `await` as the claim's second gate. If the room-side gap is preferred instead, make
`await` also wait on the covered rooms' pending falls, but the first fix is one line.

**Guards:** a claim submitted in the same tick as the killing swing succeeds after the bounded
wait; a claim for a camp that fell one tick earlier does not come back `not-defeated` under its
original key; the existing fall-on-stop tests (`fights/review_test.go:14`) keep passing.

**Size/risk:** **S**, low. Worth doing before the fall/claim path gets more callers.

### 2. The hub caches every visited chunk's fight ground and its "no camp" marker for the life of the process, and that ground never sees a later path change

**Evidence:** every wake stores the chunk's `fights.Geometry` — the full walkability grid, 24×24
bools — in `h.fightLocations`, including campless chunks (`presence_fights.go:404–407,472`).
The only removal is the epoch-expiry check (`presence_fights.go:295–299`), and it needs
`resolved.endsAt > 0`. The Tangle's epoch has no end (`loadFightChunk` sets `endsAt` only when the
epoch has one), so for the world people actually play in nothing is ever removed: `fightLocations`
and `fightFailedWakes` grow by one entry per chunk any player's 3×3 ever touched. The store's own
chunk cache is explicitly bounded (`store/chunks.go:358–361`); this one has no bound at all. It is
small per chunk today and the frontier is small (`content/wilds.json` frontier reach 3), but the
frontier is stated to move in 0.9 and to grow with Lamps (`frontier.go:1–6`), and the map is held
forever.

The cached ground is also a snapshot of `chunks.Effective` at wake. `Effective.Walkable` opens a
tile for any ground change (`chunks/effective.go:58–59`), so a stone path laid after the wake is
invisible to the sim and to `fightGround` (`presence_fights.go:727`) — the ground bolts and
Shadowstep dashes are judged against — for as long as the entry lives. A room's own geometry is a
deliberate wake-time copy (bounded by sleep while players are away); the location cache turns that
bounded staleness into an unbounded one, and campless chunks never get a room to refresh them.

**Change:** bound `fightLocations`/`fightFailedWakes` (an LRU like `store/chunks.go`, or drop a
location when its last room sleeps and no peer covers it), and invalidate a cached geometry from
the path operations' after-commit hook (`wildsLay`/`wildsClear`/`wildsLift` know exactly which
chunk changed). Re-reading a chunk's ground on the next wake is enough; no live update is needed.

**Guards:** a walk across N chunks leaves the map at a bounded size; a bolt fired across a tile
laid after the wake is judged on the changed ground; the wake-cache tests
(`presence_fights_review_test.go`) keep passing.

**Size/risk:** **S–M**, low risk. Do it before the frontier grows, not before the first shared
camp.

### 3. `FightSwing.tool` halves (or does not halve) the damage of every slash, and the client decides it

**Evidence:** `rules.FightDamage` multiplies the base by `attack.toolDamageFraction` — 0.5 in
`content/combat.json` — when `tool` is set (`rules/fight_math.go:44–55`), and the room passes the
flag from the wire straight into `hit` (`room.go:956`). The hub trusts it the same way
(`presence_fights.go:595–613`); the only server rule that reads it is the mage-may-slash check at
`:602`. The client sends `tool: strike.kind === 'tool'` (`src/game/entities/fight-strike.ts:35`),
i.e. whether the swing came from a held tool.

**Interleaving:** a player holding an axe or pick sends their swing with `tool: false`. The room
judges full `kit.MeleeDamage` instead of the tool half — double damage to the shared camp — with
nothing else different: same cooldown, same counter, same reach, same crit roll. The flag is the
one remaining client-decided input to server damage in the fight path.

**Change:** the swing should carry what is in hand (the item def, or a boolean the server derives
from its own inventory of the sender) and the hub should compute `tool` from that; a mage's tool
slash stays allowed. If the friends model is meant to keep this client-side, then say so next to
the flag and drop it from the damage formula so it is cosmetic rather than a damage switch.

**Guards:** a tool swing from an account whose carried items hold no tool does not get full melee
damage; the existing `fight_math` vectors cover the fraction itself.

**Size/risk:** **S–M** (small contract addition plus one hub check). Cheapest of the remaining
"still client-trusted" items; hurt/HP staying client-observed is an explicit owner decision
(shared-fights.md 1.5) and is not raised here.

### 4. Kindle's patch is placed at the client's stated point, skipping the room's movement cap

**Evidence:** every cast but one runs its origin through `attackPosition`, the same per-tick
movement budget a swing origin shares (`server/internal/fights/cast.go:86–88`). Kindle is the
exception (`cast.go:111–113`): its patch is laid at `c.X, c.Y`, which `handleFightCast` takes from
the client's `PresenceAbility` (`presence_fights.go:661`). The one bound on that point is
`allowAbility`'s reach + one tile + moving-caster slack (`presence_abilities.go:282–289`), i.e.
up to about a tile and 53 px from the last stored position. Everything else in the room —
aggro, targets, slash and strike origins, the decoy — uses the capped position
(shared-fights.md 1.10: "the room caps how far a player's reported position can move per tick …
and uses the capped position").

The effect is bounded and small (a slow patch one tile ahead of where the room thinks the caster
stands), so this is a consistency gap rather than an exploit: it is the one place where the
movement cap — the design's single movement trust rule — can be skipped, and the exception is
undocumented.

**Change:** place the patch at the capped position (`p.X, p.Y` after `attackPosition`, as `echo`
already does) or cap `c.X, c.Y` like a swing origin. One line in `Room.Cast`, and the same
treatment for any future placed field effect.

**Guards:** a kindle cast from a client that reports a position a full chunk ahead lays its patch
at the capped spot; the signature vectors for Kindle's radius are unchanged.

**Size/risk:** **S**, low.

## Keep as is

- **The room/actor/scheduler shape.** One goroutine per worker set, no goroutine per room, no
  store work in a tick, commands answered or dropped without waiting, and the fall handover on
  exit (`actor.go:226–256`). The lifecycle races that remain are the ones named above, not a
  locking problem: the hub lock is taken in one direction (worker → hub, never the reverse), and
  the flight callbacks are careful not to hold worker state.
- **The fall writer.** Unbounded queue, retried writes, idempotent `InsertFall`, queued falls
  readable at wake (`ReadFallInTx`) and `entity_state` owned by the fall. Finding 1 is the seam
  between the room and this writer, not the writer itself.
- **Server-owned damage, crits and reach** (`rules/fight_math.go`), with the float-fusion guards
  and the shared vectors. The kit comes from the profile; the swing's job is to be judged, not to
  carry numbers.
- **Frame coalescing and the opt-in flush.** Frames are assembled from shared bytes, bounded per
  peer by both messages and bytes, with Ready and swing results kept urgent. The default stays 0
  (immediate).
- **The 0.9 migrations and the claim tables.** Migration 035 matches its history hash, the
  witnesses/claims keys are exactly the design's, and camp claims never move the camp's row.

## Proposed order

1. **Findings 1 and 4** — one small change each, both on paths a player touches every fight.
2. **Finding 3** — a small contract addition; do it with the next proto change so the swing's
   fields stay honest.
3. **Finding 2** — before the frontier moves (Lamps), with the invalidation hook beside the path
   operations.

## Verification

Only this review document is an authored repository change. No source files were edited, no
commit was made, and no git command that changes state was run. No e2e suite and no Nix build was
run. Everything ran through this terminal.

**Unmodified suites:**

- `go test -count=1` on `server/internal/fights`, `server/internal/rules`, `content`: passed
  (0.50 s, 0.16 s, 1.15 s).
- `go test -count=1` on `server/internal/api`, `server/internal/store`: passed (25.5 s, 11.5 s).
- `go vet ./...` and `node_modules/.bin/buf lint`: passed.
- The `wilds`, `chunks` and `wildsgen` packages were not re-run this round (their behaviour is
  unchanged since the last review's runs except for the timing-test gating, which is covered by
  `TestGeneratorTimingIsOptIn`).

**Claims checked in code, not reproduced:** findings 1–4 are interleavings read from the code.
Finding 1's refusal stickiness follows from `terminalRefusal`'s list (`not-defeated` is not among
the non-terminal codes) and `op.go`'s replay of a stored refusal; the window itself is one room
tick. No probe test was written for these: each is a small, contained fix with the guards listed.

## Done
