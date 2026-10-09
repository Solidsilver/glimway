{ lib, buildGoModule
# The build id for /api/health (the flake passes its clean short revision).
, build ? null
}:
buildGoModule rec {
  pname = "glimway-server";
  version = (lib.importJSON ../package.json).version;
  src = lib.fileset.toSource {
    root = ../.;
    # gen/ is the generated content messages (gen/glimway/content/v1),
    # which content/*.go import.
    fileset = lib.fileset.unions [ ../go.mod ../go.sum ../server ../content ../gen ../.gitignore ../nix/server.nix ];
  };
  vendorHash = "sha256-uPQdvFvVWiXucm2BFmlbvR52G07y4254AF0wNeiOaEc=";
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
