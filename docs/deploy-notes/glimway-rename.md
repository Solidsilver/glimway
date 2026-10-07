# Deploy note: the Glimway rename and service flake

The game became Glimway in October 2026. New deployments use the
[self-hosting guide](../home-server.md). Existing deployments can adopt the
flake while retaining their state directory and database.

## Player-visible rename

The session cookie is now `glimway_session`; the old `fingersnap_session`
cookie is ignored, so players sign in again once. Browser saves, settings and
remembered sign-ins retain their old storage names (`fingersnap`,
`fingersnap-connected`, `fingersnap-credentials` and `fingersnap:*`). Old save
codes still import. The title and credits now say Glimway. The default public
Habitica X-Client app name is `glimway`.

## Adopt the flake

1. Take a consistent backup with the currently installed binary, as its
   service user, against its actual database. Review the target migrations;
   migration 010 resets early homestead data and must not run on a real-player
   database without a preserving migration.
2. Add `inputs.glimway.url = "github:Solidsilver/glimway"` to your host flake,
   pass the input to `outputs`, and import `glimway.nixosModules.default`.
3. Remove the old `deploy/nixos/glimway.nix` and `glimway-server.nix` imports
   and any source-copy wrappers. Both paths now refer to one unified module.
   Importing it alone no longer starts the static service; set
   `services.glimway.enable = true`.
4. Transfer options using the table below. Set `stateDirectory` and `database`
   to the existing values; no data move is needed. `webPackage` now supplies
   the static site, so a checkout's `dist/` directory is optional.
5. Configure `publicOrigin` (for example `https://glimway.example.org`). Enable
   `reverseProxy.enable` for the module's Caddy site or keep your own proxy,
   routing `/api/*` and `/ws` to the backend and other paths to the web listener.
   Remove any duplicate Caddy site definition when enabling the managed one.
6. Stage the host configuration as required by its Git flake, build with
   `nixos-rebuild build --flake /etc/nixos#example`, then switch. Check
   `systemctl status glimway glimway-server`, the backup timer, and
   `https://glimway.example.org/api/calendar`. Sign in and check existing data.

| Previous setting | Unified module setting |
|---|---|
| `services.glimway-server.enable` | `services.glimway.enable` |
| `services.glimway-server.package` | `services.glimway.package` |
| `services.glimway-server.listen` | `services.glimway.listenAddress` + `port` |
| `services.glimway-server.stateDirectory`, `database` | `services.glimway.stateDirectory`, `database` (keep actual values) |
| `services.glimway-server.habiticaUrl`, `xClient` | `services.glimway.habitica.url`, `habitica.xClient` |
| `services.glimway-server.trustedProxies`, `partyAdmission` | Same names under `services.glimway` |
| `services.glimway-server.backupRetentionDays` | `services.glimway.backups.retentionDays` |
| `services.glimway.root` | `services.glimway.web.root`, or omit to use the packaged site |
| Static `services.glimway.user` | `services.glimway.web.user` + `web.group` for an existing static account |
| Static `services.glimway.listen` | `services.glimway.web.listenAddress` + `web.port` |
| CLI login-limit overrides | `services.glimway.login.concurrency`, `rate`, `globalRate` |

Example preserving arbitrary legacy paths:

```nix
services.glimway = {
  enable = true;
  stateDirectory = "legacy-game";
  database = "/var/lib/legacy-game/game.sqlite";
  publicOrigin = "https://glimway.example.org";
};
```

The unified module retains `glimway`, `glimway-server`,
`glimway-server-backup` and its timer. An instance still using `fingersnap*`
units should remove those old module imports as well. The new default account
is `glimway-server`; systemd re-owns the configured state directory on startup.
Directories outside StateDirectory are created with the selected account by
tmpfiles. If selecting an existing account, set `createUser=false`.

The server reads `GLIMWAY_*`, with deprecated `FINGERSNAP_*` fallbacks. Rename
custom overrides. Update admin scripts to use `glimway-server` and pass the
existing database path. The binary and web bundle are now built from the flake
input: updating that input replaces rsync, server-side npm builds, and source
copies into the host configuration.

To roll back, switch to the previous NixOS generation. Database migrations are
not undone; restore a matching backup if needed. Changing between old and new
cookie names signs players out again. Local machine details and commands are
kept only in ignored `deploy/local/OWNER-NOTES.md`.
