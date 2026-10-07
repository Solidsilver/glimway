{ lib, buildNpmPackage, nodejs_24
, habiticaCreatorId ? "5abfd539-22eb-457f-8e2a-9fb3d66731f1"
, habiticaAppName ? "glimway"
}:
buildNpmPackage {
  pname = "glimway-web";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json ../package-lock.json ../index.html
      ../vite.config.ts ../svelte.config.js ../tsconfig.json
      ../src ../public ../content
    ];
  };
  nodejs = nodejs_24;
  npmDepsHash = "sha256-kPQlObS9Ave0e8X4dNgzmRkqpaGKX/srULozjO+IFnU=";
  npmFlags = [ "--no-audit" "--no-fund" ];
  # Never download Playwright browsers or regenerate committed atlases.
  env = {
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    VITE_HABITICA_CREATOR_ID = habiticaCreatorId;
    VITE_HABITICA_APP_NAME = habiticaAppName;
  };
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
