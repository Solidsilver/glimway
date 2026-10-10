{ lib, buildNpmPackage, nodejs_24
, habiticaCreatorId ? "5abfd539-22eb-457f-8e2a-9fb3d66731f1"
, habiticaAppName ? "glimway"
# The build id (the flake passes its clean short revision). Null: a hash of
# the sources (scripts/build-version.mjs), as the sandbox has no .git.
, build ? null
}:
buildNpmPackage {
  pname = "glimway-web";
  version = (lib.importJSON ../package.json).version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json ../package-lock.json ../index.html
      ../vite.config.ts ../svelte.config.js ../tsconfig.json ../CHANGELOG.md
      ../scripts/build-version.mjs ../scripts/whats-new.mjs ../src ../public ../content
      # The stable's layout reads the crafts pass's manifest (src/lib/stable-layout.ts).
      ../assets/generated/crafts-pass/manifest.json
    ];
  };
  nodejs = nodejs_24;
  npmDepsHash = "sha256-atEeF44R39P4T6PNypCeNbQNFnSgbsCp9c9uFPuBodQ=";
  npmFlags = [ "--no-audit" "--no-fund" ];
  # Never download Playwright browsers or regenerate committed atlases.
  env = {
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    VITE_HABITICA_CREATOR_ID = habiticaCreatorId;
    VITE_HABITICA_APP_NAME = habiticaAppName;
  } // lib.optionalAttrs (build != null) { GLIMWAY_BUILD = build; };
  preBuild = ''
    if grep -rl '^version https://git-lfs.github.com/spec/v1$' public; then
      echo "Runtime art contains Git LFS pointers; fetch the real objects before building." >&2
      exit 1
    fi
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r dist/. "$out/"
    runHook postInstall
  '';
  meta = {
    description = "Glimway static web app (including committed runtime art)";
    license = lib.licenses.agpl3Plus;
    platforms = lib.platforms.unix;
  };
}
