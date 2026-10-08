# 0.3 Server-first

Status: **design, lane A contracts revised after review round 2**, 2026-10-07. Written from the code at `e6c4958`.
The owner's decisions are in [plan.md](plan.md) ("Server-first") and [guests.md](guests.md); the
owner's answers to this doc's first open questions are folded in (section 10).

**The aim.** The server owns all state and rules. The client sends intents, predicts their
result, and draws. Nothing new is written twice (TypeScript and Go) and kept in step by parity
tests. Local guest play goes. Combat stays on the player's screen.

**Three rules for every change in this release:**

1. **No client-written documents.** The client never uploads state for the server to merge.
   `PUT /api/progress` goes, and so does the `progress` field that rides on every keyed
   mutation. A Go test keeps it gone (see "Tests").
2. **A predictor may be wrong; a rule may not.** The client may keep a copy of a rule to
   *predict* (a placement preview, "you can't afford that"). If the copy is wrong, the server
   refuses or clamps and the prediction rolls back. Predictors therefore need no parity tests.
   Shared *tables* in `content/` are checked by loading the same file on both sides. The one
   exception kept in 0.3 is `items.ts` and its vectors (open question 15).
3. **Clean breaks.** Nobody plays but the owner. One upgrade carries the owner's data. Old
   clients are refused with a reload notice (section 8) and get no other compatibility code.

---

## 1. Inventory: what the client owns or duplicates today

### 1.1 The progress document

Written by `toProgress` (`src/lib/api/progress.ts:29-44`), decoded by `rules.DecodeProgress`
(`server/internal/rules/rules.go:400-451`), merged by `rules.Merge` (`rules.go:455-471`), stored
whole as `progress.doc_json` (migration 001). Uploaded by `PUT /api/progress`
(`server/internal/api/progress.go`), by `/api/sync` (required), and optionally by `/api/spend`
and every keyed mutation (`upload` in `mutation.go:88-111`, about 50 routes). A stale upload
(`baseRev` < `rev`) merges story fields only.

| Field | Written by the client at | What the server checks now | Who relies on it |
|---|---|---|---|
| `area` | `WorldScene.moveTo` (`WorldScene.ts:873`), arrival, turning, defeat (`state.ts:414-423`) | One of the known areas. No travel check. Taken as-is when current | Safe-area gate for sync (`sync.go:48`), rest (`spend.go:51`), home rest, world moves, Wilds checks, the witness room |
| `position` | `notePosition` about once a second (`WorldScene.ts:579-586`), Wilds entities | Within ±1e6. Taken as-is | The only proof of reach: `nearTile` (`item_slots.go:19-27`), `nearPiece` (`gathering.go:84-91`), `nearWilds` (`wilds.go:568-582`), the defeat tile |
| `quest` | `Session.applyQuestEvent` → `advanceQuest` (`state.ts:352`) | Known stage; only moves forward. **Any later stage is accepted**, so `new` → `complete` passes | Quest gifts (2 + 3 embers, `mutation.go:113-131`), paid on every upload **including stale ones**; witness beats |
| `hp` | `Session.setVitals` from damage, the healer's heal (`hero.ts:418,431`), defeat recovery | 0 ≤ hp ≤ maxHp. **Taken as-is**: a client can heal itself by uploading. One lock: an imported hero at 0 HP with a 0-HP baseline can't upload more than 0 (`mutation.go:98-100`) | Rest refusals, revive, the Wilds defeat |
| `mana` | Same, plus the cast cost (`hero.ts:336`) and passive regen (5/s, +6/s by a lit lantern, +5/s seated, `hero.ts:205-263`) | 0 ≤ mana ≤ maxMana. Taken as-is. No lock | Nothing server-side yet |
| `playSeconds` | `Session.tickPlaySeconds` | Maximum | Shown on the title and in Moments only |
| `inventory` (quest items) | Quest transitions add `lantern-route-rubbing`, `warden-seal` | Filtered to the four `QuestItems` (`rules.go:39`), union | Display |
| `discoveries` | `recordDiscovery` (`session.ts:286`), quest transitions | Union, ids not checked | No server reader |
| `defeatedEnemies` | `recordDefeat` for curated enemies (`enemies.ts:340`), the Warden | Union, ids not checked | No server reader; the client skips spawning them |
| `flags` | `Session.addFlag` and about 13 namespaces (below) | Economy flags (`embers:welcome`, `lit:*`, `opened:*`) stripped and re-added from `outcomes`; the rest unioned, capped at 4096 | **Rewards trust some of them** (below) |
| `version` | Constant 1 | Must be 1 | — |

Never uploaded: `maxHp`, `maxMana`, `embers`, `emberXp`, `xpEmbers` (server-owned already), and
the client-only markers `wildsRegion` and `outerSeason` (`state.ts:47-54`). So **the server
cannot tell whether a player in `wilds` is in the Tangle or the Whitequiet.**

**Flag namespaces.**

- Written by the client: `seen:`, `met:`, `heard:`, `guide:`, `nudge:pip-gate`, `home:met-silas`,
  `home:arrived`, `wilds:turned`, `unmoored:*`, `paper:<id>` (`game/papers.ts:30`, about 10
  callers), `donated:<paper>@<day>`, `echo:<member>` (`wilds/sites.ts:442`),
  `witness:<beat>:<doer>:<name>` (`presence-moments.ts:47-56`), `warden-sliver:found`
  (`wilds/entities.ts:379`).
- Written by the server into the same list: `returned:`, `paper:`, `echo:*:softened`, `heirloom:`,
  `ada-oil-gifts:` (`item_rewards.go`).
- **Rewards that read client-forgeable flags today:** `paper:<id>` gates a library donation
  (`library.go:130`); `echo:hollis` or two `paper:` flags unlock the felling-axe heirloom
  (`item_rewards.go:135-143`); `echo:nan` unlocks Nan's pole (`item_rewards.go:171`);
  `wilds:turned` makes three papers due (`stories.ts:69-123`).

**Rewards triggered by a merge today:** quest gifts and witness relays. The campsite grant on
Commons progress that `docs/server-behavior.md:283-286` describes was removed from the code; the
doc is stale.

### 1.2 TypeScript rule modules and their Go twins

| TS module | What it decides | Go twin | Parity | Target |
|---|---|---|---|---|
| `lib/state.ts` `advanceQuest`, `recoverFromDefeat` | Quest transitions, defeat recovery | **none** (Go accepts any later stage) | `stateDefaults` only | Server op (`quest-step`, `fall`); TS keeps the transition table as a predictor read from `content/quests.json` |
| `lib/habitica/sync.ts` `resolveDefeatRecovery`, `passiveRegenAllowed` | 25 % HP / 50 % mana after a fall (rounded up); demo regen | **none** | — | Server (`fall`); demo regen deleted |
| `lib/habitica/sync.ts` `syncProfile`, `applyImportedProfile` | Sync credit for local heroes | `rules.Sync` | `backend.json` | Delete (local play only) |
| `lib/embers.ts` | XP credit, welcome, quest embers, `checkSpend`/`spendEmbers`, charm | `rules.go` `CreditXP`, `Welcome`, `CheckSpend`, `SpendEmbers` | `backend.json` | Delete all but `checkSpend` (a predictor for prompts) and `withCharm` (combat) |
| `lib/economy.ts` | The type of `content/economy.json` | `content/embed.go` `Economy` | shape test | Keep: the predictor-facing contract for the shared table |
| `lib/habitica/mapping.ts`, `gear.ts` | `/user` → profile, effective stats | `habitica.Map` (`client.go:111-247`) | `backend.json` mapping | The server maps (section 2.2, `profile`); the client reads the mapped profile from the envelope |
| `lib/combat.ts` | Kits, damage, crit, mitigation, mana cost, cooldown, heal | **none** | — | Client keeps the fight. Cost, cooldown and the heal formula's constants move to `content/combat.json`, so the server can bound healing (section 4) |
| `lib/wilds/gen-v1.ts`, `index.ts`, `registry.ts` | Entities, loot, exits | `wilds/gen_v1.go` | `wilds.json` (inner-1 only) | Delete; the Go generator replaces it (section 3) |
| `lib/wilds/tangle.ts`, `outer.ts`, `stories.ts`, `world-data.ts` | Terrain, decor, crossing, story sites, Echo assignment, site papers | **none** (client-only by design) | — | Rewritten in Go, then deleted. Art maps (`TANGLE_GROUND`, `DECOR_ART`) move to a client art module |
| `lib/homestead-land.ts` `generateLand`, `landSeed` | Homestead wild land | `land/land.go` | `homestead.json` | Server sends the land grid; TS keeps the lookups (`landAt`, `isLit`, `postCost`) over served data |
| `lib/hash.ts` | Integer seeds (Wilds, land), float decor noise | `wilds/hash.go` | golden values, `wilds.json` | Integer half deleted with the generators; float half stays (painting only) |
| `lib/calendar.ts` | Wick, day, mark, festival, turning | `content/calendar.go` | `calendar.json` | **Keep with vectors**: it becomes the clock module (section 5) |
| `lib/homestead.ts` `checkPlacement`, `plantable`, `cleanPostName` | Placement preview | `home_placement.go`, `cleanPostName` | `post-names.json` only | Keep as predictors |
| `lib/items.ts` derived rules | Instanced, stackable, slots, giveable, `usableNow`, `giftPhrase` | `content/items.go`, `home_gifts.go` | `items.json` | Keep for 0.3, vectors included (the stated exception) |
| `lib/gathering.ts` | Season gate, swing plan, visit ids | `content/gathering.go`, `api/gathering.go` | none | Keep as predictor. The client-made visit id resets the per-visit cap; acceptable (day cap holds) |
| `lib/village.ts`, `workshop.ts`, `mail.ts`, `repairs.ts`, `world-moves.ts` | Panel pre-checks, content validators | `projects.go`, `crafting.go`, `content/*.go`, `worlds.go` | none | Keep as predictors |
| `lib/inventory.ts` | Inventory tabs; guest `material:` pack (`:94-147`) | `fitTool` | none | Keep the tabs; delete the guest pack |
| `lib/api/progress.ts` | `toProgress`, `mergeServerState`, reconnect plans, `QUEST_ITEMS` | `DecodeProgress`, `Merge` | none | Delete; replaced by the predictor (section 2.4) |
| `lib/save.ts`, `lib/nudges.ts` | Guest save, save codes; Pip's guest nudge | none | — | Delete |
| `lib/papers/library.ts` local donations | Guest shelf, no-library fallback; its own fetch outside the queue (`:171-172`) | `library.go` | — | Delete the local half; donations go through the queue |
| `content/papers.ts`, `game/wilds/placements.ts`, `stories.ts` find rules | When each paper can be found | partly (`project_papers`, `item_rewards.go`) | — | Find rules move into `content/papers.json`; the server grants (section 2.2) |
| `lib/guides.ts`, `belt.ts`, `local-json.ts`, `tile.ts`, `version.ts`, `changelog.ts`, presence modules | UI and drawing | — | — | Keep |

**Client-only rule logic in `src/game`:**

- `hero.ts`: damage, crits, cast cost and cooldown, heal, damage taken, passive and seated regen.
- `enemies.ts`, `creatures.ts`, `projectiles.ts`: enemy HP, AI, hits.
- `warden.ts`: three speakings settle it, then fires `defeat-guardian`.
- `wilds/entities.ts:315-328`: a camp is claimable once its enemies are down. The server doesn't
  check this.
- `wilds/sites.ts`: Echo settling, papers.
- `game/papers.ts`: paper finds.

Combat stays here. The rest becomes operations.

### 1.3 Code that exists only for local play

About 190 lines in about 60 files branch on "guest" or `!link`. The big pieces:

| Piece | Where | Target |
|---|---|---|
| Guest save (IndexedDB `fingersnap`) and corrupt-save recovery | `lib/save.ts`; `App.svelte:399-424, 587-609, 909-928`; `session.ts:105-153, 362-388, 419-424, 465-472` | Delete |
| Save codes, "Start over" | `save.ts:324-418`; `MenuPanel.svelte:85-133, 216-235, 279-315` | Delete |
| Migrate choice ("Bring this device's journey") | `account-flow.svelte.ts:236-245, 338-381`; `OriginChoice.svelte`; `content/connected.ts:10,33-55`; `POST /api/origin` (`origin.go:71-132`); `players.save_origin` | Delete. The fresh half of `origin.go:54-70` (first vitals, profile baseline and XP mark from the checkpoint) moves into player creation. The `origin-required` gate in about 12 handlers goes |
| Demo hero Wren and `'demo'` vitals | `content/world.ts:53-70`; `ui/hero.ts`; `combat.ts:88-92`; `sync.ts:80-82, 259-281`; `hero.ts:255-257`; server `store.go:244`, `rules.go:277-288` | Delete. Keep the Wren toast in `avatar.ts:121-128` (a connected hero's look failed to load) |
| "Try a sample hero" and local Habitica play | `ConnectGuide.svelte:171-256, 471-531`; `ui/habitica-local.ts:79-93`; `lib/habitica/fixtures.ts` (tests keep it) | Delete. README's second way to play ("As your Habitica hero", no server) goes too |
| No-server detection → guest | `vite.config.ts:26-28`; `ui/account.ts:57-82`; `account-flow.svelte.ts:166-191` | Becomes a plain "can't reach the world" screen |
| Guest economy | `session.ts:172-213`; `world-actions.ts:202-221` | Delete |
| Guest Wilds | `game/wilds/store.ts:16-28, 200-330`; `regions.ts:119-124`; `outer.ts:32-46`; `entities.ts` guest branches | Delete |
| Guest branches in village, homestead, items, homeland, inventory | `village.ts`, `homestead.ts`, `items.ts`, `homeland.ts:44-59`, `lib/inventory.ts:94-147` | Delete |
| Guest copy | `content/heirlooms.ts`, `echoes.ts`, `errors.ts`, `inventory.ts`, `connect-guide.ts:139-147`, `world-talk.ts`, `homestead-talk.ts`, `sites.ts:467-495` | Delete or rewrite |
| Guest-keyed localStorage | `guide-pin.ts:19`, `held.ts:21` | Key by account |
| Guest-only docs | README lines 17-21, 46, 53, 280-345, 395, 444, 501-556; `docs/home-server.md:3`; `.env.example` (stale) | Rewrite. The Nix static listener (`deploy/nixos/glimway.nix:94-101`) is the connected frontend that Caddy needs (`:117`): **keep it** |
| Logout "returns to guest play" | `account-flow.svelte.ts:542-570`; `content/connected.ts:93` | Logout returns to the title |

**Shared with connected play, so they stay:** the request queue (`lib/api/queue.ts`), the
connected cache (`lib/api/cache.ts`, reshaped into the outbox, section 2.4), `local-json.ts`
(device preferences), remembered credentials (opt-in, below).

### 1.4 The Habitica import path

| Step | Who | Token? |
|---|---|---|
| Sign-in preview and party claim | The **browser** calls `GET /api/v3/user` (`habitica/client.ts:101`, `ConnectGuide.svelte:161`) | Browser → Habitica |
| Login | `POST /api/session {userId, token, invite?, party?}` (`lib/api/client.ts:257-264`). The server calls `/user` once (`habitica.VerifyLimited`, `login.go:66`), then blanks the token (`login.go:67`) | **The only time the token reaches the server** |
| Sync | The browser calls `/user` again (`ConnectGuide.svelte:290`) and posts the **mapped profile** to `/api/sync`. The server checks the id, `Plausible()`, caps credit to verified XP plus an allowance (200 + 100/day, max 3000), and holds the rest as pending (`sync.go:44-105`) | Browser → Habitica only |
| Checkpoint | Every login settles or expires pending credit and flags forgery (`checkpoint.go:31-76`) | — |

What the server keeps: `sessions.checkpoint_json` and `pending_sessions` (the verified profile,
never the token); `sync_baselines` (`profile_json`, `xp_mark`, `verified_xp`, loss references);
`players.habitica_party_id`; the ledger with `reported_xp`. The token is never stored, logged or
returned by the server (request logs record a fixed route label, `routes.go:15-17,47-55`; errors
carry codes only).

**On the device,** "Remember on this device" keeps `{userId, apiToken}` in plain text in IndexedDB
(`remembered.ts`). It is opt-in and never sent to the server on its own.

**After 0.3:** only login sends the token. Sync reports stay unverified client input, bounded
as today and checked at the next login.

**Copy that is wrong today:** `content/connect-guide.ts:125` ("Send your token anywhere except
Habitica itself") and `:131` ("into this tab's memory, and nowhere else") contradict the login
send. Fix them in this release. The README and `MenuPanel.svelte:269` are right.

---

## 2. The target: operations

### 2.1 The shape of every operation

- **Request:** an `op` header (`lease`, `key`) plus the operation's payload, plus
  `Where { area, x, y }` when the server checks reach or place. **No `baseRev`, no `progress`.**
  `area` is an area id, with the region for the Wilds (`wilds:inner-1`, `wilds:outer-1`); `x` and
  `y` are pixels in that area (region-wide in the Wilds, as today).
- **One state version.** Each account has one counter, `players.version` (today's `rev`,
  renamed). **Every** write to the player's state bumps it: operations, reports, server sweeps
  that settle the player's mail, operator commands. A `PlayerState` with a higher version is
  always newer.
- **Conflicts:** one lease, one client queue, and every operation is checked against the
  server's current state. The `stale-revision` dance and the stale/current merge go.
- **Idempotency** keeps today's table and seven-day retention, with two changes:
  - **The stored row holds only the operation's own result** (and the version it committed at),
    never the state. A replay answers with that stored result plus the **current** state, so a
    replay can never move the client back in time.
  - **The request hash covers the payload only.** The whole `op` header (lease, key and report barrier) is left
    out, so a replay under a new lease isn't an `idempotency-mismatch`. Everything else,
    including `where`, is frozen: the outbox freezes key and payload bytes. After an authorized takeover it replaces only
    the transient `op.lease` and report barrier; it never changes payload or `where`.
- **Response:** the `Envelope` (section 6): the operation's `result` and the current
  `PlayerState`.
- **Refusals.** A game refusal (`not-next-step`, `short`, …) answers with the code **and the
  current `PlayerState`**, through a new error writer (`writeRefusal`; today `http.go:12-26`
  writes a code only). It is used only after the session and lease checks pass.
  Unauthenticated and lease failures still answer with a code only.
- **`Where` is trusted** (friends on invites), as position is today. The server records it as
  the player's place, so every keyed operation also refreshes the place.
- **Contract gate.** Every `/api` request except `/api/health`, `/api/calendar` and public immutable
  `/api/sprites/*` assets carries
  `X-Glimway-Contract: <n>`. Only the exact current decimal integer is accepted. Missing, older, future,
  signed, padded or malformed numbers answer `409 reload-needed` (section 8).

Known `where.area` ids are the curated areas, a valid `HomeGate`, or `wilds:<region>`
from the region table. Unknown ids are stateful `invalid-position` refusals. Coordinates are
trusted within finite pixel bounds. Payload ids match `[A-Za-z0-9:_-]{1,128}`; report
seq/basis/casts are safe non-negative integers, HP/mana are non-negative. Domain rules require
positive sequence numbers and required ids. Strict generated request decoding also covers
login, play and world choose. Missing `op` is stateless `400 invalid-json`.

### 2.2 The operations

`content/quests.json`, `content/story.json`, `content/vitals.json`, `content/combat.json` and
the find rules in `content/papers.json` are new or grown tables (section 5).

| Operation | Route · proto | Key | Replaces | Server checks and does | Client predicts | Refusal |
|---|---|---|---|---|---|---|
| **report** | `POST /api/report` · `ReportRequest{lease, client, seq, basis, place: Where, hp, mana, casts}` | none; ordered by `(client, seq)` | `area`, `position`, `hp`, `mana`, `playSeconds` in uploads | See "Reports" below. Out-of-bound values are **clamped, not refused**; the answer carries what was kept | Nothing; it reports what the screen shows | The client adopts the clamped vitals |
| **quest-step** | `POST /api/quest/step` · `QuestStepRequest{op, quest, to, where}` | yes | `quest`, quest items, step-made discoveries and defeats | `to` is the next step after the current one in `content/quests.json`, and `where.area` matches the step's `at`. Grants the step's items, marks, papers and embers once (outcome `quest-gift:<quest>:<step>`). Relays the step's witness beat | `advanceQuest` from the same table | `not-next-step` / `wrong-area`; stage, items and marks roll back |
| **mark** | `POST /api/story/mark` · `MarkRequest{op, mark, where}` | yes | client-written `flags`, `discoveries`, curated `defeatedEnemies` | The mark's namespace is `client` in `content/story.json`. The id is known where the table lists ids (discoveries, curated enemies). The area matches where the table says so. Caps as today | Adds the mark | `server-mark` / `unknown-mark` / `wrong-area`; the mark disappears |
| **take-paper** | `POST /api/papers/take` · `TakePaperRequest{op, paper, where, epoch, site}` | yes | `paper:` flags for placed, handed-over, Commons, board and site papers | The paper's find rule holds (see "Papers" below) | Paper in the journal | `paper-not-due`; paper removed |
| **settle-echo** | `POST /api/wilds/echo` · `SettleEchoRequest{op, epoch, site, member, where}` | yes | `echo:<member>` flags | The site is an Echo site in this epoch's stored chunks, within reach of `where`, and **this player's assignment** for that site (section 3.4) names a member not yet settled. Writes `echo:<member>`, grants its paper, relays the witness beat | Settled pose and lines | `echo-not-here`; Echo unsettled |
| **fall** | `POST /api/fall` · `FallRequest{op, where}` | yes | client defeat recovery, `POST /api/wilds/defeat` | See "Falls" below | Recovery and the walk home | The client adopts the server's vitals and place |
| **profile** | `POST /api/profile` · `ProfileReport{lease, raw, report}` | none (credit is against the XP mark, as today) | `POST /api/sync` | `raw` is the `/user` projection (`USER_FIELDS`) as Habitica returned it. The server validates its shape and maps it with `habitica.Map`, then applies today's sync rules without the upload: the profile id must equal the account's **Habitica sign-in subject**, plausibility, capped credit, pending, welcome, and the safe-area check against the server's place | "Syncing…" | Error copy as today |
| **spend** | `POST /api/spend` · `SpendRequest{op, kind, target, where}` | yes | `/api/spend` with progress | As today, minus the upload. Kinds: `rest`, `home-rest`, `road-lantern`, `chest`. **`revive` is deleted**: no client sends it, and `rest` already covers 0 HP, still paid from earned embers (`needs-earned`) | `checkSpend` prompt only; vitals change on the answer | — |
| **every keyed mutation** (items, homestead, mail, crafting, workshop, repairs, projects, Wilds claim and relight, world move and leave, library donate) | unchanged routes | yes | their `progress` and `baseRev` fields | Unchanged rules. Reach checks (`nearTile`, `nearPiece`, `nearWilds`, home rest, safe areas) read `where` instead of the uploaded position. A claim of a paper-bearing POI or chest grants its paper (section 3.4). Wilds gathering checks the target (below). Library donate joins the queue and checks a server-held `paper:` mark | As today | As today |

All wire and port times are Unix seconds, never JavaScript milliseconds;
`Vitals.castReadyAt` may be fractional. `PlayerState.place.placeSetVersion` and
`vitals.vitalsSetVersion` expose the independent watermarks. Profile sync's rejected outcomes
are stateful refusals, not successful `ProfileResult.status` values.

**Reports.** One report goes out about every 10 seconds, on every area change and on page hide
(keepalive). In order, the server:

1. **Order and generation.** `POST /api/play {clientId, takeOver}` uses a per-tab client id,
   persisted in sessionStorage across reloads and re-keyed for duplicated live tabs. There is no
   separate tab id. Client and device ids match `[A-Za-z0-9_-]{1,128}`. Resuming the same tab's
   lease keeps its report generation, ordering and cast debt; a new lease issues a fresh random
   `reportGeneration`. A report carries `client`, `generation`, safe-positive integral `seq`,
   and safe non-negative `basis`. Retired generations answer `superseded`. Within a generation,
   `seq <= report_seq` is ignored. A new generation resets `report_at` to null; its first accepted
   report counts no play time. Never rebind captured reports to a replacement generation.
2. **Basis and acknowledgment.** Server vitals writes (rest, fall, refills, consumables and
   profile vitals credit) advance `vitals_set_version`. Every keyed `where` advances
   `player_place.place_set_version`. An ordered report older than the vitals watermark consumes
   its sequence but ignores vitals, place and casts. A report older only than the place watermark
   accepts vitals and casts and ignores only place. This preserves in-flight combat through an
   unrelated crafting or gathering operation.
   `ReportResult {client, generation, seq, accepted, staleBasis, casts, basis, placeIgnored}`
   echoes the requested sequence; `accepted` means vitals/casts applied, `staleBasis` means the
   combat basis was consumed and ignored, and `placeIgnored` means place did not apply.
   `casts` is the accepted count, zero on ignored reports; `basis` is the accepted input basis
   (persisted basis on duplicates). No ignored overlay delta is sent again.
3. **Persistent signature budget.** `cast_ready_at` is a real-valued Unix timestamp, not reset
   by reporting. Signature cooldown is `content/combat.json.signatureCooldownSeconds` (**1.0 s**).
   Basic attacks use the separate per-class `basicAttackCooldownSeconds` (healer **2.5 s**).
   For an accepted, current-basis report, let `ready = max(cast_ready_at, vitals_at)` and
   `elapsed = max(0, now - vitals_at)`. The cooldown allowance is
   `max(0, 1 + floor((now - ready) / signatureCooldownSeconds))`. Allowed casts are
   `min(reported casts, cooldown allowance, floor((stored mana + regenCap * elapsed) / cost))`,
   or zero at zero HP, under its lock, or without a class. Persist
   `cast_ready_at = max(now, ready + allowed casts * signatureCooldownSeconds)`.
   The single initial allowance is consumed persistently, including across same-time reports.
4. **HP and mana.** HP may only fall except a healer's accepted casts; cap it at
   `min(maxHp, stored hp + accepted casts * server healAmount)`. Debit the cost of all accepted
   signature casts: mana is at most
   `max(0, min(maxMana, stored mana + regenCap * elapsed - accepted casts * cost))`.
   The max cap is **after** subtraction. Thus repeated same-time sequences cannot reuse mana
   or cooldown. `combat.json` names the current stat-derived heal constants and rounding.
5. **Place and time.** Record place through the shared placement hook only when accepted and
   `placeIgnored` is false. Combat remains accepted when only place is ignored. Add the accepted-report
   gap capped at 30 seconds, except the first in a generation. Persist `vitals_at = now` and
   bump the player's version once. A newly consumed stale-basis sequence also bumps once,
   because the acknowledgment in `PlayerState.vitals` changed; it leaves vitals/place,
   `report_basis`, `report_at` and cast debt untouched. Duplicates do not bump. Neither
   duplicate nor stale-basis reports apply casts again.

Server refills set `vitals_at` and `vitals_set_version` and preserve cooldown debt:
`cast_ready_at = max(old cast_ready_at, now)`. They do not give another initial cast.
The new schema includes `report_client`, `report_generation`, `report_seq`, `report_basis`,
nullable `report_at`, and `cast_ready_at` in `player_vitals`.

**Report barriers (B implements, C2 sends).** Before rest, home rest, consumables or profile
reads stored vitals/safe place, C2 freezes and flushes its pending report and waits for its
acknowledgment. `OpHeader.report` and `ProfileReport.report` carry
`ReportBarrier {client, generation, seq}`. For a new keyed operation, the helper checks a supplied barrier before placement; B
requires one for vitals-dependent kinds. Replays need only the current lease, since they
apply no gameplay. The server requires that generation's stored sequence
at least that value and its accepted basis at least `vitals_set_version`; otherwise it answers
`report-required` with state. This is retryable, not a terminal game refusal. Fall does not need
a barrier to succeed, but is a causal boundary that invalidates earlier captured combat.
Every keyed placement establishes only the place watermark; the barrier checks only the vitals watermark. A server refill invalidates an earlier accepted combat basis; unrelated operations do not.

**Partition fixtures.** B must verify a healer with 18 mana: first same-time cast consumes 18
and the initial slot; later same-time sequences permit none, even if they report unchanged mana.
With enough mana and a 1 s gap, splitting two casts versus coalescing them yields the same cast
budget and uncapped mana bound. Capping may discard honest surplus regen, never create budget.
Retries spend no budget; refills restore mana but preserve any future `cast_ready_at` debt.

**Falls.** `fall` always succeeds once the lease and key pass. In order:

1. HP becomes the recovery value from `content/vitals.json`: `min(baseline HP, ceil(maxHp × 0.25))`
   and `min(baseline MP, ceil(maxMana × 0.5))`, keeping today's rounding up
   (`sync.ts:268-269`). A 0-HP baseline stays at 0.
2. The place becomes the village spawn.
3. **The lantern, only if possible.** If `where.area` is a Wilds region whose current epoch
   exists and `where` falls inside its grid, the server places the fallen-hero lantern at that
   tile. If the daily cap (`lanternsCreatedPerDay`) is reached, or `where` isn't a valid Wilds
   tile, no lantern is made. The fall still succeeds, and the result says `lantern: none` with
   the reason.

A fall in the curated areas needs nothing from the Wilds, so it can queue offline.

**Papers.** Today `content/papers.json` keeps only each paper's source *kind*; the rules live in
`src/content/papers.ts`, `game/wilds/placements.ts` and `lib/wilds/stories.ts`. They move into
`content/papers.json`, and `scripts/papers.ts:180-195` stops throwing away everything but the
kind. Each source and who grants it, for the 39 papers that aren't on the library shelf from the
start:

| Source (count) | Granted by | Server check |
|---|---|---|
| `placed` (9) | `take-paper` | `where.area` is the paper's area, `where` within 2 tiles of its tile, and the quest is at its `after` stage |
| `quest` with no NPC (2: `eleven-days`, `principia-memoria-excerpt`) | `quest-step` | The step grants it |
| `quest` with an NPC (1), `gift` (3) | `take-paper` | The quest is at or past the stage; `where.area` is the NPC's area (village) |
| `village-project` (6) | `take-paper` | The account is in `project_papers` for that project (what `grantPaper` checks today) |
| `commons` (5) | `take-paper` | Area `commons`, plus each paper's own server fact: Carting Day by the server's calendar (the hame), a claimed plot, a laid foundation, the door-fox hung on a lintel |
| `turning` (5) | the server | `weir-effect-survey-draft`: granted when the server records a turning seen after the road is lit (below). `notices-from-the-board`: `take-paper` at a board, with the road lit and `wilds:turned`. `nan-greer-trail-journal` and `a-salting-drift-table`: site papers (below). `joss-penhallow-letter-map-case`: **unbuilt, never grantable** |
| `wilds-poi` (5) | the claim (2: `failed-grid-of-sector-4`, `joss-penhallow-field-notes-pencil-map`); `take-paper` at a site (3: the cairn, the nest, the plank) | Claim: this player's personal claim of a POI with that `poi` id in this epoch, east column and road lit where the rule says. Site: the site is in this epoch's stored chunks within reach, and its rule holds (an owned paper, the road lit, the season's Mark) |
| `wilds-chest` (1) | the claim | A tier-3 chest claimed by this player in this epoch |
| `echo` (2) | `settle-echo` | The assignment check above |

- **`wilds:turned` becomes server-owned.** The server keeps `player_place.last_outer_epoch`. The shared placement hook (B owns it; reports and keyed operations call it when `where.area` is `wilds:outer-1`) looks up the authoritative
  outer epoch and compares `starts_at`, never opaque ids. An empty watermark initializes
  `last_outer_epoch` and `last_outer_starts_at` without granting anything. A strictly later
  observed epoch writes `wilds:turned` and grants `weir-effect-survey-draft` only when the road
  is already lit at that observation. Repeated, older or first observations grant nothing;
  an existing turned mark remains. Lighting the road later does not fabricate that observation.
- **Unbuilt papers carry `unbuilt: true`** in the table, and every grant path refuses them.

**Server-written marks** stay server-written and become trustworthy:

- `returned:`, `heirloom:`, `ada-oil-gifts:`, the softened Echoes;
- `embers:welcome`, `lit:`, `opened:`;
- `paper:` (every grant path above);
- `echo:` (the settle operation);
- `wilds:turned`;
- `warden-sliver:found` (written by the claim that finds it);
- `witness:` (the relay writes it for each peer in range);
- `donated:` (the donation writes it).

`content/story.json` marks every namespace `client` or `server`. The `client` namespaces are
`seen:`, `met:`, `heard:`, `guide:`, `nudge:`, `unmoored:`, `home:met-silas`, `home:arrived`,
`found:` (discoveries) and `defeated:` (curated enemies). **No reward may read a `client`
namespace.** A Go test checks the reward code's reads against the table.

**Gathering in the Wilds** (open question 12). Today the server takes any tree
(`gathering.go:93-160`, "Trees are client scenery"). Instead it reads the stored chunk of the
current epoch for `where`'s region and checks that a decor piece of a kind the gathering target
allows (a tree for felling, a rock for the pick, a seasonal patch in season) stands within reach.

### 2.3 What the client keeps, and what goes

**Kept for prediction and drawing:**

- the quest transition table and `advanceQuest` (reading `content/quests.json`);
- paper due-ness for hints (reading `content/papers.json`);
- `checkSpend`, placement and gathering previews, panel pre-checks;
- the combat kit and the whole fight;
- position and vitals between reports;
- painting and collision from served chunks.

**Deleted:**

- the guest save, the guest economy and the demo hero;
- `toProgress`, `mergeServerState`, the reconnect plans and orphan adoption;
- the local generators;
- `syncProfile`, the local sync rules and the browser-side profile mapping.

### 2.4 Prediction, the queue and the outbox

**What the game shows.** The client holds `server`, the newest `PlayerState` it has adopted, and
`pending`, its unanswered operations in order. The game shows `server` with `pending` applied by
each operation's predict function. A `PlayerState` is adopted only if its version is at least the
one held.

**The outbox.** `pending` lives in IndexedDB (the connected cache, reshaped):

- **Ownership.** One outbox per `(account, device)`. `device` is a random id persisted in localStorage, distinct from the per-tab lease/report `clientId`. Signing
  in to a different account on the same device leaves the other account's outbox alone until
  that account signs in again.
- **Persist first.** An operation is written to the outbox, with its exact request bytes, before
  it is sent.
- **Head of line.** The outbox sends one operation at a time, in order. The next waits until the
  head has an answer. Reports aren't in the outbox: one coalesced report waits for an idle moment
  (casts summed, latest place and vitals).
- **Lifetime.** An entry older than six days is dropped unsent, and its prediction rolls back
  with a notice ("Something you did offline more than six days ago wasn't kept"). Idempotency
  rows last seven days, so a key is never replayed after the server has forgotten it.
- **Contract.** Each entry records the contract number it was made under. After a reload into a
  newer contract, older entries are dropped with the same kind of notice.

**What happens when a send doesn't succeed:**

| Outcome | What the client does |
|---|---|
| **Transport failure** (no answer, timeout, 5xx) | Keep the head and retry with backoff, same key and bytes. Keep predicting. After a minute, show a "Reaching the world…" chip |
| **Game refusal** (a 4xx game code with state) | Drop the head, adopt the refusal's state, and re-apply the rest. Unsent operations are dropped only for an explicit dependency failure or a shared authoritative predicate; predictor failure alone is not proof of refusal. One notice says what didn't happen |
| **Lease lost** (`superseded`, `playing-elsewhere`) | Stop sending and keep everything. Show "Playing on another device" with **Take over**. Never take over on its own. Replay once the player takes over |
| **Signed out** (`unauthorized`, session expired) | Stop and keep everything. Show sign-in. Replay after signing in to the same account |
| **`reload-needed`** | Stop, keep the outbox, show the reload notice (C1 consumes A's typed `isReloadNeeded` for HTTP and presence) |

A stateless `400 invalid-json` on a queued operation is a client bug: C2 pauses the outbox
and shows a notice; it never retries it indefinitely. `idempotency-mismatch` carries state,
but is not a settled gameplay refusal: that key may already have committed a different payload.
C2 reconciles current state and the committed operation before changing prediction or advancing
the head. A exports `isOutboxClientBug`, `needsReconciliation` and `isSettledRefusal` for this.

**Logout.** Logout first tries to flush the outbox. If it can't, it asks: keep the unsent things on
this device for the next sign-in, or drop them.

**Storage failure.** If IndexedDB can't be opened (a private window, for example), the outbox lives
in memory and offline play is off: every operation shows "Needs a connection" when there is none.

**Offline** (owner, 2026-10-07: keep it). In the curated areas, the operations the client can
predict (`quest-step`, `mark`, `take-paper` for placed and handed-over papers, `fall`) queue in
the outbox, and one report keeps the latest place and vitals. Anything whose result the server
decides (spends, claims, crafting, mail) shows "Needs a connection", as now. **The owner requires the outer Wilds to have the server. This implementation also requires
both regions to have it (an implementation interpretation):** entering asks for a fresh region read, and cached chunks may be drawn
but are never authority for play. If another device moved on meanwhile, replayed steps that no
longer fit are refused and roll back. No merge rule and no recovery copy are needed.

**Tab and report ownership (C2).** One tab holds a Web Lock named
`glimway-outbox:<account>:<device>` for the sender and durable sequence allocator. BroadcastChannel
notifies other tabs of state/outbox changes. Without Web Locks, use a tab-specific sender
and keep offline sending disabled in passive tabs. The server's lease owner is session plus per-tab `clientId` and never
silently takes over; same-tab reload resumes the report generation, while a new lease creates one. The immutable in-flight
report is separate from the next coalesced report: a lost sequence's casts never enter its
successor. A pending report stores its basis and causal operation boundary. Offline fall/refill
replay invalidates earlier captured combat; only local changes after that boundary may be
reported against the new state. Never blindly rebase an old report to the newest version.

**Combat overlay (C2).** Unreported local damage, mana spending and casts live above adopted
server state. Unrelated snapshots update authoritative state without healing that overlay.
A matching report ack retires its captured overlay; a server vitals operation/fall deliberately
starts a new causal boundary. Game snapshots of equal version must be equal; otherwise treat
the response as uncertain and reconcile with a state read.

**Ambiguous answers.** HTTP 429, 5xx, `not-implemented`, malformed/HTML successes and invalid
refusal state do not prove that an operation was uncommitted or terminally refused. Keep the
head and retry/reconcile. Auth/lease/reload failures pause. Only a validated terminal game
refusal with state removes the sent head. Abandoning an unresolved sent head on logout or expiry
first reconciles current state; never-sent work can be dropped directly.

### 2.5 Removed for good

- `PUT /api/progress` and `progress.go`.
- `rules.DecodeProgress`, `rules.Merge`, `rules.ValidMerged`.
- The `upload` step in `keyedMutation`, sync and spend; `progress.doc_json`.
- `POST /api/origin`, `players.save_origin`, the `origin-required` error.
- `baseRev` and `stale-revision` on operations.
- `revive`.
- `POST /api/wilds/defeat` (folded into `fall`).

---

## 3. The Wilds from the server

### 3.1 Same regions, regenerated in Go

The owner decided (2026-10-07) that **the Wilds may come out different**. Go generates them
fresh. Nothing has to match the TypeScript generator, and no claims need to survive.

- **What stays the same:**
  - The regions: the Tangle (`inner-1`, permanent) and the Whitequiet (`outer-1`, turning each
    wick), each a 3×3 grid of 24-tile chunks with the entry at (1,1) and the crossing on the
    Tangle's north edge.
  - The gameplay: the kinds and counts of camps, nodes, chests and POIs; loot tables; timers;
    story sites; the deep-country finds.
- **What changes:**
  - Terrain, decor and placements come from a new **generator version 2**, written in Go. The
    existing Go entity and loot code (`gen_v1.go`) can be reused inside it.
  - Entity ids keep the `kind:cx:cy:index` shape and are deterministic and stable within a v2
    epoch. They are not compatible with v1.
- **The cutover is explicit.**
  - `content/wilds.json` moves to `generatorVersion: 2`.
  - The upgrade deletes every v1 epoch and its rows: entity state, personal claims, discoveries,
    lanterns and lantern rewards. The weekly `warden_finds` and `storm_finds` caps stay.
  - A v1 epoch is never read with v2 code: the server refuses any epoch whose version it lacks
    (`generator-unavailable`, as today).
  - Saved places in the Wilds are reset to a verified spot (section 8).
  - The client's chunk cache is keyed by contract and generator version, so no old terrain is
    ever drawn.
- **What's tested** (Go goldens and invariants, not parity):
  - every exit and every entity is reachable from the spawn on walkable tiles;
  - neighbouring chunks' exits line up;
  - sites stand on walkable tiles;
  - entity ids and loot rolls are deterministic per epoch;
  - the chunk decodes completely;
  - it stays within the size and time budgets (3.3).

  The golden fixtures are new chunk hashes for a few fixed seeds, captured from the v2 generator.
- **Retired directly:** the TS generator and terrain code, `scripts/wilds-vectors.ts`,
  `content/vectors/wilds.json`, and both sides' Wilds parity tests.

### 3.2 The message

Units: grid positions and sizes are **tiles**; decor offsets are **pixels**; `Exit.entry` is a **tile** in the destination. Cells
are numbered row-major, `i = y × size + x`.

```proto
// proto/glimway/v1/wilds.proto
message WildsChunk {
  string epoch_id = 1;          // each chunk names its own epoch (per-chunk epochs later need no change)
  string region = 2;            // "inner-1" | "outer-1" today
  string realm = 3;             // "hearthwick"; reserved for realms
  sint32 layer = 4;             // 0; caves later are -1
  sint32 cx = 5;
  sint32 cy = 6;
  uint32 generator_version = 7; // 2
  uint32 size = 8;              // 24 tiles
  repeated string palette = 9;  // ground ids used in this chunk, at most 16
  bytes ground = 10;            // 4 bits per cell; cell i is byte i/2, low nibble for even i
  bytes solid = 11;             // 1 bit per cell; cell i is byte i/8, bit i%8 (least significant first)
  repeated Exit exits = 12;
  DecorList decor = 13;
  repeated StorySite sites = 14; // geometry only, never who or what is there for a player
  Tile spawn = 15;
  string look = 16;             // "tangle" | "outer"
  string mark = 17;             // the season's Mark for the outer look; empty when permanent
  repeated WildsEntity entities = 18; // immutable camp/node/chest/POI bodies, including enemies/material/tier/poi
}

message Tile { uint32 tx = 1; uint32 ty = 2; }

message Exit {
  uint32 tx = 1; uint32 ty = 2; uint32 tw = 3; uint32 th = 4; // the doorway rectangle, tiles
  Dir dir = 5;                  // north, east, south, west
  string to = 6;                // the area id it leads to: "chunk:<region>:<cx>:<cy>" or "commons"
  Tile entry = 7;               // where the hero arrives in `to`, in its tiles
}

// Struct of arrays, so ~400 pieces pack tight. Only piece arrays have the same length; kinds is a dictionary and flags packs two bits per piece.
message DecorList {
  repeated string kinds = 1;    // decor kind names used in this chunk
  repeated uint32 kind = 2;     // index into kinds
  repeated uint32 tx = 3;
  repeated uint32 ty = 4;
  repeated sint32 ox = 5;       // pixel nudge from the tile's bottom centre
  repeated sint32 oy = 6;
  repeated uint32 variant = 7;
  bytes flags = 8;              // 2 bits per piece: bit 0 flip, bit 1 overhang
}

message StorySite { string id = 1; SiteKind kind = 2; uint32 tx = 3; uint32 ty = 4; }
```

**Validation, on both sides:**

- Before generating or storing, the server checks that `cx` and `cy` are integers inside the
  region's grid and that the epoch belongs to the caller's world.
- On decode, the client checks:
  - `palette` holds at most 16 entries;
  - `ground` is exactly `size²/2` bytes and `solid` exactly `size²/8`;
  - every nibble indexes the palette;
  - the per-piece DecorList arrays (`kind`, `tx`, `ty`, `ox`, `oy`, `variant`) have equal
    lengths; `kinds` is a palette, `kind` indexes it, and packed `flags` covers every piece;
  - every tile lies inside the chunk;
  - every `to` is a known area or a valid chunk of either known region (including the
    Tangle/Whitequiet crossing and return); `entry` is inside the destination grid, not the
    source grid. The chunk and its immutable entity/site tiles must also be in bounds.

  A chunk that fails is dropped and fetched again; it is never drawn.

**Size.** A sampled chunk today carries about 380–390 decor pieces (seed `review-seed`, chunk
(1,2)). That puts the whole message at about 3–4 KB, not under 1 KB, plus HTTP compression.
**Budget:** at most 6 KB raw per chunk, and at most 30 KB compressed for a region's nine. Lane D
measures both on its golden seeds and reports them before the client work starts.

### 3.3 Serving and caching

- **Generated once, at epoch creation.** When an epoch is created, the server generates all nine
  chunks and stores them in `wilds_chunks(epoch_id, cx, cy, generator_version, blob, created_at)`,
  in the same transaction. A stored epoch therefore never needs its generator again, and there is
  no race on a first read. (The open map can't pre-generate an unbounded map; it will need the
  rule "keep a generator while an open epoch references it".) An in-memory LRU of about 512
  chunks sits in front.
- **`GET /api/wilds/chunk/{epochId}/{layer}/{cx}/{cy}`.**
  - Binary protobuf (`application/x-protobuf`). It's a new route, so the "HTTP stays JSON" rule
    in `proto-migration.md` covers only existing routes.
  - The session is enough; no lease.
  - The epoch must belong to the caller's world.
  - Ended epochs answer `epoch-ended`.
  - `Cache-Control: private, max-age=31536000, immutable`.
- **The client never trusts a cached chunk on its own.** It starts play or fetches new chunks only for the
  epoch a fresh region read has just named. A previously validated cached view may remain
  visible while disconnected, labeled stale and with entry/interactions disabled. So a chunk cached in the HTTP cache or IndexedDB can
  never stand in for an `epoch-ended` answer. The IndexedDB store `glimway-chunks` is keyed
  `<contract>:<generator_version>:<epochId>:<cx>:<cy>`; entries of ended epochs and of older
  contracts are deleted at start and at each turning.
- **Claims and loot read the stored chunk** instead of regenerating all nine chunks per request,
  as they do today (`wilds.go:111-130,322`, `gen_v1.go:235`).
- **Budget:** a Go benchmark of 5 ms per chunk at p95 (world.md). A region's nine chunks are
  generated at once, so creation stays under about 50 ms.

### 3.4 The region view, entities and Echoes

`GET /api/wilds/region/<id>` stays the changing-state read: the epoch, cycles, entity state,
personal claims, discoveries, lanterns, and now **this player's Echo assignments**. It drops the
full entity bodies, which now come in chunks.

- **The one write it keeps: creating the epoch.** If the region has no current epoch, the read
  creates it (with its nine chunks) in its transaction, exactly as `ensureEpoch` does today
  (`wilds.go:41-84`). That's the explicit exception. Otherwise the read writes nothing.
- **Cycles are projected, not written.** For a camp or node whose stored state is depleted and
  whose `available_at` has passed, the read shows it available at `cycle + 1`. That's **exactly
  one** new cycle, however long the absence, as today (`wilds.go:143-149`). An entity with no
  row shows cycle 0, available. A claim applies the same projection inside its transaction,
  requires the request's cycle to equal it, and then writes it. No generic periodic function
  advances cycles.
- **Echo assignments are per player.** Chunks hold only site geometry. Who waits at each Echo
  site depends on the epoch **and on whether this player's road is lit** (`stories.ts:39-49`).
  The rule moves to Go: the same inputs, Tam only in the east column, the twins only when the
  road is lit, each member at most once per epoch. It is computed per player from server quest
  state, and the region view carries `echoes: [{site, member, settled}]`. `settle-echo`
  recomputes the assignment and accepts only that member.
- **Claims and relights:** today's rules, with `where` instead of uploaded progress. A claim of a
  paper-bearing POI or a tier-3 chest grants its paper in the same transaction (2.2).
- **Where you are:** `Where.area` carries the region (`wilds:inner-1`, `wilds:outer-1`), so the
  server knows which region you're in. The client-only `wildsRegion` marker goes.
- **Homestead land** follows the same rule: the server sends each home's land grid with the
  homestead view, and `generateLand`, `landSeed` and the land half of the `homestead.json`
  vectors go. Consumers to move: `game/homeland.ts`, `entities/homestead-art.ts`,
  `homestead-placement.ts`, `homesteads.ts`, `WorldScene`'s home building, `world-dev-hooks`.

The region read creates a missing epoch but never records player placement or turning.
Area transitions reach the server through reports/keyed `where` only. Stored chunk keys are
`(epoch_id, layer, cx, cy)`; world/realm are determined by epoch ownership. Layer is 0 now.
D's lookup must ignore epochs with a non-current generator version, including v1 epochs
created on an intermediate development branch after the one-time 027 reset.
Homestead views can fetch supplemental `GET /api/homestead/land/{gate}`: the immutable grid
has `generatorVersion: 2`, width/height and row-major cells named `grass`, `tree`, `stump`,
`boulder`, `water`, `ford`, `slope`, `edge`, `path` (the corresponding client LAND vocabulary).

### 3.5 What the client still needs locally

- Ground and solid grids, to paint and to build static collision bodies (`area/collision.ts`).
- Exits with their arrival tiles, and the spawn, for transitions and arrival.
- Decor (with offsets, flip and overhang) and site geometry, to draw them and offer interactions.
- The season's Mark, for the outer look.
- Entity positions and camp mixes, to spawn the local camp enemies.
- This player's Echo assignments, from the region view.

Movement and collision are predicted entirely on the client, as today. The server never checks a
path.

### 3.6 What this mustn't block

- Per-chunk epochs: each chunk carries its own `epoch_id`, and storage is keyed by it.
- The open map's global coordinates: `realm`, `layer`, signed `cx`/`cy`.
- `Where.area` is an open string, so `wilds:<realm>:<layer>` can replace region ids later.

Nothing here assumes a fixed 3×3 except pre-generation at epoch creation, which the open map
replaces with on-demand generation.

---

## 4. Combat's boundary

**On the player's screen:** movement, enemies (camp mixes and curated), hits, crits, damage
taken, dodges, the Warden's speakings. There is no server enemy simulation in this release.

| | The server checks | The server trusts (friends on invites) |
|---|---|---|
| **Defeating a curated enemy** | `mark` with a `defeated:` id from the area's list in `content/story.json`, in that area, once | That the fight happened |
| **Settling the Warden** | `quest-step` to `guardian-defeated`: previous step done, area `ruin`. Pays 2 embers once | That three speakings happened |
| **A Wilds camp** | Claim: the epoch, the entity id in the stored chunk, the projected cycle, availability, reach of `where`, 20 claims a minute, once per cycle | That its enemies are down (as today; closes with shared fights) |
| **Loot** | All of it: the server rolls it and grants it | Nothing |
| **HP** | Reports may only lower it, except a healer's heals: no more casts than the cooldown and the mana available allow, each healing the server's own amount from the account's stats. Other raises come only from server operations (`rest`, `home-rest`, consumables, `profile`, `fall`). The zero-HP lock carries over | How much damage was taken |
| **Mana** | Never above `min(max, stored + 16/s × elapsed)` | When and whether it was spent |
| **Falling** | `fall` decides recovery and place. The lantern keeps its limits | That the hero fell, and where |
| **Rests** | `spend rest` in the village, `home-rest` on your own plot (from `where`), as today | — |

**What a modified client can still do** in 0.3, under the friends-on-invites trust:

- never take damage, by under-reporting;
- cast without paying, by leaving casts out of its reports. The mana bound is an upper bound, not
  the true balance; stored mana can sit above real mana by up to `regenCap × elapsed`;
- heal as much as an honest healer casting as often as the cooldown and mana allow;
- fall on purpose, to get the recovery vitals and the walk home;
- clear camps without fighting, and claim curated defeats and discoveries without visiting;
- stand anywhere for reach checks, since `where` is trusted.

What it can no longer do: heal itself beyond those bounds, raise mana above the bound, skip quest
steps, forge papers, Echoes or the turning, unlock heirlooms, or pay quest gifts twice.

For magic ([magic.md](magic.md), "Cost"), workings check the server's bound. A working never gets
more mana than honest regen could have given, which is all this release promises.

---

## 5. Groundwork

| Piece | This release | What to build |
|---|---|---|
| **`account_id`** (guests.md step 1) | **Needs it** | Accounts get an opaque `account_id`. Existing players keep their Habitica id as the value; **new accounts get a random id** (`store.Random`). `sign_ins(account_id, method, subject, secret_hash, created_at)` with **unique `(method, subject)`**, backfilled with one `habitica` row per player. Login verifies Habitica, then finds the account through `sign_ins(habitica, <user id>)`; none means a new account with a random id plus its sign-in row. `profile` compares the reported profile id with the account's Habitica subject, never the account id (today `sync.go:38` compares it with the player id). See "Which columns rename" below |
| **Profile source seam** (step 2) | **Needs it** | `players.profile_source` (`habitica`). One Go function (`profile.For(account)`) and one TS module (`lib/profile.ts`) answer name, look, class, level, stats, companions and ember earning. Every reader of the imported profile goes through them, including presence avatars (`presence_auth.go:26-28`). A Go test checks that nothing else reads `profile_json` |
| **Server-owned mana** | **Needs it** | The report bounds and refills as operations (sections 2.2 and 4). Stored in `player_vitals` with the persistent report/cast fields specified in 2.2 |
| **The clock module** | **Needs a small part** | `content/clock.go` and `src/lib/clock.ts` grow out of the calendar: `calendarAt`, `nextTurning` and `recovered(stored, rate, cap, since, now)` (the mana bound). Shared vectors in `content/vectors/clock.json`, replacing `calendar.json`. Resident cycles (0.4) add their helper when they arrive. Entity cycles don't use a periodic helper (3.4) |
| **Rule tables in `content/`** | **Needs these** | `quests.json`: the **lantern road only**, in [quests.md](quests.md)'s format (step 1 of its build order). Step ids are today's stage names, so `accepted` … `complete`. `story.json`: mark namespaces, writer, id lists, areas. `vitals.json`: regen cap, fall recovery. `combat.json`: per-class cast cost, cooldown and the heal formula's constants (`combat.ts` reads them from here). `papers.json`: full find rules. Go and TS both load each file; the loaders validate |
| **The ability table** | Shouldn't block | `combat.json` is shaped so magic's ability table (0.5) extends it |
| **World changes with expiry** | **Not in 0.3** (owner, 2026-10-07: deferred to 0.5) | No 0.3 operation writes one. The chunk key (`epoch_id`, layer, cx, cy; realm from the epoch) and `entity_state` already carry what the table's key needs. It comes with its first writer in 0.5 (fishing depletion or the first working) |

**Which columns rename.** Lane A's first substep lists every table. The rule:

- A column that means *the player in this game* becomes `account_id` and a foreign key to
  `players`. Examples: progress, balances, ledger, items, homes, mail, claims, sessions,
  idempotency, deeds.
- A column that means *a Habitica identity*, possibly before any account exists, stays a Habitica
  subject and is not a foreign key. Examples: `allowlist`, `pending_sessions`, the login
  limiter's user buckets, party admission records, `invites.used_by` where it names who redeemed.
  These look accounts up through `sign_ins` when they need one.
- Party ids stay Habitica party ids.

---

Only newly created accounts have opaque random ids. Historical accounts retain their Habitica
subject as account id, visible in presence, world ownership and mail. All auth joins use the
Habitica sign-in in 0.3; guest step 3 replaces that assumption.

## 6. The protobuf side

This release finishes slice 2 of `docs/proto-migration.md` ("Session, identity and snapshot
envelope": profile, progress, save, envelope). It also covers the play, progress, sync and spend
half of slice 8, plus the chunk and region messages.

- **Profile:** two messages.
  - `HabiticaUser` is the **input**: the raw `/user` projection the browser posts, limited to
    `USER_FIELDS`, with size limits and shape validation.
  - `HabiticaProfile` is the **output**: the mapped profile, in the envelope and in
    `checkpoint_json`.
- **Progress:** no message. It's deleted. Its parts live in `PlayerState`.
- **Save:** no message. The guest save is deleted.
- **Envelope** (`proto/glimway/v1/state.proto`):

```proto
message PlayerState {
  double version = 1;           // the one state version; doubles for counters, per the shape rules
  Account account = 2;          // account_id, display_name, profile_source, party_id, world_id, flagged
  HabiticaProfile profile = 3;  // absent for profile_source "none" later
  Vitals vitals = 4;            // hp, mana, max_hp, max_mana, report_seq, report_client, report_generation,
                               // vitals_set_version, vitals_at (seconds), cast_ready_at (fractional seconds)
  Place place = 5;              // area, x, y
  Story story = 6;              // map<string,string> quests; repeated string marks, discoveries,
                                // defeated, quest_items; double play_seconds
  Embers embers = 7;            // balance, xp_earned, pending, xp_mark, verified_xp
}
message ReportBarrier { string client = 1; string generation = 2; double seq = 3; }
message OpHeader { string lease = 1; string key = 2; ReportBarrier report = 3; }
message Where { string area = 1; double x = 2; double y = 3; }
message ErrorDetail { string code = 1; }
message Refusal { ErrorDetail error = 1; PlayerState state = 2; }

message Envelope {
  PlayerState state = 1;
  oneof result {                // one typed result per new operation
    ReportResult report = 10;
    QuestStepResult quest_step = 11;
    MarkResult mark = 12;
    TakePaperResult take_paper = 13;
    SettleEchoResult settle_echo = 14;
    FallResult fall = 15;       // recovered vitals, place, lantern: placed | none + reason
    ProfileResult profile = 16; // credit, pending, vitals credit
    SpendResult spend = 17;
    WildsClaimResult wilds_claim = 18;
    WildsLanternResult wilds_lantern = 19;
  }
}
```

Profile has its own `ProfileAppearance`; presence evolution cannot change the state contract.
Raw Habitica pet/mount maps use `google.protobuf.Value` to retain null/zero/negative/boolean
ownership values; only Habitica mapping decides ownership. All timestamp fields are Unix
seconds (fractional cast readiness), and HTTP numbers are finite JSON numbers.
After 028, `Story.discoveries`/`defeated` are compatibility projections derived from
`found:`/`defeated:` marks, never independent counters. C2 uses marks as the single source.
Witness flags compose a bounded beat/account id and a human name: their mark input allows 256 UTF-8 bytes, including spaces/Unicode in the name. Ordinary payload ids retain the 128-byte character restriction.
All authenticated unfinished handlers answer `409 not-implemented` with state, including
chunk and land reads; this remains retryable during lane integration.

**Fields and identity.** `Vitals` includes HP/mana/maxima, report client/generation/seq,
`vitalsAt`, `vitalsSetVersion`, and `castReadyAt`. `Embers.xpEarned` is the **remaining spendable
XP-earned balance** (`xpEmbers`), not lifetime earnings. `xpMark` is the paid XP high-water;
`verifiedXp` the last verified checkpoint's lifetime XP; `pending` the held ember amount.
`QuestStepResult` returns the committed quest/step plus items, marks, papers and embers
newly granted by that transition. `MarkResult`/`TakePaperResult.added` indicate a new grant;
a replay returns the original value. `SettleEchoResult` identifies epoch/site/member and
its granted paper (empty if that settlement has no paper). `ProfileResult.status` is `synced`
or `unchanged`; `credit` is the embers added now, `pending` is the resulting total held amount,
and `vitalsCredit` is signed HP/mana change. `SpendResult.outcome` keeps `lit:<target>`,
`opened:<chest>` or empty for rest. Claim results include mutable entity state, loot, resulting
material balances, rare-find booleans and papers newly granted. Lantern results include the
epoch, whether a reward was given, loot, resulting balances and current lanterns.
Result quantities/timestamps/counters are JSON numbers, optional identities are wrapper nulls,
and missing output lists/maps are emitted `[]`/`{}`. `FallResult.lantern` is `placed` or `none`,
with reason `not-wilds`, `invalid-place`, `epoch-missing` or `daily-cap`; successful placement
returns its epoch/id. A site paper identifies `epoch` and `site`; settlement includes the
expected `member`, rejecting a stale assignment. Site kinds are echo/given/cairn/nest/reeds/plank.

`SessionResponse` has one alternative: `state` or `worldChoice` (the latter holds a Habitica
subject, since no account exists yet). `StateResponse` adds required `leaseActive`;
`PlayResponse` adds `lease`, `reportClient`, `reportGeneration`. The generated request/reply
schemas and `api/operations.ts` are C1/C2's facade; current game callers use the documented
Snapshot projection until C2 rewires them. All errors use `{error:{code}, state?}`; auth/lease
errors omit state. `ApiError.state` retains only validated `PlayerState`.

**Domains not yet on protobuf** (items, homesteads, mail, crafting, repairs, projects, worlds:
slices 3–7). Their requests take `op` and `where` in place of `lease`/`baseRev`/`progress`, but
keep their JSON results. On the wire their answer is `{"state": <PlayerState as ProtoJSON>,
"result": <today's JSON result>}`. Go writes it with one adapter (`writeMixed`): ProtoJSON for
`state`, `encoding/json` for `result`. TS decodes `state` with generated code and `result` with
the existing result parser. Embedded `Snapshot` fields are removed from each domain's result;
read extras become `result` (for example items `{items}`, storage
`{home,inventory,storage,personal,shared}`, mail `{mail,nextCursor,nextPendingCursor,inventory}`);
keyed mutations keep the current `result` object. No `rev`, `version`, account metadata or
progress document is nested into the result. `decodeMixed` accepts a domain-specific result
parser and validates state first. The Go `server-first.json` fixtures freeze both typed and
mixed empty/populated result shapes. Each domain moves its `result` into the oneof when its slice migrates.

**Also in this release:**

- **Presence v2.** V1 definitions remain in `glimway.v1`, deprecated for generated-source compatibility.
  New `glimway.v2` presence messages carry `account_id` with the same event vocabulary.
  Runtime readers/writers use only v2; v1 can be deleted in a later release. The subprotocol becomes `glimway.presence.v2`, so old
  tabs are closed with 4005 (section 8).
- **New error codes**, appended to the enum: `reload-needed` (HTTP), `not-next-step`,
  `wrong-area`, `unknown-mark`, `server-mark`, `paper-not-due`, `echo-not-here`,
  `not-implemented` (while the integration branch is being built), and `report-required`
  (retry after the report barrier).
- **The contract number** (`X-Glimway-Contract`) lives in `content/contract.json`, read by both
  sides.
- **Fixtures:** zero, empty and populated cases for every new message and the mixed adapter.
  Go-written, read by `tests/proto-contract.test.ts`.
- **Code generation.** `npm run proto` regenerates everything (`clean: true`). Only one change to
  `proto/` is in flight at a time: lane A writes the contracts; afterwards any lane's proto change
  is a small change of its own on the integration branch, regenerated there, and the other lanes
  rebase onto it.

---

## 7. Tests

### 7.1 E2E

The brief's "about 14 of 49" is low. **17 spec files never use the server**, 10 more are mixed,
and 3 server specs carry guest tests (`e2e/fixtures.ts` blocks `/api` unless `server: true`).

- **The harness.** The `server` option goes, and the auto fixture keeps only its server half:
  today `noServer` both starts the worker's backend and routes the browser to it
  (`e2e/fixtures.ts:45-55`, `routeToBackend`). Rename it (`backend`) and keep that, so every test
  gets a backend and routing. A fake-Habitica hero replaces the demo hero.
- **The clock in tests.** Display tests may keep the dev calendar hook (`__fsDevCalendar`), which
  deliberately bypasses the server calendar (`src/game/village.ts:128-139,182-185`). Tests whose
  rewards depend on the date need a server clock: a test-only `-dev-clock` flag on the test
  server (lane B).
- **New helper:** `seedStory(accountId, {quest, marks, place})`, writing the new story tables with
  `sql()` and replacing the guest `seedSave`. Some specs already do this with SQL on `doc_json`
  (`heirlooms.spec.ts:78`, `playtest1.spec.ts:191,211`).
- **Helpers to delete** (`e2e/helpers.ts`): `beginNewJourney`, `mockHabitica`,
  `rememberedRecord`, `savedRecordText`, `savedToDisk`, `seedSave`, `savedFlags`, `savedStage`.
  `savedToDisk` waits become waits on server state.
- **The audit.** Every spec importing these helpers is checked, `wilds-screens.spec.ts` included.

| Specs | Today | Move to the test server with | Delete |
|---|---|---|---|
| quest (**@smoke**), camera, touch, touches, talk, goal, mill, first-paint, atlases, naming-screens, art-screens, art1-screens, density-screens | Guest | `freshPlayer` | — |
| sprite-anchors | `goto('/')` only | Nothing, if the title still draws; otherwise `freshPlayer` | — |
| combat | Guest; the Warden test reloads a saved stage | `freshPlayer`; `seedStory` for the Warden; a server-state wait | — |
| residents | Guest; `seedSave` for Hazel's card; the dev calendar | `seedStory`; the display tests keep the dev calendar | — |
| village (`:41, 71-76`) | Guest festival and board tests | The festival test, with the dev calendar | The guest board test (rewrite it for the server board if it isn't covered) |
| papers, papers-screens | Guest | `seedStory` for paper marks (tests 1, 3, 4) | The guest library test (covered by connected "shared library shelf") |
| embers | Guest | The lantern and chest test, with `earnEmbers`/`fund` | The sample-hero test (covered in `connected.spec`) |
| inventory, polish | Mixed | `fund`/`giveInstance` | polish's sample-hero sync |
| playtest1 | Mixed | Fake-Habitica hero | — |
| version | Mixed | The new-build notice; "odd answers"; a new `reload-needed` test | "guest Reload… slow final write" |
| whats-new | Guest | `freshPlayer`; localStorage stays | — |
| onboarding, onboarding-layout | Guest title, local connect, remembered credentials | Paste parsing, the guide tabs and Remember/Forget, on the new title | Guest start, local connect, Pip's guest nudge |
| wilds-outer | Guest Echo and turning | Seed `worlds.seed`; Echo assignment and `wilds:turned` from the server; reload into place becomes a server-place test | — |
| wilds (server) | — | — | "guest: the Tangle is explorable with local claims" (its **@smoke** tag moves to the connected claim test) |
| homestead (server) | — | — | Both guest tests |
| connected (server) | — | Rewrite "offline play keeps going" for the outbox; add "a refused step rolls back" and "lease lost keeps the outbox" | `describe('no server')` (2), "login + bring save" (**@smoke**; the tag moves to "login + fresh start"), "logout… returns to guest play", "offline play meets newer progress… story merges" |
| connected-screens | — | — | The origin screen and "Signed out with a guest save" |
| review-fixes:77 | Calls `beginNewJourney` | `freshPlayer` | — |
| review5-fixes:171-176 | A local clock test | `freshPlayer`; keeps the dev calendar (display only) | — |

Every test now starts a backend in its worker, so the full suite gets heavier. It still runs once,
at the integration gate (section 9), as [testing.md](../testing.md) asks. CI already runs smoke and full Playwright jobs. Verify/protobuf/unit gates remain required
between lane merges. Intermediate lane and integration branches are expected to fail e2e until
the coordinated cutover is complete; the owner reviews those failures, and the full integration
gate must pass before release. This lane does not run e2e or disable its CI jobs.

### 7.2 Unit and parity tests that retire

**TS, deleted:**

- `save.test.ts`, `save-v2.test.ts`, `save-current.test.ts`, and the guest parts of
  `stores.test.ts`.
- `habitica-sync.test.ts`, `habitica-mapping.test.ts`, `api-progress.test.ts`,
  `wilds-vectors.test.ts`.
- The generation parts of `wilds.test.ts`, `wilds-runtime.test.ts` and `wilds-outer.test.ts`.
- The origin parts of `account-flow.test.ts`; the guest-nudge parts of `remembered.test.ts`.

**TS, shrunk:**

- `embers.test.ts`: `checkSpend` only.
- `backend-content.test.ts`: the economy shape, without the `backend.json` drift check.
- `homestead-land.test.ts`: the lookups and post names.
- `hash.test.ts`: the float half.
- `link.test.ts`, `link-recovery.test.ts`: rewritten for the predictor, queue and outbox (below).

**Vectors and parity:**

- `content/vectors/backend.json`, `scripts/backend-vectors.ts` and `rules/parity_test.go` go. The
  Go rules keep their own table tests.
- `content/vectors/wilds.json`, `scripts/wilds-vectors.ts` and both Wilds parity tests go
  directly. The new Go goldens replace them (3.1).
- The land half of `homestead.json` goes with the TS generator.
- **Kept:** `calendar.json` (renamed `clock.json`), `items.json` (the stated exception),
  `post-names.json`, the proto fixtures.

**New TS unit tests** (lane C2):

- adoption by version;
- predict, re-apply and drop on refusal;
- head-of-line blocking on transport failure;
- lease loss keeps the outbox and never takes over on its own;
- persist before send;
- the six-day expiry;
- report coalescing (casts summed, `seq` kept across reloads);
- the logout and storage-failure paths.

**Go, rewritten.** The helpers `mutation()`, `syncBody()` and `spendBody()`
(`test_helpers_test.go:137-146`) build `{lease, baseRev, progress}`. They change once, and their
callers follow mechanically. These tests are about the upload itself and get deleted or rewritten
as operation tests:

- `api_test.go`: `TestProgressCurrentStaleAndServerAuthority`,
  `TestStaleAfterSyncRestRevivePurchaseAndIdempotency`,
  `TestOwnedUploadTypesAreIgnoredAndUnknownCredentialsStripped`, the three migrate/origin tests.
- `fixes_test.go`: `TestMergedUnionBoundRollsBack`, `TestHealerProgressRemainsWritable`.
- `round2_test.go`: `TestRound2FStaleAndEarnedRevive`.

### 7.3 New Go tests

- **report:**
  - HP can't rise for non-healers;
  - a healer's rise needs integral, cooldown-bounded, affordable casts, at the server's heal
    amount;
  - no heals at 0 HP or under the lock;
  - honest sequences never clamp: casting, regenerating and casting again;
  - the mana bound;
  - an older `seq` is ignored, and a retried `seq` counts its casts once;
  - a report with an old `basis` can't undo a rest or a fall;
  - play time accrues with the gap cap and none for the first report after a lease.
- **Versions and replay:**
  - every writer bumps the version;
  - a replay returns the stored result with the current state and a higher version;
  - a replay under a new lease is accepted;
  - a changed `where` under the same key is `idempotency-mismatch`.
- **Refusals** carry state only after the session and lease checks; unauthenticated failures
  don't.
- **quest-step:**
  - each legal transition, with the items, marks, papers and gifts it grants;
  - skipping a step or the wrong area is refused;
  - gifts pay once across replays and devices;
  - the witness relay comes only from the step.
- **mark:**
  - `client` namespaces are accepted;
  - `server` namespaces, unknown ids and wrong areas are refused;
  - the caps hold;
  - a table test checks that every reward's flag read is a `server` namespace.
- **Papers:**
  - every source row in 2.2: placed reach and stage; NPC stage and area; project eligibility;
    Commons facts and Carting Day; board, site and turning rules; claim-granted papers;
  - unbuilt papers are refused everywhere;
  - `scripts/papers.ts` keeps the full rules: a test that regenerating the file leaves it
    unchanged.
- **settle-echo:**
  - the assignment matches the TS rule's intent: Tam east only, the twins late, each member once;
  - another player's assignment or an already-settled member is refused.
- **fall:**
  - the recovery numbers with ceiling rounding;
  - the lantern only on a valid Wilds tile;
  - at the daily cap the fall succeeds with `lantern: none`;
  - a curated-area fall needs no Wilds.
- **spend and profile:**
  - today's tests without uploads;
  - reach from `where`;
  - a raw profile with the wrong Habitica subject is refused;
  - zero-HP rest needs earned embers.
- **No upload survives:**
  - `PUT /api/progress` is 404;
  - a route-table test posts a body with `progress` and `baseRev` to every route and checks
    they're refused as unknown fields, with no change.
- **Contract gate:** a missing or old `X-Glimway-Contract` gets `reload-needed`; health and
  calendar don't need it.
- **Chunks and regions:**
  - world isolation; `epoch-ended`;
  - all nine chunks are stored at epoch creation, and two concurrent first reads make one epoch;
  - decode validation (bad nibble, short grid, mismatched decor arrays);
  - the goldens and invariants (3.1);
  - `BenchmarkChunk` within 5 ms p95, and the size budget;
  - the region read writes only on epoch creation;
  - the cycle projection gives exactly one cycle after a long absence, and a claim persists it;
  - Wilds gathering checks the target kind near `where`.
- **Accounts:**
  - a new account gets a random id and a sign-in row;
  - `(method, subject)` is unique;
  - login finds the existing account through `sign_ins`;
  - allowlist and pending sign-ins still work by Habitica subject;
  - only `profile.For` reads `profile_json`.
- **Upgrade** (section 8).

---

## 8. The upgrade

One forward path. The owner takes a backup first (`home-server.md`). The migrations run in order
in one start-up, and each ends with `PRAGMA foreign_key_check`.

1. **026 accounts** (lane A).
   - Before anything else, **players who never chose an origin** (`save_origin IS NULL`) are
     finished the way the fresh choice would have done (`origin.go:54-70`):
     - `profile_json` comes from their verified `sync_baselines.checkpoint_json`;
     - HP and MP come from it, capped at its maxima;
     - the XP mark is `checkpoint_xp`;
     - the progress document keeps its defaults.
   - Then the renames, by the rule in section 5. `sign_ins` gets one `habitica` row per player.
     `players.profile_source` is set to `habitica`.
   - `save_origin` and `save_origin_at` are dropped. If the bundled SQLite can't `DROP COLUMN`,
     they are left in place, unused.
   - **`idempotency` is cleared**, since the envelope's shape changes here.
2. **027 schema** (lane A).
   - The new tables: `player_vitals`, `player_place` (with `last_outer_epoch`), `quest_progress`,
     `story_marks`, `wilds_chunks`; `players.version` and `players.play_seconds`.
   - **The Wilds reset:** every v1 epoch is deleted with its entity state, personal claims,
     discoveries, lanterns and lantern rewards. The weekly find caps and the ledger stay.
3. **028 the progress document** (lane B), one transaction:
   - **Vitals.** `hp` and `mana` are clamped to the baseline's maxima. `vitals_at` is now and
     `vitals_set_version` is the new version.
   - **Place.**
     - Any `wilds` place is reset to the Commons, at the Tangle arch: a curated, walkable spot,
       since the terrain is regenerated and the region was never stored.
     - Unknown areas are reset to the village spawn.
   - **Quest.** The stage maps to `quest_progress('lantern-road', <stage>)`; step ids equal
     today's stage names, and `new` means no row.
   - **Gift outcomes.** `quest-gift:defeat-guardian` and `quest-gift:return-village` are renamed
     to `quest-gift:lantern-road:guardian-defeated` and `quest-gift:lantern-road:complete`, so no
     gift pays twice.
   - **Marks.**
     - 028 clears and rebuilds `story_marks` and `quest_progress` from the document; the 027 bridge's append-only rows and `server` writer labels must not be trusted. Flags become `story_marks` under their namespace's writer. Economy flags stay in
       `outcomes`.
     - Discoveries become `found:` marks and defeated enemies `defeated:` marks.
     - `inventory` is normalized: only the four quest items, deduplicated, as `quest-item` marks.
     - **A flag in a namespace `story.json` doesn't know stops the migration** with its name. It
       is never dropped silently. Run it on a copy of the owner's database first.
   - **Turning.** A player holding `wilds:turned` keeps it as a server mark.
     `last_outer_epoch` stays empty, since no v1 epoch survives.
   - **Rest.** Increment the current `players.version` once through `BumpVersion`; never derive it
     from `progress.rev`, which can lag after login/play/maintenance in the A bridge.
     `play_seconds` is copied. Then the
     `progress` table is dropped. Entitlements (outcomes, heirloom flags, paid papers, the
     ledger) are untouched apart from the gift renames.

**Upgrade tests**, from fixture databases in the existing `upgrade_fixture_test.go` pattern:

- a player with a null origin;
- a player with the story complete, gifts paid, papers, Echoes and heirlooms;
- a player saved in the Wilds;
- a player with an unknown flag (the migration stops).

After each upgrade: the column renames, the split tables, the gift renames, unchanged ledger sums,
`foreign_key_check` clean. Then a real first login through the fake Habitica and a first action
(`report`, then `quest-step` or `spend`) succeed.

**Old clients.**

- Presence moves to `glimway.presence.v2`, so an open 0.2 tab's socket closes with 4005
  (`presence_socket.go:74-80`).
- Every stateful `/api` call without the new contract header answers `409 reload-needed`, so nothing an old
  client sends is written. Health, calendar and immutable sprite routes remain public.
- The 0.2 client doesn't know that HTTP code, and its 4005 handling stops presence without a
  prompt. So **an old tab shows errors until its periodic build check offers the reload**
  (`version.ts`, dismissible). That's acceptable with one player.
- From 0.3 on, clients show the reload notice on `reload-needed`, from HTTP or presence, so later
  contract bumps get a proper prompt.

---

A handoff checks 026/027 on a copy of the owner's database before release. Unfinished-origin
profiles use a logged deterministic fallback: valid profile_json, then checkpoint_json, with
verified_xp retained as the XP mark; otherwise NewState and no imported profile. Incomplete
old evidence never prevents startup. The connected cache makes a clean break with old
`habiticaId` IndexedDB entries; C1 shows the "wasn't kept" notice instead of silently implying
those queued changes survived.

## 9. Lanes

**One integration branch.** Lanes branch from `exp/server-first` and merge back into it, not into
`expansion`.

- Between merges the old client doesn't have to keep working; nobody plays on this branch.
- Each lane keeps `go test`, `npm run verify` and its own unit tests green on the branch, and runs
  only its own changed e2e specs at the end.
- The full e2e suite runs once, at the **integration gate**, after the last lane merges. The
  owner's playtest follows. Then `expansion` receives the release.

**Contracts first.** Lane A merges first. It lands:

- the protos for the envelope and for every operation's request, result and refusal;
- the error codes and the contract number;
- the `ChunkSource` interface (Go and TS) with fakes;
- the op helper, the refusal writer, the contract gate;
- route stubs for every new operation;
- the schema migrations.

B, C1, C2 and D then build against fixed interfaces, using fakes where another lane's work isn't
in yet.

**Fixed ports and bridge (A2).** Go `store.StateComposition` loads/persists snapshots and
projects `PlayerState` in the caller's immediate transaction. A's `DefaultStateComposition`
keeps the old document as the intermediate truth, mirrors vitals/place on persist, and uses
only `players.version`; B replaces it in `store/state.go` with 028. Migration 027 populates
these rows from retained documents; new player creation also
initializes normalized vitals/place. Quest and mark rows are mirrored on persist, without
removing unknown legacy flags before B classifies them in 028. `BumpVersion` centralizes increments;
peer/maintenance writers bump each affected account in the same transaction. Replay never bumps.

`chunks.ChunkSource` reads a world's stored chunk in that transaction; helpers read entity and
decor geometry without generation. `chunks.EpochComposition.Current(ctx, tx, world, region, now)` never creates: absent/current-generator mismatch is `sql.ErrNoRows`, ended is `ErrEpochEnded`. `Create` creates an epoch and all
nine chunks in one tx. `ports.RegionSource.Region` creates only an absent epoch, otherwise reads.
`ports.StoryRules.Echoes` takes the snapshot and geometry-only `EchoInput` (epoch/sites); B derives road/mark predicates. It provides per-player Echo assignments, eligibility and atomic paper grants;
`ports.Lanterns.PlaceFallen(ctx, tx, *Snapshot, epoch, *Where, now)` owns D's fall geometry and capped write, returning `FallLantern` with exactly the fall reasons. `ports.Placement.Record` is the one turning/placement hook; `ports.HomeLandSource.Land` supplies
served land. These grants/hooks never bump versions themselves. `sql.ErrNoRows` means missing,
`chunks.ErrEpochEnded` ended, `chunks.ErrUnavailable` transient. Executable fakes use the same
signatures. Go `chunks.Validate` and TS `decodeChunk` validate binary geometry, including cross-region
exits and the Commons arrival grid (62×42 initial tiles). TS `api/ports.ts` retains PaperRule/QuestStep types; actual client read/view contracts live in OperationsApi and ChunkSource; `api/operations.ts` supplies generated
session/operation calls and its fake is usable before C2. Its `chunk` call consumes binary
protobuf, and all HTTP calls carry contract 3. Report/barrier helpers are contracts and stubs
until B implements rules; they cannot silently accept an old progress field. Intermediate
spend/Wilds routes dispatch v3 `op` requests to their stub while old domain handlers remain
for lane tests; B/D remove that temporary branch when they migrate the handler. `ports.PaperRule`/TS `PaperRule` and
`QuestStep` fix the initial typed content schema; B owns the actual rule data and validators.

**Ownership corrections.** A owns the mechanical identity/SQL sweep across the repository,
including every lane's handler, tests, store helpers and CLI; other lanes rebase those edits.
B owns story/placement implementations and report budgets/barriers. D owns chunk/region/land
implementations and homestead-land consumers (`homestead-art`, `homestead-placement`,
`homesteads`); C2's entity scope excludes them. C2 owns `WorldScene`, and D contributes its
home-land building changes there through C2's facade or a coordinated merge, not concurrent
whole-file rewrites. C1 may use A's session facade while C2 is unfinished. C2's removal of
shared save APIs waits for C1's UI consumers. A owns `combat.json`'s initial constants and both
reader updates; B extends its server rules without changing the fixed timings.

**Migration numbers are fixed:** 026 and 027 belong to A, 028 to B. D needs none. A lane that
finds it needs one takes the next number at the time it merges.

| Lane | What | Owns (files) | Depends on | Size | Model |
|---|---|---|---|---|---|
| **A. Contracts and accounts** | A1 protos and fixtures (M). A2 seams: `ChunkSource` and fakes, `api/op.go` (lease, key, idempotency v2, `writeRefusal`, `writeMixed`, contract gate), route stubs, `store` composition hooks for B and D (M). A3 accounts: the per-table rename list, migration 026, `sign_ins` lookup, random ids, the profile seam in Go and TS, presence v2, `origin` deleted with its fresh half moved into player creation (L). A4 migration 027 (S) | `proto/**` and generated code (until it merges), `server/internal/store/{store,migrations}.go`, `migrations/026_*`, `027_*`, `api/{routes,http,op,mutation,idempotency,origin,login,world_choice,checkpoint,state,presence,presence_auth,presence_socket}.go`, `content/contract.json`, `src/lib/profile.ts`, `src/lib/presence*.ts`, `src/lib/api/{types,parse,client}.ts` (envelope and header) | — | **XL**: A3 is a behaviour change across every table, not a mechanical rename | Codex |
| **B. Server rules and operations** | B1 tables and loaders: `quests`, `story`, `vitals`, `combat`, `clock`, and `papers` with its generator fix (M). B2 `store/state.go` loading and saving the new tables (M). B3 handlers: `report`, `quest-step`, `mark`, `take-paper`, `fall`, `profile` (raw mapping), `spend`; `where` on every keyed mutation outside the Wilds; server-written marks and the turning; witness from operations; library donate through the queue; the `-dev-clock` test flag (L). B4 migration 028 and the upgrade tests (L). B5 delete the upload, `DecodeProgress`, `Merge`, the old helpers (S) | `server/internal/rules/**`, a new `server/internal/story/**` (quests, marks, papers, Echo assignment rule), `store/state.go`, `api/{progress,sync,spend,witness,library,item_*,gathering,home_*,homestead,crafting,workshop,repairs,projects,mail,worlds,commons,market,plants}.go`, `content/{quests,story,vitals,combat,clock,papers}.*`, `content/vectors/clock.json`, `scripts/papers.ts`, the find-rule data in `src/content/papers.ts`, `migrations/028_*`, their Go tests | A | **XL** | Codex |
| **C1. Drop local play** | C1a the title ("can't reach the world"), ConnectGuide without local play, Menu, account flow, the connect-guide copy fix (M). C1b guest branches outside C2's and D's files, guest-keyed preferences, the Vite no-server branch (M). C1c the e2e harness, `seedStory`, moving and deleting specs (7.1) (L). C1d README, `home-server.md`, `testing.md` (S) | `src/App.svelte`, `src/ui/**`, `src/lib/{nudges,inventory}.ts`, the local half of `src/lib/papers/library.ts`, `src/content/**` except `papers.ts`, `src/game/{village,homestead,items,keepsakes,guide-pin,held}.ts`, `vite.config.ts`, `e2e/**`, `README.md`, `docs/home-server.md`, `docs/testing.md` | A1 | **L** | Opus |
| **C2. The client on operations** | C2a predictor, queue and outbox (2.4) (L). C2b rewire every call: reports with casts and `seq`, `quest-step`, `mark`, `take-paper`, `fall`, `profile` (the browser posts the raw projection), `where` on mutations (M). C2c delete the guest session, `save.ts` and `lib/api/progress.ts` (S). C2d unit tests (M) | `src/game/{link,session,papers}.ts`, `src/game/scenes/**`, `src/game/entities/**` except Wilds-only files, `src/lib/{state,embers,combat,save}.ts`, `src/lib/api/{progress,cache,queue}.ts` and the operation calls in `client.ts`, `src/lib/habitica/{sync,client,mapping,gear}.ts`, the remote half of `src/lib/papers/library.ts`, `tests/{link,link-recovery,api-progress,embers,…}` | A1, A2; codes against B's protos with a fake server | **L–XL** | Opus |
| **D. The Wilds from the server** | D1 Go generator v2: terrain, decor, exits, site geometry, entities and loot, with goldens and invariants (L). D2 pre-generation at epoch creation, storage, the chunk route, validation, the benchmark and size measurement (M). D3 the region view: epoch creation as the only write, cycle projection, Echo assignments from B's rule; claim, relight and `settle-echo` with `where` and claim-granted papers (M). D4 client: chunk fetch, decode and validation, the IndexedDB cache, rendering and collision from chunks, the guest Wilds deleted, the TS generators deleted (L). D5 homestead land served and its consumers moved (M) | `server/internal/wilds/**`, `server/internal/land/**`, `api/wilds.go`, `store/chunks.go`, `content/wilds.json`, `src/lib/wilds/**` (deleted; art maps moved), `src/lib/homestead-land.ts`, `src/lib/hash.ts`, `src/game/wilds/**`, `src/game/homeland.ts`, `src/game/atlas-plan.ts` (its art import), the homestead entity files that read land (`homestead-art`, `homestead-placement`, `homesteads`), `scripts/{wilds,homestead}-vectors.ts`, `content/vectors/{wilds,homestead}.json` | A (chunk contract, schema); B's Echo rule and paper rules (fakes until B merges) | **XL** | Codex |

**Handoffs and shared seams:**

- **`routes.go`, `http.go`, the error enum and `types.ts`** belong to A. After A merges,
  B/D may replace their route stubs and remove old routes/parsers in coordinated changes; proto
  changes still serialize on the integration branch.
- **The Echo assignment rule and paper rules** are written in B (`story` package). D's region view,
  claims and `settle-echo` call them.
- **Wilds gathering** is in B's `gathering.go`, reading chunks through `ChunkSource`. It uses the
  fake until D merges.
- **`save.ts`** is deleted by C2 only after C1 has removed its imports from `App.svelte`
  and `MenuPanel.svelte`; use a coordinated merge or retain the exports until both migrate.
- **Land and `homeland.ts`** belong to D. C1 doesn't touch them.
- **Proto changes after A** go one at a time on the branch (section 6).

**Order:**

1. A merges.
2. B, C1, C2 and D work in parallel, each merging when green.
3. The integration gate: the full e2e suite, then the owner's playtest.
4. `expansion` receives the release.

**The polish lane** (sound, the player body, phones, UI steps 8 and 9) runs alongside on
`expansion`. Until 0.3 lands, it stays out of the files that C1 (`src/ui/**`, `App.svelte`), C2
(`src/game/scenes/**`, `src/game/entities/**`, `session.ts`, `link.ts`) and D
(`src/game/wilds/**`) are rewriting. Where it must touch them, it waits, or it lands its change
on the integration branch.

---

## 10. Risks and open questions

### Risks

- **The rename touches everything.** Mitigation: it's in lane A, which merges before any other
  lane edits SQL, and it's specified table by table.
- **Rollbacks in story moments.** A refused `quest-step` after the dialogue has played its payoff.
  Mitigation: steps are checked on things the client already knows (previous step, area), so a
  refusal means a real bug. Log it.
- **Report load.** One write every 10 seconds per player is nothing for SQLite at this scale.
  Reports bump the version, but no operation is checked against the version, so they never make
  another operation fail.
- **The regenerated Wilds play differently.** The goldens and invariants guard the shape; the
  owner's playtest at the integration gate judges the feel.
- **Chunk size.** Decor dominates. Measure before the client work starts (3.2).
- **e2e weight.** About 27 more spec files now use a backend. Measure the suite at the gate.
- **Quests.md disagrees.** Its section 2 keeps plain steps client-written and merged. After 0.3
  every step is an operation, and gates (0.4) add checks to the same operation. Rewrite that
  section in the docs pass.
- **Remaining trust** is listed in section 4.

### Owner's answers (2026-10-07)

1. **Offline play:** keep the outbox in the curated areas. The Wilds need the server; cached
   chunks may be shown as display data only.
2. **The Wilds may come out different:** regenerate in Go; no exactness and no TS-id
   compatibility; new Go goldens and gameplay invariants; unsafe saved Wilds positions reset; old
   client terrain caches invalidated.
3. **World changes table:** deferred to 0.5.

### The other questions, with the defaults taken

4. **The server maps the Habitica profile.** The browser posts the raw `/user` projection
   (`HabiticaUser`, validated); `habitica.Map` makes the `HabiticaProfile`. `mapping.ts` and the
   mapping vectors retire.
5. **Quest content in 0.3:** `content/quests.json` with the lantern road only, as shipped. The
   redesigned opening, the Quests page, the tutorial and gates stay in 0.4.
6. **Mana bound:** one 16/s cap, used as a conservative upper bound, not as the true balance.
7. **The healer's mend** (the review's position): checked by class, cooldown and mana
   affordability, at the server's stat-derived heal amount.
8. **Delete `revive`.** Zero-HP rests keep the earned-ember rule.
9. **Homestead land served.** Its consumers move in lane D (D5).
10. **Play time:** the server counts report gaps, capped at 30 seconds; nothing for the first
    report after a lease or a reconnect. Offline time isn't counted.
11. **Discoveries and curated defeats** are checked by known id and area. That isn't proof of a
    fight or a visit.
12. **Wilds gathering** checks the target's decor kind, region and epoch near `where`, not a
    "gatherable" flag.
13. **The region read writes only to create an epoch**; cycles are projected, one at most.
14. **Player creation sets the first vitals, baseline and XP mark**; existing null-origin rows are
    finished in migration 026 before the column goes.
15. **`items.ts` and its vectors stay** in 0.3, as the one named exception to retiring duplicate
    rules.
16. **The browser's sign-in read stays** (the party claim). Only login sends the token; sync
    reports stay unverified input.

### Still open

- **The tests' server clock:** a `-dev-clock` flag (proposed) or an injected clock in the e2e
  backend. *Default:* the flag, test builds only.
- **Chunk size over budget:** if the measured message is over 6 KB, drop decor offsets for pieces
  with zero offset (a presence bitmask), or move scatter-only decor (litter, pebbles, grass) back
  to client seeding. *Default:* measure first, decide in lane D.

### Round 1 handoff checks

B5 removes `PUT /api/progress`, `POST /api/sync`, and legacy upload bodies for `POST /api/spend`.
D removes legacy upload bodies for `POST /api/wilds/claim`, `/lantern`, and `/defeat` (B5's
retirement assertion is enabled once D is merged). `/api/origin` is already removed; C1 removes
its TODO-marked raw client method and flow. A's skipped `TestRetiredTrustRoutesB5` is the
checkable exit criterion: each old request must receive 404/405.
The bridge advances vitals time/budget only on numeric vitals changes or explicit
`Snapshot.VitalsWritten`; every keyed `where` sets `PlaceWritten`. B's normalized saver
must keep those independent policies, including server refills whose values do not change.

A's TS ports contain only actual client seams: OperationsApi/FakeOperations and
ChunkSource/FakeChunks, plus PaperRule/QuestStep types. Server-only transaction seams/fakes
live in Go. `report` accepts keepalive; chunk and region reads reject mismatched identities as
bad-response. Turning is observed through reports/keyed outer-1 placements, never region reads.
