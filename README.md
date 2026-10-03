# Fingersnap — first playable demo

A cozy, lantern-restoring web RPG demo. Svelte 5 + TypeScript + Phaser 3 + Vite.
Runs entirely in the browser. The demo adventure needs no accounts and makes no
network requests; optionally, you can connect a Habitica account **read-only**
(see below) to play as your own character.

Source of truth: [Fingersnap Plan.md](Fingersnap%20Plan.md). Demo scope:
[BUILD_KICKOFF.md](BUILD_KICKOFF.md).

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

```sh
npm run typecheck  # tsc --noEmit
npm run check      # svelte-check
npm run build      # production bundle in dist/
npm run preview    # serve the production build
npm run verify     # typecheck + check + build
```

## The demo adventure

Meet **Mara** in the village of Hearthwick, accept the lantern quest, follow the
**Brackenwood Path** (mind the wisps), find the clue in the **Ashwatch Ruin**,
overcome the **stone warden**, light the hilltop lantern — then return home and
see the village lantern glowing again.

- Three explorable areas with collisions, scene transitions, and NPCs
  (`mara`, `pip`, `orrin`) with stage-aware dialogue.
- Light real-time combat: melee attacks (E / Space) and a signature ability
  (F / ✦, costs mana). Telegraphed lunges on the warden. An imported
  character's class picks the kit — warrior slash + cleave, mage ranged bolt +
  fingersnap, rogue stab + shadowstep dash, healer tap + mending pulse — and
  its effective stats (gear and level included) drive the numbers with bounded
  diminishing returns for extreme imports.
- Quest journal, character sheet, and dialogue in Svelte; the frame loop and
  world stay in Phaser. They talk through a small event bus of meaningful
  state changes only.
- Saves are versioned, local (IndexedDB), with clipboard export/import of save
  codes — no credentials inside saves.
- HP, mana, position, quest stage, and defeated enemies persist across
  reloads. Reloading is **never** a heal.

### Your Habitica character (optional, read-only)

In the Character sheet (C) you can paste a Habitica user id + API token to play
as your own character: vitals, effective stats, class kit, appearance layers
from the bundled official-art cache, plus pet follower and outdoor mount. The
adapter is strictly read-only — one explicit `GET /user` per button press, and
**nothing in the game ever writes to your account**. Credentials stay in this
tab's memory until Disconnect (never saved, exported, or logged), and the
`X-Client` header identifies the tool's creator, never you.

Health policy: importing replaces the demo vitals once; later syncs credit
genuine external HP/MP changes **exactly once** (damage + unchanged profile
never refills) and only in the village. Imported vitals get no passive
healing; defeat wakes you at capped vitals (zero stays zero) and locks
expeditions until a genuine external heal — village life (NPCs, journal,
sync) keeps working. See [docs/import-contract.md](docs/import-contract.md).

### Defeat (demo vs imported rule)

Falling in battle wakes you by the village well with restored demo vitals; all
story progress is kept. This is explicitly a placeholder for real
imported-Habitica health rules, which arrive with account integration. The
recovery lives in the shared module (`recoverFromDefeat` in `src/lib/state.ts`)
so the rule is testable and single-sourced.

## Controls

| Action | Desktop | Touch |
|---|---|---|
| Move | WASD / arrow keys | D-pad (bottom left) |
| Talk / attack | E or Space | A button (bottom right) |
| Cast signature ability | F | ✦ button |
| Mount up / dismount | M | (outdoors, imported characters) |
| Journal / Character | J / C | HUD buttons |

Dialogue pauses movement and combat. Touch controls appear on coarse-pointer
devices; the layout is responsive with safe-area insets for phones.

## Architecture

```
src/
  game/           Phaser runtime (owned by the runtime agent)
    main.ts        game bootstrap
    events.ts      bus: meaningful state events game ↔ UI
    session.ts     owns GameState; quest events; debounced saves
    input.ts       shared touch vector + UI-blocking flags
    textures.ts    procedural placeholder art (see below)
    worlds.ts      deterministic code-native area builders + collisions
    scenes/        BootScene, WorldScene
  ui/             Svelte interface (HUD, dialogue, journal, character, touch)
  lib/            shared quest state + IndexedDB saves
  content/        dialogue, journal, locations, demo character
  App.svelte      shell: title screen, HUD wiring, panels
```

`GameState` (versioned) is the single persisted truth: area, position, quest
stage, HP/mana, inventory, discoveries, defeated enemies, play time.

## Art

In-game sprites start from original placeholder art generated at runtime in
`src/game/textures.ts` (pixel-art strings → canvas). Delivered original
generated art is integrated alongside and on top of it: a twelve-frame props
atlas supplies world props (lantern post, shrine, bench, sign, crates,
mushrooms…) with explicit collisions and deliberate small-world sizing; two
flattened scene illustrations serve the title screen and journal — UI only,
never walkable maps; the expansion pack provides terrain tiles, a 4-direction
demo walk, enemy idle sets, and foreground occluders; and the runtime-art pass
(delivered October 3, 2026) adds NPC **breathing animations**, the stone
guardian's five discrete poses (idle/windup/lunge/hurt/defeat, wired into the
combat state machine), and per-class effect animations (magic bolt, cleave,
dash trail, healing pulse). A typed helper (`src/game/runtime-art.ts`) builds
exact native-size canvas textures from the delivered sheets' measured
rectangles at boot; procedural placeholders remain as the fallback layer.

Imported characters render as layered avatars composed from official Habitica
sprites — a small same-origin cached subset ships in
`public/assets/habitica/` (WebGL-safe); layers that exist only upstream are
skipped and honestly reported, never fetched cross-origin. Pets follow as
separate sprites; mounts require their layers to be cached before riding is
granted. Provenance, licenses, and attribution:
[ASSETS.md](ASSETS.md), [docs/habitica-assets.md](docs/habitica-assets.md),
and `assets/ASSETS_GUIDE.md`. Slot/dimension contract for future art:
[docs/runtime-asset-spec.md](docs/runtime-asset-spec.md).

Import flow and Habitica runtime wiring:
[docs/runtime-import-notes.md](docs/runtime-import-notes.md). Purchases,
account writes, and checkpoint rewind remain out of scope.

## Verification

- `npm run verify` — typecheck + svelte-check + unit tests + production build.
- `npm test` — Node's built-in test runner (`node --test tests/*.test.ts`)
  covering shared quest state, save validation, and content contracts.
- Manual smoke test: full quest playthrough, scene transitions, collisions,
  dialogue pausing, resize/portrait layout, reload resume, save
  export/import, defeat recovery. Results and screenshots:
  [docs/playtest.md](docs/playtest.md).

## Known limitations

- Demo art is placeholder; imported avatars render only from the small cached
  official-art subset (uncached layers are skipped and reported).
- No audio, no gamepad, no installable/offline mode.
- Saves are local to one browser; export codes are the manual backup path.
- The generated art pack has no distribution license selected yet; the bundled
  Habitica art subset and gear catalog are non-commercial/attribution-bound —
  see `ASSETS.md` "Third-party use boundaries" (public redistribution blocked
  until corresponding source is published).
