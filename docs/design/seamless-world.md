# Exploration: one seamless outdoor world

2026-10-11. Exploration, not an agreed release plan. Based on the code in this worktree and the shipped 0.8 design; no source changes, app use, benchmarks or e2e runs.

**Feasible, but a large project.** The Wilds already supply most of the streaming machinery. The harder work is giving the village, story woods, Commons and homes a physical layout, then replacing rules that currently use an area name as a boundary. Several roads out of a fixed village are quite practical. Making every home plot seamless is a separate, substantial design problem.

| Option | What the player feels | Rough work | Main risk |
|---|---|---|---|
| A. Remove fades between separate areas | Quicker handoffs at the same gates; still a camera/position jump | S for a cosmetic trial; M for preloading and reliable handoffs | Looks seamless until a friend or the camera crosses the join |
| B. Stream existing authored areas on one grid | Walk from the square through Commons and into woods; buildings and story places stay familiar | L, several lanes; homes add another L | Area-based rules and the current plot layout |
| C. Fixed village stamp in generated land | A permanent centre with roads into wilderness on several sides | B's foundations plus L for generation, edges and layout | Regenerating land must honour every fixed edge and road |
| D. Add a second settlement | A destination reached by an actual journey through the Wilds | M for a small authored outpost after B/C; L for a town; larger for procedural towns | Persistence, frontier access, content and the return journey |

S/M/L here mean lane size, not a delivery promise: S roughly 1–3 focused engineering days, M roughly 4–8, L roughly 2–4 weeks, including focused validation and review. Art and owner playtests add elapsed time. A credible complete B/C implementation with seamless plots is roughly **10–20 engineer-weeks**, potentially more if the housing layout or story structure changes. A village/Commons/Wilds version with plots still behind gates is smaller, roughly **5–10 engineer-weeks**, but is an intermediate result, not the whole outdoor world. These are judgement estimates from reading code, not a measured implementation schedule.

## What exists today

### Two ways of drawing outdoors

The curated outdoor places are Hearthwick (`village`, 42×26 tiles), Brackenwood (`woodland`, 56×30), the ruin (34×24), and the Commons (62 tiles wide, growing south as more gates are needed). They are deterministic authored builders: grids, scenery, NPCs, enemies, exits and a spawn point. They are not server-generated Wilds chunks. A registry also resolves home land and interior rooms. See [worlds.ts:175–241](../../src/game/worlds.ts#L175), [map dimensions:326](../../src/game/worlds.ts#L326), [woodland:542](../../src/game/worlds.ts#L542), [ruin:677](../../src/game/worlds.ts#L677), [registry:827–867](../../src/game/worlds.ts#L827), and [Commons dimensions:131–136](../../src/game/commons.ts#L131).

Homes are a third source of outdoor geometry: each `home:<gate>` is a separately served 40×30 land grid, generated from world ID and gate, with cleared tiles and placed furniture applied locally. Each has its own south gate and cottage door. Cottages are `in:home:<gate>`, 12×10 indoors. See [home content:44–85](../../content/homestead.json#L44), [land service:22–38](../../server/internal/api/land.go#L22), [home builder:149](../../src/game/homeland.ts#L149), [home exit:271](../../src/game/homeland.ts#L271), and [cottage exit:61](../../src/game/cottage.ts#L61).

The Wilds are one `WorldScene` with `area: 'wilds'`. Its base `WorldData` has empty grids and entities; the moving window supplies them. Chunks are 24×24 tiles, 384×384 world pixels. It normally attaches a 3×3, fetches a 5×5, and draws landmarks in the outer ring. It retains the old row until the hero is eight tiles past an edge to avoid rebuilding when you turn back. Crossing a chunk edge changes the window and presence room, not the scene. See [coords.ts:5–29](../../src/game/wilds/coords.ts#L5), [Wilds world:33–66](../../src/game/wilds/wilds-world.ts#L33), [window plan:10–42](../../src/game/wilds/window-plan.ts#L10), [edge slack:108–126](../../src/game/wilds/window-plan.ts#L108), and [window update:94–124](../../src/game/wilds/window.ts#L94).

### The joins are portals, not adjoining ground

The current route graph is:

```text
village ── woodland ── ruin
   │
commons ── Wilds (Tangle ── Whitequiet ── Beyond)
   ├── home:0 ── cottage
   ├── home:1 ── cottage
   └── more gates; Yard and its deeds room are interiors
```

Both village exits are on its east edge, at different heights. The Commons returns west to village, goes north to Wilds, and opens sideways through fences into homes. See [village exits:406–409](../../src/game/worlds.ts#L406), [woodland exits:617–620](../../src/game/worlds.ts#L617), and [Commons exits:405–410](../../src/game/commons.ts#L405). This graph is not a geographic map: widths, doorstep coordinates and gate directions do not yet imply compatible placement.

An `ExitDef` is a tile rectangle, destination area and arrival tile. `checkExits` detects the hero in that rectangle; `transitionTo` updates the save, loads needed land in darkness and restarts the scene after a default 240 ms fade. Removing that fade still restarts the scene and moves the hero. Indoors uses the same mechanism, with explicit facing on arrival. See [ExitDef:92–105](../../src/game/worlds.ts#L92), [exit handling:978–1031](../../src/game/scenes/WorldScene.ts#L978), [doors:1040–1048](../../src/game/scenes/WorldScene.ts#L1040), and [moveTo:1110–1140](../../src/game/scenes/WorldScene.ts#L1110).

The Commons/Wilds join is particularly explicit. The Commons north arch is near local x=23. The Wilds gate is on chunk (0,0)'s south edge, local tiles x=1..3, y=23; arrival is world tile (2,22). Return is Commons tile (23,2). The nominal Commons exit entry is overridden by the Wilds helpers. See [Commons arrivals:83–91](../../src/game/commons.ts#L83), [gate content:574–589](../../content/wilds.json#L574), [gate helpers:54–83](../../src/game/wilds/coords.ts#L54), and [handoff:1018–1028](../../src/game/scenes/WorldScene.ts#L1018).

### Origin, spawn and camera

North is negative y. The Tangle occupies chunks x=-1..1, y=-2..0; Whitequiet occupies x=-1..1, y=-5..-3. Cells are three chunks across, anchored at (-1,-2). The current frontier allows land within three chunks of the footprints but none south of chunk row 0. It is exactly a rectangle today because those two footprints are stacked. See [fixed footprints:551–603](../../content/wilds.json#L551), [frontier:1004–1007](../../content/wilds.json#L1004), [cell origin:1129–1133](../../content/wilds.json#L1129), and [frontier code:13–36](../../server/internal/frontier/frontier.go#L13).

This means the village is not currently at the physical centre of generated land: it is off-grid beyond the south boundary. A surrounding wilderness needs a changed frontier and a reserved southern footprint. It does **not** require renumbering the existing Tangle. Keeping its coordinates and placing authored ground south of it would preserve far more data than moving everything so the village is at numeric (0,0).

Curated spawns are local tiles; Wilds spawns and saved positions are world pixels. The scene samples position once a second and blocks samples during a transition so old coordinates cannot overwrite the destination. Unknown saved areas fall back to the Commons arch. See [spawn fields:197](../../src/game/worlds.ts#L197), [position sampling:737–775](../../src/game/scenes/WorldScene.ts#L737), and [arrival recovery:28–38](../../src/game/scenes/world-arrival.ts#L28).

The camera frames curated map bounds, with a soft fade at their edges. The Wilds camera uses signed world bounds and looks into the drift, without those map-edge fades. Indoors has its own closer zoom. A seamless centre needs the outdoor camera to follow the wider world bounds, not clamp at each old area boundary; door transitions can retain room framing. See [world-camera.ts:61–108](../../src/game/scenes/world-camera.ts#L61).

### Server state and who sees whom

The server accepts named curated areas, canonical home IDs, registered rooms and `wilds`. Player place is persisted as `area,x,y`, with a `place_set_version` that prevents an old movement report undoing a server relocation. See [area validation:56–60](../../server/internal/api/payload_validation.go#L56), [place persistence:169](../../server/internal/store/state.go#L169), and [report ordering:87–116](../../server/internal/api/report.go#L87).

Curated presence is one room per area. Village players see other village players, but cannot see someone just through an exit in Commons. Wilds presence is one joined room `wilds:<cx>:<cy>` per player, with visibility shared across the surrounding eight rooms. Positions are already world pixels, not chunk-local coordinates. World identity isolates groups. See [client room selection:142–181](../../src/lib/presence-client.ts#L142), [server visibility:22–70](../../server/internal/api/presence_socket.go#L22), [world-filtered roster:348–356](../../server/internal/api/presence.go#L348), and [scene room changes:778–796](../../src/game/scenes/WorldScene.ts#L778).

Visibility is not every interaction's eligibility. For example, the hub's `near` helper requires the exact same room, whereas Ward pulses use neighbouring visible rooms and radius. A seamless crossing must audit gifts, witnesses, petting and abilities as well as avatar drawing. See [presence.near:331–344](../../server/internal/api/presence.go#L331) and [wardPulse:350–362](../../server/internal/api/presence_abilities.go#L350).

The Go v3 generator makes immutable chunk geometry on first read; subsequent readers share the stored blob. A chunk's seed depends on epoch and coordinates; generated entity IDs contain chunk coordinates. Fixed footprints provide openings and story sites, but are not a general village/building/NPC stamp format. See [generator port:25–34](../../server/internal/wildsgen/wildsgen.go#L25), [generation:25–37](../../server/internal/wilds/gen_v3.go#L25), [fixed sites:74–80](../../server/internal/wilds/gen_v3.go#L74), [entity IDs:148–152](../../server/internal/wilds/gen_v3.go#L148), and [stored chunks:190–201](../../server/internal/store/chunks.go#L190).

Camp/node state belongs to `(epoch,entity)`, chest claims also to the account, discoveries to an epoch, and fallen lanterns to an epoch/world/owner. Curated story progress and homes use their own identities and tables. Shared changes already support both curated keys (area as realm, no chunk/epoch) and generated keys (realm/layer/chunk/epoch/entity). Unexpired rows are applied on reads. See [current schema:27–50](../../server/internal/store/migrations/034_open_map.sql#L27), [world-change keys and expiry:19–85](../../server/internal/worldchange/worldchange.go#L19), and [home state reads:44–96](../../server/internal/api/home_queries.go#L44).

### Wick turning, map and paths

The Tangle's `still` epoch does not turn. Whitequiet and the Beyond use a new `wick` epoch at each turning. Still chunks are created together; wick chunks are created lazily. Old wick cleanup cascades through their stored state. Adjacent new ground reads kept neighbours' edges, so the Tangle meets changing land consistently. See [epoch selection:105–112](../../server/internal/wilds/coords.go#L105), [epoch creation:104–169](../../server/internal/store/chunks.go#L104), [cleanup:174–187](../../server/internal/store/chunks.go#L174), and [kept edges:17–29](../../server/internal/wilds/gen_v3.go#L17).

Today a turning reloads the Wilds window in place; a player in changed solid ground steps to nearby open ground. They are not sent home. The latest Lamps amendment retains this rule and drops the older nearest-lamp relocation proposal. See [Turning:128–184](../../src/game/scenes/world-turning.ts#L128) and [lamps.md:211–224](lamps.md#L211). A future permanent centre must survive this reload even when changing land is visible beside it.

The current Map tab draws the Tangle plus chunks walked this wick, landmarks, discoverers, named ways and the hero only when in `wilds`. Walked/seen knowledge is device-local and keyed by wick. See [map-data.ts:24–77](../../src/game/wilds/map-data.ts#L24) and [walked.ts:1–18](../../src/game/wilds/walked.ts#L1). `docs/design/world-map.md` was absent when inspected; its concurrent design should be reconciled before choosing placement. This exploration neither supplies nor assumes its eventual layout.

Cleared and laid paths are shared chunk ground changes. Named ways recognize laid runs touching generated landmarks or footprint openings. The current code skips ways between two footprints and creates new way records under the wick epoch; a second fixed town is therefore not automatically a named destination with a permanent road. See [ground keys:43–65](../../server/internal/api/open_map_paths.go#L43), [opening endpoints:317–380](../../server/internal/api/open_map_paths.go#L317), and [way creation:696–723](../../server/internal/api/open_map_paths.go#L696). Permanent roads, player-laid paths, frontier permission and map labels need separate decisions.

## Options and their consequences

### A. Keep separate areas, improve the edges

**Player:** the same doors and gates, quicker crossings, possibly a short hitch or jump. A simple no-fade restart is easy to trial. It cannot show continuous movement through a joint or keep a friend visible on its other side.

**Client/server:** preload the destination and preserve camera/facing for a better handoff. Area reports and presence joins remain. A convincing view across an edge requires drawing part of the neighbouring area and bridging presence with coordinate transforms; by that point much of B's work has returned in a more awkward form.

**Migration/shared play:** no saved-position or home migration for the cosmetic version. Entity keys remain. True cross-edge visibility adds mixed local coordinate spaces and reach checks, with duplicate roster and interaction risks.

**Performance/map/turning:** preloading consumes extra memory and moves build work earlier, but each crossing still destroys and creates entities. The map remains an area graph beside the Wilds map; wick behaviour stays as today. Mobile may get a nicer fade-free handoff but a more obvious uncovered stall.

**Pros:** cheap, reversible polish. **Cons:** does not answer the owner's centre-and-roads idea. Use only if the actual goal is faster gates, not as the foundation for a seamless world.

### B. Put authored ground on the same grid

**Player:** Hearthwick, Commons, Brackenwood and the ruin become adjoining named districts in one outdoor scene. The original square and story props can remain. Cut their terrain into 24-tile chunks, leaving terrain between footprints wherever necessary. Remove portal trigger rectangles at outdoor joins; retain signs and indoor doors.

**Client:** generalize the Wilds window into an outdoor window with multiple chunk sources. A curated chunk needs ground, collisions, prop footprints, lights, NPCs, repairs, doors, fishing banks and interactions; the current `AttachedChunk` knows Wilds terrain/entities, so slicing the ground alone is insufficient. Give each streamed object an owner and attach/detach lifecycle. Large buildings may overlap several chunks but must appear once, with collision ready before access. Preserve absolute y depth ordering and the existing ordered build queue.

**Server:** supply an authoritative placement manifest and curated collision data, ideally shared authored content instead of porting TypeScript builders by hand. Keep named place IDs for gameplay and stable entity IDs for story. Spatial presence covers the whole outdoor grid; interiors keep separate rooms. The server derives the place under a world position, including fine boundaries inside a chunk, rather than trusting that the whole outdoor area is village-safe.

**Migration:** each old outdoor area gets a tile-aligned origin. Convert old local player pixels by `worldPx = localPx + 16 * originTile`; keep interior coordinates. Home data stays keyed by home ID with plot-local coordinates. Generated Wilds data can stay in place if the current frame stays. Details are in the migration section below.

**Presence/performance:** friends remain visible across old joins; distant villagers will no longer all share one visible room. Limit loaded ground to the moving window. Attach village systems per chunk or per visible district, not an entire village's systems every time a boundary moves. Reuse the 0.8 bulk operations and workers; measure dense town chunks separately from woods.

**Map/turning:** add permanent district footprints, indoor door markers and home labels to the world map. Authored terrain never turns; surrounding generated land does. Resolve mixed fixed/generated edges on both sides of a chunk and prevent path tools editing authored buildings or another person's lot.

**Pros:** preserves the village's identity; staged adoption; uses the working window. **Cons:** the authored maps were composed as enclosed scenes, so their borders, joins and routes need deliberate redesign. Homes cannot be placed by a simple offset from today's gates.

### C. Make the village a fixed stamp in generation

A stamp is an authored patch placed at a permanent location before random ground is filled around it. This is an authoring/generation choice on top of B's streaming and location work, not a competing renderer.

**Player:** the village becomes a recognisable centre, with two or more roads leading to different landscapes. Meadows, orchards or a common verge soften the transition into woods. The Tangle remains a named destination; the original story road can still be a particular route.

**Client/server:** the server reserves a footprint plus a border, projects its collision/props/door anchors into chunks and connects named outlets to the generated route network. Rivers, thickets, camps and landmarks must yield to the stamp. Update glimpses and map reads as well as full generation. A stamped square needs curated content fields absent from today's chunk message. Merely adding `village` to `places` would also affect nearest-footprint difficulty and frontier reach; a village reserve must not accidentally make all nearby land safe or low-tier.

**Migration/shared play:** same position and presence changes as B. Keep story/NPC IDs and home ownership stable. A stamp revision must not silently replace already stored chunks: version its layout and migrate affected geometry explicitly. Keeping the old Wilds frame is still the cheapest choice. Moving the gate, road, fixed sites or generated grid can invalidate existing discoveries, paths and entity IDs.

**Performance/map/turning:** runtime cost depends on content density, not whether it was authored or generated. Fixed chunks can be cached, but cannot carry mutable home furniture forever in an immutable blob. Mark the town and reserved roads permanent on the map; changing wilderness honours stable outlets at every wick. Permanent town land is different from a lamp-held chunk: the town is authored, while a hold preserves whatever generated layout was present when lit.

**Pros:** best fit for several roads and future settlements; one geographical model. **Cons:** more generation, art and layout work; creates explicit exceptions for towns, lots and protected roads. Recommend this as the eventual shape, introduced by B rather than by regenerating the entire world at once.

### D. A second settlement through the Wilds

| Kind | Placement and journey | Cost after B/C | Persistence and content |
|---|---|---|---|
| Hand-made town | Reserve a fixed footprint at a chosen distance/direction; author its joins and route | L, plus town art/writing | Stable town; hand-made rooms, residents, shops and quests |
| Reusable town stamp | Author a small outpost once; choose an eligible site from the world seed and store that choice | M for one small outpost; L for a full town | Stable ID/location; rotate/reuse scenery only where doors and art support it |
| Procedural town | Generate streets, buildings, lots and roles from a new grammar | Multiple L lanes | Requires reachable doors, schedules, unique IDs, names and meaningful services; no such town generator exists today |

A prototype with a few buildings can precede a complete second town. A generated **site** with a landmark is already supported; a generated **town** with citizens and interiors is not. Keep its placement stable across wicks if it has residents, homes or quests. A settlement that disappears every wick is a travelling camp with different expectations.

Reach is not automatic: a town inside the current frontier can be walked to; one beyond it needs a deliberate initial corridor or lamps that open the intervening land. Adding a town as another frontier seed could unlock a disconnected island without opening the approach. Generated routes must have fords/passes and must still connect to town outlets after a turning. Decide whether the road itself persists, or only its endpoint does.

Client work is additional stamp content, doors, signs, map labels and goal routing. Server work includes persistent placement, route reservation, place checks and new room/content registrations. Spatial presence and chunk simulation can reuse B/C. Existing player positions need no migration if this is additive; the reservation still needs a policy for already generated land, paths or later lamp holds occupying the site. Homes there would need settlement/lot identity beyond today's single Commons gate sequence. Extra residents, shops and dialogue are real product work even if placing the ground becomes cheap.

**Pros:** gives roads a destination and lamps a reason to matter. **Cons:** a bigger world can feel empty, travel can become a chore, and a town without new activity is mostly scenery. Prefer one modest permanent authored outpost, reached on foot, before attempting procedural towns.

## Homestead plots: where they go

**This is the largest open design choice.** The owner's added possibilities are a plot district beside the village and Wilds, a home that claims and permanently keeps a patch of generated land, or both. All three can be seamless. They differ chiefly in how much land must be reserved, how neighbours meet, and whether a deed can change the wilderness.

| Housing option | What the player feels | Land and neighbours | Housing work after the common outdoor foundations |
|---|---|---|---|
| H1. Serviced plot district | A lane from the village into a wooded neighbourhood bordering the Wilds; familiar homes close together | Fixed, spaced lots with public lanes; easy visits and shelves | L + M, roughly 4–7 engineer-weeks including migration/map/verification |
| H2. Claims out in the land | Choose a clearing you found, mark its boundary, and keep that landscape through every turning | Scattered homes, or friends claiming nearby eligible patches; approaches can change | Two L lanes + M, roughly 6–10 engineer-weeks including held terrain and claim rules |
| H3. Both | A convenient first home near town, with an optional move to a frontier home | Village neighbourhood plus small clusters in the Wilds | H1 plus most of H2, plus M for moving/selection; roughly 10–18 engineer-weeks |

These are **housing-specific** estimates, with the shared window/location work already available; they replace or expand lane 7 below, not the whole project estimate. H2 could be cheaper after Lamps delivers tested holds, but ownership, home geometry, relocation and access still need their own work. Copying an entire existing plot onto a suitable Wilds site is cheaper than preserving whichever native ground the player chooses, but it would not fully deliver “this patch I found becomes my home.” All figures are exploration estimates.

### Today's lots are separate spaces

The gate system identifies a home by world and gate, not by a physical world rectangle. Gates alternate west/east; rows are at y=9,13,28,33 and then every five tiles. A 40×30 plot cannot fit beside each five-tile row without overlap. Every plot also currently enters from its south edge, although its Commons gate sits in a west/east fence. See [gate geometry:157–167](../../src/lib/homestead.ts#L157), [home size:48–60](../../content/homestead.json#L48), [growing gate count:238–245](../../server/internal/api/home_deeds.go#L238), and [home entry:91–104](../../src/game/homeland.ts#L91).

One player belongs to one homestead, including a joint deed. Claiming currently means choosing an available numbered gate; it does not select world coordinates or hold generated terrain. Land is generated from world/gate, while furniture and cleared tiles are home-local records. The server's placement checks regenerate that separate land, so using native Wilds ground requires changing the validation source as well as the drawing. See [claim:266–290](../../server/internal/api/home_deeds.go#L266), [membership schema:16–20](../../server/internal/store/migrations/010_homesteads_v2.sql#L16), [joint deed:88–94](../../server/internal/api/home_membership.go#L88), [land service:22–38](../../server/internal/api/land.go#L22), and [placement ground:14–25](../../server/internal/api/home_placement.go#L14). The historical membership column is now `account_id`; preserve the one-home rule, not the obsolete column name.

### H1. A district between the village and the Wilds

Reserve a strip or several branches of countryside beside the centre, reached by public paths from Commons and opening onto the Wilds. Put homes **in** that landscape, with adequately spaced lots; the district's border need not be a loading gate or a wall. Keep the present 40×30 home terrain and local furniture layouts by placing each as a fixed patch, surrounded by a verge that joins neighbouring ground.

Use world origins and stable lot IDs rather than stretching the present compact gate lane. Existing plots should be translated, not rotated: south-facing approaches preserve cottage/stable art and interior exits. A new lane can run along their south sides, with branches leading to the old numbered gates. Reserving district expansion space at the start avoids moving established homes whenever a deed is bought. New branches can be added within those reservations; no single unbounded lane needs to be painted or fetched at once.

The server stores lot footprints and origin/entry anchors per world, serves fixed plot geometry plus mutable home overlays, and excludes the district from wilderness regeneration. The client streams lots through the same outdoor window, transforms between world and plot coordinates, and attaches cottage, furniture, lights and interactions once. Public lanes remain traversable even when a plot is vacant, overgrown or occupied. Permanence is cheap here because no existing wick landscape needs to be captured or its camps converted.

**Benefits:** least disruptive migration, visible neighbours, quick access to Silas and village activities, predictable public roads, and a clear place for spare lots. **Costs:** the district occupies substantial physical space; later rows cannot overlap as they do conceptually today. It gives fewer reasons to explore for a home and can feel like a subdivision unless lanes, vegetation and water make it part of the countryside.

### H2. Claim a patch of generated Wilds

There are two versions of this option. A **designated site** lets the generator offer suitable clearings with a cottage pad and public approach; a player chooses among those found. A **free choice** lets the player position a boundary almost anywhere and requires more rejection rules, terrain preparation and route repair. Start with designated or strictly validated sites. Rivers, fords, the Lantern Road, story sites, camps, another home's land and later lamp sites cannot simply disappear under a new cottage.

For the first version, reserve a chunk-aligned 2×2 envelope, 48×48 tiles. Inside it, a 40×30 buildable plot preserves today's home dimensions; the remaining space provides a border and approach. Freeze the four chunks, but make ownership/build rights apply only to the inner lot. The outer verge can remain public. Unaligned 40×30 rectangles can intersect more than four chunks, so align the envelope before sizing the retained land. This deliberately keeps slightly more land than is owned, making the held boundary and epoch lookup manageable.

That envelope is a suggested simplification, not a requirement of the lore. The more exact alternative freezes only the plot's tile mask and lets the rest of each intersecting chunk turn. That needs a mixed permanent/wick chunk format, masked entities, collision and cache composition, and seam rules inside a chunk, not just across its edges. Budget **another L or more** for that fidelity. A literal 40×30 claim is therefore not the cheapest implementation even though it keeps less land.

**What a claim would do:**

1. The player previews the deed boundary, entrance, buildable ground and the actual retained envelope. The server checks the same shape against effective shared ground, including other players' paths, sites, public routes and active fights. Require the whole envelope inside the reachable frontier, not merely the clicked tile.
2. In one transaction, reserve non-overlapping world cells, charge the deed cost once, attach the deed/members, and record the exact terrain version being kept. Recheck the epoch and overlaps at commit: two friends claiming the same clearing, or a request delayed across a turning, must not both succeed or capture different land. Reuse keyed operation replay for retries.
3. Keep the current chunk blobs and relevant effective ground changes, or copy them into a dedicated permanent terrain record. Do not later regenerate them from a `still` seed: that would preserve coordinates but change the clearing the player chose. Stable reservation metadata records world/realm/layer, origin, inner plot, approach, terrain reference and revision.
4. Apply home clearing, posts, plants, furniture and cottage placement as home-owned overlays. Adapt the native snapshot to the home terrain vocabulary used by placement checks; exclude incompatible sites rather than silently flattening them. Native ground may lack today's ready-made cottage pad and guaranteed gate path, so offer only sites where those can be prepared and reached.
5. New wick ground honours the retained edge, including its public opening. Other players and the map receive the same revision and effective collision. At the turning, the claimed chunks stay; neighbouring unheld chunks change. A player in the cottage returns to its persistent door anchor, and one standing on the plot remains on its unchanged ground.

The reusable part is Lamps' planned per-chunk hold, not today's gate claim. Current chunk reads reject an ended epoch; cleanup deletes old epochs and their world-change rows; neighbour generation currently collects only still neighbours. All of those must accept a retained claim's terrain, with cache pruning and near reads updated too. See [ended-epoch read:202–221](../../server/internal/store/chunks.go#L202), [cleanup:181–187](../../server/internal/store/chunks.go#L181), [kept-neighbour collection:265–284](../../server/internal/store/chunks.go#L265), [client pruning:448–450](../../src/game/wilds/store.ts#L448), and [planned holds:218–224](lamps.md#L218). A marker saying “claimed” without these changes would leave a house on changing or unreadable land.

Treat terrain retention, frontier reach, ownership and safety as separate decisions. Keep one effective terrain reference per chunk, with retention reasons such as plot reservation and lamp hold. If a lamp already holds the candidate ground, a home uses that same ground rather than creating a second version; reject incompatible reservations. Removing a lamp's role must not release ground still needed by a plot. A deed should not quietly expand the frontier like a 3×3 way-lamp or make its entire four-chunk envelope safe. Home posts still govern connected buildable light, and paid rest still requires the player's own home conditions. Whether merely owning a remote plot counts as a safe sync boundary needs explicit agreement.

**Benefits:** a home is a discovery and a lasting mark on the shared world; neighbours can settle near a loved meadow; roads and Lamps gain a practical destination. **Costs:** every claim permanently reduces turning land, can erase public opportunities if poorly placed, adds old-epoch/state retention, and can isolate owners when its approach turns. Snapshotting ground must not provide a way to capture repeated camp/chest rewards or privately own a public landmark. Keep existing entity/claim IDs for compatible retained content; do not respawn or duplicate loot when a deed is created. Prefer claim envelopes without camps, chests or story entities for the first release.

### H3. Both, with one home rather than two

Allocate current homes into the serviced district. Later offer eligible Wilds plots as an optional **move of the existing homestead**, retaining one deed/home per player or joint group. Friends can stay neighbours near the village or choose compatible neighbouring frontier sites. This preserves the accessible social centre while letting exploration eventually shape settlement.

The move is additional work: preserve home/member/item IDs, storage, shelves, plants and stable ownership; choose how placed pieces and cleared tiles fit different native ground. A literal translation can put furniture on a stream or a cottage on a boulder. Show a new placement preview and return incompatible pieces to home storage with an explicit policy for plants and clearance, or initially permit only undeveloped homes to choose a frontier site. Any move needs all joint members' agreement. Resolve players saved inside or on the moving home through the new door/plot anchors, with a position-version barrier.

Do not let players copy their old home, furniture or retained ground into two occupied properties, or move repeatedly to hold unlimited land. The old district lot can become vacant and reusable. An old frontier footprint requires the permanence policy below; its retained chunks continue to count against the world limit even when no one lives there. H3 shares the district and claim machinery but adds relocation, two kinds of vacancy and more user-facing choice. It is the richest option and the largest scope.

### Neighbours, shared play and the way there

Outdoors remains shared within the same invite world. Friends can walk past and visit without joining a private home scene; furniture, clearing, shelves, lights and desolation are visible from neighbouring chunks. Keep building/removal rights attached to deed membership, not proximity. A joint home is one lot with several members. Shelf access and gifts retain their existing rules; nearby homes do not share inventories or building rights. The indoor cottage remains a transition and keeps its home identity.

A boundary should be visible through a small marker, fence or planting, with a public entrance. Let neighbours see and emote across it, without needing everyone to join a `home:<gate>` outdoor presence room. Cross-chunk reach checks must support the shelf and tools near the boundary; a gate that visually touches a friend's chunk should not make interaction fail solely on a room label. Large pieces spanning chunks need one visual/interaction owner. Nearby camps remain owned by the fight sim; safe plot boundaries must not allow combat to damage homes or follow players into protected land by accident.

**A permanent home is not a permanently reachable home.** Its surrounding road can still turn into new forest or water. District lanes should be fixed public ground. Frontier sites need a guaranteed local approach copied at their retained edge, with regenerated routes/fords connecting onward to the existing network. For an initial outland version, require a short approach to a public way-lamp and protect that connecting route; drawing a straight line on the map is insufficient. An alternative is letting the approach change while guaranteeing some walking route each wick, but that requires reach tests around every claimed cluster and a rescue/return policy. Coordinate this with Lamps and homing items before players settle far away.

### Limits and the map

Today's 0..9999 gate range is an ID/parser bound, not a planned physical capacity. A sensible **provisional playtest** is eight serviced district slots and up to four frontier envelopes per world, with one home membership per account and joint members sharing a slot. These numbers are suggested defaults, not owner decisions or existing limits. Migration must accommodate every existing home even if a world already exceeds them; raise/reserve the capacity before cutting over rather than evicting someone.

| Limit | Suggested first rule | Reason / later expansion |
|---|---|---|
| Plot size | Existing 40×30 interior of a 48×48 reserved envelope; no free boundary growth | Preserves local home geometry and bounds retained land; posts increase buildable light inside it |
| Spacing | At least eight public tiles between reserved envelopes; larger where a route/river needs it | Leaves room to walk and join edges; adjacent ownership must not wall off the countryside |
| How far | District borders the centre; remote sites within three chunks of an already reachable public lamp, and wholly inside the open frontier | Makes the approach/return manageable; greater reach later follows Lamps, not arbitrary coordinate claims |
| How many | Eight district slots plus four remote envelopes initially; cap retained remote envelopes, including vacant ones | Four remote 2×2 envelopes keep up to 16 chunks, substantial against today's 81-chunk frontier; monitor how much land still turns |
| Protected space | Exclude village/story reserves, public routes/ford corridors, landmark/camp sites, lamp footprints and other lots | Preserves shared play and progression; specify a clearance buffer per site kind |
| Growth | Open a reserved district branch or a tested new remote capacity band; never move occupied lots | Expansion follows actual membership, map size and measured costs |

No lamps are implemented yet; the remote distance rule is a proposed post-Lamps starting point. District homes can ship before them. Site scarcity, river clearance and an eight-tile gap may make fewer remote candidates available than the numerical cap: the UI should show the real eligible choices rather than promise a plot at every coordinate. Deed price and a Keeper's hand/lamp prerequisite for remote claims are separate product questions; today's first-free/10-glim gate price is not automatically the price of permanent wilderness ([deeds:155–157](../../content/homestead.json#L155)).

The Map tab should show stable district/lot boundaries, ownership or joint names, vacant lots, public entrances, access roads and the actual retained envelope. Give “owned plot”, “kept ground” and “turning land” different meanings. Show a plot even if the surrounding wick's walked record has reset, and keep its stable ID across changes to coordinates or residents. A claim preview explains which extra border chunks will stop turning, whether the approach is fixed, and which neighbouring spaces remain public. A home list can focus the map on a friend or an available serviced lot. Claim placement and exclusions must use the server manifest; device-local walked land cannot decide whether another player owns a patch.

### Permanence, vacancy and migration

Decide what “permanent” means before implementing H2. Today, leaving the last member makes a home vacant; desolation starts after three days and the deed is lost after fourteen. Cleanup removes its placed goods, plants, cleared ground and home record. See [content timers:160–166](../../content/homestead.json#L160), [leave:105–108](../../server/internal/api/home_membership.go#L105), and [settleHomes:29–84](../../server/internal/api/home_deeds.go#L29).

For the owner's “permanently take over a patch” idea, recommend that **the terrain reservation survives deed loss** and becomes a reusable vacant lot. Ownership can lapse under the present policy while the land stays a recognisable settled patch. Keep reservation/terrain records separate from the home row that cleanup deletes. Count vacant reservations in the retained-land cap and offer those first to new settlers; otherwise repeated claiming and abandonment freezes the world. A different policy could release abandoned remote ground at the next turning, after relocating anyone there and checking no lamp still holds it, but then its permanence lasts only while held/owned. That is a different promise and should be named as such. Nothing in this exploration changes today's loss policy.

| Existing data / feature | District migration | Remote claims / both |
|---|---|---|
| Gate numbers and signs | Keep gate numbers as legacy identity; assign every occupied and spare slot a physical lot/approach; signs become on-site entrances | Keep stable home identity but stop deriving location from a gate number; add reservation→origin lookup and map destinations |
| Native plot terrain | Preserve the current world/gate seed and translate each 40×30 grid into reserved district ground | New claims capture native Wilds terrain; existing developed homes should migrate to district first, or require an explicit compatible-site/removal plan |
| Furniture, clears, plants, storage, members and stalls | Keep home-local coordinates, IDs and ownership; reserve sufficient ground for every existing footprint | Preserve IDs on a move, validate against the new ground and handle incompatible placement explicitly; do not reset or duplicate goods |
| Saved outdoor position | Translate through the assigned lot origin; validate the resulting tile | Resolve the home's current origin/revision; moving the home requires relocation barriers for occupants |
| Cottage IDs and exits | Keep `in:home:<gate>` initially, mapping the return to the new stable doorway | Prefer door→home identity resolution so a later move returns to its new site; preserve alias IDs used by existing saves |
| Shelves, deed table and home guides | Move gate shelves/signs with their lot; Pell's office remains a shared indoor destination | Remote shelves sit at the claim entrance; update guides, quests and map search rather than relying on Commons gate coordinates |
| Public Wilds changes | Reserve district in unused land where possible; reconcile any affected shared paths before replacing terrain | Validate and preserve agreed public paths through the envelope; do not delete another player's road or hold when a claim commits |

Migration does not grant a second property. Existing homes first receive locations; remote claims are a later choice. Keep player-place barriers and pending-operation/layout handling from the migration section below. Move geography while retaining home identity; do not replace every home just to obtain new coordinates.

**Housing recommendation:** start with H1, laid out at the village/Wilds edge with enough reserved space for current homes. Build its location model so H3 remains possible. After Lamps' retention and approach rules are proven, playtest one eligible native Wilds claim, then a neighbouring friend's claim and a wick turning. Only then decide whether a small number of permanent remote lots adds enough play to pay for H2/H3. The owner's full claim idea is feasible, but it is a second feature alongside seamless walking, not merely another place to put today's gates.

## The changes most likely to break things

### Keep physical space separate from named places

Use one outdoor coordinate space, with named districts/plots over it. A location lookup should answer the world position, containing place, plot if any, safety/rest rules, epoch and nearby interaction anchors. Interiors keep their own local coordinates and identify the outdoor doorway they return to. This is a proposal, not an existing abstraction.

Rendering chunks, gameplay districts, ownership boundaries and generation footprints should remain separate. A 24×24 chunk can contain both a safe square and unsafe woodland. The client predicts the same lookup; the server makes eligibility decisions. A new area label such as `outdoors` is optional, but calling everything `wilds` without this separation would break safety and quests just as surely.

| Existing dependency | Failure if all outdoors simply becomes `wilds` | Necessary treatment |
|---|---|---|
| NPC schedules and dialogue spots | Residents disappear, doors/path legs use the wrong local coordinates; seller reach fails | Keep place/spot IDs, transform their anchors, load one resident visual once, derive schedules from clock |
| Quest `at`, `reach`, `where`, talk/use checks | Return-to-village never completes, or talking anywhere outdoors becomes allowed | Resolve named place and specific spot in the common frame; preserve quest IDs and stages |
| Safe area and healing | The square becomes unsafe, or the whole world becomes safe; zero-HP movement crosses into danger | Check place/light at the hero's position on both sides; stop movement at unsafe boundaries without needing an exit |
| Unmoored | Rest time never clears in town, or relocating the gate changes what counts as deep | Use safe/light zones; retain or explicitly redesign the gate-distance rule |
| Indoor exits | Exiting bakery/cottage returns to coordinates near the world origin | Resolve stable doorway ID to current world doorstep; retain indoor IDs/coordinates/facing |
| Homes and gates | Overlapping lots, wrong plot ownership, shelf/placement/rest targets move | Add a real lot layout and world↔plot transforms; keep home IDs and local furniture positions |
| Story enemies and Warden | A bypass route skips the tutorial, or shared combat rewards a personal story encounter | Protect the story route and retain explicitly personal combat ownership |
| Art and camera | Abrupt ground cuts, clipped roofs, shadows and depth seams; camera clamps at old edges | Author a border palette, assign single owners to overhanging props, use world bounds |
| Tests and dev hooks | Warps, area assertions, door helpers and screenshots address obsolete frames | Preserve logical place helpers and add world-crossing checks |

These are concrete dependencies, not hypothetical cleanup: [resident-cycle.ts:51–74, 110–158](../../src/game/resident-cycle.ts#L51) resolves area-specific doors and spot tiles; [npc-routines.ts:8–14, 29–44](../../src/game/npc-routines.ts#L8) keeps talk/reach at fixed posts; [quest_rules.go:58–86](../../server/internal/api/quest_rules.go#L58) compares area strings; [goal-route.ts:28–56](../../src/game/goal-route.ts#L28) resolves area-relative targets; [safe rules:34–38](../../server/internal/rules/rules.go#L34), [spend checks:29–38](../../server/internal/api/spend_op.go#L29), [Unmoored:130–157](../../src/game/entities/unmoored.ts#L130), and [zero-HP exit restriction:978–981](../../src/game/scenes/WorldScene.ts#L978) rely on old boundaries. Safety permits sync/free movement; it does not itself grant every paid rest. Keep village rest, cottage rest and future lamp rest distinct. Mana regeneration, paid healing and passive HP policy also differ: imported heroes do not gain passive HP merely by standing in a safe place or lantern light ([hero.ts:294–311](../../src/game/entities/hero.ts#L294)); road-light rest additionally checks distance and nearby enemies ([lanterns.ts:62–74](../../src/game/area/lanterns.ts#L62)).

### Plot ownership and light

The housing options above all keep build rights in plot coordinates. Home lantern posts govern connected buildable light and placement; Lamps retain generated chunks. Neither a neighbour's lamp nor a road crossing a lot grants building rights. See [placement light rule:99–113](../../server/internal/api/home_placement.go#L99) and [home rest:158](../../server/internal/api/home_membership.go#L158). An interim village/Commons/Wilds release can keep plot gates as transitions, provided it is described as partial outdoor continuity. If every outdoor plot must be seamless immediately, H1 or H2 belongs on the critical path.

### Art, performance and phones

The 0.8 work matters: batched display-list/static-body changes, flat decals, an ordered incremental build queue, worker ground painting and edge slack are already present. Collision goes in immediately; scenery and things are built in later slices with a nominal 4 ms build budget. A lane can exceed that budget if one unsliced task is expensive. See [bulk.ts:2–15](../../src/game/area/bulk.ts#L2), [chunk build:206–253](../../src/game/wilds/window-chunk.ts#L206), [collision runs:435–448](../../src/game/wilds/window-chunk.ts#L435), and [BUILD_MS:55–58](../../src/game/wilds/window.ts#L55).

The release notes report the worst frame at 4× CPU throttling falling from about 970 ms to 50 ms; that is evidence of improvement, not proof of smooth dense-town performance. The shipped design still records window-wide gathering registration at about 4 ms average under that throttle and occasional frames just over 50 ms. It also records a stale reload position and a laid-edge ground seam issue. See [CHANGELOG.md:109–118](../../CHANGELOG.md#L109) and [open-map.md:600–620](open-map.md#L600). The design's ≤8 ms phone painting budget is a target, not a new measurement from this exploration ([open-map.md:491–500](open-map.md#L491)).

Curated tiled ground and Wilds pixel-painted ground are separate paint paths ([terrain.ts:164–174](../../src/game/area/terrain.ts#L164)). Preserve the village's flagstone/grass character, but make a few tiles of verges, trodden ground, fences and trees join the Wilds palette. Neighbour reads must cross source boundaries. A giant building painted once per chunk would duplicate art and cost; anchor it once and account for its overhang when streaming. Continuous y sorting must include indoor-door props, people, lights and canopies.

On phones, budget worker transfer and texture upload, collision attachment, resident/light animation and UI together. Bound decoded caches as well as attached chunks; the current decoded chunk cache is a growing map for the active epoch ([chunks.ts:28–35](../../src/game/wilds/chunks.ts#L28)). Slow network arrival needs a safe barrier at missing collision, followed by opening when data is ready, without a hidden scene restart. Include walking while mounted, diagonal crossings, turning back, dense Commons gates, repeated indoor trips and repeated town visits in memory/frame-time measurements. Review the recorded worker-error fallback issue before depending on workers for more sources ([game review:118–139](../reviews/2026-10-11-step-back-game.md#L118)).

Server cost follows active players/chunks, not total map area, if fixed content and empty land remain lazy. Cold near reads currently make chunks inside a transaction. Still-epoch creation currently generates every still footprint's chunks up front ([chunks.go:157–169](../../server/internal/store/chunks.go#L157)); adding every future home lot to that loop would create a growing cold-start cost. Make town/lot loading bounded rather than assuming all permanent ground is already lazy. The one SQLite connection and hub mutex remain relevant; do not let simulation ticks perform those reads or save every NPC every tick. The older capacity figures in [scaling.md:3–39](../scaling.md#L3) predate 0.8 and are estimates, not a load test. Current storage still sets one connection and FULL synchronous writes ([store.go:46–51](../../server/internal/store/store.go#L46)). Spatial visibility can fan out across nine busy chunks, so the 32-player room cap is not a bound on each visible roster or on all fight messages.

## Migration without losing the village or homes

Prefer keeping the current Wilds origin and generated IDs. Put village/Commons/story footprints in newly reserved land, with authored connectors where the old portal geometry cannot line up. Pick the layout before writing the migration.

| Data | Recommended handling |
|---|---|
| Player place | Translate each old outdoor area's pixels by its fixed origin. Translate `home:<gate>` through the lot origin. Leave interiors local. Validate the result and use a named safe arrival anchor if blocked or unmappable. Bump player version and `place_set_version`. |
| Quest marks, inventory, currency, mail, repairs, story outcomes | Keep IDs and progress. Replace area checks with place/anchor lookup; moving the visual must not reset a repaired bridge or tutorial step. |
| Homes | Preserve home IDs, membership, gate number, deed history, furniture/stall IDs, plants, cleared tiles, shelves and storage. Keep their local coordinates; add placement metadata. Re-keying ownership to chunks would be unnecessary and dangerous. |
| Generated chunks/state | Leave untouched where coordinates/geometry stay. If generation changes existing ground, use a versioned, scoped change and an explicit state policy. Moving generated chunk coordinates also moves coordinate-derived entity/site references; offsetting only players is insufficient. |
| Paths, discoveries and lanterns | Preserve their coordinates and epochs if Wilds stays fixed. New permanent roads use protected content. Define whether changed geometry preserves, remaps or retires affected path/way/state rows. |
| Shared changes in curated places | Retain stable realm/entity identity for stock and repairs, or migrate each kind explicitly. Do not put village pond stock into a wick epoch merely because its picture sits in a streamed chunk. |
| Browser data and pending operations | Version layout/cache keys, reproject or discard convenience walked-map records, and reject/rebase old-coordinate reports and queued operations under a contract/layout boundary. Retain operation IDs and idempotent results; do not blindly replay them at translated coordinates. |

The 0.8 migration is a useful example of relocating saves with a version barrier, but its wholesale deletion of Wilds state is **not** the default for this project ([034_open_map.sql:1–64](../../server/internal/store/migrations/034_open_map.sql#L1)). The earlier plan says compatibility was cheap because nobody played then ([plan.md:33–36](plan.md#L33)); confirm today's saves and owner preference before assuming the same clean break is acceptable. This exploration performs no migration.

Keep indoor IDs such as `in:village:bakery` and `in:home:0`. Replace their outdoor return coordinates with doorway/plot anchor resolution. Several town doors should not depend on the most recent gate used. Defeat recovery, removed-room recovery, world switching and later homing items must all resolve the same named safe anchors.

## Server fights, then Lamps

The brief says server fights are next, then Lamps. `plan.md` still puts shared fights later in its release table, but its combat section recommends a one-camp prototype. Follow the brief's newer order; do not silently rewrite the agreed roadmap during this exploration. See [plan.md:167–169](plan.md#L167) and [combat prototype:245–267](plan.md#L245).

**Design the shared boundaries together; ship fights before the large seamless refactor.** Agree now on world/realm/layer/chunk/epoch identity, geometry sources, logical places, stable entity/door anchors and visibility versus simulation ownership. Build the first server camp on today's Tangle. It already has server geometry and spatial presence; it does not need a seamless village.

Shared fights plan a sim per active chunk, about 10 Hz with snapshots at 8 Hz, camp enemies leashed to their owning chunk, and personal rewards. Curated Brackenwood enemies and the Warden remain client story fights. Putting those pictures on the world grid must not change that authority by accident ([layers.md:195–237](layers.md#L195)). Camp leash remains a combat rule even when chunk edges are invisible.

The existing 3×3 visibility complicates activation: a player in one chunk can see enemies in the next, whose room might otherwise have no occupant. Specify whether proximity activates neighbouring camps, or when inactive enemies become visible. Use one owning simulation per chunk/epoch, with cross-boundary observation and hits routed to it; never run nine duplicate sims for one camp. Seamless town edges add safe-zone and protected-road decisions, but no reason to simulate peaceful town chunks. The current server review already calls out this separation and keeping ticks independent of transactional chunk generation ([server review:165–170](../reviews/2026-10-11-step-back-server.md#L165)).

Lamps fit well with a permanent centre and roads. Their held-chunk lookup, frontier growth and retention of old wick epochs are the same permanence problems needed at a fixed/generated join. A permanent town should be a fixed reservation; it must not need a lamp to exist. Lamp holds should neither move a plot nor permit changes inside someone else's land. Do not count every town as a new difficulty/frontier seed without deciding what that does to progression.

Before Lamps, agree on those contracts and reserve the likely centre footprint. Full seamless implementation can follow Lamps if the owner remains undecided. If the owner commits to new southern roads now, place those reservations before lamp holds can occupy them. Avoid moving coordinates after permanent player holds are established. Lamps prose still contains old region names, migration 034 and older turning instructions; re-plan it against 0.8, as its opening note already requires ([lamps.md:6–8](lamps.md#L6), [current holds amendment:211–224](lamps.md#L211)).

## Lanes and stages that can stop cleanly

| Lane | Deliverable | Size | Dependency / why it matters |
|---|---|---|---|
| 1. Geography and location contract | Choose footprints/roads, source precedence, place/plot lookup, indoor return anchors, epoch and fight ownership; shared Go/TS vectors | M | First; reconcile the concurrent world map |
| 2. Curated chunk data | Export shared authored terrain/collision/anchors; support fixed chunks and revisioned caching | L | 1; avoid two independent map implementations |
| 3. Streaming lifecycle | Generalize the window and attach/detach NPCs, doors, lights, repairs and interactions with one owner | L | 1–2; retain 0.8 performance work |
| 4. Gameplay and presence | Spatial outdoor rooms; place/reach checks; safety, rest, sync, zero-HP boundary, Unmoored and goal routing | L | 1, then integrate with 3; coordinate with fights |
| 5. Saves and cutover | Position conversion, version barriers, indoor/recovery anchors, caches/outbox and upgrade fixtures | M | Layout fixed; grow to L if existing Wilds is moved |
| 6. Roads and stamp seams | Protected village border, several outlets, generator routes/river exclusions, stable→wick joins, map and ways | L | 1–4; the step from B to C |
| 7a. District home lots (H1) | Spaced reserved lots, gate→origin metadata, local transforms, growth/desolation, migration/map and streaming overlays | L + M | Owner's housing decision; common outdoor foundations first |
| 7b. Remote claims (H2) | Native terrain snapshots/holds, protected claim envelopes, approach routes, shared claim validation and retention after vacancy | Two L + M | Coordinate with Lamps; separate from 7a; sub-chunk claims add another L or more |
| 7c. Both and moving (H3) | Site choice, joint approval, home relocation, incompatible placements and reusing the old lot | M plus most of 7b | After 7a; keep one home per member and cap permanent remote reservations |
| 8. Art and phone verification | Transitional ground/props, single-owner overhangs, frame/memory/network walks, regression updates | M–L | Runs through each playable stage; cannot be left to the end |
| 9. Second outpost | One permanent authored destination, route, interiors, map identity and a reason to visit | M–L | 6, plus Lamps if beyond the initial frontier |

These lanes overlap in verification; do not add every upper bound as a precise calendar forecast. NPC content, art and housing decisions are the main estimate multipliers. A pure procedural settlement system would add several L lanes beyond this table.

1. **Foundation, independently useful:** agree on the location/anchor seam and migrate one consumer at a time while old areas still play normally. Ship server camp fights independently. No new geography or save cutover is required for this stage.
2. **Small crossing playtest:** stream the existing Commons arch and the adjoining Tangle ground in one scene, preserving the current Wilds frame. Give Commons a world origin matching its arch to the fixed gate, with a short authored connector to resolve width differences. For example, Commons origin tile (-21,24) puts its north lane x=22..25 at world x=1..4 immediately south of the Tangle gate x=1..3, y=23. This is an illustrative translation, not a proposed final town layout. Keep its plot gates and village exit as existing transitions. Convert Commons saves, place checks and interior return anchors only for this slice. This is roughly two M lanes across data/client and server/migration/validation, not a one-line fade removal.
3. **The fixed centre:** add village, its indoor returns, Brackenwood and ruin as authored chunks; connect village↔Commons and preserve the opening route. Ship with the current number of wilderness approaches. If plots still transition, say so in release notes.
4. **Several roads:** reserve and open at least a second approach, later another side; blend ground and connect routes through turning land. Add permanent centre/door/road labels to the Map tab. This proves the owner's intended feel without waiting for another town.
5. **Seamless district plots (H1):** place the redesigned lots beside the village and Wilds, translate their saves and attach home overlays by chunk. Interior cottages and shops continue to transition. The outdoor-world goal is complete only when story areas and plots also have continuous ground. Optional remote housing is a later stage: after Lamps, prove one native claimed patch survives a turning, its public approach remains usable, and a friend can claim nearby without overlap. H3's move of an existing developed home follows only after that succeeds.
6. **Another destination:** add a modest fixed outpost, then decide whether enough play comes from travel and lamps to justify a full second town.

At any stop, ship only complete joins with safe collision, server rules and correct saves; do not leave half-converted coordinate conventions in active play.

### What the first playtest must establish

Walk Commons→Tangle→Commons, turn back repeatedly and cross diagonally; the camera and movement should stay continuous and the outdoor scene/window identity should stay the same. Two players should keep seeing each other and valid nearby interactions across the join. Doors should still transition and return to the correct world doorstep. Reload on either side, reconnect, and turn the wick beside the arch: Commons must remain unchanged and safe while nearby changing land updates.

Record frame time, ready collision, visible pop-in and memory on the owner's phone, plus slow-network behaviour. Success is that the arch feels like a place in the landscape and the existing Commons/Tangle play still works. Stop and reassess if it mainly exposes stalls, awkward map proportions or confusing safety boundaries.

Future automated validation should cover coordinate/anchor vectors, negative chunks, permanent/turning seams, save upgrades with pending reports, cross-edge presence and reach, zero-HP boundaries, one resident visual and no listeners/tweens left after detaching. Update the existing actual-walk window tests, gate/path tests, door/home helpers, camera/screens and presence expectations; no e2e runs were needed for this read-only exploration. Relevant existing seams are [e2e/helpers.ts:259–275, 416–419](../../e2e/helpers.ts#L259), [room-helpers.ts:13–17, 40–44](../../e2e/room-helpers.ts#L13), [presence.spec.ts:71–94](../../e2e/presence.spec.ts#L71), [camera.spec.ts:85–97](../../e2e/camera.spec.ts#L85), and [window-order.spec.ts:1–7](../../e2e/window-order.spec.ts#L1).

## Recommendation and owner questions

**Keep exploring; do not commit to a full rebuild yet.** Adopt B's shared grid and streamed authored places as the technical direction, with C's fixed centre and connected roads as the eventual geography. Preserve the Wilds frame. For housing, start with H1's serviced district beside the village/Wilds; keep H3 open through stable plot locations, then trial permanent native Wilds claims after Lamps. Plan the location and simulation contracts beside server fights, ship the fights prototype first, then use the Commons/Tangle join to decide whether outdoor continuity earns its cost. Keep Lamps moving once its placement/epoch assumptions are settled; defer a second town and procedural towns. The opening full-world estimate covers district housing; H2/H3 adds the separate claim/relocation work sized above.

The gain is tangible: the village feels embedded in the world, roads can lead different ways, friends remain visible across gates, and a second destination becomes easier to place. The cost is also tangible: a substantial rewrite of area-based gameplay and streaming lifetimes, more art at borders, a housing layout change, and mobile regressions that fades currently conceal. It adds geography and continuity, not automatically more things to do. If the existing transitions already feel good, Lamps and shared fights can provide more new play sooner.

Decisions still needed from the owner:

- Does “whole outdoor world” require every home plot seamless immediately, or is a village/Commons/Wilds release with plot transitions a useful first shipping step?
- Should the present square and buildings remain almost exact, or may roads, fences and the housing lane be recomposed? Which sides should open, and which leads to the original story road?
- How many homes should a world accommodate, and are wider rural lanes/branches acceptable to give each existing plot real space?
- For housing, is the target district-only, remote claims, or both? Should a remote claim preserve the exact native clearing, or may it insert today's generated home plot?
- Does permanent land stay fixed after the deed lapses, becoming a reusable vacant lot, or return to the turning wilderness? Are the suggested eight district/four remote slots and spacing suitable for these invite worlds?
- Should remote claims require public lamplight, and should a deed itself hold only its patch or also open more frontier? Must its approach stay fixed, and should moving an existing joint home require every member's approval?
- Must the tutorial remain a protected personal route even though there are other ways into the woods? Can new roads wait until its story gate is passed?
- Which present saves and laid paths must survive? Is a scoped geometry reset acceptable if it materially reduces migration work?
- Is the next settlement a permanent outpost with a specific activity, or a full town with residents, houses and quests? Should its approach survive every wick, or be renewed and eventually held by Lamps?
- After the first crossing playtest, is continuity valuable enough to delay other roadmap work? What should the concurrent world-map design preserve before any coordinates become permanent?
