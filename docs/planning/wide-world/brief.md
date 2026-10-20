# The wide world: brainstorm brief

*2026-10-20, written at dev after 0.13.0.*

## Why you're reading this

Glimway's next release (0.14) is **the wide world**: endless Wilds in every direction, new biomes,
mountains to climb and caves to explore, all seamless. The owner moved it ahead of building,
crafting chains, stalls and the contract freeze (now 0.15) so the shape of the world is settled
before it's frozen. They want to iterate on world generation over several rounds and enjoy it;
an emptier world is fine for now, because later content releases add points of interest and
hand-made places.

Several agents from different model families answer this brief at the same time. Your answer
matters most where it differs from the obvious one, so give your own view. A separate spike lane
is prototyping height and caves in the client at the same time (`exp/height-spike`); you don't
need to build anything.

**Ground rules:**
- Read only. Don't edit the repo, run the game or run E2E tests. Reading code and running quick
  Go or unit tests to check a fact is fine.
- Paths are relative to the repo root (branch `dev`).
- Write your answer to the path given at the end, in that format.

## What exists today

Read [`docs/roadmap.md`](../../roadmap.md) first (the 0.14 section has the owner's calls), then
whatever of these you need:

- **Generator (Go, server):** `server/internal/wilds/` (v3: `world_v3.go`, `gen_v3.go`,
  `base_v3.go`, `detail_v3.go`, `lands.go`, `cells.go`, `wend.go` the river, `road.go` the Lantern
  Road, `rumour.go`, `epoch_v3.go`, `fixed.go`, `hash.go`). Each chunk is a pure function of the
  world seed, the wick epoch and (cx, cy). Fixed point (`fp` 256, `noiseOne` 65536); `Hash` folds
  ints as int32. Chunks are 24×24 tiles. Land cells are 7 chunks; place cells 3. Tiers rise with
  distance and cap at 3. **Lasting geography:** landform passes hash the seed without the season;
  living detail uses the seasoned hash. There is no surface height today; "land kinds" are the
  only biome-like idea.
- **Rules and content:** `content/wilds.json` (the frontier block: `reach` 3, `southLimit` 7,
  `heldSlack` 3), `content/` generally.
- **Where land is served:** chunk composer fixed → held → generated (`docs/design/location-seam.md`
  §0), `server/internal/store/chunks.go` (chunks stored when first read), `server/internal/api/
  wilds.go`, `api/open_map.go` (walks the whole frontier rect). Chunk key:
  `WildsChunkKey { realm, layer, cx, cy }` in `proto/glimway/v1/wilds.proto`; `layer` exists but
  only layer 0 is used.
- **Client (Svelte 5, TypeScript, Phaser 3 arcade physics):** `src/game/wilds/` (`window.ts`,
  `window-plan.ts` the chunk window and walls, `terrain.ts`, `ground-*.ts`, `chunks.ts`,
  `coords.ts`), `src/game/WorldScene.ts`. Positions are pixels in a single world space.
- **Land tiers and lamps:** `docs/design/lamps.md` (Wild / Common / Built, holds, oil, the weekly
  turning, desire paths), `docs/design/world-map.md`.
- **Earlier thinking on caves and layers:** `docs/design/layers.md` (direction B, generated caves;
  direction C, stacked layers, was cut), `docs/design/open-map.md`, `docs/design/world.md`.
- **Lore:** `docs/lore/canon.md`, especially §2.4 the Whitequiet (the edge that only light pushes
  back) and §2.5 the Dark.
- **The idea entry:** `docs/ideas.md`, "More variety beyond the Tangle, in endless Wilds", with the
  owner's picture of sparse height.

## The owner's calls (2026-10-20)

1. **Endless in every direction.** Remove the edge, or put a far world border (as in Minecraft)
   before the maths breaks down.
2. **Mountains to climb, caves to explore, seamless.** Real surface levels "sound kinda fun", but
   the must-have is climbing a mountain and walking into a cave tunnel or a large opening below
   ground without a loading door. Visual ideas to weigh: a cave fades everything around you to
   black; a mountain fades the land below to fog or sky colour.
3. **Height is sparse.** No digging anywhere, no caves everywhere. A few tunnels from the surface
   open into large spaces below ground (maybe players build bases there someday). Mountains have
   trails up them, and sometimes a way across a whole range, but not everywhere. Some caves run
   under mountains.
4. **New biomes**, refined over several iterations. Emptiness is acceptable for now.
5. **Building, stalls and the freeze wait** until after this.

## What to answer

Be concrete: name files, numbers and data shapes where it helps. Mark each recommendation with how
sure you are.

1. **Endless.** What actually limits distance today (the int32 hash, fixed-point maths, float32 in
   WebGL and Phaser at large pixel coordinates, JS numbers, SQLite keys, the map)? Where should the
   world border sit, and what is it in the world? What replaces the frontier rule: is there any
   limit on generation besides the border? What happens to canon §2.4 (offer the owner two or
   three lore options; the owner decides lore). Storage: what is stored, what is regenerated, what
   is pruned. The open map as a window. Difficulty and tiers past 3. The road, river and rumours
   laid per region instead of once. Ways home on a long walk. Server and client costs per player
   walking far out.
2. **Biomes.** A macro layer above land kinds (climate-style fields or something else), on the
   lasting landform. How biomes meet. How later biomes can be added after the freeze without
   changing land players have seen (versioning by region or by generator version). Which two or
   three biomes to do first, and why.
3. **Height.** Compare at least: (a) drawn height (one walkable plane, mountains as masses with
   trails, caves as separate layers through entrances) and (b) real surface levels (a few discrete
   heights per tile, cliffs, ramps and trails, level-aware collision and draw order). For each:
   how it's stored in a chunk, how physics, draw order, presence, fights, creatures, lamps, holds,
   desire paths, building and the map handle it, and the seamless transitions (fades to black or
   fog). Then recommend. Remember caves under mountains and large underground spaces reached by
   tunnels.
4. **The chunk contract.** What a chunk key and payload become so that all of the above fits, and
   what of it gets frozen at 0.15.
5. **The iteration loop.** The owner wants to iterate on generation and have fun doing it. What
   tooling makes that fast (for example a world lab: render a large region from a seed in seconds,
   flip biomes and parameters, compare versions)? Existing pieces to build on (`glimpse.go`,
   `render_v3_test.go`).
6. **Art.** What new art each part needs. Our art model's time is scarce, so say what can be
   procedural or recoloured and what must be drawn.
7. **Slicing.** Split 0.14 into iterations the owner can playtest one after another, smallest
   playable first. Say what the first one is.
8. **Risks and open questions** for the owner, each as a choice with your recommendation.

## Your answer

Write it to `docs/planning/wide-world/responses/<your-name>.md` in your worktree (your name is in
your prompt). Plain language, short sentences, headings per question above. Aim for 300–600 lines.
Don't commit; the orchestrator collects it.
