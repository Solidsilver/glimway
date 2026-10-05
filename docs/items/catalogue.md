# Items: catalogue

Status: worked out with the owner 2026-10-05. Rules live in
`docs/items/overview.md`; recipes, wear numbers and repairs in
`docs/items/crafting-and-repair.md`.

Ids are suggestions in the house kebab-case; existing ids (from
`content/homestead.json`, `content/crafting.json`, `content/wilds.json` and
`src/content/expansion-writing.ts`) are kept as they are and marked *(exists)*.

Each entry has a one-line **icon** brief for a 16×16 icon in the house style
(`docs/art-requests.md`). Placed home goods also need a world sprite at their
footprint.

---

## Tools

### Cheap tools (crafted at the bench; 1 fitting slot; break at zero)

| Id | Name | What it is / does | Icon |
|---|---|---|---|
| `bench-axe` | Bench axe | Pine haft, soft scrap-iron head. Chops trees in the Tangle and on your land. | Short axe, pale haft, dull grey head |
| `bench-pick` | Bench pick | Breaks boulders into quarry stone and drift-stone. | Pick with a pale haft |
| `bench-spade` | Bench spade | Digs saplings, roots, herbs, turncap spawn and wild honey. | Spade, worn wooden grip |
| `stave-bucket` | Stave bucket | Oak staves, iron hoops. Draws water at the well (once the rope is mended); water feeds hearth recipes and waters beds. The hoops loosen with use. | Small wooden bucket, two dark hoops |
| `watering-can` | Tin watering can | Tarrow tin, bought from Silas. Waters a bed in one go. Watering is never required: a watered bed grows a little faster that day. | Squat tin can with a long spout |

### Heirloom tools (story only; 3 fitting slots; blunt at zero until mended)

Story beats are suggestions for the quest writing.

| Id | Name | What it is | Suggested source | Icon |
|---|---|---|---|---|
| `brack-felling-axe` | Brack felling axe | Ash haft, iron head forged by Maren Brack, Hollis's sister. Rehafted by Orrin with a trunnel through the eye. | Silas, from the old Wheel & Wick guildhouse, once he trusts you with Hollis's name | Long axe, dark ash haft, bright bit |
| `orrins-mason-pick` | Orrin's mason pick | The pick Orrin dressed the north bridge's footings with. "Drift-stone for foundations, NOT for walls" is cut into the haft. | Orrin, after the north bridge is mended | Pick with a notched haft |
| `ada-garden-spade` | Ada's garden spade | Small, polished by eighty years of hands. Ada dug the twins' first garden with it. | Ada, after you've brought her window oil a few times | Short spade, dark polished grip |
| `nans-lamplighter-pole` | Nan's lamplighter pole | Long pole with a hook and a wick-trimmer. As a tool, it sets lamp heads and trims wicks on posts and village lamps. Off hand: lights the way a little further than a lantern. | Found at Nan's echo camp, once the echo is settled | Long pole, brass hook at the top |

### Special tools

| Id | Name | What it is / does | Icon |
|---|---|---|---|
| `oak-mark-punch` | Oak-mark punch | The Hall's wheel-and-wave stamp. Strike a **wax seal** into a standing iron-oak before felling it (needs a warden-set axe too). Never wears. From Silas, who kept one from his carting days. | Stubby iron punch, wheel-and-wave face |

### Off-hand items (the slot opens with a class; anyone can carry any of them)

| Id | Name | Plain effect (while held) | Affinity | Icon |
|---|---|---|---|---|
| `carters-lantern` | Carter's lantern | Lights the way in the dark Tangle; wisps keep a little further off. A fill of **candle oil** lasts a long while. | **Warrior**: burns a shade warmer, wisps keep further off | Lantern on a short pole, lit |
| `turncap-jar` | Jar of turncaps | Elara's living compass. The caps tilt toward the nearest named light. Dries out over a few wicks; refresh with fresh **turncap spawn**. | **Mage**: also tilts toward unsettled echoes | Glass jar, three pale caps leaning one way |
| `salve-satchel` | Salve satchel | Keeps one remedy always at hand (use it without opening the inventory). | **Healer**: remedies used from it work a little better | Small leather satchel, a jar lid peeking out |
| `runners-whistle` | Your own whistle | A plain tin whistle from Pip that you **dent to your own note** (choose it once). Echoes nearby answer it. | **Rogue**: the note carries further, and hidden papers chime back | Tin whistle with a dent |

Joss's tin whistle (a keepsake) also works in the off hand like `runners-whistle`.

### Carry gear (adds the second pocket)

| Id | Name | Look | Icon |
|---|---|---|---|
| `forager-satchel` | Forager's satchel | Elara's style: salt-stained canvas, string ties | Canvas satchel |
| `work-apron` | Work apron | Silas's style: leather, pencil pocket | Leather apron |
| `carting-coat` | Carting coat | Old Compact cut, deep pockets | Long brown coat |

All three do the same thing (second pocket); the choice is looks. One is enough.

---

## Supplies

### Materials

| Id | Name | Notes | Icon |
|---|---|---|---|
| `timber` *(exists)* | Timber | Now arrives **green**; seasons on a woodpile after a real day (see crafting doc). | Split log |
| `seasoned-timber` | Seasoned timber | Wanted by fine furniture, beds and tables. "Green wood sinks, dry wood sings." | Split log, paler, a crack in the end grain |
| `stone` *(exists)* | Quarry stone | Walls, hearths, slates. | Flat grey stone |
| `drift-stone` | Drift-stone | Footings, well linings and post-holes only. Recipes refuse it for walls. | Rounded stone with a faint swirl |
| `fiber` *(exists)* | Fiber | Rope, cord, baskets. | Bundle of bracken |
| `amber` *(exists)* | Amber | Cut with tallow into oils; polished into beads. | Warm orange drop |
| `iron-oak` | Iron-oak | From windfall (or a marked, warden-felled standing oak). Heavy, rare, heirloom-grade builds. | Dark tight-ringed log end |
| `willow-bark` | Willow bark | Stripped with the axe from willows by water. Tea. | Curl of bark |
| `beeswax` | Beeswax | Comes with wild honey. Wax seals, waxed cord. | Yellow wax block |
| `storm-grade-drop` | Storm-grade drop | Very rare amber found deep in the Tangle or the Whitequiet. Storm oil only. | Amber drop with a bright core |
| `tallow` | Tallow | Bought cheaply from Hazel's kitchen. Oils, salves. | Pale lump in paper |
| `flour` | Flour | Bought from Finn ("the fine sift, not the grist"). | Small sack |
| `wild-honey` | Wild honey | From hives in hollow trees, with the spade. | Comb drip |

**Seasonal materials** (turn up only in their season; never expire):

| Id | Name | Season | Feeds | Icon |
|---|---|---|---|---|
| `walnut-shells` | Walnut shells | Mudrise (swept up by the freshet) | Candle hulls | Two half shells |
| `madder-scraps` | Madder scraps | Carting (from the market) | Bunting | Red cloth scraps |
| `amberfall-sap` | Amberfall sap | Amberfall (the woods let it go) | Amberwake window lamp, Empty Chair cushion | Thin amber trickle on bark |
| `frost-glass` | Frost-glass | Quiet (off the frozen pond) | Closure Night lamp | Pale blue shard |
| `bloom-flowers` → `dried-flowers` | Bloom flowers | Bloom; dry after a season, still usable | Garlands, pressed-flower frames | Posy (fresh) / brown posy (dried) |

### Fittings (one of each kind per tool; movable at the bench)

| Id | Name | Kind | Where from | Icon |
|---|---|---|---|---|
| `tarrow-edge-strip` | Tarrow-steel edge strip | **Bite** (sharper) | Salvaged crate-straps at abandoned carts and old Count House stores | Thin bright metal strip |
| `loose-road-nail` | Loose road-nail | **Hold** (wears slower) | Common at old lamp-stones. Not the Eleven. | Single square nail |
| `iron-oak-wedge` | Iron-oak wedge | **Hold** | Offcuts at tight-ringed stumps | Small dark wedge |
| `tyre-iron-hoop` | Hoop of tyre-iron | **Hold** (buckets, mallets: nothing splits) | Maren's wheels, at the abandoned cart | Small iron ring |
| `green-ash-haft` | Green-ash haft | **Heft** (lighter, faster, less tiring) | Ash trees, now and then, when chopping | Pale straight haft |
| `amber-bead` | Amber bead | **Glow** (a faint light in the dark) | Polished at the bench from amber | Glowing orange bead |
| `waxed-cord` | Waxed cord | **Grip** (rarely dropped; quieter near wisps) | Bench: fiber and beeswax | Coil of cord |
| `warden-sliver` | Warden-stone sliver | **Remember** (never breaks; dulls and heals) | Very rare: deep Tangle, the Whitequiet; perhaps one when the Warden is settled | Grey stone chip with an amber fleck |

### Repair parts and building parts (bench)

| Id | Name | Used for | Icon |
|---|---|---|---|
| `fibre-rope` | Fibre rope | The well's rotten rope; lashings | Coiled rope |
| `split-rail` | Split rail | Fallen fence rails | Rough rail |
| `slates` | Slates | Leaking roofs | Three stacked slates |
| `oak-slat` | Oak slat | Cracked bench slats | Smooth plank |
| `lamp-wick` *(exists)* | Lamp wick | Guttering village lamps; lantern posts | Coiled wick |
| `oilcloth-wrap` *(exists)* | Oilcloth wrap | Polishing the hame before Carting Day | Folded waxed cloth |
| `wooden-peg` *(exists)* | Wooden peg | Trunnels for rails, slats and rehafting heirlooms | Peg |
| `lamp-head` | Lamp head | Iron frame, glass and a wick holder for a lantern post. Bought from Orrin or **salvaged from old lamp-stones** in the Tangle. | Small iron lamp head, glass panes |
| `wax-seal` | Wax seal | One strike of the oak-mark punch | Red-brown wax disc, wheel and wave |

### Seeds and saplings (spade)

Plant inside lamplight and it stays put; outside, it wanders.

| Id | Name | Grows into | Icon |
|---|---|---|---|
| `hazel-whip` | Hazel whip | Hazel tree (timber) | Thin sapling, round leaves |
| `birch-sapling` | Birch sapling | Birch (timber) | White-barked sapling |
| `rowan-sapling` | Rowan sapling | Rowan (timber; red berries in Amberfall) | Sapling with a red cluster |
| `comfrey-root` | Comfrey root | Comfrey bed (salve) | Knobbly root, two leaves |
| `wild-thyme` | Wild thyme | Thyme bed (tea) | Tiny-leaved sprig |
| `turncap-spawn` | Turncap spawn | Turncaps on a stump at home that lean toward *your* lantern post | Pale cap on a sliver of wood |
| `iron-oak-acorn` | Iron-oak acorn | Very rare. Grows only in lamplight, over weeks of real time, into a tight-ringed iron-oak. | Dark heavy acorn |

### Food and drink

| Id | Name | Effect | Where from | Icon |
|---|---|---|---|---|
| `keepers-twists` | Keeper's Twists (butter batch) | Small HP restore. "Not quite right." | Hazel (bought), or your hearth with her recipe card | Twisted bread, golden |
| `oil-twists` | Keeper's Twists (oil) | HP and a little mana; comes with Hazel's note | Hazel, once the oil comes back (or early, by returning Joss's whistle) | Twisted bread, darker, burnt end |
| `saltings-tea` | Saltings tea | Mana back, slowly over a minute | Your hearth (starting recipe); Elara | Cup, grey-green tea |
| `oatcakes` | Finn's oatcakes | A little HP. Sold in fives, of course. | Finn | Stack of round oatcakes |
| *Ledger soup* | Ledger soup | Not carried. Served in the square to anyone working on a village project: a long, gentle regen. | Mara | (no icon; a pot sprite in the square) |

### Remedies

| Id | Name | Effect | Where from | Icon |
|---|---|---|---|---|
| `comfrey-salve` | Comfrey salve | Clears *unmoored* at once. "The hands keep more memory than the head." | Your hearth (starting recipe) | Small tin, pale salve |
| `willow-bark-tea` | Willow-bark tea | Eases *unmoored* slowly. Mother Cotta adds ginger, a Tops luxury; here it's willow and water. | Your hearth (found page) | Cup, brown tea |
| `blue-moss` | A pinch of Blue Moss | Nearby wisps **forget you** for a short while, so you can slip past a camp. Your map forgets too until it wears off. | Found only, in the deep Tangle | Twist of paper, blue moss poking out |

### Oils

| Id | Name | Use | Icon |
|---|---|---|---|
| `candle-oil` | Candle oil | Refills a carried lantern | Small corked vial, pale amber |
| `hearth-oil` | Hearth oil | Lights lantern posts and window lamps (once each); a gift for Ada's window | Squat flask, warm amber |
| `storm-oil` | Storm oil | Rare. Kept for the old ways. | Stoppered flask with a bright core |

---

## Keepsakes

Trinkets the Wilds give back. Pocket helps are small and come from who owned the
thing.

| Id | Name | In a pocket | Belongs to | Icon |
|---|---|---|---|---|
| `whittled-fox` *(exists)* | Whittled fox (long ear right) | Papers glint brighter | Hollis; can be returned to Silas | Pine fox, right ear long *(exists in art requests)* |
| `knotted-halter` *(exists)* | Knotted ox-halter | Beetles take longer to notice you | Tam; can be returned to Ada | Rope halter, knotted |
| `work-glove` *(exists)* | Work glove | A little extra when gathering fiber or bark | (A carter; left at the frozen pond) | Single leather glove |
| `river-glass-bead` *(exists)* | River-glass bead | One extra skip on the pond; the Wend gives back small things more often | (A carter's harness) | Frosted green bead |
| `tin-whistle` *(exists)* | Tin whistle | Off hand: works as your whistle | Joss; can be returned to Hazel | Dented tin whistle |
| `beeswax-candle` *(exists)* | Beeswax candle | Display only: saved for a birthday | (Bett and Tam's? Ada would know) | Candle with red yarn |
| `road-nails` *(exists)* | Stamped road-nails | Display only; the set stays at eleven | Nan's lamp-posts | Small bundle of nails |
| `spare-bootlace` *(exists)* | Spare bootlace | Display only | Joss (runner's double hitch) | Knotted lace |
| `mirror-fox` | A mirror-wise fox | Display only. Silas carves them with the long ear on the left; collect them and compare the ears. | Silas | Pine fox, left ear long |

Keepsakes with no living owner (Bett's, Dorrit's, Nan's) can be **left at their
echo camp** instead of being returned.

---

## Home goods

The 14 existing decorations stay as they are (`content/homestead.json`). Two of
them now have jobs:

- `tool-rack` *(exists)*: a warden-set tool **heals here in lamplight**; shows
  each tool's fitting.
- `stone-hearth` *(exists)*: where **hearth recipes** are made.

### New working pieces

| Id | Name | Footprint | What it does | Sprite brief |
|---|---|---|---|---|
| `door-fox` | Door-fox | lintel | Silas carves it when you get your deed, mirror-wise. Can't be sold or given. | Small fox over a door, left ear long |
| `window-lamp` | Window lamp | window | Hearth-grade. Your window shows lit from the Commons lane; at Amberwake every lit window adds to the village's glow. | Warm square of light in a window |
| `gate-shelf` | Gate shelf | 1×1, at your gate | Pure-gift shelf for passers-by | Small roofed shelf on a post, jars on it |
| `writing-desk` | Writing desk | 2×1 | Copy recipe pages to give away | Slant-top desk, inkpot |
| `keepsake-cabinet` | Keepsake cabinet | 1×1 | Glass-front case; keepsakes show as little sprites and visitors can read their stories | Glass-front cabinet, small shapes inside |
| `drying-rack` | Herb drying rack | 1×1 | Holds herbs from your beds and shows them hanging | Wooden rack, bundles hanging |
| `apothecary-shelf` | Apothecary shelf | 2×1 | Jars fill to show your stock of remedies | Shelf of jars, some full |
| `woodpile` | Woodpile | 2×1, outdoor | Green timber stacked here seasons after a real day | Stacked split logs under a little roof |
| `lantern-post` | Lantern post | 1×1, outdoor | Expands your land (see crafting doc) | Timber post, iron lamp head, lit; plus an unlit variant and a brighter Amberwake variant |
| `raised-bed` | Raised bed | 2×1, outdoor | Plant herbs and saplings | Timber-edged bed of dark soil |

### New lovely pieces

| Id | Name | Footprint | Notes | Sprite brief |
|---|---|---|---|---|
| `naming-frame` | Naming-slip frame | 1×1, wall | Frames your first naming slip | Small frame with a slip of paper |
| `pencil-map` | Pip's pencil map | 2×1, wall | A copy from Pip, in pencil because the lines drift. Smudges a little each season. | Pinned map, pencil lines |
| `pressed-flowers` | Pressed-flower frame | 1×1, wall | From Bloom flowers (fresh or dried) | Frame with flat flowers |

### Seasonal pieces (craft any time; materials only in season)

| Id | Name | Festival | Notes | Sprite brief |
|---|---|---|---|---|
| `candle-hulls` | Candle hulls | The Breaking | A shelf of walnut-shell boats; float one on the pond on the day | Walnut-shell boats with leaf sails |
| `carting-bunting` | Carting bunting | Carting Day | Strings across your gate | Red and cream bunting |
| `empty-chair` | The Empty Chair | Amberwake | Set at your table for those lost in the Tangle | Plain chair, a sap-gold cushion |
| `closure-lamp` | Closure Night lamp | Closure Night | You light it and set it facing the dark | Frost-glass lamp, pale light |

---

## Papers

| Kind | Examples | Notes |
|---|---|---|
| **Found texts** | Everything in `docs/lore/texts/` already placed in the world | As today |
| **Recipe pages** | Saltings tea (Elara), comfrey salve (a leaf of Mother Cotta's book from Mara's library), candle oil (Mara) as the starting three; willow-bark tea (another Cotta leaf), Keeper's Twists (Hazel's card), oil twists (Hazel), hearth oil (a leaf of Ada's oil receipts), wax seal (a Brackenwood handbook page), storm oil (a margin of Wenna's ledger) | Copyable at a writing desk |
| **Naming slips** | One per lantern post you name | Your own small Ledger of the Road; the hook for the old ways |
| **The chores list** | The notice board's "mended by" history | Readable at the board, not carried |
