# Deploy note: the Glimway rename

For the owner, for the first deploy after the game became Glimway (October 2026). Nothing here has
been run on the server by an agent. Paths are the main instance's, as in
[home-server.md](../home-server.md).

## What players notice

- **Everyone is signed out once.** The session cookie is now `glimway_session`; the old
  `fingersnap_session` cookie is ignored. Players sign in again with their Habitica details and
  land in their world as before. Nothing on the server is lost. A player who let this device
  remember their Habitica details still has them.
- **Guests notice nothing.** Saves, settings and remembered sign-ins stay in the browser under
  their old names (the `fingersnap` and `fingersnap-connected` IndexedDB databases,
  `fingersnap-credentials`, and the `fingersnap:*` keys). Save codes made before the rename still
  import.
- **The name.** The title screen, the page title and the credits say Glimway. Habitica now sees
  the app as `5abfd539-22eb-457f-8e2a-9fb3d66731f1-glimway` (the `x-client` header).

## What stays the same on the server

- The checkout at `~/code/fingersnap`, the source copy at
  `/etc/nixos/services/native/fingersnap-source`, the domain `fsnap.example.invalid` and the
  Caddy config (same ports: 4173 and 8090). Renaming any of them is optional and separate.
- The state directory `/var/lib/fingersnap-server` and the database
  `/var/lib/fingersnap-server/fingersnap.sqlite`, through two new module options (below). Nightly
  backups keep going to `/var/lib/fingersnap-server/backups/`.

## What changes

| Before | After |
|---|---|
| `deploy/nixos/fingersnap.nix`, unit `fingersnap` | `deploy/nixos/glimway.nix`, unit `glimway` |
| `deploy/nixos/fingersnap-server.nix`, `services.fingersnap-server` | `deploy/nixos/glimway-server.nix`, `services.glimway-server` |
| units `fingersnap-server`, `fingersnap-server-backup` (+ timer) | `glimway-server`, `glimway-server-backup` (+ timer) |
| system user and group `fingersnap-server` | `glimway-server` |
| binary `fingersnap-server` | `glimway-server` |
| `FINGERSNAP_*` environment variables | `GLIMWAY_*` (the old names still work for now; see below) |
| default database `/var/lib/fingersnap-server/fingersnap.sqlite` | `/var/lib/<stateDirectory>/glimway.sqlite`, `stateDirectory` defaulting to `glimway-server` |

## Steps

1. **Back up first**, with the old binary, while the old service still runs:

   ```sh
   sudo -u fingersnap-server fingersnap-server -db /var/lib/fingersnap-server/fingersnap.sqlite \
     backup /var/lib/fingersnap-server/backups/before-glimway.sqlite
   ```

2. **Copy the source and build the site** as in "Update the app" (the rsync to
   `~/code/fingersnap`, then `npm ci && npm run verify`). The static server keeps serving `dist/`.

3. **Refresh the source copy in `/etc/nixos`** with the rsync under "Server source in /etc/nixos".
   Its `--delete` drops the old `deploy/nixos/fingersnap*.nix` and `server/cmd/fingersnap-server`
   from the copy. Then `git -C /etc/nixos add services/native/fingersnap-source`.

4. **Replace the static-site module.** In `/etc/nixos/services/native/`:

   ```sh
   cd /etc/nixos/services/native
   cp ~/code/fingersnap/deploy/nixos/glimway.nix glimway.nix
   git rm fingersnap.nix
   git add glimway.nix
   ```

   In that directory's `default.nix`, change `./fingersnap.nix` to `./glimway.nix`. The module's
   `root`, `user` and `listen` options default to the main instance's values
   (`/home/deploy-user/code/fingersnap/dist`, `deploy-user`, `127.0.0.1:4173`), so it needs no
   settings.

5. **Replace the server wrapper.** Rename `fingersnap-server.nix` to `glimway-server.nix` (the file
   name is up to you; `default.nix` must match) and make it:

   ```nix
   { ... }:
   {
     imports = [ ./fingersnap-source/deploy/nixos/glimway-server.nix ];
     services.glimway-server = {
       enable = true;
       # Keep the data where it is.
       stateDirectory = "fingersnap-server";
       database = "/var/lib/fingersnap-server/fingersnap.sqlite";
     };
   }
   ```

   Carry over any other `services.fingersnap-server.*` settings you had under the new name. Update
   `default.nix` and `git add` the wrapper (`git rm` the old file if you renamed it).

6. **Environment variables.** The module now sets `GLIMWAY_*`. If you set any `FINGERSNAP_*`
   yourself (a systemd override, a shell profile for the admin CLI), rename them. The server
   still reads `FINGERSNAP_<NAME>` when `GLIMWAY_<NAME>` is unset, but that fallback is
   deprecated and will go in a later release.

7. **Build, then switch:**

   ```sh
   nh os build /etc/nixos --hostname example-host --no-update-lock-file --out-link ~/glimway-nixos-result
   nh os switch /etc/nixos --hostname example-host
   ```

   The switch stops and removes the `fingersnap*` units and starts the `glimway*` ones. The
   `fingersnap-server` user is no longer declared. On its first start, systemd sees that
   `/var/lib/fingersnap-server` belongs to another user and re-owns it, recursively, to
   `glimway-server`. The Nix `vendorHash` is unchanged by the rename (checked).

8. **Check:**

   ```sh
   systemctl status glimway glimway-server --no-pager
   systemctl list-timers glimway-server-backup --no-pager
   ls -ld /var/lib/fingersnap-server            # owned by glimway-server, mode 0700
   curl -s https://fsnap.example.invalid/api/calendar
   ```

   Then sign in once in a browser: the menu's About card should say Glimway and credit
   HabitRPG, Inc.

9. **Admin CLI from now on:**

   ```sh
   DB=/var/lib/fingersnap-server/fingersnap.sqlite
   sudo -u glimway-server glimway-server -db "$DB" allowlist list
   ```

## Rolling back

Switch to the previous NixOS generation (`nixos-rebuild switch --rollback`) and put the previous
`dist/` back. The old service starts as `fingersnap-server`, and systemd re-owns the state
directory back the same way. Players are signed out once more, since the old build only knows
`fingersnap_session`.

## Later, if you want

- Move the checkout to `~/code/glimway` (then set `services.glimway.root`) and the source copy to
  `glimway-source` (then fix the wrapper's `imports`).
- Move the data to `/var/lib/glimway-server`: stop `glimway-server`, move the database with its
  `-wal`/`-shm` files (or restore a backup as `glimway.sqlite`), and drop the two options.
- A new domain, with the old one redirecting.
