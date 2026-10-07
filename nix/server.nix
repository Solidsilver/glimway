{ lib, buildGoModule }:
buildGoModule {
  pname = "glimway-server";
  version = "0.2.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [ ../go.mod ../go.sum ../server ../content ../.gitignore ../nix/server.nix ];
  };
  vendorHash = "sha256-HM3XBw07fNMpbkPCPYFs9Rww/4OSnfiQds0L22ojqig=";
  subPackages = [ "server/cmd/glimway-server" ];
  env.CGO_ENABLED = 0;
  meta = {
    description = "Glimway Go game server and administration CLI";
    license = lib.licenses.agpl3Plus;
    mainProgram = "glimway-server";
    platforms = lib.platforms.unix;
  };
}
