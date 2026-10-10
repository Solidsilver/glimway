# Ideas

A canvas for ideas that come up along the way. Nothing here is planned or promised. When an idea
becomes real work, it moves into a plan or brief and gets a link here. Add freely and keep each
entry short.

Designed ideas now live in [design/](design/plan.md): the combined [plan](design/plan.md), the
open [world](design/world.md), [layers](design/layers.md), [pets](design/pets.md),
[magic](design/magic.md), [quests](design/quests.md), [fishing](design/fishing.md) and
[guests on the server](design/guests.md).

Tags: **(agreed)** means the owner wants it and it has a place in the order; **(maybe)** means
worth thinking about; **(later)** means parked on purpose.

## Habitica integration
- **Gold purse** (agreed): a Top-up button in the account settings first syncs the latest Habitica
  gold, then moves gold into an in-game purse, with clear consent. Gold flows into the game only and
  never pays out to Habitica.
  - **Limits:** 2 top-ups per UTC day, with no amount cap.
  - **Unknown outcome:** a top-up whose result is unclear is credited automatically once a balance
    check confirms it.
  - Research is in [habitica-gold.md](habitica-gold.md); the design to build is
    [design/purse-and-wardrobe.md](design/purse-and-wardrobe.md) (0.6).
- **Gold and embers as two currencies** (agreed): gold buys shop goods and materials and trades
  between players; embers stay what you earn by doing things in the world.
- **Player shops** (agreed, 0.6): a price in gold on a gate-shelf slot; gold also moves in letters
  and by hand. A stall on the Commons stays a maybe.
- **Habitica wardrobe** (agreed, 0.6): Habitica gear you own shows up in-game as cosmetics. Earning
  it stays in Habitica. Design: [design/purse-and-wardrobe.md](design/purse-and-wardrobe.md).
- **Pets and mounts as companions** (shipped in 0.5): choose which pet walks with you and three for
  the yard, and ride from the stable. See [design/crafts.md](design/crafts.md).
- **Streaks and achievements** (maybe): earn recognition in the world, such as a plaque, a title,
  or a resident who remarks on it.
- **Party goals tied to Habitica tasks** (maybe): party members' finished tasks add up to something
  shared in the world, such as lighting a stretch of road together, so doing your dailies helps
  your friends.

- **Backups for everything Habitica supplies** (agreed, standing goal): our own versions of the
  avatar (the player body), gear, pets and sprites, so a spin-off not tied to Habitica stays
  possible. Lean on Habitica's art for now.
- **Human-made art** (agreed, when resources allow): replace the generated art, and welcome artists.

## Story and world
- **A longer main road** (agreed, later): 2–3 chapters past the Warden, gated on real time and
  Habitica activity. Hooks: the lost expedition, the open account, the Sallow Ford lamp.
- **The Dorrit keepsake** (agreed): it completes the Echo set.
- **The carter's map** (agreed): a world map of places you've seen and the way toward your goal
  (UI step 10).
- **A paved village square** (maybe): the new flagstones only appear in the Commons, and paving
  the village square would change its layout.
- **Farmland in homestead gardens** (maybe): the farmland tiles are delivered but unused.
- **More resident routines** (maybe): the owner likes the strolls and the bench sit; more people
  could have small daily routines.

- **Fishing** (maybe): a rules-based fishing system worked out lazily from elapsed time. Any body of
  water large enough in a scene (one navigable screen) may hold fish; which waters have fish is
  still to decide.
  - **Pond size** sets the most fish a water can hold.
  - **Repopulation** follows a rate over time, computed when someone enters (no background ticks).
  - **The current stock** decides which species bite and how long a catch takes. A near-empty pond
    fishes slowly.
  - **A water can be fished out** for a while, with a small "a fish got in here somehow" chance.
  - It's all deterministic and server-checkable, like gathering.
- **More variety beyond the Tangle** (maybe, needs a brainstorm): mountains, lakes and rivers, and
  later caves, plus ways to go past the Whitequiet. Unlock those only once players have a way back
  (a map, breadcrumbs, or a door or teleport item). This needs a better generation system; hold a
  brainstorming session when we explore it.

- **Exploration for every class and playstyle** (maybe): the Wilds and future expansions give each
  Habitica class (warrior, mage, healer, rogue) and each playstyle (fighting, gathering, crafting,
  exploring, socialising) something worth doing out there.
- **Tunnels and caves** (maybe): dig or explore tunnels and caves for spelunking and boss fights.
  Keep it simple. Needs the layers idea below.
- **Layers, interiors and multi-storey buildings** (maybe, needs design):
  - a layer system for going underground;
  - entering a house as its own area, which allows richer interiors;
  - both together for multi-storey buildings and floors.
  - Some residents could mostly live indoors, so you go inside to talk to them, which leans
    naturally into shops.

## Standalone version (later)
Glimway without Habitica, with Habitica as one mode. The owner plays with Habitica, so this waits.
- **Guest accounts** (agreed, designed): key phrase sign-in, devices, linking. Steps 3–6 of
  [design/guests.md](design/guests.md).
- **Embers without Habitica** (needs a design session): today guests earn embers only from story
  and gifts, so ember gates stop them. A standalone game needs its own source.
- **Our own look, classes, levels and companions** (agreed, standing goal): the backups listed
  above, plugged in through the profile source.

## Social
- **Party notice board** (maybe).
- **See which friends are online, and where** (maybe).
- **Gate-shelf gifts flagged for party members** (maybe).

## Game systems (design sessions)

- **A pet overhaul** (maybe, needs a design session): pets come from Habitica but feel tacked on
  today. Ideas: pet storage, mounts done properly, and pets that matter in the world. Check against
  [habitica-boundary.md](habitica-boundary.md).
- **A bigger magic system** (maybe, needs a design session): today there's a single Fingersnap
  ability. Expand it into a real system, perhaps tied to class.
- **A quest overhaul** (maybe, needs a design session):
  - quests as a tree, so new ones can be added over time;
  - the first quest is a "tutorial by doing" without feeling like a tutorial: it teaches the
    guided-task system, talking to people, using your weapon, and so on.

## Polish
- **Sound** (agreed): ambience, UI sounds, footsteps. `ASSETS.md` lists audio as pending.
- **Player body** (agreed): a hero that turns, walks and swings, recoloured from your Habitica
  look (art round 3, optional item).
- **Phones at full screen resolution** (agreed): the art is 4×, and phones show only 2× today.
- **UI steps 6, 8, 9 and 11** (agreed): panels that open on what matters, desktop UI scale and
  keys at hand, a real pause menu and settings, wide-screen side panels and haptics. See
  `../fingersnap-wt/ui/.agent/UI-REVIEW.md` (to be moved into docs).
- **A "What's new" card** (agreed): fed by the player-facing lines in the changelog.
- **The demo hero holding tools** (maybe): guests can't show a held tool because the blade is
  drawn into the demo frames.
- **Transition art as a 47-piece blob set** (later): only if the procedural edges ever disappoint.

## Platform and operations
- **Versioning** (agreed): semver 0.x, tags, `CHANGELOG.md`, the version in the Menu, and a
  "new version, reload" prompt.
- **Client error reporting and basic server metrics** (agreed).
- **Automated database backups** on the home server (agreed).
- **Scaling** (later): notes in [scaling.md](scaling.md). Measure before acting.
- **A binary wire format (protobuf) for presence** (later): see [scaling.md](scaling.md).
- **Lossy WebP for the people atlas** (later): it would roughly halve its 0.7 MB, but the owner wants
  exact pixels for now.
- **A faster scene build on phones** (maybe): after the ground fix, about 0.4–0.5 s remains on a
  throttled phone, from props, portraits and the HUD's icons.
