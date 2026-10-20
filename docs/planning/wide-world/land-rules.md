# Rules for land that feels real

*Decided with the owner, 2026-10-20. Sources:
[ideas-argon.md](responses/ideas-argon.md) §7 (Argon's twelve rules) and
[land-rules-sol.md](responses/land-rules-sol.md) (Sol's review against `server/internal/wilds/`).
Context: [synthesis.md](synthesis.md), [height-spike-notes.md](height-spike-notes.md),
[height-lab-2-notes.md](height-lab-2-notes.md), `docs/roadmap.md` 0.14.*

The idea behind all of them (Argon's): land feels real when each small detail follows from the
land's shape and history, not from a dice roll at that tile. Sol's correction: the rules need
shared plans the generator can rely on, not more scatter on top of today's corridors.

**Statuses.** **Agreed**; **changed** (the owner's wording); **stage 2** (owner: planned, but
taken up once the height map and terrain are figured out; the direction stands, the details are
settled then, against real terrain); **expectation** (what these rules need from the height
design, which owns how height, cliffs and caves work: "let's not dictate too much about height,
caves, etc.").

## Build order for 0.14 (owner, 2026-10-20)

Terrain first, then water over it, then the living dressing. This replaces the iteration order in
the roadmap and [synthesis.md](synthesis.md) (lake country used to come second).

1. **Walk any way** (merged; fixes from its review in flight): open world, border, landform
   version split, world lab.
2. **Terrain and below:** height, cliffs, ramps, passes (the Tops) and caves, together, per the
   height design.
3. **Water:** a flow map over the real terrain gives rivers, streams, lakes, ponds and tarns.
4. **Lake country and the woods:** biomes and pins, and the dressing rules.
5. **Far roads and tuning.**

Owner: "if we do a water flow map (and that influences lakes, ponds, rivers, streams, etc) we
should probably do that before lake country." The cost of this order: the first new biome arrives
in iteration 4, so playtesters see mountains, caves and water on today's woods first.

**Reconciled with the open world and the height design** (owner, 2026-10-20, after this file was
first written): caves come with the terrain in iteration 2, not after the biomes (the must-have
is climbing a mountain and walking into a cave with no door, and the height labs design them as
one thing). These rules say what the land must look and play like; how height, cliffs, ramps,
caves and channels are built belongs to the height design (rules 2, 6 and 16 were trimmed to
match). Region access keeps the open world's guarantees for held land (rule 2).

## How every rule is built

Each chunk is made alone, so anything that crosses a chunk edge (a lake, a grove, a cliff, a trail,
a clearing) comes from a **plan with an owner**: a feature owned by a spot on a coarse grid, with a
lasting id and a bounded size. A chunk asks "which owners could reach me?", draws their parts,
settles overlaps in a fixed order, and clips to its box. Never "carve the inside and hope the
neighbour matches". Lasting things (water, rock, height, passes, caves, big landmarks) use the
landform seed; living things (ordinary trees, forage, creatures, lesser paths) use the weekly seed.
The border limits where you can walk, never what the generator may sample, so widening it moves
nothing. Each rule adds its overlay to the world lab, and generation must stay within the chunk
budget (today 5 ms p95, 6 KiB), measured, not assumed.

## The rules, in build order

| # | Rule | Iter. | Status |
|---|---|---|---|
| 1 | Lasting skeleton, turning skin, and the way home lasts too | 1→ | **agreed** |
| 2 | Trails are lazy walkers; reach regions, not every chunk edge | 2, 5 | **agreed** |
| 3 | It works before it's pretty | 2 | **expectation** |
| 4 | Keep faces, ramps and mouths readable | 2 | **expectation** |
| 5 | One look for height from every side | 2 | **expectation** |
| 6 | Water never runs uphill: a flow map | 3 | **changed** |
| 7 | Still water sits in hollows (ponds and tarns) | 3 | **stage 2** |
| 8 | Country first, trails through it | 4 | **agreed** |
| 9 | Restraint: broad masses, a few accents | 4→ | **agreed** |
| 10 | Biomes blend; edges are sharp only where the land explains it | 4 | **stage 2** |
| 11 | Groves, not confetti | 4 | **stage 2** |
| 12 | Old things get the space they need | 4 | **stage 2** |
| 13 | Landmarks you can steer by | 4→5 | **stage 2** |
| 14 | Room to build | 4 | **stage 2** |
| 15 | Trees thin as you climb | 4 | **stage 2** |
| 16 | Rock comes in seams; stones fall below faces | 4 | **stage 2** |
| 17 | Cliff feet: wet only where there's water | 4 | **stage 2** |
| 18 | Ruins and road stones have a reason | 6 | **stage 2** |
| 19 | Creatures live where their food and shelter are | life lane, 5 | **stage 2** |

### 1. Lasting skeleton, turning skin, and the way home lasts too

*Argon 12, Sol keep (with access added). Agreed.*

- **On the ground:** the saddle lake and the waterfall below it are there every week, and so is the
  pass and the ford you used to get there. The berry bushes and beetle camps on its shore move.
- **How:** lakes, channels, rock, heights, ramps, main passes and crossings, cave shapes and mouths,
  and big historical landmarks live on lasting plans (landform seed and version). Ordinary trees,
  forage, creatures and lesser paths turn. Held and fixed land stay as they are. Player things are
  overlays generated land never moves.
- **Lands:** iteration 1 split the landform version (`LandformV1`, merged); each later iteration
  puts its new features on lasting plans.

### 2. Trails are lazy walkers; reach regions, not every chunk edge

*Argon 6 (contour A\* between landmarks), changed by Sol: plan passes and fords first. Agreed.*

- **On the ground:** trails follow the hillside, switch back up slopes, cross ranges at saddles
  and rivers at fords. A range or a river is a real barrier with a few known ways over. There are
  loops, not one funnel.
- **How:** lasting passes and fords first; route on a coarse graph, then refine to tiles only along
  the corridor using the height design's walking rule. Whether trails make ramps or follow ramps
  the terrain already has is the height design's call (owner, reconciling). Guarantee every region
  can be reached (and home from it), not that every chunk edge opens. Deleting today's edge gaps
  and adding the region check land together.
- **The open world's guard** (owner, reconciling): region access must also keep every held chunk,
  lamp, camp and town gate reachable through the openings it already has, and must never strand
  anyone where they stand (a hero saved on ground that turns to rock still gets out). Iteration
  2's brief proves both on real held land.
- **Lands:** coarse access with terrain (2); fords once water exists (3); regional roads (5).

### 3. It works before it's pretty

*Sol, missing from Argon. Expectation on the height design.*

- **On the ground:** a ford actually crosses, a pass reaches both sides, a cave branch has a way
  back you can read. A dead end is fine if it looks like one.
- **Expects:** reach checks on the real walking graph, before dressing, with the lab reporting
  detours and failed links.

### 4. Keep faces, ramps and mouths readable

*Argon 11 (trees 2 tiles back from a cliff), changed by Sol: use real sprite bounds. Expectation.*

- **On the ground:** no tree crown hides a cliff face, a ramp, a ford, a cave mouth or the hero.
  Ivy over a lip never makes a drop look walkable.
- **Expects:** a mask of faces, ramps and mouths from lasting geometry that dressing can read; the
  dressing rules (11, 15, 16, 17) filter tall decor by its real art bounds. Ivy and dense small
  props stay sparse for phone draw cost. Judged in an in-game walk, not a lab PNG.

### 5. One look for height from every side

*Sol, missing from Argon. Expectation.*

- **On the ground:** a drop reads as a drop whether you face it from the north (a thin rim) or the
  south (a tall face). No walkable ground hidden behind a cliff.
- **Expects:** the height design's art and generator choices; an art ask.

### 6. Water never runs uphill: a flow map

*Argon 1 ("exclusively downhill"), changed by Sol and then by the owner. The owner liked this one
from the start: it "allows for an algorithm for the placement of smaller ponds or alpine lakes."*

- **On the ground:** every stream comes from somewhere (a spring at a cliff foot, a tarn, a bog)
  and goes somewhere (a lake, a hollow, another stream). Streams join and grow downstream. Water
  may run level for a while; it never climbs. Waterfalls are where the land drops. No orphan bits
  of river.
- **How:** its own system over the finished terrain (owner: "a drainage network as its own system
  after terrain height is figured out"). The rule fixes the outcome above, not the method (owner,
  reconciling): how a channel meets the height levels (carved into them, or a water height of its
  own) is for the height design and the water iteration's brief. Sol's bounded drainage solve is
  the starting point: drainage domains on a coarse grid, a fill-and-flow pass from each domain's
  low point, flow added up downstream. Confluences share one id; width comes from the flow. Domain
  size, rivers crossing domains, and cold-solve cost are settled in that brief, measured in the
  lab.
- **The Wend:** owner: make it believable; it needn't stay one long wiggly line, "or [it can]
  disappear in favour of the water network, and have other rivers show up." One move before 1.0
  is fine.
- **Lands:** iteration 3.

### 7. Still water sits in hollows

*New, from the owner's reaction to rule 6. Stage 2.*

- **On the ground:** a pond lies in a dip in the meadow; a small tarn fills a bowl on the
  mountain, flat and level, and if it overflows a stream leaves from its low lip and runs down.
- **How:** falls out of the flow map: hollows filled to their spill height become ponds, tarns and
  lakes with lasting ids, and the spill point starts the outlet stream. Lake surfaces are always
  level. A hollow that would cut across a cliff or ramp is dropped, not forced.
- **Lands:** iteration 3.

### 8. Country first, trails through it

*Sol, missing from Argon. Agreed: "forest that can be walked through with a few trails."*

- **On the ground:** the woods are a forest you can walk through, with dense thickets, fallen
  trees and boggy bits in the way, and a few trails that are the easy way. Not a maze of
  corridors with a clearing at every junction.
- **How:** woods solidity comes from shared fields (dense pockets, open floor), not a
  `thicketPermille` of 1000 carved by corridors; then a sparse trail network over it, with access
  from rule 2. The maze feel survives as thicket pockets or a thicket biome.
- **Lands:** iteration 4, measured in the lab against today's corridor rhythm.

### 9. Restraint: broad masses, a few accents

*Sol, missing from Argon; matches the owner's "too many camps" note. Agreed.*

- **On the ground:** long stretches of plain meadow and ordinary woods, so the rock tower or the
  old tree actually stands out. Walking without an encounter for a while is normal.
- **How:** landmarks and wonders spaced per region, not one per three-chunk place cell; the lab
  reports spacing, repetition and encounter-free walking time. Numbers tuned in the lab with the
  owner.
- **Lands:** iteration 4 onward; creature counts with the life lane.

### 10. Biomes blend; edges are sharp only where the land explains it

*Argon 7, Sol keep. Stage 2.*

- **On the ground:** woods thin into wet meadow, then willow clumps, then mud, then reeds, with
  the odd island of each across the line. A cliff or a lake shore can be a sharp edge because you
  can see why.
- **How:** one pinned biome owns each tile; a lasting blend weight from the shared border mixes
  compatible ground and decor and fades canopy. 12–20 tiles is a starting range to tune. Water
  depth, cliffs, danger and the Whitequiet's look never blur. A new biome never changes a seen
  neighbour.
- **Lands:** iteration 4. Sol rates it the best return for the work.

### 11. Groves, not confetti

*Argon 4 (mother trees in downwind arcs), changed by Sol. Stage 2.*

- **On the ground:** trees stand in stands of mixed ages, with gaps, the odd lone tree, a dead one,
  and saplings at a grove's edge. Ferns and mushrooms on the shaded side of trunks and rocks.
- **How:** a lasting grove-potential field plus a few named old-tree anchors on a coarse grid;
  turning saplings and scrub drawn inside it. Groups replace today's tile-by-tile scatter rather
  than adding to it. "Shaded side" means the art's light direction, plus moisture.
- **Lands:** iteration 4, with rule 8 (walk-through woods need groves to look like forest).

### 12. Old things get the space they need

*Argon 5 (a 3–6 tile halo with a flower ring), changed by Sol. Stage 2.*

- **On the ground:** a lamp stone has a clear way up to it; a ruin can have bushes behind it; an
  old tree has shade, not a circle of flowers. Nothing clips into a landmark.
- **How:** per-kind approach shapes reserved before paths and decor (today's `clearPlace` and
  friends, extended across chunk edges through owner plans). A spot that would need a shore or
  cliff flattened is rejected, not flattened.
- **Lands:** iteration 4.

### 13. Landmarks you can steer by

*Sol, missing from Argon. Stage 2.*

- **On the ground:** you can tell someone the way home: "left at the leaning rock tower, along the
  hooked shore". Specials differ in shape, colour and ground, so they aren't all the same prop.
- **How:** a landmark vocabulary with route roles; the lab counts repeats. The test is a
  playtester describing a route without coordinates.
- **Lands:** iteration 4 onward; mostly content and tuning in 5.

### 14. Room to build

*Sol, missing from Argon. Feeds 0.15 building. Stage 2.*

- **On the ground:** now and then a dry, flat, open patch with a view and two ways in, a natural
  spot for a home. Not one in every chunk.
- **How:** measure how many usable footprints (6×6, 8×8 to start) the lasting terrain offers;
  building spots are checked against lasting land, not this week's clearing.
- **Lands:** measured in iteration 4; tuned when the building kit is known.

### 15. Trees thin as you climb

*Argon 3, Sol keep (height relative to the biome). Stage 2.*

- **On the ground:** full woods in the valleys, sparser and windswept higher up, scrub and heather
  near the top, bare rock and cairns on summits. A sheltered hollow up high can still hold a copse.
- **How:** a lasting canopy-potential mask from height, climate and exposure, so the change is
  gradual, not three stripes. A low plateau can stay wooded; the treeline is per biome. Solidity
  follows the mask (no invisible walls where trees were removed); rock faces are rock.
- **Lands:** iteration 4. Sol: the cheapest very visible win once cliffs exist.

### 16. Rock comes in seams; stones fall below faces

*Argon 8, changed by Sol ("exclusively" and "diagonal"). Stage 2.*

- **On the ground:** outcrops line up with the ridges and bend with them; loose stones pile below
  a cliff face; round stones on river banks; the odd lone boulder in a field.
- **How:** outcrops follow the ridges and faces the height design makes (owner, reconciling: the
  rock doesn't steer the ridges). Talus about 4 tiles below the face foot (on screen, below the
  face rows), never on a ramp or a cave approach. Big outcrops last; small stones turn.
- **Lands:** iteration 4.

### 17. Cliff feet: wet only where there's water

*Argon 2 (rain shadows and wet toes), changed by Sol. Stage 2.*

- **On the ground:** ferns, moss and dark soil at the foot of a cliff that has a spring or a
  stream; dry stony toes otherwise. The lip above is windier and barer.
- **How:** a lasting moisture modifier from the wetness field, the flow map, hollows and cliff-toe
  position; an exposure modifier for lips. Computed once per chunk with its halo.
- **Lands:** iteration 4.

### 18. Ruins and road stones have a reason

*Argon 10, Sol keep without the spacing rule. Stage 2.*

- **On the ground:** a saw-pit near haulable wood and a dry bank; road stones along the road,
  facing the next ford or pass, with longer gaps on straight stretches.
- **How:** terrain and resources → destinations → roads → roadside remains, all lasting plans.
  Generated lamp stones all start dark; nothing relights them for realism.
- **Lands:** a few cues in iteration 4; roads in iteration 5.

### 19. Creatures live where their food and shelter are

*Argon 9, Sol keep. Stage 2; the spawning algorithm belongs to the life lane
([life-synthesis.md](life-synthesis.md)).*

- **On the ground:** ducks near reeds, goats near ledges, beetles near deadwood; no camp on a
  one-tile switchback or across a cave's way out.
- **How:** lasting habitat masks (reed edge, grove and deadwood, ledge, hollow, exposed slope),
  then turning spawns weighted by them, with regional caps. Safe approaches and escape routes are
  hard checks. The Whitequiet's own rules win over "dark hollow" weights.
- **Lands:** masks with the dressing (4); spawning with the life lane.

## Where rules fight, and what wins

1. **The cliff foot** (wet toes 17, talus 16, shade plants 11, readability 4, ramps): access and
   readability win (ramp, mouth, face, approach kept clear); then a few accents in what's left.
   Never stack every pass on the same strip.
2. **Groves vs. landmark space** (11, 12): the landmark's approach wins; a grove can sit behind it.
3. **Soft edges vs. hard facts** (10 vs. water, cliffs, danger, Whitequiet): hard facts win.
   Blends mix ground and plants only.
4. **Water vs. terrain** (6, 7): water follows the terrain, never painted on after. If a hollow or
   stream can't fit the cliffs, the water gives way, not the cliff.
5. **Lazy trails vs. play** (2): a narrow saddle is a meeting point, so keep room to pass and rest
   near it, and no unavoidable camp on a switchback. Loops, so every trip isn't the same funnel.
6. **Realism vs. access** (2, 3 vs. today's gaps): access is guaranteed per region, not per chunk
   edge; both changes land together so nobody is stranded.
7. **Detail vs. phone cost** (all dressing): flat baked ground patches over many tall sprites; no
   per-tuft animation, moss sprites or extra lights.
8. **Creatures vs. habitat** (19 vs. 3, 4): safe approaches and ways out win over "this hollow
   suits a monster".

## Dropped

- **Rain shadows** (Argon 2): needs a wind and climate model for little gain; the wetness field
  covers "this side is wetter".
- **South- and east-facing cliffs are wetter** (Argon 2): orientation isn't a reason; water is.
  Replaced by rule 17.
- **Fixed diagonal rock stripes** (Argon 8): would look like stripes on the map. Replaced by
  rule 16.
- **One mother tree with saplings in downwind arcs** (Argon 4): a repeated stamp. Replaced by
  rule 11.
- **A 3–6 tile halo with a flower ring round every landmark** (Argon 5): adds to the
  room-at-every-junction look. Replaced by rule 12.
- **"Never two dark in a row" for lamp stones** (Argon 10): that's about players tending lamps;
  generated stones all start dark.
- **A fixed two-tile setback from cliffs** (Argon 11): a guess; replaced by real art bounds
  (rule 4).
- **Oxbows and a sea** (Argon 1): not in 0.14; the flow map ends rivers in lakes and hollows.

## Still open

- **The flow map's shape** (domain size, whether rivers cross domains, how long a cold solve may
  take) is for the water iteration's brief, measured in the world lab.
- **Creature spawning** waits on the life lane.
- **Stage 2 details** are settled against real terrain, each in its iteration's brief.

## Where this differs from Sol

- **Ponds and tarns** (rule 7) are new, from the owner's note. With the flow map they come almost
  free: filled hollows are the ponds.
- **The flow map moved up**: Sol offered it as an iteration 5 option; the owner made water its own
  iteration, right after terrain.
- Otherwise Sol's corrections hold up. I checked the claims I could against the code (woods
  `thicketPermille` 1000, three-chunk place cells, the landform hash including
  `GeneratorVersion`, lamp stones on the road), and they match. (Orchestrator: this branch was
  cut before the open world merged; that lane split the landform hash out as `LandformV1`.)
