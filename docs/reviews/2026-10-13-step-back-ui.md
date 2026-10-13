# Step-back review after 0.9: the UI

Snapshot **268c9b4** (detached at dev; 0.9 in progress: shared server-run camp fights, presence v3
frames, sharded fight scheduler, opt-in tick flush). Review of `src/ui`, `src/App.svelte`, the
styles and the UI-facing copy, with the e2e screen specs' expectations as the visual stand-in. This
follows `2026-10-11-step-back-game.md` (which covered the UI's splits) and
`2026-10-11-step-back-server.md`, and carries the outstanding parts of `2026-10-07-arch-ui.md`.
Review only: no implementation changes.

## Map: what changed since 2026-10-11 (a5005c3..268c9b4)

**The world map is the UI's one large new piece.** The Journal's Map tab is gone (`MapTab.svelte`
deleted); `WorldMap.svelte` (925 lines) plus `map-renderer.ts` (481) open full screen on M and on a
new HUD button, with the zoom kept per player and world in App (`mapScale`, `src/App.svelte:114`),
riding moved to V, and `content/controls.ts:16–37` holding both keys so the Menu list can't drift
(`tests/controls.test.ts:34`). The component reads well: one generation-fenced loader
(`WorldMap.svelte:82–141`), view/gesture code in `lib/wilds/map-view.ts`, terrain in the renderer,
you and labels as DOM, and a dev hook for playtests. Three review rounds show: the held-escape fix
(`src/App.svelte:622`), one guard for M and the HUD button (`mapAllowed`, `:673`), and `inert`
under the map (`:818`, `:842`).

**Smaller changes:** empty hands on the belt (0 key; `Icon.svelte` hand glyph, `lib/belt.ts`), the
phone camera kept clear of the belt ring in portrait (`play-insets.ts:73–79`), a portrait HUD
layout for narrow phones (`Hud.svelte:1022–1035`), and the c08-client adoption ordering reaching
the panels (`adoptHomeAnswer` in `CompanionsTab.svelte:88`, `homes.fresh()` in
`InventoryPanel.svelte:95`, `adoptMaterialCounts` in `YardPanel.svelte:157`). The large splits
remain outstanding; see F6.

### Status of the previous UI findings

| Previous | Status | Evidence at this snapshot |
|---|---|---|
| game F9 / arch F10 — large UI components | **not done** | Current F6. InventoryPanel and Hud grew again; the requested splits are still the right ones. |
| arch F1 — panel shell and action runner | **done** | `Panel.svelte`, `panel-state.svelte.ts` (`actionRunner`, `busVersion`) adopted across 17 panels; `InventoryPanel.svelte:24,74` uses both. Seven components still style `.msg` themselves — cosmetic residue, not a new finding. |
| arch F2 — shared panel CSS / notice cards | **done in shape** | `NoticeCard.svelte` serves PartyPrompt, LeaverNotice, LinkNotice and What's new; the promoted tokens are in `app.css`. I did not re-run jscpd; residual duplication is folded into F6. |
| arch F3 — five "is something on top?" lists | **done** | `src/ui/layers.ts` Layer/BLOCKS table; `App.svelte:559–574` builds one `layers` value. One gap in its own promises: F5 below. |
| arch F4 — connected-play flow in App | **partly** | `account-flow.svelte.ts` (508 lines) owns the state machine; App still owns bus wiring and session entry (`App.svelte:496–560`). |
| arch F5 — bus mirrors and polling | **partly** | The pack is still polled (`App.svelte:589`) and `GuidesTab.svelte:19` still ticks at 1 Hz. Cross-area; not reopened here. |
| arch F6 — error copy | **done, with one hole** | `src/content/errors.ts` holds the domain tables. The Wilds claim/relight table stayed in `src/game/wilds/entities.ts` and does not cover its own endpoint's codes — F2. |
| arch F9 — private-class measurement | **done** | `play-insets.ts` with `data-inset="hud|cluster|ring|pad|arrange"` markers. |
| arch F12 — duplicate localStorage helpers | **done** | `src/lib/local-json.ts` (`readJson`/`writeJson`) behind `inventory.svelte.ts:15` and `papers.svelte.ts:14`. |

## Findings (payoff relative to risk)

### F1. Reduced motion erases the only cooldown readout. P2

**Evidence:** `src/app.css:605–615` sets `animation-duration: 1ms !important` for every element
under `prefers-reduced-motion: reduce`. The ability and roll cooldowns are animated overlays whose
duration is set inline — `src/ui/Hud.svelte:362` and `:422`:
`<div class="sweep" style={animation-duration:${st.cooldown}s}>` — with `.sweep` shading `--p` per
cent of the slot (`:1224–1232`) and `@keyframes sweep` animating `--p` from 100% to 0%
(`:1246–1254`). An `!important` author rule beats an inline non-important declaration, so the
sweep falls to `--p: 0%` in one millisecond.

**Input:** turn on the OS "reduce motion" setting, press F (or tap Roll on a phone). For the whole
cooldown the slot shows no shading and no countdown: it looks ready while the game still refuses
the press. Nothing else on the slot carries timing — `dim` is about mana (`Hud.svelte:356`) and
`denied` is a brief refusal shake. The e2e checks of the sweep (`e2e/combat.spec.ts:119`,
`e2e/touch.spec.ts:39–41`, `e2e/abilities.spec.ts:93`) all run with motion allowed, so nothing
guards this.

**Change:** keep one-shot progress fills at their real duration under reduced motion — a slow
single fill is not the oscillating motion the setting is for. Smallest fix: have the reduced-motion
rule read a per-element custom property (`animation-duration: var(--anim-dur, 1ms) !important`,
with `style="--anim-dur:${st.cooldown}s"` on the sweep), or render a plain "Ns" countdown instead
of the sweep when reduced. Keep the global override for the pulsing/glowing loops.

**Guards:** one abilities case with `test.use({ reducedMotion: 'reduce' })` asserting the sweep is
still partly shaded a second into a cooldown (or that the countdown text is there).

**Size:** S. **Risk:** visual only.

### F2. Claim and relight refusals fall through to "The Wilds didn't answer" copy. P2

**Evidence:** `src/game/wilds/entities.ts:78–94` (`CLAIM_ERROR`) names `old-cycle`,
`entity-unavailable`, `already-claimed`, `not-defeated`, `condition-unmet`, `too-far-away`,
`not-in-wilds`, `epoch-ended`, `claim-rate-limited` and the transport codes. Anything else falls to
`unknown: 'The Wilds didn't answer. Nothing was taken — try again in a moment.'`
(`claimError`, `entities.ts:558–566`), and the relight path uses the same table
(`entities.ts:577`).

The two endpoints can return codes the table doesn't name. `wildsRelight`
(`server/internal/api/wilds.go:565–629`) returns `lantern-id-required`, `lantern-not-found` and
**`already-lit`** (`:576–591`), plus whatever `nearWilds` refuses: `not-in-wilds`,
**`beyond-frontier`**, `too-far-away` (`:242–256`). `wildsClaim` can return `invalid-claim`,
`entity-not-found` (`:377–393`) and `epoch-not-found`. Only the second and third of each pair's
codes are in the table.

**Interleaving:** two friends stand over a third friend's fallen lantern (the relight is a shared
moment by design — `FALLEN_HERO_LANTERNS.relitByFriend`, `content/expansion-writing.ts:279`). Both
press E within one round trip. The slower one gets `already-lit` and reads *"The Wilds didn't
answer. Nothing was taken — try again in a moment"* while the lit lantern is in front of them — and
"try again" invites a repeat press that fails the same way. The same fallback shows for
`beyond-frontier` although the client already has drift wording for that code on the path side
(`src/lib/wilds/paths.ts:139`).

**Change:** give the missing codes their own lines (`already-lit`, `lantern-not-found`,
`lantern-id-required`, `beyond-frontier` (the drift), `entity-not-found`, `invalid-claim`,
`epoch-not-found`, `world-access-denied`), and add a node test that every refusal code
`wildsClaim`/`wildsRelight` can send has wording, the way `content/errors.ts` documents its own
tables. Keep `condition-unmet`'s fight wording — it is only ever a camp fall's witness refusal
(`wilds.go:489–506`).

**Guards:** a table-completeness unit test plus the existing relight e2e extended with a
double-relight race asserting the second player's line is not the transport fallback.

**Size:** S. **Risk:** copy only.

### F3. The map's `inert` treatment misses the desktop action bar. P3

**Evidence:** `src/ui/Hud.svelte:319` puts `inert={covered}` on `.hud`, and `src/App.svelte:842`
wraps `TouchControls` in `<div class="covered" inert={mapOpen}>` — the comment at `:841` says the
touch pad is "out of reach, for pointers and assistive tech alike". The desktop action bar is a
third piece: it sits **outside** the `.hud` element (opened at `Hud.svelte:372`, after `.hud`
closes at `:353`) and outside the covered wrapper, so with the map open the E slot, the context
buttons, the belt, the ability slots and the roll are neither `inert` nor `aria-hidden`.

Pointers are safe (`.actionbar` is z-index 20 under the map's 40) and Tab is held by the map's
focus trap, so this is assistive-tech exposure — but the map is `role="dialog" aria-modal="true"`
only as far as the screen reader honours it, and the code elsewhere chose `inert` as belt and
braces. `e2e/world-map.spec.ts:89` and `:327` assert `inert` only on `[data-inset="hud"]`.

**Change:** put the action bar under the same `covered` treatment (pass `covered` into it, or wrap
`.hud` and `.actionbar` in one wrapper that carries `inert`), and extend the world-map spec to
assert the belt's container is inert while the map is up.

**Size:** S. **Risk:** low; the map is the only `covered` user.

### F4. The phone HUD menu row grew to five buttons; only the upright-narrow case has a rule, and nothing checks the top row's fit. P3

**Evidence:** phones now get journal, map, inventory, emote and menu (`Hud.svelte:279–315`), five
44 px buttons = 244 px, which the new portrait rule acknowledges ("up to five buttons, 244 px",
`:1022–1035`). The landscape rule (`:1037–1053`) keeps strip · goalbar · buttons on one row:
`grid-template-columns: auto minmax(0, 1fr) auto`, with the strip's bars at a fixed 130 px
(`:1047`).

On 568×320 — the repo's own "short landscape" size (`e2e/whats-new.spec.ts:89`) — the strip's
min-content (bars 130 px + glims + place) plus the 244 px button row leaves the goal bar around
30 px; its objective button (`min-width: 0`, `Hud.svelte:658–663`) then wraps word by word into a
tall column on a 320 px-tall screen. This is arithmetic from the CSS, **unverified visually** (no
screenshots in this environment). The layout guards look elsewhere: `e2e/touch.spec.ts:27–35`
checks the bottom cluster's fit and overlap, `e2e/onboarding-layout.spec.ts:4` runs 1200×760 and
390×844.

**Change:** in the short-landscape rule, give `.goalbar` a floor (`minmax(56px, 1fr)`) or drop
`.place`/chips there when height is short, and add a HUD-top-row fit/overlap assertion at 568×320
next to the touch-cluster one.

**Size:** S. **Risk:** visual, phone only.

### F5. A nested confirm doesn't own the keyboard: M/J/C/I replace the Menu under it. P3

**Evidence:** `ConfirmDialog.svelte:28–36` stops only Escape (`role="alertdialog"`). App's global
keys deliberately let J/C/I/M switch panels whenever a panel is up (`src/ui/layers.ts:58–62`: "A
panel doesn't block them"; `App.svelte:640–652`). `mapAllowed()` (`App.svelte:673–677`) is
documented as "the same guards: a talk, a cinematic, the account's screens, a reload, the ending,
a naming or **a confirm**, and arranging the home all own the screen first" — but the in-play
logout confirm is MenuPanel's own state (`MenuPanel.svelte:64, 249–260`) and never reaches the
`logout` layer (`App.svelte:563` tracks only App's title-screen `confirmLogout`).

**Input:** Esc → Menu → "Log out" → press M. `toggle('map')` unmounts the Menu and its unanswered
logout dialog with it, and the map opens. The question is silently discarded; J/C/I do the same
through the other panels.

**Change:** either have ConfirmDialog stop unhandled keys while it is up (it already does this for
Escape), or put the in-play confirm into `layers` and honour it in `mapAllowed`. Align the comment
with whichever is chosen. A table test of the layer predicates (the one arch F3 asked for) would
catch this class of drift.

**Size:** S. **Risk:** input gating; keep the behaviour change to letter keys inside a confirm.

### F6. The three big components are still the outstanding split. P3 (carried)

**Evidence:** line counts at this snapshot versus a5005c3: `App.svelte` **1,393** (1,352),
`InventoryPanel.svelte` **1,511** (1,510), `Hud.svelte` **1,295** (1,259),
`ConnectGuide.svelte` **1,048** (1,048); the map added `WorldMap.svelte` 925 and
`map-renderer.ts` 481, both well factored. What was asked for earlier has not changed: the
inventory's selected/hovered card, action chooser, grid, filtering, counts, roving keyboard cursor
and measurement still live in one file (`InventoryPanel.svelte:74–110` holds all of that state),
and Hud mixes the vitals card/strip, goal, chips, context bar, belt, moves and their layout CSS,
adding the map button and the portrait/landscape rows this round. App still owns the bus wiring and
session entry (`App.svelte:496–560`).

**Change:** the previously requested order stands and each split is its own lane: the inventory
detail/action card with an explicit selected-entry/action contract first, then Hud's action/touch
cluster, then App's connected-play lifecycle. Keep the models outside those components (the c08
adoption ordering is in place now and should stay as it is).

**Guards:** inventory, touch and onboarding-layout e2e; the camera/inset assertions
(`data-inset`); the map's covered-ness (F3).

**Size:** M, in three lanes. **Risk:** low per lane.

### F7. Three map strings live outside the copy module. P3

**Evidence:** `src/ui/WorldMap.svelte:437` inlines `'You're on the map.'` into the summary,
`:548` renders `{MAP_LABELS.seen}: none yet.` with the "none yet." literal in the markup, and
`:557` builds a legend label by `MAP_LABELS.foundBy.replace(' {name}', '…')`, repurposing the
"Found by {name}" template into a label that reads "Found by …". Every other map line is in
`MAP_LABELS` (`src/content/open-map.ts:70–110`), and the repo's convention (arch F6/F7) is that
player-facing strings live in `src/content`, where tests can see them.

**Change:** add `onMap`, `noneYet` and `foundByAnyone` to `MAP_LABELS` and use them.

**Size:** S. **Risk:** none.

## Text after shared fights: what I checked

The brief asked about claims, witnesses and camp messages. The claim and camp copy **does** match
the new rules: `CLAIM_ERROR`'s `not-defeated` ("The camp still stands — its fight isn't over.") and
`condition-unmet` ("You weren't near for that fight. The next one is yours to join.") line up with
the fall-record-plus-witness rule (`docs/design/shared-fights.md` 1.9;
`server/internal/api/wilds.go:489–506`), `camp-fights.ts:1–16` describes exactly what the client
does with the room's word, and the claim success line ("The camp is yours to rest at", with loot)
is unchanged in meaning. `src/content/witness.ts` is a different feature (the warden's naming, the
last lantern, an Echo settled) and carries no fight text. The camp walk-in lines
(`content/expansion-writing.ts:266–271`) are flavour and still read true. The controls list is
wired through `content/controls.ts` (M/V above), and the "What's new" player lines match
shared-fights decisions 6 and 8 ("one extra enemy per extra player, up to five"; the shared
workings) — with one looseness worth a copy pass someday: "Everyone who watched the fight can
claim their own reward" reads as *watched*, while the rule is "was covering the camp's chunk at
any point during the fight" (`shared-fights.md` decision 6), so a friend who arrives after the
fall cannot claim and is told so (`condition-unmet`). The one real gap in this area is F2.

## Done
