# Runtime review (read-only) — quest/save/pause/touch bugs

Reviewer: shared-logic agent (`snap_state`). Scope: `src/game/`, `src/App.svelte`,
`src/ui/`. No files edited; browser owned by `snap_runtime`. Findings are
prioritized real bugs only.

## F1 (high) — Guardian spawn toast fires twice after the clue

Repro: study the mural in the ruin → toast *"The air goes cold…"* (#1) →
any scene restart while still at `clue-found` in the ruin (leave+re-enter,
reload, or die and walk back) → the same toast again (#2).

Cause — two spawn paths and no persistence of "already announced":

- `WorldScene.ts:620` — `onDialogueClosed` calls `spawnGuardian()` on
  `find-clue` → toast.
- `WorldScene.ts:383-385` — `buildEnemies()` (every `create()`) spawns again
  whenever `ruin && quest === 'clue-found'` → toast.
- `WorldScene.ts:122` — `init()` resets `guardianSpawned = false` on every
  restart, so the guard only protects within one scene view.

The second spawn also gives the warden full HP again after a death, which is
demo-defensible; the repeat **toast** is the bug. Fix: announce once per save
(e.g. `session.recordDiscovery('warden-appeared', …)` gate, or persist the
spawn flag in GameState discoveries) and/or skip the toast when
`state.defeatedEnemies`/quest already implies the encounter is known.

Related listener-duplication risk (same symptom class, lower certainty):

- `App.svelte:57-76` — `wireBus()` registers six `bus.on(...)` handlers in
  `onMount` and **never unsubscribes** (cleanup at 50-54 only stops the game).
  Any App remount / Vite HMR during a playtest doubles every handler: every
  toast renders twice (incl. the guardian toast), quest-objective toasts fire
  twice. The `visibilitychange`/`pagehide` listeners at 33-36 leak the same
  way. Fix: collect `bus.off` cleanups in the `onMount` return.

## F2 (high) — Corrupt save puts the game in a permanent save-failure loop

`App.svelte:44-48` treats every `loadGame()` rejection as "start fresh",
including `CorruptSaveError`. But `saveGame` (by contract) refuses to
overwrite a corrupt record, so the fresh session's saves then fail forever
("Saving failed — progress may not persist." every 350ms debounce/autosave).

Escape hatches exist in `src/lib/save.ts` but no UI uses them:

- `clearSave()` is never called (`CharacterPanel.resetDemo` uses
  `saveGame(createNewGame())`, which also refuses).
- `{ overwriteCorrupt: true }` is never passed.
- `CorruptSaveError.raw` (recovery export) is never surfaced.

Also `CharacterPanel.svelte:53` (`applyImport`) and `:63` (`resetDemo`)
call `void saveGame(...).then(...)` with **no catch** — on rejection this is
an unhandled promise rejection and the button appears to do nothing.

Fix: catch `CorruptSaveError` separately on load; show recovery UI (export
`err.raw`, explicit clear via `clearSave()`, or `overwriteCorrupt` after
confirm); add `.catch` to both `saveGame` call sites and set `importError`.

## F3 (high) — `return-village` auto-fires on village entry, bypassing Mara

`WorldScene.ts:172-174`: `create()` applies `return-village` 600ms after any
village entry at `lantern-lit`. Per `docs/runtime-contract.md`, that event
belongs to `dialogueFor('mara','lantern-lit')`. Consequences:

- The "tell Mara the light is back" beat is skipped; the quest completes on
  a timer instead of on conversation.
- Mara's `lantern-lit` dialogue (which carries the event) becomes unreachable
  dead content; `journalEntries('lantern-lit')` beat is undercut.

Fix: drop the auto-fire and let the agreed dialogue event drive it (keep the
village-change visuals keyed off `complete`). If auto-complete is a
deliberate design change, update `docs/runtime-contract.md` and trim the
event from the dialogue in `src/content/world.ts` — currently both exist.

## F4 (medium) — Touch A-button repeat bypasses the post-dialogue grace period

`TouchControls.svelte:44-49`: holding A emits `EV.action` every 320ms.
`WorldScene.handleAction` (`WorldScene.ts:513-520`) checks `uiBlocked()` but
not `uiState.blockedUntil` (only `handleKeyboardActions` checks it, at
719-720). After the last dialogue line closes via the A button, the next
repeat tick immediately re-opens the same interaction or attacks — the
220ms grace set in `onDialogueClosed` is ignored on the touch path.

Secondary: one `EV.action` emission is handled by both `DialoguePanel.onAction`
(advance) and `WorldScene.handleAction` (open/attack); which runs first is
registration-order dependent, so a tap that opens a dialogue can also advance
it in the same tick.

Fix: check `blockedUntil` inside `handleAction`, and/or stop `actionRepeat`
while `uiState.dialogueOpen`.

## F5 (low) — Duplicate clue discovery id

`WorldScene.ts:617` records discovery `'clue-mural'`, while
`advanceQuest('find-clue')` (shared state) adds `'old-route-marker'` plus the
`lantern-route-rubbing` inventory item. One clue, two discovery ids. Align on
the shared id (`old-route-marker`) or accept both explicitly.

## Checked and not buggy

- Quest chain `accept → find-clue → defeat-guardian → light-lantern →
  (return-village)` gates correctly in `Session.applyQuestEvent`
  (stage-gated; repeated events no-op).
- Reload-as-heal is prevented (vitals decreases schedule saves; regen is
  intentional). Write queue serializes saves; `saveGame` validates input.
- `scene.restart` bus cleanup (`events.once('shutdown')` at
  `WorldScene.ts:164-169`) is balanced; the primary double-toast path is the
  respawn+re-toast in F1, not a leaked scene listener.
- Dialogue pauses movement/combat (`uiBlocked()` gates `update`); delta is
  clamped so background tabs don't jump. No further pause issues found.

## Suggested fix order

F1 + F3 (quest-facing), F2 (save integrity), F4 (touch), F5 (cleanup).
