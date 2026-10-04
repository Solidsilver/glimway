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
npm test           # unit tests (node --test)
npm run test:e2e   # browser playtests (Playwright, starts its own dev server)
npm run verify     # typecheck + check + unit tests + build
npm run verify:all # verify, then the browser playtests
```

First time running the browser playtests: `npx playwright install chromium`.

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
healing (lit road lanterns give them mana only); defeat wakes you at capped
vitals (zero stays zero) and locks expeditions until a genuine external heal
or a warm rest paid with embers earned from Habitica XP — village life (NPCs,
journal, sync) keeps working. See [docs/import-contract.md](docs/import-contract.md).

### Embers: real-life progress lights the road

Every 10 XP you earn **on Habitica** becomes an ember the next time you sync
in Hearthwick. It's still read-only: the game keeps the highest lifetime XP
it has ever paid out and credits only XP above that, so each XP pays once —
losing XP and earning it back (unchecking and re-checking a task) pays
nothing new. The first
import pays a one-off welcome of 3 embers (not your past XP), and two story
beats leave a few embers so demo players can try spending them too.

Spend them in the world:

| Where | Cost | What you get |
|---|---|---|
| Hearthwick's lantern, by the well | 2 | A warm rest: full health and mana (at 0 HP, an imported hero needs embers earned from XP) |
| Three road lanterns along Brackenwood | 3 each | A lit rest spot while no enemy is near: mana for everyone, health for demo heroes |
| The chest in Ashwatch Ruin | 5 | The Ember Charm (+10% critical hits) |

Rules live in `src/lib/embers.ts`, with tests in `tests/embers.test.ts`.

### Defeat (demo vs imported rule)

Falling in battle wakes you by the village well with restored demo vitals; all
story progress is kept. This is explicitly a placeholder for real
imported-Habitica health rules, which arrive with account integration. The
recovery lives in the shared module (`recoverFromDefeat` in `src/lib/state.ts`)
so the rule is testable and single-sourced.

## Controls

| Action | Desktop | Touch |
|---|---|---|
| Move | WASD / arrow keys | Joystick (bottom left) |
| Talk / use / attack | E or Space | Big button (bottom right; shows Talk near people) |
| Cast signature ability | F | ✦ button (shows mana cost and cooldown) |
| Dodge roll | Shift | Small green button above ✦ |
| Pick a dialogue reply | 1 / 2 or arrows + Enter | Tap the reply |
| Mount up / dismount | M | (outdoors, imported characters) |
| Journal / Character / Menu | J / C / Esc | HUD buttons |

Every real enemy attack is telegraphed: a windup pose, a "!" and a rising
tone, then a white flash when its aim locks, which is your cue to step aside
or roll. Slimes and mushrooms hop at you; beetles back off and then charge in
a straight line, and a beetle that charges into a tree or wall is dazed and
takes extra damage. Hits knock enemies (and you) back through physics, so
nothing gets shoved through a wall.

Dialogue pauses movement and combat. Touch controls appear on coarse-pointer
devices; the layout is responsive with safe-area insets for phones.

## Interface

- **HUD:** area, current goal (tap to expand), health and mana with icons; a
  desktop action bar shows the E action (it follows context: Slash / Talk /
  Use) and the signature ability with its mana cost, cooldown sweep and a
  shake when you can't afford it. Low health pulses the bar and adds a red
  vignette.
- **In the world:** a gold **!** floats over whoever moves the story on, a
  **…** bubble over anyone with something new to say, and a keycap over the
  current interaction target. Exits are labelled with their destination and
  pulse with chevrons. Canopies and arches fade when anything walks beneath.
- **Moments:** quest beats arrive as a ribbon banner, new areas get a title
  card, lighting a lantern plays a short camera beat, defeat has a "You
  stumble…" collapse and a wake-up card, and finishing the quest shows a
  closing card with your play time and finds.
- **Panels:** Journal (goal, quest-step checklist, notes newest first),
  Character (portrait, vitals, stat tiles, ability cards, pack with item
  names), and Menu (save codes, Habitica connection, sound, controls,
  credits, start over). Panels trap focus; hard choices use in-game
  confirms rather than browser popups.
- **Sound:** small procedural Web Audio cues (no files, no network): UI
  clicks, per-speaker dialogue blips, hits, casts, quest chimes, the lantern
  sting. Toggle in the Menu; the choice is remembered on this device.
- **Fonts:** Pixelify Sans (display) and Nunito (body), bundled locally via
  Fontsource. `prefers-reduced-motion` turns off shakes, hit-stop and big
  tweens.

Dev builds expose read-only playtest hooks (`__fsPlayer`, `__fsEnemies`,
`__fsSafety`, `__fsWorld`, `__fsDebug`) plus dev-only levers (`__fsDevHurt(n)`,
`__fsDevStrike(n)`, `__fsDevWarp(area, tx, ty)`) for checking the
low-health, defeat and quest beats without a full playthrough.

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
  `tests/worlds.test.ts` checks every map's layout rules: the border is closed
  except at exits, exits come back on the opposite edge beside the way home,
  the journey runs village → woodland → ruin left to right, and every NPC,
  enemy, exit and quest target is reachable from the spawn.
- `npm run test:e2e` — Playwright playtests in `e2e/` (real keyboard and touch
  input; warps and the dev strike skip long walks and fights):
  - `quest.spec.ts`: the whole quest from a fresh start to the ending card,
    exits round-tripping in the right direction, the hero staying inside every
    map, and area title cards naming the current area.
  - `embers.spec.ts`: welcome embers from a sample hero, a warm rest, a
    greyed-out chest, and lighting a road lantern with quest embers.
  - `combat.spec.ts`: slime windups and hops, a beetle charge that hurts if
    you stand still and misses if you roll when it flashes, and knockback that
    never leaves an enemy off the map.
  - `touch.spec.ts`: the phone layout's controls fit without overlapping, and
    the roll button works.
- Manual smoke test: full quest playthrough, scene transitions, collisions,
  dialogue pausing, resize/portrait layout, reload resume, save
  export/import, defeat recovery. Results and screenshots:
  [docs/playtest.md](docs/playtest.md).

## Known limitations

- Demo art is placeholder; imported avatars render only from the small cached
  official-art subset (uncached layers are skipped and reported).
- Procedural sound effects only (no music), no gamepad, no installable/offline mode.
- Saves are local to one browser; export codes are the manual backup path.
- The generated art pack has no distribution license selected yet; the bundled
  Habitica art subset and gear catalog are non-commercial/attribution-bound —
  see `ASSETS.md` "Third-party use boundaries" (public redistribution blocked
  until corresponding source is published).

## Optional connected backend

Guest play remains local. The phase-2 Go backend lives in `server/` with shared
JSON in `content/`; run it locally with `npm run server` (Go 1.26+), alongside
`npm run dev`. Server access is allowlist/invite-only. The server sees a
Habitica token only during login and makes one read-only `GET /user` to prove
account ownership (one retry on 429). It never stores, logs, or returns the
token. Later sync fetches remain browser-to-Habitica. The backend owns
connected balances, sync baselines and paid outcomes; frontend integration
is a later phase. See [deployment and backups](docs/home-server.md).
