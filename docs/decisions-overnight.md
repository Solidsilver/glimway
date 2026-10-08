# Decisions made while the owner was away

The owner asked (2026-10-07) for work to keep going overnight, release after release, with alpha
tags as checkpoints. Every call the owner would normally make is logged here: what was decided,
why, and the tag it first landed in. To undo one, start from the tag before it.

Releases built this way carry only alpha tags (`vX.Y.0-alpha.N`). `main` and the real release
tags wait for the owner's playtest.

## Tags

| Tag | Branch | What it adds |
|---|---|---|
| `v0.3.0-alpha.1` | `expansion` | Sound (Kenney CC0) with a Menu toggle and volume; phones and high-DPI screens at full resolution; the desolation flake fixed; pre-release version support |

## Decisions

| # | Decision | Why | First in |
|---|---|---|---|
| 1 | Sound starts with Kenney's CC0 packs (owner's choice), credited in `ASSETS.md`. | Owner, 2026-10-07. | — |
| 2 | Pre-release tags publish their own GHCR image but never `latest`, `X.Y` or `main`. | Checkpoints without moving the owner's deploys. | alpha.1 |
| 3 | Phones render at the device pixel ratio, capped at 3, and phones above 1× keep the full 4× art (textures 16 → 44 MB). If an older iPhone struggles, lower `MAX_CANVAS_RATIO` (`src/game/viewport.ts`) to 2 first, then `PHONE_ART_DENSITY` (`src/game/atlas-plan.ts`) to 2. | The polish goal was full sharpness; the Mac showed no frame cost, but no real phone was measured. **Please try it on your phone.** | alpha.1 |
| 4 | A live pixel-ratio change (window dragged between screens) resizes the canvas but keeps the textures built at start. | Rebuilding textures mid-game isn't worth the complexity. | alpha.1 |
| 5 | Sound picks to judge by ear: the swing uses Kenney's `knifeSlice` (least sure), footsteps sit at gain 0.28, info toasts chime, enemies calmed play a gentle "resolved" tone. The old `fingersnap:muted` setting isn't read, so a muted device starts with sound on. No ambience yet: Kenney has no fitting loops (slot ready in `src/game/sound-bank.ts`). | Owner asked for Kenney first; nobody else plays yet. **Please listen.** | alpha.1 |
| 6 | Known camera quirk left alone: with `roundPixels`, Phaser floors the camera's scroll each frame, so the follow can rest up to ~8 world px short of the hero. | Pre-existing; fixing it changes camera feel everywhere. Candidate for the next review round. | — |
| 7 | 0.3 design: "the outer Wilds need the server" is read as both Wilds regions (the Tangle too), since every reward there is a server claim. | Interpretation of the owner's answer. | — |
| 8 | 0.3: a tab still open on 0.2 won't show a reload prompt when 0.3 deploys (it shows errors until its periodic version check offers the reload). Later versions handle it properly. | The shipped 0.2 client can't be taught after the fact; only the owner plays. | — |

## Test health

- Flaky on the CI runner: `gifts.spec.ts:17` (known), `party-worlds.spec.ts:47` (new; a 2.5 min
  "Test ended"), `crafting.spec.ts:114` (seen before on macOS CI). Each passed on retry.
