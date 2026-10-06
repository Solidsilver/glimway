# Items: crafting, wear, repair, gathering and lantern posts

Status: worked out with the owner 2026-10-05. Rules in
`docs/items/overview.md`; item entries in `docs/items/catalogue.md`.

All quantities and counts are first guesses for playtesting.

## Where things are made

| Place | Makes | Unlocks |
|---|---|---|
| **Workbench** | Cheap tools, fittings, repair and building parts, home goods; moving fittings; mending heirlooms | Workshop tier (tier 2), as today |
| **Hearth** (`stone-hearth`) | Food, remedies, oils, wax seals | Cottage tier (tier 1) |
| **Writing desk** | Copies of recipe pages | Any tier, once placed |

Both the bench and the hearth use a small recipe screen like the existing crafting
screen. Everything made at either carries a **maker's mark**.

## Bench recipes

### Cheap tools

| Makes | Materials |
|---|---|
| Bench axe | timber 2, stone 2, fiber 1 |
| Bench pick | timber 2, stone 3 |
| Bench spade | timber 2, stone 2 |
| Stave bucket | timber 3, fiber 1, wooden peg 2 |

The tin watering can is bought from Silas (Tarrow tin isn't made here).

### Fittings

| Makes | Materials |
|---|---|
| Amber bead (Glow) | amber 2 |
| Waxed cord (Grip) | fiber 2, beeswax 1 |

The other fittings are **found only** (see the catalogue).

### Repair and building parts

| Makes | Materials |
|---|---|
| Fibre rope | fiber 4 |
| Split rail | timber 2, wooden peg 2 |
| Slates (×3) | stone 3 |
| Oak slat | seasoned timber 1, wooden peg 1 |
| Lamp wick, oilcloth wrap, wooden peg | as today (`content/crafting.json`) |

### Carry gear

| Makes | Materials |
|---|---|
| Satchel, apron or coat (choose the look) | fiber 8, beeswax 1 |

### New home goods

| Makes | Materials |
|---|---|
| Gate shelf | timber 4, stone 1 |
| Writing desk | seasoned timber 6 |
| Keepsake cabinet | seasoned timber 5 |
| Herb drying rack | timber 3, fiber 2 |
| Apothecary shelf | seasoned timber 4 |
| Woodpile | timber 4, stone 2 |
| Raised bed | timber 4, stone 2 |
| Window lamp | lamp head 1, hearth oil 1 |
| Naming-slip frame | seasoned timber 1 |
| Pressed-flower frame | seasoned timber 1, bloom or dried flowers 3 |
| Candle hulls | walnut shells 4, candle oil 1 |
| Carting bunting | madder scraps 4, fiber 2 |
| The Empty Chair | seasoned timber 4, amberfall sap 1 |
| Closure Night lamp | frost-glass 2, lamp wick 1, hearth oil 1 |

All of these are **bench-only**: Silas doesn't sell them (nor the door-fox,
which he carves at deed time, nor Pip's pencil map, which is Pip's gift). The
deliberate exceptions are the **oak table** and the **reading chair**, which
Silas still sells to anyone with the embers — fine work for players who
haven't the bench yet. The **carved bed** and the **bookshelf** take seasoned
timber: the bed's purchase bill and the bookshelf's recipe both do.

The pressed-flower frame's recipe waits on **dried flowers** (bloom flowers
drying over a season — the seasons work); it takes fresh blooms until then.

### Seasoned timber

- Chopped timber arrives **green**. Stacked on a **woodpile**, it becomes
  **seasoned** after a real day. The woodpile's description: *"Green wood sinks, dry
  wood sings."*
- **Fine work wants seasoned:** beds, tables, chairs, shelves, desks, cabinets, the
  oak slat. The existing furniture recipes (oak table, reading chair, carved bed,
  bookshelf) should switch their timber to seasoned.
- **Rough work takes green:** posts, rails, woodpiles, beds for planting, tools.

## Hearth recipes

"Water" is a full stave bucket (drawn at the well; one draw is one bucket use).

| Makes | Materials | Effect | Recipe source |
|---|---|---|---|
| Saltings tea ×2 | wild thyme 2, water | Mana back slowly over a minute | **Starting** (Elara) |
| Comfrey salve ×2 | comfrey root 2, tallow 1 | Clears *unmoored* at once | **Starting** (Cotta leaf, via Mara) |
| Candle oil ×2 | amber 1, tallow 1 | Refills a carried lantern | **Starting** (Mara) |
| Willow-bark tea ×2 | willow bark 2, water | Eases *unmoored* slowly | Found: another Cotta leaf |
| Hearth oil ×1 | amber 3, tallow 1 | Lights posts and window lamps | Found: a leaf of Ada's oil receipts |
| Keeper's Twists ×4 | flour 2, wild honey 1 | Small HP | Found: Hazel's card |
| Oil twists ×4 | flour 2, wild honey 1, candle oil 1 | HP and a little mana | Hazel, once the oil comes back (or for returning Joss's whistle) |
| Wax seal ×2 | beeswax 1 | One oak-mark strike each | Found: a Brackenwood handbook page |
| Storm oil ×1 | storm-grade drop 1, tallow 1 | Kept for the old ways | Found: a margin of Wenna's ledger |

## Writing desk

| Makes | Materials |
|---|---|
| A copy of any recipe page you hold | fiber 1 (rag paper) |

## Wear

One tree, one boulder, one dig or one bucket draw is **one use**.

| Tool | Uses | At zero |
|---|---|---|
| Cheap | ~30 | Breaks and is gone |
| Cheap with a Hold fitting | ~45 | Breaks |
| Heirloom | ~80 (~120 with Hold) | Blunt or cracked: still in your pack, can't be used until mended |
| Warden-set | Never breaks | Dull (see below) |

Wear never interrupts an action: a tool that reaches zero finishes the swing it's
on.

### Fittings

- A tool has **1 slot (cheap) or 3 (heirloom)**, and can hold **one fitting of each
  kind**.
- **Any fitting can be moved at the bench**: take it off one tool, put it on
  another.
- **Common fittings wear out:** each has about **30 uses** of its own, then falls
  off; the tool goes back to wearing normally. The **warden-stone sliver never
  wears**.
- A tool's icon shows its fittings (a nail glint, a cord wrap, a grey chip).

| Kind | Effect |
|---|---|
| **Bite** | Fewer swings per tree or boulder; a dull warden-set tool still cuts well |
| **Hold** | Wears slower (×1.5 uses); a warden-set tool dulls half as fast |
| **Heft** | Faster swings, less tiring |
| **Glow** | A faint light around you in the dark |
| **Grip** | Rarely dropped; a little quieter near wisps |
| **Remember** | Warden-stone: never breaks, dulls and heals |

### Warden-stone

Warden-stone is drift-stone that has learned one shape and always walks back to it.

- A warden-set tool **dulls with use** (about 40 uses from sharp to dull). At its
  dullest it works at **half speed** (three-quarters with Bite). It never stops
  working.
- It **heals back**: fully **overnight**, or within about an hour of real time
  hanging on your **tool rack in lamplight**. Its icon creeps back to sharp.
- If it's dropped or left in the Tangle, it **walks home** to your tool rack.
- **You can carry one warden-set tool at a time.** Two slivers in one pack pull
  toward each other's pose and grind. Others wait on the rack; you choose at home.
- Slivers are very rare, and found only out deep: the deep Tangle and the
  Whitequiet. Settling the Warden is a story beat; it gives no sliver.

### Mending heirlooms

| Where | Cost |
|---|---|
| Your bench | timber 2 and wooden peg 1 (axe, pick, spade); fiber 2 (Nan's pole) |
| Orrin or Silas | A few embers; they do it while you talk |

Mending restores full wear. Cheap tools can't be mended.

## Gathering

| Tool | Target | Gives |
|---|---|---|
| Axe | Pine, birch, hazel | timber 2–4 (green) |
| Axe | Ash | timber 2–4; sometimes a green-ash haft |
| Axe | Willow (by water) | timber 1–2, willow bark 2 |
| Axe | Iron-oak windfall | iron-oak 1–2; three leafy branches are left at the stump automatically |
| Axe (warden-set) + oak-mark punch + wax seal | Standing iron-oak | iron-oak 4–6; a gentle wake. Leaves a tight-ringed stump; regrows only after a long while (about a real week). |
| Pick | Boulder | quarry stone 2–4; drift-stone 1–2 (often) |
| Pick | Old lamp-stone | loose road-nails; sometimes a lamp head |
| Spade | Herb patches | comfrey root, wild thyme |
| Spade | Saplings | hazel whip, birch, rowan |
| Spade | Stumps | turncap spawn; rarely an iron-oak acorn by tight-ringed stumps |
| Spade | Hollow tree | wild honey 1, beeswax 1 |
| Bucket | Well | water |

### Regrowth

- **The Tangle:** trees, boulders and patches come back when you leave and return.
- **Your land, inside lamplight:** nothing regrows; plant to bring trees back.
- **Your land, outside lamplight:** regrows like the Tangle.

### Caps (first guesses; enforced server-side)

| | Trees | Boulders | Digs |
|---|---|---|---|
| Per area visit | 8 | 5 | 6 |
| Per day | 30 | 20 | 25 |

At the cap the player sees *"The wood's given enough here today."* and the nearby
trees shuffle out of reach. No numbers are shown.

### Planting

- **Inside lamplight:** stays put. **Outside:** wanders a little each day.
- **Watering is never required.** A watered bed grows a little faster that day.
- **Iron-oak acorn:** grows only in lamplight, over weeks of real time, into a
  tight-ringed iron-oak.

## Village repairs

Repairs are **shared**: done once for the whole village, by whoever mends it first.
To mend something, use the right part on the broken thing.

| Broken thing | Part | What changes | Who notices |
|---|---|---|---|
| The well's rotten rope | Fibre rope | Water can be drawn again | Hazel: "Bread tastes of the well again." |
| A fallen fence rail | Split rail | The gap closes; the path stops cutting the corner | Silas |
| The leaking library roof | Slates | The drip bucket by the shelves goes away | Mara |
| A bench with a cracked slat | Oak slat | You can sit there again | Whoever sits there next |
| A guttering village lamp | Lamp wick | Burns steady | Ada, from her window |
| The hame before Carting Day | Oilcloth wrap | It shines on the gate | Everyone, on the day |

**Not repairs:**

- **The signpost.** Trying to straighten it makes Orrin stop you: "Leave it." That
  starts a thread toward Dorrit's lean.
- **Ada's lamp** is never broken, but you can bring her **hearth oil** any time.
  The village pays for it, so it's a gift. She says "Leave one for Ada" and gives
  you something small.

### The chores list (notice board)

- **At most three** open repairs at a time.
- **The first two are scripted** (the well rope, then the fence rail), to teach the
  idea once.
- After that, new breakages come **with the weather**: roughly one per season turn or
  big storm, never the same thing twice in a row.
- No timers, no penalties. The reward is the change itself, a line from whoever
  notices, and sometimes a small gift (a twist from Hazel, a recipe page from Mara).
- The list keeps a short **"mended by"** history, so the village remembers who fixed
  what.

## Seasonal materials

| Season | Material | How it turns up |
|---|---|---|
| Mudrise | Walnut shells | Swept up along the Wend after the freshet |
| Bloom-wick | Bloom flowers | Picked in the Commons and the Tangle; dry after a season into dried flowers |
| Carting | Madder scraps | The Carting Day market |
| Amberfall | Amberfall sap | On trees in the Tangle; the woods let it go |
| Quiet | Frost-glass | Off the frozen pond |

Seasonal home goods can be crafted any time; only the materials are seasonal.
Nothing expires.

Bloom flowers stay fresh through the Mark Bloom-wick falls in (Carting:
Bloom-, Light- and Cart-wick) and dry in the pack once Amberfall begins.

**Playtest notes.** The madder stall sells a player at most four scraps on
Carting Day, and Carting Day comes once in twelve wicks: four scraps a year,
exactly one Carting bunting (madder scraps 4). A player who misses the day goes
without until the next one. Watch whether that is too tight.

## Lantern posts

Land only stays put where a named lamp holds it. A post is built from the three
parts in the canon.

### Parts

1. **The post:** green timber, with the footing **packed with drift-stone** (Orrin's
   rule 4).
2. **The lamp:** a **lamp head** (bought from Orrin, or salvaged from an old
   lamp-stone in the Tangle) and a **lamp wick**.
3. **The oil:** **hearth oil**, to light it once. After that the post keeps itself.
   **No refuelling.**

### Cost

For the *n*th post: timber 6 + 2(*n*−1); drift-stone 4 + (*n*−1); hearth oil 1
(2 from the 6th post on); plus a lamp head and a lamp wick.

| Post | Timber | Drift-stone | Hearth oil |
|---|---|---|---|
| 1st | 6 | 4 | 1 |
| 2nd | 8 | 5 | 1 |
| 3rd | 10 | 6 | 1 |
| 4th | 12 | 7 | 1 |
| 5th | 14 | 8 | 1 |
| 6th | 16 | 9 | 2 |

### Placement

- **Never two dark in a row.** A new post must stand **within the light of a lamp you
  already have**. The campsite's lamp post is the first link, so land grows as a
  chain out from your home.
- Each post lights a circle with a radius of about **5 tiles**; that ground becomes
  part of your homestead.
- **Old post sites:** a **tight-ringed stump** on your wild land means a lamp stood
  there once. A post set there costs **half the timber and drift-stone** and lights
  **half again as far**, because the land remembers being held.

### Naming

Setting a post means speaking its naming, as a fill-in-the-blank built from **real
landmarks near the post**:

> *You are the* [third post] [above / below / beside / past] *the* [stream bend].
> *Behind you* [the cottage]*; ahead* [the old stump]*.* [Keep the weave tight. /
> Hold fast. / Stay.]

- **Landmark choices** come from what is actually near the post: your cottage, your
  gate, a stream bend or slope, a boulder, a tight-ringed stump, planted trees (by
  kind), beds, and your other posts (by their short names).
- The player also picks a **short name** for the post from the same parts ("the
  stream-bend post").
- The naming is written once. If the land changes later (the boulder is broken up),
  the post still holds; the slip remembers what it was.
- Each naming gives a **naming slip** in Papers. The slips are the hook for the old
  ways: two lamps given the same naming become one place.

### Amberwake

At Amberwake you can top up any post with hearth oil for a **brighter glow**. It's
for looks only and fades after the festival.
