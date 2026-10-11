# Full-screen world map

Status: built on `exp/world-map`, 2026-10-11 (lanes A–E). Section 12 says where the build differs from this plan.

The playtest problem is simple: the map helps, but its fixed Journal-sized view makes it hard to explore. Give it the whole screen and let the player zoom and drag it.

The owner decided that the map leaves the Journal, everyone has it from the start, and **M opens the map**. It is a built-in tool, with no recipe, inventory item, quest unlock or class requirement. This plan replaces the UI decisions in [open-map.md §2.8](open-map.md#28-the-map-tab). The walked land, discovery and turning rules stay the same.

## 1. Move riding to V

**Recommendation: V toggles Ride / Get down. Runner-up: Z.** Both are unused in the current game. V is near WASD, reachable with the thumb or index finger without moving the whole hand, and keeps Q, E, R and F available for their current actions. Z is also close, but puts more work near the left pinky and Shift, which already dodges. These are ergonomic judgments, to check in a playtest; V is not claimed to be a universal mount convention.

Other games show why a separate mount key is reasonable, but do not supply a free key here. Guild Wars 2 uses M for its map and X for mount/dismount; this game already uses X to put furniture away. Elder Scrolls Online uses H for mounting; H already sends our mount home. Keep those existing actions rather than moving several controls to copy another game. Sources: [Guild Wars 2 controls](https://wiki.guildwars2.com/wiki/Controls), [ESO mount help](https://help.bethesda.net/app/answers/detail/a_id/2589/~/how-do-i-ride-a-mount-in-the-elder-scrolls-online%3F).

### Current key survey

This is the input actually in the worktree, including contextual keys that the Menu does not list. Keys can have different meanings when a panel or mode owns input.

| Keys / input | Current owner and action | Consequence |
| --- | --- | --- |
| WASD, arrows | `world-controls.ts`: walk; `homestead-placement.ts`: nudge furniture | Keep for walking; arrows/WASD pan only when the map viewport has focus. |
| E, Space | World action: talk/use/attack; placement confirms; dialogue advances/selects | Leave world actions alone; focused map buttons keep native Space/Enter activation. |
| F | Signature ability | Occupied. |
| R | Level-20 move; placement rotates furniture | Occupied, despite “ride” being a useful mnemonic. |
| Shift | Dodge; Shift+Tab reverses focus | Occupied. |
| M | Phaser capture, key registration and `toggleRide` listener | Remove all three mount bindings; App owns M for the map. No legacy M alias. |
| J, C, I | App: Journal, Character, Inventory | Keep; they can switch away from the map as with other panels. |
| G, then 1–5 | App: emote picker and choice | Keep; opening the map dismisses the picker. |
| 1–9, mouse wheel | World belt selection; picker consumes its digits first | Map gestures must never change the held tool. |
| B | `HomeBar.svelte`: enter Arrange where available | Keep; HomeBar is hidden/blocked under the map. |
| X, Delete, Backspace | Placement: remove furniture | Occupied contextually; reject X for riding to avoid a destructive double meaning. |
| Enter, E, Space | Placement confirm; dialogue replies; native buttons/forms | Keep ordinary focus behavior. |
| H | `avatar.ts`: send a led mount home | Keep, including the Go home key cap. |
| Q (`LET_GO_KEY`) | Fishing: let a landed fish go | Occupied; do not change fishing to free it. |
| L, P | `wilds/paths.ts`: lay stone/lift, lay plank; hold while walking | Occupied, even though absent from the main controls list. |
| Escape | App closes a panel or opens Menu; dialogue, placement and nested confirmations consume it first | Keep one owner per press. Map closes to the world, without also opening Menu. |
| Tab, Shift+Tab; arrows, Home, End | Focus trap; Journal/Character tabs, inventory grids and other selectors | Preserve their meanings outside the focused map viewport. |
| Backquote | App's development-only panel | Keep; not a mount candidate. |
| Left/right click; joystick, hold/tap to walk | World actions and touch movement | Block beneath the map. |

Phaser currently captures `SPACE,UP,DOWN,LEFT,RIGHT,W,A,S,D,E,F,R,M,SHIFT`. Change M to V in the capture and registered keys, and bind V to riding. Use a shared `RIDE_KEY = 'V'` in `src/content/controls.ts` for the control row and saddle key cap. Ride presses must ignore repeats, modifiers, text entry and blocked world input, as H already largely does. Recheck V and Z when the fights branch assigns any new keys.

### Every named mount key

Implementation must update these together:

- `src/game/scenes/world-controls.ts`: capture, key registration, listener and header comment.
- `src/game/entities/avatar.ts`: saddle `key`, H/M ownership comment, `toggleRide` and `mountUp` comments. H and the Go home button remain paired.
- `src/content/controls.ts`: V riding row and a separate M map row, with “Map button, top right” as its touch equivalent. `TOUCH_CONTROLS` derives from these rows.
- `src/game/context-buttons.ts`: the explanatory key examples; the generic button API needs no redesign. `src/lib/companions.ts` also names M in its riding comment.
- `e2e/companions.spec.ts`: all seven current `press('m')` ride/refusal cases become V presses, preserving stable, village, indoor and dismount checks. Add a check that M opens the map without changing riding state.
- `tests/controls.test.ts`: assert distinct M-map and V-ride rows and their touch equivalents. The brief points to `tests/world.test.ts`, but the current keyboard/touch assertions actually live in `tests/controls.test.ts`.
- `README.md` controls table; `docs/runtime-import-notes.md`; active riding guidance in `docs/design/crafts.md` and `docs/design/pets.md`. Mark older design claims as superseded where they also describe obsolete riding rules; do not rewrite historical reviews or released changelog entries.

## 2. One App-owned full-screen panel

**Add `'map'` to App's `Panel` union and render a new `src/ui/WorldMap.svelte` when selected.** Use the existing panel owner and `layers.ts` blocking rules. Do not add a second `mapOpen` flag. This gives the map the same account, lease, move and reload boundaries as other panels.

The visual shell fills the available viewport with parchment, a pinned header and toolbar, and a clipped map viewport. Use `100dvh` and safe-area padding. It is an overlay in presentation and a panel in App's state. Give it its own full-screen styles and reuse `focusTrap`; the current `Panel.svelte`/`sheet.ts` shell has a constrained sheet body and a header drag-to-dismiss gesture, which would compete with map gestures. Do not attach `sheet` to this map. Dragging any part of the map never dismisses it.

M, the HUD Map button and the close button use the same App transition. M toggles; Escape closes; J/C/I switch panels. Closing goes back to the world rather than restoring the Journal. Ignore repeated or Ctrl/Meta/Alt-modified M presses and text-field/contenteditable input. Mark the handled event `fsConsumed` as App already does for panel keys. Apply the same opening guards to the HUD callback as to M: dialogue, cinematic, account/lease/move/reload/ending blocks, naming/confirmation overlays, and placement own the screen. Finish Arrange before opening the map; do not discard an unfinished placement. Map controls cannot invoke mount, fishing, path or belt actions beneath them.

Opening dismisses emotes and transient HUD explanations. The covered HUD and touch controls must not remain pointer or Tab targets. Covering them visually alone is insufficient; use the existing input gates plus inert/hidden treatment appropriate to the overlay. Retain App's higher-priority account and transition layers above the map.

### The world underneath

**Use today's panel behavior, not a new scene-wide pause.** `WorldScene.update()` halts the hero and skips movement, enemy/projectile updates, gathering and other local world interactions while `uiBlocked()` is true. It still ticks cooldowns and play time, updates remote players/NPCs and some visuals, and keeps the link/presence alive. Phaser physics, timers and tweens are not globally paused by ordinary panels. The full-screen map inherits that behavior; opening it does not disconnect or stop the wick clock.

The local player normally stands still, so a live dot does not imply walking with the map open. It must still reflect corrections, teleports and area changes. Future server fights cannot be paused by this panel. The map must consume resulting state through the normal client flow without requesting a server pause or promising safety; the fights design owns that policy. Do not refactor combat to implement the map.

### Where it works

| Situation | Opening and player marker |
| --- | --- |
| Wilds, including Tangle/Whitequiet/Beyond | Show walked land and current position. Open centred on the player. |
| Village, Commons, home plot or cottage | Still open the Wilds map. State “You’re outside the Wilds”; omit the player dot and open at the Commons gate. The home/village coordinates must never be plotted as Wilds coordinates. |
| Other interiors or curated areas | Same outside-Wilds treatment. This release does not invent an indoor floor plan. |
| No walked chunks this wick | Keep the always-shown Tangle and existing empty-state explanation. The map is available before exploration. |
| Guest / no connected Wilds metadata | Open the full shell with a readable empty state explaining when land can be shown. Availability of the UI is not a promise of server data. |

“Centre on me” is disabled with a visible explanation outside the Wilds; “Show all” and a “Commons gate” action remain useful. If an area change happens while open, update the marker and message immediately without recentering a manually panned view. A world/account change clears the old view and cached snapshot.

### Offline and failed reads

`mapInput()` needs a link and a session Wilds view. `freshen()` already skips network reads when offline; chunks come from memory/device cache before the server. Preserve a successful, world-and-wick-scoped map snapshot through a temporary loss of connection and across map closings within that session. Show “Offline — showing the land already read” and allow zoom/pan. A missing chunk stays blank, with a partial-data message; one chunk failure must not clear the map.

A cold offline session with no Wilds metadata cannot reconstruct the map merely from chunk bytes. Show the existing “needs the Wilds read once this session” explanation and an explicit Retry button enabled on reconnect. Persisting complete metadata for cold offline maps is later work. When a known wick ends while offline, do not present its Beyond as current: remove expired turning-land data, retain only safely identified permanent Tangle data, and explain that a current read is needed. Never reuse a snapshot from another world or an old epoch as current terrain.

## 3. Zoom and pan

**Store the view as a centre in world-tile coordinates and a scale in CSS pixels per tile.** A map pixel is currently one tile; world game pixels are 16 per tile. Keep those units explicit in a new pure `src/lib/wilds/map-view.ts`, independent of DOM and Phaser.

For viewport width/height `W,H` and displayed frame width/height `Fw,Fh` in tiles, define `fit = min((W-32)/Fw, (H-32)/Fh)`. Clamp usable dimensions to positive values. Scale ranges from `min(0.5, fit)` to **16 CSS px/tile**, with fit itself capped at 16. This allows a large walked area to fit without limiting normal zoom to a tiny picture. Default opening scale is **4 px/tile**, shown as 100%; clamp it to the allowed range. Buttons and keyboard use quarter-octave steps, multiplying/dividing by `2^(1/4)` (four steps double/halve the scale).

- **Wheel:** zoom about the pointer. Normalize wheel delta modes and accumulate trackpad deltas so tiny events do not each make a full step. Wheel up zooms in. Handle it only inside the viewport, prevent its scrolling there with a non-passive listener, and coalesce paints to animation frames. Native Ctrl/Meta-wheel browser zoom remains available.
- **Drag:** left mouse button or one finger moves the sheet with the pointer. Use pointer capture, a small movement threshold and explicit pointer-cancel/lost-capture cleanup. Buttons and the details list do not start a map drag. No inertia in this release.
- **Pinch:** two touch pointers zoom continuously about their midpoint; midpoint movement also pans. Clamp scale continuously. When either finger leaves, rebase the remaining gesture so the map does not jump. Snap to a device-pixel-aligned translation after the gesture, without forcing a discrete scale jump.
- **Keyboard:** when the viewport is focused, arrows or WASD pan 48 CSS px per press; key repeat pans again. Shift increases that to 144 px. `+`/`=` and numpad Add zoom in; `-` and numpad Subtract zoom out, about viewport centre. Home centres on the player when available; End shows all. M/Escape remain App-owned. The same actions have visible buttons.

For a tile centre `(tx+0.5,ty+0.5)` and view centre `(cx,cy)`, its screen position is `(W/2,H/2) + scale * ((tx+0.5,ty+0.5)-(cx,cy))`. Invert this transform to find the world point under a pointer. After changing scale, solve for the new centre that keeps that world point at the same screen point, then clamp. Labels, marks and hit testing use this same transform.

**Clamp the view centre to the displayed frame's first/last tile centres on each axis.** This permits up to half a viewport of parchment past an edge, allowing an edge-positioned player to be centred, but prevents dragging the whole map out of view. When an axis of the scaled frame is smaller than the viewport, fix that axis at the frame midpoint; in that case exact player centring yields to keeping the small map visible. Show all uses `fit` and the frame midpoint. “Centre on me” keeps the scale and applies this clamp.

### Opening, remembering and live changes

Remember the chosen absolute scale in App-owned state for the current player/world session, so unmounting the panel does not reset it. Each opening recentres on the current player (or Commons gate), rather than restoring the previous pan. Do not save pan or add persistent preferences in this release. Reset scale on player/world change. Resizing preserves world centre and scale where possible, then clamps; neither resize nor newly walked chunks automatically selects Show all.

Current `MapTab.svelte` coalesces `EV.wilds` reloads to at most twice a second. Keep that ceiling for terrain/ways/discovery changes and keep `MAP_READ_EVERY_MS = 10_000` as the separate stale/ended-wick network-read throttle. Zoom and pan do not call `mapInput()` or make network requests.

Keep view state separate from each input/picture result. A new `mapFrame()` can move its origin when knowledge grows; recomputing world-relative positions preserves the view instead of shifting it by the new origin. Only a changed clamp range can move the centre. Coalesce invalidations while a load is in flight into one trailing load. Use an opening/world generation token so a slow result cannot replace a newer view or update an unmounted component. Preserve the last successful picture during loading, announce failures, and clean up event listeners, timers, gestures and animation frames on close.

The saved `session.state.position` is currently written about once a second and may lag when a panel opens. Add a small read-only position surface, `src/game/map-position.ts`, published from the active WorldScene before its blocked-input early return. Include actual area/world identity and current sprite coordinates; clear it when that scene shuts down. The map samples it only while mounted (up to 10 Hz, repaint only on changes), falling back to the saved position during scene startup. This needs no network message or save write. Keep fractional tile coordinates for a smooth dot; terrain is still tile-based.

Draw the player dot and “You” separately from terrain, rather than baking them into the large RGBA picture as today. Changes to the dot must not reread chunks or repaint all terrain. Do not follow the dot after a manual pan; recenter only on opening or an explicit action. A live position can still be drawn over blank land while its chunk loads.

### Labels and crisp drawing

Pass the actual zoom scale to the existing `fitLabels()`, not the old fitted sheet width divided by picture width. Text stays at a readable fixed CSS size; only anchor positions scale. Preserve the current ranking (you, ways, places, footprints, gate), finder lines and marks even when labels are omitted. Cull to the viewport plus a label-sized margin before fitting, so off-screen labels do not suppress visible ones. Align the label-box estimate with the actual displayed font size and multiline layout.

Paint terrain without smoothing (`imageSmoothingEnabled = false`), retain pixelated rendering where applicable, and account for device pixel ratio once. Round the final drawing translation to physical pixels to avoid blur. Fractional pinch scales necessarily give tiles differing screen widths; nearest-neighbour sampling preserves hard edges. DOM labels are not enlarged bitmap text.

## 4. Bound the drawing work

**Do not make a canvas as large as the zoomed world.** Today's `mapPicture()` allocates `width * height * 4` bytes for a dense tile-resolution rectangle and `MapTab` copies the RGBA buffer into ImageData. Scaling its CSS size would be fine for a small frontier, but a sparse, widely walked area could waste memory on a huge mostly blank rectangle.

Use a viewport-sized canvas with a backing resolution capped at `min(devicePixelRatio, 2)`. For example, a 1200×800 viewport at 2× uses about 15 MiB for one RGBA backing buffer, independent of travel distance. Keep terrain and moving marks in separate layers so marker updates do not redraw terrain.

Extract reusable ground/chunk painting and mark generation from `map-model.ts`; keep `mapPicture()` as a small-map compatibility/reference path for existing pixel tests. The production renderer, `src/ui/map-renderer.ts`, draws only intersecting chunk rasters at detailed scales. Cache native 24×24 chunk rasters by world/epoch/chunk and ground-change revision, with a bounded LRU of at most 1024 entries (about 2.25 MiB of raw RGBA, excluding browser object overhead). Clear inappropriate entries at epoch/world changes. Draw blank parchment/grid, frontier and glimpse analytically inside the viewport rather than allocating every intervening tile.

At overview scales, use cached chunk summaries and a spatial index; below one physical pixel per tile, choose coarser summaries and aggregate contributions into screen cells. Build/update these summaries when map input changes, not on each drag. Never generate a high-resolution raster for the full frame merely to shrink it. Display frame bounds remain based on all known chunks/ways/places, even when their pixels are outside the viewport. Do not fetch more land because the player pans into an unexplored region.

`mapInput()` currently loads all walked keys with unbounded `Promise.all` and locates discovered places by scanning their cell chunks. Bound chunk-load concurrency (start at 8), reuse immutable chunk/cache results, and cache discovered coordinates by world/epoch/place. A queued Wilds refresh should invalidate changed data rather than throw away every chunk raster. Labels should come from visible indexed marks so `fitLabels`' pairwise collision checks do not grow with every off-screen place.

Verify a synthetic sparse map of thousands of chunks, including negative coordinates and large gaps: canvas size and cache memory stay bounded; panning/zooming makes no reads; terrain raster work happens on input changes or newly visible detailed chunks. Aim for interaction frames within 16 ms on the desktop fixture and 33 ms on a representative phone. Record measurements and any remaining bottleneck before adding worker rendering; a worker is not a prerequisite.

## 5. Remove the Journal map page

`JournalPanel.svelte` returns to three pages: Quests, Papers and How do I…? Remove its MapTab import, map tab entry, map tabpanel, unused map icon/copy imports, and `'map'` in both `initialTab` and its local `Tab` union. Remove `'map'` from App's `journalTab` union separately; App's **Panel** union gains `'map'` instead. Preserve Journal quest-opening triggers and guide links: opening the world map must not count as opening the Journal.

Migrate `MapTab.svelte`'s content into the new map and remove that component once consumers have moved. Keep the Ways and Places lists, including “Found by”, in a details area rather than losing their readable information. Use `world-map` and `map-viewport` test IDs; preserve useful `map-canvas`, `map-ways` and `map-places` IDs. Retire `map-tab` and `journal-page-map` selectors.

There are currently no other direct map-tab links in game content; the concrete callers are the Journal and the map-opening steps in `e2e/paths.spec.ts` and `e2e/rumour.spec.ts`. Search again during implementation for `MapTab`, `journal-tab-map`, `journal-page-map`, map `initialTab` values and user-facing “Journal → Map” instructions. Update descriptive comments in `map-data.ts`, `map-model.ts`, `walked.ts`, `window.ts` and `content/open-map.ts`. Reuse the delivered `map-tab`/`icon-map-tab` art as the HUD map icon; its asset name does not require an atlas rebuild. Adjust its descriptive text in `open-map-art.ts` and `docs/art-request-open-map.md`.

Add supersession notes to `open-map.md` §2.8 and its map decisions, and update the active map/lamps roadmap wording in `plan.md`. Older reviews remain a record of what existed then.

## 6. Lamps and later map layers

**Lamps in 0.9 belong to the world map.** Replace the planned Journal Lamps tab in [lamps.md §2.6](lamps.md#26-ui) with a Lamps layer control and a ledger in the map's details area. The existing map terrain provides the held/unheld land, frontier and player view; add lamp marks and warm held-land shading there rather than creating a second SVG grid. The ledger keeps the planned short name, naming sentence, namer, distance, mage-lit mark and newest-first ordering. Selecting a lamp centres its mark. Phone: open the ledger as a details sheet while retaining the map behind it.

The future lamps pass must amend `lamps.md` decision 9, §2.6, empty-state wording, tab-icon request, lane/test references and the old “no map panel” baseline. Lamp naming/confirm UI stays in its own operation flow; viewing the map grants no lamp capability. These are migration instructions, not implemented lamp behavior in this release.

Separate terrain, marks/labels and readable details so later pins, party marks and lamp holds share the same coordinate transform and clipping. [magic.md](magic.md)'s “Sense the turning” should eventually provide an authorized party-only forecast layer with wick/expiry metadata, visually distinct from explored current land. Do not expose future terrain by fetching it speculatively. The “carter's map” wording in that design must be reconciled with the owner's built-in-map decision; no craft gate is added here. Pins, party sharing, forecasts and layer toggles ship with their own feature, not as empty placeholders now.

### Desktop minimap: a follow-up idea

The owner suggested a desktop minimap while this plan was being written. Keep it as an optional follow-up to the full-screen map, using the same world data, bounded renderer and live-position surface. A starting design is a roughly 160×160 view near the desktop HUD's top-right buttons, centred on the player, north-up, showing nearby walked terrain, a few important marks and the dot. Click/keyboard activation opens the full-screen map. Hide it under panels, cinematics and outside the Wilds, and offer a Menu preference to turn it off.

It should not have its own network polling, drag/zoom controls, discovery rules or global keys. A moving minimap is a reason to separate the player layer now, even though the full-screen panel holds movement. Check space against the quest card, menu buttons, banners and camera insets before choosing placement. It is desktop-only; the phone keeps its Map button and full-screen view. Default visibility, exact size and whether it joins this release remain owner questions. No minimap implementation is required to finish the core map.

## 7. Focus, touch and readable information

Use `role="dialog"`, `aria-modal="true"` and a visible “World map” heading. Reuse `focusTrap` with initial focus on a labelled, focusable viewport. Describe its keyboard controls through `aria-describedby`; do not use `role="application"`. The canvas has a meaningful image label and a text summary of current area/wick, offline state and whether the player is on the map. Ways/Places and the legend remain accessible text, independent of fitted visual labels. Do not announce each live dot movement; use a polite status region for loading, offline/retry and explicit zoom/centre actions.

Tab reaches Close, viewport, Zoom in/out, Centre on me, Commons gate, Show all and Details in a predictable order. Arrow/WASD handling belongs only to the focused viewport; tabs/lists/buttons retain native behavior. The existing `focusTrap` returns focus to another overlay when appropriate and otherwise blurs on close, deliberately avoiding a HUD button swallowing the next Space attack. Follow that actual behavior rather than changing focus globally for this feature; keep M and the HUD opener discoverable and test Space after closing. Respect reduced motion: no animated zoom or fly-to is needed.

At **360 px width**, use a compact header (title and a 44×44 Close target), a second toolbar row with 44 px targets for −, +, Centre and Show all, and a Details button in a further row if needed. “Commons gate” can be inside Details on phones. The map takes the remaining height. Ways, Places, explanations and legend scroll inside Details, not across the map. Details uses the map's existing focus boundary; do not add a competing focus trap. While details are expanded, keyboard map shortcuts apply only to its viewport, and gestures on the list scroll normally.

Use `touch-action: none` only on the map gesture surface, not the whole document or readable lists. Pinch and drag never scroll the page or trigger browser back navigation from the map's interior. Keep browser zoom available outside that surface, and retain button alternatives for every gesture. Handle rotation, safe areas and interrupted touches without retaining a stuck drag.

**HUD order:** Journal, Map, Character (desktop only), Inventory, Emote (when available), Menu. Map has accessible name “World map (M)”, tooltip “World map”, a desktop M key cap and the existing map art with a code-drawn fallback. Phones already omit Character, so the new live-world row has five 44 px buttons with four 6 px gaps: 244 px before outer padding. At 360 px, let that row occupy the full HUD width rather than squeezing it beside the quest text; put the goal row below it if necessary. Preserve `data-inset="hud"` measurement and verify landscape as well as portrait. Arrange remains in its existing bottom dock, not in this menu row.

## 8. Verification for implementation

This planning pass changes Markdown only. The following checks are acceptance work for the implementation.

| Level | Required cases |
| --- | --- |
| Pure view math: new `tests/wilds-map-view.test.ts` | Screen/world round trips at negative coordinates; wheel/pinch anchor invariance before clamping; zoom limits and four-step doubling; clamping on both axes, small-map centring, resize and origin changes. |
| Map model: `tests/wilds-map.test.ts` | Preserve ground/path/frontier/glimpse and finder behavior; separate hero marks from static painting; labels return as scale increases; off-screen labels cannot suppress visible ones; summaries never reveal unwalked terrain. |
| Data: `tests/wilds-ops.test.ts` and focused map-data cases | Preserve ended/stale wick and 10-second read coalescing; offline snapshot/partial chunks; retry and old-world/old-wick rejection; bounded load concurrency and stale-result protection. |
| Controls: `tests/controls.test.ts` | M is map, V is ride, H/Q unchanged; every control has its corresponding touch row. |
| E2E: new `e2e/world-map.spec.ts` | Open via M and HUD; full-screen bounds; M/Escape close once; J switches to the three-page Journal; typing/modifiers/repeat and blocked layers; default/reopened centre and remembered zoom; centre/show-all; wheel, drag, keyboard and two-pointer pinch; no attacks, path writes, belt changes or rides under the map. |
| E2E data/state | Live marker from a controlled correction without terrain reload; manual pan survives `EV.wilds` and frame expansion; no dot in village/home/interiors; guest/no-view, warm offline, expired wick and reconnect; focus trapped, background inert, Space after close and text list available. |
| E2E mobile/screens | 360 px portrait and short landscape: HUD button fits, map controls do not overlap, safe areas respected, details scroll, cancel/rebase pinch safely. Keep desktop and phone screenshots of labels and a named way. |
| Performance fixture | Sparse thousands-of-chunks input, bounded canvas/cache, no requests during interactions, measured drag/zoom times and no listener/timer accumulation after repeated open/close. |

Existing spec changes are concrete: `companions.spec.ts` moves riding presses to V; `paths.spec.ts` opens the map with M and expands Details for the named-way list; `rumour.spec.ts` does the same for “Found by”. Rename the `95-map-tab-way-*` screenshot names to full-screen-map names; review the existing finder screenshot too. Check `papers.spec.ts` and `papers-screens.spec.ts` for Journal tab order/layout regressions, and `touch.spec.ts` for the added HUD entry. The open-map walk/screen specs do not currently open the Journal map; run relevant regression coverage if position publication or HUD insets affect them.

Update `e2e/changed-map.json` to replace the MapTab path, map the new component/renderer/view/position files to `world-map.spec.ts`, and retain paths/rumour/companions and existing HUD/Journal regression mappings. Include `tests/layers.test.ts` if any blocking policy changes. Run `npm run verify` and the targeted Playwright specs during implementation; review screenshots through that implementation's normal workflow. This docs-only task opens no apps or browsers and runs no game tests.

## 9. Work lanes and fights overlap

Sizes are rough: S is about half to one focused day; M about one to three; L needs a further split. They include relevant tests, not just component code. These are implementation work divisions, not instructions to start agents during this planning pass.

| Lane | Size / dependency | Files it owns | Parallel with `exp/fights-design`? |
| --- | --- | --- | --- |
| A. View math | S; first | New `src/lib/wilds/map-view.ts`, `tests/wilds-map-view.test.ts` | Yes: isolated pure map files. Publish the centre/scale/viewport interface first. |
| B. Drawing and data | M; agree A interface | `src/lib/wilds/map-model.ts`, `src/game/wilds/map-data.ts`, new `src/ui/map-renderer.ts`, `tests/wilds-map.test.ts`, map-data additions in `tests/wilds-ops.test.ts` | Usually: no fights/server contracts. Coordinate if fights edits the shared Wilds test file; keep map-data additions in a dedicated file if needed. Split summaries/cache and data-loading changes if this grows past M. |
| C. Full-screen interaction | M; A, B's published drawing interface | New `src/ui/WorldMap.svelte` and local styles; component-level gesture/focus checks | Yes while developing in isolation. Depends on D for real App mounting and live-position input. |
| D. App, HUD, key and position integration | M; A/interface agreement, C for final hookup | `src/App.svelte`, `src/ui/Hud.svelte`, `src/ui/JournalPanel.svelte`, remove `src/ui/MapTab.svelte`; `src/content/controls.ts`, `src/game/scenes/world-controls.ts`, `src/game/entities/avatar.ts`, `src/game/context-buttons.ts`, `src/lib/companions.ts`; new `src/game/map-position.ts`, narrow `src/game/scenes/WorldScene.ts` publication; `tests/controls.test.ts` | **Coordinate/serialize shared client edits.** WorldScene, world-controls, avatar, HUD and App are plausible fights integration hot spots. Own one narrow patch and merge/rebase it against the agreed fights input/state interfaces. Do not change combat/pause semantics or event protocols here. |
| E. Acceptance and documentation | M; integrated D | New `e2e/world-map.spec.ts`; changes to `e2e/{companions,paths,rumour,touch,papers,papers-screens}.spec.ts` as needed, `e2e/changed-map.json`; `README.md`, `docs/runtime-import-notes.md`, `docs/design/{world-map,open-map,lamps,magic,plan,crafts,pets}.md`, `docs/art-request-open-map.md`; descriptive map comments in `src/{content/open-map,game/wilds/walked,game/wilds/window,game/wilds/open-map-art}.ts` | Docs and the new spec can proceed independently. Coordinate shared acceptance files, changed-map routing and screenshot baselines; apply comment-only source edits after their owning lane. |
| F. Optional desktop minimap | S–M; core accepted and owner scope decision | New `src/ui/MiniMap.svelte`, HUD/Menu preference and inset wiring, its focused tests; reuse A/B/D surfaces | Follow-up. HUD/Menu wiring overlaps client integration; isolated rendering can be explored separately. |

A and B can start independently after agreeing units; C can build against their interface while B finishes. D is the single integration owner, avoiding A/B/C all editing App or HUD. E can draft fixtures and docs early, then run acceptance after integration. Core map completion is A–E, with no server migration, protobuf, generated code or backend fight-rule work.

The fights worktree's brief has not been inspected here. Treat the listed shared files as likely overlap, not a guarantee about its lane ownership. Before implementation, exchange the actual touched-file lists and reserve the small WorldScene position-publication insertion. Server-only fights work in `server/**` can proceed alongside A–E; any client input, combat-state or forced-move changes must be integrated deliberately, especially because server combat may continue with the map open.

## 10. Owner decisions (2026-10-11)

- **Riding moves to V.**
- **The map opens close up on you** (4 px/tile, 100%), and your zoom is remembered between openings.
- **The desktop minimap comes later**, after the full-screen map ships.

## 11. Still open

The questions below were answered above where marked; 4 and 5 stay open for the fights and magic work:

1. **Mount key:** accept V, or prefer the Z runner-up? This plan uses V unless changed before implementation.
2. **Opening zoom:** does the proposed local 100% view (4 px/tile), remembered between openings, feel right in playtesting, or should the first opening show all walked land?
3. **Desktop minimap:** follow-up or part of this release; visible by default or opt-in? The suggested starting size is 160×160 near the HUD, subject to a layout check.
4. **Shared fights:** when server combat arrives, should a threat/hit automatically close the map, or should it stay open with combat feedback? Agree with the fights design; this map pass inherits current panel behavior and creates no server pause.
5. **Magic wording:** should “carter's map” become an upgrade/route-reading service for the built-in map? Its later forecast and route features must not take away everyone's basic map.

## 12. As built (2026-10-11)

Lanes A–E landed together. Where the build differs from the plan above:

- **Overview summaries.** Close in, the renderer draws each walked chunk in view from a cached
  24×24 raster (LRU, 1024 entries), as planned. It switches to the overview when more than 512
  chunk slots fit in the viewport, not at a fixed scale. The overview is one image of the whole
  frame's walked land, at most 1024 px a side: six pixels a chunk (a summary pixel for 4×4 tiles)
  when the frame is small enough, else a chunk a pixel, else the mean of several chunks a pixel.
  It's built when the input changes and drawn cropped to the view. That stands in for the
  per-region summaries and screen-cell aggregation: memory stays bounded (about 4 MiB for the
  overview at most) and a drag never builds anything. Ways and places are bucketed by 96 tiles,
  so a pan only looks at the marks near the view.
- **Your dot and the labels are DOM**, over one terrain canvas, not a second canvas. Labels are
  culled to the view (with a margin), turned into screen pixels and fitted with
  `fitLabels(…, 1)`. That's the same thing as passing the scale, because collisions only depend
  on relative positions.
- **Loading.** `mapInput()` is now `loadMap()`. It returns the input together with the world/epoch
  scope and the offline, partial, ended and missing states, so the component can word them.
  Chunks load eight at a time, a chunk whose terrain and ground changes are unchanged keeps its
  `MapChunk` (and its raster), and finders' places are cached per world, wick and place. A chunk
  that fails keeps its last picture from the same world and epochs.
- **The wheel zooms in whole quarter-octave steps.** Small trackpad deltas add up until they make
  a step. Ctrl/Cmd-wheel is left to the browser, as planned. On a Mac that also means a trackpad
  pinch zooms the page, not the map (a playtest question).
- **Narrow phones held upright:** the HUD's menu row gets its own row, with the goal line under
  it (`Hud.svelte`, `max-width: 480px` portrait). Short landscape puts the title and icon-only
  tools on one row, with Details beside the map.
- **Acceptance.** `e2e/world-map.spec.ts` covers opening and closing, the Journal switch,
  chords, repeats and typing, the remembered zoom, drag, wheel, keys, a two-pointer pinch with
  rebase, show all and centre, the live dot without a reload, a pan that survives `EV.wilds`, no
  world input under the map, and the 360 px portrait and landscape layouts. The offline, guest,
  ended-wick and other-world cases are unit tests (`tests/wilds-map-data.test.ts`), not browser
  tests.
