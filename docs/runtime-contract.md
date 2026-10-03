# Fingersnap runtime contract

Source of truth for shared logic between the runtime (Phaser/Svelte scaffold)
and the state/content/persistence modules. Runtime-owned integration notes
(assets, scenes) live in `docs/runtime-asset-spec.md`; this file covers the
`src/lib/` and `src/content/` API surface.

## Ownership

| Path | Owner |
|---|---|
| `src/lib/`, `src/content/`, `tests/`, `docs/`, `ASSETS.md` | shared-logic agent (this file) |
| scaffold, `package.json`, build config, `src/game/`, App/styles, `docs/runtime-asset-spec.md` | runtime agent |

Do not edit across the boundary. Change requests to the shared API go in this
file's "Open questions" section.

## Module API

### `src/lib/state.ts`

```ts
type AreaId = 'village' | 'woodland' | 'ruin';
type QuestStage = 'new' | 'accepted' | 'clue-found' | 'guardian-defeated' | 'lantern-lit' | 'complete';
type QuestEvent = 'accept' | 'find-clue' | 'defeat-guardian' | 'light-lantern' | 'return-village';

interface GameState {
  version: 1;
  area: AreaId;
  position: { x: number; y: number };
  quest: QuestStage;
  hp: number; maxHp: number; mana: number; maxMana: number;
  inventory: string[]; discoveries: string[]; defeatedEnemies: string[];
  playSeconds: number;
}

createNewGame(): GameState
validateSave(data: unknown): GameState          // throws InvalidSaveError
advanceQuest(state: GameState, event: QuestEvent): GameState  // immutable, throws on illegal step
questObjective(stage: QuestStage): string
recoverFromDefeat(state: GameState): GameState  // demo-only defeat rule, see below
```

Also exported: `AREAS`, `QUEST_STAGES`, `QUEST_EVENTS`, `SAVE_VERSION`,
`InvalidSaveError`.

`validateSave` strips unknown fields on success and throws `InvalidSaveError`
with a field path on failure. Never store or forward the raw input; use the
returned object.

### `src/lib/save.ts`

```ts
loadGame(): Promise<GameState | null>            // null = no save; throws CorruptSaveError on corrupt record
saveGame(state: GameState, options?: { overwriteCorrupt?: boolean }): Promise<void>
exportSave(state: GameState): string             // portable JSON; credentials can never appear
importSave(json: string): GameState              // throws InvalidSaveError on oversized/malformed/invalid
clearSave(): Promise<void>                       // explicit discard only
```

Also exported: `CorruptSaveError` (has `.raw` for recovery UI),
`MAX_IMPORT_LENGTH` (200,000 chars).

Behavior the runtime must respect:

- All reads/writes are serialized through one queue. Fire `saveGame` freely;
  the last queued write wins and races cannot produce a stale final record.
- A corrupt stored save is **never silently overwritten**. `loadGame` throws
  `CorruptSaveError`; `saveGame` refuses (same error) until the player
  explicitly confirms, which passes `{ overwriteCorrupt: true }`. Offer an
  "export raw save" recovery action via `err.raw` and an explicit
  `clearSave()` before starting a new game.
- `exportSave`/`importSave` accept only known GameState fields. Credentials
  must stay out of GameState entirely.
- `importSave` accepts either the exported document (`{kind:'fingersnap-save',...}`)
  or a bare `GameState`.

### `src/content/world.ts`

```ts
dialogueFor(npcId: string, stage: QuestStage): { speaker: string; lines: string[]; event?: QuestEvent }
journalEntries(stage: QuestStage): { title: string; body: string }[]   // cumulative
locations: Record<AreaId, { name: string; description: string }>
DEMO_CHARACTER: { name: string; class: string; level: number; stats: { str; int; con; per } }
```

## NPC and interaction ids

Exactly these five ids (agreed with runtime):

| id | Role | Speaker label |
|---|---|---|
| `mara` | Quest giver, village square | Mara |
| `pip` | Courier child, village | Pip |
| `orrin` | Retired carpenter, village | Orrin |
| `clue` | Route-marker stone in the ruin | Route Marker |
| `lantern` | Hilltop lantern shrine | Hilltop Lantern |

Unknown ids throw. All five have dialogue at every quest stage.

## Quest machine: who fires what

Stage order: `new → accepted → clue-found → guardian-defeated → lantern-lit → complete`.

| Event | Legal from | Fired by | Trigger |
|---|---|---|---|
| `accept` | `new` | dialogue | `dialogueFor('mara','new')` |
| `find-clue` | `accepted` | dialogue | `dialogueFor('clue','accepted')` |
| `defeat-guardian` | `clue-found` | **runtime encounter** | guardian defeated (combat/story encounter; no dialogue id owns this) |
| `light-lantern` | `guardian-defeated` | dialogue | `dialogueFor('lantern','guardian-defeated')` |
| `return-village` | `lantern-lit` | dialogue | `dialogueFor('mara','lantern-lit')` |

Rules:

- When a returned dialogue has an `event`, apply it once via `advanceQuest`
  after the player finishes the dialogue. Dialogue never carries an event
  that is illegal for its stage; `complete` dialogues carry no event.
- `advanceQuest` also records side effects: `find-clue` adds inventory
  `lantern-route-rubbing` + discovery `old-route-marker`; `defeat-guardian`
  adds inventory `warden-seal` + defeated enemy `stone-warden`;
  `light-lantern` adds discovery `hilltop-lantern`; `return-village` adds
  discovery `lantern-road-restored`. Journal titles/bodies are content-owned;
  these ids are stable.
- The lantern-restored village change is keyed off `state.quest === 'complete'`
  or discovery `lantern-road-restored`.

## Areas and spawn

- Areas: `village` (Hearthwick), `woodland` (Brackenwood Path), `ruin`
  (Ashwatch Ruin) — see `locations` for display text.
- Fresh-game spawn: `area: 'village'`, `position: { x: 400, y: 300 }`. The
  runtime may treat this as map-relative and override after map authoring;
  keep `createNewGame()` values as the canonical default.

## Demo defeat rule (demo-only)

`recoverFromDefeat(state)`: return to `village` spawn, restore `hp` to `maxHp`
and `mana` to `maxMana`, **keep** quest stage, inventory, discoveries,
defeated enemies, and play time. This is the milestone-2 local rule only.
Imported-Habitica health reconciliation, low-HP difficulty, and the final
defeat/recovery design are deferred (see Fingersnap Plan, Health and mana).
Do not apply this rule to any future imported-health state without the
reconciliation design.

## Quest objective text

`questObjective(stage)` returns the current objective string for UI display.
Treat the returned string as display content owned by `src/lib/state.ts`.

## Persistence expectations for the runtime

- Save at meaningful transitions (dialogue events, area transitions, defeat
  recovery, every 30–60s of `playSeconds` accumulation is fine); `saveGame`
  is cheap and queued.
- Update `playSeconds` in the state you save (accumulate real elapsed time).
- On boot: `loadGame()` → `null` means offer "New game"; `CorruptSaveError`
  means show the recovery UI; success means resume.
- Demo mode makes **no** Habitica requests and needs no credentials. Keep any
  future adapter behind an explicit disabled flag.

## Tooling notes for the runtime agent

- Tests: `node --test tests/*.test.ts` (Node 22.6+/26 built-in type stripping;
  no test dependency, no package.json change needed). Currently 35/35 pass.
- Source and test imports use explicit `.ts` extensions (Node ESM + type
  stripping). TypeScript needs `allowImportingTsExtensions: true` with
  `noEmit` (Vite builds fine either way).
- `src/lib/save.ts` uses DOM `IDBFactory` types (needs `"DOM"` in `lib`).
- `tests/helpers/fake-indexeddb.ts` is a test-only IndexedDB stand-in; do not
  import it from app code.

## Open questions

- Map-space meaning of spawn `position {x:400, y:300}` once real maps exist.
- Whether `playSeconds` is owned by a Phaser time accumulator (recommended) or
  the Svelte interface layer.
- Guardian encounter shape (simple story interaction vs early combat); either
  must call `advanceQuest(state, 'defeat-guardian')` exactly once.
