# Changelog

What changed in each release of Glimway. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (0.x for now: anything may still
change). How to cut a release: [docs/releasing.md](docs/releasing.md).

Each release has two parts, always in this order and with these headings, so
the game can show the first part as "What's new":

- `### For players`: short, plain lines about what you'll notice in play.
- `### Technical`: what changed for people who run or work on Glimway.

## [Unreleased]

### For players

- When a new version of Glimway is ready, a small notice offers to reload.
  Your progress is saved first, and if it can't be saved just then, the
  notice says so and waits.
- The Menu shows which version you're playing, with a link to this list of
  what's new.

### Technical

- `package.json` is the one source of the version; the Nix packages read it
  too. Each build also gets a build id: the short git commit of a clean
  checkout, the `GLIMWAY_BUILD` it is given (the Docker build argument the
  release workflow fills, the flake's revision), or else a hash of the build's
  inputs (`scripts/build-version.mjs`).
- The client gets both at build time (`__GLIMWAY_VERSION__`,
  `__GLIMWAY_BUILD__`), and `vite build` writes `dist/version.json`. Open tabs
  check it when they come back into view and every ten minutes; a different
  build id brings up the reload notice.
- The server is built with its version and build id (`-ldflags -X`, `dev`
  otherwise), reports them in `GET /api/health` and logs them at start-up.
- `version.json` is served with `Cache-Control: no-store`.
- The release workflow stops early when the tag doesn't match
  `package.json`'s version.
- This changelog, and the release steps in `docs/releasing.md`.

## [0.1.0] - 2026-10-07

The first public release.

### For players

- Walk the old lantern road: meet Mara in Hearthwick, follow the Brackenwood
  Path, settle the stone warden at Ashwatch Ruin, and light the lanterns
  again.
- Light, fair combat: every attack is telegraphed, and you have a basic
  attack, a signature ability for your class and a dodge roll.
- Play as a guest, with everything saved in your browser, or as your own
  Habitica hero: every 10 XP you earn on Habitica becomes an ember to spend
  on warm rests, road lanterns and the Ember Charm.
- Join a small, invite-only world with friends: raise a homestead in
  Hearthwick Commons from a campsite to a cottage and a workshop, arrange
  your furniture, gather in the shared Tangle, give to village projects, send
  mail, and see each other walk around and wave.
- Gather and craft: chop, quarry, dig and plant, then make things at the
  hearth, the desk and the crafting bench.
- Glimway keeps its own calendar, with festivals that change the village for
  a day.
- Find 52 papers (letters, ledgers, songs and more), read them in your
  journal, and share them in the Hearthwick Library.
- Plays on phones too, with touch controls.

### Technical

- Browser game in Svelte 5, TypeScript, Phaser 3 and Vite; an optional Go
  server with SQLite for shared worlds, with presence over a WebSocket.
- Habitica access is read-only: one `GET /user` per connect or sync, from
  the browser.
- Three ways to deploy: a NixOS service flake, Docker Compose with images on
  GHCR (`ghcr.io/solidsilver/glimway`, amd64 and arm64), or by hand
  ([docs/home-server.md](docs/home-server.md)).
- Code under AGPL-3.0-or-later, the game's own art under CC0, Habitica's art
  under its own licence; contributions under the DCO.
- Unit tests, Go tests and Playwright playtests.

[Unreleased]: https://github.com/Solidsilver/glimway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Solidsilver/glimway/releases/tag/v0.1.0
