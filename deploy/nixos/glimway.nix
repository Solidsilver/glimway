{ config, lib, pkgs, utils, ... }:
let
  inherit (lib) mkOption mkEnableOption types;
  cfg = config.services.glimway;
  stateDir = "/var/lib/${cfg.stateDirectory}";
  listen = address: port: "${if lib.hasInfix ":" address then "[${address}]" else address}:${toString port}";
  backendListen = listen cfg.listenAddress cfg.port;
  webListen = listen cfg.web.listenAddress cfg.web.port;
  webRoot = if cfg.web.root == null then toString cfg.webPackage else cfg.web.root;
  bool = lib.boolToString;
  option = type: default: description: mkOption { inherit type default description; };
  args = [
    "-login-concurrency" (toString cfg.login.concurrency)
    "-login-rate" (toString cfg.login.rate)
    "-login-global-rate" (toString cfg.login.globalRate)
  ] ++ cfg.extraFlags;
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
  backup = pkgs.writeShellScript "glimway-backup" ''
    set -eu
    backup_dir=${lib.escapeShellArg cfg.backups.directory}
    ${lib.getExe cfg.package} -db ${lib.escapeShellArg cfg.database} backup "$backup_dir/$(${pkgs.coreutils}/bin/date -u +%Y-%m-%dT%H-%M-%S)-$$.sqlite"
    ${pkgs.findutils}/bin/find "$backup_dir" -type f -name '*.sqlite' -mtime +${toString cfg.backups.retentionDays} -delete
  '';
in {
  options.services.glimway = {
    enable = mkEnableOption "Glimway game server and static web app";
    package = option types.package (pkgs.callPackage ../../nix/server.nix { }) "Go server and admin CLI package.";
    webPackage = option types.package (pkgs.callPackage ../../nix/web.nix {
      habiticaCreatorId = cfg.habitica.creatorId;
      habiticaAppName = cfg.habitica.appName;
    }) "Built static site; default uses the configured public Habitica identity.";
    listenAddress = option types.str "127.0.0.1" "Backend bind address (IPv6 without brackets).";
    port = option types.port 8090 "Backend HTTP port.";
    publicOrigin = option types.str "https://glimway.example.org" "Public HTTP(S) origin, including a nonstandard port if needed. Used by the optional Caddy virtual host; preserve this Host when using another proxy.";
    stateDirectory = option types.str "glimway-server" "Relative systemd StateDirectory under /var/lib. Set to the existing directory when migrating.";
    database = mkOption {
      type = types.str;
      default = "${stateDir}/glimway.sqlite";
      defaultText = lib.literalExpression ''"/var/lib/''${stateDirectory}/glimway.sqlite"'';
      description = "Absolute SQLite path. Its parent directory is created and made writable.";
    };
    user = option types.str "glimway-server" "Service account; also used for backups and the static listener.";
    group = option types.str "glimway-server" "Service group.";
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
      concurrency = option types.ints.positive 4 "Maximum concurrent upstream identity proofs.";
      rate = option types.ints.positive 10 "Eligible login attempts per IP/IPv6 /64 per minute.";
      globalRate = option types.ints.positive 60 "Global upstream calls per minute, including retries.";
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
      enable = option types.bool true "Run the static file server on a local listener.";
      root = option (types.nullOr types.str) null "Optional absolute existing dist directory instead of webPackage (migration escape hatch).";
      listenAddress = option types.str "127.0.0.1" "Static listener bind address (IPv6 without brackets).";
      user = option types.str cfg.user "Existing account for the static listener; defaults to the backend user.";
      group = option types.str cfg.group "Existing group for the static listener; defaults to the backend group.";
      port = option types.port 4173 "Static file server port.";
    };
    reverseProxy.enable = mkEnableOption "Caddy HTTPS virtual host at publicOrigin, routing /api/* and /ws to the backend and other requests to the static listener";
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      assertions = [
        { assertion = builtins.match "[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*" cfg.stateDirectory != null
            && !(lib.any (part: builtins.elem part [ "." ".." ]) (lib.splitString "/" cfg.stateDirectory));
          message = "services.glimway.stateDirectory must be a relative directory without dot segments."; }
        { assertion = lib.all (path: lib.hasPrefix "/" path && path != "/"
            && !(lib.any (part: builtins.elem part [ "." ".." ]) (lib.splitString "/" path)))
            ([ cfg.database (builtins.dirOf cfg.database) cfg.sprite.cacheDirectory cfg.backups.directory ] ++ lib.optional (cfg.web.root != null) cfg.web.root);
          message = "Glimway database, sprite cache, backup directory and web root must be absolute paths other than /."; }
        { assertion = builtins.match "https?://[a-zA-Z0-9.-]+(:[0-9]+)?" cfg.publicOrigin != null;
          message = "services.glimway.publicOrigin must be an HTTP(S) hostname origin without a path."; }
        { assertion = !cfg.reverseProxy.enable || cfg.web.enable;
          message = "Glimway's managed Caddy proxy requires the static web listener."; }
      ];
      environment.systemPackages = [ cfg.package ];
      systemd.tmpfiles.rules = map (path: "d ${lib.escapeShellArg path} 0700 ${cfg.user} ${cfg.group} - -")
        (lib.unique (writable ++ lib.optional cfg.backups.enable cfg.backups.directory));
      systemd.services.glimway-server = {
        description = "Glimway Go backend";
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
        } // cfg.extraEnvironment;
        serviceConfig = hardening // {
          ExecStart = utils.escapeSystemdExecArgs ([ (lib.getExe cfg.package) ] ++ args);
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
      systemd.services.glimway = {
        description = "Glimway static web app";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        serviceConfig = {
          ExecStart = utils.escapeSystemdExecArgs [ "${pkgs.caddy}/bin/caddy" "file-server" "--root" webRoot "--listen" webListen ];
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
        };
      };
    })
    (lib.mkIf cfg.backups.enable {
      systemd.services.glimway-server-backup = {
        description = "Glimway consistent SQLite backup";
        serviceConfig = hardening // {
          Type = "oneshot";
          ExecStart = backup;
          ReadWritePaths = lib.unique (writable ++ [ cfg.backups.directory ]);
        };
      };
      systemd.timers.glimway-server-backup = {
        description = "Scheduled Glimway backup";
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
