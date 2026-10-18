# Releasing

Glimway uses [semantic versions](https://semver.org/), 0.x for now, and git
tags `vX.Y.Z`. `package.json`'s `version` is the one source: the web build,
both Nix packages and the Docker image all read it. A release is a commit
that moves the changelog and bumps that version, tagged.

## Branches

- `main`: releases only. Every commit on it is a released version.
- `dev`: the next release, playable. Each release's work comes together on an
  integration branch (`exp/<feature>`, with one worktree per lane; see [agent-workflow.md](agent-workflow.md)), and once it
  passes CI it merges into `dev`. The playtest runs on `dev`, in the main
  checkout. Fixes found there go out to worktrees again and merge back into
  `dev`. When the playtest passes, the release commit (below) goes on `dev`, and
  `main` fast-forwards to it once its CI is green.

## Cutting a release

The orchestrator does steps 1–5; the owner copies the backup in step 5 and
does the deploy. Nobody touches the live database or service before the
deploy.

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

3. **Check locally.** `npm run verify` and `go test ./...`, inside
   `nix develop`. Don't run the playtests on the host: CI runs them in the
   next step.
4. **Commit on `dev` and wait for CI green on the release commit.** A push to
   `dev` runs the full E2E suite on the self-hosted GPU runner
   ([testing.md](testing.md)). Watch it in the foreground:

   ```sh
   git commit -am "Release X.Y.Z"
   git push origin dev
   gh run watch <run id> --exit-status
   ```

   The bar is two full dev runs in a row with no hard failures and at most
   two flaky tests (decision 61 in
   [decisions-overnight.md](decisions-overnight.md)); the release commit's own
   run must be one of them or come after them. A red run is fixed forward on
   `dev`, never by moving `main`.
5. **Rehearse the upgrade** on the release commit, against a copy of the live
   database. The owner copies the newest *verified* live backup (from
   `/var/lib/glimway-server/backups/`, only the `.sqlite` file) to a path the
   orchestrator can read, outside `/var/lib/glimway-server`. The orchestrator
   then runs the release commit's server on it:

   ```sh
   nix develop -c go run ./server/cmd/glimway-server migrate --dry-run /path/to/copy.sqlite
   ```

   `migrate --dry-run COPY` runs the `verify-backup` checks on the copy,
   migrates a private snapshot of it in a temporary folder, checks that
   again, and prints the schema, the migrations applied and how long they
   took, and the counts before and after (accounts, worlds, homes, items,
   plants, holds, camps, Pell's crates). `COPY` itself is never written. It
   refuses this server's `-db` and any file that looks in use (a `-wal`,
   `-shm` or `-journal` beside it, more than one hard link, or a process
   holding it), so rehearse on a plain copy. Details:
   [home-server.md](home-server.md#updating-and-local-checks).

   Check the output:

   - it exits zero and lists the migrations you expect, ending at this
     release's newest;
   - accounts, worlds and homes are the same before and after;
   - every other count that changes is one the release's migrations explain
     (things moved into Pell's crates, say), and nothing drops to zero that
     wasn't zero.

   Record the output with the release (its decision-log entry). If anything
   looks wrong, stop: the release waits for a fix and a new rehearsal.
6. **Move `main`** once CI on the release commit is green and the rehearsal
   passed:

   ```sh
   git push origin dev:main
   ```

   That pushes the same commit, so `main`'s CI run is a second run of it.
7. **Tag and publish (automatic).** When CI passes on `main`,
   `.github/workflows/tag-release.yml` reads `package.json`'s version and, if
   there's no `vX.Y.Z` tag yet, tags that commit and calls
   `.github/workflows/release.yml`, which builds and pushes
   `ghcr.io/solidsilver/glimway` (`X.Y.Z`, `X.Y`, `latest`, `sha-<commit>`)
   with the commit as the build id. A failed CI run tags nothing: rerun it or fix forward
   and push again. The release commit must not be `[skip ci]`: with no CI
   run, nothing tags it. A tag pushed by hand still publishes too (the release
   workflow runs on `v*` tags and stops if the tag isn't `v` + `package.json`'s
   version). If the tag exists but publishing failed, run "Publish GHCR image"
   by hand (Actions → Run workflow) with that tag.
8. **Deploy** (the owner) as in [home-server.md](home-server.md). Open tabs
   notice the new build (they check `/version.json`) and offer to reload;
   `GET /api/health` names the server's version and build.

Never move or reuse a published tag: fix forward with the next patch version.

### 0.13.0: one restart of live

Live runs 0.11.2. The 0.13.0 deploy changes the live unit, so it restarts
the server once (later settings changes only reload it):

- the unit gains a settings file, `/etc/glimway/config.toml`, rendered from
  `services.glimway.settings`, and an `ExecReload` that sends SIGHUP;
- the login limits move from flags into that file (`[server.login]`), with
  the same values.

That start also applies `038_lamps.sql` (live's schema ends at 037): the
lasting-geography reset with its refunds, the lot lanterns, camps, holds and
Pell's crates in one migration. That is what the rehearsal in step 5 is for.

## Pre-releases

Milestones on the way to a release are tagged `vX.Y.Z-alpha.N`, so a problem can
be traced to the step that brought it. Bump `package.json` to the same version
(`npm version X.Y.Z-alpha.N --no-git-tag-version`), commit, and tag the commit on
the branch where it was built (usually `dev` or the release's integration
branch); `main` stays on the last release. The release workflow publishes the
image as `X.Y.Z-alpha.N` and `sha-<commit>` only: never `X.Y` or `latest`. The
changelog keeps collecting under `## [Unreleased]` until the real release.
The protobuf breaking check ignores pre-release tags and compares against the
last real release ([proto-migration.md](proto-migration.md)).
