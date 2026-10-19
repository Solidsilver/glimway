# Step-back round 2: the client

Snapshot: `acdbf0b4df7645980a0de2b0e809feed730ef424` (`review/013-prerelease`, dev).
Review only; no implementation changes or commits. **1 P1, 2 P2, no new P3s.**
The known App lamp-naming alias bug belongs to A10 and is excluded here.

## Map: what I read

Read the round 1 summary and A1–A8 packages, UI and game reports, decisions 36–66,
`docs/design/lamps.md`, and the Unreleased player promises. Followed App's bus wiring,
reactive aliases, layers and session replacement; the naming, crate, inventory, map,
shelf, deed, companions and dialogue panels; their focus/read helpers; WorldScene,
controls, Turning/travel holds, camps, communal lamps, home talk, ways home, Items,
Village and the Link delivery/outbox paths. Checked corresponding content, pure
helpers and tests, and read server handlers where necessary to establish the answers
the client receives. This is a whole-client boundary review, not a diff review; the
most detailed traces are the 0.13 paths below.

## Findings

### C1. Destroying a game leaves its scene listeners alive across a world switch

**P1 · M size · Confirmed**

- **Evidence:** An in-page world move constructs a new session
  (`src/ui/account-flow.svelte.ts:422`), and App destroys the previous game before
  starting its replacement (`src/App.svelte:544`, `src/game/main.ts:36`). Phaser's
  `SceneManager.destroy` calls `Systems.destroy`, which emits **destroy**, without
  shutdown. This distinction is already documented and handled by
  `src/game/scene-end.ts:1` and `src/game/entities/homesteads.ts:136`.

  However, WorldScene removes its global bus handlers only on **shutdown**
  (`src/game/scenes/WorldScene.ts:577`, `:585`). WorldControls does the same for
  its bus subscriptions and `trackBelt` (`src/game/scenes/world-controls.ts:98`,
  `:110`). Camps (`src/game/wilds/camps.ts:82`), communal lamps
  (`src/game/wilds/communal-lamps.ts:91`) and ways home
  (`src/game/ways-home.ts:45`) likewise never end on destroy.

  Two concrete consequences reproduced in `/tmp/glim-client-review-probes.mjs`:

  1. With the old and new sessions' real `trackBelt` subscriptions installed, adopting
     the new session's item view fires the old tracker first. Its `itemsFor(old)`
     replaces the module singleton; the new tracker then calls `itemsFor(new)` and
     creates another empty model (`src/game/held.ts:64`, `:80`;
     `src/game/items.ts:264`). The newly loaded Items object is no longer current,
     and the current model's `view` is **null**. This needs an ordinary item refresh,
     not a request overlapping the switch.
  2. The real WorldScene bus setup and extracted `onRelocate`/`moveTo` methods,
     with a destroyed camera manager, still receive a later relocation. The old
     scene tries to fade its missing main camera (`WorldScene.ts:1120`, `:1388`)
     and throws before the new scene's subscriber runs. The bus does not isolate
     listener exceptions (`src/game/events.ts:45`). The probe records
     `currentReceived: false`. A distant ways-home landing takes this branch.

  Actual camp and communal controllers also retained their `lampNamed` listeners
  and emitted a naming panel when a deferred landmarks answer landed after destroy.
  Their new `gone` checks protect shutdown only. The existing lifetime test double
  supports only shutdown (`tests/wilds-lifetimes.test.ts:41`), so its passing world-move
  test does not model App's world-move teardown.
- **Player effect:** After changing worlds without reloading, tools can disappear
  from the current belt/model on every pack refresh. Old controllers continue
  answering new-world events. A later paid way home can update the server and saved
  destination but throw before the current scene follows it; the player stays at
  departure until recovery/reload. A late old-world naming read can cover the new
  world with the wrong panel.
- **Fix:** Use `onSceneEnd` for scene-owned external subscriptions and build
  invalidation, including WorldScene's unlisten, WorldControls' belt tracker, camps,
  communal lamps and ways home. Audit the other shutdown-only external subscriptions
  in the same client lifetime, with destroy-safe resource cleanup. Add a **destroy →
  replacement scene → item refresh/relocation** guard using the actual subscriptions;
  exercise deferred naming on destroy as well as shutdown. Clearing the camp cache
  alone does not remove these listeners.

### C2. Keeper rules and member pickers can put their controls above the clipped screen

**P2 · S size · Confirmed**

- **Evidence:** `src/game/wilds/camps.ts:279` builds four rule choices, a Name someone
  choice, one removal choice per listed member, and Done. `:295` puts every remaining
  world member in another dialogue list. The server permits 64 listed members
  (`server/internal/api/claim_rules.go:34`). These are ordinary dialogue boxes,
  not the bounded `Panel` shell.

  `src/ui/DialoguePanel.svelte:322` anchors the box to the bottom; neither `.dialogue`,
  `.box` nor `.choices` has a height limit or scrolling (`:334`, `:423`). The shared
  scrolling rule applies specifically to `.overlay > .panel`
  (`src/app.css:293`); dialogue is not an `.overlay`. App clips its main viewport
  (`src/App.svelte:1145`). The actual controller probe generated **18 choices for
  12 listed members**. Their vertical padding alone is 324 px (`DialoguePanel:436`),
  plus 136 px of row gaps, before any text or heading: already more than a 320 px
  landscape viewport. Larger supported lists exceed desktop heights too. This is
  verified from generated choices and CSS bounds, not a browser screenshot.
- **Player effect:** On touch, the top of the keeper's rules/member list disappears
  above the screen and cannot be scrolled into view. Changing rules or selecting
  early members becomes inaccessible as the list grows. Keyboard arrow navigation
  exists, but does not supply a touch scroll area; number shortcuts also handle only
  single-digit choices (`DialoguePanel.svelte:188`).
- **Fix:** Bound the dialogue box to the available viewport height and give its
  choices/body vertical scrolling, preserving a visible heading and dismissal.
  Verify a short landscape viewport and a supported long member list. This can ship
  as a focused sizing fix without introducing the deferred charter/members panel.

### C3. A lot-lantern fill can open its old conversation after the player leaves

**P2 · S size · Confirmed**

- **Evidence:** A top-up goes through `home:lantern:<gate>`
  (`src/game/entities/homestead-talk.ts:611`) to `fillLantern` (`:401`). The home
  mutation adopts the returned home and finishes (`src/game/homestead.ts:471`).
  `fillLantern` then awaits a separate `fetchHome(gate)` before playing sound and
  opening another dialogue (`homestead-talk.ts:407`). Neither that continuation
  nor `say` (`:457`) checks the home layer's lifetime. The layer already sets
  `home.gone` on shutdown **and** destroy (`homesteads.ts:137`).

  The real `HomesteadTalk.fillLantern` probe held that second read, marked its home
  gone and scene inactive, then completed the read. It still emitted one
  `Lot Lantern` dialogue. This window is reachable: the mutation's busy hold has
  ended, while the subsequent GET does not hold player input. No failed mutation or
  artificial overlap between serialized HTTP requests is required.
- **Player effect:** Fill the stake, then enter the cottage or leave the scene while
  the follow-up home read is slow. The departed stake starts talking over the new
  scene, holds input again, and can replace the conversation the player just opened.
  A world replacement can deliver the same stale dialogue.
- **Fix:** Check `home.gone` after each await before opening scene-owned dialogue or
  playing its sound. Keep successful model updates/land invalidation, and use a toast
  if a completion still needs acknowledgement after departure. Add a deferred
  follow-up-read/departure guard; an active-scene check alone misses a restart on the
  same Phaser scene object.

## Player-path traces and remaining limits

All writes below reach Link's serialized, persisted operation machinery. A request
that was stored/sent before reload is reconciled/replayed with the same key; the UI
must distinguish its `pending` answer from a final refusal. This review found no
additional goods-loss mechanism in the crate, planting or pack-up client requests.

| Path | Click → request → UI answer; what remains |
|---|---|
| Naming | Lamp talk → landmarks GET → `lampNamingOpen` → App/panel → `lampNamed` → camp or communal POST → adopt lamp, reload items, toast. A10 owns submit/cancel alias ordering. Shutdown fences are present; **destroy is missed (C1)**. Refused landmarks and mutations have error toasts. |
| Keeper build rules/member list | `camp:rules/pick/rule/add/unname` → `WorldScene.onDialogueClosed` → `WorldActions` → camp POST with complete rule/list → adopt returned camp → reopen rules. Refusals toast and leave the stored rule intact. **Long-list controls are clipped (C2)**. |
| Pack-up | Lamp → pack confirmation → `camp:packup` → camp POST `pack` → remove camp from known list, invalidate land, reload goods, toast. Refused/pending operations are told; shutdown avoids reopening scene panels. Destroy has C1's shared lifetime problem. |
| Trowel | Held `uproot` tool changes plant offer → home items/uproot or camp/uproot → returned wear/carried plant → Items adoption or reload; home refetch/camp adoption removes the plant. Refusals toast. No additional request/response mismatch found; home callback lifetime remains less consistently fenced than the camp controller. |
| Weekly sap/chandler | `village-life.ts:239`/`:256` offer refining/tapping → dialogue action → `WorldActions.tapSap/refineSap` → Items mutation → adopt returned pack → tap dialogue/gain toast or refusal. `already-tapped` has the next-wick line. `withServer` checks scene activity, not build identity (`world-actions.ts:117`); no separate reachable failure was established beyond the teardown findings. |
| Pell picker/replant | Pell reads recovery before offering picker → App crate panel → recoveryCollect with ids/asSeed → remove returned ids immediately → reread while busy. Transport reads retry; a final read refusal is displayed. Whole plants have individual inventory keys and route their instance id to items/plant or camp/plant, then adopt/refetch. Pending collection remains reconcilable after reload; no duplicate-take bug reproduced. |
| Communal light/relight | Stone's `lampStoneLook` or inventory `communalPost` → controller → communal POST → adopt returned lamp, reload pack, invalidate land, toast. Copy/read use the same route. Errors include pending wording. **Destroy leaks its handlers (C1)**. |
| Lamps ledger | Map → `loadMap` → explored-key map-status batches → keyed lamp ledger → row centres the mark. Scope/generation fences reject another world/wick; offline keeps known input, partial failure is announced, expired Wilds are withheld. No additional ledger defect found. |
| Land chip/notices/lot lantern | Window → `LandHere` → status read → `landHere` bus/HUD. A3 now retries failed stationary reads and invalidates after relevant mutations. Village's calendar asks for dimming notices and toasts them; a failed notice request waits for the next calendar read, and server marking on GET gives no delivery acknowledgement. **The lot fill's follow-up dialogue has C3**. |
| Ways home | Inventory closes → `waysHome` → three-second `WayPause` → ways-home POST → authoritative move adoption → `relocate` → scene follow/rebuild → arrival toast/items reload. Movement/fights cancel the pause; pending can be told later. Turning now retains relocation before position sampling resumes. **A destroyed older scene can intercept delivery (C1)**. |
| Keeper's hand | Mara quest action → quest-step → server marks/gifts; designated stone GET identifies `cutStone`; copy POST writes `keeper:cut`; subsequent quest progression grants `keeper:hand`; communal relight/tend/read/name writes completion. Content and client action routes agree. Pure quest/naming coverage exists; the complete player journey still lacks E2E, and no additional progression blocker was verified. |

## Verification

No Playwright, Vite, dependency installation, code/spec edits or commits. Used
`nix develop -c node …` with an external resolver pointing at the existing
`/data/code/fingersnap/node_modules`; its lockfile is byte-identical to this worktree's.

- Focused client tests: **56 passed, 0 failed**, including layers, panel reads, lamp
  lifetimes, travel hold, crate picker, trowel, sap, naming, map lamps and ways home.
- Full node suite: **2,693 passed, 1 failed** of 2,694 in 63.1 s. The failure was
  `calendar-fixture.test.ts` spawning Node without the temporary resolver, so its child
  could not import protobuf. Re-running that one test with the resolver inherited in
  `NODE_OPTIONS` passed. No product assertion failed after that environment correction.
- Throwaway probes: `/tmp/glim-client-review-probes.mjs` imports real controllers and
  belt/item models, and transpiles the actual scene bus setup/relocation methods.
  It verifies C1 and C3's interleavings and C2's generated choice count. These are
  terminal probes, not browser reproductions. `npm run check` was not run.

## Round 1 UI findings: did cleanup fix them?

| Finding | Status at this snapshot | Evidence |
|---|---|---|
| U1 naming does not own J/C/I | **Fixed** | `src/ui/layers.ts:67` includes naming in appKeys; `tests/layers.test.ts` varies naming and confirm. Focused suite passes. A10's separate alias bug is excluded. |
| U2 crate ordering/busy gap; shelf retries refusals | **Fixed for the reported mechanisms** | `CratePanel.svelte:40` holds its reread inside `action.run` and adopts filtered entries immediately; `GateShelfPanel.svelte:34` uses `latestRead`; `panel-state.svelte.ts:78` restricts retry codes and fences old reads. Deferred read/refusal tests pass. |
| U3 oil note and hardcoded capacity | **Fixed** | Shared sap/chandler note in `src/content/camps.ts:21`, used by camp and home talk; full text reads `wayLamp.maxWicks` (`src/lib/camps.ts:154`). |
| U4 scattered camp/crate/map/workshop copy | **Mostly fixed; wording rider remains** | Named camp/crate/rule strings moved to `src/content/camps.ts`; map controls/key use content; workshop uses `LOCKED_RECIPE` (`WorkshopPanel.svelte:217`). `CRATE_LINES.collected` still calls every collection “home pieces”, including plants/materials (`content/camps.ts:125`). Other new words remain outside content, notably ways-home, sap and communal-lamp strings; not promoted to another cleanup finding here. |
| U5 Wild/Turning and swapped map keys | **Fixed** | `src/content/land-chip.ts:13`/`:15` say Wild for ordinary land, retaining Turning for released holds; `content/map-lamps.ts:18` and `lib/wilds/map-lamps.ts:20` use lastWick/guttering in the correct mapping. Tests pass. |
| U6 inventory position is stale on opening | **Behavior fixed** | Inventory emits `notePosition` first on mount (`src/ui/InventoryPanel.svelte:97`). The optional shared feet-math extraction was not done; some coordinate formulas remain inline. |
| U7 large components/world rules in Inventory | **Not fixed; deliberately deferred** | App 1,441 lines, Inventory 1,622, HUD 1,343, map 1,011. Inventory still owns placement eligibility (`:360`); App still owns repeated settings lifecycle calls (`:426`, `:490`, `:533`). Decision 61 schedules incremental refactors for early 0.14. |
| U8 short-landscape HUD row | **Not fixed; original visual claim remains plausible** | `src/ui/Hud.svelte:1072` still uses `auto minmax(0,1fr) auto`, bars remain 130 px (`:1081`), and the goal has no floor. No screenshot/browser sizing assertion was run here. C2 concerns a separate, verifiable dialogue-list overflow. |

## Open questions for the owner

None needed to fix C1–C3; these preserve the decided game rules. The existing lore
pass can settle the remaining collection wording and copy placement.
