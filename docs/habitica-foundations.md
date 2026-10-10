# Habitica integration foundations (research record)

Researched: 2026-10-02 (local; HTTP `Date` headers returned 2026-10-03 UTC).
Evidence types in this document:

- **live**: HTTP request/response checked during this research
- **source**: file read from `HabitRPG/habitica` `develop` branch at research time
- **doc**: prose from official API docs/wiki
- **unverified**: open question; do not build claims on it

No live adapter is enabled in the demo. This record exists so the future
adapter starts from evidence instead of assumptions. No credentials were used.

## Sources consulted

| URL | What it establishes | Evidence |
|---|---|---|
| https://apidoc.habitica.com/ | API reference home (HTTP 200) | live |
| https://raw.githubusercontent.com/wiki/HabitRPG/habitica/API-Usage-Guidelines.md | X-Client rule, background delay, rate limits, public-repo rule | live |
| https://raw.githubusercontent.com/HabitRPG/habitica/develop/LICENSE | Code GPL v3; HabitRPG assets CC BY-NC-SA 3.0; BrowserQuest assets CC BY-SA 3.0 | live |
| https://raw.githubusercontent.com/HabitRPG/habitica/develop/website/common/script/libs/statsComputed.js | Effective-stat formula (double-counting pitfalls) | source |
| https://raw.githubusercontent.com/HabitRPG/habitica/develop/website/common/script/statHelpers.js | `diminishingReturns`, `toNextLevel`, `capByLevel` | source |
| https://raw.githubusercontent.com/HabitRPG/habitica/develop/website/common/script/ops/scoreTask.js | Reward scoring charges gold; insufficient-gold rejection | source |
| https://raw.githubusercontent.com/HabitRPG/habitica/develop/website/server/controllers/api-v3/user.js | `GET /api/v3/user`, `userFields` minimal projection | source |
| https://raw.githubusercontent.com/HabitRPG/habitica/develop/website/server/controllers/api-v3/tasks.js | `POST /api/v3/tasks/:taskId/score/:direction`, reward `value` = gold cost | source |
| https://habitica.com/api/v3/user (OPTIONS preflight) | CORS headers actually served | live |
| https://github.com/HabitRPG/habitica/wiki/API-Usage-Guidelines | Canonical guideline location (wiki) | doc |
| https://github.com/HabitRPG/habitica/tree/develop/website/server/models/user | User model referenced by `GET /user` docs | doc |

## Read API requirements (concrete)

- **Auth headers**: `x-api-user: <user UUID>`, `x-api-key: <API token>`.
  The same token authenticates writes; it is **not** a read-only credential.
  Keep it in memory only, never in saves, exports, logs, URLs, or source.
- **`X-Client` header is mandatory** for third-party tools: format
  `UserID-appname` where UserID is the *tool creator's* Habitica user id
  (guidelines doc). Example from wiki: `12345678-90ab-416b-cdef-1234567890ab-AutoCaster`.
  The CORS preflight confirms `x-client` is allowed (live).
- **Background automation** (guidelines doc): 30 s delay between API calls,
  including GET. Stop automatic calls when an action can no longer complete.
  Glimway is manual/conservative sync only: one `GET /user` per explicit
  sync action, never per frame or per combat event.
- **Public repository**: tools used by others must have publicly reviewable
  source (guidelines doc). Plan already commits to this.
- **Rate limits** (guidelines doc + live headers): responses carry
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; excess
  returns `429` with `Retry-After`. The preflight response exposes those
  headers via `access-control-expose-headers` (live). Handle 429 with
  backoff; surface it, do not hammer.
- **Minimal fields**: `GET /api/v3/user` supports `?userFields=comma,separated`
  to return a projection instead of the full document; notifications are
  always returned (source: user.js apidoc comment). A read adapter should
  request only what the character mapping needs, e.g.
  `userFields=stats,items.gear,items.pets,items.mounts,achievements,preferences,profile.name,auth.timestamps`.
  The exact allowed field list is dot-paths on the user model (doc points to
  `website/server/models/user`) — **verify per field against a real account
  before shipping** (unverified until then).
- Useful read endpoints for the planned mapping (source: controllers):
  - `GET /api/v3/user` (character stats/class/gear/appearance/pets/mounts)
  - `GET /api/v3/tasks/user` (reward tasks incl. custom Glimway rewards
    and their gold `value`)
  - `GET /api/v3/user/in-app-rewards` (shop-style rewards listing)

## Stats semantics and double-counting pitfalls

`statsComputed(user)` (source: `statsComputed.js`) is the effective-stat
formula Habitica itself uses in scoring/combat:

```
effective(stat) = baseStat + buff + gearBonus + classBonus + floor(min(lvl, MAX_LEVEL) / 2)
maxMP = 2 * effective(int) + 30
```

where `baseStat = user.stats.{str,int,con,per}`, `buff =
user.stats.buffs.{str,int,con,per}`, and for each equipped item in
`user.items.gear.equipped`: `gearBonus += item[stat]`, plus
`classBonus += item[stat]` **again** when the item's `klass`/`specialClass`
matches `user.stats.class`.

Habitica spells the mage class **`wizard`** in both `stats.class` and gear
`klass`/`specialClass`. Glimway accepts both spellings at every intake and
maps `wizard` onto the internal `mage`; gear klass `wizard` therefore matches
an internal `mage` for the class bonus.

Pitfalls for the Glimway mapping (plan already requires "Avoid counting
equipment and buffs twice"):

1. `user.stats.str` etc. are **base stats only** — they exclude gear, buffs,
   and the level bonus. Adding gear on top of them is correct **only** if you
   have not already applied gear elsewhere. Never combine a precomputed
   effective value with per-item gear sums.
2. Class-matching gear contributes **twice** in Habitica's own formula (once
   in `gearBonus`, once in `classBonus`). If Glimway wants flatter
   balance, that is a deliberate rules change, not an import — document any
   deviation from `statsComputed`.
3. `user.stats.buffs` includes temporary buffs (skills, potions, seasonal
   effects). Import them or not explicitly; do not silently merge them into
   base stats and then also read `stats.buffs` again.
4. The level bonus `floor(cappedLevel/2)` is applied per stat inside
   `statsComputed`; `user.stats.lvl` is the raw level (cap via
   `statHelpers.capByLevel`). Do not add `lvl` to stats twice.
5. `maxMP` is derived from effective INT (`2*int+30`); `user.stats.mp` is the
   current pool. Do not treat `stats.maxMP` as a stored field without
   checking.
6. `statHelpers.diminishingReturns(bonus, max, halfway)` exists in Habitica
   source and is the kind of curve the plan asks for ("diminishing returns to
   keep very different accounts playable"). Reuse the concept with our own
   documented constants; do not copy GPL code into our codebase without a
   license decision.
7. Equipment wear/owned items must never be consumed or modified by
   Glimway (plan boundary): reads of `items.gear` are display/combat
   inputs only.

## Licenses (verified in LICENSE file, live)

- Habitica **source code**: GPL v3.
- **Assets and content designed for HabitRPG**: CC BY-NC-SA 3.0.
- **Assets and content designed for Mozilla BrowserQuest**: CC BY-SA 3.0.

Consequences for Glimway (per plan): adapted assets keep their
share-alike/noncommercial conditions; our own code license is a separate
decision; the asset register (`ASSETS.md`) tracks each third-party asset
individually. Presenting as an independent project; no official endorsement.

## CORS verification and its limits

Verified live (2026-10-02) with `OPTIONS https://habitica.com/api/v3/user`
and `Origin: https://example.com`:

```
access-control-allow-origin: *
access-control-allow-methods: OPTIONS,GET,POST,PUT,HEAD,DELETE
access-control-allow-headers: Authorization,Content-Type,Accept,Content-Encoding,X-Requested-With,x-api-user,x-api-key,x-client
access-control-expose-headers: X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,Retry-After
```

So browser-direct access is *architecturally possible* without a backend.

Limits of this verification (do not over-claim):

- curl is not a browser: real-browser behavior (extension CSPs, privacy
  settings, storage partitioning, corporate proxies) is unverified until a
  browser prototype performs an authenticated request.
- `access-control-allow-origin: *` was checked without credentials; cookie or
  Authorization-based flows behave differently (we plan header auth, which
  this preflight covers, but a real authenticated GET is still unverified).
- The wiki requires `X-Client` on *every* request; the preflight allowing the
  header is not proof the server accepts our future client id format.
- Rate-limit policy for third-party tools may change; treat 429 handling as a
  hard requirement, not a nicety.
- Nothing here verifies account/deletion/privacy handling; plan covers
  credentials (memory only) but a privacy note is still owed before release.

## Purchases (Reward redemption): verified behavior and open uncertainties

Verified in source (scoreTask.js, tasks.js):

- Custom **Reward** tasks are the intended purchase channel; a reward task's
  `value` is its gold cost (tasks.js apidoc: "The cost in gold of the
  reward").
- Scoring: `POST /api/v3/tasks/:taskId/score/:direction`. For
  `task.type === 'reward'`, direction `up` executes the purchase:
  `stats.gp -= task.value` (scoreTask.js ~line 444-448). Gold check:
  `if (task.value > user.stats.gp && task.type === 'reward') throw
  NotAuthorized` (scoreTask.js ~line 272) — insufficient funds fail
  server-side.
- Scoring is therefore a **write** with real gold consequences. The plan's
  boundary stands: the only planned writes are explicit, user-confirmed
  Reward setup/redemption. The demo performs **no writes at all**.

Unverified / uncertain (must be resolved before enabling purchases):

1. **No idempotency key** was found for `POST /tasks/:id/score`. A retry of
   the same redemption appears to charge gold again. Therefore we cannot
   claim exactly-once purchase behavior; follow the plan: persist a purchase
   journal *before* requesting, never auto-retry an uncertain outcome, and
   stop rather than pretend reconciliation is exact.
2. **Reconciliation evidence**: reward scoring in `scoreTask.js` does not
   show a dedicated purchase ledger/history write for reward redemptions
   (history handling there is habit/daily oriented). Whether task `history`,
   notifications, or another store provides a reliable redemption identifier
   is **unverified**. Do not claim server-side purchase history without
   evidence from a test account.
3. **Price staleness**: `task.value` is an editable task field. A price shown
   before confirmation can change server-side; the server charges the
   *current* `value` at score time. Revalidate immediately before confirming
   and show the actual charge afterward (plan requires this).
4. **Concurrent submissions**: two overlapping score requests could both pass
   the gold check before either charges. Serialize purchases locally
   (disable buttons, single in-flight redemption) and treat concurrent
   attempts as unsupported.
5. **Reward creation** (`POST /api/v3/user/tasks` with `type: 'reward'`) is a
   write that creates visible account content. Plan requires explicit
   approval of name/purpose/cost before creating anything. Whether creation
   is reversible without side effects is unverified.
6. **Exactly-once delivery** of the local entitlement after a successful
   redemption: keep the redemption response in the journal before granting
   locally; if local delivery fails after a confirmed charge, preserve
   recovery info and surface it (plan's reliability requirements).

Recommended first integration step (milestone 4, not now): against a throwaway
test account, verify (a) minimal-field `GET /user`, (b) reward creation,
(c) redemption gold charge + insufficient-funds rejection, (d) what history
identifiers exist, (e) an authenticated browser request. Record results here.

## Boundary reminders (from the plan, unchanged)

- No scoring habits/dailies/to-dos, no stat/equip/spell/inventory writes.
- No live adapter, tokens, or writes in the credential-free demo.
- Combat/defeat/healing stay local; imported HP only constrains expedition
  health at sync boundaries.
- This document records research; it does not authorize purchases code.

## `items.gear.owned`: what the wardrobe reads (0.6)

The wardrobe's picker is filled from `items.gear.owned` (design 4.3), read **by the server** in
three places — sign-in, a purse top-up, and the wardrobe's **Check for new gear** — and stored in
its own table (`player_gear`). It is never part of a profile report: a browser that sends
`items.gear.owned` is ignored.

What the map holds (source: Habitica's user model and `scoreTask`/`death` handling; the shape is
**unverified against a live account** until the owner's live check, `docs/habitica-gold.md`
"Live check"):

- **Keys** are Habitica's gear keys, `type_klass_index` (`weapon_warrior_1`,
  `armor_mystery_201403`, `headAccessory_armoire_gogglesOfBookbinding`) — the same keys the
  sprite proxy and `content/habitica-gear.json` use (1,860 of them, in the eight drawn slots).
- **`true` is owned.** Every starter piece the class begins with (`*_base_0`, zero gold) reads
  `true` from the start; earned, bought, mystery, armoire, quest and subscriber gear appear when
  the account owns them.
- **`false` is gear the hero had and lost** — the warrior's death penalty takes pieces away, and
  the key stays in the map with `false` until it is bought again. Glimway reads `false` as "not
  owned": the wardrobe shows the Habitica look for that slot (4.2), never a piece the hero lost.
- **Keys the catalog doesn't know** turn up occasionally (event or retired gear). They can't be
  drawn here, so the server drops them on write; the list in `player_gear` is sorted and
  catalogued only.
- The map can run to a few hundred keys for a collector (about 60 KB of JSON). It is read only by
  the wardrobe's operation and read and by `visualAvatar` (4.3), and never sent on every answer.

To confirm at the live check: that the starters are `true`, that a hero who died shows `false`
for the lost pieces, and that an unknown key really does appear in the raw map (so the filter has
something to do).
