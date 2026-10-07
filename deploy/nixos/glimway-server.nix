{ config, lib, pkgs, ... }:
let
  cfg = config.services.glimway-server;
  stateDir = "/var/lib/${cfg.stateDirectory}";
  serverPackage = pkgs.buildGoModule {
    pname = "glimway-server";
    version = "0.2.0";
    # The module and embedded canonical content must share the repository root.
    src = lib.cleanSourceWith {
      src = ../..;
      filter = path: type: lib.cleanSourceFilter path type
        && !(builtins.elem (builtins.baseNameOf path) [ "node_modules" "dist" ".data" ".agent" ]);
    };
    vendorHash = "sha256-6q2leQnJ7FfPu9yqLeqFzdZKbsPKrsY12GkoBzjf4zg=";
    subPackages = [ "server/cmd/glimway-server" ];
    env.CGO_ENABLED = 0;
  };
  backup = pkgs.writeShellScript "glimway-backup" ''
    set -eu
    backup_dir=${lib.escapeShellArg "${stateDir}/backups"}
    ${pkgs.coreutils}/bin/mkdir -p "$backup_dir"
    ${cfg.package}/bin/glimway-server -db ${lib.escapeShellArg cfg.database} backup "$backup_dir/$(${pkgs.coreutils}/bin/date -u +%Y-%m-%dT%H-%M-%S).sqlite"
    ${pkgs.findutils}/bin/find "$backup_dir" -type f -name '*.sqlite' -mtime +${toString cfg.backupRetentionDays} -delete
  '';
in
{
  options.services.glimway-server = {
    enable = lib.mkEnableOption "Glimway Go backend";
    package = lib.mkOption { type = lib.types.package; default = serverPackage; description = "Backend binary package (requires Go 1.26 or later to build)."; };
    listen = lib.mkOption { type = lib.types.str; default = "127.0.0.1:8090"; description = "Local HTTP listener for Caddy."; };
    # A server set up before the rename keeps its data by setting this to
    # "fingersnap-server" (and database to the old path).
    stateDirectory = lib.mkOption { type = lib.types.str; default = "glimway-server"; description = "State directory under /var/lib (systemd StateDirectory); holds the database and nightly backups."; };
    database = lib.mkOption { type = lib.types.str; default = "${stateDir}/glimway.sqlite"; defaultText = lib.literalExpression ''"/var/lib/''${stateDirectory}/glimway.sqlite"''; description = "SQLite path; custom paths must be writable by the service."; };
    habiticaUrl = lib.mkOption { type = lib.types.str; default = "https://habitica.com"; description = "Habitica read-only API base URL."; };
    xClient = lib.mkOption { type = lib.types.str; default = "5abfd539-22eb-457f-8e2a-9fb3d66731f1-glimway"; description = "Habitica creator-id-appname header."; };
    trustedProxies = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ "127.0.0.1" "::1" ]; description = "Proxy IPs permitted to supply the last X-Forwarded-For hop; empty trusts none."; };
    partyAdmission = lib.mkOption { type = lib.types.bool; default = true; description = "Let members of a Habitica party with a world here sign in without a code, and make party worlds (-party-admission)."; };
    backupRetentionDays = lib.mkOption { type = lib.types.ints.positive; default = 30; description = "Nightly backup retention in days."; };
  };
  config = lib.mkIf cfg.enable {
    users.groups.glimway-server = { };
    users.users.glimway-server = { isSystemUser = true; group = "glimway-server"; };
    # Puts the admin CLI (allowlist, invite, backup) on PATH.
    environment.systemPackages = [ cfg.package ];
    systemd.services.glimway-server = {
      description = "Glimway Go backend";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        GLIMWAY_LISTEN = cfg.listen;
        GLIMWAY_DB = cfg.database;
        GLIMWAY_HABITICA_URL = cfg.habiticaUrl;
        GLIMWAY_X_CLIENT = cfg.xClient;
        GLIMWAY_COOKIE_SECURE = "true";
        GLIMWAY_TRUSTED_PROXIES = lib.concatStringsSep "," cfg.trustedProxies;
        GLIMWAY_PARTY_ADMISSION = lib.boolToString cfg.partyAdmission;
      };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/glimway-server";
        User = "glimway-server";
        Group = "glimway-server";
        # systemd re-owns an existing state directory to this user on start.
        StateDirectory = cfg.stateDirectory;
        StateDirectoryMode = "0700";
        WorkingDirectory = stateDir;
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = "5s";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ (builtins.dirOf cfg.database) ];
        ProtectHome = true;
        PrivateTmp = true;
      };
    };
    systemd.services.glimway-server-backup = {
      description = "Glimway consistent SQLite backup";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = backup;
        User = "glimway-server";
        Group = "glimway-server";
        StateDirectory = cfg.stateDirectory;
        StateDirectoryMode = "0700";
        UMask = "0077";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ (builtins.dirOf cfg.database) ];
        ProtectHome = true;
        PrivateTmp = true;
      };
    };
    systemd.timers.glimway-server-backup = {
      description = "Nightly Glimway backup";
      wantedBy = [ "timers.target" ];
      timerConfig = { OnCalendar = "*-*-* 03:15:00"; Persistent = true; RandomizedDelaySec = "10m"; };
    };
  };
}
