# Fishing

Status: core player choices settled with the owner, 2026-10-07. One-press reeling,
Keep/Release, cooking and gifts, the 10–60-second stock-dependent wait range,
dependable everyday home fish, year-round mill-race access and shared depletion
without a personal daily quota are agreed. Docks and ice
fishing are wanted as later possibilities; their scope and release are open.
A pet use is also parked. Remaining numbers and detailed rules are proposals.
The combined plan fixes release
placement: mill pond and one recipe in 0.4, generated waters in 0.6, home water
in 0.9 or later. This remains design work only.

## Pitch

A few quiet casts between journeys: find a bank, watch the float, bring
something home for the hearth or a neighbour. The water remembers what people
take; leave it alone and fish return. Fishing should make places worth visiting
without making a player feel they ought to stay logged in.

## Layers and build costs

| Direction | What feels good | Trade-off and build cost |
|---|---|---|
| Quiet shared bank | Cast, wait briefly, press Reel when ready. Fish become supper and gifts; friends affect the same water. | Recommended starting point. Moderate work: shared stock, timed server operations, shoreline interactions and art. Depletion needs care so late arrivals still have a pleasant visit. |
| Angling and exploration | Different waters and stock levels offer different species; learning habitats and a journal give reasons to roam. | More rules, content and journal UI. The owner chose one-press reeling throughout; species variety does not introduce a skill check. |
| Tending a home water | Deed members share a pond or stream, improve its bank and give away their catch. | A social home activity, but the largest scope: water eligibility, permissions, new home goods and balancing stocking against unlimited production. Private waters can draw people away from shared places. |

Owner preference: **all three appeal**. Proposed structure: one shared catch
and stock system, with the bank ritual first, discovery second, home tending
third, following the agreed release order. The main player choices below are
settled; proposed tuning and implementation details remain to verify before
a build brief.

## Fishing decisions (owner, 2026-10-07)

1. **One press per Reel.** After the bite, one E/Space press or one tap on Reel
   lands the fish. No hold-to-reel, repeated tapping or timing minigame. Cast
   remains a separate action, followed by the agreed Keep/Release choice.
2. **Dependable everyday fish at home.** Home water supports ordinary cooking
   and gifts. Some species remain tied to other habitats, so improving a home
   pond does not replace exploring. This describes its species role, not an
   unlimited supply: home water still has capacity, depletion and lazy recovery.
3. **Short casts, slower at scarce waters.** About ten seconds in healthy water,
   around thirty at low stock, and up to sixty at very low stock. Exact fullness
   thresholds are tuning proposals. This is the wait until a bite, not a deadline
   for pressing Reel.
4. **Cooking and gifts first.** One useful hearth dish and existing gifts/mail
   form the initial use of fish. More recipes and resident reactions can follow.
   The owner suggested pets as a possible later use; its meaning and scope are
   still open and must fit the existing companion boundary.
5. **Keep or Release.** After landing, the player chooses. Keep grants the fish
   to their pack; Release returns it to the same fishery and pays no item or
   currency. Released fish never become a transferable live-stock item.
6. **Winter access at the mill-race.** One bank stays open in Quiet, so the
   first fishing release remains usable year-round. Ice fishing can come later,
   alongside docks; neither is a prerequisite for 0.4.
7. **Shared depletion, no personal daily quota initially.** Everyone draws
   from the water's shared stock. The server enforces the cast wait, one active
   cast per account and attempt/request rate limits to prevent rapid-cast abuse.
   A daily take cap is not part of the initial design. Revisit one if group
   playtests show monopolization, and before any future fish-selling economy;
   it would be account-wide and would not reset on a world move or profile link.

## Coordination with the world design

The owner has chosen server-side generation of an open map in 24×24-tile
chunks, with lake country first. Final reference copies read 2026-10-07:
`.agent/ref/plan.md`, `.agent/ref/guests.md`, `.agent/ref/world.md`. Their agreed
cross-design decisions override earlier draft dependencies here. These are
planned changes to today's code, not features already shipped here.

### Release placement and shared foundations

- **0.4 Crafts:** the mill pond, a rod, the first fish and one useful recipe.
  This uses a curated server-known fishery and does not wait for the open-map
  generator. Guest identity steps 1–2 land here without changing sign-in
  behaviour; playable guest accounts follow in 0.5.
- **0.5 The open map:** guest sign-in, removal of local-only play, the shared
  world-change foundation, server generation and per-chunk epochs. Guests
  gain the full mill-pond feature through the same item and fishing paths.
- **0.6 Lake country:** generated fisheries, new habitats/species, reed and
  clay, crossings and pottery. Rod access and fishing are never class- or
  level-gated. Tool ways give guests access to banks beyond obstacles too.
- **0.9 or later:** home water and tending. A journal and extra recipes can
  be small additions when their content is ready; they do not block 0.4.
- Use the **single interactions path** from cleanup before 0.3 for Cast/Reel,
  rather than adding another target-selection loop. Use the agreed shared
  **clock helpers and test vectors** for recovery and turn boundaries.
- Use opaque **`account_id`** for casts, caps, grants and ownership. Linking or
  unlinking Habitica changes the profile source, not fish inventory, cast
  identity or cap history. The guest and Habitica paths share the same rules.
- Integrate generated stock with the agreed **world changes with expiry**
  foundation: world, realm, layer, chunk, epoch and entity identify a change.
  Fish retain their own recovery timers. Chunk replacement ends that water's
  state; preserving a chunk preserves its fishery, with recovery still capped.
  Do not treat recovery as either a permanent loss or a magical change that
  resets every wick, and do not invent another generic expiry framework.

### Fishery contract

- The generator supplies authoritative fisheries: `water:<chunk key>:<n>`,
  water-tile area, habitat (`still`, `flowing`, `reedy`) and bank tiles.
- One water is one connected body inside one chunk. A lake across two chunks
  has two fisheries. Bridges and fords never split a fishery.
- A weekly reshuffle gives an unpreserved chunk new waters with fresh stock.
  Waters in preserved, lit chunks keep their stock and recover normally;
  lighting a lamp does not itself refill them.
- Fishing owns eligibility thresholds, capacity, recovery, species and catch
  rules. It consumes the generator's descriptors rather than discovering water
  from client terrain. Keep mutable stock separate from the stored chunk blob.
- Persistence and casts must include world, realm, layer, chunk and its epoch
  as well as the descriptor ID. A reused local index cannot make an old cast
  settle against a newly generated water. Curated fisheries use stable place
  IDs and do not acquire a new generation at the weekly Turning.
- Lake country brings a reed material. A reed float or home reed pot is an
  available crafting hook; tackle remains optional. A reed pot does not count
  as new water area or multiply fish production. Passive fish traps are not
  implied by this material hook.
- Guests are invite-only server accounts and get **all fishing**, homesteads,
  crafting, gifts and mail. The no-server game is dropped. Fishing grants need
  a connection; the connected offline cache cannot authorize catches or edit
  stock. Guests earn embers from story and gifts only, so fishing must not
  introduce an alternate ember income. Their lack of class, level or companions
  never reduces fishing access or the catch odds.
- Permanent, material-built way-lamps preserve chunks; temporary mage-lit rest
  lamps do not. Read the world's authoritative preservation decision rather
  than inferring it from a glowing sprite. Reaching lake-country fisheries in
  0.6 does not require 0.8 way-lamps or the mage's later Old ways.
- Pottery in 0.6 is taught by Finn through Aldo's kiln project. If a future
  reed margin uses a crafted pot, reuse that kiln and recipe system. The first
  fishing rod, fish recipe and float cannot require lake-country reed or clay,
  since they ship two releases earlier.

## How the three fit together

### 1. The shared bank: a small ritual

Example visit: walk to the mill pond, select the rod, see “Little rings among
the reeds,” and Cast. The float bobs for roughly ten seconds. A dip, a soft
sound and the Reel button say the catch is ready. Press Reel, see a brief
landing animation, then choose Keep or Release. Two fish can become supper;
one can go to a friend's mailbox. The next visit is a little quieter because
someone has been fishing.

The bank can offer a few reachable standing or sitting positions. These are
places to stage the animation, not exclusive resources: two players can fish
alongside each other without having to claim a seat. Friends share the water,
not a competitive minigame. Optional presence messages can show casting and
landing; that needs new cosmetic presence states, not shared combat.

**Chosen catch feel: one press per Reel.** After the bite, Reel plays the
landing animation without further input. Cast and Reel are two separate
actions; no holding, repeated taps or reflex test. The suggested ready state
has no short failure window, with interruption and abandoned-cast rules still
to settle. Keyboard and touch use the same rule.

The owner chose **Keep/Release**. Proposed settlement: keeping commits the
fish to inventory and its use of the rod; releasing returns the reserved fish
to the water and pays nothing. This needs a pending
catch state until the choice is made. Abandoning that state should release it
through the same lazy hold-expiry rules. The release choice must not permit
unlimited rerolls for rarer species.

Depletion should be readable through rings, float activity and a short bank
description. Avoid naming who emptied a pond. The owner chose shared depletion
and server rate limits without a daily take quota. Test the mill pond with
several friends, not only a solo account; tune capacity and recovery before
adding another limit.

**Incremental cost:** the main fishing foundation is medium scope: water
definitions, stock rows, cast lifecycle, tool action and catch presentation.
The chosen one-press interaction keeps input work small. Sitting and shared
fishing poses add animation and presence work; they can follow the first release.

### 2. Angling: learn the places

Give waters a small set of habitat tags, such as still, flowing and reedy.
Start with three species and one distinguishing visual for each. Illustrative
names, not canon: mill roach in the pond, Wend dace in flowing water, reed
perch in backwaters. Each species has a useful culinary role, not just a rarity
colour. A modest fish journal records its first catch, the habitat and a
resident's note; “best size” and collection prizes are unnecessary initially.

For example, an abundant reedy pond might weight two common fish at 70/30.
When its stock is low, use a different table and a longer wait. That can make
species respond to depletion without maintaining a population per species.
If a desirable species only appears at low stock, players will deliberately
empty ponds; prefer making unusual fish more likely in healthy suitable
habitats, while some hardy common fish persist when stock falls.

Habitat selects the eligible species; fullness chooses weights and wait.
The server computes both when accepting a cast. A separate server-owned cast
sequence determines the roll. The client never submits which fish bit.

Discovery comes from visiting another bank and reading the water. Recipe pages
can make a new species useful: a river broth, a pan-fried pond fish, a packed
supper. As a discussion recipe, one fish, one wild thyme and one well water
could make a single serving with a small existing HP-restoration effect.
Actual quantities and effect remain untuned. A shared supper contribution or
resident response should be optional and bounded, without daily gift chores.
The 0.4 recipe must also be useful to guests after 0.5: guests have mana but
no signature ability, so a mana-only dish is a weak shared first recipe.
Preserve the existing zero-HP lock and compare the dish with today's food.

Seasonal differences could follow the existing Marks later, but start with
species always obtainable somewhere. Real clock-time windows would make
players' schedules matter too much. The owner chose an open mill-race bank
for Quiet. The rest of the pond can keep its existing ice and frost-glass
gathering; both activities refer to the same underlying water, so the winter
fishing bank does not add capacity or create a second stock pool.

**Incremental cost:** curated habitat tags, species weights and recipes are
low-to-medium additions to a working fishing system. A journal is another UI
feature. The agreed world generator supplies authoritative fishery descriptors,
so lake-country support needs endpoint/rendering integration and mutable stock
per chunk generation, without a second terrain generator or Go/TypeScript
water-generation parity work.
Adding species populations, sizes, bait or tackle multiplies balancing and
inventory work, so none is assumed for the first version.

### 3. Home water: a place to care for

A home stream uses the same stock rules as a public fishery, keyed to its
homestead. Everyone on the deed shares it. A suggested default is members-only
fishing, with a home setting allowing visitors to fish; visitors never move
improvements. Fish and meals can still be given freely.

Tending could be lasting changes rather than maintenance:

- **A bank seat or small landing:** makes a pleasant place to fish, without
  producing more fish. This fits placed home goods most closely.
- **A planted reed margin:** adds habitat for one suitable species. Count one
  improvement of this kind per water, so twenty reed pots do not create twenty
  bonuses. It changes the catch mix rather than its water-size capacity.
- **A repaired inlet:** for a suitable stream, a one-time project could improve
  recovery modestly, for example by 20%. Still bounded by capacity; no feeding,
  cleaning meter or loss for staying away. This is optional extra balancing.

**Chosen relationship to exploration:** home water reliably provides everyday
cooking fish; other habitats have species a home cannot host. Homebodies have
a comfortable activity and explorers a reason to find other banks. Habitat
improvements may broaden the everyday catch mix, but do not remove those
species restrictions. The exact species lists remain to design.

Today's homes have a stream chance, not a pond for everyone. There are two
scopes: first support existing streams, with public fishing available to all;
later let Silas lay out a small pond on a valid clear footprint. A built pond
needs persistent water tiles, placement checks, collision updates and protection
from erasure while casts are pending. It is a land feature, not merely a pond
sprite placed over grass. Existing homestead generation should stay stable.

Do not start with moving caught fish between waters. Transferable live stock
needs a distinct item lifecycle, habitat checks and careful conservation so a
gift, released catch or duplicated request cannot create fish. Natural recovery
and habitat improvements deliver much of the tending feeling for less work.

**Incremental cost:** fishing at existing home streams and a decorative bank
seat are medium scope, mostly fisheries metadata and deed permissions. A reed
habitat improvement adds placed-item-derived rules. Digging ponds and stocking
them are large additions to land editing and the economy. Extra art includes
the bank seat/landing, a planted reed margin, and eventually pond edges and
inlet details; improvements should visibly explain what they do.

### Docks and ice fishing, later

The owner likes both as later additions. Their release is unscheduled; they
should extend the chosen catch loop rather than delay mill-pond fishing.

**Docks:** a small timber landing with room to stand or sit together. At home
it is a deed-shared build; a public dock could be a village project or a
material-built world change. Initially it gives access and a pleasant place
to fish, without increasing stock, catch speed or rarity. A natural bank still
works, so no player needs a dock to use a fishery.

For generated waters, reuse the agreed material-built expiry: the dock lasts
until its chunk turns, or permanently in preserved lamplight. It extends
validated fishing access to its edge while retaining the same water ID and
water-area capacity, including water under its boards. Start with a footprint
inside one chunk; spanning chunks adds construction and turn-seam rules.

**Build cost:** medium addition after the catch loop: placement on the bank
and over water, a walkable collision overlay, cast reach from the dock edge,
deed/world permissions and pending-cast handling when a structure changes.
Art needs a pier/landing, supports, readable edges and optionally a seat,
with shared sitting/fishing poses if those are not already available.

**Ice fishing:** in Quiet, use a pick at a marked reachable edge to open a
hole, then use the same rod, Cast, one-press Reel and Keep/Release. An initial
version keeps the player on the bank; it need not add walking on frozen lakes.
Use the current `pond-ice`/pick interaction as a starting point, separating
the existing frost-glass grant from opening a valid fishing access point.

The hole accesses that water's existing stock; cutting another hole cannot
reset stock, increase capacity or grant another stray-fish chance. The server
checks the season, underlying fishery and bank reach. The opening could last
through Quiet (or until its unpreserved chunk turns), avoiding repeated upkeep.
Season-end and chunk-turn expiry are computed lazily. Exact opening lifetime
and species changes are later design choices. No cold meter, drowning or
new survival requirement is proposed.

**Build cost:** small-to-medium for bank-side holes and existing pick rules;
larger if players later walk on ice. Art needs ice water treatment, a visible
hole and chipped rim, an opening effect and the float/line treatment at the
hole. Coordinate the seasonal ice art with lake country. The open mill-race
remains available for anyone without a pick.

## Starting rules to explore

- Generated water follows the agreed per-chunk definition above, independent
  of camera size. Curated scenes and homes need equivalent explicit fisheries.
  A phone viewport, bridge or ford must not change identity or capacity.
- Size means water-tile area, with a reachable, safe bank required. The minimum
  area and whether narrow streams qualify are open. Decorative puddles need
  not all become fishing targets.
- Public stock belongs to the Glimway world and water, including in a party's
  world. Separate worlds have separate stock. Home water, if included, belongs
  to the homestead; visitor fishing needs an explicit design decision.
- Refresh stock on entry, inspection and fishing operations. Entry alone is
  insufficient when several people remain at one pond. No background ticks.
- Preserve fractional recovery between reads; stop accruing recovery at full
  capacity. Repeated inspection must neither speed recovery nor discard it.
- A cast's wait and species weights depend on the stock at its accepted start.
  Scarce stock takes longer. Freeze the result for that cast so cancelling,
  reloading or retrying cannot reroll it.

For a prototype, compare these deliberately small values:

| Knob | Discussion value |
|---|---|
| Eligible water | At least 6 water tiles and a reachable bank; proposal |
| Small / medium / large capacity | 6 / 12 / 24 fish for 6–23 / 24–63 / 64+ water tiles; proposal |
| Recovery | One fish per 10 minutes, up to capacity; larger-water rates open |
| Wait at healthy / low / very low stock | About 10 / 30 / up to 60 seconds; agreed range, fullness thresholds open |
| Catch interaction | One press per Reel (agreed); readiness without a short failure window is the suggested rule |
| Active casts | One per account, across devices and worlds |
| Rod wear | Proposal: one use per kept fish; Release and cancelled casts do not wear it |
| Personal daily take quota | None initially; agreed. Shared stock and server rate limits apply |

Healthy water permits a short bank visit; very scarce water can take a full
minute for one bite. Say that the water is very quiet before the player commits
to the cast. Test the pace with both a solo world and a group arriving together.
Species and their stock-dependent weights are not chosen. Recommended first
model: one total stock count with habitat/fullness-weighted catches. Separate
populations for each species cost more to balance and explain and are not
needed for the first release.

Suggested tuning thresholds, not owner-approved numbers: healthy at 50% stock
or above (10 seconds), low at 20–49% (30 seconds), very low below 20% but nonzero
(60 seconds). Compute fullness before the accepted cast reserves its fish.
An empty water does not promise a bite; an available bounded stray-fish event
can later offer one through the same catch path.

### Depletion, fairness and the stray fish

A depleted water should say so before asking for a long wait: “Very still
here. Try another bank, or let it rest.” Avoid refill notifications or an
exact countdown that asks people to race back.

The requested “a fish got in here somehow” chance should be a deterministic
event tied to a water and elapsed-time interval, with at most one shared
claim from that event. It must not be a fresh roll on every visit or cast.
Its frequency, odds, lifetime and interaction with normal recovery remain
open; it is a little surprise, not an unlimited fallback supply.

Concurrent casts need a clear promise. Suggested approach: reserve a fish
when a cast is accepted, so a friend cannot take it during the wait. Count
reserved fish against capacity; cap holds and release abandoned ones lazily.
Cancellation returns that fish and preserves its roll until the hold ends.
This adds bookkeeping and can be used to block stock; compare it with settling
casts in order and allowing an honest “nothing this time” result before choosing.
Neither approach should lock a whole pond for one player.

## What fish are for

**Agreed:** start with one useful hearth recipe and giving raw fish or cooked
meals through existing gifts and mail. A recipe from Hazel or a bank
conversation with Finn would put a person behind it; these are writing
suggestions, not new canon.
Fish do not rot, and meals carry the existing maker's mark.

Use existing consumable effects if a meal helps the player. Its recipe cost
and effect need balancing against today's food; it must respect the existing
zero-HP restriction rather than replace an earned-ember rest.

Later possibilities: a resident accepting supper with a quiet response, a
recipe paper, or a small fish journal. Each needs its own scope. No repeatable
ember payout, Habitica gold, XP, equipment, Habitica pet food, pets or mounts.
Displayed fish would need a separate boundary review; an aquarium is not assumed.

### Possible pet interaction, later

The owner's “maybe pets later” is parked as a use to explore, not permission to
grant companions or duplicate Habitica's feeding system. A compatible starting
idea is **show a fish to an already-owned companion**: it sniffs, watches or
shows a small happy reaction. The fish remains a Glimway cooking supply; this
does not create a pet-food item, feeding progress, growth into a mount, hunger,
bond stats or a Habitica write. Guests still have no Habitica companions and
retain every functional use of fishing through cooking and gifts.

This would integrate with the agreed companion feature. Its interaction,
species-appropriate reactions and any animation work need a separate small
design pass. Coordinate with the companion design before treating an
interaction or art requirement as settled.

## Fit with today's build

- `content/gathering.go`, `content/gathering.json` and `src/lib/gathering.ts`
  provide a pattern for shared, validated rules. They currently describe
  chop/break/dig, not timed casts or shared fish populations. A separate
  fishing rule module is likely clearer than adding fish to gathering yields.
- `server/internal/api/items.go` already performs tool wear, inventory grants,
  caps and ledger changes transactionally. Fishing needs new persistent water
  and cast state plus start/settle/cancel operations, using the existing play
  lease, revision queue and idempotency rules. Account IDs, the interactions
  cleanup and the protocol migration land ahead of this feature; implementation
  should use those foundations rather than the old Habitica-only identifiers
  or a new JSON-only API alongside the agreed protobuf contract.
- Ordinary gathering checks area, tool and caps rather than each scenery
  tree. Fish capacity requires stronger water validation: clients cannot
  submit their own pond size or invent a water ID.
- `src/game/worlds.ts` has the village mill pond and Brackenwood stream.
  `WorldData` has no fisheries list. The village pond is the smallest first
  slice: add a matching server-known definition and reachable bank targets.
- Today's `src/lib/wilds/types.ts` and `gen-v1.ts` distinguish server-reproducible
  entities from client-only terrain. The chosen world rewrite replaces this
  split for gameplay terrain and supplies fishery descriptors. Fishing should
  integrate those descriptors and the new per-chunk epochs; no client terrain
  port is needed. Coordinate dependency timing with the world rollout.
- Generated homesteads can have streams. Their fishing rights must follow
  joint deeds and world moves, rather than assuming one player owns a plot.
- A rod needs a new tool action in `content/items.go`, `src/lib/items.ts` and
  `src/lib/belt.ts`, with action prompts, touch controls and world interaction.
  Register it with the shared interactions path. Fishing should use the
  existing E/Space action and a large Cast/Reel button.
- Fish can be Supplies using existing stack items; rods can use tool instances.
  `content/crafting.json` already includes bench tools and `hearthRecipes`,
  validated by `content/workshop.go` and `src/lib/workshop.ts`. A rod recipe
  and a fish meal can extend those paths rather than needing a new crafting UI.
- Today's `src/game/items.ts` says guests do not have the connected
  tool-instance inventory or belt. The agreed 0.5 guest rollout gives them the
  same item/cast paths and all fishing. The 0.4 slice must be ready to support
  profile source `none`; no local fishing implementation is needed. Shared
  catches require a connection and cannot come from an offline save upload.

Habitica remains read-only. The rod is a working tool, never worn stat gear;
fishing art must preserve the imported hero's worn gear. Check proposed item
names and uses against the boundary before implementing content.

## Abuse and interruptions

- Server time decides recovery and readiness. Use integer arithmetic and
  shared vectors; advancing time in several reads must match one elapsed read.
- A server-owned cast sequence seeds outcomes. Client request keys provide
  idempotency, not a way to pick a favourable roll.
- Reserve/release, settle, wear, stock decrement and inventory grant must be
  atomic where relevant. Replaying an old settlement cannot pay twice even
  after the ordinary request-response cache expires.
- Reloading, taking over a device, moving worlds and an outer Turning need
  explicit cast rules. Old-epoch casts must not grant new-epoch fish.
- Rate limits, enforced cast waits and shared recovery bound yield, with no
  personal daily quota initially. Rate limits apply per account across worlds
  and devices. Cancelling cannot bypass the next allowed start or a full cast
  wait. Do not copy gathering's client-supplied visit identifier as a fishing
  reset mechanism.
- Movement and damage interrupt the presentation safely. Whether a ready
  catch survives a closed tab, and how long an unclaimed reservation lasts,
  depend on the owner's preferred feel. No automatic repeated casting.
- Position checks use the existing invite-only trust model; they cannot prove
  that a modified client watched the float or performed a gesture.

## Art and content request

**0.4 art round:** a rod inventory icon; a rod/line casting and reeling presentation
that fits guest and imported heroes without covering Habitica gear; a readable
float with idle, bite and landing frames; the first fish icon;
one cooked dish icon. Specify native pixel sizes and atlas placement using
the existing art pipeline when the animation frames are specified. Combine this into
the release's single written art request, as required by the combined plan.

**0.6:** further species icons and any additional dish or tackle icons. Reuse
the world art round's water, shores, reeds and crossings. A reed float is
optional at this stage, not a dependency of the 0.4 float.

Reuse existing banks and water for the first slice. A seat, fishing dock,
ice-fishing hole, journal illustrations or new NPC would each add another
art request. Float feedback needs a visual cue alongside optional procedural
sound, and a calm reduced-motion version.

## Open tuning and implementation details

No unanswered player-choice question is pending from this conversation.
Before a build brief, settle or verify:

- Water-size eligibility, capacity, recovery rate and the proposed fullness
  thresholds; tune them with a group at the mill pond.
- Cast reservation lifetime and interruption rules, including a closed tab,
  takeover, movement, damage and world moves. A short missed-bite window is
  not proposed; abandoned holds must not lock water indefinitely. Exact hold
  duration and any renewal behaviour remain open.
- Attempt rate limits, atomic Keep/Release settlement and the proposed wear
  rule, so retries and cancellations cannot create fish or bypass waits.
- First rod source/cost, fish species and recipe quantities/effect. A rod
  should be available without needing the player's own workshop; the early
  source is still a content decision. Rods remain working tools, not gear.
- The bounded stray-fish event's odds, interval and lifetime, for generated
  waters in 0.6. Its event identity must survive retries and repeated visits.

Home permissions and improvements, docks, ice fishing and a pet interaction
can be detailed before their later releases. Docks and ice fishing are liked
later additions with unscheduled scope. The pet idea remains parked for
companion-design coordination.

## Build order within the agreed releases

1. **0.4, rules and stock:** one curated mill-pond descriptor, one rod and one
   species; shared stock, clock-based recovery and account-keyed casts. Verify
   fractional recovery, full-capacity behaviour, concurrent holds and retries.
2. **0.4, complete activity:** Cast/Reel through the shared interactions path,
   Keep/Release, rod wear, inventory grants, one hearth recipe and existing
   gifting/mail. Include the introduction and release art. Verify phones,
   reduced motion, damage/movement interruption and the pond's winter access.
   These first two steps together are the minimum fishing release.
3. **0.5, guest integration:** verify the same activity for guest accounts,
   including rods, recipes, gifts, cap continuity when linking Habitica, and
   connection loss. Consume the shared clock/world-change foundations as they
   land; do not add a second guest or expiry subsystem.
4. **0.6, lake-country fishing:** consume authoritative descriptors; add habitat
   tables and a few species, and settle stock-dependent waits/weights and the
   bounded stray-fish event. Verify bank reach, bridges/fords, chunk-edge lakes,
   weekly replacement and preserved-water stock. A small journal or additional
   recipes can follow this slice without blocking the generator integration.
5. **0.9 or later, home water:** existing streams and deed permissions first,
   then seats and habitat improvements. Building ponds and transferring live
   stock remain separate larger steps, subject to the owner's choices.
6. **Later, unscheduled:** docks and bank-side ice fishing, each a small
   extension with its own art in the chosen release's request. Validate access,
   stock conservation and material-build/seasonal expiry before adding them.
