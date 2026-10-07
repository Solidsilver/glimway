# Design: a wider world beyond the Tangle

Status: brainstorm with the owner, 2026-10-07; paused at a good spot. **Direction
chosen: one open wilderness, generated on the server, bounded by lamplight.**
Agreed so far: the generator, the frontier and way-lamps, five kinds of land with
lake country first, pottery with Finn, one obstacle catalogue shared with
magic's class workings, and how today's Tangle moves over. Cross-design
conflicts with magic settled 2026-10-07 (decisions 10 and 12, the catalogue).
Open questions are listed near the end.

Source ideas: "More variety beyond the Tangle" and "Exploration for every class
and playstyle" in [../ideas.md](../ideas.md). Caves
and underground layers belong to the layers brainstorm
([layers.md](layers.md)); this doc owns the generator and lists the hooks caves
need.

## The pitch

Past the Tangle the land opens up: woods give way to uplands, lake country,
rivers and sap bogs, different every time the drift turns. You can go as far as
the light reaches and a little further. Light a lamp out there, name it, and the
whole world can go further, and always find its way home.

The canon supplies the places and the rule. The drift is why the land beyond is
unknown, and named lamps are why any of it can be held.

| Place | What it is | Land it suggests |
|---|---|---|
| The river Wend | Runs past the mill; ice-out at the Breaking | River, fords, backwaters, lakes |
| The Tops | The steep hills west toward Tarrow | Uplands, scree, tarns, wind |
| The Sapping Grounds | The deep amber reserves | Resin bog, old sap-taps, amber pools |
| The Lantern Road east | Toward Sallow Ford; the Six went this way | The road itself, waystations, the far lamp |
| Merrow Saltings | Elara's home; they ride the drift on drift-tables | Saltmarsh, far off, a late reach |

## Decisions so far (owner, 2026-10-07)

1. **Generation moves to the Go server** (proposed by the owner in the layers
   brainstorm): generate once, store, serve. The client only renders. The Tangle
   may change once when this ships.
2. **One open wilderness** that varies in terrain, "almost Minecraft-like", as
   long as the backend stays fast. It replaces the fixed 3×3 regions.
3. **Lit land survives a turn**, and the Go rewrite covers the Whitequiet as
   well as the Tangle (both are walkable in the client today).
4. **The frontier:** you can go a few chunks past the nearest lit lamp; lighting
   and naming lamps pushes it out for the whole world.
5. **Chunks are packed tight in protobuf.**
6. **No obstacle is class-only:** every obstacle has a class working and a tool
   way, in one catalogue (below). Level sets the size a working can move.
7. **Room for realms later** (alternate dimensions or worlds).
8. From the layers brainstorm: **enemies in generated places are shared and run
   by the server** ([layers.md](layers.md), "Fighting together").
9. From the layers brainstorm: **guests are server accounts without Habitica**,
   so they play the same open map ([layers.md](layers.md), "Guests on the
   server").
10. **The shared world is communal and synced, and how long a change lasts
    depends on what made it** (owner, 2026-10-07, settling a conflict with
    [magic.md](magic.md)). Every change in a generated place is shared with the
    whole world.
    - **Built and lit with materials** (a plank crossing, a mended footbridge, a
      way-lamp): lasts until that chunk turns, or **for good inside
      lamplight**.
    - **Done by magic** (heave, brace, pin, a mended glade, a mage-lit lamp):
      holds **until the turning**, wherever it is, even inside lamplight. Only
      amber holds longer: Old ways pairs last past turnings.
    - House line: *magic holds until the land turns; what's built and lit holds
      longer.*
    - Harvested nodes and cleared camps keep their own respawn timers.
11. **River clay does both:** the base of way-lamps and pottery for home.
12. **Lamps and the Old ways** (owner, 2026-10-07, settling a conflict with
    [magic.md](magic.md)):
    - **The Keeper's hand is for everyone.** Naming a way-lamp is a Keeper's
      craft (writing down where the lamp stands), learned from Mara. Way-lamps
      are permanent and push the frontier.
    - **The mage's naming is the deeper magic.** It lights dark lamps out there
      without oil (a rest spot until the turning), stands in for the hearth oil
      when lighting a way-lamp or lantern post, and at level 30 gives two lamps
      one naming: **the Old ways, a mage capstone that anyone in the world can
      walk**.
    - A world without a level-30 mage has no fast travel. The way back is then
      the frontier rule, the turncap jar and the carter's map.

## Today

- The Wilds are two 3×3 regions of 24-tile chunks (`content/wilds.json`): the
  Tangle (`inner-1`, permanent) and the Whitequiet (`outer-1`, turns every wick).
- Generation is per chunk with no knowledge of neighbours
  (`src/lib/wilds/gen-v1.ts`, `tangle.ts`, `outer.ts`). Entities and loot are
  integer code ported to Go (`server/internal/wilds`) and pinned by test vectors;
  terrain is client-only. Epochs freeze each region's generator version.
- So nothing can span chunks (a river, a ridge, a lake shore). The open map
  fixes that.

## The open map

### Coordinates

Every generated chunk is keyed `(world, realm, layer, cx, cy)`:

- **realm:** `hearthwick` for everything now. Another dimension is another realm:
  its own map, its own fields and art, reached through a link (a doorway lamp,
  a drift-table). Nothing to build now beyond the field.
- **layer:** surface `0`, under `-1` (caves; see "Hooks for layers").
- **cx, cy:** chunk position. The Commons gate's chunk is the origin, so
  distance from Hearthwick is just distance from (0, 0).

Hand-made rooms (house interiors, upper floors) keep ids that name the place
they belong to, such as `in:village:mill` and `in:village:mill:2`
([layers.md](layers.md)). Only generated places use these coordinates.

### How a chunk is generated

Terrain comes from **continuous fields** sampled at world tile coordinates, not
chunk-local ones. A chunk is a pure function of its key and its epoch, and
neighbours agree at their shared edge because they sample the same fields.

- **Fields:** elevation, moisture and warmth from layered noise. The land type
  comes from the mix (woods, uplands, wetland, sap ground, lake country).
- **Height bands:** elevation is cut into a few bands (low, rise, high), with
  cliffs or scree where bands meet. Bands decide what's walkable; the look
  stays on the client.
- **Water:** lakes where elevation dips below a water level; rivers along the
  zero line of a ridged noise field, so they wind across chunk edges by
  construction. Each lake or river stretch records its size (for fishing, if it
  lands).
- **Canon geography as bias:** the fields lean by direction from Hearthwick, so
  the Tops rise to the west, the Wend runs through, and the land toward Sallow
  Ford lies east. The world is unbounded but its rough shape is canon.
- **The Lantern Road** is one fixed seeded line, with its old lamp stones
  already placed and dark. It leaves the Whitequiet northward, as today's
  crossing does, then bends east toward Sallow Ford. Relighting them is the easy way to push the
  frontier along the road; lamps you set yourself push it anywhere else.
- **Structures by cells:** the world is cut into cells of, say, 4×4 chunks.
  Each cell hashes to at most one structure (a camp ruin, a lamp site, a cave
  mouth, a landmark, a story site) at a hashed spot. A chunk reads the 3×3
  cells around it to know what touches it, which is bounded work.
- **Paths:** each structure links to its cell neighbours' structures with a
  seeded route. A chunk computes only the routes from nearby cells that cross
  it, then lays its own detail (clearings, nodes, camps, chests, decor spots)
  around them, as `tangle.ts` does today.

**The line between server and client:** anything a rule touches comes from the
server (walls, ground kinds, exits, nodes, chests, camps, loot tables, water,
lamp sites, obstacles). Anything only the eye sees stays on the client (painted
edges, tile variants, scatter, turncap lean), seeded from the chunk so everyone
sees the same thing.

### Rings and the drift

| Ring | What it is | Turns? |
|---|---|---|
| Home | Hearthwick, the Commons, homesteads (hand-made) | Never |
| Near | The Tangle, inside the old road's light | Never |
| Beyond | Everything past it, the Whitequiet included | Every wick, except within a lit lamp's light |

The Tangle and the Whitequiet stop being separate regions and become the first
rings of one map. Epochs move from regions to chunks: when a wick turns, an
unlit chunk in the Beyond takes the new epoch, and a chunk within a lit lamp's
light keeps its stored layout and entity ids.

**Seams:** a kept chunk was generated from an older epoch's fields, so its new
neighbours won't match its edges. The chunk next to a kept one blends its two or
three edge tiles into the kept chunk's edge and always leaves a walkable gap
where the kept chunk has one. In the world it reads as the edge of the light: a
band of scree, roots or churned ground where remembered land meets forgotten
land.

### The frontier

You can go **a few chunks past the nearest lit lamp** (say 3). Past that, the
drift turns you round: paths bend back, the turncaps spin, and you come out
facing the way you came. **Lighting and naming a lamp near the edge pushes the
frontier out for the whole world.**

- **It's the way back, built in.** You're never more than a short walk from a
  lamp. Fast travel home is the Old ways, which a level-30 mage makes between
  two named lamps.
- **It's the gate past the Whitequiet** that the ideas canvas asks for: until
  someone in the world can set and name a lamp out there, the frontier is the
  Whitequiet's edge.
- **It's shared progress.** A world grows outward together, lamp by lamp, which
  gives crafting (lamps cost materials) and playing together a long goal.
- **It bounds the backend.** Only lit land plus a thin ring is ever generated,
  so storage and generation grow with play, not with what a client asks for.
- **Difficulty grows with distance** from Hearthwick, so pushing the frontier
  is the progression.

### Way-lamps (draft)

The lamps that push the frontier are the homestead lantern post
(`docs/items/crafting-and-repair.md`, "Lantern posts") carried into the Wilds,
with the same three canon parts and the same naming.

- **Parts:** a fired **clay base** (lake country, the kiln), a **lamp head** and
  **wick**, and **hearth oil** to light it once. No refuelling, as with posts.
  A mage's naming can stand in for the hearth oil.
- **Light at chunk scale:** a way-lamp holds **its own chunk and the eight
  around it** (3×3 chunks). Held chunks never turn. The frontier is 3 chunks
  past any held chunk.
- **Never two dark in a row:** a new way-lamp must stand inside the frontier,
  so lamps chain outward from Hearthwick, as posts chain out from a home.
- **Old lamp sites are cheaper:** the Lantern Road's dark lamp stones need only
  a wick and oil to relight; a tight-ringed iron-oak stump (where a lamp once
  stood) halves the cost. The cell pass places both, so following the old road
  or reading stumps is the cheap way out.
- **Cost grows with distance** from Hearthwick, not with how many lamps the
  world has, so a big party isn't punished for being big.
- **Naming** works as for posts: fill in the blanks from real landmarks near the
  lamp, which the generator knows (the river bend, the lake, the ferry post).
  The lamp shows its short name and who named it. Each naming gives a naming
  slip in Papers. A level-30 mage can give two named lamps one naming to make
  an Old ways pair.
- **Communal:** anyone in the world who has taken the first step (below) can
  set one, whatever their class; it holds land for everyone. Lamps are never
  snuffed, so lit land only grows.
- **Mage-lit lamps are different.** A mage's "Name a lamp" lights a dark lamp
  (a hollow post, a road lamp stone, a fallen-hero lantern) with no oil, as a
  rest spot until the turning. It's magic, so it doesn't hold land past the
  turning. Our reading: it doesn't move the frontier either; only way-lamps do.
- **Bounded storage:** every held chunk is stored for good, so the world's
  stored size is the number of lamps × 9 chunks, plus the turning ring around
  them.

### The first step: the Keeper's hand (draft)

Owner, 2026-10-07: setting way-lamps comes after a first step, with lore. The
3×3 light and 3 chunks of slack are agreed.

Naming lamps is a Keeper's craft, and the Keeper's ledger is Mara's. Its middle
pages hold the road told lantern to lantern. Mara is afraid that if the road
can be relit, her grandmother Wenna left it dark out of cruelty. Teaching you
the naming is her deciding to let the road be held again.

1. **After the Warden is settled.** You spoke the naming "the road is held
   again; rest". Mara points out that it isn't held yet.
2. **Read a route stone.** Mara sends you to a dark lamp stone at the
   Whitequiet's far edge to copy the naming cut beside it (the same act as
   copying the closure naming at Ashwatch). The cell pass always places one
   there.
3. **Check it against the ledger.** Mara finds the same words in the middle
   pages: the ledger is still true out there. "Noted." Then she agrees. She
   writes your name into the ledger as **a Keeper's hand**, gives you a page on
   the form of a naming (a paper), and a **lamp head salvaged from the Count
   House**, so your first way-lamp needs no clay.
4. **Relight the stone.** You relight that first road lamp with a wick and
   hearth oil. The frontier opens past the Whitequiet. Anyone nearby witnesses
   it.

- **For everyone, per player** (agreed): any player of any class (or none) who
  wants to set way-lamps takes this step. The land they hold is for everyone.
- **Guests too:** guests are server accounts, so they can take it.
- **Fits the quest tree** ([quests.md](quests.md)) as a branch after the Warden,
  beside the bridge chapter. The road east is also where the main road chapters
  head (the Sallow Ford lamp), so road lamps far east can be story-gated by
  those chapters.

### Keeping the backend fast

- **Generate on demand, store once.** The first request for a chunk in its
  epoch generates it and stores the blob. Later requests read the blob. Stored
  layouts mean old generator versions can be deleted, unlike today's "the
  client keeps every version" rule.
- **Packed tight (protobuf).** 24×24 ground kinds as 4-bit indexes into a
  per-chunk palette is 288 bytes, the solid grid 72 bytes as a bitset, then the
  entity list and edge gaps: well under 1 KB a chunk. The same message is the
  stored blob and the wire format. It also gives presence its protobuf tooling
  (parked in `docs/scaling.md`).
- **Cheap generation.** Noise for 576 tiles plus a few short routes should be a
  millisecond or two in Go. Set a budget (5 ms per chunk at p95) and benchmark
  it before building on it.
- **Immutable means cacheable.** A chunk in its epoch never changes, so the
  server keeps hot chunks in memory (LRU), serves them with long cache headers,
  and the client keeps them in IndexedDB. Changing state (claims, harvested
  nodes, lit lamps) stays in entity-state rows, fetched separately as today.
- **Fetch pattern.** The client asks for the 3×3 around the hero and prefetches
  the next row near an edge: one small request per chunk crossed.
- **Generation only where players are.** The server generates a chunk only next
  to one a player is in, and only inside the frontier.
- **Per world.** Each party or solo world has its own map, so load splits
  naturally. Turning is lazy: nothing runs at the wick; the next request just
  gets the new epoch.
- **Guests are server accounts too** (owner, via [layers.md](layers.md), "Guests
  on the server"): a guest is an account without Habitica, so guests use the
  same generator, storage and endpoints. No baked map. This also opens the way
  to a version of the game without Habitica.
- **Offline (connected):** fetched chunks stay on the device.

### Shared enemies

The owner chose server-run, shared enemies ([layers.md](layers.md), "Fighting
together"): a Go sim per room, only while players are in it, moving enemies
against the stored map. On the open map:

- **A room is a chunk.** Camp enemies are leashed to their camp and never cross
  a chunk edge, so a room's sim never needs its neighbour's.
- **Camps and guardians are data:** enemy kinds, mixes and patterns per land
  type and distance ring.
- **Claims prove fights**, so loot can grow with distance without trusting the
  client.

### Hooks for layers

- Cave mouths are structures placed by the cell pass (a cliff foot in the
  uplands, a river bank, a sinkhole in sap ground) that link to a cave at layer
  `-1`.
- A cave is 1 to 4 chunks at layer `-1`, starting under its mouth. Its
  footprint stays inside its mouth's cell, and a cell holds at most one
  structure, so two caves never claim the same underground chunk. The footprint
  may run under land past the frontier; underground chunks are generated only
  when someone enters through the mouth.
- A cave's epoch follows the surface chunk its mouth is in. A cave whose mouth
  is in lamplight keeps its layout when the surface turns.
- The way-back rule holds underground: the mouth you came in by is always the
  way out. A level-30 mage could later pair a lamp inside a cave into the Old
  ways.

## Today's Tangle and Whitequiet on the open map (agreed)

- **Fixed story spots stay hand-placed.** The Tangle's story sites (the plank
  where the bridge tore), papers and Echo hooks become a small list of authored
  structures at fixed coordinates in ring one. The cell pass leaves those cells
  alone.
- **The Whitequiet keeps moving its Echoes.** Echo camps and given-back finds
  stay deterministic per epoch, as `outer.ts` does today, now placed by the
  cell pass in the turning ring.
- **Everything else regenerates once** when server generation ships: camps,
  nodes, chests, decor. Shared entity state and personal chest claims in the
  old Tangle epoch are cleared in that release; players keep everything in
  their packs and chests at home, and their story and Echo progress.
- **The crossing** from the Tangle to the Whitequiet becomes ordinary open map:
  the old road runs on through it.

## Kinds of land

Agreed (owner, 2026-10-07). Each comes from a mix of the fields, leaning by
direction from Hearthwick as the canon puts it.

| Land | Feel | Gathered there | Obstacles |
|---|---|---|---|
| **Woods** | Iron-oak, as the Tangle is today | Timber, fiber | Fallen trunks, thickets |
| **Lake country** | Meadows, the Wend, lakes, reeds | Reed, river clay, willow; fish if fishing lands | Fords, broken footbridges |
| **The Tops** | Uplands, scree, tarns, wind (west) | Slate, stone, tarn herbs | Rockfalls, cliffs (cave mouths) |
| **Sap ground** | Resin bog, amber pools, old sap-taps | Amber of every grade, the best further out | Sticky ground, sunken paths |
| **Stir-scar** | Land torn by the stir the night the Six were lost; rarer | Odd finds | Echoes, papers, drifted road |

The Merrow Saltings stay a far goal, perhaps a realm of their own later.

### Lake country first (agreed)

The first new land, chosen because it shows off what the new generator can do
(rivers and shores across chunk edges) and pairs with fishing.

**Where it is.** Wet, low ground. The Wend is a canon bias: one river is
guaranteed to cross the Whitequiet ring, so lake country is reachable inside
today's bounds before lamps and the frontier ship (build step 3 before step 4).

**What a lake-country chunk holds:**

- **Meadow** ground, more open than the woods (easier to read on a phone), with
  willow and alder stands where the woods would be.
- **The river:** 2 to 4 tiles of solid water winding across chunk edges. Where
  a path meets it, the generator places a **ford** (3 tiles of walkable
  shallows), **stepping stones**, or a **footbridge**, sometimes broken.
- **Lakes:** solid water where elevation dips below the water level, with a
  walkable bank of sand, stones or reeds all the way round.
- **Reed beds** at shores (walk-through), **clay banks** on river bends,
  **lily pads** and backwaters as dressing.

**Gathering** (targets in `content/gathering.json`, with the usual visit and
day caps):

| Target | Action | Yields | New? |
|---|---|---|---|
| Reed bed | Cut (dig action, spade) | Reed 2–4, fiber 0–1 | Reed is new |
| Clay bank | Dig (spade) | River clay 1–3 | New |
| Willow | Chop | Timber, willow bark | Exists |

**What reed and clay are for** (first guesses):

- **Rushlights:** reed dipped in tallow or candle oil. A cheap, short light,
  and canon-plausible for a village rationing oil.
- **The way-lamp base:** river clay fired into the base of the lamps that push
  the frontier. This ties lake country into the main progression.
- **Pottery** for home (agreed): see "Pottery" below.
- **Fishing tackle**, if fishing wants it: reed pots, a reed float.

**Obstacles** come from the obstacle catalogue (see "Every class, every
playstyle"). In lake country: fallen willows across paths (heavy thing), broken
footbridges (small gap), a fallen bridge over the river (large span), silted
springs, hidden fords and stepping stones (hidden way), and dark ferry lamps.

**Fighting:** camps on the shared-enemy sim. Start with today's wisps and
beetles in lake-country colours, then one new kind: a **fen-light**, a wisp
that drifts toward water and tries to draw you after it.

**Exploring:** landmarks such as the old ferry post, a drowned waystation and a
heron stone. In Mudrise, **candle hulls** from the Breaking wash up in the
reeds (festival tie-in, a small keepsake). Papers include a ferryman's tally.

**Playing together (agreed):** a crossing someone builds with materials stays
for everyone in the world until that chunk turns, or for good inside
lamplight. A crossing held by magic (a healer's mend, a warrior's brace) lasts
until the turning (decision 10).

**Water for fishing.** The generator emits each water body as a server-known
fishery descriptor: an id (`water:<chunk key>:<n>`), its tile area, its habitat
(still, flowing, reedy) and its bank tiles. Water is counted per chunk, so a
lake across two chunks is two waters, and a bridge or ford never splits one.
This answers the fishing brainstorm's "clients cannot submit their own pond
size" ([fishing.md](fishing.md), "Starting
rules to explore"). A water in a chunk that turns is new water with fresh
stock; a water in lamplight keeps its stock.

**Art needed:**

- Ground: meadow grass; sand and stone banks; shallows (ford); river water
  with a flowing animation of 2 to 3 frames; lake water (today's still water
  may do).
- Shore edges painted procedurally as today, plus a reed edge.
- Props: willow, alder, reed bed (the `reeds` decor exists), lily pads, clay
  bank, stepping stones, footbridge whole and broken, a felled-log crossing,
  the ferry post, the drowned waystation, the heron stone, a candle hull.
- Icons: reed bundle, river clay, rushlight, crock, jug, reed basket, waders,
  plank and rope.
- Enemies: lake-colour wisp and beetle, the fen-light.

### Pottery (agreed in principle; details are first guesses)

River clay becomes things for home, made at a kiln and marked with the maker's
name like every other crafted good.

- **Finn Tolley teaches it** (owner, 2026-10-07). Behind the mill stands his
  late father Aldo's kiln, cold for years. **Relighting Aldo's kiln** is a
  village project (river clay, stone, timber in `content/projects.json`). When
  it's done, Finn hands out the first pottery recipe pages and the homestead
  kiln can be built. It gives the anxious miller a calm craft to share, and a
  thread back to Aldo, who kept the linseed box.

- **The kiln** is a homestead build beside the workshop (it needs the workshop
  tier): stone, timber and river clay. Like the bench, everyone on the deed can
  use it.
- **Shape, then fire.** You shape pieces at the bench from clay (plus reed or
  other materials), then load them in the kiln. **Firing is slow and lazy:** the
  kiln records when it was lit, and the pieces are ready when you next look
  after a few real hours. Nothing ticks. It suits sessions between real-life
  tasks: load it, go do something, come back to finished pots.
- **Glazes tie the lands together:** plain fired clay to start; ash glaze from
  the woods, a green glaze from tarn herbs (the Tops), an amber glaze from sap
  ground. Each new land adds a look.
- **What it makes:** crocks and jugs (home goods), bowls and a pitcher for the
  table, planters for the homestead garden, roof tiles or floor tiles if the
  cottage tiers want them, and the **way-lamp base**.
- **Recipes are papers**, as today: a few from Finn, more
  found in lake country (a potter's daybook at the drowned waystation).
- **Gifts and the gate shelf:** pottery is a natural thing to give, so it fits
  the gate shelf and parcels with no new rules.

Art: kiln (cold and lit), the shaped and fired look of each piece, glaze
colours, icons for each piece and for the glazes.

## Every class, every playstyle

### One obstacle catalogue (owner, 2026-10-07)

Obstacles and the class workings from [magic.md](magic.md) ("The four crafts")
are **one catalogue in `content/`**. Each obstacle kind names its class working
and its tool way.

- **Workings are class-only and unlock on magic's ladder** (levels 10, 15, 20
  and 30, by Habitica level).
- **Level sets the size** a working can move, using the size tiers below.
- **Every obstacle always has a tool way**, so heroes without a class (guests,
  players under level 10) are never shut out. No obstacle is class-only.
- **How long it lasts** follows decision 10: a working holds until the turning;
  a tool way that builds something lasts for good inside lamplight.

| Size | A working can move it from | Appears from | Tool way |
|---|---|---|---|
| Small | The working's unlock level | Ring one | 1 tool or kit |
| Medium | Level 15 | A few chunks past the Whitequiet | 2 kits, or a better one |
| Large | Level 30 | Further out | A crafted piece (a plank bridge, a rope ladder) |
| Huge | Level 50 | Far out, rare | A crafted piece, or two players together |

(A working never applies below its unlock level: Brace, at 30, starts at large.)

| Obstacle | Class working (craft, level) | Tool way | What opens |
|---|---|---|---|
| **Heavy thing** (a fallen log or willow, a boulder, a rockfall) | Warrior, **Heave** (Holding, 10) | Axe or pick and rope; a lever pole for bigger | A side clearing, a cache, a shortcut |
| **Small gap** (a broken footbridge, a missing plank, a cracked step) | Healer, **Mend** the thing (Mending, 10 or 15; see below) | Plank and rope | The crossing |
| **Large span** (a fallen bridge, a torn ravine) | Warrior, **Brace** (Holding, 30) | A plank bridge (crafted) | The best side places sit behind spans |
| **Silted spring, cracked lamp, sick grove** | Healer, **Mend** the thing (Mending, 10 or 15) | Spade (spring); lamp parts (lamp) | Fresh water and a rest spot; a lamp to relight |
| **Dark lamp** (a hollow post, a road lamp stone, a ferry lamp) | Mage, **Name a lamp** (Naming, 10): a rest spot until the turning | A Keeper's hand with wick and hearth oil: a permanent way-lamp | Rest; for a way-lamp, held land and frontier |
| **Drifted path** (a way that has wandered, an old ford gone under) | Mage, **Read a route stone** (Naming, 15): a guide pin to a place you've been | The turncap jar; the carter's map | The way through |
| **Hidden way** (stepping stones, a gap in the scree, a cache) | Rogue, **Read the drift** (Drift-reading, 10) | The runner's whistle (hidden things chime back); a slow search | The stones, the gap, the cache |
| **Thick drift** (a stretch where you'd become *unmoored*) | Rogue, **Walk a blind route** (Drift-reading, 15): leaves turncaps others can follow | Comfrey salve or willow-bark tea; the turncap jar | Safe passage for whoever follows |

**The healer's world working.** Magic's healer works on tools (Mend a tool, 10)
and on people (Settle, 15). The catalogue widens one of these to **mending
things in the world** (a spring, a footbridge, a cracked lamp) as well as
tools. Which of the two levels it hangs on is magic's call. Small gaps go to the
healer; large spans stay the warrior's Brace.

**Capstones out here:** Brace (warrior) opens large spans; Old ways (mage)
pairs two named lamps for anyone to walk; Mended glade (healer) makes a resting
place in the Wilds; Sense the turning (rogue) shows what the next turning will
bring, which the server can work out from the seed.

### Playstyles

| Playstyle | What waits out there |
|---|---|
| Fighting | Camps with new enemies per land type; a guardian per reach (settled, not slain) |
| Gathering | Materials per land type (river clay, reed, slate, storm amber, tarn herbs); fishing if it lands |
| Crafting | Lamps to push the frontier; gear for getting about (rope, waders, a coracle) |
| Exploring | The frontier itself, landmarks, the carter's map filling in, papers |
| Socialising | Shared lamps, pushing the frontier together, party outings, witnessing |

## Ways back

- **The frontier rule:** never more than a few chunks from a lit lamp.
- **Old ways:** a level-30 mage gives two named lamps one naming, and anyone
  in the world can walk between them. The fast travel. It replaces "Old ways"
  for everyone in `docs/hands-on-design.md` §5. A world without such a mage
  has no fast travel.
- **The turncap jar** already tilts toward the nearest named light.
- **The carter's map** (UI step 10) shows lit land and your lamps.

## Considered and set aside

- **The Lantern Road outward** (a spine of road legs, each its own land): kept as
  the seeded road running east through the open map.
- **Fixed regions with a region planner:** replaced by continuous fields and
  structure cells, which need no planner for the land.
- **Outings from a departure point** (a drift-table trip to one destination):
  could return as a realm link later.

## Open questions

1. Pottery: is a slow kiln firing of a few real hours welcome?
2. Way-lamps: cost by distance, and that lamps are never snuffed. (Does a
   mage-lit lamp move the frontier until the turning? This doc reads no.)
3. How fast difficulty and way-lamp cost grow with distance (numbers).
4. The other lands (the Tops, sap ground, stir-scar) in the same detail as lake
   country, when their turn comes.

## Build order (rough, each step shippable)

1. **Server generator, same world.** Go generator, protobuf chunks, storage,
   cache and the chunk endpoint. Regenerate the Tangle and the Whitequiet as
   rings of the open map inside today's bounds, with the fixed story spots kept;
   the client renders server chunks, for guests too. Benchmark against the
   budget.
2. **Per-chunk epochs.** Turning moves to chunks, with lit land kept and seams
   blended.
3. **Fields, water and lake country.** Height bands, rivers and lakes, the Wend
   through the Whitequiet ring, reed and clay gathering, crossings and their
   obstacles, and the art. Waters reach the server as fisheries for the fishing
   brainstorm.
4. **Pottery.** The Aldo's kiln village project, Finn's recipe pages, the
   homestead kiln with lazy firing, the first pieces and glazes.
5. **Lamps and the frontier.** The Keeper's hand, way-lamps and naming, the
   frontier rule, and the road's dark lamp stones. The Old ways come with
   magic's mage capstone.
6. **More to do out there.** Obstacles with class and level ways beyond lake
   country, and camps and guardians on the shared-enemy sim (after the layers
   brainstorm's server enemies).
7. **The next lands** (the Tops, sap ground, stir-scar), one at a time, each a
   small release with its materials, glaze and art.
8. **Caves** through the hooks above (layers brainstorm).
