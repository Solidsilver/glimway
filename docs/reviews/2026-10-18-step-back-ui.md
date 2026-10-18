# Step-back review after 0.12–0.13: the UI

Snapshot: `190a9d38` (dev, on `exp/step-back-0.13`). This review covers `src/ui`, `src/App.svelte`, accessibility, touch and mobile, and the player-facing copy for the new systems. It follows `2026-10-13-step-back-ui.md` and the decisions log through #59, and it is a review only. `npm run check` is clean (856 files, 0 errors). The node tests for layers, the crate picker, the land chip, the map lamps and lamp naming pass (23 of 23). One throwaway probe, outside the repo, backs U1.

## Map: what changed in the UI since 268c9b42

The UI changed less than the rest of the 0.12–0.13 diff. Across `src/ui` and App, 27 files changed (+1,013 / −152). Most of the new player surface is dialogue-driven: the camp readout, keeper rules, pack-up and plant talk all go through `openDialogue` from `src/game/wilds/camps.ts`. Only a few new Svelte pieces exist:

- **`CratePanel.svelte`** (128 lines, new). This is Pell's crate picker, opened from his desk talk. It is built on `Panel` and `actionRunner`, with rows from `crateRows` (`src/lib/camps.ts`).
- **`LampNamingPanel.svelte`** (192 lines, new). It is the Keeper's naming from parts: selects and chips with a live preview, mounted by App from `home.lampNaming`.
- **The map's Lamps layer and ledger** (`WorldMap.svelte` 925 → 1011, `map-renderer.ts` +96). It adds a tier hatch, lamp marks, the ledger and the Common-paths list in Details. All of it uses one dimming rule, `landDimming` (`src/lib/wilds/map-lamps.ts:11`).
- **The HUD land chip** (`Hud.svelte:124–135, 637–652`), plus the reduced-motion cooldown countdown (Hud and TouchControls).
- **`InventoryPanel.svelte`** (1,511 → 1,619). It gained way-lamp setting, camp set-out, communal posts, planting at camps, carried plants and the ways-home pouch.
- **`WorkshopPanel.svelte`**: recipes stay locked until their page is carried.
- **DevPanel**: the clock and the server-gated tools (`DEV_TOOLS`, `devPanelOn`). The `expose()` helper replaces the ad-hoc `window.__fs*` writes.
- **`layers.ts`**: a `confirm` layer fed by `confirms.open`.
- **`GateShelfPanel.svelte`**: the shelf stall fix from e2e-health (`:53–71`).

### Status of the 2026-10-13 UI findings

| Previous | Status | Evidence |
|---|---|---|
| F1 reduced motion erases the cooldown | **done** | A `.cooldown-time` "Ns" text shows under `prefers-reduced-motion` (`Hud.svelte:376–377, 1267–1281`; `TouchControls.svelte:261, 604–619`). |
| F2 claim/relight codes fall to "didn't answer" | **done** | `src/content/wilds-errors.ts:15,18` (`beyond-frontier`, `already-lit`, …). |
| F3 action bar not inert under the map | **done** | `Hud.svelte:387` `inert={covered}`. |
| F4 phone short-landscape top row | **not done** | No `.goalbar` floor (`Hud.svelte:1069–1086`), and the strip now carries the land chip too. See U8. |
| F5 nested confirm doesn't own the keyboard | **done** | The `confirm` layer in `appKeys` (`layers.ts:58`, `App.svelte:596`). A sibling gap opened with lamp naming; see U1. |
| F6 big components | **not done, grew** | See U7. |
| F7 map strings outside the copy module | **done** | `MAP_LABELS.onMap/noPlaces/foundByLegend` (`open-map.ts:97–100`). New stray strings came in with the Lamps layer; see U4. |

## Findings

### U1. Lamp naming doesn't hold J/C/I: a panel opens under the naming overlay and takes focus. P2 · S · Confirmed

**Evidence:**
- `BLOCKS.appKeys` (`src/ui/layers.ts:58`) lists `confirm, dialogue, cinematic, gate, lease, move, reloading, ending`. It does not list `naming`.
- `onKeyGlobal` (`src/App.svelte:640–691`) skips a key only while the target is an `INPUT`, `TEXTAREA` or contenteditable (`:645–648`).
- NamePrompt is safe by accident, because its text field has focus. `LampNamingPanel` has no text field: its trap focuses the first `<select>` (`LampNamingPanel.svelte:44`), and its chips are buttons.
- `M` is guarded separately (`mapAllowed`, `App.svelte:705–708`, checks `home.lampNaming`). J, C and I are not.
- A probe test outside the repo (`layersUp({naming: true})`) confirms that `blocked(up, BLOCKS.appKeys)` is false.

**Failure:** a Keeper opens the naming panel and presses I, or types a letter into a focused select to jump to an option, as keyboards do. The inventory mounts at z-index 40 under the naming overlay at 60 (`app.css:287`, `LampNamingPanel.svelte:86`). Its focus trap pulls focus into a panel the player can't see. Tab now cycles through hidden controls. Escape closes the hidden panel, not the naming, and the naming stays up with world input held. The same goes for J and C.

**Fix:**
1. Add `'naming'` to `BLOCKS.appKeys`. NamePrompt and LampNaming already handle and stop their own Escape (`NamePrompt.svelte:31`, `LampNamingPanel.svelte:36`), so nothing is lost.
2. `tests/layers.test.ts` checks the table against a frozen copy of App's 7d3bb12 hand-written lists (`before()`, `:11–24`), which keeps this gap in place. Change that test's oracle on purpose for `naming`.
3. Add `'confirm'` to its exhaustive `LAYERS` list. Today it is pinned to `false` in every combination (`:5, :28`).

### U2. Panels that read from the server each have their own read logic; the crate has none. P2 · M · Confirmed

**Evidence:** these are the three new or changed server-read surfaces:
- **GateShelfPanel** (`:49–71`) uses a `readSeq`. Its first good read is shown even when it is older; this is the 10-18 stall fix. A failed read is retried every 500 ms while the panel is open.
- **WorldMap** (`:96–158`) uses `generation`, `started/shown`, `inFlight/again` and `superseded`.
- **CratePanel** (`:23–49`) has none of this. `reread()` has no ordering, and there is no retry or retry button after a failed first read (it just shows `failed`). The taken row stays enabled between the collect answer and the re-read: `action.run` clears `busy` before `await reread()` at `:48`.

**Failures:**
1. *Crate:* take the stool, then press Take on the next row before the re-read lands. Or press Take twice on a slow link, since the row is still there. The server skips entries that were already taken (`server/internal/api/recovery.go:156–160`) and answers `collected: []`. The panel then says `collectedLine([])` = *"Nothing waiting for you. The book's square."* (`src/lib/camps.ts:128`) while rows are still listed. Two overlapping re-reads can also land out of order and bring back a row that was taken.
2. *Shelf:* the retry loop doesn't tell a temporary failure from a refusal. If the lot's homestead is gone, for example a deed lost while the panel is open, `shelfRead` returns 404 `homestead-not-found` (`home_shelves.go:126–128`). The panel then re-asks twice a second until it is closed. Each ask runs `settleHomes` in a transaction.

**Fix:**
1. Add one small helper to `panel-state.svelte.ts`, for example `latestRead(load)`. The newest read wins once something is shown, any good read is shown before that, and only transport or 5xx codes are retried. Use it in the Shelf and the Crate, and test it with node tests the way `actionRunner` is tested.
2. In CratePanel, drop the ids in `r.result.collected` from `entries` as soon as the answer arrives, before the re-read. Say a distinct line when `collected` is empty but rows remain.
3. 0.14's market stalls will copy whichever pattern sits nearest, so this should land first.

### U3. The "you need oil" note predates weekly sap, and the lamp-full line hardcodes "three". P3 · S · Confirmed

**Evidence:**
- `'You need hearth oil (the chandler sells it)'` is written out twice: `src/game/entities/homestead-talk.ts:393` (the lot lantern) and `src/game/wilds/camps.ts:230` (way-lamps).
- Since decisions #39 and #43, oil also comes free once a wick: you tap Wick Tree sap and the chandler refines it (`content/items.json:892–896`).
- `CAMP_ERRORS['lantern-full']` reads *"It takes three wicks of oil at most"* (`src/lib/camps.ts:184`). The cap is content (`HOMESTEAD_DATA.wayLamp.maxWicks`, `content/homestead.json:606, 613`), and `campLines` already reads it.

**Cost:** a new player with no glims is told to buy, when the free route is the one the owner designed. If the cap changes, the copy will be wrong.

**Fix:** move one `needOil` note into content, naming the Wick Tree as well as the chandler, and use it in both places. Build the full line from `maxWicks`.

### U4. Lamp, camp and crate copy is outside `src/content`, with new inline strings. P3 · M · Confirmed

**Evidence:**
- Player-facing words for 0.13 live in `src/lib/camps.ts`: `campLines`, `crateLines`, `REASON_LINES`, `collectedLine`, `CRATE_WORDS`, `CAMP_ERRORS`, `CAMP_RULE_WORDS` (`:72–180` and on).
- Some are written inline in game code. In `src/game/wilds/camps.ts` that includes `'Top it up with hearth oil'`, `'Take the lamp down'`, `'The camp goes; its oil comes back to you'` (`:234`), `'Never mind'` (`:285`), `'Send it to Pell’s'` (`:300`) and the take-down toast (`:323`).
- In `WorldMap.svelte`: `'┄ Common · paths kept by a visit'` (`:597`) says the same thing as `MAP_LAMPS.common` in other words, and the group label `aria-label="Map controls"` is inline (`:537`).
- In `WorkshopPanel.svelte:211–216`, a locked recipe is tagged **"page not found"** and says *"You never learned this recipe — {r.found}."* The tag reads like a web 404.
- The 0.13 land-chip and map-lamp words did go to `src/content` (`land-chip.ts`, `map-lamps.ts`), so the repo already has a convention (arch F6/F7). The camps lane didn't follow it.

**Cost:**
- The owner's lore pass, which 0.13 and 0.14 wait on, has to search `lib/` and `game/` for words.
- `collectedLine` says *"The home pieces are in your pack"* for any collect, including path refunds and plants (`camps.ts:128`), and nothing tests it.
- `crateLines`'s "draft lines for the owner to review" (decision #45) are harder to find.

**Fix:** move the strings to `src/content/camps.ts`, keeping the functions in `lib/`. Put the inline choices and toasts there too. Rename the workshop tag (for example "page still to find"). This is one lane, and it is best done together with U3 and U5 ahead of the lore pass.

### U5. Lamp and land wording: "Turning" means two things, and the map's key names are swapped. P3 · S · Confirmed (wording is the owner's call)

**Evidence:**
- On wild land the chip says **"Turning"** all the time (`LAND_CHIP.turning`, `short.turning`; `land-chip.ts:49–50`). "The Turning" is also the weekly event, with its own screen hold (decision #55). Released land uses the same word.
- The map calls wild land *"Wild · detail turns"* (`map-lamps.ts` content `wild`), which is jargon.
- In `MAP_LAMPS` the key `dimming` holds *"Turns next turning unless tended"* (the guttering state) and `dims` holds the last-wick line (`src/content/map-lamps.ts:9, 17`; mapped at `src/lib/wilds/map-lamps.ts:21`). That is the reverse of the owner's rule that a lamp is dimming from its last wick (decision #53).

**Cost:** a player in the Wilds reads "Turning" as "it's turning now". The next person to edit `MAP_LAMPS` will put the dimming line under the wrong key.

**Fix:**
1. Rename the keys to `lastWick` and `guttering`. This is mechanical.
2. **For the owner:** the chip says "Wild" on wild land, keeping "Turning" for released land, and "detail turns" gets plain words. Bring this into the lore pass.

### U6. The inventory's camp and land buttons use a position up to a second old. P3 · S · Confirmed

**Evidence:**
- `myLandGate`, `campHere`, `lampSettable`, `campSettable` and `plantable` (`InventoryPanel.svelte:357–420`) read `session.state.position`.
- The frame loop writes that position once a second (`WorldScene.ts:976–985`).
- The panel's `onMount` (`:97–125`) doesn't emit `EV.notePosition`. Only the action handlers do.

**Failure:** step into a camp chunk and press I at once. The panel offers *Set the way-lamp here* rather than the camp's set-out and plant buttons. The set goes out from the new position and comes back as `cannot-hold` ("someone else's camp"). The reverse can also happen: a camp button shows for the chunk you just left.

**Fix:** emit `EV.notePosition` first in `onMount`. Also move the hero-feet tile, `(y - 1) / 16`, now repeated in `InventoryPanel.svelte:371` and `camps.ts:349, 404`, into one lib function.

### U7. The large components grew again, and InventoryPanel now holds world rules. P3 · L · Confirmed (carried from F6)

**Evidence:**

| Component | 10-13 lines | Now |
|---|---|---|
| `App.svelte` | 1,393 | **1,439** |
| `InventoryPanel.svelte` | 1,511 | **1,619** |
| `Hud.svelte` | 1,295 | **1,343** |
| `WorldMap.svelte` | 925 | **1,011** |

What's new is the kind of code being added:
- **InventoryPanel** now decides where on the map you are and what may be set or planted there (lot, lit backland, camp, communal; `:357–450`). It also routes planting either to `items.plant` or to `EV.campDo`. Those are game rules inside a view, and U6 comes from them.
- **App** gained the web-settings lifecycle in five places: `loadWebSettings` at `:425, :489, :531` and `resetWebSettings` at `:514, :530, :558`. On sign-in it is called twice (enterSession, then startPlaying).

Small duplication:
- The cooldown ticker `$effect` and `.cooldown-time` CSS are written out in both `Hud.svelte:78–84` and `TouchControls.svelte:25–31`.
- The `.small` button style is copied into 12 panels (CratePanel, Desk, Woodpile, Hearth, Deed, Mail, Yard, Invite, WorldCard, Library, NoticeBoard, Workshop).

**Fix:**
1. Keep the split order: the inventory's detail and action card first.
2. Before that, move the "what can I do with this piece here" checks into `src/lib` (a pure `placeOptions(entry, here)` with node tests). That also fixes U6.
3. Move the web-settings calls into `account-flow` (load on entry, reset on leaving).
4. Make the cooldown a `cooldownNow` store and its CSS a `CooldownSweep` component, and move `.small` into `app.css` next to `button.tiny`.

### U8. The phone short-landscape top row is still unguarded, and the land chip adds to it. P3 · S · Plausible

**Evidence:**
- F4's measurements still hold: `grid-template-columns: auto minmax(0, 1fr) auto` with 130 px bars (`Hud.svelte:1069–1086`).
- The strip now also carries the land chip in the Wilds (`:135`; one word on touch, which helps).
- I took no screenshots, since Playwright and Vite aren't run on this host. The arithmetic is unchanged and slightly worse.

**Fix:** as in F4: give `.goalbar` a `minmax(56px, 1fr)` floor in landscape, and add a 568×320 top-row fit assertion to `touch.spec`. CI runs it.

### U9. Test gaps in the new UI. P3 · S · Confirmed

- **`LampNamingPanel`** has no browser coverage: no open, no Escape, no submit. Decision #51 dropped lamp E2E specs for 0.13, so I'm not reopening that. U1's change to the layers test is the cheap guard. When lamp specs return, one `naming-screens` case is enough: open, press I (nothing opens), press Escape (cancelled).
- **`layers.test.ts`** never varies `confirm` in its exhaustive loop (`:5, :28`). It tests one nested case by hand.
- **CratePanel:** `e2e/camps.spec.ts:111–123` covers a single take. Nothing covers *take whole* or *take its seed*, *Take everything*, or the repeated-take case from U2. A node test of the U2 helper would cover the ordering.
- **Copy tables:** `CAMP_ERRORS` and the crate's `homeErrorText` fallbacks have no completeness test against the server's refusal codes, unlike `wilds-errors` after F2. A codes test would help at the 0.14 freeze.

## What's healthy

- **One dimming rule.** `landDimming` (`src/lib/wilds/map-lamps.ts:11`) feeds the chip, the map hatch, the lamp mark, the ledger and the art, as decision #53 asked. `campLook` matches it. No two views can disagree about a lamp.
- **Dimming isn't shown by colour alone:**
  - on the chip: dashed border and the ember icon (`Hud.svelte:648–652`);
  - on the map: a hatch (▨), a ⚠ prefix and a desaturated mark (`WorldMap.svelte:508, 927`).
- **The land chip doesn't chatter.** It reads out only dimming (`Hud.svelte:169–170`), and `sameChip` keeps the HUD from hearing about every chunk edge.
- **Lamp naming has no free text.** It has labelled selects, a fieldset and legend for each chip group, `aria-pressed`, an `aria-live` preview, its own Escape and a phone single column (`LampNamingPanel.svelte:43–81, 187–191`).
- **CratePanel** uses the shared `Panel` and `actionRunner` shell. The Panel/actionRunner convention from the 10-07 review keeps holding for new panels.
- **On the map,** the marks are `aria-hidden` and the same information is in the ledger's buttons in Details, so a screen reader gets a list, not a canvas. The 10-13 inert and focus work is intact.
- **Dev tools** are compiled out (`DEV_TOOLS`) and gated by the server (`devPanelOn`). `expose()` replaced the ad-hoc `window.__fs*` writes and their cleanup.
- **All seven 10-13 findings were handled except F4 and F6,** each with a code change I could see.

## Seams for 0.14

- **Permanent land isn't only the town any more.** A Wilds hearth's core plot is permanent (roadmap 0.14). Today `permanent` is labelled *"Town · permanent"* on the map and in the key (`content/map-lamps.ts:15`), and `landChip` returns no chip for it (`land-chip.ts:52`). A charter's core would be called "Town". Label permanent land by its claim kind before charters land.
- **Co-signed charters need a members panel.** Camp rules run as dialogue choice lists, with one "unname X" choice per member and a separate "pick who" list (`camps.ts:265–286`). That will not hold for co-signing, inviting and seeing signatures. Build one claims/members panel on `Panel` that both camps and charters use, and move `CAMP_RULE_WORDS` with it (U4).
- **Market stalls** grow from `GateShelfPanel`. Land U2's read helper first, so the stall panel starts from the shared helper rather than a copy.
- **Station chains** will need the locked-recipe state at the mill, the kiln and the bench. `known(page)` is a local closure in `WorkshopPanel.svelte`, and its copy is inline (U4). Move both to `lib` and `content` before copying it into more stations.
- **Contract freeze:** every refusal code a 0.13 or 0.14 panel can receive should have wording and a completeness test (U9), so that adding a code after the freeze also adds its wording.
- **App size:** 0.14 adds at least the charter flow and the stall panels. Each one adds a `panel ===` branch and bus wiring to App. The connected-play split (F6/U7) is cheapest before those lanes start.
