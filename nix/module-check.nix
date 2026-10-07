# Evaluate Linux configurations on any supported build host, including Darwin.
{ pkgs, nixpkgs }:
let
  inherit (nixpkgs) lib;
  evaluate = settings: (lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      ../deploy/nixos/glimway.nix
      {
        system.stateVersion = "26.05";
        boot.loader.grub.enable = false;
        fileSystems."/" = { device = "/dev/disk/by-label/root"; fsType = "ext4"; };
        services.glimway = settings;
      }
    ];
  }).config;
  defaults = evaluate { enable = true; };
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
  disabled = evaluate { };
  invalidRootDB = evaluate { enable = true; database = "/game.sqlite"; };
  invalidState = evaluate { enable = true; stateDirectory = "../game"; };
  env = cfg: cfg.systemd.services.glimway-server.environment;
  service = cfg: cfg.systemd.services.glimway-server.serviceConfig;
  assertionsPass = cfg: lib.all (a: a.assertion) cfg.assertions;
  configs = [ defaults legacy custom scheduled disabled ];
in
assert lib.all assertionsPass configs;
assert !(assertionsPass invalidRootDB);
assert !(assertionsPass invalidState);
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
assert lib.hasInfix ''"-login-concurrency" "2"'' (service custom).ExecStart;
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
assert !(disabled.systemd.services ? glimway-server);
assert !(disabled.systemd.services ? glimway);
pkgs.runCommand "glimway-nixos-module-evaluation" {
  # Force systemd unit generation as well as module options (no Linux build).
  report = builtins.unsafeDiscardStringContext (builtins.toJSON {
    defaultUnit = defaults.systemd.units."glimway-server.service".text;
    legacyUnit = legacy.systemd.units."glimway-server.service".text;
    customUnit = custom.systemd.units."glimway-server.service".text;
    backupUnit = scheduled.systemd.units."glimway-server-backup.service".text;
    backupTimer = scheduled.systemd.units."glimway-server-backup.timer".text;
    webUnit = defaults.systemd.units."glimway.service".text;
  });
  passAsFile = [ "report" ];
} ''
  mkdir -p "$out"
  cp "$reportPath" "$out/module-evaluation.json"
''
