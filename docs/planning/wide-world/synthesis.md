# The wide world: where the two answers agree, and what the owner decides

*2026-10-20. From [claude.md](responses/claude.md) (Opus) and [sol.md](responses/sol.md) (Sol),
both answering [brief.md](brief.md). The height spike (`exp/height-spike`) is still running.*

## They agree on

- **Maths isn't the limit; the rules are.** Opus generated chunks 80 million chunks out and they
  were normal (~1.5 ms each). Today's real wall is the south: every chunk south of `southLimit`
  comes out solid thicket, because the places and routes passes stop there.
- **Replace the frontier with two limits:** a far world border, and "you can only read chunks
  near you" (stops crawling the world through the API). Holds no longer buy walking distance.
- **Split the generator version** so lasting landform has its own version. Today
  `Epoch.landform()` hashes `GeneratorVersion`, so any bump would move every river and ridge.
  Must happen before the freeze.
- **Biomes as an extensible layer:** a few lasting world-wide fields (wetness, height or upland,
  maybe warmth), biome regions about 32 chunks across, a content entry per biome plus one small Go
  piece behind one interface. A region is **pinned** to `biome@version` the first time land in or
  near it is served; a biome added later only goes into unpinned regions, so seen land never
  changes. Old biome versions keep their code.
- **First biomes:** today's woods and meadow (as a biome, unchanged near home), **lake country**,
  then uplands with mountains ("the Tops").
- **Lakes are lasting features** with an id, a shore you can walk, reeds and clay. Fisheries key
  by lasting lake id, not weekly per chunk (changes `fishing.md`). Fishing and the kiln can come
  later; the generator makes the lake ids now.
- **Height:** one walkable surface with a level per tile (0–3), cliffs between levels, trails and
  ramps the only way up; **caves are layer −1 at the same x/y**, so a cave under a mountain really
  is under it. Every position stays `(layer, x, y)`, so presence, lamps, holds and paths barely
  change. Fights and creatures only meet on the same level or along a ramp. Drawn height is the
  fallback if the spike shows real levels don't read well.
- **Caves:** sparse lasting features (2–8 chunks), halls joined by tunnels to 1–3 mouths, some
  passing under a range. Shape lasts; creatures and forage turn. A tunnel's length gives time to
  load the cave, so there's never a loading door.
- **Map:** a window round the player, plus a lasting record of land you've explored; bearing home.
- **Ways home:** keep the turncap and the lamp-ash pouch; no new teleport.
- **A world lab first:** a Go tool that renders a big region from a seed in seconds, at three
  zooms, with overlays, side-by-side versions and a diff, PNG output agents can read, and a
  dev-only "go here" link into the game.
- **Art asks:** a cliff autotile set (the big one), ramps and trail tops, cave mouths, reeds and a
  willow, a few cave props. Everything else procedural or recoloured.

## Where they differ

| Question | Opus | Sol | My recommendation |
|---|---|---|---|
| Border | ±4,096 chunks (~4 h walk to the edge); no float worries below that | ±65,536 chunks, which needs the client to re-centre its coordinates as you walk | **±4,096 now**, in content so it can only widen; re-centring later if we ever widen a lot |
| Tiers past 3 | Bands up to tier 6 with stronger and recoloured enemies | Stay at 3 for 0.14; danger by place later, not by distance | Owner's call (Q3) |
| Storing chunks | Regenerate every unheld chunk on read | Staged: today's generator matches held neighbours' edges, so regenerating isn't always identical; prove it first | **Sol's staged way** (a real correctness catch) |
| Map memory | Explored bitmap per player | Keep lasting terrain knowledge across turnings, mark detail as stale | Both: the same idea |
| First slice | "Walk any way", lake country second | Walk any way **and** find a flat lake country | **Opus's order**: the world lab and the open world first, lakes right after |
| Ground encoding | One byte per tile now, before the freeze | Per-chunk palettes, widen later | Technical; settle in the build lane |
| Whitequiet lore | A: it **breathes out** (the relit road pushes it back to the far rim, a story beat) | A: it's a **condition of unkept land** you can cross; the far boundary is separate | Owner's call (Q1) |

## Proposed iterations (each playable on dev, with an alpha tag and a short playtest)

1. **Walk any way.** No reach or south limit; the south becomes land; the far border; reads near
   the player only; map as a window with explored memory and bearing home; storage staged; world lab
   v0 (atlas and region PNGs); split the landform version.
2. **Lake country.** Fields, biome regions and pins; today's land as `hearthwick-woods`; lake
   country with lasting lakes, shores, reeds, clay and willow; soft borders; world lab live page.
3. **The Tops.** Surface levels from the spike, cliffs, trails, the odd pass across a range, fog
   below, level-aware creatures and fights.
4. **Below.** Layer −1 caves, mouths, halls, fade to black, caves under ranges.
5. **Far roads and tuning.** Roads and rivers per region, rumours near your lamps; tuning rounds
   in the world lab; then release.

3 and 4 can swap if the spike finds caves easier than cliffs.

## For the owner

1. **The Whitequiet.** Opus A (breathes out to the rim, a story beat in 0.14), Sol A (a crossable
   condition of unkept land, its northern place stays), or Opus C (pale weather pockets that turn
   each wick and gather trinkets). They combine with "unexplored land is white on your map".
2. **Border distance.** ±4,096 chunks (recommended), ±1,024 (smaller, feels fuller), or bigger.
3. **Tiers past 3.** Stronger and recoloured enemies further out in 0.14, or stay at 3 until a
   creatures release.
4. **Near home.** Keep the land round the Tangle as it is (recommended; playtesters know it), or
   let biomes reach it too.
5. **Height model** waits for the spike walk.
