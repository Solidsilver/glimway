{ config, lib, pkgs, ... }:
let
  cfg = config.services.fingersnap-server;
  serverPackage = pkgs.buildGoModule {
    pname = "fingersnap-server";
    version = "0.2.0";
    # The module and embedded canonical content must share the repository root.
    src = lib.cleanSourceWith {
      src = ../..;
      filter = path: type: lib.cleanSourceFilter path type
        && !(builtins.elem (builtins.baseNameOf path) [ "node_modules" "dist" ".data" ".agent" ]);
    };
    vendorHash = "sha256-7IC/p5GlD2EZkDXQzkaZ7E19S/ABKEBsg68vt8pykis=";
    subPackages = [ "server/cmd/fingersnap-server" ];
    env.CGO_ENABLED = 0;
  };
  backup = pkgs.writeShellScript "fingersnap-backup" ''
    set -eu
    backup_dir=/var/lib/fingersnap-server/backups
    ${pkgs.coreutils}/bin/mkdir -p "$backup_dir"
    ${cfg.package}/bin/fingersnap-server -db ${lib.escapeShellArg cfg.database} backup "$backup_dir/$(${pkgs.coreutils}/bin/date -u +%Y-%m-%dT%H-%M-%S).sqlite"
    ${pkgs.findutils}/bin/find "$backup_dir" -type f -name '*.sqlite' -mtime +${toString cfg.backupRetentionDays} -delete
  '';
in
{
  options.services.fingersnap-server = {
    enable = lib.mkEnableOption "Fingersnap Go backend";
    package = lib.mkOption { type = lib.types.package; default = serverPackage; description = "Backend binary package (requires Go 1.26 or later to build)."; };
    listen = lib.mkOption { type = lib.types.str; default = "127.0.0.1:8090"; description = "Local HTTP listener for Caddy."; };
    database = lib.mkOption { type = lib.types.str; default = "/var/lib/fingersnap-server/fingersnap.sqlite"; description = "SQLite path; custom paths must be writable by the service."; };
    habiticaUrl = lib.mkOption { type = lib.types.str; default = "https://habitica.com"; description = "Habitica read-only API base URL."; };
    xClient = lib.mkOption { type = lib.types.str; default = "5abfd539-22eb-457f-8e2a-9fb3d66731f1-fingersnap"; description = "Habitica creator-id-appname header."; };
    trustedProxies = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ "127.0.0.1" "::1" ]; description = "Proxy IPs permitted to supply the last X-Forwarded-For hop; empty trusts none."; };
    backupRetentionDays = lib.mkOption { type = lib.types.ints.positive; default = 30; description = "Nightly backup retention in days."; };
  };
  config = lib.mkIf cfg.enable {
    users.groups.fingersnap-server = { };
    users.users.fingersnap-server = { isSystemUser = true; group = "fingersnap-server"; };
    systemd.services.fingersnap-server = {
      description = "Fingersnap Go backend";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        FINGERSNAP_LISTEN = cfg.listen;
        FINGERSNAP_DB = cfg.database;
        FINGERSNAP_HABITICA_URL = cfg.habiticaUrl;
        FINGERSNAP_X_CLIENT = cfg.xClient;
        FINGERSNAP_COOKIE_SECURE = "true";
        FINGERSNAP_TRUSTED_PROXIES = lib.concatStringsSep "," cfg.trustedProxies;
      };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/fingersnap-server";
        User = "fingersnap-server";
        Group = "fingersnap-server";
        StateDirectory = "fingersnap-server";
        StateDirectoryMode = "0700";
        WorkingDirectory = "/var/lib/fingersnap-server";
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
    systemd.services.fingersnap-server-backup = {
      description = "Fingersnap consistent SQLite backup";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = backup;
        User = "fingersnap-server";
        Group = "fingersnap-server";
        StateDirectory = "fingersnap-server";
        StateDirectoryMode = "0700";
        UMask = "0077";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ (builtins.dirOf cfg.database) ];
        ProtectHome = true;
        PrivateTmp = true;
      };
    };
    systemd.timers.fingersnap-server-backup = {
      description = "Nightly Fingersnap backup";
      wantedBy = [ "timers.target" ];
      timerConfig = { OnCalendar = "*-*-* 03:15:00"; Persistent = true; RandomizedDelaySec = "10m"; };
    };
  };
}
