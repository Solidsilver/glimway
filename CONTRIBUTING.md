# Contributing to Glimway

Thanks for wanting to help. Code, writing, bug reports, playtesting notes and art are all welcome.
For anything bigger than a small fix, open an issue first so we can agree on the shape before you
spend time on it.

Repository: `https://github.com/Solidsilver/glimway`

## Sign off your commits (DCO)

Glimway uses the [Developer Certificate of Origin](https://developercertificate.org/) instead of a
contributor licence agreement. Each commit needs a `Signed-off-by` line with your real name and
email, which certifies that you wrote the change, or otherwise have the right to submit it, under
the project's licence:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. To sign off commits you've already made on a branch, run
`git rebase --signoff main`. Pull requests without a sign-off on every commit can't be merged.

Contributions come in under the licence of the part they touch (inbound = outbound):

- code and docs: AGPL-3.0-or-later (`LICENSE`);
- generated art added to `assets/generated/` or `public/assets/fingersnap/`: CC0 1.0;
- human-made art: its own folder, its own `LICENSE` and its own entry in `ASSETS.md`. Talk to us
  in an issue first about the licence (for example CC BY-SA 4.0) and how you'd like to be credited.

Never add Habitica's art or code beyond what's already here without talking about it first; it
has its own terms (see the README's "Licences").

## Run the checks

Requirements: Node 24+ and Go 1.26+. Then:

```sh
npm ci
npm run verify                  # typecheck, svelte-check, unit tests, production build
go vet ./... && go test ./...   # the server, shared content and parity vectors
npx playwright install chromium # once, for the playtests
npm run test:smoke              # the critical-path browser playtests
npm run test:changed            # the playtests for what your branch changed
```

Run `npm run test:e2e` (every playtest) before asking for a final review. If you changed shared
rules, the Wilds generator, the calendar or the papers, regenerate their data (`npm run vectors`,
`vectors:wilds`, `vectors:calendar`, `papers`); the tests fail when it drifts.

[docs/testing.md](docs/testing.md) explains the test tiers, the per-worker servers, how to write
a playtest and how to chase a flaky one. Tests wait on game state through dev hooks, never on
fixed pauses.

## Ground rules

- **Glimway is read-only on Habitica.** Nothing may write to a player's Habitica account. The
  planned gold purse will change that deliberately, with consent; until then, a change that
  writes won't be merged.
- **Respect the boundary.** What the game may take from Habitica, and what stays there, is in
  [docs/habitica-boundary.md](docs/habitica-boundary.md).
- **Keep docs current.** If you change behaviour a current reference doc describes (see
  [docs/README.md](docs/README.md)), update the doc in the same pull request. Don't rewrite the
  history docs.
- **Keep old storage names.** Browser storage still uses the game's old name (`fingersnap`,
  `fingersnap:*`). Renaming those keys would wipe players' saves.

## AI and this project

Glimway was built by AI agents, directed and reviewed by the owner, and its art so far is
AI-generated. AI-assisted contributions are fine. Whoever opens the pull request is responsible
for it: you've read and understood every line, it passes the checks, and you can sign off on it
under the DCO. Say in the pull request if a substantial part was written by an AI tool.

Human-made art is especially welcome. The owner would rather the game's art were made by people
and used generated art only to make it playable first. If you'd like to draw for Glimway, open an
issue.
