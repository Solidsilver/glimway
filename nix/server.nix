{ lib, buildGoModule
# The build id for /api/health (the flake passes its clean short revision).
, build ? null
}:
buildGoModule rec {
  pname = "glimway-server";
  version = (lib.importJSON ../package.json).version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [ ../go.mod ../go.sum ../server ../content ../.gitignore ../nix/server.nix ];
  };
  vendorHash = "sha256-6q2leQnJ7FfPu9yqLeqFzdZKbsPKrsY12GkoBzjf4zg=";
  subPackages = [ "server/cmd/glimway-server" ];
  env.CGO_ENABLED = 0;
  ldflags = [ "-s" "-w" "-X main.version=${version}" ] ++ lib.optional (build != null) "-X main.build=${build}";
  meta = {
    description = "Glimway Go game server and administration CLI";
    license = lib.licenses.agpl3Plus;
    mainProgram = "glimway-server";
    platforms = lib.platforms.unix;
  };
}
