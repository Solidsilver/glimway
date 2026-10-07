# Cleanup plan (architecture review, October 7, 2026)

Combined from four reviews of `expansion` at f83ccde, kept in `docs/reviews/2026-10-07-arch-*.md`:
the Go server and contract (Sol), the Phaser game (Opus), the Svelte UI and lib (Opus), and tests,
tooling and docs (luna).

## The overall picture

The structure is sound:
- canonical JSON content shared by Go and TypeScript, with cross-language vectors;
- server-owned balances rebuilt from normalized tables;
- one transaction per keyed mutation with exact replay;
- entities that take narrow `Deps` interfaces and never import the scene;
- one `WorldData` contract drawn by a generic area layer;
- pure, tested rules in `src/lib`;
- Svelte 5 runes throughout, with a clean `svelte-check`.

Literal copy-paste is low (jscpd 1.6% overall, 0.25–0.34% in TypeScript). What the parallel agents
left behind is **semantic duplication**: the same idea written again in a new shape. Some
examples:
- six event-name registries;
- about 11 private hash and noise copies;
- three error-copy tables with the same tail;
- 13 panels hand-building the same shell;
- four proximity systems;
- two HTTP clients.

There are also a few **oversized files**:

| File | Lines |
|---|---|
| `WorldScene.ts` | 2,047 |
| `homesteads.ts` | 2,056 |
| `App.svelte` | 1,927 |
| `items.go` | 2,152 |
| `homestead.go` | 1,703 |
| `api.go` | 1,153 |

## Phase 0: real bugs the reviews found (small, first)

1. **Unreachable error messages.** The client's error list is missing seven crafting codes
   (`recipe-unknown`, `desk-required`, `woodpile-required`, `invalid-page`, `page-not-held`,
   `nothing-ready`, `invalid-action`) and `login-user-rate-limited`, and it has 13 duplicate
   entries. Players see a generic error where specific copy already exists. *(server F1)*
2. **Wilds writes lose idempotency on retry.** `link.ts:791` `wildsMutation` mints a new key inside
   the retried lambda, so a stale-revision retry goes out under a new key with no lost-answer
   replay. `sync` and `wildsMutation` also skip the `'elsewhere'` handling. *(game, cross-area)*
3. **`npm test` is red on `expansion`.** Art sources were added without an atlas rebuild. The
   art1 branch rebuilds them; also narrow the staleness hash to the frames actually used, so an
   art drop doesn't break CI. *(game F1)*
4. **Name rules differ between client and server.** The client accepts U+0080–U+009F, which the
   server rejects. Pick one policy and add shared vectors. *(server F7)*
5. **Gathering content isn't fully validated.** Break and dig caps, yield IDs, ranges, chances and
   seeds are unchecked, and `items.go:1639` ignores a failed item lookup. *(server F4)*
6. **Small client bugs to verify and fix:**
   - a paper pickup's prompt may outlive its sprite (`papers.ts:306`);
   - `talkToSilas` can leave `dialogueOpen` stuck (`homesteads.ts`);
   - the library maps any 409 to "already shelved" (`library.ts`);
   - `build-atlases.ts` empties `public/` before baking, so a failed run leaves it empty.
7. **The licence register is missing the playtest-1 art.** `ASSETS.md` has no entry for it.

## Phase 1: deletion and hygiene (small, safe, can run in parallel)

- **Dead code:** about 69 unused exports (knip), dead functions, the `integration.js` archives,
  and re-export shims.
- **Copy constants:** wire in or delete the unused ones.
- **Stale comments and references:** fix the drifted comments, and the citations of `.agent/*`
  files that no longer exist.
- **Dev hooks:** 56 `window.__fs*` hooks, 24 of them shipped to production (one exposes the whole
  collision grid).
  - Give `__fsSafety` a real import seam, because the UI's sync depends on it.
  - Add `dev-hooks.ts` so hooks are DEV-only, typed, and cleared on shutdown.
  - Move WorldScene's ~330 lines of hooks out of `create()`.
- **Docs:**
  - rewrite or retire `runtime-contract.md`, which describes the old Warden rules as current;
  - add a historical index for dated reviews, playtests and status docs;
  - make `docs/testing.md` the only test-workflow reference.

## Phase 2: shared seams (each one makes later work smaller)

- **Game:**
  - a typed, Phaser-free event bus with one registry; this drops Phaser from `session.ts` and
    the stores, so they can finally have unit tests;
  - `lib/tile.ts` (`TILE`, `tileCenter`, `tileKey`): about 170 inline tile↔px conversions, and it
    fixes lib importing from game;
  - one hash/RNG module.

  *Trap:* layouts are seed-deterministic, so each hash formula is kept exactly, with grid
  snapshots taken before the change.
- **UI:**
  - `content/errors.ts`, holding the shared transport-error copy and one `Result<T>`;
  - `local-json.ts`;
  - `panel-state` helpers (`actionRunner()`, `busVersion()`), to replace the `version`-counter
    and busy/message boilerplate repeated in 9–10 panels.
- **Server:**
  - one HTTP test helper file;
  - an authoritative error catalog, with TypeScript codes generated from Go constants.

## Phase 3: splits and single paths (medium, one extraction per change)

- **Game:**
  - `WorldScene.ts`: extract unmoored, a dialogue-action router with one `withServer` wrapper and
    one refusal-copy table, and one `moveTo()`. Target: about 800 lines.
  - **Interactions:** one registration path, interactables that carry their own
    verb/label/marker, one nearest-wins loop instead of four, and one `openDialogue()`.
  - **Big files:** split `homesteads.ts` into art, talk and placement, and `enemies.ts` into
    warden and creatures.
- **UI:**
  - `Panel.svelte` and the promoted panel CSS (664 duplicated CSS lines); colour tokens for about
    500 raw colours;
  - **App.svelte:** the in-file dedupes, and one `layer` value for "what's on top" in place of
    five hand-written lists;
  - **the library** moves onto the API client;
  - `play-insets.ts`, so children mark what gets measured.
- **Server:** split `api.go`, `items.go`, `homestead.go` and `presence.go` by responsibility
  (same package), and rename `expansion.go` to `mutation.go`.

## Phase 4: deeper changes (medium to high risk; plan each one)

- **Account flow:** move App's connected-play state machine into a testable
  `account-flow.svelte.ts`.
- **Spend:** reuse the keyed commit coordinator, keeping its wire shape.
- **Item transfers:** shared primitives for the API and unattended mail.
- **Migrations:** a migration history manifest and a reusable upgrade-fixture builder.
- **Art loading:**
  - retire the superseded placeholder art (about 70 textures drawn, then replaced);
  - collapse the three art-pass loaders into one `art-pass.ts` / `draw-kit.ts` / `depths.ts`.
- **Areas and stores:**
  - explicit area-build inputs (`build(ctx)`), with seasons from content;
  - `wildsFor(session)`;
  - one materials balance.
- **Last, because they touch every file:** a formatter, and folders for `src/ui`.

## How it would run

- **Three lanes in parallel**, each in its own worktree, one commit per step:
  - server (Sol);
  - game (Opus);
  - UI (Opus);
  - docs and tooling (luna or GLM) alongside them.
- **Reviews:** a reviewer from the other family checks each lane per phase, then I merge and run
  the full suite.
- **Timing:** the game lane waits for the art1 merge, because it reworks `terrain.ts` and
  `WorldScene.ts`.

## Decisions for the owner

1. **Placeholder fallback.** Is code-drawn placeholder art still needed if the packed art fails to
   load? Recommended: **no**. The packed art always ships, so delete the superseded drawers.
2. **Legacy compatibility code**, for saves and caches from before the first deploy
   (`LEGACY_STORE`, the pre-stamp inventory branch, older-server defaults). Recommended: remove
   once versioning lands. Client and server then ship together with a reload prompt.
3. **Name policy.** Recommended: reject all Unicode control characters on both sides, as the
   server does.
4. **A formatter** (Prettier or Biome), applied in one sweep after the lanes merge. Recommended:
   yes, at the very end.
5. **Folders for `src/ui`.** Recommended: yes, last.
