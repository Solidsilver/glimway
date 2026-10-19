# Applying the canon

Where `canon.md` has to land in the game and the docs, grouped into work packages that parallel
lanes can take without editing the same files. Written 2026-10-19 from a sweep of the tree at
`exp/lore-final` (dev `d42d811e`). Line numbers are hints; search for the quoted text.

## Rules for every lane

- **Text only.** No mechanic, id, flag, save key or quest step id changes. Item, quest and paper
  **ids** stay as they are even where a display name changes (saves depend on them).
- **Never promise [later] canon** (canon §13) as something a player can do now.
- **Terms and spellings** follow canon §12. Each lane fixes casing only in its own files:
  "the Lantern Road" (never lower case), "iron-oak" (sentence start "Iron-oak", never
  "Iron-Oak"), "the Whitequiet" for the place, "the Quiet" for winter (never "the White Quiet"),
  "the drift" lower case, "lamp stone" (no hyphen), item names in sentence case.
- **Blanket text rules still apply** (`tests/world.test.ts:186-230` and the copies listed in the
  sweep): dialogue lines ≤160 characters; no out-of-world words (habitica, xp, tasks, …) in
  world prose; no "ember(s)" in purse or witness copy.
- **Specs assert exact strings.** Before pushing, grep `e2e/` and `tests/` (and Go `*_test.go`)
  for every string you changed. E2E runs only in CI (push the `exp/*` branch); unit tests run
  locally with `npm test`.
- **Duplicated text changes together** (same package owns all copies): the Turning notice
  (`expansion-writing.ts` `TURNING_NOTICE_FORMAT`, `content/clock.go:104`, `src/lib/village.ts:69`,
  vectors), the naming template (`src/lib/lamp-naming.ts:74`, `server/internal/api/lamp_naming.go:274`),
  `THE_CUT` (`lamp-naming.ts`, `content/quests.json`, the paper), the `lamp-wick` blurb
  (`items.json`, `inventory.ts` `CRAFTED_BLURBS`), the lantern-post blurb (`items.json`,
  `expansion-writing.ts` `DECORATIONS_MATERIAL`), Carting Day (`CARTING_DAY_NOTICE`,
  `src/lib/village.ts:44`), "One glim the oil" (`seat-by-the-lamp.ts`, `room-spots.ts:161`,
  `quests.json:659`).
- **Papers are generated.** Edit `docs/lore/texts/*.md`, then `npm run papers`; never hand-edit
  `src/content/papers-text.ts` or `content/papers.json` (`tests/papers.test.ts:35-41`).

**No change needed** (checked): the Turning notice wording; the naming form and closings;
`THE_CUT`; the Keeper's hand quest's "runs on north past the Whitequiet" (matches canon §6.2);
the homing turncap ("still leaning toward town"); storm oil "kept for the old ways" (the Old
Ways are the later paired-lamp working); the Warden's mechanics and lines; `LAND_CHIP`; the
Wild/Common/Built words; Pell's origin ("sent me up from Tarrow").

---

## Work packages

| WP | Area | Files it owns | Tests to update |
|---|---|---|---|
| **A** | The Lantern Road, the opening, quests | `src/content/world.ts`, `src/content/quests/*.ts`, `content/quests.json`, `src/game/entities/world-talk.ts`, `src/game/entities/warden.ts`, `src/ui/Moments.svelte`, `src/App.svelte`, `index.html` | `tests/world.test.ts`, `tests/quests.test.ts`, `tests/residents.test.ts:79-80` (journal titles), `e2e/quest.spec.ts`, `e2e/goal.spec.ts`, `e2e/opening.spec.ts`, `e2e/polish.spec.ts`, `e2e/naming-screens.spec.ts` |
| **B** | Lamps, land, the crate, oil and ways home | `src/content/camps.ts`, `land-chip.ts`, `map-lamps.ts`, `lamp-naming.ts`, `open-map.ts`, `wilds-errors.ts`, `src/lib/communal-lamps.ts`, `lot-lantern.ts`, `wick-sap.ts`, `ways-home.ts`, `src/game/wilds/communal-lamps.ts`, `src/game/entities/homestead-talk.ts`, `homestead-placement.ts`, `homesteads.ts`, `village-life.ts` (Wick Tree lines), `content/homestead.json` (`lampNaming`), `content/wilds.json` (`words`) | `tests/camps.test.ts`, `camp-rules.test.ts`, `crate-picker.test.ts`, `trowel.test.ts`, `land-chip.test.ts`, `map-lamps.test.ts`, `communal-lamps.test.ts`, `ways-home.test.ts`, `lot-lanterns.test.ts`, `wick-sap.test.ts`, `lamp-naming.test.ts`, `wilds-paths.test.ts`, `e2e/camps.spec.ts`, `e2e/map-tiers.spec.ts`, `e2e/world-map.spec.ts` |
| **C** | People and the village | `src/content/residents.ts`, `talk.ts`, `pell.ts`, `heirlooms.ts`, `touches.ts`, `village-notices.ts`, `expansion-writing.ts`, `src/lib/village.ts`, `src/game/keepsakes.ts`, `src/game/room-spots.ts` | `tests/residents.test.ts` (calendar lines), `tests/pell.test.ts`, `tests/yard-talk.test.ts`, `tests/village.test.ts`, `tests/repairs.test.ts:97,108`, `e2e/residents.spec.ts`, `e2e/village.spec.ts`, `e2e/heirlooms.spec.ts` |
| **D** | The Wilds and the Echoes | `src/content/echoes.ts`, `src/game/wilds/*.ts` (not `communal-lamps.ts`), `src/game/lot-land.ts`, `content/gathering.json`, `src/ui/Hud.svelte` | `tests/wilds-runtime.test.ts`, `content/gathering_test.go`, `e2e/wilds-outer.spec.ts`, `e2e/warden.spec.ts:66` |
| **E** | Found texts, papers and design docs | `docs/lore/texts/*.md` (then `npm run papers`), `src/content/papers.ts`, `docs/lore/chronicle.md`, `docs/design/magic.md`, `docs/roadmap.md`, `docs/ideas.md` | `tests/papers.test.ts`, `tests/library-sections.test.ts`, `e2e/papers.spec.ts`, `e2e/papers-screens.spec.ts:87` |
| **F** | Items, help, loading and player docs | `content/items.json`, `content/crafting.json`, `content/furnishings.json`, `src/content/inventory.ts`, `loading.ts`, `controls.ts`, `guides.ts`, `src/lib/items.ts`, `README.md`, `CHANGELOG.md` | `tests/items.test.ts:64,184`, `tests/inventory.test.ts:25,44`, `e2e/inventory.spec.ts:65,71`, `e2e/homestead.spec.ts:231-240,435` |

Packages share no files. A and C both touch Mara and Orrin, but A owns the Lantern Road quest's
dialogue (`world.ts` `DIALOGUE`) and C owns everything residents say elsewhere. If a lane finds
a change outside its files, it notes it for the owning lane instead of making it.

---

## A. The Lantern Road, the opening, quests

| Where | Change |
|---|---|
| `world.ts:503` (the shrine lantern's naming) | "…before you the road east. Hold." → the road runs **north** from the shrine (canon §6.2), e.g. "before you the road north". |
| `world.ts:513` | "East of here the old road runs on toward Sallow Ford…" → "North of here…". |
| `world.ts:142` (Brackenwood card) | "where the lantern road once ran east toward Sallow Ford" → keep east (it leaves town east), capitalise: "where the Lantern Road once ran east, and then north to Sallow Ford". |
| `world.ts` `DIALOGUE`, `locations`, `ROOM_CARDS` | Casing sweep: "lantern road" → "Lantern Road" (`:139` eyebrow, `:326`, `:424`, `:529`). |
| `world.ts:140` | "Iron-oak" at a sentence start is fine; check others. |
| `world.ts:697` (hearth) | "Embers keep low…" is literal fire. Keep. |
| `world.ts:102-105` Ember Charm | Keep (owner, 2026-10-19). |
| `world.ts` journal `The Drift's Sway` / `Finding the Anchor` | Keep titles; body may name the state **unmoored** (canon §2.5). Journal titles are asserted in `tests/residents.test.ts:79-80`. |
| `quests/index.ts:83` `roadGoal` | "The lantern road glows again" → "The Lantern Road". |
| `content/quests.json:6,25` | Casing: "lantern road" → "Lantern Road". |
| `quests/keepers-hand.ts`, `quests.json:831,837` | No change (north past the Whitequiet matches canon). |
| `quests/signpost.ts` | No direction change: the signpost's east finger and the east gate stay. Check the glim line ("a bead of amber, cut to the Count House's measure") against canon §3.1 |
| `App.svelte:1069`, `index.html:7` | "Relight the old lantern road." → "Relight the old Lantern Road." |
| `Moments.svelte` | No change ("A road is a promise people keep renewing." fits). |

## B. Lamps, land, the crate, oil and ways home

| Where | Change |
|---|---|
| `camps.ts` `CRATE_LINES.collected` | "Signed out to you: {things}. The home pieces are in your pack." says "home pieces" for every kind of thing. → kind-neutral, e.g. "Signed out to you: {things}. It's all in your pack." Asserted in `tests/crate-picker.test.ts:38`. |
| `camps.ts` `CRATE_LINES` (lapsed, inCrate, notes) | Keep "Nothing is lost." |
| `camps.ts` `LAMP_OIL.needOil` | Matches canon. Keep. |
| `src/lib/communal-lamps.ts:102` | "An old lamp stone, burning again. It asks for no oil." Keep. |
| `homestead-placement.ts:409-411` (lantern-post name prompt) | A post on your own lot holds no land and gets a *name*, not a naming. Title "Name the lamp" → "Name the post"; body "Land only stays put where a named lamp holds it. What will you call this one?" → e.g. "A lantern post on your own ground. What will the sign call it?" Placeholder may keep "Ada’s Light". |
| `homestead-talk.ts:305` | "before the lantern road" → "Lantern Road". |
| `game/wilds/communal-lamps.ts:261` | Speaker "Lamp stone" is fine. |
| `content/homestead.json` `lampNaming` | No change. Check the site phrase "the old lamp stone" has no hyphen. |
| `content/wilds.json` `words.lampStone` | "A lamp stone, cold a long time… Mara might know what it was for." Keep. |
| `open-map.ts` `MAP_LABELS` | `frontier: "The drift"` → "The Whitequiet" (the frontier veil is the Whitequiet, canon §2.4). Check `e2e/world-map.spec.ts`. |
| `open-map.ts` `PATH_DONE` "The drift has turned. The land is new." | Keep. |
| `land-chip.ts`, `map-lamps.ts`, `ways-home.ts` | No change expected; casing sweep only. |

## C. People and the village

| Where | Change |
|---|---|
| `src/lib/village.ts:35-46` mark lines | "The White Quiet: cold is stillness." → "The Quiet: cold is stillness, and rest." "The Thaw", "The Green Hush", "The Shedding" stay. |
| `residents.ts:131, 198, 269` | "The White Quiet" → "the Quiet". Asserted by `tests/residents.test.ts:132-144` (`/^Smoke-wick\. The White Quiet/`). |
| `expansion-writing.ts` `BUILDER_NPC_DATA` | "I drove the lantern road twenty years." → "Lantern Road". |
| `expansion-writing.ts:85,95`, `WILDS_INNER`, `POIS`, `TRINKETS` | Casing sweep; check POI texts against canon §2.7 (trinkets are things meant to come home). |
| `expansion-writing.ts` `NEW_NPC_LINES` | Dead at runtime but tested; leave. |
| `expansion-writing.ts` `TURNING_NOTICE_FORMAT`, `SEASON_SHIFT_NOTICE` | No change. |
| `village-notices.ts` | "keep it lit through the Quiet" is right. Keep. |
| `heirlooms.ts:100` | "Worn dark from years on the Lantern Road." Keep. |
| `keepsakes.ts:45` | "the twins' birthday is at The Breaking": "the Breaking" lower-case "the" mid-sentence. |

## D. The Wilds and the Echoes

| Where | Change |
|---|---|
| `echoes.ts:258` `SITE_TEXT.nest` | "Dead Iron-Oak" → "Dead iron-oak". |
| `echoes.ts` `WILDS_OUTER` | "The deep drift. It turns every wick and keeps what it is given." Fits canon §2.4; keep. |
| `echoes.ts` settle lines | Check against canon §2.7 (owed lamp, filed away kindly). No change expected. |
| `game/wilds/terrain.ts:176`, `lot-land.ts:189` | "Break the old lamp-stone" → "lamp stone". `content/gathering.json:202` "Old lamp-stone" → "Old lamp stone". |
| `game/wilds/entities.ts:536` | "kept for the old ways" fits; keep. |
| `Hud.svelte:145` `unmooredWhy` | "Unmoored: the drift's sway holds you. Rest in lamplight or take a remedy." Matches canon; keep. |

## E. Found texts, papers and design docs

| Where | Change |
|---|---|
| `texts/dangers-of-the-white-quiet-pamphlet.md` | It is about winter: title and body "the White Quiet" → "the Quiet" ("On the Dangers of the Quiet"). File name and paper id stay. Asserted in `e2e/papers-screens.spec.ts:87`. |
| `texts/why-the-tide-fox-has-one-long-ear.md` | "the White Quiet of winter" → "the Quiet". Keep Elara's margin note: the drift isn't angry, which is canon. |
| `texts/twoford-almanac-silas-copy.md`, `joss-penhallow-field-notes-pencil-map.md` | "White Quiet" → "the Quiet" (winter) or "the Whitequiet" (place), by sense. |
| `texts/README.md:15,41,76,77,94`; `sallow-ford-chirurgeons-field-book.md`, `brackenwood-cutters-handbook.md`, `barge-knee-yields-report.md`, `oak-hall-edict-on-the-stealing-of-shade.md` | "Iron-Oak" → "iron-oak". |
| `texts/README.md` (description of Joss's letter) | "fortieth-birthday letter" but the letter says "I am forty-two today": make the description "forty-second". |
| `texts/README.md` header | "Canon reference: chronicle.md" → `canon.md`. |
| `docs/lore/chronicle.md` | Add a first line: superseded by `canon.md`; kept for history. |
| `src/content/papers.ts` `hint`s and `HANDOVER` | Check against canon; casing. `DESIGN[*].source.hook` is design notes, not player text. |
| `docs/design/magic.md` | Header note: the four class-locked crafts are superseded by the Practices (canon §5, later); the class is a lean. |
| `docs/roadmap.md` 0.15 | Name what waits at Dorrit's Span: Hesper, bound in the brackets (canon §4.6). |
| `docs/ideas.md` | Add: **worn ways** (a way walked several wicks running forgives a missed wick, canon §2.6); the **animal overhaul** (ordinary and corrupted animals; wisps and beetles explained then). |

## F. Items, help, loading and player docs

| Where | Change |
|---|---|
| `content/items.json:302` `lamp-wick` | "Lamp Wick" → "Lamp wick"; also `crafting.json:5`. Asserted in `tests/items.test.ts:64,184` ("2 Lamp Wicks"), `tests/inventory.test.ts:44`, `e2e/inventory.spec.ts:65`. |
| `content/items.json:951` `lantern-post`, `furnishings.json` | "Lantern Post" → "Lantern post". Asserted in `e2e/homestead.spec.ts:231-240,435`. Its blurb is duplicated in `expansion-writing.ts` (package C): agree the text with C, or leave the blurb. |
| `content/items.json` blurbs | Sweep for "lantern road", "Iron-Oak", "lamp-stone", "White Quiet". `storm-oil` "Kept for the old ways." stays. |
| `content/items.json:532` Ember Charm | Keep (owner). |
| `src/content/inventory.ts` `CRAFTED_BLURBS` | Keep the `lamp-wick` blurb identical to items.json. |
| `src/content/loading.ts` | Placeholders. Settled (owner): connect "Finding your way back…" (keep); land "Reading the lie of the land…" (keep); fetch "Trimming the wicks…"; decode "Filling the lamps…"; build "Speaking the namings…"; arrive "Parting the Whitequiet…"; paint "The land remembers you…". `loadingCopy.slow` "The road is still there." keep. |
| `src/content/controls.ts:32` | "home goods" is fine for the inventory tab. |
| `README.md:4, 102` | "lantern road" → "Lantern Road"; check the "Beyond the village" section (l.153-238) against canon (the Whitequiet, the Turning every wick). |
| `CHANGELOG.md` Unreleased `### For players` | It is live text (What's New). "Set your home pieces…" → plain wording; casing. Old entries stay as history. |

---

## Not in any package (decisions first)


- **Parked for 0.15 (owner):** new found texts, and new dialogue that only adds lore (Pell on his family crate, Elara as the sceptic about the Dark, the hollow-until-named lamp, the deed as a lot lantern's naming, the sap that witnesses). 0.13.0 gets fixes, renames and the lines listed here.
- The rogue ability "Echo" keeps its name until the Practices (owner).
- Any new mechanic in canon §13.
