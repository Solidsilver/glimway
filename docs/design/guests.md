# Guests on the server

Status: **agreed with the owner, 2026-10-07**, including the smaller decisions below.
**Timing changed the same day:** Habitica comes first. Steps 1–2 ship in 0.3 (Server-first),
and local guest play is dropped there, ahead of step 4 (owner: every player today has Habitica).
Steps 3, 5 and 6 move to the standalone track, which brings guests back as accounts (see
[plan.md](plan.md)). This is the "Guest accounts" foundation in [plan.md](plan.md).

## Decided (owner, 2026-10-07)

- A guest is an account without Habitica, invite-only like everyone else.
- It opens the way to a version of Glimway without Habitica.
- Nobody plays yet, so prefer clean breaks over compatibility code.
- **Sign-in is a key phrase now, with passkeys later** (direction A below).
- **Ember gates stop guests.** Guests earn embers only from story and gifts. A later
  "non-Habitica" update can give them a source of their own.
- **Guests can invite**, under the same limits as everyone else.
- **The no-server game is dropped.** Glimway needs a server. Local-only guest play goes.

## The heart of it

Today the server has no idea of an account apart from a Habitica hero. `habitica_id` is the
primary key of `players` and the foreign key in 22 of 25 migrations. Sign-in is a Habitica token
check (`login` in `server/internal/api/api.go`). The session checkpoint stores a Habitica profile,
and embers are paid from Habitica XP. So the work is three changes:

1. **An account that isn't a Habitica id.** Every table keys on an opaque `account_id`. Habitica
   becomes one way to prove who you are, held as a sign-in method.
2. **A sign-in that isn't Habitica:** the key phrase.
3. **A profile source.** One place answers "what's this hero's class, level, look, companions,
   and where do their embers come from". Habitica answers it today; guests get "none".

Admission, linking, devices and limits sit on those three.

## Identity and sign-in (decided: key phrase, passkeys later)

- **The key phrase.** Eight words from the invite word list (about 88 bits with a 2048-word list,
  64 bits with today's 256 words; grow the list or add words to stay near 80 or more). Generated
  by the server, shown once at account creation, stored only as a hash. Case, spaces and hyphens
  don't matter, as with invite codes.
- **Remember on this device** works as it does for the Habitica token: opt-in, kept in the
  credentials database apart from the save, deleted by **Forget**. With it on, a session that
  runs out signs back in without asking.
- **Sign-in methods are rows** (`sign_ins`: account, method, secret hash or Habitica id). Methods
  now: `phrase` and `habitica`. A passkey later is one more method, not a redesign.
- **Sessions stay as today**: a cookie per device, seven idle days, thirty in all.
- **Several devices.** Type the phrase on the new device, or show a short pairing code on a
  signed-in device (single use, ten minutes) and type that instead.
- **Losing a device.** The Menu lists your signed-in devices; sign any of them out. If the phrase
  may have gone with it, make a new phrase, which signs out every other device.
- **Losing the phrase and every device.** The operator issues a one-time reset code from the CLI.
  There's no email, by design: the server is invite-only and the operator knows everyone.
- **Passkeys later** need HTTPS, a Go WebAuthn library and a fixed domain. Moving the server's
  domain would strand every passkey, so the phrase stays as the fallback.

## Admission

- **A guest is created with an invite code**, the same codes as today. An unnamed code gives a solo
  world; a code naming a world puts the guest in it. The world-choice flow doesn't apply, since it
  turns on a Habitica party.
- **Codes are the only way in for guests.** The allowlist is keyed by Habitica id, and party
  admission needs a Habitica party.
- **Guests invite like everyone else:** three open at a time, five in all, none from a party's
  world, none from a flagged account. Invites can now chain from guest to guest, so the server cap
  below is the real bound.
- **A per-server account cap** in config (default 50, operator can raise it). A full server refuses
  new accounts with a plain "this world is full" and leaves existing ones alone.

## The profile source

One seam, Go and TypeScript: `profile_source` on the account (`habitica` | `none`, later
`glimway`), and one function each side that every reader of class, level, look, companions and
ember earning goes through. Nothing else reads the Habitica profile directly.

| | Habitica | None (guests) |
|---|---|---|
| Name | Habitica profile name | Chosen at creation, Wren by default |
| Look | Habitica preferences and gear | The default guest look (Wren) |
| Class | Habitica | None |
| Level | Habitica | None: guest combat stats as today |
| Companions | Habitica pets and mounts | None |
| Embers | 1 per 10 Habitica XP, plus story and gifts | Story and gifts only |
| Vitals | Imported once, then game-local | Guest vitals, game-local |

What guests get from each system in [plan.md](plan.md):

- **The open map:** everything. Same generator and endpoints. Every obstacle has a tool way, and the
  Keeper's hand and way-lamps are for everyone.
- **Quests:** the tree up to the first ember gate (chapter 2's 50 embers). Gates stop guests until
  a non-Habitica update gives them an ember source.
- **Magic:** none. No class means no workings and no signature ability (magic.md, "Classless
  players and guests"). Mana exists for rests.
- **Pets and riding:** none. Companions are only real Habitica pets (boundary rule 2).
- **Fishing:** all of it. Rods and fish are Glimway's own.
- **Homestead, crafting, mail, library, projects, presence:** all of it. Guests gain these by
  becoming accounts.
- **Gold purse:** a purse that starts empty and fills only from other players (shelf sales, and
  letters and gives once guests can receive them); no top-up, since there's no Habitica to move
  gold from (owner, 2026-10-09; [purse-and-wardrobe.md](purse-and-wardrobe.md) section 5).
- **Wardrobe:** none. Guests look like Wren.

## Linking Habitica later

- **Link:** a signed-in guest connects Habitica. The server checks the token once, as at sign-in
  today, and adds a `habitica` sign-in row. Profile source becomes `habitica`. The XP mark starts at
  the hero's current lifetime XP, so there's no back pay, and vitals import once, the way a first
  Habitica sign-in does today (the import half of `origin`). The display name becomes the Habitica
  name.
- **Already here:** if that Habitica hero already has an account on this server, refuse. No merges.
- **Unlink:** profile source goes back to `none`. Class, look and companions go; embers already
  earned stay, since they're Glimway's. The XP mark is kept against that Habitica id, so re-linking
  the same hero never pays twice. Unlinking needs a phrase on the account first, or there'd be no
  way back in; a Habitica-first account is offered one at that point.
- **Party worlds:** linking doesn't move anyone. A newly linked guest whose party has a world can
  move there through the existing world move.

## No server, no game

The static build is dropped. Glimway needs a server.

- **Goes:** the local guest save (`src/lib/save.ts` as the guest's truth), save codes, the
  "bring this device's journey" choice at first sign-in (the migrate half of `origin` and
  `players.save_origin`), and the "plays as a guest when the API is missing" fallback in dev and in
  guest e2e specs.
- **Stays:** the connected cache, so a signed-in player still plays offline in the curated areas
  and uploads on reconnect.
- **The title screen** asks: sign in with Habitica, sign in with a key phrase, or join with an
  invite (then pick Habitica or guest). No server answering means a plain "can't reach the world"
  screen.
- **Docs to rewrite:** README ("You can play three ways", guest play, the static-site deploy note
  "a working guest-only game"), `docs/home-server.md`, and the expansion principle that guest play
  needs no server.
- **Tests:** guest e2e specs run against a test server with a seeded guest account instead of
  blocking `/api`.

## Abuse and cost

- Invite-only plus the account cap bound the number of accounts. Per-member invite limits already
  exist.
- A guest sign-in costs no Habitica budget, so it's cheaper than today's sign-in. A long phrase
  can't be guessed; keep the per-IP login limit anyway, and add a per-account limit on failed
  pairing codes.
- Storage grows per world (chunk blobs, change rows). Each solo world grows its own map, so watch
  the world count; the frontier bounds each map.
- **Operator CLI:** list accounts (method, world, last seen), sign an account out everywhere, issue
  a reset code, remove an account, set the cap.

## Smaller decisions (owner confirmed, 2026-10-07)

- Guests pick a display name at creation, Wren by default; the look is always Wren's.
- Account cap: 50 per server.
- Linking a Habitica hero that already has an account here is refused.
- Guests have no level; combat uses today's guest stats.
- The invite word list grows so an eight-word phrase reaches about 80 bits or more.

## Build order

Each step ships on its own and leaves the game working.

1. **Account ids.** Rename `habitica_id` to `account_id` across the schema, Go and the TS API types
   (`habiticaId` → `accountId`). Existing rows keep their value as the id; new accounts get random
   ids. Add `sign_ins` and backfill a `habitica` row per player. No behaviour change.
2. **The profile source seam** in Go and TS, Habitica only. Every class, level, look, companion and
   ember read goes through it. Tests show nothing changed.
3. **Guest accounts.** Create with an invite and a name, the key phrase, sign in with it, remember on
   device, the account cap, operator CLI (list, reset code, remove). New title screen.
4. **Drop local guest play.** Remove the guest save path, save codes and the migrate choice; move
   guest e2e specs onto a test server; rewrite the README and deploy docs.
5. **Devices.** List and sign out sessions, pairing codes, make a new phrase.
6. **Link and unlink Habitica.**

Steps 1–4 are the minimum before W1. Steps 5 and 6 can follow in the same release.
