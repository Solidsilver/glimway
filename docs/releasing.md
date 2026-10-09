# Releasing

Glimway uses [semantic versions](https://semver.org/), 0.x for now, and git
tags `vX.Y.Z`. `package.json`'s `version` is the one source: the web build,
both Nix packages and the Docker image all read it. A release is a commit
that moves the changelog and bumps that version, tagged.

1. **Changelog.** In `CHANGELOG.md`, rename `## [Unreleased]` to
   `## [X.Y.Z] - YYYY-MM-DD` and start a fresh, empty `## [Unreleased]` above
   it. Keep both parts, `### For players` first, then `### Technical`; the
   game reads the player lines for "What's new" (src/lib/changelog.ts), so
   write them as plain sentences: links and code marks show as plain words.
   Update the compare links at the bottom.
2. **Version.** Bump `package.json` (and `package-lock.json` with it):

   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```

   The version is part of the Nix web package's npm dependency hash, so update
   `npmDepsHash` in `nix/web.nix` with every bump. The quick way, without
   building: `nix run nixpkgs#prefetch-npm-deps -- package-lock.json`.

3. **Check.** `npm run verify`, `go test ./...`, and the playtests that matter
   (`npm run test:smoke` at least).
4. **Commit and merge** to `main`:

   ```sh
   git commit -am "Release X.Y.Z"
   git push origin HEAD:main
   ```

5. **Tag and publish (automatic).** When CI passes on `main`,
   `.github/workflows/tag-release.yml` reads `package.json`'s version and, if
   there's no `vX.Y.Z` tag yet, tags that commit and calls
   `.github/workflows/release.yml`, which builds and pushes
   `ghcr.io/solidsilver/glimway` (`X.Y.Z`, `X.Y`, `latest`, `sha-<commit>`)
   with the commit as the build id. A failed CI run tags nothing: rerun it or fix forward
   and push again. A tag pushed by hand still publishes too (the release
   workflow runs on `v*` tags and stops if the tag isn't `v` + `package.json`'s
   version).
6. **Deploy** as in [home-server.md](home-server.md). Open tabs notice the new
   build (they check `/version.json`) and offer to reload; `GET /api/health`
   names the server's version and build.

Never move or reuse a published tag: fix forward with the next patch version.

## Pre-releases

Milestones on the way to a release are tagged `vX.Y.Z-alpha.N`, so a problem can
be traced to the step that brought it. Bump `package.json` to the same version
(`npm version X.Y.Z-alpha.N --no-git-tag-version`), commit, and tag the commit on
the branch where it was built (usually `expansion` or the release's integration
branch); `main` stays on the last release. The release workflow publishes the
image as `X.Y.Z-alpha.N` and `sha-<commit>` only: never `X.Y` or `latest`. The
changelog keeps collecting under `## [Unreleased]` until the real release.
