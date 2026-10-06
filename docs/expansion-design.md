# Fingersnap expansion design: onboarding, homesteads, shared worlds

Status: revision 4 (2026-10-04), approved for implementation on the
`expansion` branch.

## Implementation status

Phases 1–6 have shipped on `expansion` (October 2026). The sections below
are still the design; where the build differs, this list says how.

| Phase | Shipped |
|---|---|
| 1 Onboarding | Title choice; connect guide with website, iOS and Android steps; labeled and ordered paste with preview and Swap; opt-in Remember on this device with Forget; Pip's gate nudge. |
| 2 Backend core | Go server (`server/`, SQLite) with the login-only identity check, allowlist, CLI and player invites, recorded client-side syncs with plausibility checks, verified checkpoints and pending credit, the ember ledger, the progress document with revisions and one play lease, guest-save migration, idempotent spends, nightly backups and the NixOS module. The browser's connected mode covers sign-in, the origin choice, takeover, offline play and reconnect, and spends through the server. |
| 3 First home | `WorldScene` split; Hearthwick Commons as a second safe area with Silas; campsite → cottage (15 embers); 14 decorations with placement; home rest (1 ember); read-only visits to members' cottages. |
| 4 Compact Wilds | The Tangle (`inner-1`, 3×3 permanent chunks) with camps, resource nodes, personal chests, charted points of interest, trinkets and fallen-hero lanterns. Materials have their first use in material-priced furniture. Guests get a fixed local Tangle. |
| 5 Homestead expansion | Workshop tier (storage chest and crafting bench, 10 recipes), mail between world members (recall, 30-day return), six village projects with visible village changes and papers, and the game calendar with festivals. The outer region (`outer-1`) turns every wick on the server; **the client does not walk into it yet**. |
| 6 Presence | `/ws` rooms per world and area (and per Wilds chunk), avatars with name tags and interpolated movement, five emotes. |

Also shipped, outside the original phases: **papers** (52 found texts in eight
collections, a Journal tab) and the **Hearthwick Library** (a local shelf for
guests, one shared shelf per world); the canon text pass.

Also shipped: **party worlds and world moves** (owner decisions
below; server details in [home-server.md](home-server.md#party-worlds-and-world-moves)).

Still to come: the outer Wilds in the client, Garden and Hall tiers,
Habitica-driven decoration, the party boss mirror, co-op combat and
checkpoint rewind.

**Owner decisions after revision 4** (these override the text below where
they differ):

- **Syncs stay client-side; the server checks the token only at login.** The
  browser fetches Habitica and reports the profile; the server makes one
  read-only `GET /user` per sign-in and never stores the token. Sessions slide
  for seven idle days, at most thirty days from login, so a verified
  checkpoint happens at least monthly.
- **Game-time calendar: one wick is seven real days.** Twelve wicks make a
  year, four Marks name the seasons, festivals fall on fixed days, and the
  outer Wilds turn at the end of every wick (the "Outer-region reset period"
  question below is settled: weekly, by wick). The inner region never resets.
- **The warden is village-built and is settled, not slain.** Blows clink off
  it; speaking the naming to its heart-lamp three times (Wenna's closure
  naming from the route stone, turned round: the road is held again), while
  it stands open after a lunge, settles it. Quest ids, events and stages are unchanged.
- **Papers and a shared library.** Found texts are a progression of their own;
  in a world, the library shelf is shared and keeps the first donor's name.
- **Persistent worlds with player invites.** A first login creates a solo
  world or joins the inviter's; every member may have three codes
  outstanding and create five in all. Worlds never move players on their own.
- **A party's world belongs to the party.** The first member of a Habitica
  party to sign in makes it (no personal owner; one per party). Members sign
  in with no code and no allowlist entry and land there; everyone else still
  needs a code or the allowlist, and a code that names a world still wins.
  Solo worlds stay their owners'. A settled member whose party has a world is
  asked once ("Your party has a world of its own here. Join them?"), and the
  Menu keeps the offer. Moves are at most one a day. Leaving a party never
  moves or removes anyone (the CLI removes).
- **Moving takes only what's yours.** This replaces the move rules under
  "Worlds" below: the homestead does **not** move. You keep your character,
  story, embers, pack and personal chest; your deed membership ends as
  leaving does (desolation for a last member), and furniture, the shared
  chest, shelf stock, Wilds claims and project contributions stay. Moves start
  from the village or the Commons with nothing pending and no parcels of yours
  on the road (recall them first); parcels waiting for you go back to their
  senders, and your unused invite codes now admit friends to the new world.
  Moving back is the same flow.
- **Readable invite codes.** Six words from a fixed 256-word list plus four
  digits (`amber-fox-river-lantern-moss-ivy-7392`, about 61 bits),
  case-insensitive and tolerant of spaces; old hex codes still work.
- **Costs set from the first build:** cottage 15 embers, workshop 30 embers
  plus 20 timber, 10 stone and 8 fiber, home rest 1 ember. These are starting
  values for playtesting. The migration cap stays at 30.

Revision 4 records the owner's decisions:

- **Syncs stay client-side** (browser → Habitica, as today). The server sees a
  token only once per login, to prove account ownership, and never stores it.
  The sealed token is gone, and the server's sync becomes "record a reported
  profile", with plausibility checks and verified checkpoints at login.
- **Remember on this device** is an opt-in IndexedDB store for the token,
  shipping in phase 1.
- Mobile-app paths for the connect guide come from research; anything
  unconfirmed is marked unverified in the copy.

Revision 3 incorporated a second review:

- Stale uploads never change vitals; story progress still merges.
- Sync and spends carry the client's current progress and commit only if the
  lease, revision, and safe area still hold after the Habitica request.
- Offline progress after a takeover has a defined reconciliation flow, and
  login and lease acquisition no longer require a lease.
- Guest-save migration has a one-time, account-level guard.
- Shared content lives in a Go package at the repository root, so `go:embed`
  works without a copy step.
- The sealed token has an expiry and a Forget that invalidates every copy.
  (Superseded by revision 4.)
- Quest ember gifts are granted by the server once per player.
- Phase 4 includes a first use for materials.

Revision 2 incorporated the first review. Main changes from revision 1:

- Logging in to Fingersnap and syncing with Habitica are now separate, and
  there is an explicit design for remembering the sync credential
  ("sealed token").
- Connected saves are split into a client-writable progress document and
  server-owned balances, with a field-by-field migration rule, save revisions,
  conditional writes, and an offline policy.
- Worlds are persistent Fingersnap worlds with explicit membership, optionally
  linked to a Habitica party. Leaving a party no longer moves anyone's home.
- Generated regions pin their generator version, so generator updates never
  reshape existing land. Personal chest claims and respawn cycles have their
  own schema.
- Combined-paste parsing no longer guesses by UUID shape (both credentials are
  UUIDs).
- Phasing is reordered so every phase can deliver its own progression. The
  first housing release is one cottage, a few decorations, and visiting.

This document extends [Fingersnap Plan.md](../Fingersnap%20Plan.md). Where it
changes an existing rule (mainly the security invariants and ember rules in
[import-contract.md](import-contract.md), and the safe-boundary rule in
`src/lib/habitica/sync.ts`), the change is called out in place.

## Goals

- A new player understands the Habitica connection and can complete it in
  under two minutes, from desktop or phone.
- A returning player can opt in to syncing without re-pasting their API token.
- Players have a lasting place of their own in the world that grows with
  real-life progress.
- Friends share a world: they see each other's homesteads, change the same
  wild regions, and work on shared projects.
- Exploration, small fights, and small loot stay fresh after the curated
  quest is finished.
- Anything that needs server state is invite-only and stays small.

## Non-goals

- Open public servers or matchmaking.
- PvP, trading economies, or anything that rewards grinding the game instead
  of doing real tasks.
- New Habitica write paths. The boundary in the plan is unchanged: the only
  planned write is still the optional, confirmed Reward purchase.
- Replacing the curated quest content with generated content.
- Native apps.
- Cheat-proofing. Worlds are small invite-only groups; the server protects the
  economy's bookkeeping (no double pays, no forged balances) but does not try
  to prove that a fight happened. See "Trust model".

## Principles

- **Habitica stays the source of progression.** Embers (XP turned currency)
  remain the main way real-life work enters the game. Homesteads and shared
  projects are new things to spend embers on, not new XP sources.
- **Guest play keeps working.** The demo adventure needs no account and no
  server. Server features appear only after connecting.
- **The server owns shared state and balances; the client owns the frame
  loop.** Movement, combat, and animation stay in Phaser on the client.
- **No write replaces a balance.** Embers, materials, and the XP mark change
  only through server operations that record why. A save upload can never set
  them.
- **Async before real-time.** Persistent shared state (homesteads, world
  changes, projects) comes first. Seeing other players move comes later.

---

## 1. Habitica onboarding

### Problems today

- The connect form is in the Menu panel, so many players never find it.
- Credentials live in memory only, so every visit starts with a re-paste.
- The ember mark is set at the first import and past XP is not paid
  (import-contract.md, "Embers"). A player who connects late has lost embers
  for all the XP they earned before that. Connecting early is in the player's
  interest, and the game does not say so.
- There is no help for finding the User ID and API Token.

### Title screen choice

On a new game, before Mara's first line, show two options:

- *Play as your Habitica hero*: opens the connect guide.
- *Wander as a guest*: starts the demo vitals as today.

One sentence under the first option explains the payoff: "From now on, every
10 XP you earn in Habitica becomes an ember that lights the road." Continuing a
save skips this screen.

### Connect guide

A short stepped panel replaces the bare form:

1. **Where to find the credentials**, with tabs:
   - **Website**: Settings → Site Data, User ID and API Token. *(Verify the
     current label and add a screenshot before shipping; the menu has been
     renamed before.)*
   - **iOS app** and **Android app**: menu paths differ by platform and
     version. *(Unverified. Check both apps and add screenshots.)*
2. **Paste.** Both the User ID and the API Token are UUID strings (Habitica's
   own data display tool validates both as UUIDs), so the parser cannot tell
   them apart by shape. Accepted input:
   - the two separate fields, as today;
   - labeled text in a single paste, e.g. `User ID: … API Token: …`, matched
     by label (case-insensitive, tolerant of punctuation and line breaks);
   - two unlabeled UUIDs in a single paste: the parser fills them in the
     order they appear (User ID first, matching Habitica's settings page) and
     shows a preview with a **Swap** button. Nothing is sent until the player
     confirms.
   Any other input (one UUID, three UUIDs, no UUID) shows an error that says
   what was found.
3. **Connected**: show the hero's name, class, and level, and the ember line.
   A failed sign-in after an unlabeled paste suggests swapping first.

### "Why does it need my token?"

An expandable section in the guide:

- What the game reads (one `GET /user`, listed fields).
- What it never does (the read-only list from the plan).
- An honest note that the token itself can write to the account, and that the
  game limits itself to reads in code that is public.
- Where the token goes: memory only, unless the player ticks **Remember on
  this device** (see "Remembering the token" in section 4); sent to the
  Fingersnap server only at login, to prove the account is theirs.

### In-world nudge

Guests who walk to the Hearthwick gate get a line from Pip pointing at the
connection, at most once per save. No modal.

### Remember on this device

Phase 1 adds the opt-in **Remember on this device** checkbox described in
section 4 ("Remembering the token"). It needs no backend.

### Testing

- Unit: paste parsing for labeled text (orders, labels, separators), two
  unlabeled UUIDs (order kept, swap works), and every rejected shape.
- Playwright: new game → guide → labeled paste → connected; unlabeled paste →
  swap → connected; guest path unchanged.
- Existing invariant tests: credentials never appear in saves or exports.

---

## 2. Homesteads

### Concept

Each connected player gets a plot in **Hearthwick Commons**, a new area east
of the village gate. Members of the same world have neighboring plots. A
homestead grows through tiers:

| Tier | Name | Unlocks | Ships in |
|---|---|---|---|
| 0 | Campsite | Bedroll (rest spot) | Phase 3 |
| 1 | Cottage | Indoor scene, decoration placement | Phase 3 |
| 2 | Workshop | Storage chest, crafting bench | Phase 5 |
| 3 | Garden | Plants that grow by calendar day | Later |
| 4 | Hall | Trophy wall | Later |

**Phase 3 is deliberately small:** campsite → cottage, a handful of
decorations, and visiting. Everything costs embers only, because there are no
gathered materials yet. Material costs, storage, crafting, and gifts arrive in
phase 5, after the Wilds (phase 4) provide materials. Exact costs need
playtesting.

### Safe area and resting at home

Today sync is accepted only in the village (`isSafeBoundary` in
`src/lib/habitica/sync.ts`), which is what keeps HP reconciliation honest.
Homes extend that rule as follows:

- **Hearthwick Commons becomes a second safe area.** It has no enemies, and it
  is reached only through the village. Sync is accepted in the village and in
  the Commons. `isSafeBoundary` changes from one area to a set of safe areas,
  and the existing "sync outside the safe boundary is rejected and changes
  nothing" tests are extended to the new non-safe areas (the Wilds).
- **Resting at your own bedroll** follows the hearth rules exactly, at a lower
  ember cost: it restores local HP and mana; for an imported hero at 0 HP it
  lifts the zero-HP lock only when paid with XP-earned embers. Resting is a
  server operation (it spends embers), so the earned/gifted provenance is
  checked by the server.
- **Resting in someone else's home** is not offered.

### What the house does not do

Revision 1 claimed a home checkpoint would solve the rewind/purchase
duplication problem in the plan. It does not. A home is a natural place to
*take* a checkpoint, but rewind still needs durable entitlements for paid
goods, and it must never roll back server-owned or shared state (embers,
materials, projects, gifts, other players' changes). Checkpoint rewind stays a
separate future design.

### Habitica-driven decoration (read-only, later)

- Achievements become wall plaques.
- Pet and mount collections fill a stable.
- Class picks the style of the workbench and trophy wall.
- Party quest bosses defeated in Habitica appear as trophies (verify what the
  API exposes about party quest history).

These need extra `userFields`. Add them to the projection only when the
feature ships, and verify each field against a real account
(habitica-foundations.md already flags this).

### Building model

- The plot is a fixed tile grid (e.g. 16×12 outside, 12×10 inside).
- Placeable items have a footprint, a collision box, and a category
  (furniture, decor, utility).
- Placement is validated on the server: the item must be owned and not
  already placed, the tiles free, and the tier high enough.
- The client renders from the same item definitions as the server validates
  against, so item definitions live in shared JSON (section 4, "Shared
  content and repository layout").

### Visiting

- World members' homesteads render in the Commons from the latest server
  snapshot.
- Visitors can walk in and look around. No editing another player's home.
- Phase 5 adds a mailbox for gifts (materials or adventure items), moved by
  the server so they cannot be duplicated.

---

## 3. Curated and generated content

### Layout

```
          Curated                     Generated
  ┌─────────────────────────┐  ┌───────────────────────────┐
  │ Hearthwick, Brackenwood │  │ The Wilds: regions of      │
  │ Ashwatch, story quests  │──│ chunks past the Commons    │
  │ Commons (homesteads)    │  │ inner regions: permanent   │
  └─────────────────────────┘  │ outer regions: reset on a  │
                               │ schedule                   │
                               └───────────────────────────┘
```

- **Curated:** story areas, NPCs, bosses, quests. Unchanged.
- **Generated:** the Wilds, grouped into regions of chunks, with small camps,
  resource nodes, chests, small puzzles, and ordinary enemies (wisps, beetles,
  later types). No story bosses.

### Regions and epochs

Maps are already built deterministically from seeded code
(`src/game/worlds.ts`). The Wilds reuse that approach per chunk, with one
addition: each region records the generator version it was created with, and
keeps it.

```
region epoch  = (worldId, regionId, generatorVersion, season)   -- stored
chunkSeed     = hash(worldSeed, regionId, epoch.generatorVersion,
                     epoch.season, chunkX, chunkY)
```

- When a region is first needed, the server creates its epoch with the
  *current* generator version and season and stores it. From then on, that
  region is always generated with the stored values.
- **Inner regions are permanent.** Their epoch never changes, so a generator
  update never reshapes land near home.
- **Outer regions reset on a schedule** (period to be decided). A reset
  creates a new epoch for that region, using the generator version current at
  that moment. This is the only way a new generator version reaches existing
  regions.
- **New generator versions** apply to newly created regions and to scheduled
  resets only.
- **The client keeps every generator version that any live epoch uses.**
  Generators live in versioned modules (`wilds/gen-v1.ts`, `gen-v2.ts`, …); an
  old version is deleted only when no epoch in any world references it.
- Every generated entity gets a stable id derived from its chunk and index,
  e.g. `camp:3:-2:1`. All state below is keyed by epoch + entity id.

**Players inside a region when it resets.** The server rejects claims against
an ended epoch with `epoch-ended`. The client shows a short "the Wilds shift"
moment and returns the player to the region's entrance in the new epoch.
Unclaimed rewards in the old epoch are lost; claims already accepted are kept.
Resets happen at a fixed, announced time (shown on the notice board a day
ahead) so they are not a surprise.

### Entity determinism

The client generates terrain. The server does not need terrain, but it does
need each chunk's entity list and loot rolls to validate claims. The parts of
the generator that decide entities and loot are written so they can be ported
to Go exactly: integer hash, no floating point, no `Math.random`, no iteration
order that depends on object key order. A shared test-vector file (epoch +
chunk → expected entities and loot) runs in both test suites.

### Shared changes, personal claims, and respawn cycles

There are two kinds of state:

**Shared entity state** (one row per epoch + entity), for things everyone sees
change:

| Entity | Effect of a claim | Reset |
|---|---|---|
| Camp | Cleared for everyone; claimer gets loot | Respawns after a timer |
| Resource node | Harvested for everyone; claimer gets materials | Regrows after a timer |
| Point of interest | Marked "Charted by <name>" | End of epoch |
| Fallen-hero lantern | Lit or unlit | See below |

Each shared entity has a **cycle** number. A respawn or regrowth increments it.
The client receives the cycle with the chunk state and sends it with a claim;
the server accepts the claim only if the cycle matches and the entity is
available. A delayed request from an earlier encounter therefore cannot
collect the next encounter's reward.

**Personal claims** (one row per player + epoch + entity), for things each
player gets once:

- Chests: every player can open each chest once per epoch.
- First-visit rewards for points of interest.

### Fallen-hero lanterns

A player defeated in the Wilds leaves a lantern at that spot. Another world
member can relight it for a small reward. Limits against farming:

- No reward for relighting your own lanterns.
- A lantern pays one relight reward, once.
- At most one lantern per player per region at a time (a new defeat replaces
  the old lantern).
- A daily cap on relight rewards per relighter.

### Trust model

A camp claim proves the camp exists, is available in the current cycle, and
has not been claimed. It does **not** prove a fight happened; a modified
client could claim camps without fighting. That is acceptable for small
invite-only worlds. The server limits the damage: claims are rate-limited per
player, each entity pays only once per cycle, and all grants are recorded in
the ledger so abuse is visible and reversible.

### Village projects (phase 5)

A notice board in Hearthwick lists world-wide projects, e.g. "Repair the north
bridge: 200 timber, 80 stone". Any member can contribute materials. A finished
project unlocks curated content (a new area, an NPC, a shop). This is the
plan's "contribution toward a village restoration project" candidate, made
shared. Projects are authored content; only progress is server state.

---

## 4. Backend

### Shape

- One Go binary, `fingersnap-server`, built from `server/` in this repo (one
  Go module rooted at the repository root; see "Shared content and
  repository layout").
- SQLite via `modernc.org/sqlite` (pure Go, no CGO, simple Nix packaging), in
  WAL mode with a single writer connection.
- WebSockets via `github.com/coder/websocket` for presence (phase 6).
- Runs on the home server next to the static site. Caddy handles TLS and
  routes `/api/*` and `/ws` to the Go server; `dist/` stays served as today.
- Packaged with a NixOS module beside `deploy/nixos/fingersnap.nix`.
- Nightly SQLite backups (`VACUUM INTO`), with a tested restore procedure.

```
 Browser ──HTTPS──► Caddy ──► dist/ (static)
    │                  └────► fingersnap-server ──► SQLite
    │                                │
    │                                └──► habitica.com (one GET /user per login)
    └──────────────────────────────────► habitica.com (syncs, as today)
```

### Login and sync are separate

The Fingersnap session cookie proves who you are *to Fingersnap*. It cannot
replace Habitica credentials, which every sync still needs. The two stay
apart:

| | What it is | Lifetime | Gives access to |
|---|---|---|---|
| **Fingersnap session** | HTTP-only cookie | 30 days, sliding | Your save, homestead, world |
| **Habitica token** | Raw token, in memory or remembered on the device (opt-in) | Per visit, or until Forget | Reading your Habitica profile, from the browser |

**Syncs go from the browser to Habitica, as today.** The server sees a token
only during login (below), and only to prove account ownership.

### Login and access

1. Client sends User ID + token to `POST /api/session`.
2. Server calls `GET /api/v3/user` once with those credentials (minimal
   `userFields`: id, name, stats, party id). Success proves the caller
   controls that Habitica account. The token is dropped at the end of the
   request: never stored, logged, or returned.
3. Server checks access: the User ID is on the allowlist, **or** the request
   carries a valid unused invite code. Redeeming an invite and adding the ID
   to the allowlist happen in one transaction, so two players racing for the
   same code cannot both win.
4. Server records the verified lifetime XP as a **verified checkpoint** (see
   "Trusting reported profiles") and sets an HTTP-only, Secure, SameSite=Lax
   session cookie (random id, stored hashed, 30-day sliding expiry).

Invites: an admin (initially the owner, by CLI) creates single-use codes. Each
allowlisted player can be given a small number of codes to hand out.

The server never calls Habitica except during login: no polling, no
background sync. Login calls use the server's `X-Client` header and honor 429
and `Retry-After`. Because only logins come from the server's IP, Habitica's
per-IP rate limit is not a concern at this scale.

### Remembering the token (opt-in, on device)

- The connect guide offers **Remember on this device**, off by default.
- When on, the User ID and token are stored in IndexedDB, in their own store,
  separate from saves. They are never included in save exports, never sent to
  the Fingersnap server after login, and never logged.
- A visible **Forget** button deletes them. Disconnecting asks whether to
  forget too.
- Exposure, stated plainly in the guide: a script injection on the Fingersnap
  origin could read a remembered token, and that token can write to the
  Habitica account. Players who don't want that leave the box unticked and
  paste per visit.
- This ships in phase 1. It needs no backend, and it works for guests too.

### Sync: the browser fetches, the server records

For connected players, a sync is:

1. **Fetch.** The browser calls Habitica `GET /user` directly, exactly as
   today (`src/lib/habitica/client.ts`: same projection, `X-Client`, rate-limit
   handling).
2. **Record.** The client sends `POST /api/sync` with the mapped profile, the
   play lease, `baseRev`, and its current progress document. All server calls
   go through one client-side queue, so this never overlaps a progress
   upload.
3. **Commit, in one transaction.** The server checks the lease and `baseRev`,
   applies the progress document (as an ordinary upload), checks the safe
   area using that progress, checks that the profile's id is the account's
   Habitica ID (else the account-switch rejection), then applies the sync
   rules (`sync.ts`, ported to Go with shared test vectors: HP credit against
   the stored baseline, ember credit against the stored XP mark), stores the
   new baseline and mark, writes the ledger, and bumps `rev`.

There is no external call inside the server's handling, so there is no window
between checking and committing. If the lease or `baseRev` is wrong, nothing
is applied and the client re-reads state and retries; the Habitica fetch is
harmless to repeat. Spends that depend on vitals or area (rest, revive) work
the same way: they carry the client's progress and commit in one transaction.

### Trusting reported profiles

The server cannot verify a profile the browser reports, so a modified client
could forge XP and mint embers. Within the trust model (small invite-only
worlds) this is acceptable, with three limits:

- **Plausibility checks.** A reported profile is rejected if its lifetime XP
  is below the stored mark by more than Habitica's death penalty allows, if
  level and XP are inconsistent with Habitica's level curve, or if HP/MP
  exceed their maximums. Ember credit per sync is capped (e.g. 200 embers);
  excess is held as `pending` and paid only after a verified checkpoint
  confirms it.
- **Verified checkpoints.** Every login is a genuine read. The server compares
  the verified lifetime XP with the stored mark; if the mark is ahead of the
  real account by more than a small tolerance, the player is flagged for the
  owner, and pending credit is dropped.
- **Ledger.** Every credit records the reported XP, so forged credit is
  visible and reversible by the owner.

**Invariant changes** (update import-contract.md when this ships):

- "Token in memory only" becomes: the token exists in client memory, and in
  IndexedDB only if the player opts in to Remember. The server holds it in
  memory only for the length of one login request; it is never written to
  disk, the database, backups, or logs.
- Request logging excludes bodies and the `x-api-key` header. A test runs a
  login with a recognizable token and asserts it appears nowhere in logs, the
  database file, or a backup.
- For connected players, the HP baseline (`importedProfile`), the XP mark
  (`emberXp`), and ember balances move to the server. Guest saves keep the
  current client-side rules unchanged.

### Worlds

**A world is a persistent Fingersnap group with explicit membership.** It can
optionally be linked to a Habitica party.

- A player's first login creates their own solo world, or joins one via the
  invite they used (an invite can name a world).
- A world owner can invite more players into the world.
- **Party link (optional convenience).** If a world is linked to a Habitica
  party, the server can tell members "these party members are allowlisted but
  not in this world" and offer them a join prompt. That is all the link does.
- **Leaving a Habitica party changes nothing in Fingersnap.** Sync never moves
  a player between worlds; it does not even read the party.

**Moving to another world** is a deliberate player action with a
confirmation screen that lists what happens:

- Allowed only from a safe area, with no pending server operations.
- The homestead (tier and placed items) moves with the player and gets a free
  plot in the new world.
- Personal inventory and ember balances move with the player.
- Unclaimed incoming mail is returned to senders; outgoing unclaimed mail is
  returned to the player.
- Contributions to the old world's projects stay there.
- Discoveries, lantern state, and Wilds claims belong to the old world and
  stay there.
- Rejoining a previous world is a fresh join; old world state is not
  restored to the player.

A player belongs to exactly one world at a time.

### What lives where

| State | Owner | Notes |
|---|---|---|
| Frame loop, movement, combat, animation | Client | |
| Guest save | Client (IndexedDB, as today) | Unchanged |
| Progress document (below) | Client writes, server stores | Conditional writes |
| Ember balance, XP-earned ember count, XP mark | Server | Ledger-backed |
| HP baseline (last accepted Habitica profile) | Server | Updated only by sync |
| Paid world outcomes (lit lanterns, opened chest, Ember Charm) | Server | Results of server spends |
| Materials, decorations, homestead | Server | Ledger-backed |
| Wilds state, discoveries, projects | Server | Per world |
| Presence (positions) | Server, memory only | Phase 6 |

### The progress document

The connected save splits `GameState` (`src/lib/state.ts`) into what the client
may write and what only server operations change.

**Client-writable progress** (the client uploads it; the server validates
shape and range only):

- `area`, `position`
- `quest`, accepted only if it does not move backward (story gifts are
  granted by the server when it advances; see below)
- `discoveries`, `defeatedEnemies` (curated areas), merged as unions
- story flags (not the economy flags below), merged as a union
- quest items in `inventory` (curated, non-purchasable ids)
- `hp`, `mana`
- `playSeconds`, only increasing

**Server-owned** (in the server's response, never accepted from an upload):

- `embers`, `xpEmbers`, `emberXp`
- economy flags: `embers:welcome`, `lit:*`, `opened:*`
- purchased items in `inventory` (`CHARM_ITEM` and anything bought later)
- `maxHp`, `maxMana`, the imported profile and `vitalsSource`, which come from
  the last accepted sync
- homestead, materials, decorations

The client merges the two halves into the `GameState` the game already uses,
so most game code does not change. Spends that today happen locally
(`spendEmbers`) become server calls for connected players; guests keep the
local path.

**Story ember gifts.** Today the client grants gifted embers at two quest
beats (`QUEST_EMBERS` in `src/lib/embers.ts`: 2 for `defeat-guardian`, 3 for
`return-village`). For connected players the client stops granting them.
Whenever an accepted upload (ordinary, merged, offline, or part of a sync)
advances `quest` past a gifted beat, the server grants that gift as gifted
embers in the same transaction, guarded by an `outcomes` row
`quest-gift:<event>`. The row makes each gift pay once per player no matter how
many uploads, devices, or offline sessions report the same stage. Because
`quest` is client-writable, a modified client could claim these 5 gifted
embers early; that is within the trust model, and gifted embers cannot lift
the zero-HP lock.

### Revisions, conflicts, and offline play

**Two version numbers, kept separate.** `version` (already in `GameState`) is
the schema version. `rev` is a per-player revision counter on the server that
increases by one on every accepted change, from a progress upload or from any
server operation that affects the player (sync, spend, claim, placement).
Acquiring a play lease does not change `rev`.

**One active play session per player.** `POST /api/play` issues a play lease
to one client. Every mutating call except login, logout, and lease
acquisition requires the current lease; a call with an old lease fails with
`superseded`, and that client shows "Playing on another device" with a
**Take over** button. Read-only calls need only the session.

**Client-side ordering.** Each client sends all server calls through one
queue, in order. Progress uploads, syncs, and spends never overlap, so with a
single lease a stale upload should only happen through a bug or a network
retry. The rules below make that case safe anyway.

**Conditional writes.** Every progress upload carries the `rev` it was based
on.

- **Current (`baseRev` = `rev`):** the server accepts the whole document and
  returns the new `rev`.
- **Stale (`baseRev` < `rev`):** something changed on the server since the
  client's copy (a sync, a rest, a revive, another device's upload). The
  server merges **story fields only**: `quest` maximum, unions of
  `discoveries`, `defeatedEnemies`, story flags, and quest items, and the
  `playSeconds` maximum. It **ignores the upload's vitals, area, and
  position** and keeps its own. It returns the merged document with status
  `stale`, and the client replaces its local copy, including vitals.

Stale vitals are dropped rather than merged. Taking the lower value (revision
2's rule) would let a delayed 0 HP save undo a paid rest, and would let an old
save erase Habitica healing that the sync baseline had already credited, so it
could never be claimed again. Dropping them can lose a little damage from the
stale window; in a single-lease game that window is a race, not a play
pattern.

**Offline connected play.**

- Exploring and fighting in curated areas work offline. Progress is saved to
  IndexedDB as before, together with the `rev` and lease it was based on.
- Anything that grants or spends server-owned state needs a connection:
  syncs, ember spends (rests, lanterns, the chest), Wilds claims, placement,
  upgrades. The UI disables these with "Needs a connection" rather than
  queueing them.
- The Wilds are not playable offline, since every reward there is a claim.

**Reconnecting after offline play.** The client never uploads offline
progress until it holds the lease:

1. It calls `POST /api/play`. If the lease is free, idle (no request in the
   last 2 minutes), or already this client's, it is granted. If another
   client is actively playing, the player sees "Playing on another device"
   and must choose **Take over**; it is never taken silently.
2. **Nothing changed on the server** (`rev` equals the offline copy's
   `baseRev`): the client uploads the offline progress as a current write,
   vitals included. This is the common case: one device, a dropped
   connection.
3. **The server moved on** (another device played, or a sync or spend
   happened before the connection dropped): the client uploads the offline
   copy as a stale write, so only story progress merges. It then shows what
   happened: "You played somewhere else while this device was offline. Story
   progress from this device was kept; health, mana, and position come from
   your latest session." The offline copy stays in IndexedDB as a recovery
   copy until the player dismisses the notice; it is never uploaded again.

There is no manual "pick which vitals to keep" option, because any client
choice of vitals would reopen the recovery problem above.

**Tests:** stale upload after a sync (healing kept), after a rest (paid
recovery kept), after a zero-HP revive, and after a purchase; two tabs taking
over from each other; offline reconnect with an unchanged server (`rev`
equal, vitals uploaded) and with a changed one (story merged, vitals from
server, notice shown, recovery copy kept); offline story progress that crosses
a gifted quest beat pays the gift once.

### Migrating a guest save

On the first login for a Habitica User ID, the player chooses **Bring this
device's save** or **Start fresh**. The choice is recorded once per account:

- `players.save_origin` (`migrated` or `fresh`) and `save_origin_at` are set
  in the **same transaction** as every migration grant and outcome below,
  using `UPDATE … SET save_origin = ? WHERE habitica_id = ? AND save_origin IS
  NULL`. If no row changes, another migration or fresh start already
  happened, and the request fails with `already-set` and grants nothing.
- This guard is per account, not per request. A second device with a
  different local save, a new idempotency key, or two simultaneous first
  logins cannot migrate twice or replace existing server progress.
- A local guest save on any later device stays on that device as a guest
  save, untouched. The login screen says it will not be merged.

What a migration carries:

- **Carried:** the client-writable fields listed above.
- **Vitals:** the server uses the verified profile from this login as the
  first import (same rules as today's first import), then sets `hp` and `mana` to the lower of the local and imported values if
  the local save already had imported vitals, so migration is never a heal.
  (This is a one-time comparison against a fresh read, not the stale-upload
  rule.)
- **XP mark:** set from the login's verified read of the account, exactly
  like a first import today. The local `emberXp` is not trusted.
- **Ember balance:** the local balance carries over as **gifted** embers,
  capped (e.g. 30), recorded in the ledger as `migration`. It never counts as
  XP-earned, because a local `xpEmbers` value cannot be verified; this keeps
  the zero-HP recovery rule sound. The migration screen says so.
- **Gifts already received:** the welcome gift (if the local save has
  `embers:welcome`) and the quest gifts for beats the local save has already
  passed are recorded as paid `outcomes`, without paying them again; the
  carried balance already includes them. Otherwise the welcome gift is paid
  at the first sync, as today.
- **Paid outcomes:** lit road lanterns, the opened chest, and the Ember Charm
  carry over as outcomes (they stay lit, opened, owned), recorded with reason
  `migration`. They are not refunded or re-granted.

After migration, the local save is kept as a read-only backup until the player
deletes it. Save export/import stays guest-only.

**Tests:** two simultaneous first migrations for one account (exactly one
succeeds); migration after a fresh start (rejected); migration from a second
device after a successful one (rejected, nothing granted); migration of a save
past both quest beats (no quest gifts paid again).

### Idempotency

Every request that changes server-owned state carries a client-generated
idempotency key. The server stores `(player, operation, key, request hash,
response, created_at)` in the same transaction as the change:

- Same key, same request: return the stored response, change nothing.
- Same key, different request: reject with `idempotency-mismatch`.
- Records expire after 7 days.
- Login is not keyed (it creates a new session each time), and sync needs no
  key (ember credit is computed against the XP mark, so a repeat pays
  nothing). Stored responses never contain credential fields.

### Data model sketch

```sql
players(habitica_id PK, display_name, world_id, rev,
        lease_id NULL, lease_seen_at NULL, flagged_at NULL,
        save_origin NULL, save_origin_at NULL,
        created_at, last_seen_at)
allowlist(habitica_id PK, added_by, added_at)
invites(code_hash PK, created_by, world_id NULL, created_at,
        used_by NULL, used_at NULL)
sessions(id_hash PK, habitica_id, created_at, expires_at)

worlds(id PK, owner_id, seed, habitica_party_id NULL, created_at)

progress(habitica_id PK, schema_version, rev, doc_json, updated_at)
sync_baselines(habitica_id PK, profile_json, xp_mark, updated_at)
balances(habitica_id PK, embers, xp_embers)
ledger(id PK, habitica_id, currency, delta, earned_delta, reason, ref,
       created_at)
inventory(habitica_id, item_def, qty, PK(habitica_id, item_def))
outcomes(habitica_id, outcome_id, reason, at, PK(habitica_id, outcome_id))
idempotency(habitica_id, op, key, request_hash, response_json, created_at,
            PK(habitica_id, op, key))

homesteads(habitica_id PK, world_id, plot, tier, updated_at)
homestead_items(id PK, habitica_id, item_def, x, y, rotation, placed_at)
mail(id PK, world_id, from_id, to_id, item_def, qty, sent_at,
     claimed_at NULL, returned_at NULL)

region_epochs(world_id, region_id, epoch, gen_version, season,
              started_at, ends_at NULL, PK(world_id, region_id, epoch))
entity_state(world_id, region_id, epoch, entity_id, cycle, state,
             by_id, at, available_at,
             PK(world_id, region_id, epoch, entity_id))
personal_claims(habitica_id, world_id, region_id, epoch, entity_id, at,
                PK(habitica_id, world_id, region_id, epoch, entity_id))
discoveries(world_id, region_id, epoch, poi_id, by_id, at,
            PK(world_id, region_id, epoch, poi_id))
lanterns(world_id, region_id, epoch, owner_id, x, y, lit_by NULL, at,
         PK(world_id, region_id, epoch, owner_id))

projects(world_id, project_def, progress_json, completed_at NULL,
         PK(world_id, project_def))
contributions(id PK, world_id, project_def, habitica_id, item_def, qty, at)
```

Balances and inventory change in the same transaction as the ledger row that
explains them, and every such transaction bumps the player's `rev`.

### API sketch

```
POST   /api/session          {userId, token, invite?} → cookie, player
DELETE /api/session
POST   /api/origin           {choice: migrate | fresh, save?} → state, rev   (once per account)
POST   /api/play             {takeOver?} → lease, full state, rev
POST   /api/sync             {profile, lease, baseRev, progress} → vitalsCredit, balances, rev
GET    /api/state            → progress, server-owned state, rev
PUT    /api/progress         {lease, baseRev, doc} → doc, rev, status (current | stale)
POST   /api/spend            {kind, target, lease, baseRev, progress?, key} → balances, outcome, rev
GET    /api/world            → world, members, project progress
POST   /api/world/move       {worldId, key}
GET    /api/homestead/:id    → layout (own or a world member's)
POST   /api/homestead/place | remove | upgrade   {…, key}
GET    /api/wilds/region/:id → epoch, entity states with cycles, own claims
POST   /api/wilds/claim      {epoch, entityId, cycle, key}
POST   /api/wilds/lantern    {epoch, ownerId, key}
POST   /api/mail | /api/mail/:id/claim          (phase 5)
POST   /api/projects/:id/contribute             (phase 5)
GET    /ws                                      (phase 6)
```

Every mutating call requires the current play lease, except `/api/session`
(login, logout, forget), `/api/origin` (which runs before any lease exists),
and `/api/play` (which acquires one). `GET` calls need only the session.

### Shared content and repository layout

`go:embed` can only embed files in the Go package's own directory and its
subdirectories, so the shared JSON cannot live under `src/` while the Go code
lives in a sibling `server/` directory. Layout:

```
go.mod                      module root is the repository root
content/                    Go package "content", canonical shared data
  embed.go                  //go:embed *.json  → content.FS
  items.json  tiers.json  loot.json  projects.json
  vectors/                  test vectors (sync rules, Wilds generation)
server/                     Go packages (cmd/fingersnap-server, internal/…)
src/                        frontend, imports ../content/*.json via Vite
```

- `content/` is the single copy. No generated duplicate and no copy step, so
  `npm run build`, `go build ./...`, and the Nix build all read the same
  files.
- The frontend imports the JSON directly (Vite allows imports from anywhere
  in the project root). TypeScript types for it live in `src/lib/`, and a
  unit test validates the JSON against them.
- The Go `content` package exposes typed loaders over `content.FS`, and a Go
  test validates the same files.
- Existing TypeScript content (`src/content/world.ts`, dialogue) stays where
  it is. Only data the server must also read moves to `content/`.
- The Nix package for the server uses the repository root as its source, so
  `content/` is inside the build. Test vectors are in `content/vectors/` but
  only test code reads them.

### Real-time presence (phase 6)

- One WebSocket per player, joined to a room per (world, area).
- Clients send position and facing at about 8 Hz while moving; the server
  relays to the room. Nothing is persisted.
- Other players render as their Habitica avatar with interpolation, plus
  emotes.
- Co-op combat comes later, if at all. The likely model for a small trusted
  group: the first player in an area owns its enemies and broadcasts their
  state; ownership passes on when they leave.

### Backend acceptance tests

- Token never in logs, database, or backups (login, sync, failed sync).
- Invite redemption race: two concurrent redemptions of one code, exactly one
  succeeds.
- Duplicate requests: same idempotency key twice pays once; same key with a
  different body is rejected.
- Concurrent claims: two players claiming one camp in the same cycle, exactly
  one succeeds; a claim with an old cycle is rejected.
- Personal chest: two players each open the same chest once; a second open by
  the same player is rejected.
- Epoch end: a claim against an ended epoch is rejected with `epoch-ended`.
- Cross-world access: a player cannot read or change another world's
  homesteads, Wilds, or projects.
- Stale progress after sync, rest, zero-HP revive, and purchase merges story
  fields only and keeps the server's vitals; uploads containing server-owned
  fields have them ignored.
- Sync outside a safe area is rejected and changes nothing.
- Sync with a stale `baseRev` or an old lease commits nothing, and the next
  sync credits the same healing and XP.
- Play lease takeover: the old lease's writes fail with `superseded`; login,
  `/api/origin`, and `/api/play` work without a lease.
- Offline reconnect with unchanged and changed server state, as listed under
  "Revisions, conflicts, and offline play".
- Migration guard: simultaneous first migrations, migration after a fresh
  start, and a second device's migration all grant nothing beyond the first.
- Quest gifts: each pays once per player across repeated, merged, offline,
  and migrated uploads.
- Reported profiles: implausible profiles are rejected; credit above the
  per-sync cap is held as pending and settled or dropped at the next login's
  verified checkpoint; a profile for another Habitica ID is rejected.
- Backup and restore: restore a nightly backup into a fresh server and verify
  balances, ledger sums, and `rev` values match.
- Go/TypeScript parity: sync rules and Wilds entity/loot generation pass the
  same test vectors in both languages.

### Client prerequisites

- `src/game/scenes/WorldScene.ts` is about 2,300 lines. Before adding the
  Commons, the Wilds, or remote players, split it into area construction,
  entity/enemy logic, and a network layer.
- Add a Fingersnap API client beside `src/lib/habitica/`, with the same typed
  error approach as `client.ts`.
- Add event-bus events for server state (state loaded, superseded, epoch
  ended, homestead loaded).

---

## Phasing

Each phase ships on its own and delivers its own progression.

| Phase | Scope | Needs backend |
|---|---|---|
| 1 | **Onboarding.** Title choice, connect guide, labeled/ordered paste with preview and swap, Remember on this device, Pip nudge. | No |
| 2 | **Backend core.** Login via a one-time Habitica identity check, allowlist and invites, recorded client-side syncs with plausibility checks and verified checkpoints, server-side sync rules and ember ledger, progress document with revisions and play lease, guest-save migration, backups, NixOS module. | Yes |
| 3 | **First home.** `WorldScene.ts` split; Hearthwick Commons as a safe area; campsite → cottage; a few decorations; home rest; visiting world members. Embers only. | Yes |
| 4 | **Compact Wilds.** One small permanent inner region (a few chunks): camps, resource nodes, personal chests, discoveries, lanterns. Materials appear, with a first use: a few cottage decorations bought with materials (from a Commons vendor or a recipe board), so gathering pays off right away. No scheduled resets yet. | Yes |
| 5 | **Homestead expansion.** Workshop tier, storage, crafting, material costs, mailbox, first village project; outer regions with scheduled resets. | Yes |
| 6 | **Presence.** WebSocket rooms, avatars and emotes. | Yes |
| Later | Garden and Hall tiers, Habitica-driven decor, party boss mirror, co-op combat, checkpoint rewind. | — |

## Other ideas worth keeping

- **Party boss mirror.** When the Habitica party is on a boss quest, a shadow
  of that boss roams the Wilds. Read-only; needs the party quest fields.
- **Streak weather.** A long run of completed dailies makes the village sunny.
  Cosmetic only, so a broken streak never costs anything.
- **Garden on real days.** Plants grow by calendar day, not by play time, so
  checking in daily has a small payoff.

## Decisions

Resolved in revision 2:

- **What defines a world:** persistent Fingersnap worlds with explicit
  membership; a Habitica party link is optional and only drives join prompts.
- **Remembering credentials:** opt-in IndexedDB storage on the device, in
  phase 1 (revision 4).
- **Server-side token handling:** syncs stay client-side; the server sees a
  token only during login (revision 4).
- **Async or real-time first:** async (phases 3–5 before 6).
- **Guests in shared worlds:** no. Shared worlds need a verified Habitica
  identity.
- **Repository layout:** one Go module rooted at the repository root, with
  the server in `server/` and shared data in the `content/` package (revision
  3; see "Shared content and repository layout").

Still open:

1. **Login-time token check:** the server's single `GET /user` per login is
   the only server-side token use. Mention it in the public README, and
   confirm with the Habitica API community if anyone objects.
2. **Outer-region reset period:** monthly is the recommended start; weekly
   risks feeling like a chore.
3. **Migration ember cap:** 30 is a placeholder; set it from real save data
   once a few players exist.
4. **Phase 3 costs:** cottage and decoration prices in embers, from
   playtesting.

## Risks

- **Generator drift between TypeScript and Go.** Mitigated by integer-only
  entity/loot logic and shared test vectors in both test suites.
- **Old generator versions accumulate in the client.** Mitigated by retiring a
  version once no epoch references it; inner regions pin versions forever, so
  keep inner-region generators small.
- **Token exposure.** On the server: only during login, never persisted,
  scrubbed logging, and the log/database/backup test. On the device: only
  with Remember ticked, stated plainly in the guide.
- **Forged profiles.** Mitigated by plausibility checks, capped credit with
  pending settlement at verified checkpoints, and the ledger.
- **Habitica API changes.** Mitigated by verifying against a live account
  before each phase and keeping fixtures.
- **Scope.** Phases 4 and 5 are each larger than the whole current demo. Keep
  each phase's content small and grow it after it is fun.
