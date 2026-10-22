# Biomes and terrain: what the owner decided

*Started 2026-10-21, from [terrain-brief.md](terrain-brief.md) and the two answers,
[terrain-argon.md](responses/terrain-argon.md) and [terrain-sol.md](responses/terrain-sol.md).
Added to as the owner answers.*

## Early calls (owner, 2026-10-21, after reading Argon's summary)

1. **The round land borders can stay.** The owner doesn't mind the circles: in the game they feel
   natural, and they only look odd on the map because there are just two kinds of land so far, so
   it's too uniform. Replacing the weighting in `lands.go` (Argon's top item) isn't needed for
   this; more biomes are the fix. Revisit only if it still looks wrong with several biomes.
2. **Stone laid on a rough slope becomes built stone steps,** and counts toward the ways between
   places (Argon's recommendation).
3. **A region pins when its chunks are loaded** (walked near enough to generate), not when the map
   shows it.
4. **New generation can reach unkept land at the turning.** After a server update with new biome
   or terrain generation, the next turning may move unkept regions onto it; kept (held) land and
   fixed places stay as they are. So pins hold land that is kept, and lasting geography lasts
   between updates rather than forever. The design should say what this means for pins, held
   land at a region's edge, seams against held neighbours, the explored map and the generator
   versions.

## The owner's calls on the two designs (2026-10-21)

Both answers are merged: [terrain-argon.md](responses/terrain-argon.md),
[terrain-sol.md](responses/terrain-sol.md).

5. **The walk home: spike first, then pick.** The first lane builds Sol's region plan for one
   ridge in the world lab and measures it (cold plan time, storage), alongside Argon's
   pure-local south-face rule. The lab also shows whether Argon's per-chunk checks would have
   stranded any ground there. The owner chooses with those numbers.
6. **The Whitequiet: pale, not snowy, mostly to the north.** Sol's look (ivory grass, grey soil,
   sparse pale birch and bare snags, hushed), more of it northward, no special rules and no fights.
   No sanctuary or hearth yet (Argon's idea is parked for its own brief). The existing named place
   `whitequiet` (`content/wilds.json`) stays. Snow can be a biome of its own later.
7. **Near home: hills soon, mountains further.** A flat apron of about one chunk at the gates,
   low shoulders 3–6 chunks out, the first real mountains further off. Town and the Tangle stay
   flat; the home region isn't forced to woods.
8. **An update turning can change the shape of unkept land.** After a server update, the next
   turning may fully regenerate unkept land, height included. Held land, fixed places and the
   routes into them stay. So a pin or a terrain plan only has to last until the next update
   turning, and old generator code only lives as long as kept land needs it. This answers Sol's
   "permanence while water is pending": water arrives at an update turning.

## Technical calls (orchestrator, 2026-10-21; the build lanes may revisit with evidence)

- **Height on the wire: Sol's shape** (2-bit tops and kinds, plus sparse overrides with exact
  edge heights in 1/256 level). Argon's one-byte codes only fit one-level ramps of 2–3 tiles;
  the owner wants long multi-level stairs and spirals.
- **Versions: LandformV2 and GeneratorV4** (Sol). LandformV1 stays frozen for old kept land.
- **Height is world-wide,** not switched per biome, so region edges never make walls (Sol).
  Biomes choose ground, cover and the character of relief.
- **South faces come from a pure local rule,** the same on both sides of a seam (Argon §2.2),
  whatever the access plan turns out to be.
- **Fog at levels above and below the hero,** as the lab settled (not mist below only).
- **Regions use plain nearest-site distance with a warp** (Sol). Round borders for the smaller
  land cells stay as they are (call 1).
- **A region pins when a chunk in it is generated** (call 3). Lab previews never pin the real world.

## After walking it: slopes by default (owner, 2026-10-21)

The owner walked the generated slice near home in the height lab
(`terrain-walk-notes.md`) and found it "a bunch of plateaus with walls/cliffs".
The picture they want:

- **Mountains that read as mountains:** larger, with semi-smooth sides on the way up and
  passable paths up through passes.
- **Hills:** generally gradual up and down.
- **Rock outcrops:** a climb up one side, a sharp edge on the other.
- **Cliffs kept for particular things:** the edges of some mountains, jagged edges, and later
  the sea or large lakes.

**What changes:** walkable slope becomes the default ground, following a smooth height field
through the exact 1/256 edge heights. Cliffs come only from an intentional crag/scarp field. Ground
past a steepness limit is "too steep" (scree or bare rock): visibly mountainside, not walkable.
Passes are saddles under the limit, and the region plan's job becomes "every range has a pass".
Cliffs and too-steep ground form ribbons, never closed rings, so the walk-home guarantee mostly
follows. Whole-level plateaus and the A/B access choice are superseded. The spike's exact edges,
local south-face rule and certificate idea carry over. Mountains need more than levels 0–3, so
the 2-bit tops in the wire format must widen.

**Next (owner's pick): a slopes round in the height lab first,** in a hand-made area with:

- rolling hills;
- a smooth-sided mountain with a scree band, a pass and crags;
- an outcrop;
- a sea-cliff edge.

The round tries all four drawing styles the owner picked: shading by facing, contour hints,
small terraces, and a true ¾ lift. The owner walks it and picks. Only then is the generator
rebuilt around slopes; lane B's fields and biomes stay, and upland becomes the smooth mountain
height.
