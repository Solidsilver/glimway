# Ideas

A canvas for ideas that come up along the way. Nothing here is planned or promised. When an idea
becomes real work, it moves into a plan or brief and gets a link here. Add freely and keep each
entry short.

Tags: **(agreed)** means the owner wants it and it has a place in the order; **(maybe)** means
worth thinking about; **(later)** means parked on purpose.

## Habitica integration
- **Gold purse** (agreed): at sign-in, with clear consent, move Habitica gold into an in-game purse.
  Gold flows into the game only and never pays out to Habitica. Allow 1–2 top-ups a day, probably
  with no cap on the amount. Research is in [habitica-gold.md](habitica-gold.md).
- **Gold and embers as two currencies** (agreed): gold buys shop goods and materials and trades
  between players; embers stay what you earn by doing things in the world.
- **Player shops** (maybe): players sell to each other for purse gold, perhaps from the gate shelf
  or a stall on the Commons.
- **Habitica wardrobe** (agreed): Habitica gear you own shows up in-game as cosmetics. Earning it
  stays in Habitica. See [habitica-boundary.md](habitica-boundary.md).
- **Pets and mounts as companions** (maybe): your Habitica pet follows you around the world.
- **Streaks and achievements** (maybe): earn recognition in the world, such as a plaque, a title,
  or a resident who remarks on it.
- **Party goals tied to Habitica tasks** (maybe): party members' finished tasks add up to something
  shared in the world, such as lighting a stretch of road together, so doing your dailies helps
  your friends.

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

## Social
- **Party notice board** (maybe).
- **See which friends are online, and where** (maybe).
- **Gate-shelf gifts flagged for party members** (maybe).

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
- **Lossy WebP for the people atlas** (later): it would roughly halve 1.4 MB, but the owner wants
  exact pixels for now.
- **A faster scene build on phones** (maybe): after the ground fix, about 0.4–0.5 s remains on a
  throttled phone, from props, portraits and the HUD's icons.
