# Applying the canon

Where `canon.md` lands in the game and the docs for 0.13.0, as **three work packages** that
parallel lanes can take without editing the same file. Written 2026-10-19 from a sweep of the
tree at `exp/lore-final` (dev `d42d811e`) and revised after Sol's second-pass review
(`docs/reviews/2026-10-19-lore-review.md`, findings L1–L16). Line numbers are hints; search for
the quoted text.

## Rules for every lane

- **Text only.** No mechanic, id, flag, save key, quest step id, content key, error code or
  epoch kind changes. Display names may change; ids never do. See the guardrails table below
  (from Sol's review).
- **Never promise [later] canon** (canon §13) as something a player can do now.
- **Only your package's files.** Every file, including test files and generated outputs, has one
  owner below. If you find a needed change in another package's file, note it in your lane's
  summary for the orchestrator; don't make it.
- **Shared wording is fixed here.** Where the same text lives in two packages' files, this map
  gives the final text verbatim (section "Agreed text"). Use it exactly.
- **Terms and spellings** follow canon §12, in your own files: "the Lantern Road" (never lower
  case), "iron-oak" ("Iron-oak" at a sentence start; never "Iron-Oak"), "the Whitequiet" for the
  place, "the Quiet" for winter (never "the White Quiet"), "the drift" lower case, "lamp stone"
  in prose (no hyphen), "the Commons" (never "the Carters' Apron" in display text).
- **Blanket text rules still apply** (`tests/world.test.ts:186-230` and its copies): dialogue lines
  ≤160 characters; no out-of-world words (habitica, xp, tasks, …) in world prose; no "ember(s)"
  in purse or witness copy.
- **Specs assert exact strings.** Grep `e2e/`, `tests/` and Go `*_test.go` for every string you
  change, and update the assertions in the test files your package owns. E2E runs only in CI
  (push the `exp/*` branch); unit tests run locally with `npm test`.
- **Papers are generated** by P3 alone: edit `docs/lore/texts/*.md` (and the titles in
  `docs/lore/texts/README.md`), then `npm run papers`. Never hand-edit `src/content/papers-text.ts`
  or `content/papers.json` (`tests/papers.test.ts:35-41`).

### Identifier guardrails (from Sol's review)

| Keep unchanged | Display text that may change |
|---|---|
| `lamp-wick`, `lantern-post`, `iron-oak`, `homing-turncap`, `knotted-halter`, `road-nails` and every other item id | Item `name`/`blurb` fields. Ids are stored in stacks, instances, furnishings, mail and recovery entries. |
| Gathering target `lamp-stone`, site ids `lamp-stone:<cx>:<cy>`, enum and art keys | "Old lamp-stone" / "Break the old lamp-stone" display strings only. |
| `lantern-road`, its step and event ids (including `guardian-defeated`), `keepers-hand` | Quest prose; call the Warden "settled" in display text. |
| `dangers-of-the-white-quiet-pamphlet.md` and its filename-derived paper id | The README display title and the body; not the file name or design key. |
| `unmoored:felt`, `unmoored:cleared`, `keeper:hand`, `paper:*`, `returned:*` flags | Prose around them; no new reward or progression keys. |
| `words.drift`, `beyond-frontier`, `commons` / `in:commons:*`, `still`, `wick` | The displayed phrases only; JSON keys, error codes, room ids and epoch kinds stay. |

**No change needed** (checked): the Turning notice wording; the naming form, template and
closings; `THE_CUT`; the Keeper's hand quest's "runs on north past the Whitequiet"; the homing
turncap ("still leaning toward town"); storm oil "kept for the old ways"; the Warden's mechanics
and lines; `LAND_CHIP`; the Wild/Common/Built words; Pell's origin; the Ember Charm (owner);
the rogue ability "Echo" (owner).

**Parked (owner):** new found texts, and new dialogue that only adds lore (Pell on his family
crate, Elara as the sceptic, the hollow-until-named lamp, the deed as a lot lantern's naming,
the sap that witnesses). 0.13.0 gets fixes, renames and the lines listed here.

---

## The packages

| | Area | Files it owns | Test files it owns |
|---|---|---|---|
| **P1** | The story, quests, people and village | `src/content/world.ts`, `src/content/quests/*.ts`, `content/quests.json`, `src/content/residents.ts`, `talk.ts`, `pell.ts`, `heirlooms.ts`, `touches.ts`, `village-notices.ts`, `expansion-writing.ts`, `witness.ts`, `src/lib/village.ts`, `src/game/keepsakes.ts`, `src/game/room-spots.ts`, `src/game/entities/world-talk.ts`, `src/game/entities/warden.ts`, `src/ui/Moments.svelte`, `src/App.svelte`, `index.html` | `tests/world.test.ts`, `quests.test.ts`, `residents.test.ts`, `pell.test.ts`, `yard-talk.test.ts`, `repairs.test.ts`, `glims.test.ts`, `witness.test.ts`; `e2e/quest.spec.ts`, `goal.spec.ts`, `opening.spec.ts`, `polish.spec.ts`, `naming-screens.spec.ts`, `residents.spec.ts`, `heirlooms.spec.ts`, `quests-page.spec.ts`, `coop.spec.ts` |
| **P2** | Lamps, land, the crate, the Wilds and the Echoes | `src/content/camps.ts`, `land-chip.ts`, `map-lamps.ts`, `lamp-naming.ts`, `open-map.ts`, `wilds-errors.ts`, `echoes.ts`, `src/lib/communal-lamps.ts`, `lot-lantern.ts`, `wick-sap.ts`, `ways-home.ts`, `src/game/wilds/*.ts`, `src/game/lot-land.ts`, `src/game/entities/homestead-talk.ts`, `homestead-placement.ts`, `homesteads.ts`, `village-life.ts`, `unmoored.ts`, `src/ui/Hud.svelte`, `content/homestead.json`, `content/wilds.json`, `content/gathering.json` | `tests/camps.test.ts`, `camp-rules.test.ts`, `crate-picker.test.ts`, `trowel.test.ts`, `land-chip.test.ts`, `map-lamps.test.ts`, `communal-lamps.test.ts`, `ways-home.test.ts`, `lot-lanterns.test.ts`, `wick-sap.test.ts`, `lamp-naming.test.ts`, `wilds-paths.test.ts`, `wilds-runtime.test.ts`, `wilds-rumour.test.ts`, `wilds-map.test.ts`, `unmoored.test.ts`, `ui-feedback.test.ts`; `content/gathering_test.go`; `e2e/camps.spec.ts`, `map-tiers.spec.ts`, `world-map.spec.ts`, `open-map.spec.ts`, `paths.spec.ts`, `wilds-outer.spec.ts`, `warden.spec.ts` |
| **P3** | Found texts, papers, items, loading lines, help and docs | `docs/lore/texts/*.md` (incl. `README.md`), `docs/lore/chronicle.md`, generated `src/content/papers-text.ts` and `content/papers.json` (via `npm run papers`), `src/content/papers.ts`, `content/items.json`, `content/crafting.json`, `content/furnishings.json`, `src/content/inventory.ts`, `loading.ts`, `controls.ts`, `guides.ts`, `src/lib/items.ts`, `README.md`, `CHANGELOG.md`, `docs/design/magic.md`, `docs/roadmap.md`, `docs/ideas.md` | `tests/papers.test.ts`, `library-sections.test.ts`, `items.test.ts`, `inventory.test.ts`, `furnishings.test.ts`, `village.test.ts`, `seasons.test.ts`; `e2e/papers.spec.ts`, `papers-screens.spec.ts`, `items.spec.ts`, `gifts.spec.ts`, `inventory.spec.ts`, `village.spec.ts`, `homestead.spec.ts`, `review5-fixes.spec.ts`, `yard.spec.ts`, `lot-lantern.spec.ts`, `playtest1.spec.ts` |

Not to be edited by any package: `content/vectors/*`, `server/` (no server text changes in
0.13.0), `content/abilities.json`, `content/rooms.json`, `content/projects.json`,
`content/repairs.json`. A file not listed belongs to no package; if a lane needs one, it asks.

There is no ordering dependency between the packages. After all three merge, the integration
run is the full unit suite plus the full E2E suite on dev.

---

## Agreed text (verbatim, shared across packages)

**A1. Item and furniture names in sentence case (canon §12, L8).** P3 changes them in
`items.json`, `furnishings.json` and `crafting.json`. Home-good names in `items.json` must equal
the `furnishings.json` names (`src/lib/items.ts:98` and `content/items.go:211` reject a
mismatch), and recipe names follow their items (e.g. `crafting.json:5` and `:114` for Lamp wick).
P1 changes the same names where `expansion-writing.ts` repeats them (`DECORATIONS_*`,
`TRINKETS`, `MORE_TRINKETS`, `MATERIALS`). The exact forms:

| Now | Becomes |
|---|---|
| Amber Sconce, Beeswax Candle, Braided Rug, Braided Oval Rug, Carved Bed, Display Stand, Iron Lantern, Lantern Post, Oak Table, Potted Fern, Reading Chair, River Glass Bead, Short Bookshelf, Spare Bootlace, Stone Hearth, Tin Whistle, Tool Rack, Wash Basin, Whittled Fox, Wooden Stool, Work Glove, Woven Basket | Amber sconce, Beeswax candle, Braided rug, Braided oval rug, Carved bed, Display stand, Iron lantern, Lantern post, Oak table, Potted fern, Reading chair, River glass bead, Short bookshelf, Spare bootlace, Stone hearth, Tin whistle, Tool rack, Wash basin, Whittled fox, Wooden stool, Work glove, Woven basket |
| Knotted Ox-Halter, Stamped Road-Nails | Knotted ox-halter, Stamped road-nails |
| Lamp Wick, Wooden Peg, Oilcloth Wrap, Keeper's Twists, Keeper's Twists (oil) | Lamp wick, Wooden peg, Oilcloth wrap, Keeper's twists, Keeper's twists (oil) |
| P3 only: Bread Oven and Hearth, Bread Rack, Clerk's Desk, Counting Stool, Deed Pigeonholes, Deed Table, Elara's Desk, Flour Handprint Board, Flour Sack, Flour Sifter, Flowering Plant, Gear Train, Mending Bench, Oven Peel, Patchwork Runner, Rag Rug, Reading Nook, Reading Table, Sack Hoist and Hatch, Short Side Bookshelf, Side Chair, Side Doorway, Silas's Counter, Small Table, Sponge Bowl on a Stool, Tallow Pot on its Stand, Tall Bookshelf, Tall Side Bookshelf, Tally Board, Timber Rack, Wall Peg, Wall Pegs with Tools, Wall Shelves, Wall Tools | The same in sentence case ("Bread oven and hearth", "Clerk's desk", "Silas's counter", "Sponge bowl on a stool", …) |
| Section Sign: Field Notes / Histories / Recipes / Stories | Section sign: field notes / histories / recipes / stories |

**Unchanged:** The Empty Chair (a ritual name; `e2e/playtest1.spec.ts:333`), Ember Charm
(owner), Closure Night lamp, Wick Tree sap, and place and POI names (Old Shrine, Mossy Arch,
Fallen Waystone, Frozen Pond, Abandoned Cart, Hearthwick Commons, The Tangle). Dialogue speaker
labels ("Reading Table", "Sack Hoist", "Sponge Bowl" as speakers in P1's quest files) are
nameplates, not item names: leave them.

**A2. The lantern post (L7).** A post on your own lot widens the yard you can build in. It
holds no Wilds land and gets a sign-name, not a naming.

- `content/items.json` `lantern-post` blurb (P3): **"A lantern post for your own ground. Its light
  widens the yard you can build in, and it takes a name for its sign."**
- `src/content/expansion-writing.ts` `DECORATIONS_MATERIAL` `lantern-post` blurb (P1): **"Squared
  oak, an amber lamp on the crossbar. Its light widens the yard you can build in, and it takes a
  name for its sign. Each one costs more than the last."**
- `src/game/entities/homestead-placement.ts:409-411` name prompt (P2): title **"Name the post"**;
  body **"A lantern post on your own ground. What will its sign say?"**; placeholder unchanged.

**A3. Unmoored (L6).** Exposure is deep in the Tangle (or a Turning). Recovery is rest on safe
town or home ground, or a remedy.

- `src/ui/Hud.svelte:145` `unmooredWhy` (P2): **"Unmoored: the land won't hold still around you.
  Rest on safe ground in town or at home, or take a remedy."** Update `e2e/warden.spec.ts:67`
  (P2) to match.
- `src/content/world.ts` journal "The Drift's Sway" (P1): keep the title; body **"Deep in the
  Tangle the woods began to sway and the ground went soft underfoot. Not a storm: the land
  letting go of me for a while."**
- `src/content/world.ts` journal "Finding the Anchor" (P1): keep the title; body **"The edges
  settled and the ground stood still again. Rest on safe ground, or a remedy: the world remembers
  when you remind it."**

---

## P1. The story, quests, people and village

| Where | Change |
|---|---|
| `world.ts:503` (the shrine lantern's naming) | "…before you the road east. Hold." → the road runs **north** from the shrine: "before you the road north". |
| `world.ts:513` | "East of here the old road runs on toward Sallow Ford…" → "North of here…". |
| `world.ts:142` (Brackenwood card) | → "…where the Lantern Road once ran east, and then north to Sallow Ford…". |
| `world.ts` (`:139` eyebrow, `:326`, `:424`, `:529`), `quests/index.ts:83` `roadGoal`, `content/quests.json:6,25`, `App.svelte:1069`, `index.html:7` | "lantern road" → "Lantern Road". |
| `world.ts` journals "The Drift's Sway", "Finding the Anchor" | Bodies per **A3**. |
| `world.ts:697` (hearth "Embers keep low…") | Literal fire. Keep. |
| `quests/signpost.ts`, `quests/keepers-hand.ts`, `quests.json:831,837` | No change: the east finger, the east gate and "north past the Whitequiet" all match canon. |
| `src/lib/village.ts:35-38` `MARK_NOTES` (L13) | Mudrise **"The Thaw: meltwater, mud, and the river high in its bed."**; Carting **"The Green Hush: long light and easy roads."**; Amberfall **"The Shedding: the woods drop what they're done with."**; Quiet **"The Quiet: cold is stillness, and rest."** |
| `residents.ts:128-131` Elara's `mark` lines (L13) | Mudrise **"{wick}-wick, Mudrise. Meltwater everywhere, and the Turning brings the paths up sodden. On the flood, we'd say."**; Carting **"{wick}-wick, the Green Hush. Slack water, we'd say: the Turnings bring up gentle country. My tables are bored."**; Amberfall **"{wick}-wick, Amberfall. The Wilds are shedding what they're done with. I recalibrate every wick, and still lose a stone a Turning."**; Quiet **"{wick}-wick. The Quiet: cold is stillness, and even the outer Wilds come up hushed. A good season for sums."** Update `tests/residents.test.ts:133-135`. |
| `residents.ts:198, 269` | "The White Quiet" → "the Quiet". |
| `expansion-writing.ts:224-225` `WILDS_INNER`, the Tangle card (L3) | tagline **"The scar of a stormy night. It keeps its torn shape."**; description **"Iron-oak roots and sudden drops, torn up by a stir thirty years ago. The old road ran through here once. The land here doesn't turn: it holds the shape that night left."** |
| `expansion-writing.ts` `DECORATIONS_*`, `TRINKETS`, `MORE_TRINKETS`, `MATERIALS` | Names per **A1**; the lantern-post blurb per **A2**. |
| `expansion-writing.ts` `BUILDER_NPC_DATA`, `:85, 95` | "lantern road" → "Lantern Road". |
| `expansion-writing.ts` `NEW_NPC_LINES` | Dead at runtime but tested; leave. |
| `keepsakes.ts:45` | "at The Breaking" → "at the Breaking". |
| `witness.ts`, `heirlooms.ts`, `talk.ts`, `pell.ts`, `touches.ts`, `village-notices.ts`, `room-spots.ts` | Casing sweep only. |

## P2. Lamps, land, the crate, the Wilds and the Echoes

| Where | Change |
|---|---|
| `camps.ts` `CRATE_LINES.collected` | "Signed out to you: {things}. The home pieces are in your pack." → **"Signed out to you: {things}. It's all in your pack."** Update `tests/crate-picker.test.ts:38`. |
| `camps.ts` `CRATE_LINES`, `CRATE_WORDS` (L5) | Keep "Nothing is lost." Make sure nothing says a lot's backland goes to Pell's: its pieces go to home storage and its plants come back as seeds in the shared chest; only paths laid there go to Pell's (canon §3.8). Camp lines stay. |
| `homestead-talk.ts` lot lantern lines, `src/lib/lot-lantern.ts:26-31` (L5) | If a line says the backland's things go to Pell's, correct it to home storage and seeds. Do not change where things go. |
| `homestead-placement.ts:409-411` | Per **A2**. |
| `homestead-talk.ts:305` | "before the lantern road" → "Lantern Road". |
| Frontier wording (L4): `content/wilds.json:1136` `words.drift`; `:1215` rumour phrase; `src/content/open-map.ts:89` `MAP_LABELS.frontier`; `:118` `legendBeyond`; `src/content/wilds-errors.ts:15` `beyond-frontier` | In order: **"The Whitequiet closes in here. Only a lit camp pushes it back."**; **"Out near the Whitequiet's edge."**; **"The Whitequiet's edge"**; **"Past the Whitequiet's edge"**; **"That place is past the Whitequiet's edge."** Keys and codes stay. Update `e2e/open-map.spec.ts:306`, `tests/wilds-rumour.test.ts:13` and `e2e/world-map.spec.ts` as needed. |
| `open-map.ts:158`, the Wend card (L13) | "It finds a new course every wick." → **"It keeps its bed; the land along it turns every wick."** |
| `open-map.ts` `PATH_DONE` "The drift has turned. The land is new."; `wilds.json` `words.turned`, `words.opened` | Keep. |
| `Hud.svelte:145` | Per **A3**; update `e2e/warden.spec.ts:67`. |
| `echoes.ts:258` `SITE_TEXT.nest` | "Dead Iron-Oak" → "Dead iron-oak". |
| `game/wilds/terrain.ts:176`, `lot-land.ts:189` | "Break the old lamp-stone" → "Break the old lamp stone". `gathering.json:202` "Old lamp-stone" → "Old lamp stone" (the key `lamp-stone` stays). |
| `src/lib/communal-lamps.ts:102`, `land-chip.ts`, `map-lamps.ts`, `ways-home.ts`, `wick-sap.ts`, `village-life.ts`, `homestead.json` `lampNaming` | No change expected; casing sweep only. |
| `game/wilds/entities.ts:536` "kept for the old ways" | Keep. |

## P3. Found texts, papers, items, loading lines, help and docs

**The calendar for the found texts (L10, L14).** A wick has seven days: dates run from day 1 to
7, never higher. A Turning notice is dated day 7 (the game posts it on the wick's last day).
Keep each text's order of entries.

| Event | Date |
|---|---|
| Oil shortfall entries | Amber-wick and Leaf-wick, days 1–7 |
| Hollis and Wenna argue; the road burns through its oil | Smoke-wick and Quiet-wick, days 1–7 |
| The first storm; the closure; the mark is cut | **Quiet-wick 7th** (Closure Night) |
| The lull (nine calm days forecast) | from Thaw-wick 1st |
| The Six leave at dawn; Tam's hand | **Thaw-wick 6th** (the sixth day of the lull, the first day out) |
| The stir; the bridge breaks | **Thaw-wick 7th** (the seventh day of the lull) |
| The Warden built (eleven days) | Mud-wick into Bud-wick, that spring |

| Where | Change |
|---|---|
| `texts/ashwatch-ledger-excerpts.md:9-29` | Redate per the calendar (Amber-wick 3rd may stay). "Five days of slack calm… At dawn they went" on Thaw-wick 6th; the closure entry on Quiet-wick 7th; the Warden entry ("Eleven days") in Bud-wick. |
| `texts/nan-greer-trail-journal.md:7,18` (L14) | Injury heading → **"The sixth day of the lull, our first out. Or so Hollis says; I lost count in the white:"**; storm heading → **"The day it came (the seventh, by Hollis's count; I had stopped counting):"**. The rest stands. |
| `texts/notices-from-the-board.md` (L3, L10) | Redate: the first notice to Amber-wick 7th; "the day the mark was cut" to Quiet-wick 7th; "three weeks after the storm" to Bud-wick 7th; "twenty years ago" to Smoke-wick 7th; "this year" to Mud-wick 7th. Remove claims that the Tangle or the Lantern Road turns or drifts: the notices say **the outer Wilds** turn, and the road past the Tangle lies dark and unheld. Keep Wenna's line "the timetable does not stop because we are grieving". |
| `texts/adas-oil-receipts.md:9` | "Leaf-wick 17th (One week after the storm)" → **"Mud-wick 7th (one wick after the second storm)"**. |
| `texts/failed-grid-of-sector-4.md` (L10, L13) | Date "Twenty-two years ago" → **"Thirty-four years ago, in the Weir Years"** (the drift still ran then). Redate the days into seven-day wicks (e.g. Bloom-wick 4th, 6th; Light-wick 1st, 3rd, 5th). |
| `texts/guild-of-cartographers-invoice.md` (L13) | Date "Last Autumn" → **"Thirty-three years ago, in Leaf-wick"**. The moving river and ferry stand as history. |
| `texts/wandering-orchard-magistrate-ruling.md` (L13) | "(Year 134)" → **"(Year 118)"**: before the Two Storms (the town's Year 124 is the storm year). "Slow drift" stands as history. |
| `texts/joss-penhallow-field-notes-pencil-map.md` (L13, L15) | Rule 2 is what Joss learned running the road before the storms: open it with **"When I ran the road, the flesh of the woods wandered."** and put its two bullets in the past tense ("folded shut", "flattened out"); "during the White Quiet" → "in the Quiet". Rule 4 is about **cowls**: title **"Trust the Cowls"**; "A turncap spins with the wind…" → **"A chimney cowl spins with the wind…"**; "mark which way its cap leans" → **"mark which way its cowl leans"**. |
| `src/content/papers.ts:127` hint/hook (L15) | "whose turncap leans toward Sallow Ford" → "whose cowl leans toward Sallow Ford". |
| `texts/note-in-the-linseed-box.md:4` (L11) | "Eight years ago." → **"Two winters ago."** The twenty-seven foxes stay. |
| `texts/dangers-of-the-white-quiet-pamphlet.md` and `texts/README.md:77` (L9) | It is about winter: title **"On the Dangers of the Quiet"** in both the README link label and the H1; body "the White Quiet" → "the Quiet". File name and paper id stay. Update `e2e/papers-screens.spec.ts:87`. |
| "White Quiet" elsewhere in `texts/` (L9) | `README.md:41`; `why-the-tide-fox-has-one-long-ear.md` (both, incl. `:17`); `twoford-almanac-silas-copy.md`; `deed-of-sale-commons-plot.md:11`; `fauna-of-the-slack-water.md:12,18`: "the Quiet" for the season, "the Whitequiet" for the place, by meaning. Keep Elara's margin note (the drift isn't angry). |
| `texts/README.md:15,76,94`; `sallow-ford-chirurgeons-field-book.md`, `brackenwood-cutters-handbook.md`, `barge-knee-yields-report.md`, `oak-hall-edict-on-the-stealing-of-shade.md` | "Iron-Oak" → "iron-oak". |
| `texts/README.md` (Joss's letter row) | "fortieth-birthday letter" → "forty-second-birthday letter" (the letter says forty-two). |
| `texts/README.md` header | "Canon reference: chronicle.md" → `canon.md`. |
| Then | `npm run papers`, and commit both generated files. |
| `docs/lore/chronicle.md` | First line: superseded by `canon.md`; kept for history. |
| `src/content/papers.ts` `hint`s, `HANDOVER` | Casing; check against canon. `DESIGN[*].source.hook` is design notes. |
| `content/items.json`, `furnishings.json`, `crafting.json`, `src/content/inventory.ts` `CRAFTED_BLURBS` | Names per **A1**; the lantern-post blurb per **A2**; keep the `lamp-wick` blurb identical in `items.json` and `CRAFTED_BLURBS`. Sweep blurbs for "lantern road", "Iron-Oak", "lamp-stone" and "White Quiet". |
| A1's test assertions (L8) | `tests/items.test.ts:64-66,184`; `tests/inventory.test.ts:44,46,64-66` (`:25` Ember Charm stays); `tests/furnishings.test.ts:45`; `tests/village.test.ts:85,87`; `e2e/review5-fixes.spec.ts:57,161,166`; `e2e/yard.spec.ts:90`; `e2e/lot-lantern.spec.ts:62`; `e2e/items.spec.ts:124,134`; `e2e/gifts.spec.ts:262,281`; `e2e/inventory.spec.ts:65,72,212,282`; `e2e/village.spec.ts:153,155,197,200,202,208`; `e2e/homestead.spec.ts:231-240,435`. Grep again for every renamed name, including plurals ("2 Lamp wicks", "Wooden stools"). |
| `src/content/loading.ts` (owner) | connect "Finding your way back…"; land "Reading the lie of the land…"; fetch **"Trimming the wicks…"**; decode **"Filling the lamps…"**; build **"Speaking the namings…"**; arrive **"Parting the Whitequiet…"**; paint **"The land remembers you…"**. `loadingCopy` unchanged. |
| `controls.ts`, `guides.ts`, `src/lib/items.ts` | Casing; "the Commons" stays. |
| `README.md:4,102` and "Beyond the village" (`:153-238`) | "Lantern Road"; the Tangle doesn't turn; the Whitequiet and the land beyond turn every wick; the frontier is the Whitequiet's edge, and only a lit camp pushes it back. |
| `CHANGELOG.md` Unreleased `### For players` | Live text (What's New). "Set your home pieces…" → plain wording; casing; the frontier and unmoored wording as above. Old entries stay as history. |
| `docs/design/magic.md` | Header note: the four class-locked crafts are superseded by the Practices (canon §5, later); the class is a lean. |
| `docs/roadmap.md` 0.15 | Name what waits at Dorrit's Span: Hesper, bound in the brackets (canon §4.6). |
| `docs/ideas.md` | Add **worn ways** (canon §2.6) and the **animal overhaul** (ordinary and corrupted animals; wisps and beetles explained then). |
