# Decisions made while the owner was away

The owner asked (2026-10-07) for work to keep going overnight, release after release, with alpha
tags as checkpoints. Every call the owner would normally make is logged here: what was decided,
why, and the tag it first landed in. To undo one, start from the tag before it.

Releases built this way carry only alpha tags (`vX.Y.0-alpha.N`). `main` and the real release
tags wait for the owner's playtest.

## Tags

| Tag | Branch | What it adds |
|---|---|---|

## Decisions

| # | Decision | Why | First in |
|---|---|---|---|
| 1 | Sound starts with Kenney's CC0 packs (owner's choice), credited in `ASSETS.md`. | Owner, 2026-10-07. | — |
| 2 | Pre-release tags publish their own GHCR image but never `latest`, `X.Y` or `main`. | Checkpoints without moving the owner's deploys. | — |
