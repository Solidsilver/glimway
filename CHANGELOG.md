# Changelog

What changed in each release of Glimway. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (0.x for now: anything may still
change). How to cut a release: [docs/releasing.md](docs/releasing.md).

Each release has two parts, always in this order and with these headings, so
the game can show the first part as "What's new":

- `### For players`: short, plain lines about what you'll notice in play.
- `### Technical`: what changed for people who run or work on Glimway.

## [Unreleased]

## [0.6.1] - 2026-10-10

### For players

- Embers and the purse's gold are now one currency: glims. A glim is a bead
  of amber holding a glint of light. You earn them from Habitica XP as you
  earned embers, 10 XP to a glim.
- The gold you had in your purse was turned into glims, two gold for each
  glim.
- One counter on the screen, glims, on desktop and phones.
- In the Menu, **Turn gold into glims** spends Habitica gold, two gold for
  each glim. You pick the glims and the card shows the gold. **Max** fills in
  the most you can get. You can get up to 30 glims a day this way, in up to
  two top-ups.
- The purse log is now the **Glim log**.
- Every good has one price, in glims. Silas's bundles cost 3 or 4 glims.
- Shelf prices, letters and gifts by hand use glims. Glims you get from a
  friend or a top-up can't pay for a rest at 0 HP; only glims earned from XP
  can.

### Technical

- Contract 7: `PlayerState.glims` (a new `Glims` message), glims fields on
  quest steps, buys, gives, mail and the purse (`Purse.glims_left`,
  `PurseTopUp.glims`). The old ember and gold fields are reserved. A buy has
  no `pay`.
- Error codes `insufficient-glims` (225) and `top-up-cap` (226). The
  `insufficient-embers` and `insufficient-gold` codes are deprecated and no
  longer sent.
- Migration 033 `glims`: balances and the ledger move to one `glims`
  currency. Purse gold is turned in at 2:1 with a `currency-merge` ledger
  row, gold letters become glim letters (the mail rebuild), and
  `purse_topups` gains `glims`.
- A top-up credits one glim for every two gold, with a cap of 30 glims per
  UTC day across up to two top-ups (`top-up-cap`). Glims from top-ups,
  shelves, letters and gives are never XP-earned.
- The client's game state, content keys, vectors and words say glims; the
  Ember Charm keeps its name. The glim art is packed for the HUD.
- `buf.yaml`'s breaking rules let a field go only once its number and name
  are both reserved (`docs/proto-migration.md`).

## [0.6.0] - 2026-10-10

### For players

- You can move gold from Habitica into a purse here. Find it in the Menu,
  under your Habitica hero. It spends Habitica gold, and you're asked each
  time.
- Purse gold buys goods from Hazel, Finn and the fair stall, and timber,
  stone and fiber from Silas.
- Put a price in gold on things you leave on your gate shelf. Friends pay you
  when they buy them.
- Send gold to a friend in a letter, or hand it over when you're standing
  together.
- Wear any Habitica gear you own. Choose it in the Character panel's new
  Wardrobe tab. Your stats and your Habitica outfit stay as they are.
- What you carry in your off hand is now "at your belt".

### Technical

- The purse in the game: the Menu's purse card with Top up (it syncs first,
  then the consent card; the token rides in that one request, never the
  outbox), the purse log sheet (`GET /api/purse`), gold in the HUD on desktop,
  gold choices at the sellers, shelf prices and Buy, gold letters, gold gives
  and the gold gift toast. Gold buys, letters and gives are predicted from the
  outbox entry's stored purse change. The purse pass's icons are packed
  (`purse.webp`).
- The purse on the server: gold is a second ledger currency
  (`balances.gold`, `store.CreditGold`/`DebitGold`); a top-up spends
  Habitica gold through a temporary reward, keyed per account and checked in
  a detached worker (balance checks at 2, 5, 10, 20 and 35 s, then settled
  lazily), at most two a day, with `GET /api/purse` for the log. The token is
  used for that one request: never stored, logged or returned.
- Gold between players: shelf prices and Buy, gold at sellers, gold letters
  and gives, with a conservation test per account and by reason.
- The wardrobe: `player_gear` filled only from the server's own reads of
  Habitica, `rules.Look`/`Resolve` with shared vectors
  (`content/vectors/wardrobe.json`), and a changed look that tells friends in
  the room after its commit.
- Contract 6: the purse and wardrobe protos, error codes 220-224, and
  migration 032 (with the mail rebuild).
- A `dev` branch holds the next release for playtesting; `main` gets only
  releases, tagged and published automatically once CI passes.

## [0.5.2] - 2026-10-09

### For players

- Send your mount home on your own land and it walks back into its bay in
  the stable.
- A friend's Ward-light heals you as much as it heals them.
- Friends see the moves you make while walking or riding.
- A hero who comes back from the Orb of Rebirth keeps their class moves.
- The picture holds still when the camera follows you on a plain screen.
- Mend shows how much it healed, as the ward does.

### Technical

- The step-back reviews after 0.5 (`docs/reviews/2026-10-09-step-back-*.md`)
  and the two cleanup lanes that acted on them.
- Presence: `PresenceAbility.pulse_heal`, filled by the hub from the
  caster's Mend; the reach check allows for movement only while the caster
  walks or rides; no cast before a position. Ward credit is reserved per
  report and settled at commit.
- `sync_baselines.class_mark` is written at sign-in, at account creation
  and before a sync.
- The idempotency cache refuses any request with a credential-shaped field,
  checked over every keyed request type.
- Shared magic vectors (`content/vectors/magic.json`), replayed in Go and
  TypeScript. Pulse times come from the ability's own numbers.
- Tests: the Go rig starts on a fixed date (`GLIMWAY_RIG_START` overrides
  it), store functions take the clock, ward pulses fire by hand (the api
  package runs in 13 s, not 30), and e2e polls what's still settling. CI
  runs `go vet` and `-race` on the api package; dev-tagged tests are named
  `TestDev…`.
- A connected operation holds the world from the moment it's taken, not
  from its send: an input in between (an M right after Saddle up, a second
  operation) no longer slips through.
- A refused fishing keep closes the line; a water missing from content
  closes its casts. The report pump moved out of `link.ts`; dead exports
  are removed and guarded by a test.

## [0.5.1] - 2026-10-09

### For players

- A fix for servers that build Glimway with Nix. Nothing changes in play.

### Technical

- The Nix web package includes the crafts pass's manifest, which the
  stable's layout reads; 0.5.0 failed to build with Nix.
- Releasing: a release commit's full e2e run on `main` is never cancelled
  by a later push (so the right commit is tagged), the tagger runs one at a
  time, and "Publish GHCR image" can be run by hand for an existing tag.

## [0.5.0] - 2026-10-09

### For players

- Riding has moved home. Build a stable after the Workshop, stall a
  mount, and set out from there: M to ride or get down, and it follows
  you on a lead through the village.
- Choose which of your pets walks with you, and up to three to live at
  home, in the Character panel's new Companions tab. Friends' pets follow
  them now too, and you can pet any of them.
- At level 20 each class learns a second move: Stand, Kindle, Ward-light
  or Echo. It's on R, and the second ✦ on phones.
- Heroes without a class fight with what's in hand. Fingersnap is the
  mage's.
- Fishing at the mill pond. Ask Finn about the rod by his door.
- Silas's Yard has a Buildings section near the top. The stable is
  there, and says it needs the Workshop until you have one.
- Walk without a pet if you like: No pet is a choice in the Companions
  tab.
- A mount you're riding leaves its bay empty, and walks back into it when
  you send it home on your own land.
- After a catch, Keep it with E or Let it go with Q; the prompt names
  both.
- A click swings only a weapon or a sturdy tool (axe, pick, spade). A rod,
  can or pair of shears isn't for fighting.
- Esc ends a talk, unless there's a choice you have to make.
- What your quest step needs glows softly when it's on screen, and the
  top bar says when it's here rather than pointing at a way out.
- The gate signs at the village's edges are signposts you can see.

### Technical

- 0.5 Crafts (`docs/design/crafts.md`), contract 5. Companions:
  `POST /api/companions` (`companions`) stores the follower and up to three
  yard pets (`player_companions`, `yard_pets`, migration 030); a
  `follow_pet` of `none` means no follower, empty means Habitica's current
  pet. The stable: `stall`, `mount-out`, `mount-home` and `stable-extend`
  operations; `HomeView.stalls` shows a stall empty while its mount is out.
  Presence carries `avatar_change` and `ability` events to contract-5 tabs.
- Magic: `content/abilities.json` (with its proto) is the ability table
  both sides read. The level-20 moves unlock by the level mark,
  `sync_baselines.level_mark` (migration 031), and the report allows each
  move against its own budget; Ward-light's heal credit is spent after the
  commit.
- Buildings carry a `building` flag in `content/homestead.json`. What a
  click does with each belt kind is `SWING` in `src/lib/belt.ts`. The quest
  goal's route and target glow share `src/game/goal-route.ts`.
- The container's base images come from `mirror.gcr.io` (same digests),
  after Docker Hub rate limits failed CI builds.
- Releases tag themselves: when CI passes on `main` and `package.json`
  holds a version with no tag yet, `tag-release.yml` tags that commit and
  publishes the image (`docs/releasing.md`).
- Fishing in the game: the mill pond's three banks come from
  `content/fishing.json` and sit on the interactions path (Cast, Pull in,
  Reel, then Keep or Let it go in the context buttons). The rod is a new
  belt kind, `fish`. `fish-cast`, `fish-settle` and `fish-cancel` are
  keyed outbox operations that need a connection; `GET
  /api/fishing/waters` gives each water's band. A reload puts an open
  line back from `PlayerState.fishing`, and presence carries the
  `fishing` pose.
- A Line in the Race opens the Quests page's Crafts shelf. A quest
  already under way now speaks before another quest's start when both
  want the same person.
- The crafts pass's fishing frames (rod, float, rings, splash, roach, fry,
  recipe card) are baked into the items pack.

## [0.4.0] - 2026-10-09

0.3 (Server-first) shipped only as pre-releases; its changes are part of 0.4.0.

### For players

- Hazel's sponge rises in its washtub, Finn's hoist works when it's
  fixed, and Elara sits writing at her desk while she keeps the library.
- The library's section signs are small plaques on the shelves now, so
  the books show.
- Step inside. Hazel's kitchen, Finn's mill with its sack loft up the
  stairs, the library's reading room and your own cottage are rooms you
  walk into, furnished and lived-in.
- Hazel and Finn keep their hours: Hazel bakes for forty minutes of each
  hour and steps out for twenty; Finn works the stones, the loft and his
  door. Knock when nobody's home and you'll hear where they've gone. You
  buy from them wherever they are.
- Elara keeps the library half of each hour. Talk to her to read or to
  give a paper; the shelves are sorted into Stories, Histories, Recipes
  and Field notes, and there's a reading nook by the window.
- A Quests page in the journal lists every quest you've found, with its
  notes. Pin one and its goal leads the top bar.
- A new beginning with Orrin and Mara, and three small quests in the
  rooms: Set to Rise with Hazel, The Stuck Hoist in Finn's loft, and A
  Seat by the Lamp in the library.
- People say their own piece first; a quest's request follows.
- Closing the tab right after a fight keeps what happened in it.
- When someone speaks the warden's naming, the warden you're watching rests
  for its few seconds and no longer, even on a slow or background screen.
- Coming back online after playing offline sends your health and place to
  the world at once, instead of up to ten seconds later.
- Opening and closing a conversation or a panel is quiet again: the
  zip it made is gone.
- Felling a tree takes all of it: trees leaning over a path in the Wilds
  sometimes left their top standing over the stump, or didn't fall at all.
- Mara, Orrin and Pip have painted portraits in conversation, like the
  rest of Hearthwick, and Silas's shows too.
- Your world lives on the server now. Everything you do is checked and kept
  there, so a second device picks up exactly where the first left off.
- Glimway plays with a Habitica account only: playing without signing in
  is gone.
- Lost your connection? Keep playing nearby. What you do waits on this
  device and goes up as soon as you're back; spending embers and anything
  in the Wilds waits for the connection.
- The Tangle and the outer Wilds are drawn fresh by the server, so the
  Tangle you know looks different.
- Glimway has sound: footsteps that change with the ground (grass, path,
  stone, wooden floors), the thunk of an axe, a pick on stone, a spade in
  the earth, doors, coins, and the knocks and swishes of a fight. The Menu
  has a sound switch and a volume slider, kept on this device.
- Phones and high-resolution screens draw the world at their full
  resolution: the art is sharper, and you see the same stretch of it as
  before.

### Technical

- One schema: everything the server and the client both type or load is
  on protobuf. The remaining hand-typed routes (homestead, items, library,
  mail, storage, crafting, commons, projects, repairs, world, operation
  results, invites) have generated request and answer types, decoded
  strictly on both sides; client requests are built through the generated
  schemas. Every content file both sides load has a schema in
  `proto/glimway/content/v1` (files stay JSON; a few reshaped where proto
  can't express them), field rules as protovalidate constraints, and
  cross-entry rules in code once per language, pinned by shared vectors
  with a rule id per refusal. The production client skips content
  validation (CI and the server validate the bundled files). See
  `docs/proto-migration.md`.
- The reconciliation read answers an operation's actual result.
- 0.4 Indoors (`docs/design/indoors.md`), contract 4: rooms are places
  (`content/rooms.json`, `in:<parent>[:floor]` ids, per-room presence),
  residents on an hourly cycle (`content/residents.json`, `residentAt`,
  the server's clock via `X-Glimway-Now`), quests by id on the server
  (triggers, gates in order, `reached_at`/`gate_at`, migration 029).
- Furnishings: one catalogue (`content/furnishings.json`, 76 pieces,
  the home goods moved in) and one placement rule (`canPlace`, Go and
  TS, shared vectors); rooms place pieces by id with a facing and a
  parent; collision is each piece's base.
- The indoors art pass, round 2 (176 frames) and a shared interior kit,
  under design 7.0's interior style rules.
- Reports: closing the tab sends the newest steps under the next
  sequence instead of resending the report in flight.
- Dev mode for local playtesting (dev builds only, which `npm run server`
  now makes): `POST /api/dev/grant` gives the signed-in account embers,
  items or home goods through the real store paths, never anything from
  Habitica; the dev panel (`` ` `` or the Menu's Dev row) exists only under
  `vite` dev. Production binaries and bundles don't contain either.
- e2e waits for a server answer allow 15 s (`SERVER_ANSWER_MS`): the first
  answers of a session take 3-5 s on the software-rendered smoke runner.
- Everything drawn for a tile registers in one place
  (`src/game/area/tile-art.ts`), so felling removes the foreground canopy
  too; a dev-only `__fsArtAt(tx, ty)` hook lets e2e read what's drawn.
- Dialogue busts for Mara, Orrin and Pip on a new sheet
  (`fingersnap-portraits-residents`); every speaker maps to a bust, and the
  sprite crop is only the fallback.
- Server-first (`docs/design/server-first.md`): the server owns all state
  and rules. `PUT /api/progress` and the uploaded progress document are
  gone; the client sends operations (`proto/glimway/v1/op.proto`,
  `operations.proto`), predicts their answers and rolls back a refusal.
  Every operation is idempotent on its key, replays the current state, and
  runs in a savepoint. Contract 3, sent as `X-Glimway-Contract`; an older
  client gets a reload notice.
- Accounts: random account ids, looked up from Habitica sign-ins
  (`sign_ins`). Migrations 026 (accounts), 027 (normalized state,
  `wilds_chunks`, the Wilds reset) and 028 (moves the old progress
  documents into the new tables).
- The Wilds generator is in Go (integer-only, v2) and pre-generates nine
  chunks per epoch; the client generator is gone and reads served chunks.
- The client keeps an outbox in IndexedDB per account and device, behind a
  Web Lock, so offline play queues operations and replays them with the
  same keys. Reports carry generations and sequence numbers; places and
  vitals have their own version watermarks.
- Local (guest) play is removed, and with it the client-side progress
  save.
- Dev builds only (`-tags dev`, and only with `-dev-clock`):
  `POST /api/dev/clock` moves a test server's clock forward, so e2e can
  cross a season end. Production binaries don't contain the route.
- CI: the full suite uploads screenshots and error context only on
  failure; `go test -tags dev` covers the dev clock.
- Sound effects from Kenney's CC0 packs (`public/assets/audio/kenney/`,
  43 MP3s, about 121 KB, in Git LFS; register in `ASSETS.md`). One sound
  module (`src/game/sound.ts`) plays them from the event bus; new bus events
  `sound:cue`, `sound:footstep` and `sound:work`. It stays silent under
  automated browsers (`navigator.webdriver`), so e2e runs fetch no audio.
  The setting moved to `glimway:sound` (`fingersnap:muted` is no longer read).
- The canvas renders at the device pixel ratio, capped at 3 (Phaser's NONE
  scale mode, sized by `src/game/main.ts`); the camera zooms in canvas px
  (`canvasZoomFor`) and everything the interface reads or writes (insets,
  the hero's spot, the dev hooks) stays in CSS px through `canvasRatio`.
  Phones above a ratio of 1 keep the whole 4× art: about 44 MB of textures
  instead of 16 MB.

## [0.2.0] - 2026-10-08

### For players

- When a new version of Glimway is ready, a small notice offers to reload.
  Your progress is saved first, and if it can't be saved just then, the
  notice says so and waits.
- The Menu shows which version you're playing, with a link to this list of
  what's new.
- After an update, a short card says what's new since you last played. The
  Menu's "What's new" brings it back any time.
- Prompts are steadier: the nearest thing you can reach always shows its
  prompt, and a click reaches exactly as far as the action itself.

### Technical

- `package.json` is the one source of the version; the Nix packages read it
  too. Each build also gets a build id: the short git commit of a clean
  checkout, the `GLIMWAY_BUILD` it is given (the Docker build argument the
  release workflow fills, the flake's revision), or else a hash of the build's
  inputs (`scripts/build-version.mjs`).
- The client gets both at build time (`__GLIMWAY_VERSION__`,
  `__GLIMWAY_BUILD__`), and `vite build` writes `dist/version.json`. Open tabs
  check it when they come back into view and every ten minutes; a different
  build id brings up the reload notice. Its Reload stops the world (input,
  enemies, physics, timers), saves until the stored copy is the live game,
  waits for every server write in flight (including ones queued behind the
  upload, and a superseded tab's orphan copy), and only then reloads; if
  anything can't be saved, play resumes and the notice says why.
- The server is built with its version and build id (`-ldflags -X`, `dev`
  otherwise), reports them in `GET /api/health` and logs them at start-up.
- `version.json` is served with `Cache-Control: no-store`.
- The release workflow stops early when the tag doesn't match
  `package.json`'s version.
- This changelog, and the release steps in `docs/releasing.md`.
- The "What's new" card reads each release's `### For players` lines from
  this file when the game is built (`virtual:whats-new`,
  `scripts/whats-new.mjs`), never at runtime. A device remembers the build it
  last caught up to (`glimway:whats-new` in localStorage); a device that
  never saw the card catches up without one. `CHANGELOG.md` is now a build
  input (the build hash, the Docker context, the Nix web package).
- Interface cleanup: one panel shell (`Panel.svelte`) and notice card
  (`NoticeCard.svelte`), shared panel styles and colour tokens in `app.css`,
  the panel action and bus helpers (`panel-state.svelte.ts`), one table of
  what each overlay holds back (`layers.ts`), the camera insets measured
  from marked elements (`play-insets.ts`), connected play's state machine
  out of `App.svelte` (`account-flow.svelte.ts`, unit-tested), and the
  refusal copy in `src/content/errors.ts`. Node tests can import rune
  modules through `tests/helpers/svelte-runes.ts`.
- The client no longer falls back when a server has no mail recall: every
  server since the first deploy has it.
- A shared contract in protobuf (`proto/`, generated with `buf` into
  `server/internal/gen` and `src/lib/gen`, checked in): the error codes are
  one enum on both sides, calendar and invites are served from generated
  types with today's JSON shape, and CI regenerates the code and runs
  `buf breaking` against `main`. Plan for the remaining domains:
  `docs/proto-migration.md`.
- Presence is binary protobuf over the `glimway.presence.v1` subprotocol;
  a broadcast is encoded once for every recipient (about 7.5 times faster).
  A tab from an older build is told to reload (close code 4005).
- Game cleanup: one typed, Phaser-free event bus; `lib/tile.ts` and one
  hash module; one interactions path (each point carries its verb, label,
  marker and reach) with one nearest-wins loop; `WorldScene` split into
  controllers (unmoored, the Turning, dialogue actions, moves); homesteads
  and enemies split by concern; the superseded placeholder drawers retired
  and the art-pass loaders collapsed into `art-pass.ts`.
- Server cleanup: `api.go`, `items.go`, `homestead.go` and `presence.go`
  split by responsibility (`expansion.go` is now `mutation.go`), shared
  HTTP test helpers, `internal/itemmove` for item transfers (API and mail),
  and a pinned migration history (`store/history.json`) with upgrade
  fixtures that carry data.
- Playwright uses at most 3 local workers by default.

## [0.1.0] - 2026-10-07

The first public release.

### For players

- Walk the old lantern road: meet Mara in Hearthwick, follow the Brackenwood
  Path, settle the stone warden at Ashwatch Ruin, and light the lanterns
  again.
- Light, fair combat: every attack is telegraphed, and you have a basic
  attack, a signature ability for your class and a dodge roll.
- Play as a guest, with everything saved in your browser, or as your own
  Habitica hero: every 10 XP you earn on Habitica becomes an ember to spend
  on warm rests, road lanterns and the Ember Charm.
- Join a small, invite-only world with friends: raise a homestead in
  Hearthwick Commons from a campsite to a cottage and a workshop, arrange
  your furniture, gather in the shared Tangle, give to village projects, send
  mail, and see each other walk around and wave.
- Gather and craft: chop, quarry, dig and plant, then make things at the
  hearth, the desk and the crafting bench.
- Glimway keeps its own calendar, with festivals that change the village for
  a day.
- Find 52 papers (letters, ledgers, songs and more), read them in your
  journal, and share them in the Hearthwick Library.
- Plays on phones too, with touch controls.

### Technical

- Browser game in Svelte 5, TypeScript, Phaser 3 and Vite; an optional Go
  server with SQLite for shared worlds, with presence over a WebSocket.
- Habitica access is read-only: one `GET /user` per connect or sync, from
  the browser.
- Three ways to deploy: a NixOS service flake, Docker Compose with images on
  GHCR (`ghcr.io/solidsilver/glimway`, amd64 and arm64), or by hand
  ([docs/home-server.md](docs/home-server.md)).
- Code under AGPL-3.0-or-later, the game's own art under CC0, Habitica's art
  under its own licence; contributions under the DCO.
- Unit tests, Go tests and Playwright playtests.

[Unreleased]: https://github.com/Solidsilver/glimway/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/Solidsilver/glimway/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Solidsilver/glimway/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/Solidsilver/glimway/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Solidsilver/glimway/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Solidsilver/glimway/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Solidsilver/glimway/compare/v0.2.0...v0.4.0
[0.2.0]: https://github.com/Solidsilver/glimway/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Solidsilver/glimway/releases/tag/v0.1.0
