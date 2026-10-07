# Releasing

Glimway uses [semantic versions](https://semver.org/), 0.x for now, and git
tags `vX.Y.Z`. `package.json`'s `version` is the one source: the web build,
both Nix packages and the Docker image all read it. A release is a commit
that moves the changelog and bumps that version, tagged.

1. **Changelog.** In `CHANGELOG.md`, rename `## [Unreleased]` to
   `## [X.Y.Z] - YYYY-MM-DD` and start a fresh, empty `## [Unreleased]` above
   it. Keep both parts, `### For players` first, then `### Technical`; the
   game reads the player lines for "What's new". Update the compare links at
   the bottom.
2. **Version.** Bump `package.json` (and `package-lock.json` with it):

   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```

3. **Check.** `npm run verify`, `go test ./...`, and the playtests that matter
   (`npm run test:smoke` at least).
4. **Commit and tag** on `main`:

   ```sh
   git commit -am "Release X.Y.Z"
   git tag -a vX.Y.Z -m "Glimway X.Y.Z"
   git push origin main vX.Y.Z
   ```

5. **Publish.** The tag starts `.github/workflows/release.yml`, which stops if
   the tag isn't `v` + `package.json`'s version, then builds and pushes
   `ghcr.io/solidsilver/glimway` (`X.Y.Z`, `X.Y`, `latest`, `sha-<commit>`)
   with the commit as the build id.
6. **Deploy** as in [home-server.md](home-server.md). Open tabs notice the new
   build (they check `/version.json`) and offer to reload; `GET /api/health`
   names the server's version and build.

Never move or reuse a published tag: fix forward with the next patch version.
