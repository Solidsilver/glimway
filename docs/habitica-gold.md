# Habitica gold and the purse

See also [habitica-policy.md](habitica-policy.md): Habitica's rules for third-party tools and our plan for telling them.

Status: research for the owner, 2026-10-07. Nothing here is built. The
boundary rules this must follow are in [habitica-boundary.md](habitica-boundary.md).

The idea: at sign-in, a player can move Habitica gold into an in-game purse,
with clear consent. Purse gold buys shop goods and materials and pays for
goods in other players' shops. Gold flows into the game only and never back
to Habitica. Top-ups are limited per day, not by amount.

## Short answer

- **It can be done with the token we already hold at sign-in, and nothing
  forces us to store it.** All the Habitica calls fit inside the one request
  that carries the token.
- **Use a custom reward, scored `down`.** Create a reward task priced at the
  amount, score it, then delete it. That's three writes. Habitica checks the
  balance itself and refuses with "Not Enough Gold" rather than going
  negative.
- **Don't use `PUT /user` with `stats.gp`.** It's allowed, but it's a blind
  set of an absolute number. It overwrites any gold change made in between,
  and it's the path Habitica's own wiki lists under cheating.
- **Habitica keeps no record of it.** There's no gold history in Habitica,
  rewards keep no history, and once we delete the task nothing is left except
  the lower balance. Glimway's purse log is the only record, so it has to
  be good.
- **Habitica gives us no idempotency and no locking.** A timeout on the score
  call leaves "did it charge?" unanswerable from the task. We design around
  that: never retry a charge blind, check the balance right after a failure,
  and let the owner settle what's still unclear.
- **The token model changes in one way:** if top-ups happen only at sign-in,
  a player gets one chance a month (sessions last up to 30 days). I recommend
  a "Top up purse" action that sends the token once for that one request,
  exactly as sign-in does. That's an owner decision.

## 1. Every way a tool can lower a user's gold

Read from the Habitica source at `develop`, commit
[`0989bbe`](https://github.com/HabitRPG/habitica/tree/0989bbeae08596eaa4494bd456f793af26d31329)
(2026-10-05). Paths below are relative to that tree. The apidoc at
`habitica.com/apidoc` returned 404 on 2026-10-07; it's generated from the
`@api` comments in the controllers, which I read instead.

| Way | What it does to gold | Fit for the purse |
|---|---|---|
| Score a custom reward, `POST /api/v3/tasks/:id/score/down` | `gp -= task.value`, after checking `task.value <= gp` | **Yes.** Exact amount we choose, Habitica checks the balance |
| `PUT /api/v3/user` `{"stats.gp": N}` | Sets gold to N | No. Blind set, worst race, reads as cheating |
| Gold shop: `/user/buy-gear/:key`, `/user/buy-armoire`, `/user/buy-health-potion`, `/user/buy-quest/:key`, `/user/buy/:key` | Fixed price, grants a Habitica item | No. Grants Habitica items, against the boundary |
| `/user/purchase/gems/gem` (subscribers) | Gold for gems | No |
| Scoring a habit or daily down | Loses a task-dependent amount | No. Not an amount we choose |
| `/user/reset`, revive, rebirth | Sets gold to 0 | No |

Admin endpoints can also change gold (`api-v3/hall.js`), but they need staff
permission.

### Scoring a custom reward

Confirmed in source:

- **There's no "spend N gold" endpoint.** The reward must exist first:
  `POST /api/v3/tasks/user` with `{"type":"reward","text":"…","value":N}`
  (`text` is required). An optional `alias` (letters, digits, `-`, `_`; not
  a UUID) makes it addressable as `/tasks/<alias>`
  (`website/server/models/task.js` L66–89).
- **Value rules.** `value >= 0` is enforced (`models/task.js` L97–106).
  Non-integers are floored on create and update (L161–164). There's no
  maximum on the task; gold itself is capped at 99,999,999
  (`common/script/constants.js` L5).
- **The deduction.** `common/script/ops/scoreTask.js` L444–449:
  ```js
  } else if (task.type === 'reward') {
    // Don't adjust values for rewards
    delta += _changeTaskValue(user, task, direction, times, cron);
    // purchase item
    stats.gp -= task.value;
  }
  ```
  Both `up` and `down` deduct.
- **Not enough gold is refused, never negative.** `ops/scoreTask.js` L271–272
  throws `NotAuthorized` ("Not Enough Gold", HTTP 401) when
  `task.value > user.stats.gp`. A value equal to the balance is allowed and
  leaves 0. The schema also says `gp: { min: 0 }`
  (`models/user/schema.js` L675).
- **Score `down`, never `up`.** Habitica's own web client buys rewards with
  `score('down')` (`client/src/components/tasks/task.vue` L397). Scoring `up`
  also rolls a random drop (`server/libs/tasks/index.js` L480), a crit, and
  can award the `completedTask` achievement. So an `up` top-up could hand the
  player a Habitica egg or potion, which breaks the boundary.
- **The response carries the new balance.** `api-v3/tasks.js` L742–757
  returns `data: { delta, _tmp, hp, mp, exp, gp, lvl, … }`, with `gp` read
  after the save.
- **While it exists, the reward sits at the top of the Rewards column**
  (`libs/tasks/index.js`, `createTasks` pushes to `tasksOrder.rewards` at
  position 0). `DELETE /api/v3/tasks/:id` hard-deletes it and removes it from
  the column (`api-v3/tasks.js` L1387–1444).

### What the player sees in Habitica afterwards

Confirmed in source, by what isn't there:

- **Their gold is lower.** That's all that's left once the task is deleted.
- **No gold history.** Habitica's transaction log covers gems and hourglasses
  only: `export const currencies = ['gems', 'hourglasses'];`
  (`server/models/transaction.js` L7).
- **No reward history.** `RewardSchema` is empty; only habits and dailies keep
  `history` (`models/task.js` L351, L421). User `history` holds `exp` and
  `todos` only.
- **No notification.** The reward branch never adds one.
- **If the Habitica app is open,** it notices the version bump and resyncs, so
  the balance drops in front of them. The reward may flash in the Rewards
  column if the resync lands mid-top-up.
- **If the player runs other Habitica tools with webhooks,** those see
  `taskActivity` `created`, `scored` and `deleted` events for our task.

### `PUT /user` with `stats.gp`

Allowed. `stats` is an updatable path, and only `stats.class` is blocked
under it (`server/libs/user/index.js` L38–84). Habitica's own "Fix Character
Values" setting uses exactly this path. It writes no history either. It's the
wrong tool for us for three reasons:

1. It sets an absolute number we compute from an earlier read. Any gold the
   player earns or spends in between is overwritten.
2. Habitica doesn't check the balance; we'd be trusting our own stale read.
3. The wiki's Cheating page names "Using Fix Character Values to give
   yourself extra … gold". A tool that sets `stats.gp` looks like that, even
   when it lowers gold.

## 2. Rules for third-party tools

Sources: the GitHub wiki
[API Usage Guidelines](https://github.com/HabitRPG/habitica/wiki/API-Usage-Guidelines)
(last changed 2024-06-19), the fandom wiki's
[Guidance for Comrades](https://habitica.fandom.com/wiki/Guidance_for_Comrades),
which includes Template:Third_Party_Tool_Rules (revised 2025-05-25), and
[Application Programming Interface](https://habitica.fandom.com/wiki/Application_Programming_Interface)
(2025-08-30).

- **`x-client` header.** Format `<creator's user id>-<app name>`; "the User ID
  of the person who **wrote** the tool, not the player who is using it". We
  already send `5abfd539-…-glimway` (`server/cmd/glimway-server/main.go`).
  The fandom API page says that since late July 2025, authenticated calls
  without it are rejected. In code, the server checks only that it's present
  (`server/middlewares/auth.js` L75–77, behind `ENFORCE_CLIENT_HEADER`).
- **API version.** Use v3 only. The wiki says v4 "is not suitable for use in
  any third-party tools for any reason". That rules out `v4/tasks/bulk-score`.
- **Rate limit.** "30 requests every 60 seconds … for each user", keyed on
  `x-api-user` (falls back to IP). Headers `X-RateLimit-Limit`,
  `-Remaining`, `-Reset`; a 429 carries `Retry-After` in seconds, possibly
  fractional (`server/middlewares/rateLimiter.js`). The browser's syncs share
  this per-user bucket with our sign-in calls.
- **Pacing.** "For automated scripts that run in the background (no user
  intervention needed) … keep a delay of 30s between different calls, in
  particular POST and PUT". A top-up is player-initiated, so I read this as
  not applying, but our three writes land within a second or two. See the
  open question on telling Habitica staff.
- **Stop when the action can't complete.** "running out of Gold when
  automatically buying items should make the calls stop". Habitica's 401
  "Not Enough Gold" ends the top-up; we never retry it.
- **Public code** if others use the tool (we're public).
- **Storing tokens** must be stated plainly on the front page and in the docs.
  We don't store them on the server, so this doesn't apply beyond the opt-in
  Remember we already disclose.
- **Tell staff.** Submit the tool at
  [forms.habitica.com/app-submission](https://forms.habitica.com/app-submission)
  "as soon as your code is ready", and email admin@habitica.com "if you expect
  many players to use your tool".
- **Nothing about gold or editing user data.** The guidelines don't mention
  `stats.gp`, custom rewards or modifying gold, apart from the stop-when-out
  rule.
- **Never call cron.** `POST /api/v3/cron` runs the player's day rollover and
  applies Daily damage. Scoring doesn't trigger it.

## 3. Atomic or racy?

Racy. Confirmed in source; the lost update below is inferred from the code
and not tested live.

- A score request loads the user once (auth middleware), checks and subtracts
  in memory (`ops/scoreTask.js`), and saves with Mongoose `user.save()`
  (`libs/tasks/index.js` L576–604). That's read-modify-write. Mongoose writes
  `$set: { "stats.gp": <computed> }`, not `$inc`.
- There's no optimistic concurrency. The user schema options are only
  `skipVersioning`, `strict`, `minimize` and `typeKey`
  (`models/user/schema.js` L759–764). Habitica's `_v` is a counter bumped on
  save, not a guard. A source comment admits it: "mongoose's push and pull
  should be atomic and help with our concurrency issues".
- So if the player buys something in the Habitica app at the same moment, one
  save can overwrite the other. Either they keep the item and the gold we
  took, or our deduction disappears and we've credited the purse for free.
  The window is one Habitica request, tens of milliseconds.
- There's no idempotency key anywhere in the server. Scoring a reward doesn't
  even re-save the task, so after a timeout the task can't tell you whether
  it was charged.

**Reading the balance first.** `GET /api/v3/user?userFields=…` returns a
projection (`server/middlewares/auth.js` L22–54). Our sign-in already reads
`stats`, which includes `gp`; `Map` in `server/internal/habitica/client.go`
just ignores it today. No extra call is needed. That read is only for the UI
and an early "not enough"; Habitica's own check inside the score is the one
that counts.

**Integer gold.** Habitica PR #15631 "Number Rounding" (commit `d584f8f22e`,
merged 2026-08-04) floors `stats.gp` on every save and reward values on
create. The purse can be whole gold. I couldn't confirm this is live in
production, so floor the balance we read before showing it.

## 4. The token model

The top-up fits the used-once model as long as every Habitica call happens
inside the request that carries the token:

- Sign-in already holds the token for one request and drops it
  (`req.Token = ""` in `server/internal/api/api.go`). A top-up adds three
  writes to that same request, and the token is dropped after the last one.
- Nothing in Habitica's API needs a stored token for this. Webhooks would
  only matter for acting later, and they're unsigned anyway.
- What would force storing it: scheduled or automatic top-ups, or retrying a
  failed top-up later from the server. The design below does neither.

The catch is sessions. A Glimway session lasts up to 30 days, so "at
sign-in" can mean once a month. The browser already holds the token during a
visit (every sync uses it), or the player can paste it. A separate
`POST /api/purse/top-up` that takes the token in its body, uses it for that
request and drops it, is the same promise as sign-in: the server sees a token
only during a request the player just started. **Owner decision:** sign-in
only, or a Top-up action too. I recommend both, sharing one code path.

## 5. Recommended design

### Flow

1. **Browser.** The player opens "Top up purse" (offered on the sign-in card,
   and in the Menu once signed in). The browser already has the balance from
   its own `GET /user`. It shows the consent card (below) and the player
   picks an amount.
2. **Request.** The browser sends the token, the amount and a fresh
   idempotency key, either inside `POST /api/session` (`topUp: {amount, key}`)
   or as `POST /api/purse/top-up`.
3. **Reserve** (DB transaction 1, no Habitica calls inside). Check the daily
   limit, check there's no unsettled top-up for this player, and insert a
   `purse_topups` row in state `reserved` with the key, amount and the gold
   we read. Commit. A repeated key returns the stored outcome, like the
   existing `idempotency` table does for spends.
4. **Habitica** (outside any transaction, on a context detached from the
   browser's, so a closed tab can't cut a call in half):
   1. Verify (sign-in's `GET /user`, or one `GET ?userFields=stats.gp` for the
      Top-up action). If `gp < amount`, settle as `not-enough` and stop.
   2. `POST /api/v3/tasks/user`
      `{"type":"reward","text":"Glimway purse: 120 gold","notes":"Glimway is moving gold into your purse. It removes this reward when it's done.","value":120,"alias":"glimway-topup-<row id>"}`.
      Mark the row `created`.
   3. `POST /api/v3/tasks/glimway-topup-<row id>/score/down`.
      - 200: the charge happened. Record `data.gp` as the gold after.
      - 401 "Not Enough Gold": no charge. Settle as `not-enough`.
      - 429: Habitica refused before running it. Wait `Retry-After` (cap a
        few seconds) and try once more.
      - Timeout, network error or 5xx: **unknown. Never send the score
        again.** Do one `GET ?userFields=stats.gp`. If gold fell by at least
        the amount, treat it as charged. If it didn't move, treat it as not
        charged. Anything else, or if the GET fails, settle as `unconfirmed`.
   4. `DELETE /api/v3/tasks/glimway-topup-<row id>`. If this fails, keep
      a flag on the row; the next time a token is in hand for this player,
      delete the leftover before anything else.
5. **Settle** (DB transaction 2). For a charge, write a ledger row
   (`currency 'gold'`, reason `habitica-topup`, ref = the row id) and mark
   the row `done` with the gold before and after. Drop the token.

### Crash recovery

- **Between reserve and the score call:** the row is `reserved` or
  `created`. On startup, the server marks rows older than a few minutes
  `unconfirmed`. A `created` row means a reward may still sit in the
  player's Rewards column, priced at the amount; it's deleted the next time
  the player brings a token.
- **Between the score and settle:** same as above. The charge may have
  happened, and we can't ask Habitica without a token.
- **Unconfirmed rows** block further top-ups for that player and show in the
  purse log as "Not confirmed yet: 120 gold". The owner settles them with a
  CLI command (`purse settle <id> charged|not-charged`) after asking the
  player whether their Habitica gold dropped. Habitica has no record to
  check, so the player's word and our stored "gold before" are the evidence.
  In a small invite-only world that's acceptable; if it's not, the
  alternative is to credit unconfirmed top-ups automatically and accept the
  occasional free gold.

The rule underneath: **we would rather owe the player than charge them
twice.** Never retry a charge whose outcome is unknown.

### Consent card

Shown every time, before any request. Plain words, Habitica's own terms:

> **Move gold from Habitica into your purse**
>
> You have **1,240 gold** on Habitica.
> Move [ 200 ] gold   [All]
>
> This **spends Habitica gold**. Your Habitica balance goes down by this
> amount, the same as buying a reward there. Glimway never gives gold
> back, and purse gold can't go back to Habitica.
>
> Glimway adds a reward called "Glimway purse" to your Habitica
> Rewards for a moment, buys it, and removes it. Habitica doesn't keep a
> record of this; your purse log does.
>
> Top-ups left today: 2 of 2.
>
> [ Move 200 gold ]   [ Not now ]

- No default amount above zero, no pre-ticked box, and "Not now" is as easy
  to press as the main button.
- If the player has their own custom rewards (real treats bought with
  Habitica gold), say once, the first time: "Gold you move here can't pay for
  your Habitica rewards any more."
- At sign-in, the card can't come after sign-in succeeds, because the token
  has already been used and dropped by then. So it's an optional row on the
  sign-in card instead: "Also move gold into your purse" (off by default),
  with the amount.

### Daily limit

- **Two top-ups per UTC day per player**, matching the server's other daily
  caps (`server/internal/api/items.go` counts from UTC midnight). The owner
  said 1 or 2; I'd start at 2 so a failed-looking top-up doesn't use up the
  day, and drop to 1 if it gets used as a habit.
- Count `done` and `unconfirmed` top-ups. `not-enough` and errors before the
  score don't count.
- No amount cap, as the owner prefers. The amount must be a whole number from
  1 to the gold we read.

### Ledger and log

- New migration (026 at the time of writing): `purse_topups(id,
  habitica_id, idem_key, amount, gp_before, gp_after, state, task_alias,
  leftover_task, created_at, settled_at)`, unique on `(habitica_id,
  idem_key)`.
- Purse gold is a `ledger` currency (`'gold'`), so it gets the same
  "no write replaces a balance" rule as embers. Every spend and trade writes
  a row.
- The purse log in-game lists each top-up with date, amount, state and the
  Habitica balance before and after, plus every spend. This is the only
  record the player has.
- The purse is world-only (it needs the server). Guests and connected heroes
  without a world have no purse.

### Docs and copy that must change with it

Today the game promises it never writes. These go in the same change:

- README "Your Habitica character (read-only)" and "What the game reads, and
  what it never does".
- `src/content/connect-guide.ts`: "The game limits itself to reading".
- `docs/import-contract.md`: `HabiticaClient` has no writes. The browser
  client can stay read-only; only the server writes.
- `docs/expansion-design.md` "Login and access": the server's only Habitica
  call is the login GET.

## 6. Risks

- **The lost update** (section 3). Rare, symmetric, tens of milliseconds.
  Accept it. Store gold before and after for every top-up so the owner can
  see what happened.
- **Unknown outcomes** need the owner to settle them by hand. Keep them rare
  with a short Habitica timeout on the write path and a balance check right
  after any failure.
- **A leftover reward** in the player's Rewards column, priced at the amount,
  if delete fails. If they click it, Habitica takes the gold again and we
  credit nothing. Delete leftovers first thing with the next token, and the
  task's notes tell the player what it is.
- **The token is in server memory for longer**, about four Habitica round
  trips instead of one. Same promise (never stored, logged or returned), with
  a longer window. Extend `TestTokenCookieAndBackup`
  (`server/internal/api/api_test.go`) to the new endpoint.
- **Players spend gold they'd planned for their own Habitica rewards.**
  Consent copy covers it; the daily limit slows impulse top-ups.
- **The economy.** Long-time Habitica players can have tens of thousands of
  gold. With no amount cap, one top-up can buy out every shop. Set gold
  prices and shop stock knowing that; that design is separate from this doc.
- **Habitica could change the endpoint or its rules.** The reward path is
  public API used by the official clients, so it's unlikely to vanish, but
  it's worth telling staff what we do (open question below).

## 7. Couldn't confirm

- The live apidoc (404 on 2026-10-07). I used the source comments it's built
  from.
- Production settings: the actual rate limit (the code default is 30 per
  minute, and the wiki says the header "will always be 30"), and whether
  `ENFORCE_CLIENT_HEADER` is on. The wiki says it has been since July 2025.
- Whether "Number Rounding" (integer gold) is deployed to production yet.
- The lost-update race. It follows from the code and Mongoose defaults; I
  didn't test it against the live API, and I made no authenticated calls.
- Whether a reward flashes in the official mobile apps during a top-up. That
  depends on when they resync.

## Open questions for the owner

1. Top-ups only at sign-in, or a Top-up action that sends the token once more
   (recommended)?
2. One or two top-ups a day? (Recommended: two, UTC day.)
3. Unconfirmed top-ups: settled by the owner (recommended), or credited
   automatically?
4. Submit Glimway on Habitica's app-submission form and tell staff about
   the write before it ships? I'd do it, since the tool will start changing
   gold.
