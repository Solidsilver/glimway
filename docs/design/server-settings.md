# Server settings

The server reads one TOML file, the same however it's deployed: by hand, in
Docker or under NixOS. Dev mode is its first user. How to run it:
[home-server.md](../home-server.md#server-settings-and-dev-mode).

## The file

- **Where:** `-config <path>` or `GLIMWAY_CONFIG=<path>`. There is no default
  path. Without a file the server runs on its defaults, and a dev build
  behaves as it always has (below). A fixed path such as
  `/etc/glimway/config.toml` was left out on purpose: on a host with the live
  and staging instances and local `npm run server`, every one of them would
  read the live file.
- **Format:** snake_case keys in tables. It's read with
  [BurntSushi/toml](https://github.com/BurntSushi/toml), and any key the
  server doesn't know is an error (`MetaData.Undecoded`), so a typo fails
  loudly. [deploy/glimway.example.toml](../../deploy/glimway.example.toml)
  lists every setting with its default, its variable, and whether it applies
  live or at restart.
- **Layers, lowest first:** the defaults, the file, `GLIMWAY_*` variables,
  then flags.
  - A setting's variable is `GLIMWAY_` and its path in capitals:
    `dev.enable` is `GLIMWAY_DEV_ENABLE`, and `server.login.rate` is
    `GLIMWAY_SERVER_LOGIN_RATE`. Lists are comma-separated.
  - A setting that used to be a variable keeps its old name as well (an `env`
    tag): `GLIMWAY_LOGIN_RATE`, and still `FINGERSNAP_LOGIN_RATE`.
  - Flags (`-login-rate`) win over everything.
  - A variable or flag pins its setting: a reload reads the file again, but
    the variable still wins.
- **Check without running:** `glimway-server -config FILE check-config`.
  The Nix module runs it on every rebuild.

### Tables

| Table | Read by | For |
|---|---|---|
| `[dev]` | both sides | Whether dev mode is on (`enable`) and for whom (`accounts`) |
| `[server.*]` | the server | The server's own settings: `[server.login]`, `[server.dev]` (grant, clock, fight_fall) |
| `[web.*]` | the web client | Settings the server hands each player: `[web.dev]` (hooks) |

Dev mode is split this way because who gets it is one decision both sides
must agree on, while each tool runs on one side. The server enforces all of
it: a web tool the server doesn't grant is never shown. Future settings go
by where they run: `[server.<area>]` or `[web.<area>]`.

### The web part

`GET /api/web-settings` (no sign-in needed) answers `[web]` for this caller,
by TOML name, with `"dev"` replaced by the dev tools this player has: both
sides' tools, so the panel shows only what the server will do. For anyone
else, `"dev"` is `null`. The client reads it at start, on sign-in and on
switching accounts (src/lib/web-settings.ts). A change to `[web]` needs a
reload, never a new web build.

## Live and restart

Every setting is marked `apply:"live"` or `apply:"restart"`.

- **Reload:** SIGHUP, which is `systemctl reload` under NixOS and
  `docker kill -s HUP` in Docker. The server reads the file and variables
  again. If they load and check, live settings take the new values and
  players stay connected. Restart settings keep their running values, and
  the log names any that changed: `settings: server.login.rate change at the
  next restart`. If they don't load or check, nothing changes and the log
  says why.
- **Startup-only, outside the file:** `-listen`, `-db`, `-static-dir` and
  the other existing flags and variables still need a restart. They haven't
  moved into the file yet.

| Setting | Applies |
|---|---|
| `dev.enable`, `dev.accounts` | live |
| `server.dev.grant`, `server.dev.clock`, `server.dev.fight_fall` | live |
| `web.dev.hooks` | live (the player reloads the page) |
| `server.login.concurrency`, `server.login.rate`, `server.login.global_rate` | restart |

## Dev mode

- **Builds:** dev tools exist only in dev builds.
  - The server: `go build -tags dev`.
  - The web: the Vite dev server, or `GLIMWAY_DEV_TOOLS=1 vite build`. A
    release build replaces `__GLIMWAY_DEV_TOOLS__` with `false`, so the dev
    panel and the world's hooks never reach its bundle.
  - A release server given `dev.enable = true` refuses to start, to pass
    check-config, or to reload.
- **Tools:** each tool (`server.dev.*`, `web.dev.hooks`) follows
  `dev.enable` unless it's set itself.
- **Without a settings file or `GLIMWAY_DEV_ENABLE`** (local dev, e2e): a
  dev build serves every tool to callers on this machine. A request with
  `X-Forwarded-For` or `Forwarded` doesn't count as this machine's. The
  clock moves only with `-dev-clock`. The Vite dev server shows every client
  tool.
- **With either** (staging): the caller's address says nothing, because
  behind Caddy everyone comes from 127.0.0.1. A dev route answers only when
  all of these hold:
  - it's a dev build;
  - `dev.enable` and that tool's setting are on;
  - the request has a signed-in, allowlisted session;
  - the account is in `dev.accounts`, or the list is empty;
  - a write comes from the same site, as JSON.

  Anyone else gets a 404. A dev build with a settings file always runs a
  movable clock (from the real time), so `server.dev.clock` can be turned on
  by a reload.
- **Moving the clock** is world-wide and forward-only. The panel asks before
  moving it, and the server logs every move.
- **Under Nix,** `services.<name>.settings.dev.enable` picks the dev builds of
  the server and the web, and with it off the instance runs release code.
  Only an instance made with `allowDevMode` (the staging `glimway-dev`) may
  turn it on; the live instance fails an assertion.
- **In Docker,** build the image with `--build-arg GLIMWAY_DEV_TOOLS=1`. The
  release workflow doesn't publish a dev image.

## Adding a setting

1. Add the field to its table in `server/internal/settings/settings.go`, with
   `toml:"snake_name"`, `apply:"live"` or `apply:"restart"`, and a `doc:"…"`
   line. Put its default in `Default()`, and anything to refuse in `Check`.
   A new table is a struct field with `toml` and `doc` tags.
2. Run `go test ./server/internal/settings -run TestExample -update` to
   rewrite the example file. The test fails until you do.
3. Read it where it's used:
   - **A live server setting:** read `live.get()` (or the `settings` func the
     code was given) at the moment it's used, never once at startup, so a
     reload reaches it.
   - **A restart server setting:** read `conf` once in `run`
     (server/cmd/glimway-server/main.go) and pass it on, as
     `server.login` does. If it replaces an older flag, keep the flag
     (`fromFlags`), and give the old variable name as an `env` tag.
   - **A web setting:** add it to `Web` with its `toml` tag. It reaches the
     client in `/api/web-settings` under that name. Read it in
     `src/lib/web-settings.ts` (the `WebSettings` type and
     `parseWebSettings`).
4. The NixOS option needs nothing: `settings` is freeform. Type it there only
   if the module itself reads it, as `dev.enable` is.
