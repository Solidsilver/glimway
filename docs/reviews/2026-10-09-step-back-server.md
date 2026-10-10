# Step-back review after 0.5: the server, shared rules and tooling

Snapshot: `afa8363` (Release 0.5.0: Crafts). Scope: `server/` (cmd, api, store, rules, land, wilds, worldchange, migrations), `content/` (Go loaders, JSON, `proto/glimway/content/v1`), `proto/`, and the tooling (`.github/workflows`, `Dockerfile`, `compose.yaml`, `nix/`, `scripts/`, `buf*`). The game and UI are reviewed separately. Estimates: S = one focused change; M = several; L = staged. Findings are ordered by payoff relative to risk. The previous review is [2026-10-07-arch-server.md](2026-10-07-arch-server.md) (snapshot `06ba31d`).

## Map: what changed since 2026-10-07

- **0.3 Server-first, 0.4 Indoors, 0.5 Crafts** landed. `server/internal/api` now has 71 production files (15,520 lines) and 60 test files (19,751 lines). `store` has 18 files (2,058 lines). `content` has 24 loaders (3,331 lines). There are 30 migrations, through `031_level_mark.sql`, with a `history.json` manifest.
- **The keyed-operation pipeline** is `op.go`/`op_idempotency.go`/`mutation.go`. Its order: auth → due mail → load → lease → idempotency (cached refusal or replay) → report barrier → `where` → a `gameplay` savepoint around apply/settle/persist → result validation → commit → after-commit notifications. Spend now runs on it (`spend_op.go:19`). Replay returns the stored result with the *current* state (`op_test.go:77`); that is deliberate.
- **0.5 added**, mostly written by MiMo in lanes B/C/D:
  - **Companions and the stable:** `api/stable.go` 417 lines, `api/companions.go` 208, `store/companions.go` 126.
  - **Magic:**
    - `rules/magic.go` 242 lines.
    - `api/report.go` holds the per-move budget and the ward credit.
    - `api/presence_abilities.go` 288 lines: relay, reach, ward pulses.
    - `store/ability_ready.go`.
    - The level mark column (031).
  - **Fishing:** `api/fishing.go` 550 lines, `content/fishing.go`. Fish stock is per world and per water, kept lazily in `fisheries`; casts are rows in `fishing_casts`.
  - **Smaller additions:** `worldchange/`, the `fishingComposition` decorator on `PlayerState`, and presence pose/ability events (`proto/glimway/v2/presence.proto` 11–12, pose = 6).
- **Tooling:** `tag-release.yml` is new. It tags main from `workflow_run` of CI and calls `release.yml` through `workflow_call`. The Dockerfile copies the crafts manifest (3cfb70d).
- **Prior findings 1–8:**
  - Done: the error catalog (the proto `ErrorCode` enum, with a test panic on a missing code at `proto.go:25`), gathering validation, spend on the keyed path, and the migration manifest with frozen hashes and registered backfills.
  - Mostly done: the file splits. `api.go` is 134 lines; the largest files are now `wilds.go` (938) and `worlds.go` (688).
  - Partly done:
    - Test helpers: `test_helpers_test.go` exists, but the `round*/fix*/phase5` suites remain.
    - Item movement: `itemmove` is used by `store/mail.go`, but about 20 currency-string literals remain.
    - Go/TS parity: the name policy now matches, with `content/vectors/post-names.json`, but there are no placement fixtures.

## Findings

### 1. The Nix web package can't build 0.5.0: the crafts manifest is outside its fileset

**Evidence:**
- `src/lib/stable-layout.ts:14` imports `../../assets/generated/crafts-pass/manifest.json`.
- The Dockerfile was fixed for this (`Dockerfile:15`, 3cfb70d).
- `nix/web.nix:13-17` lists `package.json … src public content` but not `assets/`. The release commit changed only its `npmDepsHash`.
- `deploy/nixos/glimway.nix:48` builds `webPackage` from `nix/web.nix`.

No `nix build` was run; this is read from the fileset.

**Change:** add `../assets/generated/crafts-pass/manifest.json` to the fileset. Add a CI job that runs `nix build .#glimway-web .#glimway-server`, or `nix flake check`. CI builds no Nix today, so drift between the Dockerfile and Nix, and stale `npmDepsHash`/`vendorHash`, go unseen until a deploy.

**Size/risk:** S, low. **Guards:** the new Nix CI job. Until it exists, the owner's `nh os build` before switching.

### 2. The class mark is written only by the profile op, so a rebirth can take a hero's magic away

**Evidence:**
- `class_mark` has one writer: `profile_report.go:97-105`.
- Sign-in raises `level_mark` but not `class_mark` (`login.go:197`).
- Account creation sets `level_mark` but not `class_mark` (`world_choice.go:130`).
- Migration 030 has no backfill.
- Sync runs only when the player presses "Sync character".
- `rules.Craft` (`rules/magic.go:28`) falls back to the class mark only when it is non-empty.

**Scenario:** a level-40 rogue who never synced in 0.5 takes the Orb of Rebirth on Habitica, then presses Sync. `profile_json` becomes classless and `class_mark` is still NULL, so `Craft` returns `""`. The hero loses their moves until they choose a class again. Design 4.2 and question 11.4 promise they keep them. `presence_abilities_test.go:245-261` encodes the gap: it asserts that "a classless sync leaves Alice with no craft", although Alice signed in as a level-20 healer.

**Change:** make three small writes, (c) first:
- (a) **Sign-in, `login.go:197`:** add `class_mark=CASE WHEN ?!='' THEN ? ELSE class_mark END` using `NormalizeClass(p.Class)`.
- (b) **Account creation, `world_choice.go:130`:** add `class_mark` to the `sync_baselines` INSERT.
- (c) **The profile op, `profile_report.go:97`:** when `s.ClassMark == ""` and the stored `s.ImportedProfile.Class` is set, take that class before the sync overwrites it. This alone covers 0.4 accounts, because their `profile_json` still holds the class.
- Optionally, a 032 backfill from `json_extract(profile_json,'$.class')`.

**Size/risk:** S, low. **Guards:**
- A new test: sign in classed, sync classless at level ≥ 10, assert the craft is kept.
- Rewrite the tail of the ward test so it changes class (healer → warrior, then a `mend` is dropped) instead of going classless.

### 3. Casts made while moving or riding are dropped by the hub's reach check

**Evidence:**
- `presence_abilities.go:194-199` allows `(reachTiles+1)*16` px from `p.pos`. Only Kindle has `reachTiles`, so Stand, Echo, Ward-light and every signature get 16 px.
- The client sends a position at most every 150 ms (`src/lib/presence-client.ts:161`) and doesn't flush one before `ability()`. The hub also drops positions that arrive less than 125 ms apart (`presence_socket.go:304`).
- At 155 px/s riding (`hero.ts:38`), the stored position can be 23 px stale, or about 16.5 px on foot.

**Effect:**
- A rejected cast is silently not relayed, so friends never see it.
- For Ward-light, `scheduleWard` never runs, so allies get no ward credit and no heal.
- The caster sees their own effect, so nobody notices.

This is derived from the arithmetic, not reproduced.

**Change:** allow slack of maximum speed × (position gap + jitter), about 50–60 px. Also, or instead, have the client flush its position just before sending `ability`.

**Size/risk:** S, low. It stays inside the trust model. **Guards:** a hub test where the last position is 20–25 px behind a cast made 150 ms later, and the cast is relayed and credits the ward.

### 4. Fishing tests go red from 2026-11-16; a seller test goes red on 2026-10-24

**Evidence:**
- **Fishing:** `newRig` starts its clock at `time.Now()` (`test_helpers_test.go:87`).
  - The north and east banks are `closedIn: ["Quiet"]` (`content/fishing.json:15-16`), and the fishing tests cast there without pinning the clock (`fishing_test.go:266, 343, 479, …`).
  - Quiet is wicks 9–11 of the 84-day year. The epoch is 2026-01-05, so the next window is **2026-11-16 to 12-06**, then every 84 days.
  - Two reviewers reproduced this independently with a fixed start date in Quiet. Eight tests fail with `409 not-in-season`: CastReserves, CancelAndRelease, BandsStock, BanksReachAndSeason, SettleRefusals, TwoAccounts, Replays and WireShapes.
- **Sellers:** `TestSellersHazelFinnAndTheCartingStall` (`seasons_test.go:311`) jumps to the Carting mark and expects the madder stall closed. On Carting Day itself, `jumpTo` (`seasons_test.go:25-31`) stays on the festival day, so the buy returns 200. This was reproduced at 2026-08-01. The next Carting Day is **2026-10-24**.

This is the same class of bug dcf461e fixed for the repairs weather test.

**Change:**
- Fishing: a setup helper that jumps to a non-Quiet day, or casts from `race`, the bank that is open all year.
- Sellers: a `jumpTo` variant that requires `Festival == nil`.
- The durable fix is finding 5.

**Size/risk:** S, low. **Guards:** finding 5's per-season run.

### 5. Store functions read the wall clock while the API uses the injected clock

**Evidence:**
- `store/store.go:190` (`Invite`: created and expires at `time.Now()` + 30 days), `store/parties.go:42,68`, and `store/admin.go:31,56`.
- The API compares these rows with `Config.Now()`: `inviteUsable` in `login_limits.go:126`.
- With the rig clock started on 2026-11-20, about 29 tests failed and the run hit the 10-minute timeout. Any test whose clock runs more than 30 days ahead, such as `jumpTo("mark","Quiet")` from today, can't use a CLI invite.
- With a past start date, `TestWorldChoiceClosedPartyRefusesPartyAdmitted` fails, because `Parties` compares `pending_sessions.expires_at` with wall time.
- The same mismatch is live under the e2e dev clock (`-tags dev`): CLI invites and the admin party list ignore moved time.

**Change:**
- Pass `now` into these store functions.
- Then start `newRig` on a fixed date, a Carting-mark day without a festival. That ends findings 4 and 6's dependence on the date of the run.
- Tests that need a season jump to it explicitly.

**Size/risk:** M, low. Mechanical, but it touches many tests. **Guards:** a CI step (or nightly job) that runs the api package with the rig clock at one start date per mark plus each festival. About 30 s per date.

### 6. `TestPlantingAtHome`'s `429 login-rate-limited`: the per-IP login limiter, on a clock that doesn't move

**Evidence:**
- Every rig request comes from `httptest.NewRequest` (`test_helpers_test.go:337`), so every request has RemoteAddr `192.0.2.1`. They all share one bucket in `a.loginLimit` (`login.go:41`).
- The limit defaults to 10 per 60 s (`api.go:110-117`), and the window runs on the rig's clock, which doesn't advance during setup.
- `homePlayer` (`gathering_test.go:139-156`) logs in a fresh account for each candidate world, up to 40, until a world's land has lit trees, unlit trees and a lit boulder. About 47% of random worlds qualify, so it needs 11 or more logins in about 0.17% of calls. Its three callers (`gathering_test.go:323, 415, 507`) put that at roughly 0.5% per api run.
- One reviewer hit it naturally in `TestPlantingNeverStacksIsCappedAndBlocksPlacement`.
- The limiter isn't shared between tests and no tests run in parallel: the server is correct.

**Change:**
- In `homePlayer`, advance `x.now` by `LoginWindow` before each retry.
- Better, choose the world by checking `land.Seed` over candidate world IDs *before* logging in, then log in once.
- Don't raise `LoginRate` in `newRig`: `fixes_test.go:152-166` depends on the default of 10.

**Size/risk:** S, low. **Guards:** `go test -run 'Planting|HomePlayer' -count=200 ./server/internal/api` passes.

### 7. CI and the release workflows: three small gaps in `tag-release.yml`, and checks CI doesn't run

**Evidence:**
- **What `tag-release.yml` gets right:**
  - It filters on `branches: [main]`, `event == 'push'` and `conclusion == 'success'`, which excludes PR, fork and tag-push runs.
  - It tags `head_sha` and reads `package.json` at that SHA.
  - Values reach `run:` through `env`, so there's no injection.
  - `release.yml` checks out `inputs.sha`.
  - `workflow_call` is the right way around the rule that tags pushed with `GITHUB_TOKEN` don't trigger workflows.
- **Gaps:**
  - a. **The wrong commit can be tagged.** `e2e-full` has `cancel-in-progress: true` per ref (`ci.yml:127-129`). A second push to main while the release commit's e2e runs cancels that run, so the *next* commit is tagged with the release's version. A `[skip ci]` release commit is never tagged until a later push. *As of this review, CI for `afa8363` is still in progress on main, and `v0.5.0` doesn't exist yet: don't push to main until it is tagged.*
  - b. **Recovering from a failed publish is awkward.** Once the tag exists, "Re-run all jobs" sees it and skips `publish`. `release.yml` has no `workflow_dispatch`, and the docs forbid re-pushing the tag.
  - c. **No concurrency group.** Two main runs finishing together both pass `ls-remote`, and the second `git push` fails red.
  - d. **CI runs `go test ./...` but not `go vet`** (`ci.yml:37`). `go test` runs only part of vet, without the copylocks check, so `round1_test.go:209` (`t.Fatal(..., fall)` copies a proto `Envelope`) goes unseen.
  - e. **No `-race`,** although presence is concurrent. A targeted `-race` run on the presence, ward, stable and fish tests was clean in 51 s.
  - f. **`ci.yml:39` re-runs the whole api package** (about 30 s) for three dev-tagged tests.

**Change:**
- a: `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`, and a note in `docs/releasing.md` that a release commit must not be `[skip ci]`.
- b: `workflow_dispatch` with a `tag` input on `release.yml`, resolving the SHA from the tag.
- c: `concurrency: tag-release`.
- d, e: add `go vet ./...` and `-race` on `./server/internal/api`, and fix the copylocks hit (pass `&fall` or `protojson.Format`).
- f: add `-run DevGrant` (or the dev tests' names) to that line.

**Size/risk:** S each, low. **Guards:** the next release tags itself. CI fails on a planted vet error.

### 8. A water missing from content makes every state read fail for anyone with an open cast on it

**Evidence:**
- `closeCasts` returns an error for an unknown water (`fishing.go:173-176`; also 374-377 and 447-450).
- `fishingStateFor` runs the lapse inside every `PlayerState` (`fishing.go:542`, wired at `api.go:82`), including the refusal and replay paths.

**Scenario:** a content edit renames `water:village:mill-pond` while someone has a cast out. Their settle and cancel return 500. Once the hold passes, every op and every state read for that account returns 500 until the database is fixed by hand. This is latent today, and it is a seam for generated waters on the open map.

**Change:** for an unknown water, close the cast without touching stock and log it. A state read never fails on fishing.

**Size/risk:** S, low. **Guards:** stage a cast row with an unknown water and assert that `/api/state` answers 200 and the cast is closed.

### 9. The idempotency cache stores and serves the whole request body: a token hazard for 0.6

**Evidence:**
- `savePayload` (`reconcile.go:95-110`) writes every keyed request, minus `op`, to `idempotency.payload_json`, refusals included.
- `GET /api/operations/result` returns it (`reconcile.go:74`).
- Rows live 7 days (`op_idempotency.go:35`).

A "Top up purse" request with a `token` field, written on `keyedOp`, would store the Habitica token in plaintext and return it to anyone with the session. That breaks rule one of the boundary.

**Change:**
- Make it impossible by construction: `requestBytes` refuses any request message that has a field marked secret (a proto field option, or a deny-list of `token`/`api_key`).
- Add a test that walks every request type routed through `keyedOp`.
- The top-up keeps its own idempotency in its own table (finding 10).

**Size/risk:** S, low. **Guards:** extend `TestTokenCookieAndBackup` (`api_test.go:18`) to the top-up route, checking `payload_json`, the WAL and the `/api/operations/result` body.

### 10. Prepare the 0.6 purse and wardrobe seams before the lanes start

**Evidence and changes, in the order 0.6 will hit them:**

- **No Habitica call inside a transaction.**
  - The store is one connection with immediate transactions (`store/store.go:46,51`), so a top-up doing create → score → delete → balance read inside `keyedOp` would hold every other request for up to 4 × 15 s (`habitica/client.go:32`).
  - Login gets this right: it verifies with Habitica at `login.go:59` before `BeginTx` at `:73`.
  - The top-up should be its own handler, not on `keyedOp`: a reserve transaction → Habitica calls on a context detached from `r.Context()` (a closed tab must not cancel mid-score) → a settle transaction.
  - It must never reuse `VerifyLimited`'s 429 retry loop for the score call.
  - It needs a startup sweep of stale reservations, modelled on `RunMailMaintenance` (`main.go:308`).
- **One way to spend the Habitica budget.** `login.go:41-59` applies four limits inline: per IP, per-user proofs (`proof_limits.go:25`), concurrency slots, and the global or party budget. Extract a `withHabitica(r, userID, fn)` so a top-up charges the same budget and marks failed proofs the same way. `Server.Habitica` is a concrete `*habitica.Client` (`api.go:63`); put the new write methods behind a narrow interface so tests can inject "timed out after score".
- **Gold and wardrobe only from data the server fetched.**
  - `/api/profile` maps a browser-supplied user through `habitica.Map` (`profile_report.go:57`) and stores it as `ImportedProfile`. That's accepted for pets, mounts and the level mark under the friends model.
  - If `stats.gp` or `items.gear.owned` reach `rules.Profile`, a forged report can "own" any gear or show any balance. Parse them into a separate type, filled only by the server's own fetch.
  - Store the wardrobe in its own table, written at sign-in or top-up, and have `profileReport` drop those fields.
  - Keep gp out of `rules.Profile`: it is persisted to `sessions`, `checkpoint_json` and `profile_json`, and projected back to the client.
  - The comment at `profile_report.go:91` says "verified sync" for a report that is only plausibility-checked.
- **Currency.**
  - `store.Credit` (`store/store.go:258`) hardcodes `'embers'` and the earned/XP split, and `debitEmbers` (`mutation.go:60`) carries XP logic gold doesn't have. Add a `gold` balance column and a currency-parameterized credit and debit. Write ledger rows with currency `gold` and `earned_delta` 0.
  - Several tests sum the ledger's `delta` without a currency filter; they'll need one.
  - Finish prior finding 6's first step before adding a currency: typed constructors in `itemmove` for embers, gold, stack, decoration, fitted and location-prefixed currencies. Today three conventions coexist (`content.StackCurrency`, `itemmove.Currency`, and literals in `home_deeds.go`, `home_placement.go`, `item_fittings.go`, `item_wear.go`, `workshop.go`, `dev_grant.go`, `item_giving.go`, `quest_rules.go`).
- **The market.**
  - Sellers price only in embers (`market.go:53`); add a price currency to the content good.
  - Paying in another player's shop needs a two-account transfer in `itemmove` (debit the buyer, credit the seller, two ledger rows).
  - Any escrow must be released in `relocate` (`worlds.go:422`) and in the CLI's `allowlist remove` (`store/store.go:144-170`).
- **Day boundaries** are computed three ways: `market.go:43`, `item_use.go:102` and `item_wardens.go:11` (`utcDay`). The "1–2 top-ups a day" cap needs one helper.
- **Wardrobe display.** Add `items.gear.owned` to `USER_FIELDS` (`habitica/client.go:50`, `src/lib/habitica/client.ts:19`) only when it ships. Apply the chosen outfit in `projectProfile` (`store/composition.go:96`).

**Size/risk:**
- S each: the extraction, the `withHabitica` helper, the currency constructors and the day helper.
- M within 0.6: the reserve, call and settle handler.
- Low risk if done before the features land.

**Guards:**
- A fake Habitica that hangs on score, while another player's `GET /api/state` still completes.
- A forged `/api/profile` with `gear.owned` and `gp` leaves the wardrobe and purse unchanged.
- A wrong token on a top-up counts as a failed proof.

### 11. Ward-light: friends heal less than the server credits, and credit is read before commit

**Evidence:**
- A friend's screen heals `HEAL_FORMULA.base × fraction` (`src/game/entities/moves.ts:43-45,187`), "their stats aren't on this screen". The hub credits `Magic.Heal × fraction` (`presence_abilities.go:227`). Design 4.3 says a pulse is 0.4 of the caster's Mend. The extra credit sits unused until it expires after 60 s.
- `report.go:90` reads the credit before commit and `:131-133` spends it after. Two reports from one account in that gap can each use the same credit. This is bounded by the 60 s expiry and the 8 s cooldown, and was not reproduced.

**Change:**
- The hub fills a server-set pulse amount on the relayed `PresenceAbility`, the way it fills `account_id` (one proto field).
- Credit is reserved under `h.mu`, keyed by report sequence.

**Size/risk:** S–M, low. **Guards:**
- A parity test: the relayed amount equals `rules.WardPulseHeal` for the caster.
- Two concurrent reports spend one credit once.

### 12. Seventeen of the api package's 30 seconds are real sleeps for ward pulses

**Evidence:**
- `presence_abilities_test.go:220,305,359,371` each sleep 4.2 s, plus a 2 s poll at 247, because pulses use `time.AfterFunc` (`presence_abilities.go:238`) while the hub's clock is injected.
- The slowest tests: `TestWardCreditExpiryAndZeroHP` 8.45 s, `TestPresenceWardCreditHealsAFriend` 4.31 s, `TestWardCreditSpendsOnlyWhatTheReportNeeded` 4.24 s.
- Other wall-clock waits that could flake on a loaded machine:
  - `wilds/size_v2_test.go:106-128` asserts p95 ≤ 5 ms per chunk.
  - `fix6_test.go:128-131` uses fixed 60/70 ms sleeps.
  - `presence_test.go:422-445` computes a rate from real elapsed time.

**Change:**
- Inject an `afterFunc` (or a small scheduler) into `presenceHub` and fire the pulses from the test.
- Skip the wilds timing test unless `GLIMWAY_PERF=1`.

**Size/risk:** S–M, low. **Guards:** the same tests, deterministic, in under a second.

### 13. One route table, not a dispatch and a separate list of log labels

**Evidence:**
- The label list (`routes.go:20`) and the dispatch (`routes.go:78-233`) have drifted:
  - `/api/operations/result` is dispatched (`:131`) but logs as `unknown`.
  - `/api/progress` and `/api/sync` are labelled but no longer routed.
  - The four `/api/stable/*` labels are overridden by the prefix rule at `:31`.
- 5xx answers leave no diagnostic: `problem()` drops the error (`http.go:21-27`), and the access log has only a status class.

**Change:**
- One table that yields both label and handler, done before the purse routes.
- Log the error text for 5xx only. Error values carry no token; keep bodies and headers out.

**Size/risk:** S, low. **Guards:** a test that every dispatched path has a fixed label; the existing "credentials logged" assertions in `api_test.go`.

### 14. `PlayerState` is assembled in two places

**Evidence:**
- `api.New` wraps the composition in `fishingComposition` (`api.go:82`, `fishing.go:533-549`), while companions and magic are composed in `store.PlayerState` (`store/composition.go:70-89`).
- The wrapper reads its own clock (`fishing.go:543`), not the op's clock (`op.go:53`), and also wraps test `FakeState`s.
- `store/fake_composition.go` is a test double in the production package.

**Change:** move fishing into the store projection (or one explicit list of decorators) and pass `now` through. The purse balance will go in the same place.

**Size/risk:** S, low. **Guards:** fishing state and replay tests.

### 15. Rules decided in two places without a shared vector, and small loader gaps

**Evidence:**
- **Pulse times:** Go hard-codes `[1s, 2.5s, 4s]` (`presence_abilities.go:42`); TypeScript derives them from `durationSeconds` (`combat-moves.ts:104-111`).
- **Craft rules:** `Craft`, `LevelMark` and `Unlocked` (`rules/magic.go:17-51`) mirror `craftOf`, `levelMarkOf` and `unlockedAbilities` (`src/lib/combat.ts:83-98`, `abilities.ts:57`). `crafts-fixtures.json` covers the wire, not these rules.
- **Loader gaps**, in both languages:
  - An ability's numbers aren't required per move: Kindle without `reachTiles`, or Ward-light without `pulses`/`pulseHealFraction`/`radiusTiles`, loads and silently changes server behaviour (`presence_abilities.go:195,224`).
  - `pulses` > 3 is capped by `wardPulseOffsets`.
  - A water id's area segment isn't checked against `area` (`content/fishing.go:61-90`).
- **Habitica mapping:** the mapping vectors in `content/vectors/backend.json` lack the 0.5 cases, a pet valued -1 and a null pet (`habitica/client.go:248`).

**Change:**
- Pulse times derived from content in Go too.
- A craft table (class, class mark, levels → craft and unlocks) in `content/vectors/abilities.json`, replayed by both languages.
- The required per-move numbers and the water-area rule in both loaders.
- The two mapping cases.

**Size/risk:** S, low. **Guards:** the vectors themselves.

### 16. Small correctness nits in the 0.5 server

- **A refused settle can leave the line open.** `wrong-tool` on settle (`fishing.go:385-393`) rolls back and leaves the cast open, blocking new casts for up to 600 s. The client treats it as "cast over" (`src/lib/fishing.ts:261-263`). Fix: release it in the same op.
- **Fishery time can step back.** `fisheryAt` sets `f.At = at` without a check (`fishing.go:53`); a wall-clock step back counts recovery twice. Fix: `max(stored, at)`.
- **Casts before the first position are not reach-checked.** After a join, `p.pos` is nil (`presence_socket.go:287`), so a cast before the first position skips the reach check (`presence_abilities.go:194`). Fix: drop casts until a position arrives.
- **`mount_home` is cleared in some paths and not others.** It is set to NULL at `stable.go:187` and `home_membership.go:122`, but left in place at `stable.go:284,302`, `worlds.go:481` and `store/state.go:85`. It's harmless, because `CompanionsFor` requires `mount_out != ''`. Fix: one `store.SendMountHome` helper.
- **Yard slots assume contiguity.** `store/companions.go:102` loops `slot <= len(bySlot)`. Fix: iterate the sorted rows.
- **Ready rows for moves that aren't unlocked.** `BoundReport` stores a `player_ability_ready` row for any reported combat id (`rules/magic.go:204-206`). It's bounded, and needs no change unless the table matters.

**Size/risk:** S each, low. **Guards:**
- A settle refused with `wrong-tool` releases the cast.
- `fisheryAt` with an earlier `at`.
- A cast with no position is dropped.

### 17. Dead code and hygiene

- **Dead or misleading:**
  - `ports.LanternRoad` and `LanternRoadSteps` (`ports/ports.go:12,14`) are unused and duplicate the quest tree.
  - `habitica.Client.Verify` (`client.go:43`) is used only by tests.
  - `client.go:100` is unreachable.
  - `replayResult`'s second parameter is unused (`op_idempotency.go:97`).
  - The "after the write lock" comment at `fishing.go:199-202` is wrong: the lock is taken at `BeginTx`.
- **Duplicates:**
  - `nullable` is defined twice (`assets.go:273`, `itemmove.go:55`).
  - `companionAvatar` only calls `visualAvatar` (`presence_auth.go:220`).
  - `companionsProto` (`companions.go:37`) is repeated inline at `store/composition.go:79`.
  - The pose allow-list is repeated at `presence_socket.go:236` and `:310`.
- **Dead guards and shadowing:**
  - The `a.presence == nil` guards (`presence_abilities.go:147,154`) are dead, because the hub is always built.
  - `stableExtend` shadows the ResponseWriter `w` with a footprint width (`stable.go:350`).
- **Tooling and docs:**
  - `scripts/buf-breaking.sh:21-22` accepts moves that only matter for pre-0.4 tags. Drop them and the note in `docs/proto-migration.md`.
  - `compose.yaml:50` uses an unpinned `caddy:2-alpine`.
  - The migration backfills 026 and 028 are hashed but call live `rules`/`content`/`profile` code (`migration_028_backfill.go:53-124`). A rules change can alter an old-database upgrade while every checksum passes. Say so in `migrations.go:12`, and treat `TestStory028Upgrade` and the 026 upgrade tests as the real freeze.

**Size/risk:** S, low. **Guards:** `go vet` and the tests already in place.

### 18. Open-map seam: per-chunk epochs

**Evidence:**
- `worldchange.Key` already carries layer, chunk and epoch, and its rows have `ends_at`, so per-chunk rows fit.
- But nothing deletes expired `worldchange` rows; per-chunk turnover will grow the table without limit.
- `region_epochs` and `Place.outer_epoch` are per region (`store/chunks.go:60-94`); `deleteStaleEpochs` (`store/chunks.go:112`) is the model for cleanup.
- Fishing resolves waters only from curated content (`content.WaterFor`), and `fishing_casts` has no chunk or epoch column.

**Change:** when the open map starts, add expiry cleanup for `worldchange`, a water lookup by (realm, chunk, epoch), and casts that close when their chunk turns over. Finding 8's fix is a prerequisite.

**Size/risk:** M within that release. **Guards:** a chunk-turnover test that closes an open cast and prunes expired changes.

## Keep as is

- **The keyed pipeline's order.**
  - Lease before replay, with `op` excluded from the request hash.
  - A gameplay savepoint, result validation before commit, and after-commit notifications only on a fresh commit.
  - Terminal refusals are cached; transient ones (`superseded`, `report-required`, `invalid-position`) are not.
- **Fishing's stock math.**
  - Stock ≥ reserved always holds.
  - A kept fish is granted exactly once, inside the savepoint, with `UPDATE … WHERE state='open'`.
  - `ready_at` and `hold_until` are fixed at cast time and checked against server time.
  - Two players on one water are serialized by the single immediate connection.
  - A world move closes casts against their own world (`worlds.go:425-433`).
- **The level mark (031).**
  - It's raised with `MAX` at sign-in, at creation and on a plausible sync.
  - It stays separate from `verified_high_level`, so synced levels never feed rebirth or forgery checks.
  - Unlocks read `max(mark, profile level)` on both sides.
- **The stable.**
  - Validity is worked out on read (`CompanionsFor`), and only the owner empties or overwrites a held stall.
  - UNIQUE constraints stop a mount standing twice.
  - `mount_out` is cleared on a new lease, a world move, a leave and an emptied bay, with a test for each.
- **Presence.**
  - It rejects a client-supplied `account_id` and keeps cooldowns across reconnects.
  - It runs no database query under `h.mu`, and `avatarChanged` runs after commit.
- **The Habitica boundary holds in 0.5.**
  - Nothing grants or writes a Habitica item.
  - Pets and mounts are read-only lists.
  - The token lives only in the login handler, is cleared at `login.go:60`, and is in no struct.
  - `TestTokenCookieAndBackup` checks the database, the WAL, the logs and the responses.
- **Content and protos.**
  - The loaders are strict: they refuse nulls, unknown keys and proto-name keys, and run protovalidate.
  - The proto error enum is the single catalog, numbering is clean, and `buf breaking` runs against main and the latest tag.
- **Releases.** `tag-release.yml`'s core design: `workflow_run` on main pushes, tag `head_sha`, `workflow_call` into `release.yml` at that SHA, inputs through `env`.

## Proposed order

1. **Before the next deploy:** add the crafts manifest to `nix/web.nix` (1). Fix the date-bound tests before 2026-10-24 and 2026-11-16 (4). Keep pushes off main until `v0.5.0` exists (7a).
2. **Player-facing:** the class-mark writes (2) and the reach slack (3). Both are small and can go in a 0.5.1.
3. **Test health:** the `homePlayer` login (6), the injected ward scheduler (12), `go vet`/`-race`/Nix in CI and the tag-release fixes (7).
4. **The cleanup lane:** store functions take `now` and the rig is pinned (5), unknown waters don't fail state (8), one route table (13), one `PlayerState` composition (14), then vectors and loader gaps (15), the nits (16) and dead code (17).
5. **Before the 0.6 lanes start:** the secret-field guard on the idempotency cache (9), `withHabitica`, currency constructors and the day helper (10), and the server-set ward pulse amount (11), so the purse handler has its seams ready.
6. **With the open map:** findings 18 and 8.

## Verification

- `go test -count=1 ./...` at the repo root passed. api took 30.6 s and store 7.8 s.
- `go vet ./...` reports one issue: copylocks at `round1_test.go:209`.
- Reviewers also ran targeted `-race` runs on the presence, ward, stable and fishing tests (clean), `buf lint`/`buf breaking` (clean), and a coverage run (api 84.0%; the 0.5 files average about 88%, with gaps mostly in error branches).
- The date-dependent failures were reproduced in a scratch copy of the tree, started at fixed dates (2026-08-01, 08-30, 09-13, 11-20).
- The Nix and reach findings are read from the code, not reproduced.
- No source edits, no e2e, no commits.
