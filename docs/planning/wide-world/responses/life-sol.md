# Life in the wide world — sol

*2026-10-20. Proposal for 0.14; no implementation changes.*

My recommendation: make danger a property of places, and encounters a scarce use of that danger.
A dangerous valley can be empty. An ordinary animal can live in a dangerous valley.
Lighting the way should change an expedition, without turning every lamp into a town.
Keep tiers at 1–3. Spend the first effort on spacing, warnings and the content seam.

Confidence: **high** means I would build it; **medium** means a useful playtest starting point.
**Low** means an example to test later. All creature names below are working names, not canon.
I read the brief, synthesis, roadmap, lamp/fight designs, relevant canon and generator/fight code.
The synthesis's owner answers override older Whitequiet/frontier wording in those documents.

## 1. Danger as a field

**High: use lasting pressure, remoteness from tended places, and a small biome adjustment.**
Do not use distance from the world origin as difficulty. A remote community should matter.
Do not make every cave, mountain or pale landscape evil by definition.
The Whitequiet's Echoes are memories; they are not automatically enemies.

Give the land a smooth, lasting `pressure` field, from 0 to 20.
Its broad features span roughly 8–16 chunks, independently of 32-chunk biome regions.
Sample world coordinates with a separate seed salt and fixed-point interpolation.
A pressure hollow can cross a woods/lake boundary. Two lakes can feel quite different.
Pin its version alongside regional geography, including the neighbours used for interpolation.
Never resample known pressure when adding a biome or tuning creature weights.
This is the proposed meta-biome: one scalar field, not another catalogue of biome combinations.

**Medium: begin with this integer score, measured at an encounter anchor:**

```text
D = clamp(12 + remoteness + pressure + biomeBias - localLight, 0, 100)
remoteness = 48 - max(sourceRelief)
sourceRelief = strength * max(0, 1 - distance / radius)
```

| Tended source | Strength | Relief reaches zero at |
|---|---:|---:|
| Town or an eventual permanent inhabited hearth | 48 | 16 chunks from its boundary |
| Oil-held camp or lit backland | 24 | 6 chunks from its boundary |
| Retained, lit communal lamp | 12 | 2 chunks from its position |

Use the strongest contribution, not their sum. No benefit from stacking twenty lamps.
An enemy encounter currently called a `camp` is never a source of human care.
An empty ruin, unlit lamp stone, offline avatar or newly generated road is not a source either.
Standing players do not move this field. That would make danger flicker during shared play.
Common paths preserve routes; a visit alone does not pacify their surrounding woodland.
For 0.14, funded/tended status is the practical proxy for people, even when they are offline.

Start biome biases at woods 0, lake country −4, uplands +6, caves +10, Whitequiet +4.
These represent encounter exposure, not moral descriptions of terrain.
Use the local biome at the anchor, with a short blend at surface boundaries.
Pressure and light must remain separate lab overlays so their effects are understandable.

A lit retained lamp also supplies up to 32 `localLight`, fading to zero over 12 walkable tiles.
Again take the strongest light. Town's existing safe-ground rules take precedence over this score.
Local light follows connected ground and ramps; it does not shine through a cliff or cave roof.
Use a bounded flood over already loaded geometry, not a world-wide navigation search.
For broad relief, same-layer Chebyshev distance is an acceptable surface approximation initially.
Caves get relief only from cave sources; surface light cannot shelter an underground room by x/y.
Later, a mouth may pass a deliberately bounded amount of light into its entrance tunnel.

Example: remote woods with pressure 10 score 70; a communal lamp's centre lowers that to 26.
An oil-held camp's centre lowers it to 14. A distant town does not keep increasing danger forever.
Relief saturates, so chunk 4,000 does not require a level-4,000 character.

**High: separate the live reading from the week's encounter plan.**
Pressure, cave topology and habitat anchors last. Wild occupancy and signs can turn each wick.
Take a care snapshot after weekly upkeep resolves; use it for that wick's encounter selection.
Capture the sparse care-source set once per world; lazy cells use it even on their first visit.
Keep snapshot and live-source revisions distinct when caching pressure and care queries.
A newly lit lamp lowers the live reading immediately and suppresses local future recruitment.
Idle hostiles withdraw to their anchor; engaged ones finish their readable attack, then return.
Do not despawn a wounded enemy, erase earned completion, or alter a fight's size mid-fight.
No new encounter begins within four walkable tiles of a lit lamp or on an arranged footprint.
This is encounter suppression, not safe ground, healing or a cure for player unmooring.
Dimming holds retain their benefit throughout their full warning wick, as they retain services.
Lapse updates relief only when weekly upkeep actually lapses the claim. No continuous oil drain.
Lifting a lamp may raise the reading immediately; additional occupants still wait for next turning.

**Medium: show four bands: sheltered 0–19, watchful 20–44, pressed 45–69, deep 70–100.**
Use words and shapes as well as colour. Reserve "safe" for actual safe-ground semantics.
Before an encounter, show tracks, disturbed reeds, fever marks or a visible resting creature.
The explored map shows broad pressure hatching and current known light, not hidden exact spawns.
Mark old encounter observations with their wick; do not present last week's sighting as current.
A nearby inspection can say "Pressed · far from tended light · fevered tracks nearby."
Quiet Whitequiet ambience needs a visible alternative warning; absence of sound is not enough.

## 2. Fewer, better encounters

**High: remove the per-chunk minimum. It guarantees clutter before biome design can help.**
`content/wilds.json` currently requests 1–2 camps per chunk, with 2–4 resource nodes too.
`gen_v3.go` then adds place-owned entities; `cells.go` can add a camp glade per 3×3 place cell.
Those are two independent sources of hostile camps. Both must enter one encounter budget.
`detail_v3.go` also clears and connects entities, so fewer camps should mean fewer camp clearings.
Do not leave a carpet of vacant combat clearings after reducing only enemy visibility.

**Medium: a quick first patch can change generic camp counts from 1–2 to 0–1.**
The requested generic mean falls from 1.5 to 0.5, before placement failures and extra place camps.
That is a two-thirds cut to that source, not a measured two-thirds cut to all actual encounters.
Keep curated encounters and quest targets explicit. Give the tutorial one dependable encounter.
Do not globally change `campRespawnSeconds` yet; fixed and held content need separate treatment.
This is a cheap opening playtest, not the finished population algorithm.

**Medium: target the following surface densities for the finished plan.**
An ecology cell is 8×8 chunks, or 64 chunks; it is smaller than a biome region.
Scale budgets by walkable habitat area, so a large lake is not ringed with compensating enemies.

| Typical cell band | Hostile groups per 64 habitat chunks | Ordinary groups | Sign patches |
|---|---:|---:|---:|
| Sheltered | 0 | 4 | 4 |
| Watchful | 4 | 6 | 8 |
| Pressed | 6 | 4 | 8 |
| Deep | 8 | 2 | 6 |

These are expected allocations and upper starting targets, not guaranteed successful placements.
A hostile group is normally one creature; two become possible in pressed/deep territory.
Keep today's shared-fight scaling ceiling of five, fixed at first aggro; never enlarge a lone animal.
Baseline wildlife groups have 1–3 members. Signs are cheap ground detail, not active actors.
Apply a 0.5 hostile-budget multiplier in the Whitequiet. Its distinguishing feature is silence.
Caves use connected halls: start at one hostile anchor per 4–8 walkable chunk equivalents.
A small cave can have no fight at all. Every mouth is not a mandatory battle.

Require at least 36 world tiles between hostile anchors, including across cell boundaries.
Keep their active aggro areas apart when selecting positions. Signs can lead toward one group.
Reject occupied bottlenecks when there is no practical way to walk around the aggro area.
Start with 12 clear tiles at cave mouths and around ramp landings; verify the approach, not just a circle.
More dangerous ground changes composition and warnings before it changes the number of bodies.
A useful optional hard encounter is one conspicuous site in roughly 128 suitable chunks, replacing a slot.
Do not add that site as a bonus ninth encounter or duplicate the Warden as random wildlife.

Fill the intervals with terrain, views, water, footprints and occasional forage, not more icons.
A shorebird leaving reeds can point to an existing forage patch without minting a new loot source.
Some signs end at an empty roost. A discovery should not always require clearing enemies.
Do not multiply per-encounter material drops sixfold to preserve the old combat throughput.
Leave basic building materials available through peaceful nodes and future gathering loops.
Review resource-node clutter separately; this proposal changes combat density first.

**Medium: judge rhythm by walks, not only atlas averages.**
Start with a goal of 60–120 seconds between visible hostile groups on ordinary exploratory walks.
That is a playtest hypothesis; I did not measure movement speed or current generated density here.
Record distance, sightings, forced aggro and voluntary fights over repeatable routes in the lab.
A ten-minute zero-XP walk should have several useful sights and require no fight to return home.

## 3. Creatures per biome, good and bad

**High: separate species, ecological role, and combat behaviour.**
An ordinary beetle and an unmoored beetle can share anatomy without sharing interaction rules.
Ordinary animals are not attack targets, material sacks, or unearned Habitica pets.
Fever breaks on victory: the beast visibly steadies and flees; rewards come from the site aftermath.
Use existing material claims, not meat, skins or corpse harvesting. No new inventory economy here.
A completed beast encounter stays completed even while its recovery animation is visible.
Things of the Dark disperse instead. Classifying wisps that way needs the owner's lore decision.
Until then a role in the roster must not silently become new explanatory player text.

**Medium: this is the roster direction, with shared silhouettes deliberately repeated.**

| Habitat | Ordinary life | Unmoored beast | Proposed Dark encounter |
|---|---|---|---|
| Woods/meadow | Hare: freezes, then flees away from approach; tracks lead to glades. | Beetle: current zigzag scuttle; bait it into a tree for its stun. | Wisp: current short hop and clear wind-up; approaches open ground. |
| Lake country | Shorebird: keeps to banks; retreat reveals a forage spot among reeds. | Reed beetle: longer keep-away and recovery; shore geometry makes approach matter. | Shore wisp: slower hop rhythm on dry headlands; never demands entering water. |
| Uplands | Goat: browses near a pass; its tracks identify a usable ramp. | Stone beetle: longer wind-up, short scuttle; rocks offer deliberate stun opportunities. | Ridge wisp: short chase range and long recovery; protects an optional overlook. |
| Caves | Small beetles: retreat into cracks; a sign of connected dry floor. | Pale beetle: one conspicuous charge/scuttle lane per hall; walls are counterplay. | Hollow wisp: slow approach and a long warning; guides attention to an optional recess. |
| Whitequiet | Pale hare: rare motion; tracks remain readable against pale ground. | Rare fevered beetle: wakes only near its marked territory; never beside every Echo. | Quiet wisp: visibly rests before stirring; all attacks remain visible in pale scenery. |

These variants initially change tuning, habitat and spacing, not damage families or bespoke spells.
Preserve telegraphs of at least 0.5–0.8 seconds; none gets harder by becoming unreadably fast.
Low confidence: a later unmoored goat could commit to a single straight charge and wall stagger.
A later cave bat could retreat between perches, making it a different approach problem.
Neither is necessary to make 0.14's first cave legible or to ship the content seam.

A useful group does one thing: reveals a route, indicates forage, gives warning, or offers a fight.
Do not make every animal a follower, fetch quest, taming candidate and combat companion.
Keep future mount eligibility as a later species capability; do not build breeding or hunger now.
No native wildlife request crosses the Habitica seam. Existing pets remain their existing system.

## 4. The spawning algorithm

**High: plan habitats and territories across chunks; simulate actors only inside nearby chunks.**
Do not implement births, starvation, predator chains or world-wide population counters.
The interesting persistence is "this valley has life" and "we cleared this territory this wick."
It is not the exact location of an unseen hare three hours ago.

### Lasting candidates

A pinned biome provides habitat samples: shore, open ground, scree, trail margin, cave hall.
Use the agreed regional geometry and feature IDs for lakes, ranges and cave systems.
Divide each surface ecology cell into sixteen 2×2-chunk proposal areas.
Each area proposes one hostile anchor, with deterministic jitter, habitat tags and a hash priority.
Friendly groups and signs use separately salted proposals and budgets.
Include any suitable place landmark as a candidate, not as a second automatic camp generator.
A landmark's encounter consumes the same slot and spacing budget as a free-standing one.
Reserve fixed/story encounters explicitly; exclude their surrounding area from procedural proposals.

Evaluate terrain on a bounded stencil; do not create stored chunks just to search a region.
Use finite retries, say eight spots per proposal. If no valid spot exists, accept empty land.
Do not add a fallback that packs every failed shoreline proposal onto the nearest road.
A territory may span signs in several chunks, but its actor anchor has exactly one owner chunk.
At biome boundaries, the anchor's habitat selects its roster; its neighbours share spacing checks.
Use floor division for negative cell coordinates and include layer in every identity.

### This wick's occupation

Resolve the biome/version pins and current effective geometry first, including held neighbours.
Compute each cell's budget from care at the turning and suitable habitat area.
Select its quota by deterministic priority, with stochastic rounding for fractional habitat budgets.
Then reject any selected anchor within 36 tiles of a higher-priority selected neighbour.
Inspect a bounded halo of neighbour cells, including other biome versions, with a shared priority salt.
This can leave a cell under budget. Do not refill it: refill is where boundary/order bugs start.
Use shared, lasting candidate IDs for exclusion; roll occupancy and roster with the calendar wick.
Thus pressure and territory geography last, while a glade's visitors can change.

Only candidates that fit the live effective geometry can materialize.
Held terrain keeps its body; it does not need to preserve a hostile infestation indefinitely.
Keep encounter plans in a separate living overlay instead of rewriting pinned held chunk entities.
This is an intentional change from today's `loadFightChunk`, which uses a held chunk's old camps.
Avoid removing a player's props or finding a spawn by clearing a player's arranged ground.
Plan/occupancy identity includes world, realm, layer, owner anchor, biome life version and calendar wick.
Geometry epoch remains a separate value. A held geometry epoch is not the current calendar wick.

Keep the resolved care snapshot and content version, or the compact selected plan, for any served cell.
Do not save an empty record for every cell on the ±4,096-chunk map.
Store defeated encounters and claims sparsely. Retire ended-wick plans once no reader needs them.
Retain lasting pins and player map knowledge. Existing held geometry/claim records keep their rules.
A restart and a reverse-order chunk read must select the same plan and same completed groups.

### Respawn and live movement

**Medium: procedural hostile territories remain cleared until the next turning.**
Today's generic camp timer is 600 seconds. Do not apply that refill loop to every new territory.
Keep the old timer policy for explicit practice/story encounters where needed, as content policy.
No action should reset the weekly completion record merely by sleeping and waking its room.
Make this an owner choice: clearing a shared world can otherwise leave fewer fights for late arrivals.
Retain current coverage-based witnesses and once-only claims; changing reward eligibility is separate.
A late arrival can explore onward; a known practice site offers repeat fights without repopulating a route.

The existing fight room is keyed by world/realm/layer/chunk/geometry epoch.
Wake from the union of players' nearby 3×3 windows; load plans and geometry at lifecycle boundaries.
Retain the 10 Hz fight tick, existing scheduler, bounded outputs and 30-second sleep grace.
Do not query SQLite, generate regions or find distant light sources inside a fight tick.
Attach the life-plan revision to room membership; turning can renew life even on held geometry.
Flush completion before publishing it, as current fall handling does. Persist claims transactionally.
Close/reconcile old occupation at the turning without giving the same encounter two completion owners.

For 0.14, both hostile movement and ordinary group movement stay inside their owner chunk.
Ordinary groups can reuse the room scheduler with simple idle/flee states and shared snapshots.
Use a separate species targetability flag; friendly animals never enter attack prediction or loot claims.
Limit ordinary groups to three actors per occupied chunk and choose new idle goals at about 1 Hz.
Interpolate their movement using the same server time; do not run client-private interactive animals.
A group chooses connected ground with an escape pocket, away from a trail's main walking lane.
It can be only tracks when suitable room or art is unavailable.
Territories are landscape structure; cross-chunk migration is explicitly deferred.

Before levels/caves ship, movement, target selection, hits, scaling and witnesses must all agree on reachability.
No creature attacks a player on another terrace through a cliff. A ramp permits legitimate contact.
Cave and surface room keys are distinct; cave inhabitants do not wake just because someone stands above.
Entrance prefetch can load geometry, but only a connected nearby approach should wake cave actors.
Hostile flight across roofs/water and room-to-room pursuit are later movement capabilities.

### Day and night

**High: do not make real-world login hours change required combat difficulty.**
There is no established general day/night creature cycle in the code I inspected.
For 0.14 use wick/mark preferences and habitat; ordinary animals can rest occasionally while awake.
Later choose an explicit shared fictional phase clock, independent of a player's local timezone.
A phase can exchange one eligible occupant at a vacant anchor, within the existing budget.
It must not refill a defeated weekly territory, spawn under a player, or interrupt a fight.
Suggested later start: equal budgets, different species weights; night is not synonymous with the Dark.

## 5. Fit with the extension seam

**High: make a creature catalogue before promising that adding creatures is content-only.**
Currently `content/enemies.json` has typed wisp/beetle entries, and `fights/room.go` branches on kind.
The wire uses `FightEnemyKind`; adding an arbitrary JSON species is not sufficient today.
Change that closed assumption once, before the 0.15 freeze, rather than duplicating fights per biome.

Proposed new content lives in `content/life.json` and each versioned biome's `life` block.
The existing `content/enemies.json` can retain shared combat tuning during the migration.
Illustrative shape, not today's accepted schema:

```json
{
  "id": "reed-beetle", "version": 1,
  "role": "unmoored", "behaviour": "scuttle", "art": "beetle-reed",
  "habitats": ["dry-shore", "reeds-edge"], "groupSize": [1, 2],
  "danger": [20, 100], "weight": 3, "activity": "any",
  "combatProfile": "beetle-slow-recovery", "targetable": true,
  "onDefeat": "fever-break", "rewardTable": "camp", "renewal": "wick"
}
```

A biome supplies habitat weights, ordinary/unmoored/Dark roster references and density multipliers.
Group sizes must agree with encounter budgets; species weights cannot create extra groups.
Use a stable string `speciesId` in snapshots and content references, with shared pose/state vocabulary.
Do not use a catalogue array index as persistent identity. Reordering content must change nothing.
The client resolves art and feedback from the same catalogue; it does not decide attacks or occupancy.

Provide built-in behaviours `idle-flee`, `hop` and `scuttle`, with bounded validated tuning.
The fever-break outcome is presentation following authoritative completion, not a second HP system.
A future genuinely new attack can add a small Go behaviour to the same room/state machine.
If it needs new render effects, declare that honestly; a behaviour hook cannot conjure client art.
Do not embed scripts or arbitrary code in creature content for hypothetical future flexibility.

Suggested server pieces: `wilds/pressure.go`, `wilds/life_plan.go`, and a small `fights/behaviours.go`.
Integrate `gen_v3.go`, `cells.go`, `detail_v3.go`, `loot.go` and `api/presence_fights.go` deliberately.
Add the content schema under `proto/glimway/content/v1/` and update the presence contract once.
Use the existing chunk composer and holds resolver; do not create an alternate terrain generator.
A biome's small Go piece emits habitat hints; common life planning owns budgets and identities.

**High: verification belongs at these seams, not in a second ecology simulator.**
Check bounded density/spacing across negative coordinates, region edges and mixed pinned versions.
Check reverse generation order, restart, a new lamp, a warning wick, lapse and held/calendar-wick disagreement.
Replay fever-break completion/claim races and ensure sleeping never restores a completed territory.
Replay same-level, ramp and roof cases through targeting and damage, not just sprite rendering.
The world lab needs habitat, pressure, care, selected anchors, rejected anchors and density histograms.
Pair those atlas checks with the owner's walk; an average cannot prove a route is pleasant.

## 6. Art

**High: purchase silhouettes, then reuse animation grammar and palettes.**
Keep existing wisp and beetle animation families. Do not redraw the Warden for random encounters.
Beetle variants can share scuttle, squash and stun art with reed/stone/pale palettes and small markings.
Wisp variants can share frames; separate them from pale terrain with a consistent dark outline.
Unmooring also needs a shape/motion cue. A colour tint alone is insufficient.
Fever breaking can use a clean palette, a settling pose and ordinary flee motion instead of death art.
Signs can begin as small procedural tracks and existing disturbed ground/reed arrangements.
Do not generate a separate corpse, loot sack, portrait and icon set for each colour variant.

**Medium: the smallest useful new silhouette budget is three: hare, shorebird and goat.**
Each needs idle and a short move cycle; mirror directions where the existing style permits it.
The Whitequiet borrows the hare, differentiated by rarity, tracks and restrained palette.
Caves borrow tiny ordinary beetles plus existing hostile beetle/wisp silhouettes.
Thus five habitats need three new animal families, not fifteen new enemy sheets.
The goat need not have attack art in 0.14. Bat art and a proper unmoored goat wait.
If art is squeezed, ship woods/lakes animals first; uplands can start with goat tracks.
Do not relabel a recoloured beetle as a goat. An honest sign is better than a false silhouette.
Biomes can feel different through where life appears and what it reveals, not just exclusive species.

## 7. Slicing

**High: keep 0.14's promise about walking the world; life work should make those walks better.**
The biome roster above is a direction, not permission to add a full creature expansion to every slice.
A dedicated later creatures release can deepen it after the terrain and extension seam are settled.

| Agreed iteration | Life work to include | Playtest question |
|---|---|---|
| Before / 1. Walk any way | Cheap 0–1 camp fix; density overlays; identify all camp sources; preserve tutorial/practice sites. | Can I walk farther without constant combat clutter? |
| 2. Lake country | Pin pressure; catalogue/plan seam; woods/lake habitat budgets; signs; beetle/wisp variants; first ordinary animals if art is ready. | Does a lake walk differ from a wood walk without filling the shore? |
| 3. The Tops | Level-aware placement and fights; pass/ramp exclusion; sparse ridge tuning; goat or goat tracks. | Can I read a route and avoid being attacked through a cliff? |
| 4. Below | Cave-local habitat/relief; mouth warnings; hall budget; beetle/wisp reuse; ordinary small beetles. | Does a cave offer anticipation and room to withdraw? |
| 5. Far roads and tuning | Whitequiet life profile alongside its biome; map warnings; weekly plan/held reconciliation; lamp reaction; cross-biome density walks. | Do light and remoteness matter without becoming a combat tax? |

If Tops/Below swap, their life checks swap with them. They are terrain correctness, not optional polish.
If the plan seam slips, keep the density reduction and signs; do not ship half a migration on held land.
Keep existing camp lifetime until the life overlay can own geometry/weekly identity cleanly.
Whitequiet remains a biome deliverable; its life profile can initially be almost empty.

Before release, try weekly clearing versus timer refill in a controlled owner playtest.
Ship the full weekly policy only after completion, late arrivals and held chunks agree.
Keep tiers capped at 3 in every iteration. Do not stealth-add tier 4 through a "variant" HP multiplier.
Later: crossing chunk boundaries, true herds, flying bats, unmoored goats, taming, mounts and predators.
Also later: day/night schedules, territory restoration quests, lasting frets and settlement population rules.
Leave a versioned hook for these; do not simulate them now.

## 8. Open questions for the owner

1. **What should remoteness mean?** Distance from Hearthwick; distance from any tended place;
   or a combination with unlimited lamp stacking? **Recommend tended places, with capped relief.**
   A far camp should soften a region without converting all neighbouring wilderness into town.

2. **How much does a communal lamp promise?** Actual safe ground; a quieter approach;
   or merely a map marker? **Recommend quieter approach and fewer new encounters.**
   Keep town/home safety and unmooring recovery distinct unless you explicitly want to change them.

3. **Does clearing last?** Ten-minute refill everywhere; cleared for the wick;
   or weekly territories plus explicit repeatable practice sites? **Recommend the third.**
   It lets a group make a way quiet and still gives a late friend somewhere dependable to fight.

4. **Is danger mostly more bodies or more deliberate encounters?** Crowd density; stronger stats;
   or composition/territories/warnings at capped tiers? **Recommend the third, keeping tiers 1–3.**
   Far exploration should remain possible for someone with no XP or appetite for grinding.

5. **May we explain today's creatures?** Keep both mysterious; identify beetles as fevered beasts
   and wisps as Dark manifestations; or replace them? **Recommend the second as a lore decision.**
   Preserve beast nature and the fever-break ending. Owner writes the canon wording.

6. **How busy is the Whitequiet?** A hard enemy biome; an almost empty memory biome;
   or a rotating monster zone? **Recommend the memory biome, with roughly half the hostile budget.**
   An Echo is worthwhile by itself. Rare danger should be unusually clear against the silence.

7. **How much new animal art belongs in 0.14?** Three silhouettes; woods/lake animals only;
   or tracks and existing creatures until later? **Recommend woods/lake first, goat if time permits.**
   Habitat, scarcity and the extension seam matter more than completing a creature checklist.

8. **Should night restrict play?** Real-time danger hours; a fictional shared cycle;
   or no combat phase yet? **Recommend no combat phase for 0.14, fictional cycle later if wanted.**
   A person who plays after work should not inherit an automatic difficulty penalty.
