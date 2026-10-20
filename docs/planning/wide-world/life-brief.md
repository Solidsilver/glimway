# Life in the wide world: brainstorm brief (danger, creatures, spawning)

*2026-10-20, part of 0.14 "the wide world".*

## Why you're reading this

0.14 opens the Wilds in every direction, with new biomes (lake country, uplands with mountains and
caves, and the Whitequiet as a biome of its own). Read [brief.md](brief.md) and
[synthesis.md](synthesis.md) first: they hold the agreed shape (biome regions pinned the first
time anyone comes near, an extension seam of content plus a small Go piece per biome, surface
levels 0–3 and caves on layer −1, world lab, a ±4,096-chunk border).

This brief is about **what lives in that world, and how dangerous it is.** The owner's words
(2026-10-20):

> I like the idea that evil gets worse farther out, and there's more danger farther away from
> people. But it might be nice to have danger vary with different biomes, or be its own
> meta-biome almost. Right now honestly there are too many camps and creatures. It might be worth
> coming up with different creatures (good and bad) for each biome, and a new algorithm for how
> they spawn.

Several agents answer at once; give your own view where it differs from the obvious one.

**Ground rules:** read only (quick Go or unit test runs to check a fact are fine, via
`nix develop -c`); don't run the game or E2E; write to the path at the end; don't commit.

## What exists today

- **Placement:** `server/internal/wilds/gen_v3.go` (entities and camps per chunk), `cells.go`
  (places in 3-chunk place cells), `detail_v3.go` (clearings round camps), `loot.go`. Tiers rise
  with distance and cap at 3 (`content/wilds.json` `tiers`).
- **Creatures and fights:** `content/enemies.json`, `content/combat.json`, server-run fights in
  `server/internal/fights/` and `server/internal/api/presence_fights.go`; design in
  `docs/design/shared-fights.md`. Today's enemies: wisps, beetles, the Warden, and camps of them.
- **Animals:** pets come from Habitica; there are no ordinary wild animals in the Wilds yet.
- **Lore:** `docs/lore/canon.md` §5.4 (the fallen and the unmoored: beasts the Dark has fevered
  keep their animal nature and flee when the fever breaks), §2.5 (the Dark: it hates light and
  people, presses where light is thin), §2.4 (the Whitequiet, now becoming a biome). The idea
  entry "An animal overhaul" in `docs/ideas.md`.
- **Land tiers:** Wild / Common / Built (`docs/design/lamps.md`): lamps, camps, holds and the town
  are "people".
- **Rules that stand:** never item loss; fun with zero XP; upkeep judged once a week at the turning;
  fights are server-run with readable telegraphs (`docs/roadmap.md`).

## What to answer

Be concrete: data shapes, numbers to start tuning from, files. Mark how sure you are.

1. **Danger as a field.** How danger is decided at a place: distance from people (town, lamps,
   holds, camps), biome, a separate "meta-biome" danger layer (for example a lasting field of how
   strongly the Dark presses there), or a mix. Which parts are lasting geography and which turn each
   wick. Whether lighting a lamp lowers danger nearby, and how much. What the player can read about
   danger before walking into it (on the land, on the map).
2. **Fewer, better encounters.** Today there are too many camps and creatures. Propose densities
   (per chunk or per region) and what fills the space instead, so a walk has rhythm: quiet
   stretches, signs of life, then something worth a fight.
3. **Creatures per biome, good and bad.** A roster shape in content that each biome fills in:
   ordinary animals (harmless, skittish, useful: tracks, forage, mounts later?), unmoored beasts
   (fevered animals, canon §5.4), and things of the Dark. Suggest a first roster for woods, lake
   country, uplands and caves, and the Whitequiet, as examples, but keep it short: the seam
   matters more than the list. Say what each one does differently in play, not just how it looks.
4. **The spawning algorithm.** How creatures are placed and move: herds and territories, day and
   night, by danger and biome, around water and trails, in caves. What is generated per chunk
   versus per region, what turns each wick, and what the server simulates live. Keep it within
   server-run fights and the chunk window (only near players).
5. **Fit with the extension seam.** A future biome should bring its creatures as content plus at
   most a small behaviour piece. A future creature should not need a new fight system.
6. **Art.** Our art model's time is scarce. Say which creatures can be recolours or variants and
   which need new sprites, and the smallest roster that still makes biomes feel different.
7. **Slicing.** What lands in 0.14 (with which iteration of [synthesis.md](synthesis.md)'s five),
   and what waits for a later creatures release. A quick density fix for today may come first.
8. **Open questions for the owner**, each as a choice with your recommendation.

## Your answer

Write it to `docs/planning/wide-world/responses/life-<your-name>.md` in your worktree. Plain
language, short sentences, headings per question. Aim for 250–450 lines.
