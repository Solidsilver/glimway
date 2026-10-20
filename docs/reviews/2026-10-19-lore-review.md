# Second-pass lore review for 0.13.0

Reviewed `exp/lore-review` at `cd9228fc` against `dev...HEAD`, including the
integrated canon, apply map, settled working notes, found texts, runtime content,
client/server mechanics, generators, and string assertions in `tests/` and `e2e/`.
Creative preferences in the notes are treated as settled. This review changes no
source, content, tests, or canon.

**Result: 0 P1, 15 P2, 1 P3.** Resolve the P2s before dispatching the apply lanes.
The map's explicit prohibition on identifier changes is correct; none of its
specified display renames requires a save migration. The main risks are inaccurate
shipped-rule descriptions, incomplete found-text corrections, and package/test scope.

This is a source review. No service or deployment was accessed. Runtime tests were
not run: `node` is unavailable in the current shell. Evidence below identifies the
existing mechanics and assertions; it does not claim an executed test result.

## Mechanical findings

### L1 — P2 — The packages share a test file, and generated ownership is implicit

**Location:** `docs/lore/apply-map.md:45`, `:47`, `:49`, `:52`.

A and C both own edits to `tests/residents.test.ts`, despite the statement that
packages share no files. Splitting line ranges still requires a shared file merge.
E is instructed to generate two files but neither is explicitly included in its
ownership cell. The general rule that one package owns every duplicate also does
not hold for item names/blurbs in C's `expansion-writing.ts` and F's item catalogues.

**Evidence:** `tests/residents.test.ts:79` contains the journal-title assertions and
`:135` the winter assertion. `scripts/papers.ts:198` writes both
`src/content/papers-text.ts` and `content/papers.json`. The lantern post has
descriptions at `src/content/expansion-writing.ts:209` and `content/items.json:955`.

**Suggested fix:** Give C sole ownership of `tests/residents.test.ts` (A already
keeps those journal titles). Explicitly give E both generated outputs and sole
responsibility for running `npm run papers` after its markdown/design edits.
Agree C/F's corresponding display text before those lanes start, and validate their
combined result before accepting either lane. There is no inherent A-before-C or
E-before-F mechanic dependency; these are file ownership and integration constraints.

### L2 — P2 — A camp holds land before it receives its parts-based naming

**Location:** `docs/lore/canon.md:208`, `:212`, `:217`.

The shipped description says oil without a naming anchors nothing, every holding
lamp already has a naming, and a way-lamp receives its lasting name while being
set. In the game, setting and naming are separate operations. A newly set,
unnamed camp already holds a chunk and expands reach; the player can leave its
naming panel without naming it. Existing camps are grandfathered too.

**Evidence:** `server/internal/api/camps.go:375` documents grandfathering;
`:403` takes the hold and `:429` creates the camp without writing a naming.
`server/internal/api/lamp_naming.go:173` names an existing camp in a later request.
`src/game/wilds/camps.ts:253` offers “Give it a naming” only when a camp has none.
`e2e/camps.spec.ts:306` explicitly tests cancelling that panel with no naming saved.
`server/internal/api/camps_test.go:275` keeps a camp through a turning on oil.

**Suggested fix:** Document the shipped distinction between a Keeper's setting
and the optional, recorded naming. If the intended framing is an implicit naming
at setting, say so and explain what the later parts-based naming adds. Do not make
the apply agent add a new naming prerequisite, invalidate old camps, or move the
ash reward from its existing explicit first-naming operation.

### L3 — P2 — The weekly rule omits the permanently stable Tangle

**Location:** `docs/lore/canon.md:79`, `:257`, and `docs/lore/apply-map.md:101`.

The canon describes unheld Wild detail as turning every wick, with permanence
listed for town/lots/hearths. The shipped Tangle is a separate, never-ending
`still` epoch regardless of visits or lamp oil. The map also leaves its location
card saying that its ground moves whenever unwatched. An agent following only
the canon cannot accurately explain this first Wilds region.

**Evidence:** `content/wilds.json:556` sets the Tangle's `epochKind` to `still`;
the Whitequiet is `wick` at `:597`. `server/internal/wilds/epoch_v3.go:19`
defines `still` as never ending. `src/game/scenes/world-turning.ts:136`
distinguishes the Tangle's notice from the Beyond's changing terrain.
`src/content/open-map.ts:102` already tells players “the Tangle stays.”
`src/content/expansion-writing.ts:225` contradicts that behavior.

**Suggested fix:** Add the Tangle exception to the shipped Turning/land rules,
without promising new permanent Wilds claims. Assign C the location-card fix.
Correct the found notices that claim the Tangle and the permanent Lantern Road
change course (`docs/lore/texts/notices-from-the-board.md:14`, `:17`, `:20`), in E.
Keep `epochKind`, generation parameters, and saved epochs unchanged.

### L4 — P2 — Walking into the frontier does not open it

**Location:** `docs/lore/canon.md:94` and `docs/lore/apply-map.md:90`.

The Whitequiet paragraph presents walking into the veil and lighting a lamp as
alternative ways to bring land into being. The frontier blocks walking. A Built
camp hold extends it; exploration alone and relighting a communal lamp do not.
Changing only the map legend to “The Whitequiet” leaves the rest of the frontier
copy calling this boundary “the drift.”

**Evidence:** `src/game/scenes/WorldScene.ts:1032` stops the hero at the boundary;
`server/internal/frontier/frontier.go:5` and `:113` derive additional reach from
held chunks, not explored chunks. `server/internal/api/frontier_reach_test.go:54`
tests a camp extending reach. `server/internal/api/communal_lamps.go:284`
relights a communal stone without taking a hold.
The remaining player strings include `content/wilds.json:1136` (`words.drift`),
`:1215` (rumour phrase), `src/content/open-map.ts:118` (`legendBeyond`), and
`src/content/wilds-errors.ts:15` (`beyond-frontier`).

**Suggested fix:** Distinguish revealing reachable, unexplored land by walking
from extending the frontier with an oil-fed camp. Map the associated frontier
display strings consistently to B, including the rumour phrase outside B's current
`wilds.json` `words` sub-scope. Flag `e2e/open-map.spec.ts:306` and
`tests/wilds-rumour.test.ts:13` if those phrases change. Retain the `drift` key,
`beyond-frontier` error code, and frontier/reach identifiers.

### L5 — P2 — Lot-backland recovery does not all arrive at Pell's

**Location:** `docs/lore/canon.md:155`, `:259`, `:272`.

“Everything” from turned land going to Pell's includes lot backland in the canon's
Built row. That is not the shipped recovery destination. Lapsed lot-backland
furniture goes to home storage, plants return as seeds in the shared chest, and
laid path materials go to Pell's. Camp recovery does use Pell's and can preserve
a plant's identity/growth. The no-loss principle holds, but the destination and
plant form differ.

**Evidence:** `server/internal/api/recovery.go:12` explicitly names the exception.
`server/internal/api/lot_lanterns.go:261`, `:274`, and `:300` implement it;
`server/internal/api/common_ways.go:45` and `:70` crate lapsed backland paths.
`server/internal/api/recovery.go:178` preserves a recovered camp plant's growth.
`server/internal/api/lot_lanterns_test.go:255` checks seed recovery to storage.

**Suggested fix:** State the lot-backland exception in the canon and B's reference
notes. Keep the guarantee that placed goods are recovered, while directing the
player to the correct chest/crate and accurately describing seeds versus plants.
Do not unify these storage systems in the text-only apply.

### L6 — P2 — “Too long in unheld land” and “rest in lamplight” overstate Unmoored's rules

**Location:** `docs/lore/canon.md:123` and `docs/lore/apply-map.md:69`, `:117`.

The general shipped claim implies exposure throughout unheld Wilds and recovery
beside a Wilds lamp. The actual exposure timer is only deep in the Tangle, and
recovery checks safe-area rules rather than lamp proximity or held land. The
Whitequiet/Beyond do not acquire the exposure timer just by being unheld, and a
camp or communal lamp does not automatically become a recovery area. Calling the
experience the Dark's first touch is a settled framing choice; this finding is
about its location and recovery promises.

**Evidence:** `src/game/entities/unmoored.ts:130` tests the Tangle footprint and
distance from the gate; `:140` runs its four-minute timer and `:153` uses
`isSafeArea`. `src/lib/habitica/sync.ts:61` delegates that check to location rules;
`content/places.json:304` gives generated land `safe: false`.
`tests/unmoored.test.ts:52` tests two-minute recovery on safe village ground.
The journal at `src/content/world.ts:641` also suggests “patience” alone can cure it.

**Suggested fix:** Qualify the shipped rule as deep-Tangle exposure/Turning, with
recovery on safe town/home ground or a remedy. Assign accurate HUD/journal wording
to D/A as appropriate; preserve the journal titles and existing `unmoored:*` flags.
If the HUD changes, update its exact tooltip assertion in `e2e/warden.spec.ts:67`.

### L7 — P2 — The map explicitly permits retaining the lantern post's false land claim

**Location:** `docs/lore/apply-map.md:85`, `:140`.

B fixes the naming prompt because an own-lot lantern post does not hold land.
F is nevertheless allowed to “leave the blurb,” leaving C's old named-post
anchor claim unaddressed. This contradicts the settled distinction in `canon.md:680` even
after B's prompt is corrected.

**Evidence:** `src/content/expansion-writing.ts:209` says “land only stays put
where a named lamp holds it.” The other blurb, `content/items.json:955`, is actually
different: “Expands your land. Holds back the dark where its light falls.” Posts
do extend local placement light (`src/lib/homestead.ts:270`), but that is distinct
from the oil-fed backland hold in `server/internal/api/lot_lanterns.go:163`.

**Suggested fix:** Require compatible replacement blurbs in C and F, explaining
the post's local light/placement reach and sign-name without claiming a weekly
anchor or a naming. Remove the
“or leave the blurb” option. Agree that copy before parallel work begins.

### L8 — P2 — The sentence-case instruction affects substantially more assertions and copies

**Location:** `docs/lore/apply-map.md:12`, `:50`, `:139`; `docs/lore/canon.md:652`.

The blanket item-name rule covers “Whittled Fox,” “Wooden Stool,” “Tin Whistle,”
“Wooden Peg,” etc., while F's concrete edits mostly list Lamp Wick and Lantern
Post. C's duplicated decoration/trinket names need the same treatment. The current
test inventory underestimates the changes; giving only the listed edits to an
agent either leaves inconsistent names or breaks the omitted string assertions.

**Evidence / missing assertion locations:**

| File | Additional affected lines / strings |
|---|---|
| `tests/items.test.ts` | `65`, `66`: Whittled Fox, Wooden Stool |
| `tests/inventory.test.ts` | `44`, `46`, `64–66`: Wooden Peg, Tin Whistle, Braided Rug, Oak Table, Wooden Stool (line 25 is already flagged) |
| `tests/furnishings.test.ts` | `45`: Wooden Stool |
| `tests/village.test.ts` | `85`, `87`: Tin Whistle, Wooden Stools |
| `e2e/review5-fixes.spec.ts` | `57`, `161`, `166`: Wooden Stool(s) |
| `e2e/yard.spec.ts` | `90`: Wooden Stool |
| `e2e/lot-lantern.spec.ts` | `62`: Wooden Stool |
| `e2e/items.spec.ts` | `124`, `134`: Keeper's Twists, Whittled Fox |
| `e2e/gifts.spec.ts` | `262`, `281`: Keeper's Twists |
| `e2e/inventory.spec.ts` | `212`, `282`: Tin Whistle, Wooden Stool; Whittled Fox is at `72`, not the map's `71` |
| `e2e/village.spec.ts` | `153`, `155`, `197`, `200`, `202`, `208`: Wooden Peg, Wooden Stool, River Glass Bead |
| `e2e/homestead.spec.ts` | `235`: Wooden Stool, in addition to the listed post assertions |

**Suggested fix:** Make the full sentence-case sweep explicit and give F ownership
of these test edits, transferring whole shared test files such as `tests/village.test.ts`
and `e2e/village.spec.ts` out of C's edit scope. C supplies any changes needed in
its duplicated names.
Update utility and recipe names together (`content/crafting.json:5` **and** `:114`
for Lamp Wick). Keep `items.json` home-good names identical to the names derived
from `furnishings.json`: `src/lib/items.ts:98` and `content/items.go:211` reject a
mismatch. F owns both files, so these edits should be one coherent change. Preserve
proper names such as **the Empty Chair** and the explicitly retained **Ember Charm**
exception. `e2e/playtest1.spec.ts:333` asserts “The Empty Chair” as a speaker; keep
that ritual name when sweeping the furniture catalogue.

### L9 — P2 — Renaming a paper's H1 does not rename its displayed title

**Location:** `docs/lore/apply-map.md:123`, `:126`.

The Dangers entry directs E to change that markdown file's title/body, but the
player-facing title comes from its link text in `texts/README.md`, not its H1.
The README row still says “On the Dangers of the White Quiet.” The README's other
White Quiet description and several additional bodies are also missing from the
explicit rename inventory.

**Evidence:** `scripts/papers.ts:95` uses `entry.title` and the filename-derived
id; `parseText` strips the H1. The title source is
`docs/lore/texts/README.md:77`, with another retired phrase at `:41`.
Additional bodies include `deed-of-sale-commons-plot.md:11`,
`fauna-of-the-slack-water.md:12`, `:18`, and the second occurrence in
`why-the-tide-fox-has-one-long-ear.md:17`. The screen test at
`e2e/papers-screens.spec.ts:87` selects the generated title.

**Suggested fix:** Explicitly rename the README link label as well as the H1/body,
inventory all White Quiet occurrences under `texts/`, and regenerate both paper
outputs. Apply “Quiet” or “Whitequiet” by meaning. Keep the existing markdown
filenames, README link targets, design keys, and paper ids unchanged.

### L10 — P2 — Several found-text dates are impossible in a seven-day wick

**Location:** `docs/lore/canon.md:195`, `:290`; `docs/lore/apply-map.md:119`.

The canon and shipped clock agree that every wick has seven days, but E's map
does not schedule corrections to found texts with Amber-wick 14/26/27, Leaf-wick
10/17/28, Smoke-wick 14, and Bloom-wick 8/10/12. These are not covered by the
canon's allowance for vague *story years*: they are explicit dates in named wicks,
sometimes announcing a Turning on the wrong day.

**Evidence:** `content/clock.json:3` sets seven days;
`content/clock.go:96` computes days 1–7. Invalid dates occur in
`docs/lore/texts/ashwatch-ledger-excerpts.md:12`, `:15`, `:24`;
`notices-from-the-board.md:7`, `:13`, `:16`;
`adas-oil-receipts.md:9`; `failed-grid-of-sector-4.md:13`, `:17`, `:20`.
These bodies ship through `papers-text.ts`; the notices are actually granted
on a Turning (`src/content/papers.ts:179`).

**Suggested fix:** Give E an explicit calendar-normalization task, with one
shared event timeline for the ledger, notices, receipts, and Nan's journal.
Advance wick names when a sequence passes day 7; place scheduled Turning notices
on day 7. Preserve the settled seven-day clock and the first-storm/closure/run/
second-storm order. L14 identifies the relative timing that needs owner resolution
before assigning replacement dates.

### L11 — P2 — Aldo's note contains twenty-seven annual foxes eight years ago

**Location:** `docs/lore/canon.md:390`, `:550`; `docs/lore/apply-map.md:119`.

The storm was 31 years ago, the first fox arrived by the third autumn, and one
arrives each autumn. Aldo died two years ago and Finn inherited twenty-seven.
But the note already declares twenty-seven foxes **eight** years ago, too early
even if the first fox arrived immediately after the storm. E's map fixes Joss's
birthday description but misses this more consequential date.

**Evidence:** `docs/lore/texts/note-in-the-linseed-box.md:4` dates the note eight
years ago; `:5` and `:11` specify twenty-seven foxes. The annual arrival is also
stated there. `forty-one-and-holding.md:4`, `:11`, `:13` and
`src/content/residents.ts:168` place the inheritance two winters ago. The
twenty-seven older hopper marks are displayed at `src/content/residents.ts:356`.

**Suggested fix:** Assign E a note-date correction consistent with the inheritance
(roughly two winters ago), keeping the settled twenty-seven inherited foxes and
the separate forty-one *wheel turns* measurement. The count of newly received
foxes since inheritance need not be fixed by changing either of those numbers.

### L12 — P3 — Sallow Ford is said to house four living survivors

**Location:** `docs/lore/canon.md:518`.

The place entry says “where ... the four survivors live,” but Nan reached the Ford
and died there. This disagrees with the Six table at `canon.md:372` and the current
roster implied by Joss's letter.

**Evidence:** `docs/lore/texts/joss-penhallow-letter-map-case.md:9` explicitly says
only Joss, Tam, and Hollis remain. Nan's death predates that four-years-old letter.

**Suggested fix:** Say “where the four survivors reached safety” or name the three
still living. Keep the historical count of four reaching Sallow Ford.

## For the owner

These are conflicts or unspecified scope that require a story-level choice of
wording. They do not reopen the settled tone, magic system, Dark, survivor fates,
or direction of the Lantern Road.

### L13 — P2 — The permanent geography rule still conflicts with the ferry and survey stories

**Location:** `docs/lore/canon.md:53`, `:89`, `:524`;
`docs/lore/apply-map.md:92`, `:125`.

The Deep Measure says riverbeds/ridges do not turn and land stays put between
Turnings. Yet the same canon says the Sennicks move their ferry “when the river
drifts.” The apply map also does not reconcile these rules with existing accounts
of rivers moving and rock/ridges disappearing. This requires more than casing.

**Evidence:** The actual Wend is stable between wicks
(`server/internal/wilds/wend.go:5`, `:74`; `epoch_v3.go:62`). Its live area card
nevertheless promises “a new course every wick” (`src/content/open-map.ts:158`).
`docs/lore/texts/joss-penhallow-field-notes-pencil-map.md:16–20` folds ravines,
flattens ridges, and moves water; `failed-grid-of-sector-4.md:11–21` describes
continuous movement and a vanished limestone outcrop; and
`guild-of-cartographers-invoice.md:11` bills for a river moving the ferry.
`wandering-orchard-magistrate-ruling.md:8` still explicitly calls its cause “slow
drift.” Current seasonal copy also implies varying drift rates
(`src/lib/village.ts:35–37`, `src/content/residents.ts:128–130`).

**Suggested fix:** Keep the decided permanent bedrock/watercourse and weekly
mechanics. Specify whether those historical accounts concern changing banks,
fords, vegetation and approaches, exceptional historical stirs, or an author's
mistaken theory. Give E the exact affected papers and C the seasonal wording;
give B the Wend card. The map's “casing sweep only” for the surrounding copy is
insufficient. Do not silently introduce seasonal terrain motion to save an old line.

### L14 — P2 — The lull's duration and Nan's injury scene cannot all be true

**Location:** `docs/lore/canon.md:353–357`;
`docs/lore/apply-map.md:119`.

The canon states nine days of slack calm, a departure on day six, and a second
storm three days early. Nan's journal places Tam's injury on day four or five
*of the lull*, while already travelling with the Six. Its next entry dates the
storm to day six. That puts the travelling injury before the settled departure,
and “nine days of slack calm” reads as an actual duration inconsistent with the
storm's arrival.

**Evidence:** `docs/lore/texts/nan-greer-trail-journal.md:7`, `:12`, `:18`;
`ashwatch-ledger-excerpts.md:25` says they departed after five calm days.
`marens-notes-on-hubs-and-tyres.md:26` treats nine days as a forecast, not elapsed
calm. The map does not assign any of these timing corrections.

**Suggested fix:** State that nine calm days were *expected* and the second storm
arrived on the sixth. Then place the injury consistently after departure (or
explicitly before departure while preparing, adjusting Nan's location/references).
Confirm that relative sequence once, then let E normalize the dates in L10. No
agent should invent a longer journey or move the established deaths independently.

### L15 — P2 — “Turncap” denotes a mushroom in canon and a wooden roof feature in a paper

**Location:** `docs/lore/canon.md:280`;
`docs/lore/apply-map.md:125`, `:130`.

The canon's explanation is specifically biological: grey mushrooms leaning toward
light. Joss's field notes instead describe a turncap that spins in the wind,
settles after twenty winters, and remembers as *wood*, then instruct the reader
to find a roof and inspect its cap. The associated paper design hook reinforces
the roof interpretation. The map currently asks only for White Quiet substitutions
in this paper, leaving the term ambiguous for future apply work.

**Evidence:** `docs/lore/texts/joss-penhallow-field-notes-pencil-map.md:23`;
`src/content/papers.ts:127` calls its source “A roofed shrine ... whose turncap
leans toward Sallow Ford.” Shipped item behavior is the mushroom-based version
(`src/lib/ways-home.ts:2`, `:17`; `server/internal/api/ways_home.go`).

**Suggested fix:** Retain the settled mushroom/homeward-item explanation. Decide
whether the roof fitting has a different name or is explicitly a crafted imitation
sharing the mushroom's name. Assign that clarification to E's paper and hook; do
not change `homing-turncap`, `turncap-spawn`, or their item effects.

### L16 — P2 — “The Carters' Apron” has no specified display-name scope

**Location:** `docs/lore/canon.md:497`;
`docs/lore/apply-map.md:94`.

The canon gives the former Commons staging ground the name **The Carters' Apron**,
but the apply map neither applies it nor says that “Commons” remains the current
player-facing name. An agent must guess whether this is a historic nickname, a
new sub-place, or a rename of existing map/dialogue labels. A blanket Commons
replacement would affect much more than display text.

**Evidence:** `src/content/expansion-writing.ts:82` still names the card
“Hearthwick Commons”; `src/content/open-map.ts:88` labels the Commons gate;
`src/content/guides.ts:55` and `src/content/world.ts:220` use Commons for player
directions. Code and content also use persistent room ids such as
`in:commons:yard`, including `content/items.json:1336`.

**Suggested fix:** Record whether Apron is only the historical staging ground's
name or a display rename for 0.13.0. If the former, explicitly retain current
Commons directions; if the latter, enumerate the exact labels and distribute
their files to A/B/C/F. Preserve room, place, layout, quest, and save identifiers
regardless of the display choice.

## Identifier and integration guardrails

The existing “text only” rule is essential. These are concrete applications of it,
not additional findings or requests for migrations:

| Keep unchanged | Display text that may change / reason |
|---|---|
| `lamp-wick`, `lantern-post`, `iron-oak`, `homing-turncap`, `knotted-halter`, `road-nails` | Item `name`/`blurb` fields can change. Definition ids are stored in stacks, instances, furnishings, mail and recovery entries. See `server/internal/store/migrations/012_items.sql:6`, `:26`, and `server/internal/api/recovery.go:58`. |
| Gathering target `lamp-stone`, site ids `lamp-stone:<cx>:<cy>`, enum/art keys | Change “Old lamp-stone” / “Break the old lamp-stone” display strings only. `content/gathering.json:199` is a lookup key; `server/internal/api/communal_lamps.go:248` parses the site-id format. “Lamp stone” is not a replacement id. |
| `lantern-road`, its step/event ids including `guardian-defeated`, and `keepers-hand` | Capitalize the quest's prose and call the Warden “settled” in display text without renaming stored quest progress or event contracts. `server/internal/store/migrations/027_server_state.sql:16` stores progress; `src/lib/quests.ts:151` maps the existing event/step names. |
| `dangers-of-the-white-quiet-pamphlet.md` and its filename-derived paper id | Rename the README display title and body, not the file or design key. `scripts/papers.ts:101` derives the id from the filename; `src/content/papers.ts:12` documents persisted `paper:<id>` flags. |
| `unmoored:felt`, `unmoored:cleared`, `keeper:hand`, existing `paper:*` / `returned:*` flags | Explanatory prose can use the new framing. Flags gate journals, rewards and interactions; a wording change must not create new reward or progression keys. |
| `words.drift`, `beyond-frontier`, `commons` / `in:commons:*`, `still`, `wick` | These are content keys, error codes, room/location ids and epoch kinds. Replace the appropriate displayed phrases only, retaining JSON keys, protocol fields and saved locations. |

Integration should include the full local unit suite and the affected E2Es in the
normal release workflow after combining the lanes. E alone regenerates papers;
F changes matching item/furnishing/recipe display names together. The item-vector
generator (`scripts/items-vectors.ts:10`) serializes mechanics, not display names,
so casing by itself does not require regenerating item vectors or changing ids.

## Summary

**0 P1 · 15 P2 · 1 P3.** Most important: reconcile shipped camp naming, frontier,
Tangle, recovery and Unmoored rules (L2–L6); complete the paper chronology/geography
corrections (L10–L15); and settle package ownership plus the full rename/test scope
before parallel application (L1, L7–L9, L16). Keep every persisted id and server
contract stable.
