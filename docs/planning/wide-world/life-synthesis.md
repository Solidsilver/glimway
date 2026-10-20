# Life in the wide world: where the two answers agree, and what the owner decides

*2026-10-20. From [life-claude.md](responses/life-claude.md) (Opus) and
[life-sol.md](responses/life-sol.md) (Sol), both answering [life-brief.md](life-brief.md).*

## They agree on

- **Today is far too busy.** `content/wilds.json` asks for 1–2 camps per chunk, plus camp glades
  from place cells; nearly all of it is tier 3. A walker passes a camp every few seconds.
- **A quick fix first:** camps per chunk from 1–2 to 0–1 (content only), keeping the tutorial's
  and quests' fights. A cheap playtest, not the finished algorithm.
- **Danger is a field, not a biome.** A lasting, smooth **pressure** field (how hard the Dark
  leans on the land, features tens of chunks across) crosses biome borders: the owner's
  "meta-biome". Add remoteness and a small per-biome bias, then subtract light.
- **Light calms land, the strongest source only** (never the sum, so a row of lamps isn't a
  fortress). Lamps lower danger live, when a fight room wakes; the generator stays pure.
- **Fewer, better encounters,** counted per cell instead of per chunk, spaced apart (Sol: at least
  36 tiles), with the quiet between filled by animals, tracks and signs rather than more icons.
  A lab "walk rhythm" probe measures seconds between encounters on straight walks; tune to targets.
- **Three kinds of life:** ordinary animals (harmless, they reveal things: forage, a ramp, a
  route); **unmoored beasts** (fevered animals, canon §5.4; beaten, the fever breaks and they flee
  instead of dying); and **things of the Dark**. Beetles become unmoored beasts, wisps things of
  the Dark (a lore call).
- **A creature catalogue in content,** keyed by a string id instead of the wire's closed enemy
  enum, with a few built-in behaviours (flee, hop, scuttle) and a small Go piece only for a truly
  new attack. A biome lists its roster; it can't add encounters beyond the budget.
- **The Whitequiet is quiet:** a memory biome where Echoes matter on their own.
- **No real-time night danger** in 0.14.
- **Art:** 3–4 new animal silhouettes; enemies as recoloured variants of beetles and wisps.

## Where they differ

| Question | Opus | Sol | My recommendation |
|---|---|---|---|
| What "far" means | Distance from home in log bands, danger 0–5, so far land keeps getting harder (with stronger "deep" variants) | Distance from **tended** places (town, held camps, lamps), relief saturating; tiers stay 1–3, danger changes what you meet, not stats | Owner's call (Q1) |
| Clearing | Camps respawn after 20 min (now 10) | Cleared until the turning, plus a few repeatable practice sites | Owner's call (Q2) |
| Whitequiet fights | None | Half the usual | Owner's call (Q3) |
| Where animals run | On the client from a shared clock (the server simulates nothing) | In the server's fight rooms, up to 3 per chunk | **Opus's way** while animals are harmless; move to the server when they carry rules |
| First new animals | Wolf, deer, duck, goat | Hare, shorebird, goat | Pick with the art pass |

## When it lands

- **Now:** the 0–1 camp fix, in a small lane.
- **Iteration 1 (walk any way):** pressure and remoteness as world lab overlays.
- **Iteration 2 (lake country):** the creature catalogue, per-cell budgets, signs, first animals,
  beetle and wisp variants.
- **Iteration 3 (the Tops):** level-aware creatures and fights, goats.
- **Iteration 4 (below):** cave life.
- **Iteration 5:** the Whitequiet's life, danger on the map, the lamp reaction, tuning walks.
- **Later, a creatures release:** herds that roam, bats, predators, taming, mounts, day and night.

## Owner's answers (2026-10-20)

1. **Far danger: a mix.** Danger rises with distance from people (town, held camps, lit lamps),
   and also climbs slowly with distance from home in wide bands, so the far reaches bite harder.
   A far camp makes its area safer, but the deep wilds stay deep.
2. **Clearing lasts until the turning.** A beaten territory stays quiet for the rest of the wick;
   a few marked practice sites refill quickly for anyone who wants a fight.
3. **The Whitequiet has no fights.** Its danger is getting unmoored and lost.
4. **Lore: beetles are unmoored beasts** (beaten, the fever breaks and they flee) **and wisps are
   things of the Dark** (they disperse). The owner writes the canon words.
5. Animals run on the client from a shared clock while they're harmless (orchestrator's pick).
