{ config, lib, pkgs, ... }:
let
  cfg = config.services.glimway;
in
{
  # The static web app, served on a localhost listener that Caddy proxies.
  # Importing this file turns it on. The defaults are the main instance's:
  # the checkout kept its pre-rename directory name.
  options.services.glimway = {
    root = lib.mkOption { type = lib.types.str; default = "/home/deploy-user/code/fingersnap/dist"; description = "The built site (`npm run build` output)."; };
    user = lib.mkOption { type = lib.types.str; default = "deploy-user"; description = "User that owns the checkout and runs the file server."; };
    listen = lib.mkOption { type = lib.types.str; default = "127.0.0.1:4173"; description = "Local listener for Caddy."; };
  };
  config.systemd.services.glimway = {
    description = "Glimway static web app";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];

    serviceConfig = {
      ExecStart = "${pkgs.caddy}/bin/caddy file-server --root ${lib.escapeShellArg cfg.root} --listen ${cfg.listen}";
      WorkingDirectory = cfg.root;
      User = cfg.user;
      Group = "users";
      Restart = "on-failure";
      RestartSec = "5s";
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = "read-only";
      PrivateTmp = true;
    };
  };
}
