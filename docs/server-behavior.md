# Server behavior and migration notes

These implementation and migration notes were moved from the former home-server
guide when deployment became generic. Earlier phase sections record behavior
at the time they landed; later sections describe subsequent changes. The source
and tests are authoritative. For installation, proxy setup and backups, use
[the self-hosting guide](home-server.md).

## Login limits and player invites

The backend pre-checks allowlist membership or an eligible unused/unexpired
invite before creating a limiter bucket or calling Habitica, then rechecks
access in the transaction. A sign-in with neither passes the pre-check only
when the client names the Habitica party it expects (`party` in
`POST /api/session`, read from the profile the browser already fetched), that
party has an open world here, and the CLI hasn't removed the account; the
verified party must then match the claim (see "Party worlds and world moves").
Those party-only attempts spend their own upstream budget, a quarter of the
global one (at least one a minute), so strangers can't use up the calls that
allowlisted and invited players need. Default limits are four concurrent identity proofs,
ten eligible attempts per IPv4 address or IPv6 /64 per minute, and sixty actual
upstream calls globally per minute (including the single permitted 429 retry).
Flags are `-login-concurrency`, `-login-rate`, and `-login-global-rate`.
The bounded IP map evicts its oldest bucket when full. Client IP is RemoteAddr
unless its peer is a configured trusted proxy; only then is the last
X-Forwarded-For hop used. Caddy's localhost peer is trusted by default. Configure
`-trusted-proxies`, `GLIMWAY_TRUSTED_PROXIES`, or the Nix `trustedProxies` option;
an empty value trusts no proxy.

Authenticated, unflagged world members can create an invite with
`POST /api/invites`, sending `Content-Type: application/json` and the body `{}`
(an empty body is rejected). No play lease is needed. `GET /api/invites` lists
hash-only metadata for active unused codes and used history (`used: true`);
`DELETE /api/invites/:id` revokes an unused code. Three outstanding codes and
five total lifetime creations per player are allowed. Expiry, use and revocation
do not restore the lifetime budget. Codes expire after 30 days. Raw codes are
returned only at creation. Admin CLI invites also expire after 30 days, and are
under the owner's control rather than the player budget. Invites admit new
players to the inviter's world and preserve existing players' world membership.

### Party worlds and world moves

A Habitica party's world belongs to the party, not to a person: its
`worlds.owner_id` is empty and `habitica_party_id` names the party. A party has
at most one (a unique index, migration 023). It is **for that party only**: no
invite code leads into it. The party id comes only from the identity check at
sign-in (`players.habitica_party_id`); the token is used once and never
stored, and the party is never read in between.

- **Who opens one.** When an account the operator let in (an `allowlist add`
  entry, or an invite code: `allowlist.added_by` other than `party`) signs in
  and its party has no world here, the server makes it in the same
  transaction (`worlds.opened_by`, migration 024). Two members signing in at
  once still make one. An account let in *through* a party never opens
  another party's world, by signing in or by asking, so party admission can't
  chain from one party to the next. `allowlist add` on such an account makes
  it the operator's (`added_by` becomes `cli`). A member whose session
  predates the world can ask: `POST /api/world/party {}` (session only, no
  lease; `no-party`, `party-closed`, or `party-open-denied` for an account
  let in through a party). `GET /api/world` says `partyCanOpen`. Making a
  world moves no one.
- **Members come in without a code.** A player whose verified party has an
  open world here may sign in with no invite and no allowlist entry, when the
  client named that same party; they are asked where to live (below), are
  added to the allowlist (`added_by` = `party`) and stay on it. Everyone else still
  needs an invite code or the allowlist. An account removed with
  `allowlist remove` is not let back in by its party (only `allowlist add` or
  a CLI code does that). An account let in through a party makes **no invite
  codes anywhere**, not even from a world of its own (`POST /api/invites` →
  403 `party-admitted-invites`; `GET /api/invites` says `partyAdmitted: true`,
  and the Menu says codes come from the operator or an invited friend).
  Otherwise its invitee would count as operator-admitted and open their own
  party's world, and admission would chain. `allowlist add` lifts it.
- **No codes into a party's world.** A resident can't make invites
  (`POST /api/invites` → `party-world-invites`; `GET /api/invites` says
  `partyWorld: true`, and the Menu says why), `invite WORLD-ID` refuses one,
  and an older code naming one admits no one (refused at the pre-check and at
  redemption, and left unused). Friends outside the party are invited from a
  world of your own. A move into a party's world leaves your waiting codes
  naming the world you left.
- **First sign-in:** a code that names a world decides (also for an already
  allowlisted newcomer, whose code is then used up), with no question.
  Otherwise a newcomer (no player row yet) whose verified party has a world
  here, or who may open one (the operator-admitted rule above), is **asked**:
  join the party's world (the question carries its `members`), or start a
  world of their own. Everyone else gets a solo world of their own (theirs
  alone; it never becomes a party's).
  - The token is still sent once and never stored, so the question doesn't
    cost a second sign-in. `POST /api/session` sets the session cookie and
    answers `{"worldChoice": {habiticaId, displayName, partyWorld,
    partyCanOpen}}` instead of a snapshot. The sign-in is held in
    `pending_sessions` (migration 025: the verified profile and party, the
    same lifetimes as a session, no player row); only the world waits.
  - Until it is answered every other call (state, origin, play, world reads,
    invites, …) refuses with 409 `world-choice-required`, and presence admits
    no socket. `GET /api/world/choice` asks again (a reload, or a tab closed
    mid-choice: the cookie still holds it; it slides like a session). Its
  `partyAdmitted` says the newcomer came in through the party (the gate then
  says invite codes come from elsewhere). When nothing is left to ask (the
  party's world can't be had any more), it makes them a world of their own,
  as sign-in would have, and answers 409 `world-chosen` (read the state).
  - `POST /api/world/choose {"choice":"party"|"own"}` answers it once: the
    player is made in the party's world (opening it now, with `opened_by`, if
    it has none and they may: `party-closed` / `party-open-denied` /
    `no-party` otherwise, the question still standing; an account let in
    through the party gets `party-closed` once the party is closed or party
    admission is off, even though its world exists) or in a new world of
    their own, and the held sign-in becomes a session with the same cookie,
    answered with the snapshot. Any other device's held sign-in for the same
    account becomes a session in that world too. Asked again afterwards:
    409 `world-chosen`. Logout and `allowlist remove` end a held sign-in.
  - Choosing their own world records the party's offer as shown (no prompt
    straight after), and the Menu keeps it. It is reversible through the move
    below. The choice itself isn't a move: the first move after it is open
    at once, and the day's cooldown counts from that move.
  - A newcomer still choosing doesn't open the party's world by signing in;
    only choosing it does.
- **Settled players** see `GET /api/world` report their party's world
  (`partyWorld`, `party: true`, no owner) when they live elsewhere, with
  `prompt: true` until `POST /api/world/prompt {"worldId"}` records that the
  join prompt was shown (once per player and party world; table
  `party_prompts`). `partyHome` says they live in it. The offer stays in the
  Menu.
- **Leaving the Habitica party.** At sign-in, a resident of a party's world
  whose verified party is no longer that one is warned: `party_left_at`
  records the first such sign-in, and `GET /api/world` carries `leaver`
  (`moveOutAt`, `moveOutIn`, `hasOwn`). They keep playing for `PartyGrace`,
  three days. Rejoining and signing in again clears it. **Leave now**
  (`POST /api/world/leave {lease, baseRev, key, progress}`, keyed) moves them
  at once to the oldest world they own, or a new one made for them, with no
  move cooldown (from the village or the Commons, parcels home first;
  `still-in-party` if they haven't left). At the first sign-in after the
  grace period the server moves them out the same way, wherever they stand
  (off the village and the Commons they arrive in the village; parcels they
  sent stay on the road for their recipients): pack and personal chest come
  along, homestead membership, placed things and shared chests stay, the
  ledger records the move and a live presence socket follows.
  `movedOutAt` stays set until `POST /api/world/notice {}`, so the next screen
  says what happened.
- **Older person-owned links** (migration 022 let an owner link their world
  to a party). Migration 023 keeps the party id on those worlds only as a
  record: they never count as the party's world, and their residents aren't
  prompted to leave for the party's world. They keep working: the owner and
  everyone living there stay, the owner can always move back, and invite
  codes still lead into them. To fold such a group into its party's world,
  the operator runs `party adopt WORLD-ID` (below); until then a resident who
  isn't its owner and leaves can't come back, and the move screen says so.
- **Moving:** `POST /api/world/move {worldId, lease, baseRev, key, progress}`
  is one keyed, idempotent transaction under the usual lease and current-
  revision rules.
  - Allowed targets: your party's world, or a world you own (moving back).
  - **At most one move per 24 hours** (`move-cooldown`), counted from the
    last `world-move` ledger row. `GET /api/world` (and the move's answer)
    carries `moveOpensAt` (server clock) and `moveOpensIn` (seconds left); the
    move screen counts down from `moveOpensIn` on the device's own clock, and
    a `move-cooldown` refusal always shows the line.
  - Only from the village or the Commons, and only with no goods parcels you
    sent still in transit (`mail-in-flight`: recall them first; a move never
    takes back a gift on its own). A recalled or returned warden-set tool goes
    to the sender's personal chest when they already carry one, so it travels
    with them.
  - Your character, story, glims, pack and personal chest come along (they
    belong to the player, not the world). Your homestead membership ends as a
    "leave" does (the last member out starts desolation); placed furniture,
    the shared chest (`GET /api/world` counts warden-set tools left in it, for
    a warning), gate shelf stock, Wilds claims and project contributions stay.
    `leaving.deedCost` says what a deed costs in the next world (the first
    deed is free; later ones aren't).
  - Parcels waiting for you go back to their senders (`recipient-removed`).
    Thank-you notes stay readable on both sides, in any world.
  - Your unused, unexpired invite codes are retargeted to the new world,
    unless it's a party's.
  - The ledger records a zero-delta `world-move` row (`ref` = `from>to`).
  - A live presence socket is moved to the new world's rooms (the old room
    sees `leave`; a full room sends the mover an empty roster).
  - A replay with the same key returns the first answer and moves nothing,
    during the cooldown too.

### Witnessing

When a player's progress lands with one of the story's shared beats in it,
the players standing near them see it and keep a journal line, "you were
there":

- the Warden's naming (the quest reaching `guardian-defeated`), the last
  lantern (`lantern-lit`), and settling an Echo (a new `echo:<member>` flag);
- relayed only from the server's own record of the beat: the doer's upload
  (`PUT /api/progress`, a sync, a spend, or a keyed mutation's progress)
  whose merge adds it, after the commit. Merges only ever add a beat once, so
  each witness hears it once per beat and doer. A stale upload (another
  device catching up) relays nothing;
- through the presence hub, to every peer connected in the doer's world and
  room who last stood within `WitnessTiles` (10 tiles, 160 px) of where the
  doer last stood, as `{"type":"witness","beat","habiticaId","name"}`. The doer
  must be standing in that room right now, in the beat's place (Ashwatch
  Ruin for the Warden and the lantern, a Wilds chunk for an Echo, as both
  their saved area and their presence room say): an offline journey caught
  up later is no one's moment. No client can send one (the hub closes a
  socket that tries, 1008 `invalid-message`).

The witness's story doesn't move. Their client shows the moment, a lantern
over the doer, and keeps a story flag `witness:<beat>:<doer id>:<name>`
(`echo:nan` is written `echo-nan`), once per beat and doer: a journal line,
never an economy flag or a reward (src/content/witness.ts). A witness whose
own Warden still waits sees it rest a moment; then the stone remembers its
pose and keeps waiting for their own naming. Echo lines never name whose
Echo it was. No migration, no new route.

**Operator controls** (run as the service user, like `allowlist`):

- `-party-admission=false` (env `GLIMWAY_PARTY_ADMISSION`, Nix
  `partyAdmission`): no one signs in through a party and no party world is
  made, so an upgrade can be deployed without opening anything. Party worlds
  already made keep working for the people in them.
- `parties` prints one JSON record per party world (and per closed party):
  party id, world, members, who opened it (`openedBy`, `openedByName`), how
  many accounts came in through the party (`admitted`), how many of those
  signed in but are still choosing a world (`held`: closing the party keeps
  them out of its world), and `closedAt`.
- `party close PARTY-ID` stops admitting that party (no codeless sign-ins
  through it, and no world is made for it); `party open PARTY-ID` resumes.
  Its world, and everyone already in, stay. Table `party_closures`.
- `party adopt WORLD-ID` makes a person's world that an older link tied to a
  party (022) that party's world: `owner_id` becomes empty, the party id
  stays, and the former owner is recorded as `opened_by`. Everyone living
  there stays. If the party already has a world no one lives in (one made at
  a sign-in after the upgrade), it is set aside first (it keeps its rows but
  belongs to no party); a lived-in one is never replaced. Residents who
  aren't in the party are then warned at their next sign-in, as leavers.
  Take a `backup` first.

`invites [player]` prints one JSON metadata record per code, optionally filtered
by creator, including creator, recipient, world, expiry and revocation timestamps.
`invite revoke HASH` revokes any unused code; the CLI can inspect player-made
codes as well as its own. `notes` lists rebirth and large sync-loss audit events.
`flag clear ID` clears a flag, advances the snapshot revision once and records an
audit entry. Access removal and flags are separate owner controls.

Unverified credit starts at 200 glims above the login checkpoint, grows by
100 per full day, and caps at 3000. Pending lots are confirmed only by a verified
login reaching their original reported XP and expire after 90 days. Both syncs
and logins advance the separate loss reference. Several deaths can be synced
at once; large losses are audited. A checkpoint compares verified XP with the highest report that earned or held
credit since the preceding checkpoint, even if later reports step down. It
allows three death windows plus the configured XP tolerance, and one extra
window per full day since that highest report. A ledger cursor distinguishes
reports and checkpoints in the same second. Flags preserve paid/pending credit;
pending still expires or settles under the existing rules. Rebirth requires earlier verified history above level 1. Sessions
expire after seven idle days. Successful authenticated requests slide that
seven-day deadline, bounded by thirty days from login. Daily activity cannot
extend the absolute limit; the server sees a token only during
`POST /api/session`, so active players sign in at least monthly.

### Backend upgrade notes

Schema upgrades use immediate transaction locking. Migration 002 carries old
aggregate pending credit into a lot at its original XP mark and adds party IDs.
It also **backfills every existing invite's expiry as created_at + 30 days**,
including old CLI codes already handed out: codes older than 30 days become
expired on upgrade. Inspect with `invites` and create replacement CLI codes when
needed.

Migration 003 adds independent loss references and verified-level history,
records legacy players lacking allowlist access as removed, revokes their unused
invites, and bounds existing session expiry by created_at + 30 days. Loss
references are initialized from the newest available legacy baseline/checkpoint
metadata; old databases did not retain a distinct sync-only timestamp. New
accepted syncs and verified checkpoints record their reference explicitly.
Existing pending lots retain their original creation date for 90-day expiry.
The service upgrades existing databases in place; use the [self-hosting backup procedure](home-server.md#admission-and-backups)
before an owner deployment.

Migration 025 adds `pending_sessions`, first sign-ins held for the world
choice (see "Party worlds and world moves"). It changes no existing rows.


### Homesteads and the compact Wilds (phases 3–4)

Migration 004 adds lazy homestead allocation, decoration instances and placement,
material balances, permanent region epochs, shared entity cycles, personal claims,
discoveries, fallen-hero lanterns, UTC relight reward counts, and durable claim
limits. It preserves existing progress, balances, sessions, and revisions. A free
campsite is granted at first homestead/Commons access and recorded in the ledger;
reads allocate only the caller's plot without changing any revision. Unallocated
neighbors remain visible as virtual tier-0 homes with null plot indices and bounds.
Accepted Commons progress also grants the campsite in the same progress transaction.

The current inner region is `inner-1`, with a permanent season `"0"` epoch using
generator version 1. Future generator deployments must retain the implementation
**and its generation data** for every version referenced by a stored epoch.
Unsupported versions fail with `generator-unavailable` rather than silently
regenerating land. No scheduled reset runs in this phase.

Shared `content/homestead.json` contains the five tier identities and fourteen
items. The free Campsite, 15-glim Cottage, and Workshop ship now. The Workshop
costs 30 glims, 20 timber, 10 stone and 8 fiber; Garden and Hall remain unavailable. Decoration placement requires the Cottage; buying tier-0
items is allowed. Its `commons` block is the one source of plot geometry, in the
client's 16-pixel tiles: plot `i` sits in column `i % columns.length` and row
`i / columns.length`, at the listed `rows`, then every `rowPitch` tiles down the
lane. Plot bounds and the home-rest check use it, and the client draws the same
plots from it. `outdoorReserved`/`indoorReserved` are the camp/cottage tiles and
the inside doorway; placements covering them fail with `placement-overlap`. `rest`/`revive` require the village hearth; `home-rest` requires
the caller's own Commons plot. Sync remains allowed in both safe areas.
`content/economy.json` contains the one-glim home rest, twenty
successful claims per minute, two fallen lantern creations per owner per UTC day,
three rewarded relights per UTC day, and one-amber
relight reward. These are starting values for playtesting. Camps respawn after
600 seconds and nodes regrow after 300 seconds, from `content/wilds.json`. A
relight after the reward cap still lights the lantern but grants no material.
Migration 006 persists creation counts and backfills them from the defeat ledger;
replacements count, while idempotent replays do not. The third creation returns
429 `lantern-creation-limited`, with Retry-After to UTC midnight.

Claims and relights require Wilds progress within a three-tile Euclidean radius.
Wilds tiles are 16 pixels (the game TILE), entity tx/ty are chunk-local, and
lantern x/y are region tiles. Defeat positions use the same 16-pixel conversion.
Home bounds use the separately configured Commons tile size. Normalized inventory
rows are the only authority for loot; legacy progress copies are filtered on load.

All gameplay POSTs require the play lease, current `baseRev`, and an idempotency
key, with optional current `progress`. New response payloads are additive to the
existing top-level snapshot. Exact request/response fields and coordinate
conventions are recorded in `server/internal/api/` and `server/internal/store/` with their regression tests.
Homestead layouts are visible only to the owner's world; mutations always affect
the caller's owned instances. Wilds epoch IDs are checked against the caller's
world before any state or loot is returned.

Restore validation now also populates and checks the new tables, verifies material
and decoration ledger sums, and checks the original player's full snapshot and
revision after reopening the backup. The same manual backup procedure applies.


### Round-3 login and frontend contract

Every reverse proxy must preserve the browser's original **Host header**,
including its port. The server compares the request Origin host against Host.
Caddy's existing HTTP reverse proxy does this by default; Vite uses
`changeOrigin: false`. Rewriting Host to the upstream address makes legitimate
browser POSTs fail with `cross-origin`. Trusted-proxy configuration controls
forwarded client IPs; it does not bypass this Origin check.

The existing IP, concurrency, and global upstream limits now also reserve
failed-proof capacity per claimed user ID: five rejected upstream identity
proofs per fifteen-minute fixed window. Inflight reservations prevent a
parallel burst from overshooting that limit. A rejected proof is an upstream
401/403 mapped to `habitica-auth`; successes, upstream outages, global-rate
rejections and busy slots do not consume failed-proof capacity. At the cap,
login returns 429 `login-user-rate-limited`, with Retry-After for the remaining
window. A full inflight-only reservation set asks for a one-second retry. The
map is bounded to 4096 IDs and evicts the oldest non-inflight bucket when full.
This in-memory protection resets on process restart, like the existing login
limiters. Valid credentials cannot be distinguished before proof, so a targeted
user must wait for the window after five rejected proofs. Other users retain
their independent failed-proof capacity.

CLI and player invites are now six words from the fixed 256-word catalog in
`content/invite-words.json`, followed by four digits (including leading zeros),
separated by hyphens. Independent uniform cryptographic draws give
`6*log2(256)+log2(10000) = 61.2877` bits of entropy. Words can repeat. Redemption
is case-insensitive and accepts hyphens or whitespace, including mixed/repeated
separators. Old 64-hex invitations still use the same hash and remain valid
until used, revoked or expired. New and old codes stay single-use, expire after
thirty days, and are stored only as SHA-256 hashes. Raw codes are shown only
once at creation. Admin revocation still takes the 64-hex **hash ID**.

New additive response fields:

- Every state-bearing snapshot has `displayName`, including login before origin
  selection. Imported profile names are not needed to label the verified hero.
- `GET /api/state` returns `leaseActive`, true only when a nonempty
  `X-Play-Lease` matches the player's current stored lease. Mismatches still
  return 200 and never heartbeat the winning lease. Without the header it is
  false. Poll with the tab's lease to detect takeover while idle.
- `GET /api/invites` returns `remaining` (lifetime creations left, including
  used/revoked/expired codes in the spent budget) and `outstandingLimit`.

For a locked imported hero (stored HP 0 and imported baseline HP 0), sync and
spend must carry the **pre-sync local progress with `hp: 0`**. Supply new Habitica
healing only in sync's `profile`; apply the server's returned snapshot after
it accepts the operation. Pre-applying healing to `progress.hp` fails with
400 `invalid-progress`. A zero-HP revive/rest needs XP-earned glims, with
zero-HP progress still carried. The same rule applies to home rest.

Migration 005 adds the private checkpoint ledger cursor and a partial index
for credit-report lookup. It preserves ambiguous legacy same-second reports
for the first new checkpoint. Existing session deadlines are clamped to the
minimum of their old expiry, the thirty-day absolute deadline, and seven days
after the best available legacy activity timestamp (`max(session.created_at,
player.last_seen_at)`). Older code did not record each session's last
successful read, so active read-only legacy sessions may need to sign in again
on upgrade. Retained historical idempotency responses with snapshots gain a
missing `displayName` from the player row; existing historical names and all
request hashes remain unchanged. No economic grants or balances are rewritten.


### Phase 5: workshop, mail, projects and the Turning

Migration 008 preserves existing decoration ownership/placement and adds instance
locations, count-based home storage, world-scoped mail in transit, project
contributions/progress and durable completion paper records. Back up before
upgrading using the [self-hosting backup procedure](home-server.md#admission-and-backups). Restore tests cover all new tables.

The shared calendar epoch is 2026-01-05 00:00:00 UTC (Thaw day 1). A wick is seven
real days, controlled by content/calendar.json; twelve wicks form a year. Calendar
clients use Unix seconds and the same pure function/vectors as Go. Closure Night
is Quiet day 7. GET /api/calendar is public and includes a notice during the last
24 hours of each wick. Outer-1 turns at each wick boundary: new season keys are
`t:<starts_at>:<ends_at>`, starts_at/ends_at are fixed UTC boundaries, and an epoch is
created lazily. Old claims fail with epoch-ended even before anyone reads the new
region. Inner-1 stays permanent. Generator v1 and its generation data are unchanged.

Storage/crafting require tier 2. Decorations move as original unplaced instances;
placed instances must first be removed. Mail transfers only server-owned gathered
materials, Wilds trinkets, crafted utilities and unplaced decorations, never
quest items or paid quest entitlements. Glims travel only in a glim letter,
which carries glims alone (kind `glims`). Assets are debited immediately on
send and remain unusable in transit until the named recipient claims them or the
sender recalls them. Unclaimed mail returns after 30 days, on recipient
removal, or when the recipient moves to another world.

Six projects cover the three written village works plus the Wheel & Wick
guildhouse, Orrin's hinges and the Cooley Window Fund. Completion world flags
are separate from client story flags. All contributing members can read their
paper eligibility from GET /api/projects after completion and call grantPaper;
no other player's revision is changed. Crafting recipes and project costs are
shared JSON and are starting values for playtesting.

The exact additive API contract and ledger currency conventions are recorded in
`server/internal/api/` and `server/internal/store/` tests. All new gameplay POSTs use the existing
lease/revision/idempotency transaction boundary. An authenticated request can
settle due mail and bump the sender's revision before loading its snapshot.

### Round 5: calendar tuning, mail safety and project tuning

Changing `wickDays` or `epoch` in `content/calendar.json` starts a new calendar
numbering. Outer epoch identity uses both absolute interval boundaries, so it
cannot collide with an old ended wick number or a differently sized interval
with the same start. Existing epochs keep their frozen season/generator inputs
and deadlines; an existing numeric-season epoch is reused when its exact
interval matches. Clients should treat `epoch.season` as an opaque string.

Migration 009 adds mail return metadata and indexes without changing existing
claims, goods, decoration IDs or player revisions. Senders can use keyed
`POST /api/mail/:id/recall` to recover unclaimed goods. CLI `allowlist remove`
returns that recipient's pending mail atomically with removal. The executable
sweeps expired or unavailable recipients' mail at startup and every 60 seconds;
authenticated HTTP transactions also settle the caller's due mail. Maintenance
uses batches of 100 rows and a 10-second sweep deadline; large backlogs resume on
the next interval. Expiry is exactly 30×24 hours after send. Both paths credit
the original goods, settle transit ledger entries, and bump the sender's revision
without touching their progress or last-seen time. Only explicit recalls use the
normal gameplay mutation's progress/Persist flow.

`content/mail.json` shares and validates these defaults with TypeScript: 50
outstanding sent and 50 outstanding received messages per player, 10 sends per
rolling 60 seconds (claimed/returned messages still count), and 50 completed
history entries per page. Capacity errors are 409 `mail-sender-limit` or
`mail-recipient-limit`; send-rate errors are 429 `mail-rate-limited` with
`Retry-After`. Removed/unadmitted recipients reject with 403
`recipient-unavailable`. Every response keeps pending mail plus a bounded history
slice; `GET /api/mail?cursor=...` follows `nextCursor`. A separate
`pendingCursor`/`nextPendingCursor` covers legacy pending backlogs exceeding the
current combined caps, so even those responses remain bounded. Cursor values
are opaque and remain scoped to the authenticated world/player.

Project totals at or above a tuned requirement satisfy that material. Additional
amounts of a satisfied material are rejected; other required materials can still
complete the project. GET /api/projects also reconciles already-satisfied costs,
recording completion/papers once without changing any player's revision. Existing
completed projects stay complete when costs rise. The precise new contracts and
failing-first regressions are in the mail/project regression tests.

### Phase 6 presence WebSockets

The `/ws` route in the [self-hosting guide](home-server.md) needs no extra Caddy upgrade headers: `reverse_proxy`
handles WebSocket upgrades by default. Preserve the browser Host (including its
port) as described in that guide. Production clients use `wss://` on the same site as the
HTTP API; Vite's `/ws` proxy has `ws: true` and preserves Host for local development.
No additional public port, service, environment variable, database migration, or
NixOS firewall rule is needed. The Go dependency and Nix vendor hash are updated.

Presence requires both the HttpOnly session cookie and the current play lease.
Send the lease in the first JSON message, never in the URL: all `/ws` query strings
are rejected, and request logs record only the fixed `/ws` label. A browser Origin
is required and must match Host. The wire protocol and client integration details
are in `server/internal/api/presence.go` and its tests; shared emotes and limits live
in `content/presence.json`, with TypeScript wire types in `src/lib/presence.ts`.

Presence is a bounded, in-process service (128 live sockets, 32 players per room).
Use one server instance; separate processes do not share rooms. Restarting clears
all presence and explicitly closes upgraded sockets, including clients waiting
for authentication. There is no persisted room or position state. The server
pings every 20 seconds, requires pong within 5 seconds, and expires application
inactivity after 60 seconds; stationary clients send a JSON heartbeat about every
20 seconds. Presence does not refresh sessions or the play lease: keep the normal
HTTP state/progress/play heartbeat running. Play takeover and logout revoke
sockets immediately; database-side revocations are detected within 10 seconds.

### Round 6 presence admission and database isolation

Physical presence sockets now also have shared limits of **2 per session** and
**4 per player**, including pending-auth and closing connections. Rejected
upgrades use 429 `presence-session-limit` / `presence-player-limit` with
`Retry-After: 5`; the global cap still uses 503 `presence-full`. Send first-message
auth promptly. The auth-message deadline remains five seconds. Session/player
reservation and generation maps are removed when their last socket releases.

A reader-owned token bucket limits aggregate application messages before JSON
parsing or the hub mutex: 30/s with a burst of 60. Brief excess is dropped;
sustained excess for five seconds closes 1008 `rate-limited`. These limits are
above normal eight-Hz positions, joins, emotes, and stationary heartbeats.

Presence DB checks run outside the hub mutex. Per-player generations prevent
stale auth/notification results from registering or removing the wrong peer.
Periodic checks run in a separate cancellable goroutine per socket, so even that
socket's writer, ping/pong and idle checks continue during DB contention. A
confirmed revoked session, lease or world still closes promptly; an unknown DB
result retries, with 1011 `auth-unavailable` only after three consecutive unknown
results. A successful validation clears that counter. Shared policy values are
in `content/presence.json`; the presence regression tests contains the client
handoff and regression evidence. No new NixOS service, public port or dependency.

### Homesteads v2: a lane of gates (migrations 010–011)

> **Warning: migration 010 resets all homestead data and must not run
> against a database with real players.** No deployment exists yet, so the
> homestead model was reset rather than migrated. If a database with players
> on it ever exists before this ships, write a preserving migration first
> (pack decorations back to their owners, chest goods into personal chests,
> decoration mail back to senders) and do not run 010 as written.

On first start, migration 010:

- deletes every decoration parcel in the mail;
- drops `homesteads`, `homestead_items` and `home_storage` (phase-3/5
  homes, every bought or crafted decoration, and every shared-chest material,
  trinket and decoration);
- creates the v2 tables (`homesteads` by world and gate,
  `homestead_members` with one homestead per player, `player_deeds`,
  `lost_gates`, `homestead_invites`, `homestead_cleared`, a rebuilt
  `homestead_items`, `home_storage` by homestead, `personal_storage`).

The old goods' ledger rows stay behind, so on an existing database the
per-currency sums for `decoration:*` and `storage:*` would no longer match
holdings after 010. Take a backup before upgrading any database you care
about.

Migration 011 adds `homestead_departures`. When the last member of a
homestead leaves, they can take their deed back free until the deed is lost.
A lost deed writes its goods off on the last member's ledger (reason
`deed-lost`): offsetting `storage:*` rows for the home chest, a zero row per
placed piece (`decoration:<id>`, ref `<home>:gate:<g>:<instance>`), and a
zero `homestead` row for the deed. Per-currency sums therefore still balance
after a loss. The contract and regression coverage are in `server/internal/store/homestead*.go`
and `server/internal/api/homestead*.go`.
