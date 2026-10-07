# Glimway

A cozy pixel RPG for [Habitica](https://habitica.com) players. Walk the old
lantern road, relight it, and let the progress you make on Habitica light the
way: every 10 XP you earn there becomes an ember to spend in the world.
"Glim" is an old word for a candle, so a glimway is a road of little lights.

It runs in the browser (Svelte 5, TypeScript, Phaser 3, Vite), with an
optional Go server for small invite-only worlds shared with friends.

**Glimway is not affiliated with or endorsed by Habitica.** It's a
third-party tool that uses Habitica's public API and, with credit, Habitica's
avatar art (see [Licences](#licences)).

You can play three ways:

- **As a guest.** No account, no server, no network requests. Everything
  saves in your browser.
- **As your Habitica hero.** Connect Habitica (read-only) and play as your own
  character: your class, gear, look and health come along, and the XP you earn
  on Habitica becomes embers.
- **In a world.** If a Glimway server is running, sign in with the same
  Habitica details to join an invite-only world with friends: homesteads,
  shared Wilds, a shared library, village projects, mail, and seeing each
  other walk around.

## How it was made

Glimway was built by AI agents, directed and reviewed by one person (the
owner). The code, the docs and the lore were written by agents.

**All of the game's own art is AI-generated,** made with OpenAI's image
generation through Codex, then measured, cut and packed by scripts. The owner
would rather the game had human-made art, and used generated art to make it
playable first. **Artists are welcome:** human-made art would get its own
folder, its own licence and credit, and would replace generated art, not sit
beside it unmarked. Open an issue to talk about it. Provenance for every
generated sheet (prompts included) is in [ASSETS.md](ASSETS.md).

The avatars, gear, pets and mounts you see on Habitica heroes are Habitica's
own art, by HabitRPG, Inc., drawn by Habitica's volunteer pixel artists. They
are shown unmodified, with credit, and are not AI-generated.

## Play

- **Self-hosted:** follow [the self-hosting guide](docs/home-server.md). Guests can play locally; connected worlds require admission.
- **On your own machine** (Node 24+):

  ```sh
  git clone https://github.com/Solidsilver/glimway glimway
  cd glimway
  npm install
  npm run dev        # http://localhost:5173, guest play
  ```

  For connected play, run a local server too: see [Run it locally](#run-it-locally).

## Deployment methods

| Method | What you run |
|---|---|
| [Nix flake](docs/home-server.md#nixos-flake) | NixOS service module, packaged web app, Caddy and scheduled backups |
| [Docker Compose](docs/home-server.md#docker-compose) | One GHCR image for the app/API, persistent data volume, optional HTTPS Caddy |
| [Manual](docs/home-server.md#manual-deployment-without-nix) | Build Go and Vite, install a systemd unit and reverse proxy |

## How your Habitica token is handled

**Glimway is read-only.** It reads your Habitica profile and never writes to
your Habitica account: no scoring tasks, no spending gold, no changing stats
or gear. The game makes one explicit `GET /user` per connect or **Sync**
press, from your browser. (The token itself *can* write to your account;
the game limits itself to reads, and the code is public so you can check.)
The `X-Client` header identifies the tool's creator, never you.

**Where your token goes.**

- It stays in the tab's memory, and is never in saves, save codes, the
  connected cache or logs.
- **Remember on this device** is opt-in. If you tick it, the User ID and token
  are kept in this browser in their own IndexedDB database
  (`fingersnap-credentials`, under the game's old name), apart from your save.
  Script injected into the site could read them, so leave it off if you'd
  rather paste per visit. **Forget** deletes them, and Disconnect offers to.
- **Signing in to a world** sends the token to the Glimway server once, at
  login, so the server can make one read-only `GET /user` to prove the account
  is yours. The server never stores, logs or returns it. Every later sync
  still goes from your browser to Habitica, and the browser reports the
  result to the server.

What comes from Habitica and what only from the game:
[docs/habitica-boundary.md](docs/habitica-boundary.md). Habitica's rules for
tools like this one, and how Glimway follows them:
[docs/habitica-policy.md](docs/habitica-policy.md).

## The lantern road

Meet **Mara** in the village of Hearthwick, accept the lantern quest, follow
the **Brackenwood Path** east (mind the wisps), copy the naming cut on the
route stone in **Ashwatch Ruin**, settle the **stone warden**, light the hilltop
lantern, then walk home and see the village lantern glowing again.

**The warden is not a fight.** Hearthwick built it, long ago: a lamp in a
stone coat whose one naming is "the road is closed here", and it is still
keeping its pose. Blows ring off the stone. It holds the path, lunges from
range and sweeps its arms up close; after a lunge it stops to find its feet
for a moment. Step in then and **speak the naming** to its heart-lamp (E /
Space, or the **Speak** button on touch): Wenna's words from the route stone,
turned round to say the road is held again. Three speakings settle it: its
arms lower, the lamp in its chest gutters to a coal, and it rests on its post
for good.

- Three explorable quest areas with collisions, transitions and NPCs (Mara,
  Pip, Orrin) whose lines follow the story.
- Light real-time combat against wisps, slimes and beetles: a basic attack
  (E / Space), a signature ability (F, costs mana) and a dodge roll (Shift).
  Every enemy attack is telegraphed: a windup pose, a "!", a rising tone, then
  a white flash when its aim locks. An imported hero's class picks the kit
  (warrior slash and cleave, mage bolt and the Fingersnap spell, rogue stab
  and shadowstep dash, healer tap and mending pulse), and their effective stats
  drive the numbers, with bounded diminishing returns.
- HP, mana, position, quest stage and defeated enemies persist across
  reloads. Reloading is **never** a heal. Falling wakes you by the village
  well with your story kept.

## Embers: real-life progress lights the road

Every 10 XP you earn **on Habitica** becomes an ember the next time you sync.
Each XP pays once: the game remembers the highest lifetime XP it has paid and
credits only XP above it, so unchecking and re-checking a task pays nothing
new. The first import pays a one-off welcome of 3 embers (not your past XP),
and two story beats leave a few embers so guests can try spending them too.

| Where | Cost | What you get |
|---|---|---|
| Hearthwick's lantern, by the well | 2 | A warm rest: full health and mana. At 0 HP an imported hero needs embers earned from XP. |
| Three road lanterns along Brackenwood | 3 each | A lit rest spot while no enemy is near: mana for everyone, health for demo heroes |
| The chest in Ashwatch Ruin | 5 | The Ember Charm (+10% critical hits) |
| Your bedroll or hearth at home (in a world) | 1 | Rest at your own place |
| Silas in the Commons (in a world) | 15 / 30 + materials | Raise a cottage, then a workshop; furniture from 2 embers |

Rules: `src/lib/embers.ts` and `content/economy.json` (shared with the server).

## Beyond the village

### Hearthwick Commons and homesteads

Hearthwick's east edge has a second gate, below the Brackenwood road, into
**Hearthwick Commons**: a safe green with a well, a notice board, a lane of
plots, and **Silas**, a retired carter who stakes the plots. Guests can walk
the Commons and meet Silas; plots belong to people with a world.

In a world, each member gets a plot. Talk to Silas to claim yours (a campsite,
free), then raise it:

| Tier | Cost | What it adds |
|---|---|---|
| Campsite | free | Fire ring, cot, lamp post; rest at your bedroll |
| Cottage | 15 embers | A room to go into, a hearth to rest by, and decorations to set out |
| Workshop | 30 embers, 20 timber, 10 stone, 8 fiber | A storage chest and a crafting bench inside |

Silas's yard sells fourteen pieces of furniture, some for embers and some for
materials from the Wilds. Press **B** (or the Arrange button) on your plot or
in your cottage to set them out: pick a piece, nudge it (arrows / WASD), turn
it (R), set it (E), put it away (X); Esc steps back out. Resting at home costs
1 ember and needs you on your own plot. Neighbours' places are visible on the
lane: walk into their cottage to look around (read-only), or leave something
in their mailbox.

### The Wilds: the Tangle

North of the Commons, under a leafy arch, lies **the Tangle**: a 3×3 grid of
generated forest chunks, the same for everyone in a world (the generator is
shared between the browser and the server, with parity tests). In it:

- **Camps** of wisps and beetles; clear one, then claim it for materials.
  Camps come back after 10 minutes.
- **Resource nodes** for timber, stone, fiber and amber; they regrow after
  5 minutes.
- **Chests** (personal: each player opens each one once) and **points of
  interest** (the first to find one charts it for the world).
- Now and then a **trinket**.
- **Fallen-hero lanterns**: fall in the Wilds and you leave a lantern behind;
  anyone in your world can relight it, and relighting a friend's pays amber.

Guests can walk a fixed local Tangle and gather into their pack; their chest
and point-of-interest claims last until the page reloads. In a world, claims,
materials and lanterns are kept by the server and shared as described.

### The calendar and the Turning

Glimway keeps its own calendar: a **wick** is seven real days, twelve wicks
make a year, and four Marks (Mudrise, Carting, Amberfall, Quiet) name the
seasons. The HUD shows today ("Sap-wick, 3rd day — Amberfall"), and festivals
change the village for a day: candle hulls on the pond at the Breaking,
bunting for Carting Day, a lamp in every window at Amberwake, and every
lantern lit on Closure Night.

The **Turning** happens at the end of each wick: the **outer Wilds** reset to
new land, while the Tangle stays as it is. The notice board posts when the next
Turning is due. The server already runs the outer region and its Turnings; the
client doesn't walk you into the outer Wilds yet, so for now they appear on
the notice board and in papers.

### Papers and the Hearthwick Library

**Papers** are found texts: ledgers, letters, notices, songs, recipe cards. 52
in eight collections; 13 start on the library shelves and the rest are found
around Hearthwick, Brackenwood and the ruin, along the quest, as gifts from
the villagers, in the Commons, in the Tangle and from village projects. Read
them in the Journal's **Papers** tab (J).

The **Hearthwick Library** is the small reading house in the village's
south-west corner. Anyone can read every paper on its shelves. Donate a paper
you've found to put it there: a guest's donations fill their own shelf; in a
world, there is one shared shelf and the first donor's name stays with the
paper.

### Village projects and mail (in a world)

The notice board (village or Commons) lists **village projects**: mend the
north bridge, build a well canopy, reinforce the mill wheel, and more. Anyone
in the world can give materials; when a project is complete the village
changes (a canopy on the well, rails on the Brackenwood bridge, Ada's window
lit) and everyone who gave something gets the project's papers.

**Mail** sends materials, trinkets, crafted pieces and unplaced furniture to
someone in your world: use your mailbox on the Commons, or theirs to address
it to them. Parcels wait until claimed, can be recalled while unclaimed, and
come back after 30 days. Embers and quest items can't be mailed.

### Seeing each other

In a world, other players in the same area appear as their Habitica avatars,
with name tags, walking and facing as they move. Press **G** (or the speech
button) for emotes (wave, nod, cheer, thanks, lantern); they show as a bubble
over your head. Presence is presentation only: other players never block you
and have no effect on play.

## Your Habitica character

On a new game the title screen asks how you want to play: **Play as your
Habitica hero** or **Wander as a guest**. The first opens a three-step connect
guide (also in the Menu): where to find your User ID and API Token (website,
iOS, Android), a paste step, and a card with your hero's name, class and
level. You can paste both values at once: labeled text (`User ID: … API
Token: …`, any order) is read by its labels; two unlabeled codes are filled in
order with a preview and a **Swap** button, and nothing is sent until you
confirm. Guide copy lives in `src/content/connect-guide.ts`; the parser in
`src/lib/habitica/paste.ts`.

**Health.** Importing replaces the demo vitals once; later syncs credit
genuine external HP/MP changes **exactly once** (damage plus an unchanged
profile never refills), and only somewhere safe: Hearthwick, or the Commons
(your cottage included). Imported vitals get no passive healing (lit road lanterns give them mana only). Defeat wakes you at
capped vitals (zero stays zero) and locks expeditions until a genuine heal on
Habitica or a warm rest paid with embers earned from XP. See [docs/import-contract.md](docs/import-contract.md).

## Playing in a world

When a Glimway server answers, connecting Habitica in the guide also signs
you in to your world (with an optional invite code). Worlds are invite-only:
the server owner allowlists people or hands out single-use codes, and every
member can invite up to three friends at a time (five in all) from the Menu.
Codes look like `amber-fox-river-lantern-moss-ivy-7392`; case, spaces and
hyphens don't matter.

- **First sign-in:** bring this device's journey into your world (story and
  place carry over; embers come along as gifts, up to 30) or start fresh.
- **One place at a time:** if your journey is open in another tab or device,
  you're asked before taking over.
- **Offline:** play goes on in the curated areas and saves on the device;
  spends and syncs wait for a connection. Reconnecting uploads what you did;
  if you also played somewhere else meanwhile, story from both is kept and
  health, mana and place come from the latest session.
- A session lasts up to seven idle days and at most thirty days in all; then
  you sign in again.
- **Log out** in the Menu. Progress that hasn't reached the world yet stays on
  the device for your next sign-in.

Guest play is unaffected: with no server (a static build) or without signing
in, everything stays local exactly as before.

## Controls

| Action | Desktop | Touch |
|---|---|---|
| Move | WASD / arrow keys | Joystick (bottom left) |
| Talk / use / attack / speak the naming | E or Space | Big action button (its label says what it will do) |
| Signature ability | F | ✦ button (shows mana cost and cooldown) |
| Dodge roll | Shift | Roll button |
| Pick a dialogue reply | 1–9, or arrows + Enter | Tap the reply |
| Mount up / dismount | M (outdoors, imported heroes) | — |
| Journal / Character / Inventory / Menu | J / C / I / Esc | HUD buttons (book, person, bag, menu) |
| Arrange your home | B, then arrows, R, E, X, Esc | Arrange button and tray |
| Emotes (in a world) | G, then 1–5 | Speech button |

Dialogue pauses movement and combat. Touch controls appear on coarse-pointer
devices; the layout is responsive with safe-area insets for phones.

## Interface

- **HUD:** area, current goal (tap to expand), health and mana, embers, the
  calendar line, and small chips for "Offline", "Server trouble" or how many
  others are here. A desktop action bar shows the E action, the signature
  ability with its mana cost and cooldown, and the roll.
- **In the world:** a gold **!** over whoever moves the story on, a **…**
  bubble over anyone with something new to say, a keycap over the current
  target, and labelled exits.
- **Moments:** quest-beat ribbons, area title cards, the lantern camera beat,
  the defeat collapse and wake card, and the closing card.
- **Panels:** Journal (the road and your papers), Character (vitals, stats,
  abilities, discoveries), Inventory (tabs for Tools, Supplies, Keepsakes, Home
  goods and Papers, with quest things under "For the road" and a "new" dot for
  items this device hasn't seen), Menu (save codes for guests, your world and
  invites, the Habitica connection, sound, controls), plus the Library, notice
  board, Silas's yard, workshop and mailbox in the world. Panels trap focus;
  hard choices use in-game confirms.
- **Sound:** small procedural Web Audio cues (no files, no network). Toggle in
  the Menu.
- **Fonts:** Pixelify Sans and Nunito, bundled locally. `prefers-reduced-motion`
  turns off shakes, hit-stop and big tweens.

## Run it locally

Requirements: Node 24+ (the unit tests run TypeScript directly) and, for the
server, Go 1.26+.

**Guest play only** (no server needed):

```sh
npm install
npm run dev        # http://localhost:5173
```

**With a local world server**, in two terminals:

```sh
npm run server     # Go server on 127.0.0.1:8090, database in .data/, HTTP cookies
npm run dev        # Vite proxies /api and the /ws socket to 127.0.0.1:8090
```

Point Vite at another server with `GLIMWAY_API=http://127.0.0.1:PORT npm run dev`.
Extra server flags go after `--`, for example
`npm run server -- -listen 127.0.0.1:8091 -db /tmp/glimway.sqlite`. With no
server running, the dev proxy fails and the game plays as a guest.

Server flags and environment variables (flags win; flags come before any
subcommand):

| Flag | Environment | Default |
|---|---|---|
| `-listen` | `GLIMWAY_LISTEN` | `127.0.0.1:8090` |
| `-db` | `GLIMWAY_DB` | `.data/glimway.sqlite` |
| `-habitica-url` | `GLIMWAY_HABITICA_URL` | `https://habitica.com` |
| `-x-client` | `GLIMWAY_X_CLIENT` | the creator's public client id |
| `-habitica-assets-url` | `GLIMWAY_HABITICA_ASSETS_URL` | `https://habitica-assets.s3.amazonaws.com/mobileApp/images/` (Habitica's sprite host, for outfit pieces the bundle lacks) |
| `-sprite-cache` | `GLIMWAY_SPRITE_CACHE` | `habitica-sprites/` beside the database |
| `-cookie-secure` | `GLIMWAY_COOKIE_SECURE` | `true` (`npm run server` sets false for local HTTP) |
| `-trusted-proxies` | `GLIMWAY_TRUSTED_PROXIES` | `127.0.0.1,::1` |
| `-party-admission` | `GLIMWAY_PARTY_ADMISSION` | `true` |
| `-login-concurrency` / `-login-rate` / `-login-global-rate` | — | `4` / `10` per IP per minute / `60` per minute |

The game was called Fingersnap until October 2026. The old
`FINGERSNAP_<NAME>` variables are still read when the `GLIMWAY_<NAME>` one is
unset, but they're deprecated and will be removed in a later release. With no
`-db`, a local `.data/fingersnap.sqlite` is still opened if `.data/glimway.sqlite`
doesn't exist.

**Letting people in.** A world is invite-only, so before you can sign in
locally, allowlist your Habitica User ID or make an invite code with the
admin CLI (same binary, same database):

```sh
go run ./server/cmd/glimway-server allowlist add YOUR_HABITICA_USER_ID
go run ./server/cmd/glimway-server allowlist list
go run ./server/cmd/glimway-server invite            # prints a code for a new solo world
go run ./server/cmd/glimway-server invite WORLD_ID   # a code that joins an existing world
go run ./server/cmd/glimway-server invites           # hash-only records, one JSON line each
go run ./server/cmd/glimway-server invite revoke HASH
go run ./server/cmd/glimway-server allowlist remove HABITICA_USER_ID
go run ./server/cmd/glimway-server flagged          # accounts flagged by a login check
go run ./server/cmd/glimway-server notes            # rebirth and large-loss audit notes
go run ./server/cmd/glimway-server flag clear HABITICA_USER_ID
go run ./server/cmd/glimway-server backup /tmp/glimway-backup.sqlite
```

Add `-db PATH` before the subcommand to use another database.

## Host your own

A Glimway instance is a static site plus, for worlds, one Go binary with a
SQLite database, on the same origin:

1. **Build the site:** `npm ci && npm run build`, then serve `dist/` with any
   static file server. That alone is a working guest-only game.
2. **Build the server:** `go build -o glimway-server ./server/cmd/glimway-server`.
   It embeds `content/` and applies its database migrations on start. Run it
   on localhost behind HTTPS (session cookies are Secure).
3. **Route `/api/*` and `/ws` to the server** from the same host that serves
   the site (keep the `/api` prefix and the browser's Host header). WebSocket
   upgrades need nothing extra.
4. **Let people in** with the admin CLI above.

NixOS modules for both halves are in `deploy/nixos/` (`glimway.nix` for the
site, `glimway-server.nix` for the server, with nightly backups). The main
instance's setup, including Caddy routes, backups and restore, is written up
in [docs/home-server.md](docs/home-server.md).

Things to know before you host:

- **Identify yourself to Habitica.** If you run a changed copy, set
  `-x-client` to your own Habitica user ID and app name
  (`<your user id>-<app name>`); Habitica asks every tool to send its
  creator's ID.
- **Habitica's art is non-commercial.** Any instance that serves Habitica's
  sprites (bundled, or fetched through the server's sprite proxy) must not be
  run mainly to make money: no ads, paid tiers or sales. See [Licences](#licences).
- **Share your changes.** The code is AGPL-3.0-or-later: if you run a
  modified copy for other people, offer them its source.
- **Don't call your instance "official",** and don't suggest that Habitica
  runs or endorses it.

## Tests

```sh
npm run typecheck   # tsc --noEmit
npm run check       # svelte-check
npm test            # unit tests: node --test tests/*.test.ts
npm run build       # production bundle in dist/
npm run verify      # all four of the above
go vet ./... && go test ./...   # the server, shared content and parity vectors
npm run test:smoke  # the critical-path playtests (a few minutes)
npm run test:changed  # the playtests for what this branch changed
npm run test:e2e    # every browser playtest (Playwright)
npm run verify:all  # verify, then the playtests
```

First time running the playtests: `npx playwright install chromium`.

The playtests run in parallel (`E2E_WORKERS`, default half the cores, 2 to
6). Each worker starts its own Go server, database and fake habitica.com on
free ports, the first time it runs a connected test; one Vite dev server, with
the dev-only playtest levers, is shared, and sends each browser's `/api` to its
worker's server. Guest specs block `/api` in the browser, so they still play as
if no server existed. Give each git worktree its own Vite port:

```sh
E2E_PORT=5203 npm run test:smoke
E2E_PORT=5203 npx playwright test e2e/presence.spec.ts   # one spec
```

While working, run `test:smoke` and `test:changed`; run the full suite once per
merge batch. `test:changed` maps changed files to specs through
`e2e/changed-map.json` (add your spec there). Tests wait on game state
through read-only dev hooks, never on fixed pauses. The tiers, the per-worker
servers, how to write a playtest and how to debug a flaky one are in
[docs/testing.md](docs/testing.md).

The playtests in `e2e/` cover the whole quest including settling the warden,
combat and dodging, embers, onboarding and its layout, the Commons and
homesteads, papers and the library, the Tangle, the calendar, notice board,
workshop and mail, connected play (sign-in, invites, takeover, offline,
logout), presence with two players, and touch. `*-screens.spec.ts` specs
check layouts and, with `SCREENS=1`, save screenshots.

Generated shared data (run after changing the inputs; the tests fail if it
drifts):

```sh
npm run vectors            # economy/sync parity vectors (TypeScript → content/vectors)
npm run vectors:wilds      # Wilds generator parity vectors
npm run vectors:calendar   # calendar parity vectors
npm run papers             # docs/lore/texts → src/content/papers-text.ts + content/papers.json
```

## Architecture

```
src/                 the browser game
  game/              Phaser runtime: scenes, entities, areas, the Wilds, homes,
                     the server link (link.ts) and presence (presence*.ts)
  ui/                Svelte interface: HUD, panels, connect guide, gates
  lib/               shared rules and clients: state, saves, embers, Habitica
                     import, Wilds generator, calendar, API client (lib/api),
                     presence protocol
  content/           dialogue, places, papers, copy
server/              Go server (one module at the repository root)
  cmd/glimway-server   HTTP + WebSocket server and admin CLI
  internal/          api, store (SQLite, migrations), rules, wilds, habitica
content/             shared JSON the browser imports and the server embeds:
                     economy, homesteads, wilds, calendar, mail, projects,
                     papers, presence, invite words; vectors/ for parity tests
e2e/                 Playwright playtests (+ the fake Habitica server)
tests/               unit tests (node --test)
deploy/nixos/        NixOS modules for the static site and the server
```

- **The browser owns the frame loop.** Movement, combat and animation stay in
  Phaser; the Svelte UI and the game talk over a small event bus of meaningful
  state changes only.
- **Guests keep everything local.** `GameState` (versioned) is the persisted
  truth in IndexedDB, with clipboard save codes and no credentials inside.
- **In a world, the server owns what matters to others.** That means balances,
  the XP mark, paid outcomes, materials, homes, the Wilds, mail, projects and
  the library. The browser uploads its story-and-vitals progress document with
  revisions and a single play lease, and spends go through the server. Writes
  are idempotent and ledger-backed, and the server checks reported Habitica
  profiles for plausibility.
- **One copy of shared data.** `content/` is the single source for rules both
  sides need. Logic that must agree exactly (sync and ember rules, the Wilds
  generator, the calendar) has generated **parity vectors** that both the
  TypeScript and Go test suites replay.

The original plan, from when the game was called Fingersnap, is
[Fingersnap Plan.md](Fingersnap%20Plan.md); the expansion (worlds, homes, the
Wilds) is designed in [docs/expansion-design.md](docs/expansion-design.md).
The docs index is [docs/README.md](docs/README.md).

## Art

In-game sprites start from placeholder art drawn by code in
`src/game/textures.ts`, with the generated art packs layered on top: a props
atlas, terrain tiles, a 4-direction walk, enemy idle sets, foreground
occluders, NPC breathing animations, the warden's poses and per-class effects,
the Commons, the Tangle, residents, houses and items. The packs' sources are in
`assets/generated/`; `scripts/build-atlases.ts` packs them into
`public/assets/fingersnap/packed/` (the folder keeps the game's old name).
Procedural placeholders remain the fallback.

Imported characters (and other players) render as layered avatars composed
from Habitica's sprites, stacked in Habitica's own order. A small same-origin
subset ships in `public/assets/habitica/` (WebGL-safe), and the server's
sprite proxy fetches and caches any other piece the first time it's needed.
Pets follow as separate sprites; mounts need their layers cached before riding
is granted. Provenance, licences and attribution: [ASSETS.md](ASSETS.md),
[docs/habitica-assets.md](docs/habitica-assets.md) and
`assets/ASSETS_GUIDE.md`.

## Playtest hooks

The page exposes read-only hooks for playtests: `__fsPlayer`, `__fsEnemies`,
`__fsWarden`, `__fsWorld`, `__fsSafety`, `__fsDebug`, `__fsLink`, `__fsWilds`,
`__fsPapers`, `__fsHomes`, `__fsVillage`, `__fsRemote` and `__fsPresence`.
Dev builds add read-only hooks the tests wait on: `__fsFrame` (frames since the
area was built, the fade, whether input is live), `__fsDialogue`, `__fsToasts`,
`__fsBanners` and `__fsDevSaved` (see docs/testing.md).
Dev builds add levers that skip long walks and fights: `__fsDevHurt(n)`,
`__fsDevStrike(n)`, `__fsDevWarp(area, tx, ty)`, `__fsDevDodge(dx, dy)`,
`__fsDevSpeakNaming(force)`, `__fsDevPlace(x, y)` and `__fsDevCalendar(unix)`.

## Known limitations

- The outer Wilds run on the server but aren't walkable in the client yet.
  Garden and Hall home tiers, world moves and co-op combat are later work.
- Procedural sound effects only (no music), no gamepad, no installable app.
- Guest saves are local to one browser; save codes are the manual backup.
- The game's own art is all AI-generated for now (see
  [How it was made](#how-it-was-made)).

## Contributing

Contributions are welcome: code, writing, playtesting notes, and above all
human-made art. Sign off each commit (the DCO), run the checks before you open
a pull request, and read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Licences

| What | Where | Licence |
|---|---|---|
| Glimway's code | everything not listed below | [AGPL-3.0-or-later](LICENSE) |
| Glimway's art (AI-generated) | `assets/generated/`, `public/assets/fingersnap/` | [CC0 1.0](assets/generated/LICENSE): public domain, no credit needed |
| Habitica's sprites | `public/assets/habitica/` | [CC BY-NC-SA 3.0](public/assets/habitica/LICENSE), © HabitRPG, Inc. |
| Habitica gear numbers | `content/habitica-gear.json` | [GPL-3.0](content/habitica-gear.NOTICE.md), from Habitica's content data |

Future human-made art will live in its own folder under its own licence,
recorded in [ASSETS.md](ASSETS.md).

**Credits.** Avatar, gear and companion art from [Habitica](https://habitica.com),
© HabitRPG, Inc., licensed
[CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/); gear
statistics derived from Habitica's content data (GPL-3.0). Glimway is not
affiliated with or endorsed by Habitica. "Habitica" is a trademark of
HabitRPG, Inc.

Because Habitica's art is non-commercial, so is any instance that serves it.
That limit is on the Habitica art only, not on Glimway's own code or art.
Background: [docs/licensing-and-funding.md](docs/licensing-and-funding.md).
