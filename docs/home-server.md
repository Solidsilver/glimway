# Self-hosting Glimway

Glimway consists of a static web app and one Go server with a SQLite database.
Use one backend process: presence rooms are held in memory and are not shared
between instances. The browser talks to `/api/*` and `/ws` on the same origin
as the site. The server checks the browser's Origin against Host; preserve Host
through your reverse proxy and do not strip the `/api` prefix.

The code is AGPL-3.0-or-later. Habitica avatars, equipment, pets and mounts are
HabitRPG, Inc. artwork with separate non-commercial terms. Read [ASSETS.md](../ASSETS.md)
and [the Habitica boundary](habitica-boundary.md) before distributing or charging
for a deployment. Habitica credentials belong to players; no operator token or
credential file is required. The backend uses a token only for the login proof
and does not store it.

## NixOS flake

Add this input to your host's `flake.nix`:

```nix
inputs.glimway.url = "github:Solidsilver/glimway";
```

Pass it to your configuration and import the module:

```nix
outputs = { nixpkgs, glimway, ... }: {
  nixosConfigurations.example = nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      ./configuration.nix
      glimway.nixosModules.default
      {
        services.glimway = {
          enable = true;
          publicOrigin = "https://glimway.example.org";
          reverseProxy.enable = true;
          openFirewall = true;
        };
      }
    ];
  };
};
```

The module builds both packages using the host's `pkgs`; keep that nixpkgs new
enough for Go 1.26+ and Node 24. Alternatively select packages from Glimway's
own pinned nixpkgs:

```nix
services.glimway = {
  package = glimway.packages.x86_64-linux.glimway-server;
  webPackage = glimway.packages.x86_64-linux.glimway-web;
};
```

The module's default web package compiles your configured Habitica creator ID
and app name into the browser bundle. If selecting `webPackage` yourself, use
`.override { habiticaCreatorId = "YOUR_PUBLIC_CREATOR_ID"; habiticaAppName = "glimway"; }`
to make its identity agree with the server. These are public application
identifiers, not a player's credentials. `habitica.xClient` overrides only the
backend's complete header.

Build and activate the host configuration:

```sh
sudo nixos-rebuild build --flake /etc/nixos#example
sudo nixos-rebuild switch --flake /etc/nixos#example
systemctl status glimway glimway-server --no-pager
systemctl list-timers glimway-server-backup --no-pager
curl -fsS https://glimway.example.org/api/calendar
```

Point DNS at the host first so Caddy can obtain a certificate. The module runs
`glimway-server` on localhost:8090 and a Caddy static file server (`glimway`) on
localhost:4173. Its optional HTTPS Caddy virtual host proxies `/api/*` and `/ws`
to the backend and everything else to the static listener. It preserves paths
and Host, and Caddy handles WebSocket upgrades. Compression is kept off `/ws`.
State is mode 0700 under `/var/lib/glimway-server`, owned by `glimway-server`.
The backend and backups use `ProtectSystem=strict`, private temporary storage,
and kernel/device restrictions with explicit writable data directories.

### Options

Every option below is under `services.glimway`. The source and descriptions are
in [deploy/nixos/glimway.nix](../deploy/nixos/glimway.nix).

| Option | Default / purpose |
|---|---|
| `enable` | `false`; enable the backend and configured companion services |
| `package`, `webPackage` | Go server/admin CLI and built static site |
| `listenAddress`, `port` | `127.0.0.1`, `8090`; IPv6 addresses without brackets |
| `publicOrigin` | `https://glimway.example.org`; HTTP(S) hostname origin, optional port, no path |
| `stateDirectory` | `glimway-server`; relative systemd directory under `/var/lib` |
| `database` | `/var/lib/<stateDirectory>/glimway.sqlite`; absolute path |
| `user`, `group`, `createUser` | `glimway-server`, `glimway-server`, `true`; set `createUser=false` for an existing account |
| `cookieSecure` | `true`; disable only for local HTTP |
| `habitica.url` | `https://habitica.com`; upstream identity-check URL |
| `habitica.creatorId`, `habitica.appName` | Built-in public creator ID, `glimway`; configure your public application identity |
| `habitica.xClient` | `<creatorId>-<appName>`; full backend header override |
| `partyAdmission` | `true`; members of an existing open party world may join without a code |
| `login.concurrency`, `login.rate`, `login.globalRate` | `4`, `10`, `60`; concurrent proofs, eligible attempts/IP/minute, actual upstream calls/minute |
| `trustedProxies` | `[ "127.0.0.1" "::1" ]`; IPs allowed to supply the last X-Forwarded-For hop; `[]` trusts none |
| `sprite.assetsUrl` | `https://habitica-assets.s3.amazonaws.com/mobileApp/images/`; sprite proxy upstream |
| `sprite.cacheDirectory` | `habitica-sprites/` beside the database; absolute path |
| `backups.enable`, `backups.schedule` | `true`, `*-*-* 03:15:00`; systemd calendar |
| `backups.randomizedDelaySec` | `10m`; timer jitter |
| `backups.retentionDays`, `backups.directory` | `30`, `/var/lib/<stateDirectory>/backups` |
| `extraEnvironment`, `extraFlags` | `{}`, `[]`; override generated env, append CLI flags; never place secrets in the Nix store |
| `web.enable` | `true`; static listener |
| `web.root` | `null` uses `webPackage`; override with an existing absolute `dist/` path |
| `web.user`, `web.group` | Backend account/group; may select a different existing static-listener account |
| `web.listenAddress`, `web.port` | `127.0.0.1`, `4173` |
| `reverseProxy.enable` | `false`; add the Caddy virtual host for `publicOrigin`; requires `web.enable` |
| `openFirewall` | `false`; managed Caddy opens TCP 80/443, otherwise opens the backend port only for a non-loopback listener |

The module creates the database parent, sprite cache, and enabled backup
directory with service ownership. For custom paths on other mounts, make sure
the mount is present before the services start (for example with
`systemd.services.glimway-server.unitConfig.RequiresMountsFor`). The static
listener reads an existing `web.root` but never changes its ownership.

### Existing state and old modules

Remove imports of both old wrappers before importing the flake module. The
`deploy/nixos/glimway-server.nix` path now imports the unified module;
`services.glimway-server.*` options have been replaced by `services.glimway.*`.
Importing the module alone no longer enables the static service.

For an existing instance, set its actual paths explicitly:

```nix
services.glimway = {
  enable = true;
  stateDirectory = "legacy-game";
  database = "/var/lib/legacy-game/game.sqlite";
};
```

The units remain `glimway` and `glimway-server`, with
`glimway-server-backup.service` and its timer. Keep the old database path;
changing only its name would create a new empty instance. systemd owns the
state directory as the configured service user. Migration details, including
the earlier name change, are in [the deploy note](deploy-notes/glimway-rename.md).

### Your own reverse proxy

Leave `reverseProxy.enable=false` if you already manage Caddy. Add this site
block to that configuration (adjust ports to match the module):

```caddyfile
glimway.example.org {
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

Use `handle`, not `handle_path`. Keep the browser Host including any port.
With nginx, use `proxy_set_header Host $http_host` and WebSocket upgrade headers;
serve `webPackage` as the document root, or proxy the static listener. Open
80/443 in the host firewall yourself when using an independently managed proxy.

### Updating and local checks

```sh
cd /etc/nixos
nix flake update glimway
sudo nixos-rebuild build --flake .#example
sudo nixos-rebuild switch --flake .#example
```

Back up before switching. Review migrations before upgrading an existing
database: migration 010 deliberately resets early homestead data. A database
with real players that has not applied it needs a preserving migration before
this version is used. Rolling back NixOS switches binaries, not the database;
restore a compatible backup if the old binary cannot read the upgraded schema.

For contributors, from a source checkout:

```sh
nix develop
npm ci
npm run verify
go test ./...
nix flake check
nix build .#glimway-server .#glimway-web
```

If art is moved into Git LFS, run `git lfs pull` before local builds. For the
`github:` input, enable inclusion of LFS objects in the repository's GitHub
source archives. Alternatively use a recent Nix with Git LFS fetching:
`inputs.glimway.url = "git+https://github.com/Solidsilver/glimway?lfs=1";`.
An input supplies both source and art, so no rsync is needed. The web build
rejects unresolved LFS pointers.

The flake supports x86_64/aarch64 Linux and Darwin. `default` is the server.
The dev shell provides Go, Node, SQLite, `cwebp`/`dwebp` and Git LFS. The web
package uses a fixed npm dependency cache and offline `npm ci` plus
`npm run build`; committed runtime art is used without an atlas build.
Linux module checks evaluate defaults, preserved paths, overrides, disabled
backups, timers and proxy settings even when run on Darwin.

Detailed party/world behavior and earlier migration notes are preserved in
[server-behavior.md](server-behavior.md).

## Admission and backups

Run the CLI as the service user and always select the live database:

```sh
DB=/var/lib/glimway-server/glimway.sqlite
sudo -u glimway-server glimway-server -db "$DB" allowlist add HABITICA_USER_ID
sudo -u glimway-server glimway-server -db "$DB" allowlist list
sudo -u glimway-server glimway-server -db "$DB" invite
sudo -u glimway-server glimway-server -db "$DB" backup /var/lib/glimway-server/backups/manual.sqlite
```

An invite without a world ID creates a solo world for its recipient; supply an
existing world ID to invite a new player there. Codes are single-use and expire
after 30 days. `allowlist remove ID` revokes access; `party close PARTY-ID`
closes party admission. Use `glimway-server -h` for configuration flags.

The Nix timer makes consistent standalone SQLite snapshots using `VACUUM INTO`,
then removes `.sqlite` backups older than the retention setting. Backups include
session hashes and gameplay records. Copy snapshots to a separate machine or
storage service; keeping them on the same disk does not protect against disk
failure. The backup command refuses to overwrite an existing file.

To restore, stop both the backend and backup timer, retain the current database
and its `-wal`/`-shm` sidecars separately, and move them out of the live directory.
Copy the chosen standalone snapshot to the configured database filename with
owner/group matching the service and mode 0600. Do not leave old WAL/SHM files
beside a restored snapshot. Start the backend, check a known account's state and
ledger balances, then re-enable the timer. Use a server version compatible with
the snapshot's schema.

## Manual deployment (without Nix)

Install Go 1.26+, Node 24+ and Caddy. Clone the source and build:

```sh
git clone https://github.com/Solidsilver/glimway.git
cd glimway
git lfs pull                 # needed if the checkout uses Git LFS
npm ci
npm run verify
go test ./...
CGO_ENABLED=0 go build -trimpath -o glimway-server ./server/cmd/glimway-server
sudo install -Dm755 glimway-server /usr/local/bin/glimway-server
sudo mkdir -p /srv/glimway
sudo cp -a dist /srv/glimway/
sudo useradd --system --home-dir /var/lib/glimway-server --shell /usr/sbin/nologin glimway-server
sudo install -d -o glimway-server -g glimway-server -m700 /var/lib/glimway-server
```

SQLite uses the pure-Go `modernc.org/sqlite` driver; no CGO or external SQLite
library is required for the binary. Runtime sprite requests need CA certificates.
Set `VITE_HABITICA_CREATOR_ID` and `VITE_HABITICA_APP_NAME` when building if you
use a different public Habitica identity.

Install `/etc/systemd/system/glimway-server.service`:

```ini
[Unit]
Description=Glimway backend
After=network.target

[Service]
User=glimway-server
Group=glimway-server
StateDirectory=glimway-server
StateDirectoryMode=0700
WorkingDirectory=/var/lib/glimway-server
Environment=GLIMWAY_LISTEN=127.0.0.1:8090
Environment=GLIMWAY_DB=/var/lib/glimway-server/glimway.sqlite
Environment=GLIMWAY_COOKIE_SECURE=true
Environment=GLIMWAY_TRUSTED_PROXIES=127.0.0.1,::1
ExecStart=/usr/local/bin/glimway-server -login-concurrency 4 -login-rate 10 -login-global-rate 60
Restart=on-failure
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enable it with `sudo systemctl daemon-reload` and
`sudo systemctl enable --now glimway-server`. Caddy can directly serve the
static bundle with a site block using the same two API/socket handlers above
and a final `handle { root * /srv/glimway/dist; file_server }`. Keep static
files readable by the Caddy account. Arrange a cron/systemd timer for the CLI
backup command and retention; the manual route does not install one for you.
To update, build a new binary and `dist/`, take a backup, install both, restart
the backend, and check `/api/calendar` and the page.

## Docker Compose

The image `ghcr.io/solidsilver/glimway` serves both the static app and backend
from one non-root process (UID/GID 10001). Releases publish `X.Y.Z`, `X.Y`,
`latest`, and `sha-<commit>` tags for `linux/amd64` and `linux/arm64`. The
`/data` named volume contains SQLite, its WAL/SHM files, sprite cache and any
manual backups. The final Alpine image includes CA certificates and a health
check against `/api/health`, which checks database availability. Use one
replica. Habitica artwork retains its separate **non-commercial** terms even
when delivered in an AGPL image; see the licence notes above.

After the repository and first release are published, a local HTTP quickstart:

```sh
git clone https://github.com/Solidsilver/glimway.git
cd glimway
cp .env.example .env
docker compose pull glimway
docker compose up -d --no-build --wait
curl -fsS http://127.0.0.1:8090/api/health
curl -I http://127.0.0.1:8090/
```

The default published port is bound to loopback. The Compose defaults disable
Secure cookies for this HTTP quickstart. For a public service, point DNS at the
host, set these in `.env`, open TCP 80/443 (optionally UDP 443), and start HTTPS:

```dotenv
GLIMWAY_PUBLIC_ORIGIN=https://glimway.example.org
GLIMWAY_COOKIE_SECURE=true
```

```sh
docker compose --profile https up -d --no-build --wait
curl -fsS https://glimway.example.org/api/health
```

The optional Caddy profile preserves Host, handles WebSocket upgrades and
proxies every path to the combined server. It has a fixed internal IP so only
that proxy's forwarded client IPs are trusted. `GLIMWAY_PROXY_SUBNET` must be
an unused Docker subnet; if changing `GLIMWAY_PROXY_IP`, also change
`GLIMWAY_TRUSTED_PROXIES` to that IP. An empty trusted-proxy value trusts none.
For a host-managed proxy, leave the profile off, proxy to localhost:8090, and
trust only its actual Docker gateway peer when forwarded client IPs are needed.

Every backend flag has an environment equivalent in [compose.yaml](../compose.yaml)
and [.env.example](../.env.example): `GLIMWAY_LISTEN`, `GLIMWAY_DB`,
`GLIMWAY_STATIC_DIR`, `GLIMWAY_HABITICA_URL`, `GLIMWAY_X_CLIENT`,
`GLIMWAY_COOKIE_SECURE`, `GLIMWAY_PARTY_ADMISSION`, `GLIMWAY_TRUSTED_PROXIES`,
`GLIMWAY_LOGIN_CONCURRENCY`, `GLIMWAY_LOGIN_RATE`, `GLIMWAY_LOGIN_GLOBAL_RATE`,
`GLIMWAY_HABITICA_ASSETS_URL`, and `GLIMWAY_SPRITE_CACHE`. CLI flags override
these. Keep database/cache paths under `/data` so they persist. If changing the
container's listening port, update `GLIMWAY_CONTAINER_PORT` and
`GLIMWAY_HEALTHCHECK_URL` too. The host port is independently configured with
`GLIMWAY_HTTP_PORT`. `.env` changes apply after `docker compose up -d` recreates
the container; restart alone does not update its environment.

`GLIMWAY_X_CLIENT` is the public **creator-id-appname**, never a player's token.
The published web bundle uses the project's built-in creator ID and `glimway`
app name. To change browser identity too, build locally with
`VITE_HABITICA_CREATOR_ID` and `VITE_HABITICA_APP_NAME` in `.env`, matching the
backend's header:

```sh
git lfs pull                # real art bytes, not pointers, in the build context
docker compose build glimway
docker compose up -d --pull never --wait
# Or explicitly build both architectures with Buildx:
docker buildx build --platform linux/amd64,linux/arm64 -t YOUR_REGISTRY/glimway:VERSION --push .
```

The build checks for LFS pointers, uses committed art, and never rebuilds the
atlases. Static serving is opt-in through `-static-dir` / `GLIMWAY_STATIC_DIR`
and remains disabled by default outside the image. HTML uses `no-store`;
content-hashed Vite assets are immutable; stable-name art revalidates using
content ETags. Missing assets are 404, while navigation paths fall back to
`index.html`. `/api/*` and `/ws` always retain their backend behavior.

### Docker updates and backups

Before changing `GLIMWAY_IMAGE_TAG`, take a backup. For example:

```sh
docker compose exec -T glimway mkdir -p /data/backups
docker compose exec -T glimway glimway-server -db /data/glimway.sqlite backup /data/backups/before-update.sqlite
mkdir -p backups
docker compose cp glimway:/data/backups/before-update.sqlite ./backups/
# Review migrations, then select a release tag in .env and update.
docker compose pull glimway
docker compose up -d --no-build --wait
```

The CLI runs as the same non-root user as the service. The backup filename must
be new each time. Schedule those commands using your host's cron or systemd,
use timestamped names, enforce your retention policy, and copy snapshots off the
host. Compose does not install the NixOS backup timer. Avoid archiving the live
volume while writes are occurring: use the consistent CLI snapshot, or stop the
service first. `docker compose down` preserves volumes; `down --volumes` deletes
them and must not be used for a production update.

Admission uses the same CLI:

```sh
docker compose exec -T glimway glimway-server -db /data/glimway.sqlite allowlist add HABITICA_USER_ID
docker compose exec -T glimway glimway-server -db /data/glimway.sqlite invite
```

For restore, stop the backend and any external backup scheduler. Copy the live
database and WAL/SHM sidecars to a separate recovery location, remove them from
the volume, then use a one-off container with the same named volume to install
the standalone snapshot as `/data/glimway.sqlite`, owned by 10001:10001 and mode
0600. Start the matching image version and verify player state before reopening
access. Switching an image tag back does not undo database migrations.

The release workflow uses only `GITHUB_TOKEN` with `packages:write`; it runs on
stable tags such as `v1.2.3`. After the first publish, the repository owner must
make the GHCR package public for unauthenticated pulls. No image is published by
local work on this checkout. CI checks out LFS content, runs the npm/Go checks,
builds a local image, and smoke-tests Compose with a disposable project volume.
