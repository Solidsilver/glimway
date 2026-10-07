# The lantern road: state and quest contract

How the first quest's state, quest machine and defeat rule fit together, as
the code has them now. The source is the reference; this page says where to
look and which ids must never change. Saves (format 2), the Habitica import
and health are in [import-contract.md](import-contract.md); the server's
side is in [home-server.md](home-server.md).

(This page used to be the milestone-2 agreement between the "shared-logic"
and "runtime" agents. That version described the warden as a combat
encounter and is in git history.)

## Modules

| Module | What it owns |
|---|---|
| `src/lib/state.ts` | `GameState`, `createNewGame`, `validateSave`, the quest machine (`advanceQuest`, `questObjective`, `questShortGoal`), `recoverFromDefeat` |
| `src/content/world.ts` | dialogue (`dialogueFor`), journal (`journalEntries`), place names (`locations`, `areaInfo`), `DEMO_CHARACTER` |
| `src/lib/save.ts` | the local save (one queue, corrupt records never overwritten silently): see import-contract.md |
| `src/lib/habitica/sync.ts` | imported vitals, syncs and `resolveDefeatRecovery` |
| `src/game/session.ts` | the running game's state; it applies quest events and saves |
| `src/game/entities/enemies.ts` | the stone warden |

Tests: `tests/state.test.ts`, `tests/world.test.ts`, `tests/save.test.ts`,
`tests/save-v2.test.ts`; the e2e `quest.spec.ts` plays the whole road.

## Quest stages and events

The ids are stored in saves and on the server: keep them, even where the
story has moved on (no guardian is defeated any more; the warden is settled).

Stage order: `new → accepted → clue-found → guardian-defeated → lantern-lit → complete`.

| Event | From | Fired by | Adds |
|---|---|---|---|
| `accept` | `new` | Mara's dialogue | |
| `find-clue` | `accepted` | the route stone's dialogue (`clue`) | item `lantern-route-rubbing`, discovery `old-route-marker` |
| `defeat-guardian` | `clue-found` | the warden settling (below) | item `warden-seal`, defeated `stone-warden` |
| `light-lantern` | `guardian-defeated` | the hilltop lantern's dialogue (`lantern`) | discovery `hilltop-lantern` |
| `return-village` | `lantern-lit` | Mara's dialogue | discovery `lantern-road-restored` |

- `advanceQuest` is immutable and throws on any event that isn't the legal
  next one. A dialogue's `event` is applied once, after the player finishes
  the dialogue; dialogue never carries an illegal event.
- The restored village keys off `quest === 'complete'` or the discovery
  `lantern-road-restored`.
- Quest dialogue ids: `mara`, `pip`, `orrin`, `clue`, `lantern`.
  `dialogueFor` throws on an unknown id.

## The warden is settled, not fought

Blows don't hurt it. After each lunge it stops to find its feet, and a hero
in reach can speak the naming to its heart-lamp (E or Space; **Speak** on
touch). After `WARDEN.speakings` speakings (3) it settles into its pose for
good, and the game fires `defeat-guardian`. It is always on its path in the
ruin: dormant in its pose before the clue, awake at `clue-found`, settled
from `guardian-defeated` on. In a shared world, a player standing by when
someone else settles theirs keeps a "witness" journal line
(`src/content/witness.ts`).

## Defeat

`recoverFromDefeat(state)` is the guest rule: back to the Hearthwick spawn
with full health and mana, keeping the quest stage, items, discoveries,
defeated enemies and play time. Imported (Habitica) vitals don't refill:
`resolveDefeatRecovery` in `src/lib/habitica/sync.ts` caps them by the last
imported values and `IMPORTED_RECOVERY`. Details in import-contract.md.

## New game

`createNewGame()` starts in `village` at `{ x: 400, y: 300 }`, quest `new`,
40 HP, 20 mana, with the field journal and the Hearthwick map in the pack.
