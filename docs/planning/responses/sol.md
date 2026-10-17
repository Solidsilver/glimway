# Glimway: future direction — Sol

## 1. Summary

- Build a discoverable world that gradually carries the history of its players.
- Combine authored destinations with varied generated country and player-built settlements.
- Ship useful holds and richer woodland, then wilderness building, then a shared adventure.
- Keep Habitica as deliberate pacing; allow friends to share the means to play.
- Let abandoned wilderness sites lapse by default; leave clock and loss details open.

## 2. Vision

Six months from now, friends recognize their world by its places: the trail they cleared, the lakeside cabin they built, the ruined station they restored, and the dangerous crossing beyond it. Authored stories give those places older histories; player actions add newer ones. Someone comes to fish or make things, someone to explore or fight, and their activities meet in shared projects and expeditions. Generated country supplies scale, variety, and changing journeys between deliberately placed destinations. Expansion adds places worth visiting and tools for shaping them. This is the owner's workshop direction, still awaiting friends' feedback. Minecraft-like freedom can grow incrementally.

## 3. Next releases

Provisional themes, not dates. Split a release if its terrain work obscures its playable payoff.

1. **Paths worth keeping.** **Payoff:** friends improve country and see their work survive a turning. **Work:** holds, minimal lantern/refuelling, clear map boundaries, and existing trail clearing/laying retained on held ground. Add noticeably dense and open woodland using existing terrain vocabulary. Start with lot backland as the bounded application. Explain what survives when light fails. **Dependencies:** decide hold ownership, expiration, recovery, neighbour access, and the terrain stability contract. Defer the full Keeper curriculum, mage workings, and multiple biomes. Completion means two friends can build a route, tend it, and understand its fate across turnings.

2. **Somewhere of our own.** **Payoff:** establish a modest shared wilderness home; make one discovered place useful again. **Work:** wilderness hearth claims, minimum deed/membership rules, existing cottage/furnishing capabilities, and one authored ruin with a small restoration project and local lore. Freely chosen sites and authored restoration should use the same placement and persistence rules. **Dependencies:** release 1's lifecycle; settle core-hearth protection versus lapsing extensions. Free choice of location comes first; custom walls, roofs, and excavation can follow. Completion means friends recognize a place as theirs and want to revisit it.

3. **An expedition worth preparing for.** **Payoff:** discover a story together, defeat a memorable shared boss, and bring something meaningful home. **Work:** one authored destination, a short lore trail, one readable boss in the server simulation, and rewards such as a recipe, furnishing, tool capability, or keepsake. Reuse Dorrit's span/Chapter 2 where it fits; settle its crossing location once. **Dependencies:** shared boss eligibility/rewards, late-arrival behaviour, travel, and provisioning. Bosses need neither caves nor cross-chunk pursuit. A biome can frame this expedition if capacity permits; the full lake-country economy remains a separate release.

## 4. Answers

**1. Next releases:** above. Judge each by a shared evening it enables.

**2. Core loop and spine:** real-life progress → resources friends can pool → choose an expedition or project → explore, gather, craft, build, or fight → return with discoveries and visible changes. Land-keeping supports this loop. Collective discovery and transformation are the spine; maintenance earns its place by enabling them.

**3. Upkeep and loss:** the owner prefers reclamation by default and is considering server settings. Preserve that preference. Recommend visible stages, generous warning, anyone-can-tend cooperation, and buffered oil. The existing plan returns built things to home storage when extensions lapse; keep recoverability as the starting proposal. Remote hearth-core permanence remains undecided. Calendar time versus active-world time is unresolved too. Define active time carefully: one friend's long session could age everyone else's holdings. Test one policy before exposing a small coherent configuration.

**4. Wider or deeper:** expand through complete places. A lake becomes valuable through its shore, fishing, history, nearby danger, and a reason to build there. Biomes should eventually change play. First improve woodland variation; add lakes, mountains, regional animals, and later tunnelling incrementally. Place authored destinations throughout.

My terrain proposal is **lasting large geography with selectively turning details**: mountain ranges and major lakes remain recognizable; selected woodland, marsh routes, vegetation, and finds change. Biomes can have different turning characters. Holds preserve local details and player changes. Deliberately unstable regions could transform more radically. This changes today's rule; it is neither existing capability nor a settled workshop decision. Prototype adjacent held, fixed, and turning chunks over multiple wicks before adopting it. Existing access guarantees already preserve reachability; player-cut routes add convenience and history.

**5. Habitica:** slowing substantial play until real-world work gets done is intentional. Tune glim sinks around projects and expeditions, while leaving visiting and enjoying existing places accessible. Avoid renewable activities that mint enough glims to bypass that pacing. Existing mailed and direct gifts support shared funding. Recognize Habitica achievements through modest world expression later; defer another party-goal system. Keep the item boundary: exciting loot must occupy Glimway's own tool, material, recipe, and keepsake space.

**6. Together:** friends should accomplish interesting shared projects without requiring fixed professions. Builders improve routes and bases; makers provide goods; explorers find destinations; fighters tackle encounters. Gifts, existing shelves, and cooperative contributions connect them, including asynchronously. Try one joint restoration and one boss before adding trading infrastructure. Avoid mandatory headcounts, equal contributions, or a specific Habitica class. Optional activities should also satisfy solo players.

**7. Standalone:** plausible later, as a server mode with its own accounts and progression economy. The owner wants long sessions without external time gates. That requires deliberate sources, sinks, and pacing. A downloadable self-hosting binary is a separate distribution project and could ship for Habitica servers first. Keep the browser client; defer native clients and rewrites.

**8. Stop or cut:** stop making the entire lamp suite prerequisite to story, bosses, or settlements. Defer the Old ways, broad magic expansion, caves, native clients, and simultaneous profession trees. Avoid speculative scaling and a blanket refactor programme. Supersede stale release tables and conflicting permanence rules in a later implementation brief. This response changes none of those files.

**9. Process:** owner attention limits validated change. Give each release one primary player promise and a short acceptance session. Parallel work can supply content and bounded implementation against decided contracts; integration should converge on one playable slice. Require concise evidence and unresolved decisions. Address relevant flakes and phone hitches alongside affected features. Before persistent construction, schedule backup/restore verification and explicit save handling. Preserve actual builds through generator upgrades; introduce terrain in new areas or deliberately turning land. Ask friends what they actually chose to do, where they stopped, and what they wanted next. Keep later releases provisional until that evidence arrives.

## 5. Disagreements

Keep the standing Habitica, authority, multiplayer, seamless-world, and scaling decisions. Change the roadmap's emphasis from completing Lamps to delivering exploration, construction, and authored adventures through thin slices. Bring a boss forward from the caves backlog. Propose revisiting open-map decision 18, which reshuffles major geography every wick: recognizable terrain strengthens navigation, settlement choice, and world history. Friends now have things to value; cheap compatibility breaks should no longer imply casually erasing their work.

## 6. Risks

Breadth could produce shallow activities. Shared funding could pressure one person to bankroll everyone or maintain their holdings. Loss may feel alive to the owner and discouraging to friends. Stable geography could reduce novelty; changing geography could undermine attachment. Authored stories need coherent discovery for newcomers after projects complete. Generation changes and reclamation can damage saves or performance. Building and terrain scope need firm limits.

## 7. Questions for the owner

1. What do friends actually choose to do, and how much play should a typical week's Habitica progress fund?
2. Which reclamation clock and recovery policy should the first version test? Should wilderness hearth cores remain permanent?
3. Would lasting major geography preserve enough of the turning's interest, and which biome should first add different play?
4. Should completed story projects remain immediately available to newcomers, with the story retold, or use another participation mechanism?

## 8. Sources

The owner's workshop answers are primary for preferences; friends' preferences remain unknown. Repository references: `docs/planning/direction-overview.md`; `docs/planning/brief-detail.md` (factual sections); `CHANGELOG.md`; `docs/habitica-boundary.md`; `docs/design/{location-seam,open-map,hearthwick-2,world,lamps,quests,crafts,shared-fights}.md`; `docs/standalone-clients.md`; `docs/reviews/2026-10-13-step-back.md`. Implementation checks: `server/internal/{wilds/world_v3.go,wilds/gen_v3.go,chunks/source.go,api/mail.go}` and gifting/currency references under `src/lib` and `server/internal/store`.
