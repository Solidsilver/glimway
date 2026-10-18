# Evaluate Linux configurations on any supported build host, including Darwin.
{ pkgs, nixpkgs }:
let
  inherit (nixpkgs) lib;
  # Both instance modules, as a host importing the live and the dev input has.
  evaluateBoth = services: (lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      ../deploy/nixos/glimway.nix
      ../deploy/nixos/glimway-dev.nix
      {
        system.stateVersion = "26.05";
        boot.loader.grub.enable = false;
        fileSystems."/" = { device = "/dev/disk/by-label/root"; fsType = "ext4"; };
        inherit services;
      }
    ];
  }).config;
  evaluate = settings: evaluateBoth { glimway = settings; };
  defaults = evaluate { enable = true; };
  # The host's shape: its own Caddy sites, so neither instance enables Caddy.
  liveSettings = { enable = true; publicOrigin = "https://fsnap.example.org"; };
  devSettings = { enable = true; publicOrigin = "https://glim-dev.example.org"; };
  live = evaluate liveSettings;
  dev = evaluateBoth { glimway-dev = devSettings; };
  both = evaluateBoth { glimway = liveSettings; glimway-dev = devSettings; };
  proxied = evaluateBoth {
    glimway = liveSettings // { reverseProxy.enable = true; };
    glimway-dev = devSettings // { reverseProxy.enable = true; };
  };
  legacy = evaluate {
    enable = true;
    stateDirectory = "legacy-game";
    database = "/var/lib/legacy-game/game.sqlite";
    web.root = "/srv/glimway/dist";
  };
  custom = evaluate {
    enable = true;
    user = "game";
    group = "games";
    listenAddress = "::1";
    port = 9090;
    publicOrigin = "https://game.example.org";
    habitica = { creatorId = "example-creator"; appName = "example-game"; };
    partyAdmission = false;
    cookieSecure = false;
    trustedProxies = [ ];
    login = { concurrency = 2; rate = 5; globalRate = 20; };
    sprite = { assetsUrl = "https://assets.example.org/sprites/"; cacheDirectory = "/srv/game/cache"; };
    backups.enable = false;
    extraEnvironment.GLIMWAY_HABITICA_URL = "https://habitica.example.org";
    extraFlags = [ "-listen" "[::1]:9091" ];
    reverseProxy.enable = true;
    openFirewall = true;
  };
  scheduled = evaluate {
    enable = true;
    listenAddress = "0.0.0.0";
    port = 9000;
    openFirewall = true;
    backups = {
      directory = "/srv/game/backups";
      schedule = "weekly";
      retentionDays = 7;
      randomizedDelaySec = "1m";
    };
  };
  # Dev mode: the staging instance may, with its dev builds; the live one never.
  devOwner = "0f9d6d9e-7c55-4b8e-9d3a-2a1c3b4d5e6f";
  devOn = evaluateBoth {
    glimway = liveSettings;
    glimway-dev = devSettings // { settings = { dev = { enable = true; accounts = [ devOwner ]; }; server.dev.clock = false; }; };
  };
  liveDevMode = evaluate (liveSettings // { settings.dev.enable = true; });
  # Its own package swapped for a dev build still doesn't let it.
  liveDevPackages = evaluate (liveSettings // {
    settings.dev.enable = true;
    package = pkgs.callPackage ./server.nix { devTools = true; };
    webPackage = pkgs.callPackage ./web.nix { devTools = true; };
  });
  # Dev mode with release builds: refused.
  devReleasePackages = evaluateBoth { glimway-dev = devSettings // {
    settings.dev.enable = true;
    package = pkgs.callPackage ./server.nix { };
  }; };
  # With settings.dev.enable off, dev builds or dev variables and flags still
  # don't get past the live instance (review: they granted the tools).
  devServer = pkgs.callPackage ./server.nix { devTools = true; };
  devWeb = pkgs.callPackage ./web.nix { devTools = true; };
  liveSneaks = map (extra: evaluate (liveSettings // extra)) [
    { package = devServer; webPackage = devWeb; extraEnvironment.GLIMWAY_DEV_ENABLE = "true"; }
    { package = devServer; }
    { webPackage = devWeb; }
    { extraEnvironment.GLIMWAY_DEV_ENABLE = "true"; }
    { extraEnvironment.FINGERSNAP_SERVER_DEV_GRANT = "true"; }
    { extraEnvironment.GLIMWAY_WEB_DEV_HOOKS = "true"; }
    { extraFlags = [ "-dev-clock=now" ]; }
    { extraFlags = [ "--dev-clock" "now" ]; }
  ];
  # Staging may have them; settings override the login options.
  devExtras = evaluateBoth { glimway-dev = devSettings // {
    package = devServer;
    extraEnvironment.GLIMWAY_DEV_ENABLE = "true";
    extraFlags = [ "-dev-clock=now" ];
  }; };
  loginBoth = evaluate (liveSettings // { login.rate = 5; settings.server.login.rate = 2; });
  disabled = evaluate { };
  invalidRootDB = evaluate { enable = true; database = "/game.sqlite"; };
  invalidState = evaluate { enable = true; stateDirectory = "../game"; };
  env = cfg: cfg.systemd.services.glimway-server.environment;
  service = cfg: cfg.systemd.services.glimway-server.serviceConfig;
  assertionsPass = cfg: lib.all (a: a.assertion) cfg.assertions;
  configs = [ defaults legacy custom scheduled disabled live dev both proxied devOn ];
  isDev = p: p.passthru.devTools or false;
  devOnCfg = devOn.services.glimway-dev;
  devOnService = devOn.systemd.services.glimway-dev-server;
  # What an enabled instance adds to a host with none: its units, accounts,
  # tmpfiles paths, commands on PATH and Caddy sites. Sorted for comparing.
  sorted = lib.sort lib.lessThan;
  added = names: cfg: sorted (lib.subtractLists (names disabled) (names cfg));
  tmpfilesPath = rule: lib.elemAt (lib.filter (x: x != "") (lib.splitString " " rule)) 1;
  owned = cfg: {
    units = added (c: lib.attrNames c.systemd.units) cfg;
    users = added (c: lib.attrNames c.users.users) cfg;
    groups = added (c: lib.attrNames c.users.groups) cfg;
    tmpfiles = added (c: map tmpfilesPath c.systemd.tmpfiles.rules) cfg;
    commands = added (c: map (p: p.meta.mainProgram or (lib.getName p)) c.environment.systemPackages) cfg;
    sites = added (c: lib.attrNames c.services.caddy.virtualHosts) cfg;
  };
  kinds = lib.attrNames (owned live);
  shareNothing = lib.all (k: lib.intersectLists (owned live).${k} (owned dev).${k} == [ ]) kinds;
  # Together they own exactly what each owns alone, with the same unit text.
  addUp = lib.all (k: (owned both).${k} == sorted ((owned live).${k} ++ (owned dev).${k})) kinds;
  sameUnits = alone: lib.all (u: both.systemd.units.${u}.text == alone.systemd.units.${u}.text) (owned alone).units;
  devEnv = dev.systemd.services.glimway-dev-server.environment;
  devService = dev.systemd.services.glimway-dev-server.serviceConfig;
  backupScript = (scheduled.systemd.services.glimway-server-backup.serviceConfig.ExecStart).text;
  # Line order: back up, verify (keeping a failure out of retention), then prune.
  before = a: b: lib.length (lib.splitString a backupScript) == 2
    && lib.hasInfix b (lib.elemAt (lib.splitString a backupScript) 1);
in
assert lib.all assertionsPass configs;
assert !(assertionsPass invalidRootDB);
assert !(assertionsPass invalidState);
# The live instance can't be configured into dev mode, even with dev builds.
assert !(assertionsPass liveDevMode) && !(assertionsPass liveDevPackages);
assert lib.all (c: !(assertionsPass c)) liveSneaks;
assert assertionsPass devExtras;
# The login options are the settings' defaults, never flags (a flag would pin them).
assert loginBoth.services.glimway.settings.server.login == { concurrency = 4; rate = 2; global_rate = 60; };
assert !(lib.hasInfix "-login" (service live).ExecStart);
assert (service live).ExecStart == ''"${lib.getExe live.services.glimway.package}"'';
assert !(assertionsPass devReleasePackages);
# Dev mode off: release builds, on every instance (staging runs release code).
assert !(isDev live.services.glimway.package) && !(isDev live.services.glimway.webPackage);
assert !(isDev dev.services.glimway-dev.package) && !(isDev dev.services.glimway-dev.webPackage);
assert !(isDev devOn.services.glimway.package) && !(isDev devOn.services.glimway.webPackage);
# Dev mode on: the dev builds, its settings in the file, reload on a change.
assert isDev devOnCfg.package && isDev devOnCfg.webPackage;
assert devOnService.environment.GLIMWAY_CONFIG == "/etc/glimway-dev/config.toml";
assert (env live).GLIMWAY_CONFIG == "/etc/glimway/config.toml";
assert lib.hasInfix "kill -HUP $MAINPID" devOnService.serviceConfig.ExecReload;
assert devOnService.reloadTriggers != [ ];
assert lib.hasInfix "X-Reload-Triggers" devOn.systemd.units."glimway-dev-server.service".text;
assert devOnCfg.settings == { dev = { enable = true; accounts = [ devOwner ]; }; server = { dev.clock = false; login = { concurrency = 4; rate = 10; global_rate = 60; }; }; };
assert lib.hasSuffix "glimway-dev-settings.toml" devOn.environment.etc."glimway-dev/config.toml".source.name;
assert live.services.glimway.settings == { dev = { enable = false; accounts = [ ]; }; server.login = { concurrency = 4; rate = 10; global_rate = 60; }; };
assert live.systemd.services.glimway-server.restartTriggers != [ ];
assert (env defaults).GLIMWAY_DB == "/var/lib/glimway-server/glimway.sqlite";
assert (env defaults).GLIMWAY_HABITICA_ASSETS_URL == "https://habitica-assets.s3.amazonaws.com/mobileApp/images/";
assert (service defaults).ProtectSystem == "strict";
assert (service defaults).StateDirectory == "glimway-server";
assert (env legacy).GLIMWAY_DB == "/var/lib/legacy-game/game.sqlite";
assert (env legacy).GLIMWAY_SPRITE_CACHE == "/var/lib/legacy-game/habitica-sprites";
assert (service legacy).StateDirectory == "legacy-game";
assert lib.hasInfix "/srv/glimway/dist" legacy.systemd.services.glimway.serviceConfig.ExecStart;
assert (env custom).GLIMWAY_LISTEN == "[::1]:9090";
assert (env custom).GLIMWAY_X_CLIENT == "example-creator-example-game";
assert (env custom).GLIMWAY_PARTY_ADMISSION == "false";
assert (env custom).GLIMWAY_TRUSTED_PROXIES == "";
assert (env custom).GLIMWAY_HABITICA_URL == "https://habitica.example.org";
assert (service custom).User == "game" && (service custom).Group == "games";
assert custom.services.glimway.settings.server.login == { concurrency = 2; rate = 5; global_rate = 20; };
assert lib.hasInfix ''"-listen" "[::1]:9091"'' (service custom).ExecStart;
assert !(custom.systemd.timers ? glimway-server-backup);
assert !(custom.systemd.services ? glimway-server-backup);
assert custom.services.caddy.enable;
assert lib.hasInfix "handle /api/*" custom.services.caddy.virtualHosts."https://game.example.org".extraConfig;
assert lib.hasInfix "handle /ws" custom.services.caddy.virtualHosts."https://game.example.org".extraConfig;
assert lib.elem 443 custom.networking.firewall.allowedTCPPorts;
assert lib.elem 80 custom.networking.firewall.allowedTCPPorts;
assert !(lib.elem 9090 custom.networking.firewall.allowedTCPPorts);
assert lib.elem 9000 scheduled.networking.firewall.allowedTCPPorts;
assert scheduled.systemd.timers.glimway-server-backup.timerConfig.OnCalendar == "weekly";
assert lib.elem "/srv/game/backups" scheduled.systemd.services.glimway-server-backup.serviceConfig.ReadWritePaths;
assert lib.hasPrefix "#!" backupScript && lib.hasInfix "set -eu" backupScript;
assert before " backup \"$snapshot\"" "verify-backup \"$snapshot\"";
assert before "verify-backup \"$snapshot\"" "\"$snapshot.unverified\"";
assert before "\"$snapshot.unverified\"" "exit 1";
assert before "exit 1" "-mtime +7 -delete";
assert !(disabled.systemd.services ? glimway-server);
assert !(disabled.systemd.services ? glimway);
assert shareNothing && addUp && sameUnits live && sameUnits dev;
assert (owned live).units == [ "glimway-server-backup.service" "glimway-server-backup.timer" "glimway-server.service" "glimway.service" ];
assert (owned dev).units == [ "glimway-dev-server-backup.service" "glimway-dev-server-backup.timer" "glimway-dev-server.service" "glimway-dev.service" ];
assert (owned dev).users == [ "glimway-dev-server" ] && (owned dev).groups == [ "glimway-dev-server" ];
assert (owned live).commands == [ "glimway-server" ] && (owned dev).commands == [ "glimway-dev-server" ];
assert lib.all (lib.hasPrefix "/var/lib/glimway-dev-server") (owned dev).tmpfiles;
assert (env live).GLIMWAY_LISTEN == "127.0.0.1:8090" && devEnv.GLIMWAY_LISTEN == "127.0.0.1:8091";
assert devEnv.GLIMWAY_DB == "/var/lib/glimway-dev-server/glimway.sqlite";
assert devEnv.GLIMWAY_SPRITE_CACHE == "/var/lib/glimway-dev-server/habitica-sprites";
assert devService.StateDirectory == "glimway-dev-server" && devService.User == "glimway-dev-server";
assert lib.hasInfix "glimway-dev-backup" dev.systemd.services.glimway-dev-server-backup.serviceConfig.ExecStart;
assert lib.hasInfix ''"127.0.0.1:4174"'' dev.systemd.services.glimway-dev.serviceConfig.ExecStart;
assert lib.attrNames proxied.services.caddy.virtualHosts == [ "https://fsnap.example.org" "https://glim-dev.example.org" ];
assert lib.hasInfix "reverse_proxy 127.0.0.1:8091" proxied.services.caddy.virtualHosts."https://glim-dev.example.org".extraConfig;
assert lib.hasInfix "reverse_proxy 127.0.0.1:4174" proxied.services.caddy.virtualHosts."https://glim-dev.example.org".extraConfig;
assert lib.hasInfix "reverse_proxy 127.0.0.1:8090" proxied.services.caddy.virtualHosts."https://fsnap.example.org".extraConfig;
pkgs.runCommand "glimway-nixos-module-evaluation" {
  # Force systemd unit generation as well as module options (no Linux build).
  report = builtins.unsafeDiscardStringContext (builtins.toJSON {
    defaultUnit = defaults.systemd.units."glimway-server.service".text;
    legacyUnit = legacy.systemd.units."glimway-server.service".text;
    customUnit = custom.systemd.units."glimway-server.service".text;
    backupUnit = scheduled.systemd.units."glimway-server-backup.service".text;
    backupTimer = scheduled.systemd.units."glimway-server-backup.timer".text;
    webUnit = defaults.systemd.units."glimway.service".text;
    devUnit = both.systemd.units."glimway-dev-server.service".text;
    devWebUnit = both.systemd.units."glimway-dev.service".text;
    devBackupUnit = both.systemd.units."glimway-dev-server-backup.service".text;
    devModeUnit = devOn.systemd.units."glimway-dev-server.service".text;
  });
  passAsFile = [ "report" ];
  # On an x86_64-linux builder, also build both rendered settings files: each
  # build runs its own server's check-config (the dev file through the dev
  # build, the live one through the release build).
  settingsFiles = lib.optionals (pkgs.stdenv.buildPlatform.system == "x86_64-linux") [
    devOn.environment.etc."glimway-dev/config.toml".source
    devOn.environment.etc."glimway/config.toml".source
  ];
} ''
  mkdir -p "$out"
  cp "$reportPath" "$out/module-evaluation.json"
  for f in $settingsFiles; do cat "$f" >> "$out/settings.toml"; done
''
