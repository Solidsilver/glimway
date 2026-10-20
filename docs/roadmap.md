# Roadmap

*Settled 2026-10-17, at dev `fe0aab12` (0.11.2); reordered 2026-10-20 after 0.13.0 (the wide world
comes first, everything after it moves down one).* This is the one place the release order lives.
`CHANGELOG.md` records what shipped; the design docs under `design/` hold the details each
release builds from. When this doc and a design doc disagree about order or scope, this doc wins.

How it was made: the owner planned with four agents in parallel (Claude, Sol, MiMo and Gemini) from
one brief, then worked the differences through with the last of them. The brief, every answer and
the owner's decisions are in [planning/](planning/direction-overview.md). The merged plan is
[planning/responses/gemini.md](planning/responses/gemini.md).

## What Glimway is for

Two gears, one world:

- **Two minutes on a Tuesday.** Tend your light, walk the road, check your stall. Real-life
  effort on Habitica turns into glims, and the world shows what you did with them.
- **An evening at the weekend.** Explorers and fighters bring materials back from the turning
  Wilds and from delves; makers and fishers refine them at stations; builders and traders turn them
  into homes, hamlets and market goods, which supply the next outing.

Land-keeping (holds, lamps, oil) is the engine that makes marks persist. It isn't the promise.

## Rules every release keeps

1. **One player-facing promise per release**, with a short owner playtest as the acceptance.
2. **Backbone before content.** 0.12–0.15 build the engine (0.14 the shape of the world); story and
   new places follow.
3. **World impermanence, never item loss.** Land can return to the Wilds; nothing a player placed
   or made is ever destroyed. Lapsed claims pack into a recovery crate at Pell's office.
4. **Upkeep is judged once a week, at the turning.** No ticking clock, calendar or active-time.
5. **Fun with zero XP.** Visiting friends, arranging your home and walking common trails are
   always free. Habitica paces the big spends and is reflected modestly, never graded.
6. **Habitica stays behind its seam.** Review rule from now on: no new Habitica call outside the
   `habitica` packages. A standalone edition (one world, two editions: economy, hero and art
   swapped) waits until the 0.14–0.17 loops are proven.
7. **Clean breaks end at the 0.15 contract freeze.** Until then migrations stay cheap. After it,
   persistent world schemas, chunk keys and the generator version are frozen: a player's
   creations and the shape of the land survive upgrades.
8. **Felt debt rides inside feature releases.** Backups, flaky tests and performance hitches ship
   with the feature they'd otherwise block; they don't get a release of their own.
9. **A docs lane runs one release ahead.** The design doc a release needs is rewritten during
   the release before it.
10. **The step-back review returns** after every release (0.10 and 0.11 were missed).

## Land: the three tiers

Decided 2026-10-17; the full design is the `lamps.md` rewrite (docs lane during 0.12).

| Tier | What it is | What keeps it | At the turning |
|---|---|---|---|
| **Wild** | Generated land nobody is keeping | Nothing | Living detail turns: trees, forage, creatures, unheld paths |
| **Common** | Laid paths and communal way-lamps | Presence: any single visit during the wick | Kept if visited; otherwise turns |
| **Built** | Claimed land: lot backland, way-lamp camps, and the land around a Wilds hearth (its core plot is permanent; see 0.14) | Oil from Wick Tree sap, in a 2–3 wick store; anyone may tend | Kept while lit; a full wick of dimming warning; on lapse the land turns and every placed item packs into the crate at Pell's |

**Lasting geography** (overturns open-map decision 18): lakes, rivers and ridges keep their
shape across turnings. Only the living detail reshuffles. In the generator, the landform passes
hash the world seed without the season; chunk detail keeps the seasoned hash.

## Releases

### 0.12 Holds and lot lanterns (backbone 1)

**Promise:** light your lot lantern and the woods behind your Hearthwick lot hold still through
the turning, and your yard grows into them.

- The holds engine: a chunk pinned to a saved wick epoch, served by the `held` source
  (`design/location-seam.md` §0 #2, #8).
- Lot lanterns and backland, fed with Wick Tree sap oil (`design/hearthwick-2.md` §6).
- Lasting geography: the macro landform seed split from the weekly seed.
- Rides along: automated SQLite backups with a restore check, before anything persistent lands;
  the two flaky E2E tests; the arrival long frame.
- Docs lane: the `lamps.md` rewrite, which gates 0.13.

### 0.13 Dimming lamps and desire paths (backbone 2)

**Promise:** the roads you and your friends walk stay open, and you can set out and name
way-lamps in the Wilds, with the map showing what is held, common and turning.

- Common land: paths and communal way-lamps kept by presence.
- Built land away from the lots: way-lamps and camps, the oil store, dimming warnings, communal
  tending, zero-loss lapse into Pell's crate.
- The Keeper's hand and naming from parts (`design/lamps.md`, rewritten).
- The map shows the three tiers (`design/world-map.md`).

### 0.14 The wide world: endless Wilds, mountains and caves (agreed 2026-10-20)

**Promise:** walk as far as you like in any direction, climb mountains and go down into caves,
all without a loading door.

Owner's calls (2026-10-20), made so the shape of the world is settled before the freeze:

- **Endless in every direction.** The Whitequiet's closing edge goes; a far world border (as in
  Minecraft) sits before the maths breaks down. What that means for canon §2.4 is part of the
  brainstorm.
- **Mountains to climb and caves to explore, seamless.** Real surface levels appeal; the must-have
  is climbing a mountain and walking into a cave or a large opening below ground with no
  transition. Looks to try: a cave fades everything around you to black; a mountain fades the land
  below to fog or sky. The height stays sparse (see [ideas.md](ideas.md)).
- **New biomes**, iterated on and refined over several rounds. An emptier world is fine for now:
  later content releases add points of interest and hand-made places.
- The owner wants to iterate on world generation itself, so a fast way to see what the generator
  makes is part of the work.

Scope and slicing come from a brainstorm and a height-and-caves spike
([planning/wide-world/](planning/wide-world/brief.md)).

### 0.15 Hearths, station chains and market stalls (backbone complete, contract freeze)

**Promise:** furnish and build your own cottage and garden from pieces you made, and sell them.

- Building tier 1 (arrange props and furniture) and tier 2 (compose from a kit of walls, roofs,
  windows, floors and garden pieces). Every kit piece is crafted: craft, then place.
- Station-chain crafting: gather, then mill or kiln, then bench, with recipes found as library
  papers. A short design spike comes first.
- Wilds hearths as an **additional charter**, not a moved deed (replaces hearth H3): two or more
  members co-sign on a world with more than one member; one signer suffices on a one-member
  world, and a charter stands if more members join later. **The core plot is permanent** (owner,
  2026-10-17): it never turns and needs no oil until the charter is given up. Only land the
  household extends beyond the core is Built land on oil.
- Two-way trading: resident buyers and async player stalls, with listing fees as a glim sink.
- Rides along: per-chunk gathering cost.
- **Contract freeze.** Clean breaks end here.

### 0.16 Chapter 2: Dorrit's span and the first expedition

**Promise:** rebuild the span together, follow the story, and beat the first shared boss.

- An authored drop-in site for the span, generalising Hearthwick's location hooks only where the
  work touches them.
- A communal drop-off project, async-friendly.
- One server-run boss with readable telegraphs. Failure costs time and a repair fee, never items.
- What waits at the span (canon §4.6): **Hesper**, the Keeper of the Weir Years, still at the
  Tangle crossing, bound into Orrin's iron brackets. The span itself fights; Hesper can be
  redeemed by unwinding her binding the way the Warden is settled, and the rebuilt span is
  Dorrit's: it steps with the hill. The stakes are Orrin's, Ada's and Mara's.
- The owner's lore pass is done ([`lore/canon.md`](lore/canon.md), 2026-10-19).

### 0.17 Lake country: kilns, reeds and wild waters

**Promise:** a complete new place: shores to fish, clay to fire, and shallow caves to explore.

*2026-10-20:* lake generation and the first caves may arrive with 0.14's biomes and caves; what
stays here (fishing, the kiln, delves) is settled after the 0.14 brainstorm.

- Lake country generation on the lasting landform; wild fishing (`design/fishing.md`); Aldo's kiln
  with pottery and building tiles (`design/world.md`).
- The first layer −1 pocket delves, using the existing `layer` in `WildsChunkKey`
  (`design/layers.md`). Bridges stay on layer 0; there is no layer above ground.

### After that

Drop-in outposts (Brackenwood, Ashwatch), more delves, more biomes, terrain and creatures on the
wide world (0.14), points of interest and hand-made places out in it, the Habitica mirror (streaks and
achievements shown in the world), a standalone edition, and the ideas in [ideas.md](ideas.md).

## Parked or cut (2026-10-17)

- **Cut:** building tier 3 (painting terrain, excavation); layers above ground (`layers.md`
  direction C); a sprawling underground (digging anywhere, caves everywhere; a few large places
  below ground reached by tunnels are in 0.14); hearth H3 (moving a deed into the Wilds).
- **Parked:** the Old ways (the level-30 capstone) and class-locked magic; Habitica party goals; the
  weekly wick report; baking (it returns later as a tactile craft, not a button); native clients
  (wrap the web client in Tauri and Capacitor when a standalone edition ships).
