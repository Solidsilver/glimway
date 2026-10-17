# Lamps: holds, lot lanterns and common ways (0.12–0.13)

Status: **design for the build**, 2026-10-17, checked against this worktree's `24f99989`
baseline. [The roadmap](../roadmap.md) owns the release order and overrides older designs.
The build below is proposed unless explicitly listed as existing in §2.1.

## 0. Owner decisions and the contract

The owner settled the tiers and release order in the
[merged plan §3–7](../planning/responses/gemini.md#7-resolved-owner-decisions-locked-in).
The [workshop, topic 1](../planning/responses/workshop-claude.md#topic-1-what-the-game-is-about)
and [wishlist §1](../planning/wishlist.md#1-land-light-and-the-turning) explain the wish for
social paths and oil as a brake on sprawl. Their competing lapse clocks are now settled.

1. **World impermanence, never item loss.** Land may turn. Everything a player placed or made
   survives; lapsed placements pack into a recovery crate at Pell's deeds office.
2. **One judgment at each weekly wick turning.** Read the ending wick's presence and the oil
   available at that boundary. Nothing ticks between turnings: no continuous upkeep burn,
   calendar-time countdown or active-time aging caused by a friend's long session.
3. **Wild, Common, Built.** Wild detail turns. A single visit keeps Common paths and communal
   lamps. Built claims need sap oil, a 2–3 wick store, communal tending and a full wick of
   dimming warning. Presence never pays a Built claim's oil bill.
4. **The earth's shape lasts.** Lakes, rivers and ridges stay; living detail turns. This
   overturns [open-map decision 18](open-map.md#0-owner-decisions).
5. **The first hold is lot backland, in 0.12.** Way-lamps, camps, Common presence, the Keeper's
   hand and the three-tier map follow in 0.13. Extending a lot needs no way-lamp or Keeper quest.
6. **Access survives the turning; its direction need not.** Keep
   [location-seam §0 #2, #6, #8](location-seam.md#0-owner-decisions-2026-10-13): fixed → held →
   generated sources, oil-fed extension, and a walkable connection to every held patch.
7. **Creations and geography survive upgrades.** Before the 0.14 contract freeze, settle the
   persistent identities and seed split. After it, preserve world schemas, chunk keys and
   generator contracts ([roadmap rules 3, 4, 7](../roadmap.md#rules-every-release-keeps)).
   An upgrade must never erase a player's work or act as an unannounced lapse.

This narrows [world.md decision 10](world.md): the hearth plot and Hearthwick lot builds last
for good. **Built land in the Wilds, including lot backland, lasts while lit.** On lapse its
arrangement goes into recovery. Magic still expires at its stated turning even on held ground.
World.md decision 12's permanent-way-lamp wording is superseded by the oil rule.

Chunk-wide visits, one-chunk camps, boundary ordering and recovery rights below are **build
proposals** making the contract concrete. Numerical costs and capacities are **tuning**, not
additional owner decisions.

## 1. The player's view

### 1.1 Three kinds of land

Permanent town and hearth ground sits outside upkeep. A generated chunk may contain Common
work; a Built claim takes precedence over Common work inside its boundary.

| Tier | What counts | What keeps it | At the turning | How you can tell |
|---|---|---|---|---|
| **Wild** | Unclaimed generated land, its generated trails and living detail; clearing alone makes no claim | Nothing | Detail regenerates; large geography stays | No claim light; chip **Wild · detail turns**; neutral map terrain |
| **Common** | Laid stone/plank paths and explicitly communal way-lamps outside Built claims | Any player standing anywhere in that chunk once during the wick | Visited work carries across; unvisited work turns, with paid path materials and placed lamps recovered | Worn path or communal lamp; chip **Common · visited this wick** or **Common · needs a visit**; ochre path marks and a labelled chunk boundary on the map |
| **Built** | Oil-fed claims: lot backland (0.12), way-lamp camps (0.13), later chartered Wilds hearths | Oil in the linked store at the turning; anyone may supply it | Funded claims hold; shortage warns for a full wick, then lapses into recovery if still unfunded | Warm light/boundary; chip **Built · held**, reserve, or **Dimming · turns next turning**; matching map shading and warning mark |

A Common visit means **occupying any walkable tile of the chunk**, however briefly. Walking
beside the path counts; touching every tile or pressing Tend is unnecessary. A path crossing
several chunks needs one visit to each chunk, shown separately on the map. Fetching a chunk,
seeing it from next door, viewing the map or leaving an offline character there does not count.
An online player still standing there when a new wick starts counts for that new wick too.
Successfully laying a path or interacting with a communal lamp also credits its target chunk,
including an action within reach across a seam, so making or tending work cannot miss by accident.

Common keeps the path and lamp, not the surrounding woodland, garden or chest. A camp with
belongings is Built and needs oil. Generated paths have no paid materials to recover; an
unvisited laid path returns its stone or timber. A quiet road can disappear without taking
anyone's work with it.

### 1.2 First light: the woods behind home

In 0.12, hang a lot lantern on the stake behind your Hearthwick lot. The chandler supplies oil
made from Wick Tree sap. Fill the linked store, and the backland keeps this wick's woods.
Connected lanterns farther out extend the yard's usable tiles within that one chunk.

Keep [Hearthwick 2 §6](hearthwick-2.md#6-extending-a-lot-with-lanterns)'s bounds: west backland
is `cx = -3`, east backland `cx = 3`, at the lot's `cy = 1..4`. The whole chunk's terrain is
held, but only lit tiles join arrange, clear, plant and gather services. Additional lanterns
do not claim a second chunk. The fenced lot and hearth remain permanent if backland lapses. Likewise a chartered Wilds hearth's **core plot is permanent until the charter is given up** (owner, 2026-10-17); only land extended beyond it runs on oil.

An empty store does not erase the yard. At a turning it enters **Dimming**, retaining its hold
and services for the following wick, with warnings in the world and on the map. Anyone may add
oil; at the next turning it returns to Held or packs up. Pell lets the household collect free.
This replaces Hearthwick 2's immediate unfed lapse, direct home-storage return and seed-only
refund: §2.7 is the recovery rule from the first backland build.

### 1.3 Out along the common ways

In 0.13, clear and lay trails with friends. Walking through a chunk once keeps all its Common
work for the coming turning. A communal lamp is a public rest and wayfinding light, claims no
surrounding land, and uses presence instead of oil. Anyone can set or relight one.

After the Lantern Road, Mara teaches **the Keeper's hand**: copy a road stone's cut, compare it
with the ledger, then light or tend a communal lamp and give it a naming. You can now set and
name a Built way-lamp for a camp. It keeps one chunk in this slice and uses the same store rule
as backland. A solo camper needs no charter or second player. Refuelling another player's light
gives no rights to their belongings.

The map's Lamps layer shows held boundaries, Common work, Wild detail and dimming warnings.
Select a lamp for its naming, namer, reserve and next-turning outcome. The ledger lives in map
Details, not an extra Journal tab or second grid
([world-map §6](world-map.md#6-lamps-and-later-map-layers)).

### 1.4 Ways home

Keep the **homing turncap** and **lamp-ash pouch** in 0.13. Proposed recipes: one turncap spawn
and two amber for a turncap; one lamp ash and two fibre for a pouch. Each is consumed only on
successful travel, needs a three-second pause, and cannot be used in a fight. Numbers are tuning.

The turncap returns to Hearthwick's Wilds entrance through a resolved anchor, never a copied
coordinate. The pouch names a stable lamp id in this world and lands on open ground beside it.
A missing, packed, unlit or cross-world lamp fails with an explanation and keeps the pouch.
Recovery/reinstallation preserves lamp id and naming. Give one ash on the first successful
naming of that lamp, never again for tending or reinstallation. Walking remains free; the
turncap is a convenience and safety fallback.

**As built (0.13).** The turncap's anchor is `hearthwick:arch`, the north arch, named in its
content use and resolved at use; it isn't spent on safe town ground. One binding per player
covers every pouch they carry: bind at a lit camp way-lamp or communal lamp within reach, pouch
in the pack. Lot lanterns take no binding. The landing is open ground within two tiles of the
lamp, in its chunk, in front of it first. "In a fight" is the presence hub's: an enemy wound up
or aimed at you, or you swung or cast into a fight room, in the last 8 s. The client holds the
pause and lets go if you move or enemies close in; the server doesn't time it.

## 2. The build

### 2.1 What exists, and where

These are observations at the baseline, not claims that the proposed systems have shipped.
The first rows were added as 0.12 and 0.13 landed and describe the code as built.

| Built since the baseline | Source |
|---|---|
| Holds | [store/holds.go](../../server/internal/store/holds.go), migration 039: `Chunks.Hold`, `Release`, `HoldAt`, `HeldEpoch(s)`; one `Holder` per kind (`Keeps`, `Released`), registered in `api.New` and judged once when the new wick epoch is made. Fixed → held → generated. |
| Lot lanterns | [api/lot_lanterns.go](../../server/internal/api/lot_lanterns.go), migration 040: holder kind `lot-lantern`. Fuel is `hearth-oil` (the chandler sells it at 4 glims, 3 a day), a 3-wick store in the lantern, one wick burned a turning, a wick of dimming, then lapse. |
| Camps and Pell's crate | [api/camps.go](../../server/internal/api/camps.go), [api/recovery.go](../../server/internal/api/recovery.go), migration 041: holder kind `way-lamp`, `camps`, `camp_plants`, `recovery_crates`/`recovery_entries`; `GET`/`POST /api/camps`, `GET /api/recovery`, `POST /api/recovery/collect`. |
| Wick Tree sap | [api/wick_sap.go](../../server/internal/api/wick_sap.go), no migration: `POST /api/items/tap` (one `wick-sap` a calendar wick, an `outcomes` row `wick-sap:<WickStart>`) and `POST /api/items/refine` (one sap → one `hearth-oil` at the chandler, free). Content `homestead.wickSap`. |
| Ways home | [api/ways_home.go](../../server/internal/api/ways_home.go), migration 044: `GET`/`POST /api/ways-home` (`bind`, `turncap`, `pouch`), `ways_home_bindings` (one per player). Bench recipes with pages; the Keeper's-hand quest gives both pages. |

| Existing seam | Source and consequence |
|---|---|
| Chunk sources | [chunks/source.go](../../server/internal/chunks/source.go) defines `ChunkSource` and `EpochComposition`. [location/location.go](../../server/internal/location/location.go) has fixed/generated sources; held came with the holds engine above. [store/chunks.go](../../server/internal/store/chunks.go) serves fixed/plot bodies first, then stored generated chunks. |
| Identity and near read | [wilds.proto](../../proto/glimway/v1/wilds.proto) defines `WildsChunkKey(realm, layer, cx, cy)`, `WorldChunk`, `NearChunk`, `GroundChanges` and `WildsWay`. [api/open_map.go](../../server/internal/api/open_map.go) takes world identity from the session and selects still/wick epochs, without holds. |
| Epoch seeds and clock | [wilds/epoch_v3.go](../../server/internal/wilds/epoch_v3.go) hashes world seed, kind, generator version and **season** into `Epoch.hash`, chunk and loot seeds. [clock.json](../../content/clock.json) sets seven-day wicks. |
| Geography still turns | [wend.go](../../server/internal/wilds/wend.go) uses `e.hash("wend")`; [lands.go](../../server/internal/wilds/lands.go) uses `e.hash("land", ...)`. [world_v3.go](../../server/internal/wilds/world_v3.go) seasons the landform warp/dither noise too. Stable geography is work for 0.12. |
| Epoch expiry | [store/chunks.go](../../server/internal/store/chunks.go) rejects ended epochs on chunk reads; `deleteStaleEpochs` eventually deletes their chunks/state. Both need hold-aware authorization and retention. |
| Player-laid paths | [api/open_map_paths.go](../../server/internal/api/open_map_paths.go) stores a `world_changes` ground row per chunk/epoch (`entity=ground`, `kind=ground`), and named `way` rows. Lay debits materials; lift checks `GroundChange.by` and refunds. Ground rows have epoch `ends_at`. [worldchange.go](../../server/internal/worldchange/worldchange.go) ignores expired rows even if the epoch survives. |
| Ground overlay | [chunks/effective.go](../../server/internal/chunks/effective.go) opens cleared/laid tiles over immutable bodies. Common carryover also needs exclusion of newly generated entity/decor collisions. |
| Presence | [api/presence_socket.go](../../server/internal/api/presence_socket.go) has outdoor chunk rooms and position/frontier checks. This is the occupancy integration seam; neighbouring viewers are not visits. Durable weekly presence is new. |
| Home work | [api/home_placement.go](../../server/internal/api/home_placement.go) chains connected lights and places `homestead_items`; [api/plants.go](../../server/internal/api/plants.go) projects plants. Backland service bounds, held planting and recovery must be added. |
| Tree and oil | [layouts/hearthwick.json](../../content/layouts/hearthwick.json) contains seasonal Wick Tree and chandler scenery. [items.json](../../content/items.json) has `hearth-oil`; [crafting.json](../../content/crafting.json) makes it from three amber and one tallow. The sap-to-chandler loop is now built (the Wick Tree sap row above); the recipe stays as a home route from amber. |

### 2.2 Holds and lasting geography

Proposed hold key: **`(world, realm, layer, cx, cy)`**, referencing saved wick epoch, claim id and
held-at time. Keep that epoch's seed, season, generator version and stored body. Resolve fixed
first, then an authorized hold, then generated still/current-wick land. Still Tangle and fixed
town/lot chunks never gain an oil obligation. A hold changes the source, not the coordinate frame.

Materialize the chunk when establishing its claim; do not regenerate it later against different
neighbours. Carry layout, decor, sites, entity bodies/identities, ordinary node/camp state and
respawn timers, material ground changes, player placements and planting state. Gathering/combat
timers keep their own rules; “nothing ticks” here means upkeep.

Separate **calendar wick** from **terrain epoch**. Chest entitlement refreshes per player each
calendar wick even on held terrain. Fallen-hero lanterns, magic, weekly rumour rewards and Echo
assignments do not become permanent or repeatable because their terrain is held. Expiring effects
still expire; old weekly offers end, and fresh Echo offers remain in the current Whitequiet
cycle. Retained bodies must not create a second copy of a weekly reward.

Near/entity reads, claims, fight-room lookup, path operations and chunk authorization must share
the resolver. An exact live held key may read its ended epoch; never globally reopen that epoch.
Retain referenced epoch rows and state until their last hold releases. Material ground changes
must stop expiring at the old `ends_at`; timed magic must not. Saving an epoch id alone solves
neither expiry nor cleanup.

Introduce a landform seed from world seed and documented generator version, **without season or
epoch kind**. Use it for land points, boundary warp, river course/width, and future lakes/ridges.
Keep creatures, forage, detail, dealt places and generated routes on seasoned hashes. Split noise
shared by geography and detail; do not remove season from `Epoch.hash` wholesale. The Lantern
Road stays a lasting route. Weekly fords may adapt to routes without moving riverbanks. Change
generation and glimpse reads together. Version this seed change explicitly; never silently
replace existing v3 output. Before the 0.14 freeze, any planned world rebuild must recover player
work first. After it, preserve the saved generator/landform contract and the bodies it created.
New lake/ridge biomes are not 0.12 work.

Holds preserve **detail**; geography lasts without them. New land beside each connected held
patch must connect at least one held opening to the walkable network back to town. Preserve the
held side, mirror compatible openings and route around stable water with fords where needed.
Test complete walks, not just matching edge bits. Common trails keep walkable crossings too.
After a lapse, a player reloading onto solid ground moves to nearest reachable open ground,
not routinely home; the turncap remains the fallback.

Built way-lamp holds may extend the frontier by a proposed three-chunk slack. Use the actual
union of fixed/still bases and active held keys, including dimming holds, not only its rectangle.
Common lamps grant no reach. Releasing one claim must leave surviving held patches connected.
If reach shrinks around a player, resolve a safe reachable arrival before accepting movement.
[frontier/frontier.go](../../server/internal/frontier/frontier.go) already bounds the starting
world; no frontier-band lane remains.

### 2.3 One judgment at the turning

Use half-open wicks `[start, nextTurning)`. Proposed records: a world turning cursor and an
idempotent result for each `(world, boundary)`. Finish the boundary transaction before serving
new state or accepting post-boundary fuel, placements or visits. Installation takes effect
immediately; its subsequent upkeep uses only these judgments. No continuous burn, daily upkeep,
active-time counter or mid-wick dimming transition.

At boundary `T`, read:

1. Durable occupancy flags for the ending calendar wick, independent of held terrain epochs.
2. Pre-boundary oil balances, funded chunk counts and previous Held/Dimming states. Fuel accepted
   at or after T belongs to the new wick.
3. Live claims, placements, ground changes and beneficiaries, so recovery captures everything
   before deleting source rows.

| Evidence at T | Result for the new wick |
|---|---|
| Wild | New detail over lasting geography |
| Common, chunk visited in ending wick | Carry Common work; surrounding detail turns |
| Common, unvisited | Remove work from land; recover paid materials/placed lamps |
| Built Held or Dimming, sufficient oil | Debit exactly one wick's cost; Held |
| Built Held, insufficient oil | Debit nothing; Dimming for the whole new wick, with hold/services |
| Built Dimming, still insufficient | Pack atomically, release hold, then turn detail |

Visits never save Built work. Do not downgrade a dimming claim to Common to avoid its bill.
Installation requires at least one wick's oil deposited; charge that deposit at the next turning.

Example with one chunk, one oil per wick and a three-vial store: T1, T2 and T3 each charge one.
At T3 it is empty but Held. T4 starts Dimming if still empty; T5 lapses if still empty. Oil added
in T4–T5 saves it at T5. Top-ups change reserves immediately and show **Will hold next turning**,
but the upkeep state changes only at the boundary.

After downtime, process missed boundaries in order before a returning player's top-up. Saved
balances and presence determine each missed judgment; no late deposit rewrites history. Persist
results once so concurrent reads, retries and restart cannot burn or pack twice. The warning
wick remains a full calendar interval even if the server was offline. Serialize boundary races
on the world cursor/transaction, not client timestamps.

### 2.4 Common work and presence without per-step writes

Proposed presence row: `(world, realm, layer, cx, cy, calendar_wick_start)`, visited flag and
first-visit time. No counts/durations. On authenticated entry, reconnect or accepted position
crossing into a chunk, insert once; cache successful writes for the wick. Subsequent steps and
visitors need no further write. Persist before acknowledging **visited**; retry failures. Never
rely only on disconnect flushes or device-local map history. Successful path-lay and communal
lamp operations insert the target chunk's flag in their own transaction, even across a seam.

After judging a turning, seed new-wick presence for connected, validated outdoor occupants.
Offline saved positions, near-window fetches and map views contribute nothing. A room must match
the accepted player position; its eight neighbouring rooms receive no credit. This adds a durable
occupancy flag to the presence seam, not a history of movement.

Store Common paths/lamps independently of expiring terrain rows, keyed by world and chunk, with
attribution and paid quantities. Adopt existing laid changes before old epoch cleanup. Carry
visited work onto new detail at the same tiles. Reserve path/lamp footprints before placing solid
decor, sites or enemies; keep the cleared corridor needed to walk the path and reach the lamp.
Do not preserve every cleared tile or the surrounding chunk's entities. Bare clearing stays Wild.

Recheck named ways across chunks after turning. Keep the naming while its laid run connects
surviving endpoints; reroute on surviving laid tiles or remove signs/name if broken or a dealt
endpoint moved. Never invent path tiles. Lift preserves attribution and refunds once. Unvisited
Common work uses §2.7 recovery; deleting its row without refund is no longer acceptable.

### 2.5 Built claims, stores and tending

Start with one generated chunk per claim: one lot backland or one way-lamp camp. Claims cannot
overlap, displace fixed/still land or take another household's designated backland. Taking a
claim over Common work retains its attribution but brings it under Built upkeep. No conversion
to Common while camp placements remain.

Proposed **tuning**:

| Knob | Proposal |
|---|---|
| Oil cost | One vial of sap-derived oil per funded chunk per turning |
| Store | Three vials per funded chunk: three charged wicks plus the separate warning wick |
| Lot fitting | Lamp head, lamp wick, two timber and first oil deposit |
| Built way-lamp | Six timber, four stone, lamp head, lamp wick and first deposit; stone footing until lake country |
| Communal stone relight | A wick; presence keeps the light, no oil obligation |
| New communal post | Same physical lamp parts without store/deposit; explicitly Common |
| Backland light | Five-tile radius, extra lanterns within connected light, usable tiles clipped to its one chunk |

As built (0.12–0.13): the oil is `hearth-oil` at one flask a wick and three wicks a store, for
lot lanterns and way-lamps alike (content `lotLantern`, `wayLamp`). The store is the lantern or
lamp itself; no separate placeable store exists yet. The way-lamp is a home piece crafted at the
bench from six timber, four stone, a lamp head and a lamp wick, so the whole cost comes back
with the lamp on recovery; setting it takes the first flask. Its setter keeps the camp and says
who builds there (below); anyone fills it. Setting it needs no homestead (the pack read lists
carried pieces, deed or not). The setter may take an empty lamp down, its unspent oil
returned, or pack the whole camp up from beside the lamp (`api/camp_teardown.go`): everything
goes to Pell's as at a lapse, anyone else's things naming the keeper who moved them, and the hold
lets go at the turning, which refunds laid paths. A camp plant comes up into the digger's pack as
its seed: anyone who may build there, or whoever planted it, whatever the rule. Nothing planted
grows into a crop yet.

Who may build (0.13, owner decision 2026-10-17; migration 045, `api/claim_rules.go`): a Built
claim's keeper sets one rule and one list of world members. The rules are `household` (the
default), `listed` (household plus the list), `except` (every world member but the list) and
`everyone`. The keeper always may. Building is placing pieces, planting, naming the lamp,
felling, breaking or digging, and clearing, laying or lifting paths in the claim's chunk; all of
these go through `mayBuild`. Walking, foraging, adding oil and reading the naming never do, and
nor does taking back your own pieces, whatever the rule (never item loss). Pieces stay their
maker's: anyone else's is the keeper's to move, to its owner's crate entry at Pell's, which Pell
tells apart from a lapse ("Moved off Alice's camp"). Rules are keyed by holder kind and id; only
way-lamp camps use them so far. The list is kept across rule changes, and the rule ends with the
camp. Common land has no rules. No camp harvest exists yet; when one is added, it should ask the
same check.

Communal lamps (0.13, content `communalLamp`): relighting a dark road stone burns one lamp wick,
not refunded when it goes dark (spent like oil); a communal post is the same `way-lamp` piece set
with no oil, crated whole to its setter if its chunk goes a wick unvisited. Both keep their stable
lamp id (stone site id, or piece id) and a `lamp_namings` row that outlives the light. A piece's
naming has no world (migration 046): it follows the lamp into any world, named and its ash given
once ever. A stone's id repeats between worlds, so its naming is its world's.

Retire distance escalation and the automatic 3×3 hold. Extra lanterns in one funded chunk do
not multiply upkeep. Each claim has one linked placeable store. Refuse unlinking/removing it
until its balance moves atomically to a replacement. No implicit shared drains between claims;
a larger shared reservoir needs explicit allocation later. Place the store inside its claim
within lantern light; install the first fitting/store atomically with the claim. The fixed lot
stake stays in place, while its fitted lantern is explicitly backland equipment for recovery.
Store construction cost is content
tuning; it is an ordinary recoverable object, not a new crafting station.

Oil is Wick Tree sap refined by the chandler
([Hearthwick 2 §9 #1](hearthwick-2.md#9-questions-settled-on-2026-10-15)). Proposed supply: a
free weekly per-member sap allotment, refined without glims, sufficient for one backland's
weekly fuel; extra sap-derived oil sold by the chandler. Explain it and provide access to the
first deposit at first lighting. Tune allotment, extra price and yield in content; no dependency
on 0.14 station-chain crafting. Reuse `hearth-oil` if its recipe/text can be reconciled, rather
than describing its existing amber/tallow recipe as an implemented tree interaction (§2.1).

As built (owner decisions 2026-10-17): once a calendar wick, anyone may tap the Wick Tree in
Hearthwick for one `wick-sap`, whether they hold a lantern or not. It's server-checked by an
`outcomes` row keyed by the wick's start, so a second tap that wick is refused (`already-tapped`)
and a replay is safe. Missed wicks don't carry over; the lantern's three-wick store covers gaps.
The chandler refines one sap into one `hearth-oil` for free, which is one lot lantern's weekly
upkeep. Extra oil is still bought there (4 glims, 3 a day), so the free sap covers one backland
and camps need bought oil. The tree's spot, reach, yield and refiner are content
(`homestead.wickSap`). `hearth-oil` reuses the old item, and its text now says it's refined sap.
The amber and tallow bench recipe stays: amber is already "sap the woods have let go of", set
hard, so rendering it at home still fits the story. The first tap explains the free weekly sap
and the chandler. Tapping again in the same wick says, in days, when the next wick brings more,
with no countdown. There is no `wick-sap` icon yet; it uses the item fallback.

Anyone in the world, including guests and non-Keepers, may donate oil. A keyed operation checks
world, range, inventory and capacity; debit only what fits, show overflow, and make retries safe.
Contributing gives no withdrawal, renaming, dismantling or recovery rights. Common tending is
free of glims. Paid oil consumed as upkeep is not an item lost to lapse.

Dimming retains services and lowers the flame. Show an amber warning chip and map hatch/icon:
**Turns next turning unless tended**. Keep held shading; do not rely on colour alone. Show the
store's reserve and next-boundary result without a ticking seconds-to-loss display. Cracks and
repairs are not needed for warning.

### 2.6 UI

Extend the near view with land status independent of terrain epoch: tier, claim id/boundary,
Held/Dimming, reserve/cost and current-wick Common visitation. This is new protocol work in
[wilds.proto](../../proto/glimway/v1/wilds.proto), not an inference from `source=generated`.
A dimming Built chunk still uses held terrain; Common uses new generated detail plus overlays.

Use [WorldMap.svelte](../../src/ui/WorldMap.svelte) and
[map-renderer.ts](../../src/ui/map-renderer.ts) for Lamps and Details. Keep the map's transform,
clipping and explored-terrain rules. A known lamp ledger entry does not reveal surrounding
unexplored terrain. Selecting a row centres its mark; on phones use the Details sheet over the
map. Distinguish permanent town from oil-fed Built claims. Common shows the path and visit-counting
chunk extent, without painting the surrounding woods as held.

Ledger fields: short name, naming sentence, namer, distance from town, tier, reserve and warning,
newest first. Retain the mage-lit indicator if a later working provides it. Empty state:
**No way-lamps yet. Your lot lantern is a place to begin.** Map viewing grants no capability.
Naming, setup confirmation and fuel deposits are separate interactions, explaining coverage,
cost and recovery before spending.

### 2.7 Zero-loss recovery at Pell's

A crate is **durable recovery storage in the world database**, not a chest entity on turning
land or a pack-sized limit. Proposed batch key: `(world, claim-or-common-chunk, lapse_boundary)`.
Entries carry source keys, stable instance/plant/lamp id or material stack, state payload,
original position, beneficiary and collection status. Batches survive epoch cleanup and upgrades.
Pell presents them as crates grouped by place and turning.

“Every placed item” includes work contributed by anyone:

| On the lapsed chunk | Recovered |
|---|---|
| Furniture, props, containers, camp equipment and future crafted kit pieces | Same instances with names, wear, attachments and custom state; no salvage discount |
| Stored contents | Every nested item/material stack, including visitor deposits; move with the container or as linked entries, never both |
| Player-planted trees, herbs and garden plants | Replantable instance with growth state, not only a seed refund |
| All laid stone/plank paths | Full paid quantities credited to the player who laid each tile; geometry retained as a record, not a second refundable object |
| Lamp itself, extra lanterns and linked store | Same items, stable lamp id/naming and unspent oil; authored stone masonry remains world scenery, supplied recoverable fittings return |

Free clearing has no material refund. Generated forage, creatures and unclaimed loot are not
player placements. Packs and permanent home storage are outside the lapse. Oil already consumed
at earlier judgments is upkeep. Refuse placements straddling claim boundaries in this slice;
container contents follow their container's claim.

Record rights at placement/deposit, not from the last tender. Personal entries go to their
owner; household/shared entries to their owning household/claim's authorized members. Paid paths
return to `by`; donated lamps to their recorded beneficiary. Preserve explicit ownership
transfers and recovery rights after the claim ends. Existing lot items belong to the owning
homestead, not a guessed maker from a nullable account field
([home_placement.go](../../server/internal/api/home_placement.go)). Each beneficiary sees only
entries they can collect. Public refuelling never changes these rights.

In one transaction, move/snapshot all entries, mark placements packed, remove/refund paid ground,
retire affected ways, release holds and record the boundary result. Only then may epoch cleanup
run. Read authoritative stored placements/ground even when their old expiry is exactly this
boundary; normal expiry-filtered views must not hide items awaiting recovery. A crash leaves
the old held claim or its complete crate. Lift, collect, top-up and lapse serialize so the same material cannot be refunded twice. Never sweep a surviving neighbour.

At Pell's, select entries to collect to pack or permanent home storage, free and without a live
claim. Collection is atomic/idempotent. A full destination leaves the remainder in recovery,
with no expiry or fee. Re-establish a claim and place things again: no automatic replay onto
changed terrain, no second material charge. Replanting restores saved state. Collection does
not silently relight a lamp.

0.12 must ship the minimum backland recovery flow before enabling lapse. 0.13 extends it to
camps, communal lamps and Common work. The zero-loss rule does not permit destructive interim
backland behavior.

**As built.** Lot backland is a deliberate exception: a lot's own home storage is its recovery
place, so a lapsed backland's pieces go there and its plants are archived with their seed in
storage (0.12). Camps use the crate: one `recovery_crates` row per lapse, and entries per
beneficiary. A piece is the same instance at location `crate`; a plant returns its seed, with its
planting kept in the entry's state for a later replant; unspent oil goes to the lamp's setter; a
laid path tile's stone or plank goes to whoever laid it. A lapsed lot backland's paths, and Common
paths that turn (an unvisited chunk, or a tile with nowhere safe to land), use the same crate:
one per chunk and turning, a stack entry per layer and material (lane E, migration 042,
`api/common_ways.go`). Collection in Pell's office takes everything at once into the pack; no destination can
be full yet. Crates are per world.

### 2.8 The Keeper's hand and naming from parts

The quest lands in **0.13**, after `lantern-road`, from Mara. It teaches shared waykeeping,
without gating lot lanterns, paths, communal light or anyone's tending.

1. Hear Mara: **“The road's held, you said. It isn't. Not out there.”**
2. Copy the cut from a designated stone on the northbound Lantern Road beyond the Whitequiet.
   Resolve a stable authored quest target inside the starting frontier, not the obsolete east
   coordinate or a weekly random site. It does not claim a backland or 3×3 patch.
3. Compare it with the ledger. **“Noted.”** A gated step grants `keeper:hand`, a lamp head,
   *The Form of a Naming* and the two ways-home recipe papers.
4. Relight/name the stone as Common, or tend/read it if already lit by someone else. Both set
   the player's completion mark. There is no first-Keeper race or oil gate here.

Setting/naming a Built lamp requires `keeper:hand`, range, valid free chunk/tile, parts, linked
store and initial deposit. Becoming a Keeper needs no class, Habitica or simultaneous friend.
Use `after`, `talk`/`use`/`flag`, gated `give`, `marks` and `papers` from
[quests.proto](../../proto/glimway/content/v1/quests.proto), not invented unlock fields. The new
target, server-owned mark namespaces and Wilds-site trigger checks belong in this lane.
`witness=keeper` is not an existing schema value and is unnecessary here.

Use **parts only, no free text** for both tiers: ordinal, relation (past/beside/above/below),
real nearby landmark, behind/ahead phrases and closing. The short name comes from the same
parts. Setting or relighting a Common lamp is public; a Keeper may give it its lasting naming.
Before naming it uses a neutral communal-lamp label. Keep the form:
**“You are the first lamp past the Whitequiet. Behind you the road;
ahead the old shrine. Hold fast.”** Closings: **Keep the weave tight. / Hold fast. / Stay.**

Store part ids, validated landmark reference and a rendered snapshot on the stable lamp id.
Offer only server-resolved landmarks, with road/Whitequiet fallback phrases. A moved Common
landmark leaves the original naming as history, not a silently rewritten name. Recovery keeps
it. Separate naming rewards from fuel/tending so neither ash nor naming rights can be repeated.

As built (0.13): quest `keepers-hand` (hear-mara → copy-cut → check-ledger → keep-a-lamp). The
quest stone is the first Lantern Road stone out of the Whitequiet inside the frontier, a function of
the world seed (`wilds.RoadStones`). Its flag steps wait on server marks in a `keeper:` namespace:
`keeper:cut` from the communal-lamp `copy` action there, and `keeper:lamp` when a holder of
`keeper:hand` relights, sets, tends, reads or names a communal lamp. Check-ledger also gives
the two ways-home recipe pages and one lamp wick for the relight.
A naming is six part ids (ordinal, relation, landmark, behind, ahead,
closing; content `lampNaming`). Landmarks are content-worded place marks and sites in the lamp's
chunk and its eight neighbours, plus the road and Whitequiet fallbacks. Behind/ahead take a side
phrase or one of those landmarks. The short name is "<Ordinal> lamp <relation> <landmark>". The
first naming of a lamp id gives one `lamp-ash`. Camp setting and naming need `keeper:hand`, and
naming a camp also needs one of its builders.

The mage's deeper naming is a later working: a dark-stone rest light until the turning, even
inside a hold. It grants no hold or recurring oil exemption. Retire the old oil-substitution
proposal; broad magic is outside these two releases.

### 2.9 Words and art

Keep Mara's careful, dry affection, Wenna's ledger example, the cut and *The Form of a Naming*.
Write the latecomer's tending line, tree/chandler oil explanation, Pell's collection lines and
plain setup warnings. Proposed lapse line: **“The woods turned. Pell has your things.”**
Never promise “for good” for a Wilds claim. For a reload onto blocked ground, keep
**“The drift turned while you stood in it.”**

Reuse delivered art:

- [Dark stone](../../assets/generated/open-map-pass/frames/lamp-stone-dark.png) and the four
  `frontier-veil-*` frames beside it from the open-map pass.
- [Bare stake](../../assets/generated/hearthwick2-pass/frames/lantern-stake-0.png) and
  [lit stake](../../assets/generated/hearthwick2-pass/frames/lantern-stake-1.png) for lot backs.
- [Name a lamp](../../assets/generated/crafts-pass/frames/ability-mage-name-a-lamp.png) and
  [Old ways](../../assets/generated/crafts-pass/frames/ability-mage-old-ways.png) icons for later
  magic. Drawn icons do not mean implemented abilities.

[The earlier art request](../art-request-lamps.md) remains the reference for way-lamp,
relit/named stone, cut panel, ash, pouch and turncap. These need delivery/integration; do not
claim a `lamps-pass` exists. Add store and readable dimming states. Reuse the icon concept for
the map's Lamps layer, not a Journal tab. Match front-facing outdoor props at 64 texels per
16 world pixels, final art before acceptance.

## 3. The eleven old questions, closed

These are Q1–11 in their old order. No unanswered proposal carries over.

| Old question | Answer or retirement |
|---|---|
| Q1 · Release scope | Roadmap: 0.12 holds/lot lanterns; 0.13 Common ways, Built camps, Keeper and map. Broad magic/story are not prerequisites. |
| Q2 · Frontier band | Retired: the open map exists. Extend reach with live Built holds, not the old finite band. |
| Q3 · First lamp and coverage | First hold is one lot backland in 0.12. Quest stone is Common on the northbound Lantern Road in 0.13; retire `(3,1)`, east-column permanence and automatic 3×3 coverage. |
| Q4 · Cost without clay | Stone footing and proposed flat parts (§2.5). Clay waits for 0.16; retire distance escalation for this slice. |
| Q5 · Naming | Parts only, server-validated landmarks, short names from those parts (§2.8). No free text. |
| Q6 · Mage's Name a lamp | Park the working; retained design is a temporary rest light until turning, no hold/recurring-oil exemption (§2.8). |
| Q7 · What lasts “for good” | Hearth/lot builds do. Wilds Built detail lasts while Held/Dimming; lapse recovers everything. Keep ordinary respawn timers, renew chest entitlement by calendar wick, expire weekly magic/lantern/Echo offers (§2.2). |
| Q8 · Ways home | Both single-use recipes in 0.13, three-second pause, no combat; failed/stale pouch preserves the item (§1.4). |
| Q9 · Map | World map Lamps layer and Details ledger, phone sheet, no Journal tab (§2.6). |
| Q10 · Chapter 2 | Roadmap 0.15 with span/expedition, not an immediate separate post-Lamps release. |
| Q11 · Glims | Parts/oil, no extra lamp fee. Walking, Common tending and recovery free; extra chandler oil may have a price. |

## 4. Build lanes and release boundary

Lanes describe assignable work, not agents to start now. Choose the next available migration
and contract numbers during implementation; stale numbers are not reserved here.

### 4.1 0.12 — holds and lot lanterns

**Promise:** light the lot lantern, keep the woods behind home through a turning, extend the yard.
No way-lamps, camps, Keeper gate or presence-kept Common land in this release.

| Lane | Delivers | Depends on |
|---|---|---|
| A · Contract and safe saves | Backups and demonstrated restore before persistence; hold/claim/store/recovery identities, boundary cursor, vectors, terrain/calendar scope | Roadmap and this contract |
| B · Geography and holds | Stable seed split, versioned generator expectations, held read/authorization, retention, material expiry and access | A's keys/epoch contract |
| C · Backland and recovery | Tree/chandler oil, bounded services, connected lanterns/store, weekly debit/warning, atomic packing and Pell collection for objects/plants/paths | A; B's resolver |
| D · Drawing and acceptance | Lot/store flows, reserve/warning in world and existing map, final art; arrival long frame and two E2E flakes riding with the feature | A's view types; B/C integration |

**As built in 0.12:** holds and lasting geography (migrations 038, 039) and lot lanterns (040)
shipped; the backland lapses to home storage, not Pell's crate, and its laid paths turn with it
without a refund (§2.7). The tree/sap supply is the chandler's `hearth-oil`. Pell's crate came
with camps in 0.13 (migration 041); common ways (042) then crated the backland's paths on lapse.

A leads; B/C can build against that contract, D against its view types. Integrate recovery before
real lapse. Warnings, buffer and safe backland collection cannot wait for 0.13. Common preservation
is absent, but paid paths on turning land must refund before cleanup under zero-loss; use the
same recovery primitive without introducing Common presence yet.

Acceptance tests: west/east lots hold across turning; only lit service tiles extend; core lots
never lapse; empty fuel gives a full warning wick; a friend refuels; the next missed judgment
recovers objects, plants, path materials and store at Pell; collect and rebuild. Check stable
landforms with changed unheld detail, all backland access, restart/retry and backup restore.
The build lane supplies the owner's focused walk; this docs rewrite does not run the game.

### 4.2 0.13 — common ways and dimming camps

**Promise:** roads friends walk stay open; players set/name way-lamps; the map shows all tiers.

| Lane | Delivers | Depends on |
|---|---|---|
| E · Common work | Durable occupancy, path adoption, safe overlays, communal lamps, cross-chunk ways and unvisited refunds | 0.12 boundary/recovery engine |
| F · Built camps | One-chunk claims, camp/store operations, frontier union/access, full recovery with contents/ownership, public deposits | 0.12 holds; shared rules with E |
| G · Keeper and naming | Mara quest/stable target, marks, parts-only naming, ash, ways home, words/art | E/F lamp ids and operations |
| H · Map and acceptance | Tier status, Lamps layer/ledger, Common sections and warnings, desktop/phone integration | E/F view types; G names |

Agree tier precedence and lamp identities before splitting E/F. G/H can begin against the
contract, then integrate the real server. Acceptance: one visit keeps a common path; an unused
branch turns/refunds; a solo Keeper establishes a camp; someone else tends it asynchronously;
a missed-oil camp warns then recovers all contents; world/map agree; both ways home work.
After each release, run the roadmap's step-back review. Neither release waits for a mage/charter.

## 5. Tests the build must carry

These are implementation requirements, not tests run by this docs lane.

- **Generation/access:** stable riverbank/landform samples across several wicks with changing
  detail; glimpse agrees. Held body hashes stay identical. Exercise negative coordinates,
  multiple held epochs, all backlands, separated patches, stable water/fords and full walks
  from town after turnings and an intervening claim's lapse.
- **Resolver/retention:** fixed wins, still stays permanent, exact held keys alone read ended
  epochs. Near/entity/fight/path reads agree. Cleanup keeps held state; material `ends_at` no
  longer hides it. Magic expires; chest entitlement renews once per calendar wick without
  duplicating Echo, rumour or lantern rewards.
- **Weekly judgment:** every §2.3 row at T−1/T/T+1; top-ups on either side, three-vial exhaustion,
  full warning length, no mid-wick upkeep writes, missed boundaries, restart and concurrent
  readers. Replay never burns/packs twice; partial balances have no order-dependent drain.
- **Presence:** stand beside a path, use another chunk tile, cross chunks, reconnect, remain
  connected across turning. One visit keeps every Common section in that chunk. Prefetch,
  neighbour visibility, map view and offline positions never count. Cross-seam laying/tending
  credits the target chunk. Bound durable writes and
  retry a failed first-visit insert.
- **Common overlays:** no new blocker on retained path/lamp footprints; surrounding detail turns.
  Only necessary clear corridors survive. Partial trails and named ways reroute/break honestly.
  Lift versus lapse cannot pay twice. Adopt old paid paths before epoch-bound rows expire.
- **Recovery conservation:** compare every instance id, nested content, plant state, remaining oil
  and paid path quantity before/after packing and collection. Include multiple contributors,
  full destinations, wrong-world/unauthorized access, repeated collection, lift/top-up/lapse
  races and crash rollback. No missing crate after cleanup or changes to permanent lots and
  surviving neighbours.
- **Quest/operations:** range/world/material/claim checks, deposits/retries/capacity, no public
  withdrawal; no class gate; latecomer completion; invalid naming parts refused; one ash reward;
  stale/cross-world pouch retains item; safe destinations; combat refuses travel.
- **UI:** all tiers, Common visit extent, reserve/prediction and full warning on desktop/phone,
  with non-colour cues. Ledger selection/focus respects map exploration. A second account sees
  tending/recovery after reload.

Use Go generator/chunk/store/API tests for geometry and transactions; TS tests for naming and
status. Add focused E2E walks for both promises with controlled turning boundaries, not real-week
waits. Run changed checks per lane and required merge checks once at integration.

## 6. Later, on purpose

- **The Old ways:** parked, including paired-lamp travel/storm oil. Keep the drawn icon.
- **Clay base:** 0.16 lake country and Aldo's kiln; stone footing until then.
- **Building tiers and station-chain crafting:** 0.14, arranging props and composing crafted kit
  pieces, already covered by recovery. No terrain painting/excavation tier.
- **Wilds hearth charters:** 0.14, additional to the Hearthwick deed. Their land is Built, using
  the same holds/oil/warning/recovery contract. Two or more co-signers on multiplayer worlds,
  one on a one-member world; that charter stands when more join. No moved deed or charter gate
  for a personal camp.
- **Chapter 2/expedition:** 0.15, after the owner's lore pass; not part of this build.
- **Standalone edition:** after the 0.14–0.16 loops are proven. No new Habitica calls outside its
  seam; lamps, oil and recovery are Glimway systems.
- **Other magic/regions:** mage temporary naming, other workings, cracks/Mend, two-player magical
  naming, forecasts and cave lamps need their own slices.

## 7. Questions for the owner

No blocking rules questions remain. One supply choice deserves an owner playtest; the build can
use this proposal with numbers kept in content.

| Question | Proposed answer |
|---|---|
| How generous is the tree/chandler's initial oil supply? | **Answered 2026-10-17, built (§2.5):** one free tap of Wick Tree sap per player per calendar wick, refined free by the chandler into one flask of hearth oil (one backland's wick). No carry-over. Extra oil stays at 4 glims, 3 a day. Numbers are in content (`homestead.wickSap`) for the playtest. |
