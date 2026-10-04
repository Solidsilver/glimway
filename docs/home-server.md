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

Caddy's site block should route the API before the existing static listener:

```caddyfile
fsnap.example.invalid {
    handle /api/* {
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
npm run dev      # Vite proxies /api to localhost:8090
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
   compare ledger sums with balances before allowing play.

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
at once; large losses are audited. A checkpoint flags only the generous forgery
signals documented in `.agent/REPORT.md`, preserving pending until expiry or
confirmation. Rebirth requires earlier verified history above level 1. Sessions
expire absolutely 30 days after login even with daily activity; the server sees
a token only during `POST /api/session`, so active players sign in monthly.

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
