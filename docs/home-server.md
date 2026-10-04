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
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite flagged
sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite backup /var/lib/fingersnap-server/backups/manual.sqlite
```

Invoke the installed service package's binary path (from its `ExecStart`) if it
is not on PATH. `invite` prints a random single-use code; its hash is stored.
Without a world ID it creates a solo world for the recipient; with an existing
world ID it admits a new player to that world. Allowlist removal also revokes
all existing sessions. Existing players keep their world on later logins.

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
