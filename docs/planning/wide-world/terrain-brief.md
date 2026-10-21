# Brief: biomes and terrain (0.14, iteration 2)

*2026-10-21. Written for two independent design answers, Argon's and Sol's, into
`responses/terrain-<name>.md`. The owner then picks between them where they differ. This is a
**design** round: write the plan, don't build it.*

## What the owner wants

Start the real terrain generation and world planning. **Get the basic biomes generating and the
core of the terrain done, so the water system can go on top next.** After that the world fills
up: water, animals and the rest.

Owner's calls for this round (2026-10-21):
- **In scope: biomes and terrain.** Biome fields, regions and pins; the heightfield (levels,
  cliffs, ramps, trails up, the odd pass across a range).
- **Caves come straight after,** on top of the real terrain, carrying over what the height labs
  settled. Design the terrain so caves fit later (mouths in faces, layer −1 under ranges), but
  don't design the caves themselves here.
- **Water comes next round** (a flow map over the real terrain: rivers, streams, lakes, ponds,
  tarns). The terrain must leave it room: hollows and valleys water can fill, slopes a flow map
  can follow, and nothing that has to be undone when water arrives.
- **First biomes:** woods and meadow (today's land as the first biome), **the Tops** (uplands and
  mountains, where most of the height is), and **the Whitequiet** (pale, quiet land as a region;
  no special rules yet). Lake country waits for water.
- **See it first in the world lab** on glim-dev (dev panel → Open the world lab), to tune shapes
  fast; then walk it in the game on dev.

## Read first

1. `docs/planning/wide-world/land-rules.md`: the owner's 19 rules and build order. Rules 1–5 bind
   this round; rules 6–7 say what water will need; 8–17 shape the biomes.
2. `docs/planning/wide-world/synthesis.md`: what the first brainstorm agreed (region pins about 32
   chunks across, `biome@version`, levels 0–3 plus layer −1, a split landform version, staged
   storage) and the owner's answers.
3. `docs/planning/wide-world/cave-levels.md` and `height-lab-4-notes.md` (plus
   `height-lab-3-notes.md` for the unified lighting): what the lab proved about levels, cliffs,
   slopes, fog by level and light. The game should copy what it lists.
4. `docs/planning/wide-world/open-world-notes.md`, `open-world-fixes-notes.md`: iteration 1 as
   built (LandformV1, border ±4,096 chunks, reads near the player, migrations 039–040, held
   neighbours).
5. `responses/ideas-argon.md`, `responses/ideas-partner-argon.md`: ideas for the Tops and the
   Whitequiet (raw, not decisions). `life-synthesis.md` for what creatures will need from terrain.
6. The code: `server/internal/wilds/` (`lands.go`, `world_v3.go`, `gen_v3.go`, `base_v3.go`,
   `seams.go`, `chunk.go`, `proto.go`), the world lab (`server/internal/worldlab/`,
   `server/cmd/worldlab/`), the lab's client (`src/game/height-lab/`) and the game's Wilds client
   (`src/game/` scenes that draw Wilds chunks).

## Answer these

1. **Fields and regions.** Which lasting world fields (height or upland, wetness, warmth, …), at
   what scales; how biome regions come from them; how a region is pinned to `biome@version` and
   what "seen land never changes" costs; how biomes blend at edges (rule 10) without the round
   arcs the owner noticed (multiplicatively weighted cells in `lands.go`).
2. **The height model in the generator.** How levels per tile come from the fields; where cliffs,
   ramps and trails up go, and how the generator guarantees every walkable area is reachable
   (rule 2: held land stays reachable, nobody is stranded); chunk seams for height; the lab's
   built and rough slopes; how this leaves hollows and slopes for the water round.
3. **The three biomes.** For each: what the land is like, its height, what grows there and how
   it fits rules 8–17 at this stage. What changes near Hearthwick and the Tangle (the owner allows
   one change at 0.14; fixed places and held land stay).
4. **Wire and storage.** How height reaches the client (proto, chunk size and the generation
   budget: today 5 ms p95, 6 KiB per chunk), versions (`GeneratorVersion`, the landform version),
   migration for held and stored chunks.
5. **The client.** Moving the lab's levels, cliffs, slopes, fog by level and unified lighting
   into the real game; what is reused, what is rewritten, phone cost.
6. **The world lab.** What views and overlays this round needs (height, biome, region pins,
   reachability, a diff between versions) so the owner and agents can tune it.
7. **The build plan.** Lanes in order, each one playable or viewable, what each proves, rough
   size, what can run in parallel, and the riskiest part to do first.
8. **Risks and open questions for the owner,** each with your recommendation.

## Rules

- Design only: no code changes. Read the code as much as you need. Write one file,
  `docs/planning/wide-world/responses/terrain-<name>.md`, with file:line references where they
  help. Be concrete: numbers, data shapes, names.
- Commit it on your own branch and push only that branch; never push or merge `dev`/`main`.
- Finish with a short summary: your top recommendations and the questions for the owner.
