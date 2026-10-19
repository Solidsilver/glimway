# One Glimway instance, named by its option path under services. Every name
# the instance owns (units, account, state directory, backup script, admin
# command) derives from `name`, so instances with different names share none.
# glimway.nix is the live instance, glimway-dev.nix the staging one.
{ name, title, port, webPort
# Put the package itself on PATH. Only one instance may: the others install a
# `<name>-server` command instead, so `glimway-server` stays the live binary.
, installPackage ? false
# Let this instance turn on dev mode (settings.dev.enable). Only the staging
# instance (glimway-dev.nix) does: the live one can never run dev tools.
, allowDevMode ? false
}:
{ config, lib, pkgs, utils, ... }:
let
  inherit (lib) mkOption mkEnableOption types;
  cfg = config.services.${name};
  opt = "services.${name}";
  serverUnit = "${name}-server";
  stateDir = "/var/lib/${cfg.stateDirectory}";
  listen = address: port: "${if lib.hasInfix ":" address then "[${address}]" else address}:${toString port}";
  backendListen = listen cfg.listenAddress cfg.port;
  webListen = listen cfg.web.listenAddress cfg.web.port;
  webRoot = if cfg.web.root == null then toString cfg.webPackage else cfg.web.root;
  bool = lib.boolToString;
  toml = pkgs.formats.toml { };
  devMode = cfg.settings.dev.enable;
  # The settings file, checked by the server it is for (a typo, or dev mode
  # for a release build, fails the rebuild instead of the reload). It sits at
  # a fixed path in /etc, so a change reloads the server (reloadTriggers)
  # rather than restarting it.
  settingsFile = pkgs.runCommand "${name}-settings.toml" { raw = toml.generate "${name}-settings.toml" cfg.settings; } ''
    ${lib.getExe cfg.package} -config "$raw" check-config
    cp "$raw" "$out"
  '';
  settingsPath = "${name}/config.toml";
  option = type: default: description: mkOption { inherit type default description; };
  # The login options are defaults for settings.server.login (config below),
  # never flags: a flag would pin them over the settings file.
  args = cfg.extraFlags;
  isDev = p: p.passthru.devTools or false;
  # What dev mode needs besides settings.dev.enable: a dev package, a dev
  # variable (GLIMWAY_DEV_ENABLE, GLIMWAY_SERVER_DEV_*, GLIMWAY_WEB_DEV_*, or
  # the old FINGERSNAP_ names) or a dev flag (-dev-clock). An instance that
  # doesn't allow dev mode may have none of them.
  devVars = lib.filter (n: builtins.match "(GLIMWAY|FINGERSNAP)_(DEV|SERVER_DEV|WEB_DEV)_.*" n != null) (lib.attrNames cfg.extraEnvironment);
  devFlags = lib.filter (a: builtins.match "--?dev-.*" a != null) cfg.extraFlags;
  devPackages = lib.filter isDev [ cfg.package cfg.webPackage ];
  writable = lib.unique [ (builtins.dirOf cfg.database) cfg.sprite.cacheDirectory ];
  hardening = {
    User = cfg.user;
    Group = cfg.group;
    StateDirectory = cfg.stateDirectory;
    StateDirectoryMode = "0700";
    UMask = "0077";
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
    ReadWritePaths = writable;
  };
  # A failed backup or restore check fails the unit (systemctl --failed) before
  # pruning, so old snapshots stay until a new one verifies. A snapshot that
  # fails the check is kept as .sqlite.unverified, out of retention and restores.
  backup = pkgs.writeShellScript "${name}-backup" ''
    set -eu
    backup_dir=${lib.escapeShellArg cfg.backups.directory}
    snapshot="$backup_dir/$(${pkgs.coreutils}/bin/date -u +%Y-%m-%dT%H-%M-%S)-$$.sqlite"
    ${lib.getExe cfg.package} -db ${lib.escapeShellArg cfg.database} backup "$snapshot"
    if ! ${lib.getExe cfg.package} verify-backup "$snapshot"; then
      ${pkgs.coreutils}/bin/mv "$snapshot" "$snapshot.unverified"
      exit 1
    fi
    ${pkgs.findutils}/bin/find "$backup_dir" -type f -name '*.sqlite' -mtime +${toString cfg.backups.retentionDays} -delete
  '';
in {
  options.services.${name} = {
    enable = mkEnableOption "${title} game server and static web app";
    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ../../nix/server.nix { devTools = devMode; };
      defaultText = lib.literalMD "the release build, or the dev build (`-tags dev`) when `settings.dev.enable`";
      description = "Go server and admin CLI package.";
    };
    webPackage = mkOption {
      type = types.package;
      default = pkgs.callPackage ../../nix/web.nix {
        habiticaCreatorId = cfg.habitica.creatorId;
        habiticaAppName = cfg.habitica.appName;
        devTools = devMode;
      };
      defaultText = lib.literalMD "the release site, or the dev-tools site when `settings.dev.enable`; built with the configured public Habitica identity";
      description = "Built static site.";
    };
    settings = mkOption {
      # RFC 42: the server's own TOML file as an attribute set, with the
      # settings the module itself reads typed and the rest freeform.
      type = types.submodule {
        freeformType = toml.type;
        options.dev = {
          enable = option types.bool false
            "Dev mode: the dev panel, grants, playtest hooks and clock ([server.dev], [web.dev]). Picks the dev builds of `package` and `webPackage`. Only an instance that allows dev mode (the staging `services.glimway-dev`) may turn it on.";
          accounts = option (types.listOf types.str) [ ]
            "Habitica user ids that get dev mode's tools. Empty: every signed-in player on this instance.";
        };
      };
      default = { };
      example = lib.literalExpression ''
        {
          dev = { enable = true; accounts = [ "<your Habitica user id>" ]; };
          server.dev.clock = false;
        }
      '';
      description = ''
        The server's settings file (TOML), as an attribute set, rendered to
        /etc/<name>/config.toml. Every setting, its default and whether a change
        applies live or at restart: deploy/glimway.example.toml. An unknown key
        fails the rebuild. A change to live settings reloads the server (players
        stay connected); flags, `extraFlags` and GLIMWAY_* variables in
        `extraEnvironment` still win over the file.
      '';
    };
    listenAddress = option types.str "127.0.0.1" "Backend bind address (IPv6 without brackets).";
    port = option types.port port "Backend HTTP port.";
    publicOrigin = option types.str "https://glimway.example.org" "Public HTTP(S) origin, including a nonstandard port if needed. Used by the optional Caddy virtual host; preserve this Host when using another proxy.";
    stateDirectory = option types.str serverUnit "Relative systemd StateDirectory under /var/lib. Set to the existing directory when migrating.";
    database = mkOption {
      type = types.str;
      default = "${stateDir}/glimway.sqlite";
      defaultText = lib.literalExpression ''"/var/lib/''${stateDirectory}/glimway.sqlite"'';
      description = "Absolute SQLite path. Its parent directory is created and made writable.";
    };
    user = option types.str serverUnit "Service account; also used for backups and the static listener.";
    group = option types.str serverUnit "Service group.";
    createUser = option types.bool true "Create the system account/group. Disable to use an existing account.";
    cookieSecure = option types.bool true "Secure cookies; disable only for local HTTP.";
    partyAdmission = option types.bool true "Allow admission through existing Habitica party worlds.";
    trustedProxies = option (types.listOf types.str) [ "127.0.0.1" "::1" ] "Proxy IPs allowed to supply the last X-Forwarded-For hop; empty trusts none.";
    habitica = {
      url = option types.str "https://habitica.com" "Habitica login-proof API URL.";
      creatorId = option types.str "5abfd539-22eb-457f-8e2a-9fb3d66731f1" "Public creator ID for the Habitica X-Client header (not a player credential).";
      appName = option types.str "glimway" "Public Habitica application name; also compiled into the default web package.";
      xClient = option types.str "${cfg.habitica.creatorId}-${cfg.habitica.appName}" "Full backend X-Client override; defaults to creator-id-appname.";
    };
    login = {
      concurrency = option types.ints.positive 4 "Maximum concurrent upstream identity proofs. The default for `settings.server.login.concurrency`, which wins when set.";
      rate = option types.ints.positive 10 "Eligible login attempts per IP/IPv6 /64 per minute. The default for `settings.server.login.rate`, which wins when set.";
      globalRate = option types.ints.positive 60 "Global upstream calls per minute, including retries. The default for `settings.server.login.global_rate`, which wins when set.";
    };
    sprite = {
      assetsUrl = option types.str "https://habitica-assets.s3.amazonaws.com/mobileApp/images/" "Upstream Habitica outfit sprite proxy URL.";
      cacheDirectory = option types.str "${builtins.dirOf cfg.database}/habitica-sprites" "Absolute directory for the sprite proxy cache; created for the service user.";
    };
    backups = {
      enable = option types.bool true "Enable consistent SQLite backups and their timer.";
      schedule = option types.str "*-*-* 03:15:00" "systemd OnCalendar expression.";
      randomizedDelaySec = option types.str "10m" "Randomized delay for scheduled backups.";
      retentionDays = option types.ints.unsigned 30 "Delete snapshots older than this number of days after a successful backup.";
      directory = option types.str "${stateDir}/backups" "Absolute backup destination directory; created for the service user.";
    };
    extraEnvironment = option (types.attrsOf types.str) { } "Extra environment variables, overriding generated values. Nix store values are public; do not put secrets here.";
    extraFlags = option (types.listOf types.str) [ ] "Extra server flags appended after generated flags.";
    openFirewall = option types.bool false "Open the backend TCP port for non-loopback listeners; with the managed Caddy proxy, open 80 and 443 instead.";
    web = {
      enable = option types.bool true "Serve the web app on a local listener (the server's static-only mode, with cache headers).";
      root = option (types.nullOr types.str) null "Optional absolute existing dist directory instead of webPackage (migration escape hatch).";
      listenAddress = option types.str "127.0.0.1" "Static listener bind address (IPv6 without brackets).";
      user = option types.str cfg.user "Existing account for the static listener; defaults to the backend user.";
      group = option types.str cfg.group "Existing group for the static listener; defaults to the backend group.";
      port = option types.port webPort "Static web listener port.";
    };
    reverseProxy.enable = mkEnableOption "Caddy HTTPS virtual host at publicOrigin, routing /api/* and /ws to the backend and other requests to the static listener";
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      assertions = [
        { assertion = builtins.match "[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*" cfg.stateDirectory != null
            && !(lib.any (part: builtins.elem part [ "." ".." ]) (lib.splitString "/" cfg.stateDirectory));
          message = "${opt}.stateDirectory must be a relative directory without dot segments."; }
        { assertion = lib.all (path: lib.hasPrefix "/" path && path != "/"
            && !(lib.any (part: builtins.elem part [ "." ".." ]) (lib.splitString "/" path)))
            ([ cfg.database (builtins.dirOf cfg.database) cfg.sprite.cacheDirectory cfg.backups.directory ] ++ lib.optional (cfg.web.root != null) cfg.web.root);
          message = "${title} database, sprite cache, backup directory and web root must be absolute paths other than /."; }
        { assertion = builtins.match "https?://[a-zA-Z0-9.-]+(:[0-9]+)?" cfg.publicOrigin != null;
          message = "${opt}.publicOrigin must be an HTTP(S) hostname origin without a path."; }
        { assertion = !cfg.reverseProxy.enable || cfg.web.enable;
          message = "${title}'s managed Caddy proxy requires the static web listener."; }
        { assertion = !devMode || allowDevMode;
          message = "${opt}.settings.dev.enable: ${title} doesn't allow dev mode. Only the staging instance (services.glimway-dev) may run dev tools."; }
        { assertion = allowDevMode || devPackages == [ ] && devVars == [ ] && devFlags == [ ];
          message = "${title} doesn't allow dev mode, but has a dev build in package or webPackage, or ${lib.concatStringsSep ", " (devVars ++ devFlags)} in extraEnvironment or extraFlags. Only the staging instance (services.glimway-dev) may run dev tools."; }
        { assertion = !devMode || isDev cfg.package && isDev cfg.webPackage;
          message = "${opt}.settings.dev.enable needs the dev builds of package and webPackage (nix/server.nix and nix/web.nix with devTools = true), the defaults when it is on."; }
      ];
      # The login options, as defaults the settings can override.
      services.${name}.settings.server.login = lib.mapAttrs (_: lib.mkDefault) {
        inherit (cfg.login) concurrency rate;
        global_rate = cfg.login.globalRate;
      };
      environment.etc.${settingsPath}.source = settingsFile;
      environment.systemPackages = if installPackage then [ cfg.package ] else [
        (pkgs.writeShellScriptBin serverUnit ''exec ${lib.getExe cfg.package} "$@"'')
      ];
      systemd.tmpfiles.rules = map (path: "d ${lib.escapeShellArg path} 0700 ${cfg.user} ${cfg.group} - -")
        (lib.unique (writable ++ lib.optional cfg.backups.enable cfg.backups.directory));
      systemd.services.${serverUnit} = {
        description = "${title} Go backend";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment = {
          GLIMWAY_LISTEN = backendListen;
          GLIMWAY_DB = cfg.database;
          GLIMWAY_HABITICA_URL = cfg.habitica.url;
          GLIMWAY_X_CLIENT = cfg.habitica.xClient;
          GLIMWAY_COOKIE_SECURE = bool cfg.cookieSecure;
          GLIMWAY_TRUSTED_PROXIES = lib.concatStringsSep "," cfg.trustedProxies;
          GLIMWAY_PARTY_ADMISSION = bool cfg.partyAdmission;
          GLIMWAY_HABITICA_ASSETS_URL = cfg.sprite.assetsUrl;
          GLIMWAY_SPRITE_CACHE = cfg.sprite.cacheDirectory;
          GLIMWAY_CONFIG = "/etc/${settingsPath}";
        } // cfg.extraEnvironment;
        # A settings change reloads (SIGHUP): live settings apply, players stay.
        # A change to a restart-only setting (deploy/glimway.example.toml marks
        # them) restarts instead: list each restart-only table here.
        reloadTriggers = [ settingsFile ];
        restartTriggers = [ (builtins.toJSON (cfg.settings.server.login or { })) ];
        serviceConfig = hardening // {
          ExecStart = utils.escapeSystemdExecArgs ([ (lib.getExe cfg.package) ] ++ args);
          ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
          WorkingDirectory = stateDir;
          Restart = "on-failure";
          RestartSec = "5s";
        };
      };
    }
    (lib.mkIf cfg.createUser {
      users.groups.${cfg.group} = { };
      users.users.${cfg.user} = { isSystemUser = true; group = cfg.group; };
    })
    (lib.mkIf cfg.web.enable {
      # The web bundle through the server's own static handler (serve-static:
      # no database, no settings), not a plain file server: the Nix store's
      # 1970 timestamps leave a file server no validator, so every launch
      # downloaded all the art. This sends content ETags, immutable caching
      # for Vite's hashed assets and no-store for html and version.json
      # (server/cmd/glimway-server/static.go, docs/home-server.md).
      systemd.services.${name} = {
        description = "${title} static web app";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        serviceConfig = {
          ExecStart = utils.escapeSystemdExecArgs [ (lib.getExe cfg.package) "-listen" webListen "-static-dir" webRoot "serve-static" ];
          User = cfg.web.user;
          Group = cfg.web.group;
          Restart = "on-failure";
          RestartSec = "5s";
          NoNewPrivileges = true;
          ProtectSystem = "strict";
          ProtectHome = "read-only";
          PrivateTmp = true;
          PrivateDevices = true;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectControlGroups = true;
          RestrictSUIDSGID = true;
          ProtectKernelLogs = true;
          LockPersonality = true;
          RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
        };
      };
    })
    (lib.mkIf cfg.backups.enable {
      systemd.services."${serverUnit}-backup" = {
        description = "${title} consistent SQLite backup";
        serviceConfig = hardening // {
          Type = "oneshot";
          ExecStart = backup;
          ReadWritePaths = lib.unique (writable ++ [ cfg.backups.directory ]);
        };
      };
      systemd.timers."${serverUnit}-backup" = {
        description = "Scheduled ${title} backup";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnCalendar = cfg.backups.schedule;
          Persistent = true;
          RandomizedDelaySec = cfg.backups.randomizedDelaySec;
        };
      };
    })
    (lib.mkIf cfg.reverseProxy.enable {
      services.caddy.enable = true;
      services.caddy.virtualHosts.${cfg.publicOrigin}.extraConfig = ''
        handle /api/* {
          encode zstd gzip
          reverse_proxy ${backendListen}
        }
        handle /ws {
          reverse_proxy ${backendListen}
        }
        handle {
          encode zstd gzip
          reverse_proxy ${webListen}
        }
      '';
    })
    (lib.mkIf cfg.openFirewall {
      networking.firewall.allowedTCPPorts =
        if cfg.reverseProxy.enable then [ 80 443 ]
        else lib.optional (!(builtins.elem cfg.listenAddress [ "127.0.0.1" "::1" ])) cfg.port;
    })
  ]);
}
