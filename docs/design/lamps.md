# Lamps (0.9)

Status: **design, waiting on the owner's answers** (section 0), 2026-10-10. Written after 0.7
(Silas's Yard) reached `dev` at `b0e57dc`. Docs only; nothing here is built yet.

**Moved to 0.9 (owner, 2026-10-10).** The owner chose to build the open map first, as 0.8
([open-map.md](open-map.md)). The frontier band in 2.1 is now **provided by the open map**, and
lane L-B is gone. The rest of this doc stands as written until Lamps are planned again after 0.8.
What that re-plan must change:

- Coordinates follow the open map (open-map.md 2.1): the Whitequiet is the 3×3 at cx −1..1,
  cy −5..−3, and the "far route stone at (3,1)" (Q3) becomes a stone on the Lantern Road, which
  leaves the Whitequiet northward.
- Holds extend the open map's `frontier.Inside` and `chunkEpoch`; `region_epochs` and its
  `held_mask` are replaced by the open map's `wild_epochs`; the near read already exists.
- `lamp-stone-dark` and `frontier-veil` art move to the open map's request.
- Numbers shift: the open map takes migration 034 and contract 8, so Lamps take the next free
  ones (035 and 9 if nothing lands between).
- Chapter 2 comes after Lamps, not as 0.9.

The plan calls Lamps "the spine" ([plan.md](plan.md), "The shape of it", item 3): way-lamps push
the frontier, the Keeper's hand teaches the naming, the mage's craft is naming, and the Old ways
link lamps. The plan put Lamps after two revisions that come first: the open map (W1–W2) and lake
country (W3–W4). **Neither has been built.** The owner first moved Lamps up to 0.8, then chose to
build the open map first (see the note above), so Lamps are 0.9.

**Rules this design keeps:** [server-first.md](server-first.md) (the server owns state, the client
predicts and draws), [habitica-boundary.md](../habitica-boundary.md) (the game never grants or
duplicates Habitica items), decision 10 in [world.md](world.md) (made with materials lasts for
good inside lamplight; magic holds until the turning), decision 12 (the Keeper's hand is for
everyone; the mage's naming is the deeper magic), and no placeholder art.

---

## What exists today (checked in the code, `b0e57dc`)

**The Wilds are still two fixed regions.** `content/wilds.json` has `inner-1` (the Tangle,
permanent) and `outer-1` (the Whitequiet, turns every wick). Each is a 3×3 grid of 24-tile chunks.

- The server generates them (`server/internal/wilds/gen_v2.go`: `GenerateRegion` :159,
  `GenerateChunk` :179). It refuses any chunk outside the grid (`GenerateChunk` :185). Edge gaps
  hash from the epoch alone (`edgeOffset` :320). Sites are dealt over the 3×3 per epoch
  (`siteSlots` :485).
- Epochs are per region, not per chunk. `store.Chunks.Create`
  (`server/internal/store/chunks.go:94`) makes the region's epoch and stores all nine chunk blobs
  in one go. The Whitequiet's epoch ends at the next turning (`content.NextTurning`). **A wick is
  7 days** (`content/clock.json` `wickDays: 7`).
- `chunks.Validate` (`server/internal/chunks/read.go:82`) refuses `cx` or `cy` outside 0..2, even
  though `chunks/source.go` says they are "signed for the open map".
- The client reads a whole region at once (`GET /api/wilds/region/<id>`, `wildsService.Region`,
  `server/internal/api/wilds.go:165`; `src/game/wilds/store.ts`). Each chunk is its own scene
  (`chunk:<region>:<cx>:<cy>`, `src/game/wilds/regions.ts:56`; its regex already accepts
  negatives). Positions are region-wide pixels.
- **No open map:** no noise across chunks, no cells, no rings, no per-chunk epochs, no frontier.
  `world.md` "Today" (lines 82–91) is out of date: it still says the client generates the Wilds.

**Lamplight exists, but only on homestead land.**

- `server/internal/land/land.go:158` `Light`, `Lit`; the home lamp at (20,10) with radius 7.
- Lantern posts (`content/homestead.json` `lanternPosts`, radius 5; `HomePostCost`,
  `content/homestead.go:63`) chain out from the home lamp. `connectedLights`
  (`server/internal/api/home_placement.go:64`) counts a post only if it stands in light that
  already counts.
- Inside that light, stumps, cleared tiles and plants are kept (`api/gathering.go:307-327`,
  `api/plants.go:52-91`). The unlit edge regrows. The client mirror is `src/lib/homestead-land.ts`
  (`homeLights`, `isLit`). `drawShade()` (`src/game/entities/homestead-art.ts:303`) darkens unlit
  tiles.
- **This is the model for way-lamps:** the same chaining rule and the same "kept inside the
  light", at chunk scale.

**Other lamps that already exist:**

- **Road lanterns** `road-1..3`: lit per player for 3 glims (`server/internal/api/spend_op.go`,
  mark `lit:<id>`), and they are rest spots (`src/game/entities/hero.ts:289`).
- **Fallen-hero lanterns** in the Whitequiet (`lanterns` table; `PlaceFallen`,
  `api/wilds.go:747`; relit by others through `POST /api/wilds/lantern`). They are per epoch, so
  they go at the turning.
- **The library lamp** (`seat-by-the-lamp`) and **Ada's village lamp** (`village-lamp` in
  `content/repairs.json`).

**World changes:** `server/internal/worldchange` (`Get`, `Put`; table `world_changes`, migration
030). Its only writer is the mill pond's fish stock (`api/fishing.go:34`, kind `fishery`), which
never expires. Nothing yet writes a change that ends at the turning.

**Lamp parts are already items** (`content/items.json`):

- `lamp-head` :766, `lamp-wick` :302 (bench recipe `craft-lamp-wick`), `hearth-oil` :879 (hearth
  recipe `hearth-hearth-oil`: 3 amber and tallow), `storm-oil` ("kept for the old ways"),
  `turncap-spawn`, `turncap-jar`.
- The gathering node `lamp-stone` ("Old lamp-stone") drops nails and, one time in five, a lamp
  head.
- **Hearth oil's use, `light-post`, does nothing.** `ImplementedUses` (`content/items.go:43`) only
  covers the HP, mana and unmoored uses. Homestead posts cost timber, stone and amber, not oil.

**Quests:** chapters 0 (`signpost`) and 1 (`lantern-road`) exist, plus the village and craft
quests.

- The step model (`proto/glimway/content/v1/quests.proto`) has gates `with`, `wait`
  (hours | turnings), `item` and `glims`; grants `items`, `marks`, `papers`, `glims` and `give`
  (gated); and witnesses `warden` and `lantern`.
- The `keepers-hand` draft in `quests.md` uses fields that don't exist (`needs: "world"`,
  `grants`, `unlock`, `gate.at`, `witness: "keeper"`). This doc rewrites it in the real model.
- Chapter 2's paper `dorrits-second-span` already ships (`content/papers.json:522`), found at the
  Tangle's `plank` site by the crossing.

**Magic:** `content/abilities.json` has eight moves, a signature (level 10) and a combat move
(level 20) for each class.

- `abilities.proto` only allows `kind` ∈ {signature, combat}. Its comment says `working` joins
  "with the first working".
- No working exists. Name a lamp's and the Old ways' icons are already drawn
  (`assets/generated/crafts-pass/frames/ability-mage-name-a-lamp.png`, `…-old-ways.png`).

**No pottery, clay or kiln anywhere.** The way-lamp's "fired clay base" has nothing to come from.

**No map panel.** The journal has three tabs (`src/ui/JournalPanel.svelte`: Quests, Papers,
How do I…?).

> **Migration note (2026-10-11):** that's no longer the baseline. 0.8 had a Journal Map tab, and
> it has since moved out to the full-screen **world map** on M (`src/ui/WorldMap.svelte`,
> [world-map.md](world-map.md)); the Journal is back to these three tabs. The lamps pass builds
> on that map: see the notes in decision 10, 2.6, 2.7, the art list and the e2e list below. No
> lamp feature is built by the map work.

**Next free migration: 034** (`server/internal/store/migrations/`, last `033_glims.sql`).
**Contract: 7** (`content/contract.json`).

### What each piece really needs

| Piece | Needs from the open map or lake country | On today's world? |
|---|---|---|
| **The Keeper's hand** (quest) | A dark lamp stone at the Whitequiet's far edge, fixed in place | **Yes.** It needs one authored site and one quest. The quest model needs a server mark, which it has (`marks` on a gated step) |
| **Way-lamps hold land** | Chunks that keep their layout while their neighbours turn: **per-chunk holds** (W2's core) | **Not as is.** Today a whole region turns at once. And a 3×3 hold in a 3×3 region would freeze all of the Whitequiet with one lamp |
| **Way-lamps push the frontier** | Land past the Whitequiet, made on demand (W1–W2) | **No.** There is no land past the Whitequiet |
| **The clay base** | Lake country's river clay and Aldo's kiln (W3–W4) | **No.** Needs a stand-in |
| **The mage's Name a lamp** | Dark lamps out there; a "working" kind; a world change that ends at the turning | **Yes**, once dark lamp stones exist. The `worldchange` table already supports `ends_at` |
| **The Old ways** (mage, level 30) | Named lamps far enough apart to be worth linking; travel between two chunks | **Technically yes**, but it is worth little until there are many lamps |
| **Chapter 2, Dorrit's span** | An authored crossing; projects that take glims; `project`/`world` gates and `wait since`; a far bank | **Yes, mostly.** The plank site is in the Tangle today. It doesn't need lamps at all |
| **Ways home** (turncap, lamp-ash) | Somewhere far enough to need them | **Yes**, once the frontier exists |

**So the true prerequisite is small and specific: per-chunk holds and a little land past the
Whitequiet.** It is not the whole open map. No noise fields, no rivers, no new kinds of land.
This doc calls it **the frontier band** and sizes it as one L lane (2.1).

---

## 0. Questions for the owner

Reply "all as proposed" or change the ones you want. Numbers that are only tuning are listed after
the table.

| # | Question | Proposed answer | Why |
|---|---|---|---|
| 1 | **What is 0.9?** | **Lamps on the open map:** the Keeper's hand, way-lamps that hold land and push the frontier, the mage's Name a lamp, and the two ways home. **Out of 0.9:** chapter 2, the Old ways, the clay base and new kinds of land (section 6). (The owner chose to build the open map first, as 0.8, on 2026-10-10.) | The lamps are the spine. The band is the least map that lets them mean something |
| 2 | **The frontier band** | The Whitequiet stops being a closed 3×3. Chunks past it are made on demand by **today's generator**, north, east and west (never back toward the Tangle). A chunk keeps its layout for good once a lamp holds it; every other chunk past the Tangle turns with the wick. With no lamps lit, the game plays as today | It reuses the generator, the chunk store and the client's chunk scenes. The open map's noise, rivers and lands come later and replace it |
| 3 | **The first lamp: where it stands, what it holds** | The far route stone stands **one chunk east of the Whitequiet** at (3,1), on the old road toward Sallow Ford. Relit, it holds the Whitequiet's **east column** for good; the other six chunks keep turning until someone sets lamps there. Later lamps may stand anywhere inside the frontier, the Whitequiet included | East is canon (the Six went east). A stone inside the 3×3 would freeze most of the Whitequiet in one go |
| 4 | **A way-lamp's cost, with no clay yet** | A **stone footing** stands in for the clay base until lake country. A new lamp *d* chunks out costs timber 6+2*d*, stone 4+*d*, a lamp head, a lamp wick and one hearth oil. **An old dark lamp stone** needs only a wick and the oil. When lake country lands, the footing becomes a fired clay base (a content change) | Same canon parts as the lantern post (crafting-and-repair.md), so it fits what players know |
| 5 | **Naming** | Built **from parts only**: an ordinal, a relation (past, beside, above, below), a real landmark in the chunk, what's behind and ahead, and a closing line. The short name comes from the same parts. **No free text**, because everyone in the world sees it | Shared text needs moderation; chosen parts don't. They also keep the Keeper's form |
| 6 | **Name a lamp (mage, level 10, 10 mana)** | It lights **dark lamp stones** as rest spots **until the turning**. It does **not** move the frontier or hold land. It stands in for the hearth oil **when the mage lights the way-lamp themselves**. Fallen-hero lanterns keep their own relight | Decision 10: magic holds until the turning. One clear target keeps it simple |
| 7 | **"For good inside lamplight", in 0.9** | A held chunk keeps its layout, its camps and nodes and their timers, its sites, and the lamp. Things already tied to the wick still go at the turning, even in a held chunk: fallen-hero lanterns, mage-lit stones, the week's Echo slots. **Chests in a held chunk refill each wick**, per player, as in turning land | The world.md rule, applied to what exists. Without the chest rule, held land would stop paying out |
| 8 | **The ways home** | A **homing turncap** (a turncap spawn set in 2 amber; crush it to walk back to the Commons' Wilds gate) and a **lamp-ash pouch** (ash you get when you name a lamp, plus 2 fibre; scatter it to step back to that lamp). Each is used up. Neither works in a fight; each needs a 3-second pause. Both recipes are papers Mara gives with the Keeper's hand | The plan's sketch (plan.md, "Ways back without a mage"). With no Old ways in 0.9, these are the way back |
| 9 | **A map** | A **Lamps** tab in the journal: Mara's ledger. It lists the world's lamps (name, who named it, how far out) and shows a simple drawn grid of held land, the frontier and where you are. No new art | The frontier is invisible without it. A grid drawn in the UI is cheap |
| 10 | **Chapter 2** | Its own small release, straight after Lamps. Its crossing stays in the Tangle, where the plank site already is | It doesn't need lamps, and it adds three gate kinds and glim-taking projects. Together they'd make Lamps twice 0.7's size |
| 11 | **Glims** | Lamps cost **materials only, no glims** | Lamps are the long shared goal for crafting (world.md). Glims stay for rests, mending and the shops |

**Tuning, not decisions** (playtest, change data): the 3-chunk slack and 3×3 hold (agreed
2026-10-07); the cost curve in Q4; how far apart old lamp stones are; the 10 mana; the turncap's
and pouch's recipes; how much harder camps get by distance (2.1).

**Habitica boundary:** nothing in 0.9 touches Habitica. Name a lamp *reads* the class and the
level mark (`rules.Craft`, `rules.Unlocked`, `server/internal/rules/magic.go`), as the level-20
moves do. Lamps, oil, wicks, turncaps and ash are Glimway items made from Glimway materials.

---

## 1. The player's view

1. **After the lantern road.** Mara is at the ledger. Talk to her: "The road's held, you said. It
   isn't. Not out there." She asks you to go to the dark stone past the Whitequiet's east edge and
   copy the cut beside it.
2. **The far route stone.** Cross the Tangle and the Whitequiet, east. The land past the east
   edge is new, and only one chunk of it is open: the road runs into a dark lamp stone with words
   cut in its side. Use it to copy the cut. Go further east and the path bends. You come out
   facing the way you came: that's the frontier.
3. **The ledger.** Back in Hearthwick, Mara finds the same words in the middle pages. "Noted."
   She writes your name in as **a Keeper's hand**. She gives you *The Form of a Naming* (a paper),
   a lamp head from the Count House, and the recipe pages for the homing turncap and the lamp-ash
   pouch.
4. **Relight the stone.** Bring a lamp wick and a hearth oil to the far stone (a mage can use
   their naming instead of the oil). It lights. You name it from parts: *"You are the first lamp
   past the Whitequiet. Behind you the road; ahead the old shrine. Hold fast."* The short name is
   "the road stone". Everyone in the world sees it.
   - If someone in your world lit it first, you tend it instead: trim the wick, read their naming.
     The step completes either way.
5. **The frontier opens.** The east column of the Whitequiet and the eight chunks around the
   stone are **held**: they keep their layout through the turning. The frontier is now three
   chunks past any held chunk, so new land opens east and north of the stone.
6. **Setting your own lamps.** Anywhere inside the frontier, in a chunk that isn't held yet, the
   action button offers **Set a way-lamp**. It shows the cost, which grows with distance, and says
   "This holds this stretch and the eight around it, for everyone, for good." Name it, and the
   frontier moves out. You get one **lamp ash** from each lamp you name.
   - **Old dark lamp stones** stand along the old road east and here and there elsewhere.
     Relighting one costs only a wick and oil, so following the road is the cheap way out.
7. **The turning.** At the end of the wick, unheld land past the Tangle turns. If you're standing
   in it, the Turning plays and you come out at the nearest lamp. Held land doesn't move.
8. **Mages.** From level 10 a mage can **Name a lamp** at a dark lamp stone: it lights for
   everyone as a rest spot until the turning, with no oil. It doesn't hold the land.
9. **Getting home.** Crush a **homing turncap** to walk back to the Commons' gate. Scatter a
   **lamp-ash pouch** to step back out to the lamp you named. Neither works mid-fight.
10. **The ledger tab.** The journal's **Lamps** tab lists every lamp in the world, and shows a
    small grid: held land warm, turning land grey, the frontier's edge, and you.
    *Migration note ([world-map.md](world-map.md) 6):* the ledger lives on the world map now, not in a Journal tab: a
    **Lamps** layer control and a ledger in the map's Details, held land shaded warm on the map's
    own terrain (no second grid). Same ledger contents; selecting a lamp centres its mark.

---

## 2. The build

### 2.1 The frontier (provided by the open map)

The open map (0.8, [open-map.md](open-map.md)) builds what this section used to: signed chunk
coordinates, chunks made on demand, per-chunk epochs, seams, the near read, the frontier at run
time (`frontier.Inside`), dark lamp stones on the Lantern Road, and tiers by distance. Lamps add
only the holds:

- `held_chunks` (world, cx, cy, epoch): a chunk is held once a way-lamp's 3×3 covers it, in the
  epoch it was in then. `chunkEpoch` returns the held epoch first.
- `frontier.Inside` grows from "within 3 of the Tangle or the Whitequiet" to "within 3 of those
  or of a held chunk".
- Ended wick epochs are kept while a hold names them (open-map.md 2.3).
- The turning moves a player in unheld land to open ground as the open map does (its decision
  10); this doc's "move to the nearest lamp" is dropped.

### 2.2 Content

| File | Change |
|---|---|
| `content/lamps.json` (new; proto `proto/glimway/content/v1/lamps.proto`; loaders `content/lamps.go`, `src/lib/lamps.ts`) | `hold: 1` (chunks each way, so 3×3), `slack: 3`, `cost: { timber: [6,2], stone: [4,1], parts: [lamp-head, lamp-wick], oil: hearth-oil }` (base and step by *d*), `stoneCost: [lamp-wick, hearth-oil]`, `naming: { ordinals, relations, closings, landmarks: { <site or poi kind>: "the old shrine", … } }`, `nameMax: 40`, `pauseSeconds: 3` for the way-home items |
| `content/wilds.json` | `outer-1` gains `baseLight` (the 3×3 plus (3,1)), `band: { maxCy: 2 }`, `bands` (camp mix and amber by distance), `lampStones: { roadRow: 1, roadFrom: 3, roadEvery: 2, scatterPermille: 170 }`. Site kinds `lamp-stone`, `route-stone` in `proto/glimway/v1/wilds.proto` `SiteKind` |
| `content/abilities.json`, `abilities.proto` | `kind` allows `working`. `name-a-lamp`: mage, `working`, level 10, mana 10, icon `ability-mage-name-a-lamp`. `validateAbilities` allows one working per class per level |
| `content/quests.json` | `keepers-hand` (2.5) |
| `content/story.json` | Server mark namespaces `keeper:` and `lamp:`; spot `far-route-stone`; witness `keeper` (in `QuestStep.witness`'s `in` list) |
| `content/items.json` | `homing-turncap` (use `homing`), `lamp-ash` (an instance that names its lamp), `lamp-ash-pouch` (instance, use `to-lamp`). Recipe papers `recipe-page-homing-turncap`, `recipe-page-lamp-ash-pouch`. `hearth-oil` text: "Lights a way-lamp once." Its `light-post` use goes, since lighting takes the oil as a part |
| `content/items.go`, `src/lib/items.ts` | `ImplementedUses` gains `homing` and `to-lamp` |
| `content/crafting.json` | Bench `craft-homing-turncap` (turncap-spawn 1, amber 2; page) and `craft-lamp-ash-pouch` (lamp-ash 1, fiber 2; page; the pouch keeps the ash's lamp) |
| `content/papers.json` | `the-form-of-a-naming` (from Mara), the two recipe pages, and the route stone's cut copy `far-naming-copy` |
| `content/vectors/lamps.json` (new) | Shared Go/TS vectors: inside/held for sample lamp sets, cost by distance, naming parts per landmark set |
| `content/contract.json` | 8 |

### 2.3 Server

**Migration `034_lamps.sql`:**

- **`way_lamps`**: `world_id`, `id`, `region_id`, `cx`, `cy`, `tx`, `ty`, `kind` (`set` or
  `stone`), `site_id` (for stones), `lit_at`, `lit_by`, `by_naming` (a mage's naming stood in for
  the oil), `naming` (the chosen parts, ProtoJSON of `LampNaming`), `short_name`, `named_by`.
  Unique on (world, region, cx, cy): one lamp per chunk.
- **`held_chunks`**: `world_id`, `region_id`, `cx`, `cy`, `epoch_id`, `lamp_id`, `held_at`.
  Primary key (world, region, cx, cy).
- **`region_epochs.held_mask`**: TEXT, the base chunks held when the epoch was made.
- Append to `migrations/history.json`.

**A new package, `server/internal/frontier`.** Pure functions with no SQL, shared with the
vectors:

- `Inside(base, held, cx, cy)`
- `Covers(lamp) []Chunk`
- `Distance(base, cx, cy)`
- `Nearest(lamps, cx, cy)`

Plus a store reader, `store.Holds(ctx, tx, world, region)`, which reads the held chunks once per
request.

**Operations** (proto in `proto/glimway/v1/lamps.proto`; outbox operations that need a
connection, like `fish-cast`):

| Operation | Checks | Does |
|---|---|---|
| `lamp-set` `{ where, naming }` | Mark `keeper:hand`. The chunk is inside and not held, and has no lamp. The tile is walkable, at least 2 from an exit gap, not on an entity or site. Materials by *d*. The oil, or a naming: the caller's class is mage and `name-a-lamp` is unlocked, and 10 mana is debited instead. The naming parts are valid for this chunk's landmarks | Takes the parts. Writes `way_lamps`. Writes `held_chunks` for the 3×3 (chunks already held keep their epoch). Gives one `lamp-ash` naming this lamp. Writes a naming slip to Papers (as posts do). Presence event `lamp` so others redraw |
| `lamp-relight` `{ where, site }` | Mark `keeper:hand`. A `lamp-stone` site in this chunk's current epoch, inside, chunk not held, no lamp yet. A wick, and the oil or a naming | As `lamp-set`, kind `stone`. At `route-stone` it also sets the mark `lamp:far-route-stone` |
| `lamp-tend` `{ where, lamp }` | Mark `keeper:hand`. A lit lamp | Free. At the far stone it sets `lamp:far-route-stone`, so a later Keeper's hand can finish the quest |
| `working` `{ ability: "name-a-lamp", where, site }` | `rules.Craft` is mage, `rules.Unlocked`, mana ≥ 10. A dark `lamp-stone` in this chunk's epoch, with no way-lamp | Debits mana. `worldchange.Put` kind `named-lamp`, key (world, `hearthwick`, 0, `"cx,cy"`, epoch, site id), `ends_at = content.NextTurning(now)`. The first expiring world change |
| `item-use` `homing` / `to-lamp` | The item is carried. Not in a room. `to-lamp`: the lamp still stands (they're never snuffed). Fights are judged on the client (see below) | Uses it up. Sets the place server-side (the `recoverRoom` path): the Commons by the Wilds gate (`COMMONS_FROM_WILDS`), or the lamp's tile |

- **Fights.** The server can't see a fight, so the client refuses the use while an enemy is
  aggroed or within 2 s of a hit, and shows the 3 s pause. That's the same trust model as hurt
  (plan.md, "Shared fights").
- **Errors.** New codes for: not a Keeper's hand, beyond the frontier, chunk already held, lamp
  here already, bad naming part, nothing to name. They go in the next free range of the error
  catalog.
- **Reads.** The near read (2.1) carries lamps, held chunks and live `named-lamp` changes.
  `worldchange` gains `ListChunk(ctx, q, world, realm, layer, chunk, epoch, now)` for the last of
  these.
- **Rest spots.** A lit way-lamp or a mage-lit stone is a rest spot. The rest operation's target
  check (kinds `rest`, `home-rest`, `road-lantern`) gains `wilds-lamp`, so rests there recover as
  at road lanterns.
- **Tests:** see section 5.

### 2.4 Game

- **Chunks with signed coordinates.**
  - `src/game/wilds/store.ts`: `outer-1` uses the near read and keeps a sparse map of chunk →
    epoch and held. `regions.ts` already parses negatives. The region-wide pixel convention
    holds; audit `Math.floor` vs `| 0` and `%` on negatives.
  - `src/game/wilds/chunks.ts`: the IndexedDB cache keys by epoch already, so held chunks stay
    cached.
- **The frontier edge.** An exit marked `edge` draws the Turning's veil in its gap
  (`src/game/scenes/world-turning.ts`). Walking in turns you round to the same gap, facing back,
  with one line: "The path bends. You're facing the way you came."
- **Lamps drawn.** Way-lamps (lit) and dark and named lamp stones are entities in the chunk (via
  `src/game/wilds/sites.ts` and `entities.ts`), with the warm `glow` used by `area/lanterns.ts`.
  Held chunks are drawn as today. Entering a chunk shows a small chip, "In lamplight" or "Turns in
  3 days", from the near read.
- **Interactions** (one registration each on the interactions path, as fishing's banks):
  - *Copy the cut* at the route stone.
  - *Relight* at a dark lamp stone, if you're a Keeper's hand.
  - *Name a lamp* on the ability button, if you're a mage at a dark stone.
  - *Tend* at a lit lamp.
  - *Set a way-lamp* anywhere valid.
  - *Rest* at a lit lamp.

  Validity is predicted from the near read and `frontier` (TS mirror, `src/lib/frontier.ts`);
  the server decides.
- **The turning** in held land does nothing. In unheld land, the Turning plays and you come out
  at the nearest lamp (the server's answer).
- **Way-home uses:** a 3 s channel with a ring, then the server's place, then a scene change.
- **Goal guide:** `src/game/entities/goal-guide.ts` routes `far-route-stone` through the Tangle
  and the Whitequiet. `src/content/guides.ts` gets a "How do I set a lamp?" guide.

### 2.5 The Keeper's hand, in the real quest model

```json
{
  "id": "keepers-hand",
  "title": "A Keeper's Hand",
  "line": "road",
  "after": ["lantern-road"],
  "start": { "talk": "mara" },
  "steps": [
    { "id": "hear-mara", "at": "village", "do": { "talk": "mara" },
      "goal": "Hear Mara out about the ledger", "where": { "area": "village", "npc": "mara" } },
    { "id": "copy-cut", "at": "wilds:outer-1", "do": { "use": "far-route-stone" },
      "papers": ["far-naming-copy"],
      "goal": "Copy the cut past the Whitequiet", "where": { "area": "wilds", "spot": "far-route-stone" } },
    { "id": "check-ledger", "at": "village", "do": { "talk": "mara" },
      "gate": { "with": "mara" },
      "give": [{ "def": "lamp-head", "qty": 1 }],
      "marks": ["keeper:hand"],
      "papers": ["the-form-of-a-naming", "recipe-page-homing-turncap", "recipe-page-lamp-ash-pouch"],
      "goal": "Check the cut against the ledger", "where": { "area": "village", "npc": "mara" } },
    { "id": "relight-stone", "do": { "flag": "lamp:far-route-stone" }, "witness": "keeper",
      "goal": "Light the stone at the edge", "where": { "area": "wilds", "spot": "far-route-stone" },
      "moment": { "eyebrow": "The road held", "title": "A Keeper's Hand" } }
  ]
}
```

- `check-ledger` grants a server mark (`keeper:`, a server-written namespace) through a gated
  step. That is the existing way to hand over a capability; no `unlock` field is needed.
- `relight-stone` watches a mark that `lamp-relight` or `lamp-tend` sets, so lighting stays one
  operation.
- `copy-cut` at an outer chunk: the step's `at` names the region's area (`wilds:outer-1`). The
  server's `use` trigger checks the player is in the spot's area (`content.QuestSpotArea`); a Wilds spot needs the chunk too. **Check during lane L-A**
  that `questTrigger` (`api/quest_rules.go:70`) handles a `use` on a Wilds site. Today only area
  spots do; adding site uses is a small branch.
- `witness: "keeper"`: Mara and anyone in the chunk see the beat (as `lantern`).
- **No `needs`:** guests and class-less heroes can take it.

### 2.6 UI

- **`src/ui/LampNaming.svelte`** (new): the fill-in naming built from parts. Chips for each blank,
  a live sentence, and a short name picked from the same parts. Phone: one blank per row. Used by
  `lamp-set` and `lamp-relight`. (`NamePrompt.svelte` stays for homestead posts.)
- **Set a way-lamp confirm:** `ConfirmDialog.svelte` with the cost list (have / need), the hold
  line and the distance.
- *Migration note ([world-map.md](world-map.md) 6): replace this bullet with a Lamps layer and ledger on the world map
  (`src/ui/WorldMap.svelte` Details, marks drawn through `src/ui/map-renderer.ts` and the same
  view transform; on phones the ledger is the Details sheet with the map behind). The contents
  below carry over; the separate SVG grid and the Journal tab don't. Naming and confirm UI stay in
  their own flow; viewing the map grants no lamp capability.*
- **Journal → Lamps tab** (`src/ui/JournalPanel.svelte`'s `Tab` gains `lamps`; new
  `src/ui/LampsTab.svelte`):
  - Lamps, newest first: short name, the naming sentence, who named it, *d* chunks out, and a
    mark if a mage's naming lit it.
  - A grid drawn in SVG from the near read: held chunks warm, inside but unheld grey, the edge
    dotted, lamps as dots, you as the hero's head icon. No new art.
  - Phone: the list, with the grid behind a toggle.
- **Inventory:** the turncap and pouch show **Use** (the existing item panel). The pouch names its
  lamp.
- **Abilities section** (`src/ui/AbilitiesSection.svelte`): Name a lamp listed under the mage's
  level-10 row as a working.

### 2.7 Words

All in Opus's voice for the village. Mara is careful, dry and fond.

- **Mara**:
  - the hook after the lantern road;
  - `hear-mara` (Wenna, and why the road went dark);
  - `check-ledger` ("Noted." Then writing your name);
  - after the first relight (from the square: "I can see it from here");
  - her idle lines once you're a Keeper's hand;
  - her line if someone else lit the stone first.

  Files: `src/content/world.ts` (stage lines) and a new `src/content/quests/keepers-hand.ts`.
- **The cut** on the far route stone, and **the paper *The Form of a Naming***. The form, with
  Wenna's example from the ledger's middle pages, in `src/content/papers-text.ts`.
- **Naming parts** in `content/lamps.json`: ordinals to "twentieth", the relations, landmark
  phrases for every POI and site kind ("the old shrine", "the frozen pond", "the cairn", "the
  reeds", "the old road", "the Whitequiet"), and the closings (Keep the weave tight. / Hold fast.
  / Stay.).
- **Copy:**
  - the frontier line;
  - the "In lamplight" and "Turns in …" chips;
  - the set-a-lamp confirm;
  - Name a lamp's ability text;
  - the turncap, ash and pouch descriptions;
  - the two recipe pages;
  - the hearth oil's corrected text;
  - the Lamps tab's empty state ("No lamps yet past the Whitequiet."), now the world map's
    Lamps ledger's empty state ([world-map.md](world-map.md) 6);
  - the guide.

### 2.8 What changes in other docs (lane L-D, with the words)

- **`world.md`:**
  - "Today" (lines 82–91) brought up to date.
  - A note under "The frontier" that the open map (0.8) builds the frontier and Lamps (0.9)
    add the holds.
  - The far route stone's place: east, (3,1).
- **`quests.md`:** the `keepers-hand` block replaced by a link to 2.5. Chapter 2 moves to after Lamps in
  the build-order table (row 8).
- **`magic.md`:** step 2 says Name a lamp lands in 0.9; the Old ways stay later.
- **`items/crafting-and-repair.md`:** hearth oil lights way-lamps; posts don't take oil.
- **`plan.md`:** the 0.9 row.

---

## 3. Art

The full request is [../art-request-lamps.md](../art-request-lamps.md). The pieces are outdoor
props in the Tangle's style (64 texels per 16 px tile), scaled to the residents. Every piece is
straight-on: front-facing, light from the upper left, no in-between angles (indoors.md 7.0, and
the 0.7 look fixes, where angled props had to be redrawn).

| Piece | Footprint | Canvas | States | Matches |
|---|---|---|---|---|
| Way-lamp | 1×1 | 96×192 | unlit, lit | A head taller than a resident. Stone footing, iron-oak post, the Count House lamp head. The old `world-lantern-post-*` (16×32, items pass) is the shape, redrawn at the new density |
| Dark lamp stone (road) | 1×1 | 64×128 | dark, named (mage-lit, cooler light), relit (way-lamp warm) | A cut stone pillar with a lamp niche. Kin to `world-old-lamp-stone-intact-weathered`, standing and whole |
| Far route stone | 2×1 | 128×128 | dark, relit | The road stone with a cut panel of text beside it, legible as writing, not real letters |
| Frontier veil | 3×1 tiles | 192×64, 4 frames | loop | The drift in an exit gap: pale threads and turncaps leaning back. Matches the Turning's veil colours |
| Lamp ash | item icon | 64×64 | one | A pinch of grey ash with one warm fleck |
| Lamp-ash pouch | item icon | 64×64 | one | A small drawstring pouch, ash-grey cloth |
| Homing turncap | item icon | 64×64 | one | A turncap set in a bead of amber, stem pointing |
| Lamps tab icon | UI icon | 32×32 | one | A tiny way-lamp, for the journal tab (*migration note:* for the world map's Lamps layer control instead, [world-map.md](world-map.md) 6) |

No new resident, portrait or room. Mara's portrait exists. The naming slip reuses
`item-naming-slip`. Name a lamp's icon exists (`crafts-pass`).

---

## 4. Lanes

| Lane | What | Files | Size | Who |
|---|---|---|---|---|
| **L-A. Contract and content** (first) | 2.2, the protos in 2.3, migration 034 (schema only), contract 8, loaders both sides, vectors, the `frontier` package (pure functions and tests), the `keepers-hand` quest data and the `questTrigger` site-use check | `proto/**`, generated code, `content/{lamps,wilds,abilities,quests,story,items,crafting,papers,contract}.*`, `content/vectors/lamps.json`, `src/lib/{lamps,frontier}.ts`, `server/internal/frontier/**`, `server/internal/store/migrations/034_lamps.sql` | M | Opus |
| ~~L-B~~ | Provided by the open map (2.1) | | | |
| **L-C. Lamps, server** | 2.3 operations: set, relight, tend, the `working` op for Name a lamp, the way-home uses, rests at lamps, presence `lamp`, `worldchange.ListChunk`, the Keeper's hand steps end to end | `server/internal/api/lamps.go` (new), `api/item_use.go`, `api/quest_rules.go`, `api/spend_op.go` (rest target), `server/internal/worldchange`, tests | M | Opus (review cross-family as L-B) |
| **L-D. Game, UI and words** | 2.4, 2.6, 2.7, 2.8 | `src/game/wilds/**`, `src/game/scenes/world-turning.ts`, `src/game/entities/goal-guide.ts`, `src/content/**`, `src/ui/{LampNaming,LampsTab,JournalPanel,AbilitiesSection}.svelte`, docs | L | Opus |
| **L-E. Art** | Section 3 | `assets/generated/lamps-pass/` | M | Codex Luna |

- **Order:**
  1. L-A first. It is the contract everyone else builds on.
  2. L-C next. It also adds `held_chunks` and the holds in `frontier.Inside` (2.1).
  3. L-D starts after L-A, against the generated types and the vectors, and merges after L-C.
  4. L-E runs from the start. The room-free props don't block code, but nothing merges with
     stand-in art, so L-D's drawing merges when L-E lands.
- **Splits, if a lane runs long:**
  - L-D can split at the panel boundary into game (2.4) and UI with words (2.6–2.8).
  - L-C's way-home items can move to their own S lane.
- **Version 0.9.0**, contract 9 (or the next free). CHANGELOG under Unreleased.
- **After the release:** the review rounds (plan.md, "Stepping back between releases"), and the
  owner's playtest on `dev` with a focused list: the Keeper's hand, first relight, a set lamp,
  the frontier edge, a turning with `POST /api/dev/clock`, Name a lamp, the turncap and the pouch.

---

## 5. Tests

**Go unit tests:**

- `server/internal/frontier/frontier_test.go`: `Inside`, `Covers`, `Distance` and `Nearest` on
  `content/vectors/lamps.json`. Covers the band's `cy ≤ 2` and a lamp at the base's corner.
- **Generator** (`server/internal/wilds`):
  - `GenerateChunk` outside the 3×3 is deterministic for (epoch, key, overrides).
  - A held neighbour's gap is copied on both shared edges.
  - `held_mask` keeps sites off held base chunks.
  - Lamp stones on the road row.
  - The Tangle still refuses chunks off its grid.
  - The Tangle's pinned vectors don't move.
- **Store** (`server/internal/store/chunks_test.go`):
  - Chunks are generated on first read and stored once.
  - A held chunk reads its old epoch after a turning.
  - `deleteStaleEpochs` keeps held epochs and their rows.
- **`server/internal/api/lamps_test.go`:**
  - Every refusal in 2.3: no mark, beyond, held, lamp here, bad tile, short materials, a mage
    without mana, a non-mage's naming.
  - Cost by distance.
  - The 3×3 written and existing holds kept.
  - The ash given.
  - Idempotent retries.
  - The far stone's mark for both relight and tend.
- **Workings** (`api/working_test.go`): Name a lamp's class, level and mana checks. The
  `named-lamp` change reads as present before `NextTurning` and absent after it, with
  `worldchange` given the clock.
- **Item use** (`api/item_use_test.go`): `homing` and `to-lamp` set the place and bump
  `place_set_version`. A pouch whose ash names another world's lamp is refused.
- **Quests** (`api/quest_rules_test.go`): `keepers-hand` end to end, including the gated `give`
  and the `keeper:hand` mark; an upload can't write `keeper:` or `lamp:`.
- **Content:** loaders refuse a `working` that isn't level 10/15/20/30, a naming landmark with no
  phrase, and a cost table that isn't monotone.

**TS unit tests** (`tests/`):

- `frontier.test.ts` on the same vectors.
- `lamps.test.ts`: the naming builder, and which parts a chunk offers.
- `wilds-regions.test.ts`: negative chunk ids and region-wide pixels round-trip.
- `items.test.ts`: the new uses are implemented on both sides.

**e2e** (only the changed specs while building; the full suite once at merge, preferably in CI):

- **`e2e/lamps.spec.ts`** (new): the Keeper's hand from Mara to the relit stone; the frontier
  opening (a chunk past the old edge now loads); setting a way-lamp with `POST /api/dev/grant`
  materials; the naming panel; the Lamps tab lists it (*migration note:* the world map's Lamps
  ledger, opened with M and Details, `e2e/world-map.spec.ts` helpers; [world-map.md](world-map.md) 6).
- **`e2e/frontier.spec.ts`** (new):
  - The edge turns you round.
  - After `POST /api/dev/clock` past the turning, a held chunk's layout is unchanged and an
    unheld one changed.
  - Standing in unheld land at the turning puts you at the nearest lamp.
- **`e2e/abilities.spec.ts`:** a level-10 mage names a dark stone; it is lit for a second player
  (`coop` helpers); it's dark after the turning.
- **`e2e/items.spec.ts`:** craft and use the turncap (you're at the Commons gate) and the pouch
  (you're at the lamp).
- **`e2e/wilds-outer.spec.ts`:** still passes with no lamps (the base plays as today).
- **Screens:** `wilds-screens.spec.ts` gets the way-lamp lit, a dark stone, the veil, and the
  Lamps tab on desktop and phone (*migration note:* the world map's Lamps layer and ledger; [world-map.md](world-map.md) 6).

---

## 6. Later, on purpose

- **Chapter 2, Dorrit's span** → **after Lamps** (Q10). It needs `project` and `world` gates, `wait`
  `since`, projects that take glims (`debitGlims`), the span as a world change with no expiry,
  and the four-bedroll Echo past it. The plank site and Dorrit's paper already ship in the Tangle.
- **The Old ways** (mage, level 30) → with the open map. They need pairs, travel between chunks,
  the storm-grade drop, and enough lamps to be worth linking. Until then the turncap and the
  pouch are the way back. The icon is drawn.
- **The clay base** → lake country. The stone footing becomes fired clay in `content/lamps.json`
  when Aldo's kiln exists.
- **The open map proper:**
  - noise fields across chunks, rivers and shores, cells and structures;
  - the rings, and seams drawn as a band of scree and roots;
  - the Tangle becoming ring one, with fixed story spots at fixed coordinates;
  - new kinds of land.

  The band's tables (`held_chunks`, `way_lamps`) and the near read carry over.
- **The other level-10 workings** (Heave, Mend, Read the drift) and the obstacle catalogue. They
  need obstacles that the generator places. The `working` kind and operation from 0.9 are their
  template.
- **A healer's Mend on a cracked lamp**, and cracked lamps themselves.
- **Lamps in caves**, and a lamp inside a cave joining the Old ways.
- **Two-player naming:** a mage's naming standing in for someone else's oil. In 0.9 the mage
  lights it themselves.
- **Sense the turning** (rogue, level 30), which would mark next wick's land on the Lamps grid.
- **Hearth oil for homestead posts:** the item text promised it, but posts never took oil. Not
  added; the text is corrected instead.
- **Making the off-hand `light`, `wisps-keep-off` and `compass` effects real** (the carter's
  lantern, the turncap jar). They are declared in content but not applied. A natural fit with
  lamps, but not needed for 0.9.
