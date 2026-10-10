# Step-back review: the game, the UI and the client libraries (`src/`, `tests/`, `e2e/`)

Snapshot **afa8363** (v0.5.0 "Crafts", 2026-10-09). Scope: `src/` (game scenes and entities, `src/ui`,
`src/lib`, `src/content`), `tests/` and `e2e/` — the client side only; the server is the other review.
Checks run here: `tsc --noEmit` (clean), `tsc -p tsconfig.e2e.json` (clean), `npm test` (1,768 pass,
0 fail, ~10 s), plus read-throughs and grep sweeps. jscpd/knip are no longer in the toolchain, so the
dead-code sweep below is a hand-rolled identifier scan. The e2e suite was not run (per the brief).
Sizes: `src/` (minus generated) ~71k lines, `tests/` ~18k, `e2e/` ~12k, 248 e2e tests in 62 specs.

The four known items are findings F1, F5, F2 and F6 (in the brief's order 1, 2, 3, 4); each says so.

## 1. What changed since the last step-back (2026-10-07)

**The cleanup lane acted on most of that review.** The bus is a small typed, Phaser-free emitter with
one `EventMap` registry (`events.ts`, `event-names.ts`); `lib/tile.ts` exists and `session.ts` no
longer imports Phaser; WorldScene is 1,058 lines with its subsystems moved out (`world-actions`,
`world-arrival`, `world-camera`, `world-controls`, `world-turning`, `world-dev-hooks` — the dev hooks
are DEV-only, scene-scoped and typed by one `FsHooks` list in `dev-hooks.ts`); `homesteads.ts` split
into art/talk/placement/yard/stable; `enemies.ts` split into creatures/warden; interactions are one
`Interactable` path with `openDialogue()` (`dialogue.ts:14`) and `interactables.ts` down to 266 lines;
art passes share `art-pass.ts` (`explodeFrames`, `registerAnims`). Not acted on: the dead-export sweep
(F9), the placeholder-art question, and any split of `link.ts` — which has since grown (F8).

**Then 0.5 landed** (lanes E, F, G in `docs/design/crafts.md`, two playtest-fix rounds, release):

- **Lane E — companions, the stable, riding:** the follower (`pet-follower.ts`, `avatar.ts`), yard
  pets (`yard-pets.ts`, pure and vector-tested), the stable as one growing piece
  (`lib/stable-layout.ts`, `homestead-stable.ts`), stalls in `HomeView.stalls`, mount out/home ops
  (`link.ts:313-314`), the led mount (`led-mount.ts`) and the Saddle/Go home context buttons.
- **Lane F — the moves:** `content/abilities.json` + `lib/abilities.ts`, the level/class marks
  (`PlayerState.magic`), `lib/combat.ts` kits and `unlockNotice`, `lib/combat-moves.ts` (the
  Stand/Kindle/Echo field, pure), `hero.ts` F/R dispatch, `moves.ts` (draws your cast and a friend's),
  `Hud.svelte`/`TouchControls.svelte` second slot, reports' `ability_casts` and ward credit.
- **Lane G — fishing at the mill pond:** `lib/fishing.ts` (banks, bands, phases), `entities/fishing.ts`
  (Cast/Pull in/Reel/Keep/Let it go, reload, walk-away), `fish-cast/settle/cancel` ops
  (`link.ts:317-319`), the remote rod and float, and *A Line in the Race*.
- **Playtest fixes** (6692ba5, 998784d): the bay empties/fills with its mount, fewer homestead
  re-reads (one a second per land), a leave tells the land, Esc out of talk, Keep/Let go keys, tools
  that don't swing, the goal glow, gate signs.

## 2. Findings (payoff ÷ risk)

### F1. A friend's Ward-light heals `base × 0.4`; the world credits the caster's Mend × 0.4 (known item 1). M
**Evidence:**
- The friend's screen: `src/game/entities/moves.ts:43-44` `friendPulseHeal` = `HEAL_FORMULA.base ×
  fraction` (6 × 0.4 = **2.4**), used for every relayed ward at `moves.ts:185-188`.
- The caster's own screen: `src/lib/combat.ts:154` `wardPulseHeal = healAmount × fraction`, with
  `healAmount` the Mend formula (`combat.ts:138-140`, base 6 + INT bonus).
- The world: `server/internal/rules/magic.go:76` `WardPulseHeal = MendHeal(caster) × fraction`, and
  the hub credits exactly that per pulse.
- It cannot match today: `proto/glimway/v2/presence.proto:34` `PresenceAbility { ability, x, y,
  account_id }` carries no heal, so the receiver falls back to the base.
- `e2e/abilities.spec.ts:127` pins the wrong number in prose ("2.4 each").

**What a player sees:** a geared healer's Ward-light lifts a friend's bar by 2.4 a pulse while the
world grants up to `Mend × 0.4` (e.g. 6.4 at INT 60) — the friend keeps less than the spell gives,
the `+2` float disagrees with the design, and the unspent credit expires after 60 s. The caster's own
pulses are correct, so the same ward heals you and your friend by different amounts.

**Change:** one pulse-heal formula in `src/lib/combat-moves.ts` (pure, beside `wardPulseTimes`), used
by `hero.ts` and `moves.ts` alike; the cast carries the number — `PresenceAbility` gains
`double pulse_heal`, filled by the caster's client and **bounded by the hub to `MendHeal × fraction`
from the caster's profile** (server lane; that bound is what keeps it honest). `moves.ts:187` reads
the relayed number and falls back to `fraction × base` only for a cast that carried none.

**Guards:** a unit test pinning both screens to one formula (`tests/combat-moves.test.ts`), the
two-player spec asserting the friend's `+N` equals the caster's Mend × 0.4
(`e2e/abilities.spec.ts:138`), `server/internal/api/presence_abilities_test.go`.

### F2. Camera rounding: objects round individually, the screen never does (known item 3: sub-pixel jitter). S
**Evidence:**
- `src/game/main.ts:25` `roundPixels: true` rounds **each object's** draw position; the follow rounds
  the scroll to whole **world** px (`WorldScene.ts:423` `startFollow(hero, true, 0.12, 0.12)`).
- Zoom is fractional: `src/game/viewport.ts:68` half steps of CSS px and `:97` quarter steps, both
  multiplied by `canvasRatio()` — on a 1× display a world px is 1.5 or 2.5 device px (and 0.75-odd at
  a 1.5× ratio), so no integer world scroll lands on whole screen pixels. Tile seams and sprites then
  snap differently frame to frame while the camera pans: shimmer on all the pixel art.
- Ad-hoc rounding already shows the confusion: the led mount rounds (`led-mount.ts:130`) while the
  hero walks on fractions, and `WorldScene.ts:689-690, 994` round the hero only for saves.

**Change:** snap the camera to whole **device** pixels, not whole world px: in `WorldCamera.keepFramed()`
(`world-camera.ts:76`, called every frame at `WorldScene.ts:597`) after the follow step,
`cam.setScroll(Math.round(scrollX*z)/z, Math.round(scrollY*z)/z)`, and pass `roundPixels: false` to
`startFollow` so its world-px rounding doesn't fight it. Optionally quantise `zoomFor`/`roomZoomFor`
to whole device px per world px (`z × r` an integer) so the grid itself sits on pixels at 1×.

**Guards:** `e2e/camera.spec.ts` (insets and framing), plus a small e2e that walks one tile and checks
`scrollX × zoom` stays integral; screenshot hashes in the art specs.

### F3. e2e: one-shot `expect` where the value is still settling (the race class that broke 0.5's CI twice). S–M
**Evidence:**
- `e2e/companions.spec.ts:138-139` — `expect((await remotes(page))[0].pet).toBeNull()` and
  `[0].led)` — single reads of presence state right after a poll on neighbouring fields; the same
  shape as the race CI found and fixed at `companions.spec.ts:272` (fd845aa).
- `e2e/companions.spec.ts:335` — `expect((await debug(page)).mountOut).toBe('Wolf-Base')` once, right
  after polling `riding`.
- `e2e/touch.spec.ts:114-116, 131-134` — samples `player.x`, waits 10 frames, asserts the exact same
  x: it passes only if the hero stopped within one sample window (a coasting frame flakes it).
- `e2e/fishing.spec.ts:93, 118-119, 165, 193, 265` and `e2e/abilities.spec.ts:39, 45` — single reads
  of `__fsFishing`/`__fsItems`/`__fsEnemies` right after actions (some after polls, some not).

**Change:** every read of game or server state that follows an action goes through `expect.poll` (or a
locator web-first assertion); for "the hero has stopped", poll over a window (the same value for N
frames) instead of two samples. Put a one-call `until(page, fn)` next to `waitGame` in
`e2e/helpers.ts` so the polled form is the easy form.

**Guards:** the suite itself; the two CI races (fd845aa) show what a miss costs.

### F4. The combat numbers live twice — client and server — with no shared vectors. S–M
**Evidence:**
- `content/vectors/backend.json` is replayed on both sides, but only for XP, sync, spend, welcome and
  mapping (`scripts/backend-vectors.ts:11-50`; `server/internal/rules/parity_test.go:141` replays
  exactly those). Nothing pins the heals or damage.
- The Mend formula is written twice: `src/lib/combat.ts:138-140` and
  `server/internal/rules/magic.go:56`, asserted separately in `tests/combat.test.ts:108-109` and
  `server/internal/rules/magic_test.go:79-88`. F1 is this drift, already realised.

**Change:** add a `Magic` vector set (MendHeal at several INT/level points, one ward's three pulses,
the report's HP bound) to `content/vectors/backend.json`, replayed by `rules/magic_test.go` and
`tests/combat.test.ts`; move `friendPulseHeal` out of the Phaser file into `lib/combat-moves.ts`.

**Guards:** `npm run vectors`, `tests/combat.test.ts`, `server/internal/rules/parity_test.go`.

### F5. The report barrier sends one report more than it needs (known item 2). S
**Evidence:** `src/game/link.ts:1465-1478` — `flushBarrier` settles the captured report (`:1466`) and
then **always** freezes and sends another (`sendReport(true)` → `ReportBook.capture(force)` at
`src/lib/api/reports.ts:204-213`, which captures "even with nothing new"), without looking at the
settled report's acknowledgment. Measured on `tests/helpers/link-rig.ts`: a periodic report followed
by a rest sends two byte-identical reports (seq 1, then seq 2 with the same hp/mana/casts); with a
captured report pending it sends three requests (the captured one twice, then the twin). Every rest,
home-rest, consumable (`link.ts:1731`) and profile sync (`link.ts:1610`) pays it.

**Change:** `flushBarrier` takes `noteLive()` first and short-circuits: if `!reports.due` and the last
acknowledgment is accepted, on the current basis (`ack.basis >= basis()`), return
`reports.barrier()` and send nothing; if the settled captured report's ack passes the same check,
return it. Force a fresh report only when the live state moved since the capture or the basis is old.
(Keep the `BARRIER_TRIES` retry for the stale-basis case.)

**Guards:** `tests/link-reports.test.ts` "4. barriers" with report *counts* asserted,
`tests/link.test.ts:521`; the change is small enough to review against those alone.

### F6. Go home walks the mount off screen even on your own land (known item 4, owner QOL). M
**Evidence:** `src/game/entities/avatar.ts:328-334` `sendHome()` → `led.walkOff()`;
`led-mount.ts:155-172` tweens the mount off the nearer screen edge and sets `homeward` to the
walk-out time; only when that timer expires does the bay fill (`src/lib/companions.ts:83-96`,
`stableNext` `:120-134`, armed by `src/game/entities/homesteads.ts:206-218`). A Go home on your own
land therefore shows your mount trotting into the void and standing empty in its stall for a beat.

**Change (where it goes):**
1. `avatar.ts:328` branches: on your own land (`parseHomeArea(this.deps.world.areaId)` gate equals
   `homesteadsFor(session).mine`), walk it home; elsewhere `walkOff()` stays as is.
2. `led-mount.ts` gains `walkTo(target, onArrive)` beside `walkOff()` — the same body tween and step
   bob, to a world point instead of off screen (it has no body, so no pathing).
3. The target: the stall's foot from `lib/stable-layout.ts` (`stableLayout`/`bayFront`, pure) at the
   placed stable's spot (`homestead-art.ts:409` already computes `bx, by`); `HomesteadLayer` exposes
   `baySpot(mount)` and WorldScene wires it into `AvatarVisual`'s deps (a `baySpot?: () => …` closure,
   like the other `XxxDeps` seams).
4. On arrival clear `homeward` for that key (or set it to the arrival time), so `stallsShown` and
   `stableNext` fill the bay as the mount steps in — `homesteads.ts:214-218`'s recheck already redraws.

**Guards:** `tests/companions.test.ts` + `tests/stalls-shown.test.ts` (arrival fills the bay), and
`e2e/companions.spec.ts:230` extended to walk the mount into the bay on your own land.

### F7. 0.6's seams: the wardrobe has no owned gear to list, and the purse has no gold. M
**Evidence:**
- `src/lib/habitica/client.ts:19` `USER_FIELDS` fetches `items.gear.equipped`, `items.gear.costume`,
  `items.pets`, `items.mounts` — but **not `items.gear.owned`**, so "every cosmetic you own" (the
  wardrobe's whole list, chosen like the Companions tab) has no source. The Companions picker works
  precisely because `pets`/`mounts` are fetched (`src/lib/companions.ts:39-50 groupBySpecies`).
- `src/lib/habitica/mapping.ts:223-244` and `types.ts:53-99` drop `stats.gp` (and silver): a gold
  purse has nothing to show. Both gaps are mirrored in `proto/glimway/v1/profile.proto`.
- Ready to reuse: costume/equipped rendering (`src/lib/habitica/avatar.ts:231-253`),
  `loadPresenceAvatar` (`avatar-render.ts:189`) and `PresenceAvatar` already carry
  `equipped`/`costume`/`use_costume` (`proto/glimway/v2/presence.proto:59-67`), and the picker pattern
  is two components (`CompanionsTab.svelte` 297 lines, `CompanionsPicker.svelte` 212) on one pure
  module (`lib/companions.ts`: grouping, search, the resolved choice with fallback at `:66-73`).

**Change:** 0.6's planning should add (a) `items.gear.owned` to `USER_FIELDS` → `HabiticaProfile.ownedGear`
→ the server's profile mapping; (b) `stats.gp` as `gold`; (c) one picker component extracted from
Companions (grid + species chips + search + "chosen here, Habitica's current first"), and a
server-resolved `wear` record modelled on `follow_pet` (chosen key, fallback to the equipped look,
presence carries it). Doing (c) first makes both features smaller.

**Guards:** `tests/habitica-mapping.test.ts` fixtures for owned gear and gp, `tests/companions.test.ts`
for the choice/fallback shape, and an e2e wardrobe picker that mirrors `e2e/companions.spec.ts:51`.

### F8. `link.ts` is the client's biggest file (2,255 lines) and 0.6 will add to it. M
**Evidence:** one class holds the typed operation table (`link.ts:313-380`), the outbox record, fence
and channel (`:800-1300`), the report pump (`:1330-1480`), ~30 domain calls (`:1480-1900`) and
lease/reconnect (`:1915-2050`). Its four core methods (`submit`, `sendHead`, `sendReport`, `adopt`)
interleave all of it; F5's fix touches the same lines.

**Change:** keep `Link` as the façade and extract, one PR at a time: the outbox bookkeeping (record,
fence, channel, expire/replay) → `src/lib/api/outbox-link.ts`, and the report pump (`sendReport`,
`sendReportNow`, `flushBarrier`) → `src/lib/api/report-pump.ts`. Both are node-testable the way
`reports.ts` is.

**Guards:** `tests/link.test.ts`, `link-reports`, `link-durability`, `link-failures`,
`link-companions`, `link-fishing` (~2,500 lines of rig-driven tests — the net is already under it).

### F9. Dead code: ~35 exports nothing references, and two retired stubs. S
**Evidence** (identifier scan over src/tests/e2e/scripts): `MoveId`, `SignatureId`
(`src/lib/combat.ts:29`), `bandAt` (`src/lib/fishing.ts:76`), `signatureMana`, `unlockedAbilities`
(`src/lib/abilities.ts:52,57`), `hasBuilding` (`src/game/buildings.ts:43`), `activeWildsRegion`
(`src/game/wilds/store.ts:142`), `parseWildsDefeat`, `parseWildsLantern` (`src/lib/api/parse.ts`),
`openLibrarySection` (`src/game/library-open.ts:16`), `resetLibraryCache` (`src/game/papers.ts:146`),
`designedSource` (`src/content/papers.ts:319`), `profileForState`, `hasProgress`, `decorWithin`,
`landRows`, `decoRise` and ~20 unused types. Retired stubs: `link.ts:1904-1911` `wildsDefeat`
(always `not-implemented`, TODO(D) at `:1907`) and `wilds/entities.ts:489-491` `reportDefeat` (returns
null "so the scene's fall path stays one call").

**Change:** delete them and the two stubs (fold `reportDefeat`'s call site into the scene's fall
call); add knip (or this scan) to `npm run verify` so the pile doesn't grow back.

**Guards:** `npm run typecheck`, `npm test`, knip.

### F10. Small duplications in the 0.5 code — the class that produced F1. S
**Evidence:** `MOUNT_FEET = { x: -6, y: 42.5 }` in `led-mount.ts:38` and again in
`homestead-stable.ts:34` ("as ./led-mount.ts"); the heal applied twice, differently —
`hero.ts:470-473` (Mend: sparkBurst + setVitals) and `moves.ts:206-213` (`mendHere`: `+N` float + sfx
+ setVitals); `moves.ts:187` re-defaults `pulseHealFraction` to `0.4`, a copy of
`content/abilities.json`'s number; `remote-players.ts:79` `HAND` recomputes the hero's hand offset
("as the hero's, ./avatar.ts:65").

**Change:** one `MOUNT_FEET` (with the companion-canvas math) in `lib/stable-layout.ts` or
`lib/companions.ts`; one `applyHeal(session, fx, at, amount)` used by both; read the fraction from
`abilityFor('ward-light')` with no literal default.

**Guards:** `tests/combat-moves.test.ts`, `tests/led-mount.test.ts`, `e2e/abilities.spec.ts`.

### F11. The UI's three big files are each a whole subsystem. M
**Evidence:** `InventoryPanel.svelte` 1,430, `App.svelte` 1,335, `Hud.svelte` 1,255,
`ConnectGuide.svelte` 1,026 lines. `App.svelte` mixes the bus wiring (`wireBus` `:151-350`), the
journey/goal line, connected play and logout (`:455-564`), panel toggling, global keys (`:589-638`)
and emotes; `Hud.svelte` mixes the goal needle, chips, gains, action bar and the touch cluster.

**Change:** split along the seams the comments already mark: App's connected-play block → its own
module/component; Hud's action bar + touch cluster → `ActionBar.svelte`; InventoryPanel's shop and
crafting sections → panels. One file per PR (the e2e spread below is the net).

**Guards:** `e2e/inventory.spec.ts`, `e2e/touch.spec.ts`, `e2e/camera.spec.ts` (insets come from
`play-insets.ts` measurements), `e2e/onboarding-layout.spec.ts`.

### F12. Slow specs and waits on real time. S
**Evidence:** `e2e/fishing.spec.ts:104` sleeps 8.5 real seconds to clear the eight-second re-cast
refusal (the same suite moves the dev clock at `:161-163` — the refusal window is clock time too);
`e2e/abilities.spec.ts:126-129` sleeps 4.5 s to prove a far ward healed nobody — a negative check
after a fixed wait, slow and passable by accident; `e2e/whats-new.spec.ts:54,60` sleep 3 s + 2.5 s to
give the card a chance to come back; `e2e/companions.spec.ts:110` the same at 1 s. Fishing's casts
wait real bite times (`castAndWait` → `waitGame(..., seconds: 20)`), and three specs carry
`test.setTimeout(150_000)` or more (`abilities.spec.ts:21`, `fishing.spec.ts:83`,
`companions.spec.ts:231` at 300 s).

**Change:** move the dev clock where the rule is time-based (the refusal window, the ten-minute hold);
for "nothing happened" checks, assert on the thing that *would* have appeared (the heal float, the
`allyHeal` on the next report) instead of waiting a window out. `moveServerClock` is already in the
suite's toolbox.

**Guards:** CI wall time; keep the slowest specs' durations visible in the log.

### F13. Coverage gaps for 0.5. S
**Evidence:** a friend's Stand, Kindle and Echo are drawn by `moves.ts:170-204` but only the ward is
e2e-covered (`abilities.spec.ts:112-137`); riding's refusals and toasts (`avatar.ts:282-308`: no stable,
no mounts, indoors, the village) are untested — `companions.spec.ts:230` covers the happy path only;
nothing pins the fishing bands or shared depletion client-side (`lib/fishing.ts`'s `bandAt` is
itself dead, F9); and the ward credit's "spend only what the HP rise needed" (crafts.md 4.4) has no
client-visible test.

**Change:** one remote-cast e2e (`__fsEmit('game:ability-cast', …)` is already the relay seam,
`abilities.spec.ts:120`), a short riding-refusal test beside `companions.spec.ts:230`, and a
`tests/fishing.test.ts` band vector (the module is pure).

**Guards:** those tests.

## 3. Keep as is
- **`XxxDeps` with lazy closures and entities that never import the scene** — the 0.5 files
  (`fishing.ts`, `moves.ts`, `avatar.ts`, `homestead-stable.ts`) all follow it. F6's `baySpot` should
  be another closure in the same shape.
- **Pure rules in `src/lib` with node tests**: `lib/combat-moves.ts`, `lib/stable-layout.ts`,
  `lib/yard-pets.ts`, `lib/companions.ts`, `lib/fishing.ts`, `lib/reports.ts` — 1,768 tests in ~10 s
  is the best thing in this worktree. F4 and F10 move *more* code into this shape.
- **The predictor's contract** (`lib/api/predict.ts` header: "A predictor may be wrong; a rule may
  not"), the immutable captured report (`lib/api/reports.ts`), and the outbox's "persist before it
  counts" discipline (`link.ts:930-958`) — the rollback story is sound and well tested.
- **`FsHooks` in `dev-hooks.ts`**, DEV-only and scene-scoped, imported as a type by `e2e/`.
- **The e2e harness**: `connected.ts`, `helpers.ts` (`waitGame`, `expectToast`), `home-helpers.ts`,
  the fake Habitica and the dev clock. New specs should keep using it rather than re-rolling waits.
- **`CompanionsTab`/`CompanionsPicker` + `lib/companions.ts`** — the model for F7's wardrobe.

## 4. Cross-area notes
- **Server (the other reviewer's lane):** F1 needs `PresenceAbility.pulse_heal` and a hub-side bound
  (`MendHeal(caster) × fraction`) — without the bound the friends-on-invites model gets worse (a
  modified client could heal friends arbitrarily); F7 needs the profile mapping to pass `items.gear.owned`
  and `stats.gp` through. F5 is client-only. The hub's ward credit itself
  (`server/internal/api/presence_abilities.go`) matches crafts.md 4.5 as built.
- **Content:** `content/abilities.json`'s `pulseHealFraction` is copied as a literal at
  `moves.ts:187` (F10); `content/combat.json`'s `heal` is the single source for the formula and
  should feed F4's vectors.
- **Tooling:** jscpd, madge and knip were run ad hoc for the 2026-10-07 review and are not in
  `package.json`; adding knip (or the scan behind F9) to `npm run verify` is the cheapest way to keep
  the dead-code finding from recurring. The e2e suite's wall time is not measured anywhere (F12).

## 5. Proposed order
Each step is one reviewable PR.

1. **F1 + F4 together** — one heal formula in `lib/combat-moves.ts`, magic vectors on both sides, then
   the relayed `pulse_heal` (client change first behind the fallback, hub bound in the server lane).
   This is the only player-facing bug in the list.
2. **F2** — the camera snap in `world-camera.ts`/`WorldScene.ts:423`; small, visible everywhere.
3. **F5** — the barrier short-circuit in `link.ts:1465`, against report counts in `link-reports.test`.
4. **F3 + F12** — the e2e pass: polls where values settle, dev clock instead of sleeps. Cheap, and it
   de-risks every later lane's CI.
5. **F9 + F10** — pure deletion and de-duplication.
6. **F6** — the owner's Go home QOL (drawing + timing, no server change).
7. **F7** — 0.6's seams, starting with the shared picker extraction so the wardrobe lands on it.
8. **F8, then F11** — the `link.ts` extractions, then the UI splits; one file per PR, tests green
   between each.
