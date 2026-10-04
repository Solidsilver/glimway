{ pkgs, ... }:
{
  # The app is built in ~/code/fingersnap; only this localhost listener is proxied.
  systemd.services.fingersnap = {
    description = "Fingersnap static web app";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];

    serviceConfig = {
      ExecStart = "${pkgs.caddy}/bin/caddy file-server --root /home/deploy-user/code/fingersnap/dist --listen 127.0.0.1:4173";
      WorkingDirectory = "/home/deploy-user/code/fingersnap/dist";
      User = "deploy-user";
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
