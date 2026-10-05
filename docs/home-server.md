# Home server deployment

Host: `ssh home.example.invalid` (`example-host`). Source and production bundle:
`/home/deploy-user/code/fingersnap` and its `dist/` directory.

The NixOS module in `deploy/nixos/fingersnap.nix` is installed at
`/etc/nixos/services/native/fingersnap.nix` and imported by that directory's
`default.nix`. It runs Caddy's static file server as `deploy-user` on
`127.0.0.1:4173`. The main Caddy config at `/etc/nixos/services/caddy.nix`
maps `fsnap.example.invalid` to this listener and handles HTTPS.

## Update the app

From the local repo, copy source without credentials or machine-specific files:

```sh
rsync -az --exclude node_modules --exclude dist --exclude .env \
  --include .env.example --exclude '.env.*' --exclude .playwright-mcp \
  --exclude playwright-report --exclude test-results --exclude .claude \
  --exclude .DS_Store ./ home.example.invalid:code/fingersnap/
```

On the server, use Node from the server's pinned nixpkgs to build:

```sh
nixpkgs_path=$(nix eval --impure --raw --expr \
  '(builtins.getFlake "/etc/nixos").inputs.nixpkgs.outPath')
cd ~/code/fingersnap
nix shell "$nixpkgs_path#nodejs_24" --command bash -c \
  'npm ci --no-audit --no-fund && npm run verify'
```

The file server reads `dist/` directly; rebuilding the app does not require an
OS switch. Change the NixOS module only when service configuration changes.

## Build and activate NixOS

```sh
nh os build /etc/nixos --hostname example-host --no-update-lock-file \
  --out-link ~/fingersnap-nixos-result
nh os switch /etc/nixos --hostname example-host
systemctl status fingersnap --no-pager
curl -I https://fsnap.example.invalid
```

Initial preparation on October 3, 2026 passed `npm run verify` (175 unit tests)
and `nh os build`. Activation was left to the server owner. At preparation
time, `fsnap.example.invalid` did not resolve; add its DNS record pointing to
the home server (like `keeper.example.invalid`) for HTTPS to work.

## Go backend (phase 2)

The backend module is `deploy/nixos/fingersnap-server.nix`. Import it alongside
`fingersnap.nix` and enable `services.fingersnap-server.enable = true;`. Its
package builds from the **repository root**, including `content/`, and needs
Go 1.26 or later in nixpkgs. `services.fingersnap-server.package` can select an
alternate package if the server's pinned nixpkgs needs a newer Go builder.
This work does not install or activate anything on the home server.

Caddy's site block should route the API and presence socket before the existing
static listener:

```caddyfile
fsnap.example.invalid {
    handle /api/* {
        reverse_proxy 127.0.0.1:8090
    }
    handle /ws {
        reverse_proxy 127.0.0.1:8090
    }
    handle {
        reverse_proxy 127.0.0.1:4173
    }
}
```

Use `handle`, not `handle_path`: the Go router needs the `/api` prefix.
The service listens only on localhost, uses Secure cookies, and keeps its
SQLite database in `/var/lib/fingersnap-server/fingersnap.sqlite` (WAL mode).
No token file or credential environment variable is needed. The only server
Habitica request is the login proof; later syncs come from the browser.

Build and local development (no deployment):

```sh
go build -o /tmp/fingersnap-server ./server/cmd/fingersnap-server
npm run server   # localhost:8090, local .data/ database, HTTP dev cookies
npm run dev      # Vite proxies /api and WebSocket /ws to localhost:8090
```

Configuration is available as flags or environment variables: `-listen` /
`FINGERSNAP_LISTEN`, `-db` / `FINGERSNAP_DB`, `-habitica-url` /
`FINGERSNAP_HABITICA_URL`, `-x-client` / `FINGERSNAP_X_CLIENT`, and
`-cookie-secure` / `FINGERSNAP_COOKIE_SECURE` (default true; false only for
local HTTP). Flags precede CLI subcommands. Examples on the server:

```sh
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite allowlist add HABITICA_USER_ID
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite allowlist list
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite allowlist remove HABITICA_USER_ID
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite invite [WORLD_ID]
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite invites [HABITICA_USER_ID]
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite invite revoke HASH
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite flag clear HABITICA_USER_ID
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite flagged
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite notes
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite backup /var/lib/fingersnap-server/backups/manual.sqlite
```

Invoke the installed service package's binary path (from its `ExecStart`) if it
is not on PATH. `invite [WORLD_ID]` prints a random single-use code; its hash is stored.
Without a world ID it creates a solo world for the recipient; with an existing
world ID it admits a new player to that world. Allowlist removal records a removal marker and revokes
all existing sessions and unused invites made by that player. Only CLI
`allowlist add` or redemption of a CLI-created invite can re-admit that ID. Existing players keep their world on later logins.

The nightly timer runs `VACUUM INTO` at 03:15, retains 30 days by default, and
writes consistent standalone `.sqlite` snapshots under the state's `backups/`
directory. A manual backup refuses to overwrite an existing destination.
Backups contain session hashes and gameplay records, never Habitica tokens.

Restore procedure (owner operation, while the service is stopped):

1. Stop `fingersnap-server` and retain a separate copy of the current database
   **and** its `-wal`/`-shm` sidecars for recovery.
2. Move those three files out of the live directory. Copy the chosen standalone
   backup to `fingersnap.sqlite`; do not leave old WAL/SHM files beside it.
3. Set owner/group to `fingersnap-server` and mode to `0600`, then start the
   service. Embedded migrations run automatically and safely on reopen.
4. Check `/api/state` for a known account's `rev`, ember balances and outcomes;
   compare ledger sums **per currency** with balances before allowing play.
   Ember totals use `currency='embers'`; materials use `material:timber`,
   `material:stone`, `material:fiber`, and `material:amber`. Decoration and
   trinket ledger currencies count owned units rather than embers.

An automated test backs up a live database, reopens the backup as a fresh
store, and checks state, revision, total ledger deltas and earned deltas.
When Go dependencies change, regenerate the module's fixed-output vendor hash
using `go mod vendor -o /tmp/fingersnap-vendor` and
`nix hash path /tmp/fingersnap-vendor` (start with an absent destination).

### Login limits and player invites

The backend pre-checks allowlist membership or an eligible unused/unexpired
invite before creating a limiter bucket or calling Habitica, then rechecks
access in the transaction. Default limits are four concurrent identity proofs,
ten eligible attempts per IPv4 address or IPv6 /64 per minute, and sixty actual
upstream calls globally per minute (including the single permitted 429 retry).
Flags are `-login-concurrency`, `-login-rate`, and `-login-global-rate`.
The bounded IP map evicts its oldest bucket when full. Client IP is RemoteAddr
unless its peer is a configured trusted proxy; only then is the last
X-Forwarded-For hop used. Caddy's localhost peer is trusted by default. Configure
`-trusted-proxies`, `FINGERSNAP_TRUSTED_PROXIES`, or the Nix `trustedProxies` option;
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

`invites [player]` prints one JSON metadata record per code, optionally filtered
by creator, including creator, recipient, world, expiry and revocation timestamps.
`invite revoke HASH` revokes any unused code; the CLI can inspect player-made
codes as well as its own. `notes` lists rebirth and large sync-loss audit events.
`flag clear ID` clears a flag, advances the snapshot revision once and records an
audit entry. Access removal and flags are separate owner controls.

Unverified credit starts at 200 embers above the login checkpoint, grows by
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
The service upgrades existing databases in place; use the backup procedure above
before an owner deployment.


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
items. The free Campsite, 15-ember Cottage, and Workshop ship now. The Workshop
costs 30 embers, 20 timber, 10 stone and 8 fiber; Garden and Hall remain unavailable. Decoration placement requires the Cottage; buying tier-0
items is allowed. Its `commons` block is the one source of plot geometry, in the
client's 16-pixel tiles: plot `i` sits in column `i % columns.length` and row
`i / columns.length`, at the listed `rows`, then every `rowPitch` tiles down the
lane. Plot bounds and the home-rest check use it, and the client draws the same
plots from it. `outdoorReserved`/`indoorReserved` are the camp/cottage tiles and
the inside doorway; placements covering them fail with `placement-overlap`. `rest`/`revive` require the village hearth; `home-rest` requires
the caller's own Commons plot. Sync remains allowed in both safe areas.
`content/economy.json` contains the one-ember home rest, twenty
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
conventions are recorded in `.agent/REPORT.md`, under "Phase 3/4 server".
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
400 `invalid-progress`. A zero-HP revive/rest needs XP-earned embers, with
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
upgrading using the procedure above. Restore tests cover all new tables.

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
embers, quest items or paid quest entitlements. Assets are debited immediately on
send and remain unusable in transit until the named recipient claims them or the
sender recalls them. Unclaimed mail returns after 30 days or recipient removal.
World moves remain outside this release.

Six projects cover the three written village works plus the Wheel & Wick
guildhouse, Orrin's hinges and the Cooley Window Fund. Completion world flags
are separate from client story flags. All contributing members can read their
paper eligibility from GET /api/projects after completion and call grantPaper;
no other player's revision is changed. Crafting recipes and project costs are
shared JSON and are starting values for playtesting.

The exact additive API contract and ledger currency conventions are recorded in
.agent/REPORT.md under “Phase 5 server”. All new gameplay POSTs use the existing
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
failing-first regressions are in REPORT.md under “Fix round 5”.

### Phase 6 presence WebSockets

The `/ws` route above needs no extra Caddy upgrade headers: `reverse_proxy`
handles WebSocket upgrades by default. Preserve the browser Host (including its
port) as described above. Production clients use `wss://` on the same site as the
HTTP API; Vite's `/ws` proxy has `ws: true` and preserves Host for local development.
No additional public port, service, environment variable, database migration, or
NixOS firewall rule is needed. The Go dependency and Nix vendor hash are updated.

Presence requires both the HttpOnly session cookie and the current play lease.
Send the lease in the first JSON message, never in the URL: all `/ws` query strings
are rejected, and request logs record only the fixed `/ws` label. A browser Origin
is required and must match Host. The wire protocol and client integration details
are in `.agent/REPORT.md`, under **Phase 6 server**; shared emotes and limits live
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
in `content/presence.json`; REPORT.md under “Fix round 6” contains the client
handoff and regression evidence. No new NixOS service, public port or dependency.
