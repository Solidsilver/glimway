# Glimway: future direction, planning overview

*2026-10-16, written at dev `fe0aab12` (0.11.2).*

## Why you're reading this

The owner is planning where Glimway goes next. They are asking several agents, from different
model families, to plan at the same time, then bringing the answers together. You are one of
them. Your plan matters most where it differs from the obvious one, so give your own view
instead of restating the roadmap below.

**Ground rules:**
- Read only. Don't edit the repo, run the game or run tests.
- Read whatever you need. Paths below are relative to the repo root, `~/code/fingersnap` (branch
  `dev`).
- Write your answer in the format at the end, to the path given there.

## What Glimway is

A cozy pixel RPG for [Habitica](https://habitica.com) players, played in the browser. Each
10 XP a player earns on Habitica becomes a **glim**, the in-game currency, so real-life habits
light the way. You walk the old lantern road, relight it, build a home, gather, craft, fish,
ride pets and fight camps with friends.

- **Stack:** Svelte 5, TypeScript and Phaser 3 for the client; a Go server with SQLite;
  protobuf for shared types. Deployed via a Nix flake or Docker, from GHCR images.
- **Audience:** small invite-only worlds that one person self-hosts for their friends. The
  owner runs one server, and friends have now played on it: their 10-15 playtest went "pretty
  much everything works wonderfully". The game is open source (AGPL), free, with no donations.
- **How it's built:** AI agents write all of the code, docs, lore and art. The owner directs,
  reviews and playtests. Work runs as parallel agent lanes in git worktrees: `exp/<feature>`
  merges to `dev`, then `main`. CI runs a full end-to-end suite (about 45 minutes) on every
  merge, and every release gets a review round. So development capacity is high, but the
  owner's attention (decisions, playtests, reviews) is the bottleneck.

A longer briefing, with a doc path for every claim, is in `docs/planning/brief-detail.md`. Its
last section is one agent's opinion, so form your own view first.

## Standing decisions and values

These are the owner's own calls. Challenge one only if you have a strong reason, and say so
explicitly.

1. **Habitica boundary** (`docs/habitica-boundary.md`): "Habitica is who you are; Glimway is
   what you do in the world." The game mirrors your Habitica look, class, gear, pets and gold,
   and never grants or duplicates Habitica items. Game items fill the gaps: tools and materials.
2. **The server owns the world.** Authored places are layout data in `content/`, served as
   fixed chunks. The client renders, predicts and interacts. There are no client-only systems.
3. **Priorities for multiplayer:** shared play first, clean architecture second, cheat-proofing
   last (only friends play).
4. **The seamless world** (`docs/design/location-seam.md` §0, `docs/design/seamless-world.md`):
   one continuous outdoors with a town in the middle of the generated Wilds. Indoors is always a
   transition. The Wilds "turn": generated land changes each week (a "wick"), unless it is held.
5. **Clean breaks over compatibility shims.** Players are few, so migrations stay cheap. This
   gets more costly now that friends have played.
6. **Art:** the game's own art is AI-generated for now. The owner prefers human-made art and
   welcomes artists.
7. **Keep Habitica logic behind a seam**, so a standalone (non-Habitica) server mode stays
   possible later (`docs/standalone-clients.md`). Standalone is parked, not planned.
8. **Scaling is parked:** measure first (`docs/scaling.md`).
9. **Ideas canvas:** new ideas go to `docs/ideas.md`, tagged agreed, maybe or later.

## What's shipped

See `CHANGELOG.md` for details.

- **0.1** (10-07): the lantern road quest, telegraphed combat, Habitica sign-in, glims from XP,
  invite worlds, homesteads, the shared Tangle (a generated woods), gathering and crafting, the
  calendar and festivals, phone controls.
- **0.2:** versioning, a "What's new" card, a reload prompt.
- **0.3/0.4:** the server owns the world, an offline outbox, sound, walk-in interiors with
  residents' hours, a Quests page.
- **0.5:** companion and yard pets, the stable and riding, level-20 second moves, fishing at
  the mill pond.
- **0.6/0.6.1:** the Habitica gold purse and wardrobe, shelves and gold in letters. Glims
  replace both embers and gold.
- **0.7:** Silas's Yard (a walk-in building shop) and Pell's deeds office.
- **0.8:** the open map. Seamless Wilds, a meadow, the river Wend with fords, the Lantern Road
  with dark lamp stones, weekly turning, the drift frontier, paths and named ways, landmarks,
  first finders.
- **0.9:** server-run camp fights shared between players, and a full-screen map.
- **0.10:** the Commons (homes) and the Tangle become one walk.
- **0.11:** Hearthwick, one seamless market town around the Wick Tree, with eight home lots.
  0.11.2 fixed missing stepping stones at river crossings.

## The roadmap as written (agreed, not built)

The order comes from `docs/design/location-seam.md` §0. Its first two steps, the join and the
one town, are done.

1. **Holds engine:** chunks that keep one wick across turnings. *No design doc yet.*
2. **Lot lanterns and backland:** a lit lantern, fed by Wick Tree sap oil, holds the land behind
   your lot (`docs/design/hearthwick-2.md` §6, §9).
3. **Dimming Lamps:** the Keeper's hand, way-lamps you set out in the Wilds, and naming lamps.
   Lamps need oil, and upkeep bounds how much land you hold (`docs/design/lamps.md`).
   **lamps.md is stale:** it's still titled 0.9, its owner questions Q1–11 are unanswered, and
   its "lit for good" rule was overturned by dimming.
4. **Hearths:** a home's hearth holds its plot, and a deed can later move out to a Wilds site.
   *Not designed.*
5. **Chapter 2 (Dorrit's span),** the next story chapter (`docs/design/quests.md`). The docs
   disagree on where its crossing sits.
6. **Lake country:** water, reeds and clay, a kiln and pottery, fishing in generated waters,
   magic workings (`docs/design/world.md`, `magic.md`, `fishing.md`).
7. **The Old ways** (a level-30 mage capstone) and the rest of Lamps.
8. **Caves and new lands** (`docs/design/layers.md`, `world.md`).
9. **Standalone, much later:** guest accounts as a server mode (`docs/design/guests.md`).

`docs/design/plan.md` holds the combined design plan. Its release table and several docs' release
numbers are out of date. Trust `CHANGELOG.md` for what shipped.

## Parked ideas (maybe or later)

- **Habitica tie-ins:** streaks and achievements shown in the world; party goals fed by Habitica
  tasks.
- **Story and world:**
  - chapters 3 and on;
  - more resident routines;
  - a second settlement, or somewhere for the west road to lead;
  - outposts in the Wilds (Brackenwood, Ashwatch);
  - the Tops (the uplands);
  - creatures that differ by land.
- **Fights:** enemies that cross chunk edges, and bosses.
- **Pets:** companions that sniff out things, a pet that leads you home, residents who notice
  pets.
- **Fishing:** home ponds, docks, ice fishing, a fish journal.
- **Magic:** more workings at levels 15, 30 and 50, and two-player naming.
- **Social:**
  - a party board;
  - who's online and where they are;
  - gifts for the party;
  - a market stall.
- **UI:** a desktop minimap, map pins, party marks on the map.
- **Platform:**
  - error reporting, metrics and DB backups (tagged agreed, never scheduled);
  - native clients (`docs/standalone-clients.md`).

## Open questions in the docs

- **Lamps:** Q1–11, plus the oil burn rate, the oil store, and how much land upkeep allows.
- **Dimming:** do things built in lamplight last for good?
- **Housing:**
  - plot size;
  - growth past eight homes;
  - claims out in the Wilds, and what happens when a deed lapses.
- **The next settlement:** what the west road leads to.
- **Standalone economy:** how players earn glims without Habitica.
- **Lake country:** kiln timing, and how difficulty and lamp cost grow with distance.

## Known debt

- **Flaky tests:** two flaky E2E tests, plus frame-budget flakes; the full E2E job takes about 45
  minutes.
- **Refactor plan** (`docs/reviews/2026-10-13-refactor-plan.md`): stages 7–14 aren't done.
  - **Duplicated rules:** prediction rules still live in both Go and TS.
- **Performance:**
  - a roughly 680 ms long frame on arrival;
  - per-chunk gathering costs;
  - a slow scene build on phones.
- **Trust gaps:** these are accepted under value 3.
  - story flags are client-writable;
  - there are no wall checks on movement;
  - hurt is judged on the player's screen.
- **Stale docs:** `docs/build-status.md`, `lamps.md`, `plan.md`'s table.

## Questions to answer

Answer the ones you have a real view on, and add any the owner should be asking.

1. **What should the next three or so releases be?** Give each a theme, the player-facing payoff
   and the rough scope.
2. **What is the core loop, and is the game's spine right?** The written plan makes land-keeping
   (holds, lamps, upkeep) the spine. Is that the best one for a cozy Habitica companion played by
   small friend groups? If not, what is?
3. **How much upkeep pressure or loss belongs in a cozy game?** For example, dimming lamps and
   land that lapses.
4. **Wider or deeper?** That is, new lands, lake country and caves, or a richer town and
   residents, story and social play.
5. **How should the game use Habitica?** Beyond the glims-from-XP link: party goals, streaks,
   quests. What would make Habitica players *want* to come back to Glimway?
6. **Playing together:** what should friends do together that they can't do alone?
7. **Standalone:** should the game ever stand without Habitica, and if so when? What would it
   need?
8. **What should stop or be cut?** Name systems, docs or plans that aren't paying their way.
9. **Process:** given an agent-built game with an owner-attention bottleneck, how should releases
   be sized and sequenced?

## Answer format

Write your answer to `docs/planning/responses/<your-model-or-agent-name>.md`. If you can't write
files, reply in chat in the same format. Keep it to about 1,500 words or less, with these
sections, so the answers can be merged side by side:

1. **Summary:** your recommendation in five lines.
2. **Vision:** one paragraph on what Glimway should feel like in six months.
3. **Next releases:** a numbered list. Each entry gets a theme, the player payoff, the main work
   and the dependencies.
4. **Answers:** to the questions above, numbered to match. Skip any you have no view on.
5. **Disagreements:** where you'd change a standing decision or the written roadmap, and why.
6. **Risks:** what could go wrong with your plan.
7. **Questions for the owner:** the decisions only they can make. Put the most important first.
8. **Sources:** the files you relied on.
