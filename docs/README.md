# Docs index

> The game was called **Fingersnap** until October 2026, when it became Glimway. Older docs
> (the history below) still use the old name.

The project [README](../README.md) is the guide to the game, running it and
its architecture. This folder holds two kinds of document:

- **Current references** describe how things are and are kept up to date
  with the code. When one disagrees with the code, the code wins: fix the doc.
- **History** records how things were on a date: status snapshots, reviews,
  playtests and art requests. They aren't updated, and some of what they
  describe has since changed (the stone warden, for one, is now settled by
  speaking, not fought). Read them for the reasoning, not for current
  behaviour.

## Current references

**Working on the code**

| Doc | What it covers |
|---|---|
| [testing.md](testing.md) | The test workflow: tiers, prerequisites, generated data, writing and debugging playtests |
| [server-behavior.md](server-behavior.md) | Server behavior and migration notes, preserved by implementation phase |
| [home-server.md](home-server.md) | Self-hosting with the NixOS flake, Docker Compose or manual builds |
| [releasing.md](releasing.md) | Cutting a release: the changelog, the version bump, the tag that publishes the image |
| [runtime-contract.md](runtime-contract.md) | The lantern road: game state, the quest machine and its ids, the warden, defeat |
| [import-contract.md](import-contract.md) | The read-only Habitica import, saves (format 2), imported health and mana |
| [habitica-assets.md](habitica-assets.md) | The gear catalog and the avatar and companion art |
| [habitica-foundations.md](habitica-foundations.md) | Research record of Habitica's API and rules (2026-10-02), the basis for the import |
| [runtime-asset-spec.md](runtime-asset-spec.md) | The art contract: sprite slots, delivered packs, what is still wanted |
| [cleanup-plan.md](cleanup-plan.md) | The architecture cleanup in progress (October 2026), from the reviews below |

**Design and world**

| Doc | What it covers |
|---|---|
| [expansion-design.md](expansion-design.md) | Onboarding, homesteads, shared worlds, the Wilds (approved design, with an implementation status) |
| [hands-on-design.md](hands-on-design.md) | Homesteads, items and things to touch (extends the expansion design) |
| [items/](items/overview.md) | Items: [overview](items/overview.md), [catalogue](items/catalogue.md), [crafting and repair](items/crafting-and-repair.md) |
| [lore/chronicle.md](lore/chronicle.md) | The canon. `lore/texts/` holds the papers' source (`npm run papers`); `lore/drafts/` is unpublished writing |
| [scaling.md](scaling.md) | Notes on scaling, for later (not needed yet) |
| [ideas.md](ideas.md) | A canvas of ideas; nothing there is planned |

**Habitica, licences and deploys**

| Doc | What it covers |
|---|---|
| [habitica-boundary.md](habitica-boundary.md) | What the game may take from Habitica, and what stays there |
| [habitica-policy.md](habitica-policy.md) | Habitica's rules for third-party tools, and the plan for telling staff |
| [habitica-gold.md](habitica-gold.md) | Research and design for the gold purse |
| [licensing-and-funding.md](licensing-and-funding.md) | Licence decisions, the Habitica art terms, funding research, the name |
| [deploy-notes/](deploy-notes/glimway-rename.md) | Generic migration steps: [the Glimway rename](deploy-notes/glimway-rename.md) |

Outside this folder: [ASSETS.md](../ASSETS.md) is the art and licence
register, and `assets/generated/README.md` the art direction.

## History

**Status and records**

| Doc | Date | What it was |
|---|---|---|
| [build-status.md](build-status.md) | 2026-10-04 | Build status snapshot, with milestones 2–3 |
| [m3-implementation.md](m3-implementation.md) | 2026-10-03 | Record of the M3 import foundation work |
| [runtime-import-notes.md](runtime-import-notes.md) | 2026-10-03 | How the runtime consumed the M3 import |
| `../BUILD_KICKOFF.md`, `../Fingersnap Plan.md` | 2026-10-02 | The original kickoff and plan |

**Reviews**

| Doc | Date | Scope |
|---|---|---|
| [reviews/2026-10-07-arch-server.md](reviews/2026-10-07-arch-server.md) | 2026-10-07 | Architecture: the Go server and the contract |
| [reviews/2026-10-07-arch-game.md](reviews/2026-10-07-arch-game.md) | 2026-10-07 | Architecture: the Phaser game |
| [reviews/2026-10-07-arch-ui.md](reviews/2026-10-07-arch-ui.md) | 2026-10-07 | Architecture: the Svelte UI and client libraries |
| [reviews/2026-10-07-arch-tooling.md](reviews/2026-10-07-arch-tooling.md) | 2026-10-07 | Architecture: tests, tooling and docs |
| [m3-review.md](m3-review.md) | 2026-10-03 | The M3 import foundation |
| [runtime-review.md](runtime-review.md) | 2026-10-03 | Quest, save, pause and touch bugs |

**Playtests** (screenshots in `screenshots/`)

| Doc | Date | What was played |
|---|---|---|
| [playtest.md](playtest.md) | 2026-10-02 | The first demo |
| [playtest-m3.md](playtest-m3.md) | 2026-10-03 | Import, avatars, class combat |
| [playtest-runtime-art.md](playtest-runtime-art.md) | 2026-10-03 | NPC breathing, warden poses, class effects |

**Art requests** (briefs for the image-generation agent)

| Doc | Status |
|---|---|
| [art-requests.md](art-requests.md) | Delivered 2026-10-05 as the Commons pass |
| [art-request-playtest1.md](art-request-playtest1.md) | The playtest-1 pass |
| [art-request-playtest2.md](art-request-playtest2.md) | Playtest-1, round 3 |
