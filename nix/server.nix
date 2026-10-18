{ lib, buildGoModule
# The build id for /api/health (the flake passes its clean short revision).
, build ? null
# The dev build (go build -tags dev): dev mode's routes and clock, for a
# staging instance with settings.dev.enable. Never the live server's.
, devTools ? false
}:
buildGoModule rec {
  pname = "glimway-server${lib.optionalString devTools "-dev"}";
  version = (lib.importJSON ../package.json).version;
  src = lib.fileset.toSource {
    root = ../.;
    # gen/ is the generated content messages (gen/glimway/content/v1),
    # which content/*.go import.
    fileset = lib.fileset.unions [ ../go.mod ../go.sum ../server ../content ../gen ../.gitignore ../nix/server.nix ];
  };
  vendorHash = "sha256-qJ4zFM2N0p6eGAchjImPkqkY+00if/eihHEppLYrA3c=";
  subPackages = [ "server/cmd/glimway-server" ];
  tags = lib.optional devTools "dev";
  env.CGO_ENABLED = 0;
  ldflags = [ "-s" "-w" "-X main.version=${version}" ] ++ lib.optional (build != null) "-X main.build=${build}";
  passthru = { inherit devTools; };
  meta = {
    description = "Glimway Go game server and administration CLI${lib.optionalString devTools " (dev build: dev mode's tools)"}";
    license = lib.licenses.agpl3Plus;
    mainProgram = "glimway-server";
    platforms = lib.platforms.unix;
  };
}
