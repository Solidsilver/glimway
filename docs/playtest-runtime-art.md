# Runtime-art playtest — NPC breathing, guardian poses, class FX (October 3, 2026)

Tester: snap_runtime via Playwright (Chromium) against the dev server
(localhost:5173) and the production preview (localhost:4173). Movement and
combat were driven with **real keyboard presses (held keys, 60–150 ms) and
touch-control taps**. Class/guardian encounters were staged efficiently with
**valid format-2 save documents pasted into the Character panel's "Restore
from code" box** (warrior/mage/rogue/healer profiles with plausible effective
stats and cached gear keys; a ruin document at quest `clue-found` for the
guardian) — no real credentials, no Habitica calls. `__fsPlayer` /
`__fsEnemies` / `__fsSafety` / `__fsDebug` are read-only handles (positions,
hp, texture keys, anim keys, body sizes, tint — nothing mutated); the enemy
handle gained `texture`/`body`/`flipX`/`tint` and `__fsDebug` gained the NPC
texture/anim list for this pass (read-only additions).

Verify status at time of writing: `npm run verify` green — typecheck clean,
svelte-check 0/0, **140/140 tests pass**, production build succeeds (also
independently re-run by the coordinating root).

## Boot wiring (dev + production)

| Check | Result |
|---|---|
| `preloadRuntimeArt` in BootScene.preload (3 source PNGs + manifest JSON) | ✅ no console errors; all four files served (200) |
| Native helper runs after fallback `generateTextures`, aliases replaced before World starts | ✅ `createRuntimeArt` → `installRuntimeAliases({ replaceExisting: true })` → `scene.start('World')` |
| Alias replacement | ✅ `mara/pip/orrin/guardian0/guardian1/slash/bolt` resolve to delivered native art (e.g. the warrior's basic slash renders the delivered crescent, see warrior-slash-alias.png) |

## NPC breathing (Mara / Pip / Orrin)

| Check | Result |
|---|---|
| Native 16×16 textures + breathing anims (2 frames, 1.5 fps, looping) | ✅ `__fsDebug().npcs` shows `*-idle-0` textures playing `*-breathing`; later samples catch `*-idle-1` — frames cycle |
| Bob removed, feet planted | ✅ pixel-diff of two frames 700 ms apart (1.5 fps period ≈ 667 ms): 513 px change confined to the torso bbox; the pose cycle A→B→A is exact (0 px diff on the repeat); the diff region ends above the foot line — **no bob, stable feet** (npc-breathing-poseA/B.png) |
| Fallback preserved | code path keeps the old static image + bob tween when the pack is absent (not re-playtested; code-reviewed only) |

## Guardian encounter (stone warden, ruin — warrior fixture)

| Check | Result |
|---|---|
| Quest-driven spawn on native art | ✅ spawns at `clue-found`; `guardian-idle` texture; **authored foot body 20×10 at offset (2,14)** stable across every pose (enemy handle readings), flipX mirrors with direction (source faces right) |
| Discrete state poses — never a loop | ✅ full cycle traced with 70–90 ms sampling: chase→`guardian-idle`, telegraph→`guardian-windup`, lunge→`guardian-lunge`, recover→`guardian-idle`; each pose appears exactly with its state (guardian-windup-full.png: coiled; guardian-lunge-full.png: stretched leap) |
| Hurt pose on hit, state untouched | ✅ non-lethal hits flash `guardian-hurt` (~160 ms) then restore the state pose; trace: idle → hurt (hp 44→31) → idle with `state: 'chase'` unchanged throughout; lunge in progress is never cancelled (production-guardian-hurt.png) |
| Telegraph tell survives hits | ✅ hit during windup: damage tint `0xffe0d0` → after the 90 ms timer the tint is **re-applied `0xd0e8ff`** while still telegraphing (was a regression found in review; fixed) |
| Defeat: death pose held through dissolve, no stale timers | ✅ killing blow → `guardian-defeat` pose visible mid-dissolve with spark motes + "The shade dissolves into motes of light." toast; pose selector early-returns on dead; quest objective flips to "Light the hilltop lantern…" (`defeat-guardian` applied once) (guardian-defeat-dissolve.png) |
| Corpse freeze (mid-lunge kill) | ✅ killed DURING a lunge: dissolve screenshots + pixel diff show the corpse staying in place (140 ms apart: only the mote cluster changes, bbox 137×134 px around the death spot) — the pre-fix behavior (body velocity carried into the tween, ~80 px slide) is gone (corpse-dissolve-1/2.png) |

## Class FX (all four kits, staged with fixtures)

| Class | Basic | Signature |
|---|---|---|
| Warrior | ✅ static aliased slash renders the delivered cleave-peak crescent, rotated to facing with `atan2` (slash-up-cardinal.png: up-attack is a true vertical arc — the old ±45°/flip heuristic is gone) | ✅ animated `effect-cleave` one-shot (12 fps), canvas centered on the attacker per pack README, hit check/reach/timing unchanged; kill verified (wisp died); mana read 46→39 = cost 12 plus ~5/s observed regen (cleave-centered.png) |
| Mage | ✅ animated `effect-magic-bolt` loop in flight, rotated to travel direction; hit verified (wisp 10→1.57 hp, str-10 kit damage 8.43) (mage-bolt-hit.png) | ✅ signature bolt shares the projectile path; mana read 90→80 = cost 15 plus observed regen (mage-bolt-in-flight.png) |
| Rogue | ✅ melee stab via static alias (same pipeline as warrior basic) | ✅ Shadowstep dash + delivered `effect-dash-trail` one-shot at the emission point, rotated along the dash; trail streak visible at the rogue's feet; strike logic unchanged (rogue-dash-trail.png) |
| Healer | ✅ melee tap via static alias | ✅ `effect-healing-pulse` ring centered on the caster; pulse killed a wisp in reach AND healed (hp 22→29 net of contact damage, heal +13 per int-30 kit; mana read 60→46 = cost 18 plus observed regen) (healer-pulse-mid.png) |

All one-shot effects destroy on `animationcomplete`; bolts are destroyed on
hit/expiry by the existing `updateBolts` — no leftover sprites observed in any
post-action frame. Effect art never defines hit areas or radii.

## Production preview (built bundle, localhost:4173)

✅ Full guardian encounter on the production bundle: restore → spawn on
`guardian-idle` (20×10 body) → hurt pose on hit (31/44 bar visible) → windup →
lunge, plus the centered cleave FX (mana 46→34 = cost 12 plus observed regen).
Screenshots:
production-guardian-hurt/lunge/windup.png, production-cleave.png.

## Phone layout (390×844)

✅ Viewport renders correctly: HUD, quest text, delivered art, D-pad +
"Action"/"Cast ability" buttons all present (phone-runtime-art.png). Single
taps on the pads register without breaking the world; NPCs keep breathing
(texture samples caught `*-idle-1` mid-cycle on the phone viewport).
**Touch press-and-hold driving is UNVERIFIED in this pass** — repeated
pointer-hold attempts timed out in the automation bridge (see limits).

## Honest limits

- **Touch holds unverified**: the MCP pointer bridge timed out on
  press-and-hold repeatedly (single taps fine). The M3 pass verified real
  touch driving end-to-end (docs/playtest-m3.md); no touch code was changed
  in this pass.
- **Guardian hurt-pose screenshot timing**: the hurt pose is a 160 ms window;
  two capture attempts missed the frame (camera-clamped fight at the ruin's
  west edge; one misleading blank was deleted). The pose is verified by
  runtime traces (texture/state sampling above) and by the production hurt
  screenshot; a clean dev-server hurt close-up was not captured.
- **Camera bounds clamping** at the ruin's west edge is stock Phaser behavior
  (544 px world vs ~426 px view at zoom 3): the player legitimately renders
  left-of-center near the wall. Two early screenshots were framed assuming a
  player-centered camera and missed the fight; they were deleted and
  re-captured.
- Damage numbers observed in-world (13/26 crit slash, 17 cleave, 8.43 bolt,
  13 heal, wisp/guardian contact) match the unit-pinned kits in
  tests/combat.test.ts; heal/crit randomness means individual runs vary.
- Fixtures were staged via the normal Restore UI only; no save files were
  hand-edited on disk and no production code paths were bypassed.

## Screenshots

docs/screenshots/runtime-art/: npc-breathing-poseA/B, warrior-slash-alias,
slash-up-cardinal, cleave-centered, mage-bolt-hit, mage-bolt-in-flight,
rogue-dash-trail, healer-pulse-mid, guardian-encounter-full,
guardian-windup-full, guardian-lunge-full, guardian-defeat-dissolve,
corpse-dissolve-1/2, production-guardian-hurt/lunge/windup,
production-cleave, phone-runtime-art.
