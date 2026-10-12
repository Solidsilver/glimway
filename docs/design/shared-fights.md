# Design: 0.9 Shared fights

Status: **agreed with the owner, 2026-10-11.** Release: **0.9 Shared fights**; Lamps moves to 0.10.
Next: lanes F-A and F-B, then the one-camp prototype (section 2).
Follows [layers.md](layers.md) ("Fighting together"), [plan.md](plan.md) ("Shared fights: staying
fast and fair"), [server-first.md](server-first.md) §4 and [open-map.md](open-map.md).

Rules kept: the server owns state; never grant or duplicate Habitica items; no compatibility shims
(only the owner plays, so clean breaks are fine).

Owner's priorities, in order (2026-10-11):
1. **Shared play:** friends see and fight the same enemies.
2. **Clean architecture:** the client only predicts and draws; one set of rules.
3. **Cheat-proofing, last:** only friends play.

The agreed model is server-authoritative with prediction:
- **Enemies:** the server simulates them per chunk room (about 10 Hz, only while someone is there);
  clients draw them interpolated about 100 ms behind.
- **Your hits:** you see them at once; the server judges them, favouring the attacker.
- **Your movement:** stays predicted on your screen; the server checks it.
- **Hurt on you:** stays judged on your screen, with the server bounding it.

The agreed flow: this design, then a one-camp prototype (wisps at one Tangle camp, two players, a
phone on mobile data, measured on feel), then lanes.

## 0. Owner decisions

1. **The release is 0.9 Shared fights.** Lamps moves to 0.10. (owner, 2026-10-11)
2. **All camp enemies move to the server in 0.9:** wisps and beetles at every generated camp, on
   every chunk. The prototype runs wisps only. Curated woodland fights, guardians and the Warden
   stay on the client. No camp keeps a local path. (owner, 2026-10-11)
3. **Simulate per chunk, deliver per 3×3.** Each chunk with a player in its 3×3 runs its own sim;
   its snapshots go to everyone who can see that chunk, as presence shares rooms today. Camp
   enemies stay leashed inside their chunk, so there is no hand-off. Enemies that follow you across
   chunks wait for later, more advanced enemies (section 5). (owner, 2026-10-11)
4. **Solo fights go through the server too,** with no local fallback. Your hits show at once and
   hurt stays judged on your screen, so solo you feel latency only in enemy movement. The
   prototype measures it on a phone; if it feels bad, tune wind-ups rather than add a second path.
   (owner, 2026-10-11)
5. **Rooms sleep when everyone leaves.** A chunk's room sleeps 30 s after the last player's 3×3
   stops covering it, so walking out and straight back keeps the fight. Asleep, live enemies are
   forgotten; the camp wakes at full strength in its home spots. A camp that fell stays down for its
   cycle: the server stores "fallen in this epoch and cycle", which claims need anyway. A fight in
   progress lives only in memory; a server restart resets it. Sleeping rooms cost nothing, and
   awake rooms can each run on their own goroutine. (owner, 2026-10-11)
6. **Rewards and camp size.** Anyone whose 3×3 covered the camp's chunk at any point during the
   fight may claim once, if it fell this cycle; dealing damage isn't needed, so a late friend or a
   healer counts. Camp size is fixed when the fight starts (the first enemy aggroed): one extra
   enemy per extra player, up to 5. Enemy HP doesn't scale. (owner, 2026-10-11)
7. **Your hits feel immediate.** Swing, flash, sound, knockback and the number show at once; the
   server's word arrives about one round trip later and normally agrees. Crits come from a
   server-given seed and a swing counter, so your screen predicts them exactly. If the server
   disagrees (already dead, out of reach), the enemy quietly takes the server's HP. Death plays only
   when the server confirms it, so nothing dies and comes back. (owner, 2026-10-11)
8. **Every ability acts on server enemies in 0.9:** Kindle's slow, Stand's lunge-stop, Echo's decoy,
   the Fingersnap bolt and Ward-light, so friends see the same thing. **One owner for costs:** the
   socket's ability path (`allowAbility`) keeps cooldowns and mana; the sim only applies effects.
   A plain swing costs nothing and needs no cost owner. (owner, 2026-10-11)
9. **Hurt on you stays judged on your screen,** against the enemies you see (drawn about 100 ms
   behind), with no new server check. A dodge you saw counts even if the server's enemy would have
   hit. The server keeps its bounds (HP reports only lower it, heals bounded). Falls and the lantern
   don't change. (owner, 2026-10-11)
10. **A fixed 10 Hz tick; a snapshot every tick, of only what changed.** A client that joins or a
    room that wakes gets the full state once. Enemies are drawn 100 ms behind; the delay grows up to
    200 ms when snapshots arrive unevenly and shrinks back when they are steady. Wind-ups go out as
    events stamped with the server's start time, so the whole telegraph plays even when a snapshot
    is late. Telegraphs stay at least today's 0.5 to 0.8 s, with the aim lock last.
    (owner, 2026-10-11)
11. **The sim is `server/internal/fights`:** one goroutine per awake room, a fixed tick, a seeded
    RNG and an injected clock, so tests replay whole fights. A room loads its chunk's effective
    geometry once when it wakes and moves enemies with circle-against-tiles collision in Go. The
    client doesn't simulate enemies, only interpolates them. Enemy tuning and the kit numbers move
    to `content/`, read by both sides, with shared vectors. (owner, 2026-10-11)
12. **The rest of the client-only list.** In 0.9: claims need a fall the server saw (the completion
    seam); camp lifetime follows epoch and cycle; a light movement check, where the sim caps how far
    your reported position may jump per tick and uses the capped position for aggro and reach
    (no rejection, no wall checks). Later: Unmoored on the server, an HP check before a fall,
    client-writable story flags, full path and wall checks. (owner, 2026-10-11)
13. **The prototype is the first real slice,** not throwaway: the `fights` package, the new
    messages and client interpolation and prediction, for one Tangle camp of wisps, on `dev` behind
    `?fights=server`; every other camp stays local until it passes. Game F7's observation/paused-play
    split and its intent/decision split go first; the claim completion seam can wait. It passes on
    these numbers, measured on a phone on mobile data, and on the owner's playtest (it feels like
    today's local fight): snapshot gaps p95 under 150 ms; interpolation delay settling at 200 ms or
    less; hit confirmations p95 under 250 ms; the server disagreeing with under 2 % of hits seen to
    land; a room tick under 1 ms. (owner, 2026-10-11)
14. **Contract 10,** protobuf presence messages, a clean break. You send a swing or cast (kind, where,
    facing, swing counter, the server tick you were seeing). The server sends snapshot deltas (room
    key, tick; per changed enemy its id, whole-pixel position, state, HP, facing), enemy events
    (wind-up start, aim lock, death), hit results, and your crit seed on join. Abilities keep their
    message and add the tick. (owner, 2026-10-11)
15. **Lag compensation keeps 1 s of enemy positions and rewinds at most 250 ms.** Inside that, a swing
    is judged where the enemy was on your screen; past it, at the 250 ms mark. Hit boxes stay
    generous. (owner, 2026-10-11)
16. **0.9 builds the measuring:** pprof behind the admin port, `Server-Timing` on the near read and
    claims, and a load test of bots that open sockets, walk and swing at camps, to find how many
    awake rooms a core runs. `?perf=1` gains a fights section (snapshot gaps, interpolation delay,
    hit confirmation); `npm run perf:walk` gains a fight scenario. (owner, 2026-10-11)
17. **Tests:** Go replays of whole fights from a seed; shared vectors for tuning and the kit; client
    unit tests for interpolation and prediction with an injected clock and jitter; a latency
    injector (`?lag=150&jitter=50` on the client, the same knobs in the Go rig); one two-client e2e
    spec, run in CI only. (default taken, 2026-10-11)
18. **No non-enemy creatures in 0.9.** Nothing friendly wanders in the Wilds. Creatures by kind of
    land stay later; a land's enemies will be new kinds in the same sim. (default taken, 2026-10-11)
19. **No art round.** Wisps and beetles already have wind-up, lock and death art. (default taken,
    2026-10-11)
20. **Lanes and models** as in section 4: Opus for the client, Sol for the Go sim and contract, MiMo
    for measuring; reviews cross families. (default taken, 2026-10-11)
21. **The owner left the remaining details to the designer** (owner, 2026-10-11). Decisions 17 to 20
    are its defaults; sections 1 to 4 fill in the rest, and the prototype gate may change them.

## What exists today

At 0.8.0 every fight runs on the player's own screen. Two players at the same camp each fight
their own copy of it. The inventory is in `.agent/CLIENT-ONLY.md`; the parts that matter here:

- **Camps.** The server generates each chunk's camps with an enemy mix
  (`server/internal/wildsgen`). The client spawns up to three enemies per available camp at fixed
  offsets (`src/game/wilds/entities.ts` `spawnCampEnemies`), with ids `wilds:<campId>:<i>`. A camp
  is claimable when every enemy it spawned is down (`campCleared`). The claim (`wilds.go`
  `wildsClaim`) checks epoch, entity, cycle, reach, rate and once a cycle, but not that a fight
  happened.
- **Enemies.** Three kinds: `wisp` and `beetle` (camps) and `guardian` (curated). Their numbers are
  in `ENEMY_TUNING` (`src/game/entities/enemies.ts:71`): hp, aggro, wind-ups of 0.5 to 0.8 s with
  an aim lock of 0.18 to 0.3 s, hops and charges, cooldowns. Behaviour is in `enemies.ts` and
  `creatures.ts`; the Warden in `warden.ts`. Movement uses Phaser arcade physics against the
  area's collision. Nothing of this exists in Go.
- **Hits.** `hero.ts` swings and bolts (`projectiles.ts`), `enemies.ts` `damageEnemy` applies
  damage, knockback and hit-stop. Crits use `Math.random`. The kit's numbers come from
  `src/lib/combat.ts` (class, level, gear).
- **Hurt on you.** `hero.ts` `damagePlayer`, judged on your screen. The server bounds reports:
  HP may only go down, except for bounded heals (`rules.BoundReport`).
- **Abilities.** Kindle, Ward-light, Stand, Echo and Fingersnap: the server checks unlock,
  cooldown, reach and mana (`presence_abilities.go` `allowAbility`) and relays the cast; effects on
  enemies are client-only (`moves.ts`, the hero's `CombatField`).
- **Presence.** A binary protobuf WebSocket (`proto/glimway/v2/presence.proto`). Wilds rooms are
  `wilds:<cx>:<cy>`; a client joins the room of the chunk it stands in and sees the 3×3 around it
  (`sharedRoom`). Positions go out at most at `positionHz` 8; client messages are capped at
  `messageBytes` 1024 (`content/presence.json`). No enemy messages exist.
- **Curated fights** (the woodland's enemies, the Warden) stay on the client (owner, 2026-10-07).

### Seams from the 0.8 step-back (2026-10-11)

The reviews are in `.agent/2026-10-11-step-back-server.md` and `.agent/2026-10-11-step-back-game.md`.
The cleanup lanes fix most of what they found. These items are left to this design and the
prototype:

- **Room identity is not visibility** (server, "Seams"). `sharedRoom` fans out to the 3×3, and a
  room label carries chunk coordinates but no world, layer or epoch. A sim needs its own key
  (world, layer, chunk, epoch) and lifecycle, kept apart from who can see it.
- **Claims need a completion seam** (server, "Seams"). `wilds.go:405–414` settles a camp claim with
  no fight record. Split "eligible to finish" from once-only reward settlement, so the fight result
  can supply eligibility.
- **A tick must not do request work** (server, "Seams" and finding 6). The store has one connection
  and immediate transactions; cold chunk reads generate inside transactions. (The c08-server lane split
  maintenance from a pure PlayerState projection with one timestamp; new transactions use `a.beginTx(ctx)`.) The room loads geometry once at a lifecycle
  boundary and never calls request projection from a tick.
- **One owner for each combat cost** (server, "Seams"). Socket ability cooldowns and ward credit
  and report-time vitals bounding are two accounting paths today. A server swing must have one
  owner for cooldown, mana and rewards.
- **Measure the wire before changing it** (server, "Seams"). The 1024-byte limit is on what clients
  send; the outbound queue has its own bound. Check snapshot sizes against the limits in each
  direction.
- **Ward-light across a chunk edge** (server finding 2). A friend just over the edge sees the ward
  but gets no credit. Fixed on dev by the c08-server cleanup lane (2026-10-11); shared camps build on it.
- **Epoch-bound operations** (server finding 3). Path operations now carry their epoch (contract 9, the c08-server
  cleanup lane, 2026-10-11); fight-bound claims follow the same pattern.
- **Camp lifetime follows the render window** (game F6). Camps spawn once per entity id and reset
  only when the chunk detaches, so a new cycle while you stay nearby spawns nothing and stays
  claimable. Local camps get reconciled by epoch, entity and cycle; that is the seam the server
  sim replaces.
- **Intent apart from hit decisions, and observation apart from paused play** (game F7). `hero.ts`
  picks targets, rolls crits and calls `damageEnemy` inside animation callbacks; `EnemySystem`
  mixes HP, death and rewards with drawing; creatures run on Phaser bodies. `WorldScene.ts:696`
  stops enemies, projectiles and the window while a menu holds input, but shared enemies must keep
  being drawn (remote players already update above that return, at `:687`). Staged: split intent
  and immediate effects from decisions, split enemy state from sprites, split the scene tick into
  observation and gated local play. Curated fights keep the local implementation behind the same
  boundary.
- **Numbers both sides need move to content** (game F7). Enemy tuning sits in a Phaser module and
  damage tuning in `src/lib/combat.ts:145`. Move them to content with shared vectors as each rule is
  ported; no untested Go transcription.
- **Interpolation to reuse with care** (game, "Shared fights"). `src/lib/presence-interp.ts` is pure
  and testable, but stamps samples at receipt and inserts a still pose after a 300 ms gap. That is
  policy for player poses, not for enemy attacks.
- **Docs to correct:** `layers.md`'s presence and guest-play lines (corrected with this design),
  and the `src/game/presence-feed.ts:15` comment (presence drives Ward healing; lane F-A).

## 1. The design

### 1.1 What a player sees

You walk up to a camp with a friend. You both see the same three wisps, plus one more for the
second of you, rising at the camp when the first one turns on you. A wisp crouches and flashes
white before it hops; on both screens it's the same wisp at the same moment, give or take a tenth
of a second. Your swing lands at once: flash, number, knockback. Your friend sees your hit about a
tenth of a second later. When the last wisp goes down you can both claim the camp. If you open
your pack mid-fight, the fight goes on around you and your friend keeps fighting.

Alone it's the same fight, with three wisps.

### 1.2 Rooms

- **Key.** A fight room is keyed by `(world, realm, layer, cx, cy, epoch)`, the same shape as a
  generated world-change key (`worldchange`). That is separate from the presence room label
  `wilds:<cx>:<cy>`, which stays as it is and decides only who sees whom (step-back "Room identity
  is not visibility"). Realm is `wilds` and layer the open map's ground layer today; caves add
  layers later (1.11).
- **Wake.** A chunk with a camp has a room, awake while any player's 3×3 covers it (decision 3).
  The hub wakes it when a position report puts a player within one chunk of it. Waking loads the chunk's effective
  geometry (`chunks.Effective`, at a lifecycle boundary, never inside a tick) and its camps from the
  stored chunk, and checks each camp's fall record for the current cycle.
- **Sleep.** 30 s after the last cover ends, the room stops (decision 5). Live enemies are
  forgotten. Nothing is written except the fall records already written.
- **The turning.** A room's epoch is part of its key, so when a chunk's epoch ends the room closes
  at once: enemies vanish, a final "room closed" event goes out, and the next position report wakes
  the new epoch's room. The Tangle never turns.
- **Goroutines.** Each awake room runs on its own goroutine with a fixed 100 ms tick
  (decision 11). A tick reads only the room's memory: no store calls, no request projection, no
  chunk generation (step-back "A tick must not do request work"). Inputs (positions, swings,
  casts) arrive on a channel; outputs (snapshots, events) go to the presence hub's bounded
  outbound queues. A fall record goes to one writer goroutine, which writes it in its own
  transaction.
- **Determinism.** Each room has a seeded RNG (from world, chunk, epoch, cycle and wake count) and
  an injected clock. A test drives ticks directly and replays a fight from its seed and its input
  log.

### 1.3 Enemies

- **Kinds:** `wisp` and `beetle`, from the camp's generated mix (decision 2). Their behaviour moves
  from `creatures.ts` to Go: wisp chase, hop with wind-up and aim lock; beetle walk, keep-away,
  charge with wind-up and lock, stun on a wall, takes 1.5× while stunned.
- **Numbers in content.** `ENEMY_TUNING` and `KNOCK` move to `content/enemies.json` (hp, reach,
  aggro, speeds, wind-ups, locks, cooldowns, knockback), typed in proto with protovalidate. The
  client reads the same file for drawing (HP bars, wind-up timing, predicted knockback). Vectors
  check the timing edges (a hop that lands as the lock ends, a charge into a wall).
- **Movement.** Circle against tile collision in Go, on the room's loaded geometry. Enemies are
  leashed to their camp and never leave their chunk (decision 3).
- **Targets.** The nearest player inside aggro range, using each player's capped position
  (decision 12). An Echo decoy is a target too. Wisps reconsider the nearest eligible player
  between attacks. They keep their target during a wind-up and lunge, so the tell stays readable.
  A current target can still be chased beyond aggro range until it leaves the camp leash, falls
  or goes; then the wisp picks again or walks home. Closest-player targeting between attacks
  replaces the prototype's persistent focus (owner playtest, 2026-10-12).
- **Camp size.** Fixed at the first aggro: the base mix (up to 3), plus one per extra player within
  160 px of the camp's centre at that moment, up to 5 (decision 6). Extra enemies rise at the camp
  with the existing spawn fade. Enemy HP doesn't scale.
- **The fall.** When the last enemy dies the room writes a fall record:
  `(world, realm, layer, chunk, epoch, entity, cycle, fell_at)`, with the witnesses (every
  account whose 3×3 covered the chunk at any point since the first aggro). Migration 035 adds the tables.
- **Curated fights** (woodland, guardians, the Warden) keep the local implementation behind the
  same client seam (lane F-A).

### 1.4 Your hits

- **On your screen at once** (decision 7): swing, flash, sound, knockback and the number. Your screen
  picks the target from the enemies it draws, as today, and sends the swing.
- **The swing message** (decision 14) carries the basic attack (the melee slash or the mage's
  bolt), where you stood, facing, your swing counter, and the tick you were drawing. The
  signatures (Cleave, Fingersnap, Shadowstep, Mend) and the level-20 moves are abilities (1.6).
- **The server's judgement.** It checks the kit's swing cooldown, then rewinds its enemy history to
  the tick you were drawing, capped at 250 ms back (decision 15), and checks reach against your
  capped position with today's generous hit boxes. Damage comes from the kit the server derives
  from your profile (class, level, gear: a Go port of `src/lib/combat.ts`'s derivation, with the
  numbers in content and shared vectors).
- **Crits.** On join the server sends you a crit seed. A swing's crit is a pure function of the
  seed, your swing counter and your crit chance, so your screen and the server agree. No
  `Math.random` is left in fights.
- **Bolts.** The server moves the mage's bolt and Fingersnap in the sim from where and when you
  cast; your screen draws its own at once.
- **Results.** A hit result goes to the swinger (confirm or refuse) and the hit shows up in the
  next snapshot for everyone. On a refusal your screen quietly takes the server's HP; no
  correction is drawn. Death plays only on the server's death event (decision 7).
- **Knockback.** The server applies it. Your screen offsets the enemy at once by the predicted
  knock and blends back onto the server's path over about 150 ms.

### 1.5 Hurt on you

As decided (decision 9): your screen judges contact and attacks against the enemies it draws,
about 100 ms behind. Enemy attacks carry their target, but any enemy you see can hurt you. Reports
keep their bounds (`rules.BoundReport`). Falls and the lantern don't change. When you fall you stop
being a target in the room.

### 1.6 Abilities

- The socket's `allowAbility` keeps unlock, cooldown, reach and mana, as today (decision 8). An
  allowed cast also goes to the room's input channel with its tick. The sim applies the effect.
  Signatures: Fingersnap's bolt flies; Cleave, Shadowstep's strike and Mend's damaging pulse hit
  enemies as they do on screen today (Mend's heal stays with the healing credit). Level-20 moves: Kindle's patches slow
  enemies, Stand stops a lunge short and staggers, Echo leaves a decoy target, Ward-light pulses
  (its credit stays where it is, fixed across chunk edges by step-back finding 2). Ability hits are
  judged like swings (rewind, reach) and their crits come from the same seed.
- `CombatField` stays on the client for prediction and drawing; the sim has its own copy of the
  rules in Go, both reading the ability numbers from content.
- A plain swing costs nothing; only cooldown applies.

### 1.7 The wire (contract 10)

New presence messages, all protobuf (decision 14):

| Message | Direction | Fields |
|---|---|---|
| `FightSwing` | client → server | kind (slash or bolt), x, y, facing, swing counter, seen tick and offset, tool, predicted targets |
| `PresenceAbility` | both | as today, plus seen tick and offset, facing, swing counter (shared with swings), predicted targets |
| `FightJoin` | server → client | room key, room handle, tick, whole enemy rows (index, id, kind, camp, max HP, state and its start tick, ...), your crit seed |
| `FightDelta` | server → client | room handle, tick, changed enemies as patches: index, x, y (whole pixels, sint32), state and its start tick, hp, facing (a step of 256); spawned rows; removed indices |
| `FightEvent` | server → client | room handle, start tick and offset, kind (wind-up start, aim lock, death, spawn, room closed), enemy index, target |
| `FightSwingResult` | server → swinger | swing counter, crit, swing refusal, rows: room, enemy, damage or refused reason |

- **Diff only** (decision 10). A delta carries only enemies that changed; an idle room sends
  nothing. A client gets `FightJoin` when a room enters its 3×3 or wakes.
- **Size.** About 12 to 15 bytes an enemy; a camp of 5 is under 100 bytes a delta. Swings are
  well under the 1024-byte client limit. Outbound frames go through the existing bounded queue;
  the prototype measures queue depth with 9 awake rooms around one player.
- **Clock.** Ticks are the time base: one world grid for every room, `floor(server ms / 100)`
  as a wrapping uint32, with a 0–99 ms offset where an instant falls between ticks. The client
  estimates the server tick from delta arrivals and draws at `tick − delay` (1.8). Wire details
  are in `docs/proto-migration.md` (contract 10).

### 1.8 Drawing server enemies

- **Interpolation.** A buffer of snapshots per enemy, drawn at 100 ms behind the estimated server
  tick; the delay grows up to 200 ms while arrival gaps are uneven and shrinks back when they
  settle (decision 10). Stamped by server tick, not by receipt (unlike `presence-interp.ts`'s
  player poses), and no synthetic still pose: an enemy holds its last state until the next delta.
- **Events** play from their start tick and offset, so a late delta never shortens a wind-up.
- **Observation runs while you are paused.** The scene tick splits into world observation and
  presentation (remote players, server enemies, the window) and this player's gated input and
  local play (game F7). A menu stops only the second.
- **Flag.** `?fights=server` draws the prototype camp's server enemies instead of spawning it
  locally (decision 13). After the gate the flag goes and every camp is a server camp.

### 1.9 Claims and camps

- **The completion seam** (step-back "Claims need a completion seam"). `wildsClaim` splits into
  "eligible to finish" and once-only reward settlement. For a camp, eligibility is a fall record
  for this epoch and cycle that lists the claimant as a witness. Settlement, loot rolls and keyed
  replay stay as they are.
- **The claim carries its epoch,** like the path operations after step-back finding 3, and is
  refused if that epoch has ended.
- **Camp lifetime** (game F6). The client keys a camp by epoch, entity and cycle, from the near
  read and the room's events, not by whether its chunk is attached.

### 1.10 Movement

The light check (decision 12): the room caps how far a player's reported position can move per
tick (the hero's top speed, riding included, plus slack), and uses the capped position for aggro,
targets and reach. Reports are never rejected, and walls aren't checked.

### 1.11 Seams for a seamless world

The owner has agreed a path towards one streamed outdoor world: the village, the Commons and the
Wilds on one grid, with indoors still a transition (`docs/design/seamless-world.md` on
`exp/seamless-explore`, "Keep physical space separate from named places" and "Server fights, then
Lamps"). Its first step is this seam, designed beside the fights. No new lanes: the prototype and
0.9 run on today's Tangle, and these rules only keep 0.9 from building in the wrong boundary.

- **The identity a sim owns** is `(world, realm, layer, cx, cy, epoch)` (1.2). Nothing in
  `fights` reads an area name or a presence room label. When the village and Commons join the
  grid, they are chunks of a realm like any other; a chunk that holds no camp has no room.
- **One owning sim per chunk and epoch.** A camp belongs to the chunk its anchor is in, and only
  that chunk's room runs it, never a copy per viewer. Players in the 3×3 observe it through
  presence fan-out. A swing or cast near an edge goes to every awake room whose chunk its reach
  touches (at most four, at a corner); each judges only its own enemies. A room receives the
  capped positions of every player in its 3×3, so an enemy can target a player standing across
  the edge. The camp leash stays a combat rule even when chunk edges are invisible.
- **Which chunks wake.** Every chunk with a camp in a player's 3×3 wakes (decision 3), so enemies
  you can see in the next chunk are always simulated. Waking costs little: a camp at rest only idles, and a room with
  nothing changing sends nothing (decision 10). Chunks with no camps, such as the town's, never get
  a room.
- **Places and safe zones are a lookup at a world position,** not an area name. One function
  answers, for `(world, x, y)`: the place id, the plot if any, whether it is safe, its rest rules
  and its epoch; Go and TypeScript share it with vectors. The sim uses it to keep enemies out of
  safe ground (a leash edge as well as a chunk edge), and the claim and quest checks use it instead
  of comparing area strings. 0.9 needs only the Wilds' answer; the lookup is the place the town's
  answers go later.
- **Stable anchor ids.** Camps are named by their generated entity id, and fall records and claims
  key on it, never on a pixel position. Doors, recovery points and other anchors get the same kind
  of stable id, resolved to a world position through the lookup, so moving the village on the grid
  doesn't move what refers to it.
- **Curated story fights stay on the client** even once their places sit on the grid: the
  woodland's enemies, guardians and the Warden stay personal story beats, keyed by their
  `defeated:` ids. A chunk holding one gets no server room for it; each player fights their own
  copy, behind the F-A seam. Putting the pictures on the grid doesn't change who owns the fight.

## 2. The prototype

**Scope** (decision 13): wisps at one Tangle camp, named in server config. The `fights` package
with rooms, wake and sleep, wisps, swings, lag compensation and crit seeds; contract 10's messages;
client interpolation, prediction and events behind `?fights=server`; the fights section of
`?perf=1`. Game F7's two splits land first. Not in it: beetles, abilities in the sim, camp
scaling, fall records (the prototype camp is still claimed the old way).

**How:** two players at the camp, one on a phone on mobile data; then the same with the latency
injector at `?lag=150&jitter=50` and `?lag=300&jitter=100`. The owner playtests on `dev`.

**It passes when** (decision 13):

| Measure | Target |
|---|---|
| Snapshot gap, p95 | under 150 ms |
| Interpolation delay, settled | 200 ms or less |
| Hit confirmation, p95 | under 250 ms |
| Hits seen to land that the server refuses | under 2 % |
| Room tick | under 1 ms |
| Owner's playtest | feels like today's local fight |

**What we learn before the lanes go on:** whether 10 Hz and 100 ms read as smooth on a phone;
whether the 250 ms rewind cap refuses too many phone hits; whether wind-ups need lengthening;
outbound queue depth; whether WebSocket over TCP stutters on mobile data. WebTransport waits unless
the last of these fails.

## 3. Tests and budgets

**Go** (`server/internal/fights`):
- Fight replays from a seed and an input log: a wisp hop and its lock, a beetle charge into a wall
  and its stun, three players scaling a camp to 5, a swing at the 250 ms cap and one past it, a crit
  matching the client's vector, sleep after 30 s and a fresh wake, the turning closing a room, a
  fall record with its witnesses.
- A tick never touches the store (a store fake that fails the test on any call during a tick).
- Claims: eligible with a fall record and as a witness; refused without; once only; replay.
- The latency rig: delay, jitter and loss on the room's inputs.

**Shared vectors:** enemy tuning edges, kit derivation, crit from seed and counter, ability effects.

**Client** (node tests, injected clock): interpolation under jitter and gaps, the adaptive delay,
events from start time, predicted knockback blending, crit prediction, observation while paused.

**E2E** (CI only, per the e2e-load rule): one two-client spec. Two browsers at the prototype
camp; one opens a menu; both see the same wisp wind up and die; both can claim.

**Measuring** (decision 16): pprof on the admin port; `Server-Timing` on the near read and claims;
a bot load test (sockets that walk and swing at camps) reporting awake rooms per core and tick
time; `?perf=1` fights section; a fight scenario in `npm run perf:walk`.

**Budgets:**

| Budget | Limit |
|---|---|
| Room tick (a camp of 5, 3 players) | under 1 ms |
| Delta, a camp of 5 | under 100 bytes |
| Outbound to one player, 9 awake rooms in a fight | under 10 KB/s |
| Frame time added on a phone at 4× throttle | under 2 ms |
| Awake rooms per core | measured by the load test; goal 200 |

## 4. Lanes

Order: F-A and F-B in parallel; F-C and F-D on top; the **prototype gate** (the owner
playtests); then F-E, F-F and F-G in parallel. Reviews cross families (Opus reviews Sol, Sol
reviews Opus). Agents run unit tests; the two-client e2e runs in CI.

| Lane | Scope | Files | Depends on | Size | Model |
|---|---|---|---|---|---|
| F-A Client seams | Game F7: intent and immediate effects apart from hit decisions; enemy state apart from sprites; the scene tick split into observation and gated local play. Curated fights keep working through the seam. Fix the `presence-feed.ts:15` comment. | `src/game/entities/{hero,enemies,creatures,moves}.ts`, `src/game/scenes/WorldScene.ts`, `src/game/presence-feed.ts` | none; can start now | L | Opus |
| F-B Contract and content | Contract 10 messages (1.7); `content/enemies.json` and the kit numbers in content with protovalidate; shared vectors; both loaders | `proto/glimway/v2/presence.proto`, `proto/glimway/content/v1/`, `content/`, `content/vectors/`, `src/lib/combat.ts` | none | M | Sol |
| F-C The sim (prototype) | `server/internal/fights`: room key and lifecycle, wake and sleep, goroutine and tick, geometry at wake, wisps, swings, lag compensation, crit seeds, the kit port, the movement cap; the hub wiring; the Go rig with latency | `server/internal/fights/`, `server/internal/api/presence*.go`, `server/internal/rules/` | F-B | L | Sol |
| F-D Server enemies on screen (prototype) | Interpolation and adaptive delay, events from start time, swing sending and hit results, predicted knockback, crit prediction, `?fights=server`, the `?perf=1` fights section, the latency injector | `src/lib/fight-interp.ts` (new), `src/lib/presence-client.ts`, `src/game/presence-feed.ts`, `src/game/entities/`, `src/game/perf*` | F-A, F-B; against F-C on `dev` | L | Opus |
| **Prototype gate** | Section 2; the owner playtests | — | F-C, F-D | — | owner |
| F-E The rest of the sim | Beetles; abilities in the sim; camp scaling; every camp a server camp; the flag removed; local camp code deleted | `server/internal/fights/`, `src/game/wilds/entities.ts`, `src/game/entities/` | the gate | L | Sol (Opus for the client part) |
| F-F Claims and camps | Migration 035 fall records and witnesses; the completion seam; claims with an epoch; client camp lifetime by epoch, entity and cycle (F6) | `server/internal/api/wilds.go`, `server/internal/store/migrations/035_*.sql`, `src/game/wilds/entities.ts` | the gate; F-C's fall output | M | Sol (Opus for the client part) |
| F-G Measuring | pprof, `Server-Timing`, the bot load test, the perf-walk fight scenario, the two-client e2e spec | `server/cmd/`, `server/internal/api/`, `scripts/`, `e2e/` | F-C; the e2e spec after F-E | M | MiMo |

## 5. Later, on purpose

- **Cheat-proofing past 0.9** (decision 12): Unmoored on the server, an HP check before `fall`,
  client-writable story flags, path and wall checks on movement, a server check on hurt.
- **Enemies that follow you across chunks** (owner, 2026-10-11): more advanced enemies that leave
  their chunk, with a hand-off between rooms. 0.9 keeps every enemy leashed to its chunk.
- **Bosses and caves** (layers.md): guardians and cave bosses with scripted patterns run in the
  same sim, with naming pieces shared in the room. They come with caves.
- **Curated story fights stay on the client** (owner, 2026-10-07): the woodland's enemies and the
  Warden, behind the F-A seam.
- **Creatures by kind of land** (open-map.md section 7): new kinds in the same sim, from the land's
  data entry. Friendly wandering creatures, if any, come with them.
- **WebTransport datagrams** (plan.md): only if the prototype shows stutter on mobile data over the
  WebSocket.
- **The seamless outdoor world** (1.11): the village and Commons on the grid, the place lookup's
  town answers, stable door ids in use. Its own design follows the fights.
- **Shared drops:** rewards stay personal (decision 6). Nothing drops on the ground for a room.
