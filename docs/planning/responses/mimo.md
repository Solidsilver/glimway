# Glimway future direction — mimo

*2026-10-16, against dev `fe0aab12` (0.11.2). Produced in a workshop with the owner; where the
owner made a call in that conversation, it is marked (owner).*

## 1. Summary

- The spine is **shared making**: a town and home that visibly accumulate. Land-keeping (holds,
  lamps) is the engine beneath it, not the promise. The written plan's claim that Lamps are the
  spine gets this backwards.
- The daily core is **tending light and trading** (owner); long sessions are building, delving
  and story; season scale is drop-in places and quests.
- **Backbone before content** (owner): holds → lamps → home & craft → delves before story
  chapters and new lands. The lore bible is the owner's own work and gates story releases.
- **Zero loss:** lapses return things to storage; sinks are natural (buying, building, repairing)
  (owner). Dimming is atmosphere and a bound on expansion, never punishment.
- Build tiers 1–2 (arrange, compose) ship in the backbone; tier 3 (painting terrain) is parked.
  Caves come as biomed delves, not sprawl. Party goals, hearth H3, the Old ways and native
  clients are off the plan.

## 2. Vision

Six months on, Glimway is the place your real-life effort accumulates. On a Tuesday you spend two
minutes: your lamps weathered the turning, and you sell the week's fish and pots at the stall. On
a free evening you put a roof on the back room, or go down into the reed caves with a friend, or
push a road out into the turning with way-lamps. The town is fuller because everyone plays solo:
paths someone laid, a span the masons raised at a turning, houses that look like their owners.
Habitica stays who you are — the glims and the mirror — and Glimway is the visible consequence.
Nothing you built is ever lost; the world just asks for light.

## 3. Next releases

1. **0.12 "Tend the light" — holds engine + lot lanterns + soft dimming.**
   *Theme:* the engine. *Payoff:* the woods behind your lot hold still because you keep a lantern
   burning; your yard grows into the backland and survives turnings.
   *Work:* the held chunk source and epoch carry-over (with the access rule from location-seam
   §0 #8); lot lanterns and backland from hearthwick-2 §6; oil from Wick Tree sap via the
   chandler; dimming numbers — full wick of warning, an oil store buffering 2–3 wick, anyone may
   tend, lapse returns pieces to home storage with a seed refund. **First work item: rewrite
   lamps.md** (it gates this release).
   *Depends on:* owner answers on oil burn, store size and how much land upkeep allows.

2. **0.13 "Hearth & craft" — the solo signature.**
   *Theme:* home, making and trade. *Payoff:* my house, my wares — a layout and look of your own,
   things you made that others buy.
   *Work:* building tiers 1–2 (arrange furniture and props; compose from a curated kit — walls,
   roofs, windows, floors, garden pieces — on your lot and hearth plot, always permanent);
   crafting as station/process chains (gather → mill, kiln, bench → make) with recipes discovered
   as library papers; craft→place, so every kit piece is a made thing; trading both kinds
   (owner) — resident buyers and player stalls / a market day; the felt debt folded in (the ~680 ms
   arrival frame, per-chunk gathering costs, the slow phone scene build, the two flaky E2E tests).
   *Depends on:* a short design spike on the crafting model (before any lane starts).

3. **0.14 "Under the hill" — caves with biomes.**
   *Theme:* the long-session outing. *Payoff:* a place worth a whole evening, alone or with
   friends. *Work:* the layer beneath the turning, biomed to match the lands above (reed-and-clay
   caves under lake country, echo-dark under the Wilds); shallow depths are deep-and-cozy — light
   management, lore finds, telegraphed fights — while specific pockets are opt-in dangerous;
   failure costs the delve and time, never items. *Depends on:* lamps' light rules from 0.12;
   a few canon entries from the lore bible (owner, their own time).

4. **0.15 "Lights along the road" — the backbone closes.**
   *Theme:* outward light and the Habitica mirror. *Payoff:* the party can hold a road; your real-
   life week is reflected in the world. *Work:* way-lamps and the Keeper's hand (dimming slice 2),
   the backland-style holds outward; the Habitica mirror (streaks and achievements shown in the
   world) and the weekly wick report; refactor stages 7–14's remaining slices and the missed
   review rounds for 0.10–0.11. *Depends on:* 0.12's holds; owner sign-off on the mirror surface.

**After the backbone:** story and drop-in places — chapter 2 (Dorrit's span), outposts like
Brackenwood — land as content releases gated on the lore bible, which the owner leads. Lake
country reframes as a *crafting expansion* (clay → pottery → more kit pieces), arriving when
crafting has players.

## 4. Answers

**1. Next releases:** see above — four releases: engine, solo signature, delve, outward light.

**2. Core loop and spine.** The loop: Habitica XP → glims → light, trade, build → a visibly fuller
world → wanting to see it again. The written plan makes land-keeping the spine; for a cozy Habitica
companion played async by small friend groups, that turns the game into a second obligation beside
Habitica. The spine is **shared making** — solo play leaves a visible mark on shared ground — with
holds and lamps as the engine that makes marks persist. Lamps matter more this way, not less.

**3. Upkeep pressure.** Near zero and never lossy. Upkeep is a *light* problem: warning for a full
wick, oil stores buffering 2–3 wick, neighbours may tend anyone's lamps, lapse returns pieces to
storage (hearth plot and materials-built things last for good — keep world.md decision 10 under
dimming). Economic sinks are the natural kind the owner named — buying, building, repairing — not
failing to log in.

**4. Wider or deeper.** Deeper first: town, home, craft, residents; then *vertical* wide (caves).
"New land" is authored places dropped into the seamless frame (location-seam §0 #9's fixed
outposts), which suits quest content and async players. Lake country and a second settlement wait.

**5. Habitica.** Mirror plus the weekly wick report (owner: "ok, not super exciting"); party goals
go back to the maybe shelf. That is the right call: the return hook lives in the game (light and
trade daily), and Habitica remains the reason glims flow and the record of who you are. Keep every
future tie-in observational — celebrate, never grade.

**6. Playing together.** The group plays mostly async (owner), so multiplayer must not require
being online together: shared projects everyone contributes to (the span, a road, the kiln),
tending and refuelling each other's lamps and holds, trading through stalls and letters, turnings
as witnessed world changes, and delves and camp fights for the times schedules do align. Two-
player lamp naming stays a nice-to-have.

**7. Standalone.** Parked, but the door is wider than before: the spine we chose (build, craft,
delve, trade) works without Habitica. Keep paying the cheap enabler already agreed — our own
avatar, gear and pet backups, Habitica behind the seam — and nothing else until there is demand.

**8. Cut or stop.** Party goals as flagship (shelf); hearth H3 (deed moves to Wilds sites — eight
lots plus backland are enough); the level-30 Old ways and cave *sprawl* (replaced by biomed
delves); native clients; building tier 3 for now; the "second settlement" idea (drop-in places
answer it). Stop maintaining stale docs: delete plan.md's release table (CHANGELOG is the record)
and fix or fold `build-status.md`; every stale table costs owner attention in review.

**9. Process.** Backbone before content (owner). Size each release to one playtestable payoff and
one batch of owner decisions. A **docs lane runs one release ahead**: lamps.md rewrite gates 0.12,
the crafting spike gates 0.13. Felt debt rides inside feature releases instead of owning a slot,
but the step-back review ritual must return (0.10 and 0.11 have none). Keep clean breaks for now,
but freeze the contract when the backbone lands — after 0.14 the world is worth keeping.

## 5. Disagreements

- **"Lamps are the spine" (plan.md):** I'd reword it — lamps are the *engine*; the spine is shared
  making. Same build order within the land thread, different promise, and it changes what "done"
  means for each release.
- **Roadmap order:** chapter 2 (step 5) and lake country (step 6) move behind the backbone, and
  lake country comes back as a crafting expansion rather than a map expansion. Caves (step 8) move
  forward but as small biomed delves, not new lands.
- **The level-30 Old ways (step 7):** park it. Capstone content for a level no playtestee is near
  is the clearest misallocation on the list.
- **Hearths H3:** cut from the plan, not merely deferred.
- I accept the standing values as written. Value 5 (clean breaks) I keep only until the backbone
  lands; say so in the docs so the expiry is explicit.

## 6. Risks

- **Lamps scope creep:** lamps.md is 581 lines with 11 open questions. The rewrite gates 0.12 and
  0.12 ships only lot lanterns plus holds.
- **Kit art cost:** tier-2 building means every wall, roof and window is authored art. Volume, not
  difficulty, is the risk; bound the first kit and grow it with craft recipes.
- **Crafting spike may not converge:** "Minecraft-ish" is the default answer and may not suit the
  game. Timebox the spike; station/process chains plus paper recipes are the fallback.
- **Async play hides multiplayer debt:** shared projects and stalls may go untested if friends
  don't play. Each multiplayer feature needs a solo fallback anyway (that is the point).
- **Economy faucet:** glims from XP and gold top-ups can outrun natural sinks. Watch prices in the
  play world; cheap fixes (fees, repair costs) exist.
- **Lore bible slips:** 0.12–0.14 are deliberately lore-light so the backbone is unblocked. If
  content releases stall waiting on canon, that is by design, not an accident.

## 7. Questions for the owner

1. When do clean breaks actually stop — when the backbone lands (after 0.14), or when the friends
   next engage with the world, whichever comes first?
2. Confirm the danger rule for deep pockets: failure costs the delve and time, **never items** —
   or do you want genuine risk somewhere?
3. Should the Habitica mirror and wick report ride in 0.15, or wait with the first content
   release so the backbone stays pure systems?
4. Building tier 3 (painting terrain on kept land): parked as the "later" tier, as I've written
   it, or cut entirely?

## 8. Sources

`docs/planning/direction-overview.md`, `docs/planning/brief-detail.md`, `docs/design/location-seam.md`
(§0 owner decisions), `docs/design/lamps.md`, `docs/design/hearthwick-2.md` (§6, §9),
`docs/design/quests.md` (Chapter 2), `docs/design/seamless-world.md` (recommendation, housing),
`docs/design/plan.md`, `docs/design/world.md` (decision 10), `docs/design/layers.md`,
`docs/design/crafts.md`, `docs/ideas.md`, `docs/habitica-boundary.md`, `docs/standalone-clients.md`.
