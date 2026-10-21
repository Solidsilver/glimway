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
