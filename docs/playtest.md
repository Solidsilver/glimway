# Fingersnap demo playtest — October 2, 2026

Tester: game-runtime agent, via Playwright (Chromium) against the dev server.
Movement, interaction, and combat were driven with **real keyboard events**
(held arrow keys, E, Space, F) and real touch-button presses on the emulated
phone. The debug handles `__fsPlayer` / `__fsEnemies` are **read-only**
(positions/body state) and were used for navigation and assertions only — no
quest stages, vitals, or save data were ever injected.

## Result: full quest playthrough, keyboard-only ✅

A single fresh run ("New journey") completed the entire quest:

| Step | Result |
|---|---|
| Title → New journey → world boots | ✅ textures/atlases load, no console errors |
| Walk to Mara, E opens dialogue (typewriter) | ✅ prompt "Talk to Mara" appears in range |
| Advance dialogue → quest accepted | ✅ objective changes to Brackenwood |
| West gate → Brackenwood Path (fade transition) | ✅ area toast, correct west entry |
| Woodland wisps: melee + bolt combat | ✅ wisps deal damage; leash tune applied |
| East exit → Ashwatch Ruin | ✅ |
| Mural in alcove → clue dialogue → discovery | ✅ stage clue-found; warden spawns once (announce gated) |
| Stone warden real-time fight | ✅ won with melee + telegraph-retreat at 18→34 HP; objective advanced |
| Shrine lantern → light it | ✅ stage lantern-lit, additive glow over the shrine |
| Return west through Brackenwood | ✅ |
| Home → Mara's "the light is back" dialogue | ✅ fires return-village → stage complete |
| **Village lantern glowing by the well** | ✅ persistent visible change |
| Reload → "Continue journey" | ✅ stage/area/HP restored exactly; reload never healed |
| Phone 390×844 (touch emulation) | ✅ d-pad + A/✦ buttons visible and drive the hero; HUD/dialogue readable with safe-area insets |

Screenshots in `docs/screenshots/`: desktop-title-save, desktop-village,
desktop-dialogue, desktop-guardian, desktop-lantern-lit, desktop-complete,
desktop-reload-resume, phone-village.

## Defeat recovery (observed live)

Two early attempts at the warden (entered at 14–16 HP) ended in defeat: the
player woke in Hearthwick at full vitals with quest stage, discoveries, and
defeated-enemy data kept — the demo-only recovery rule behaving as specified
(labeled in-game as demo recovery; real Habitica health rules deferred).
Damage, position, and enemy defeats persisted across every reload.

## Bugs found & fixed during playtesting

1. Ground blitter ignored the terrain sheet row stride (dark voids for tiles ≥
   row 1) — fixed; per-tile row/col mapping corrected.
2. Hero/enemy Arcade bodies were set in world units on scaled sprites →
   sub-pixel bodies floating at the sprite's head (bridge impassable, phantom
   blocks). Bodies now expressed in **source pixels** (verified against Phaser
   source: `setSize`/`setOffset` are source units, offset is scaled).
3. Village→woodland entry landed on the woodland's east side (beside the ruin
   exit) — moved to the west entry matching the corridor geography.
4. Random scatter props could (and did) land inside 1-tile exit mouths and on
   the village entry — props now filtered out of exit-adjacent tiles; bench and
   milestone moved off walking lanes.
5. Warden announce toast could re-fire on re-entry (spawn path also announced)
   — announce now only on the find-clue transition; respawns silent.
6. `return-village` auto-fired on village entry, bypassing Mara's lantern-lit
   dialogue — removed; the transition belongs to her dialogue event per
   docs/runtime-contract.md.
7. Touch A-button repeat could re-open dialogue immediately after closing —
   scene now honors the post-dialogue `blockedUntil` grace window.
8. Discovery id mismatch ('clue-mural' vs shared 'old-route-marker') — unified.
9. `ground-<area>` texture key reuse error on area re-entry — proper per-area
   key removal.
10. New-journey race: the discarded session's final save could land after the
    fresh save — `Session.destroy(skipSave)` + immediate save of the new game.

## Cozy tuning applied (from playtest evidence)

- Wisp: contact 2→1, aggro radius 120→90, chase 52→40, HP 12→10.
- Warden: HP 60→44, contact 3→2, lunge 4→3, lunge speed 300→250, telegraph
  0.55s→0.65s, cooldown 2.6s→3.2s. Player attack 6→8, iframes 0.9s→1.1s.
- Village rest regen ~1.2 HP/s (full recovery observed during the return walk).

## Known quirks (non-blocking)

- Under Vite HMR the App remount can double-register bus listeners for a
  moment (duplicate toast) — production runs mount once; verified single-fire
  on a clean page load.
- Content said the Brackenwood path lies "north" of the village while the demo
  map places it west — **fixed** (all 5 "north gate" mentions in
  `src/content/world.ts` now say "west gate").
- Phone dialogue was verified for layout/readability; the full quest was
  keyboard-driven on desktop (touch drive to Mara within camera reach is
  fiddly for an automated driver, not for a human thumb).
