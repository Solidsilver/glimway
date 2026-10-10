# 0.6 The purse and the wardrobe

Status: **design, for the owner to confirm**, 2026-10-09. Written from the code at `afa8363`
(`exp/design-06`, which is `main`: 0.5.0 Crafts). The owner's decisions are in
[ideas.md](../ideas.md) ("Habitica integration"), [plan.md](plan.md) ("The gold purse and the
Habitica wardrobe follow 0.5 Crafts, before the open map") and the 2026-10-07 notes they came
from. The research behind the purse is [habitica-gold.md](../habitica-gold.md); the rules every
piece here is checked against are [habitica-boundary.md](../habitica-boundary.md) and
[habitica-policy.md](../habitica-policy.md). Everything follows [server-first.md](server-first.md):
the server owns state and rules, the client predicts and draws, and operations are idempotent.
Defaults for anything still open are in section 11.

**The aim.** Two things Habitica players already have start to count in Glimway. Gold you earned
on Habitica can move into a purse in the game, when you ask and only then, and it buys goods from
the village's sellers and from friends' shelves. And the gear you own on Habitica becomes a
wardrobe: you choose what your hero wears here from what you own there, the way 0.5 let you choose
which pet walks with you.

**Four rules for this release:**

1. **Gold comes in only when the player asks, and never goes back.** One top-up is one consent,
   one token, one request. Nothing in Glimway pays out to Habitica, and nothing changes in
   Habitica except the gold the player agreed to move.
2. **The token is used for the request that carries it and then dropped.** It is never stored,
   logged, hashed into a stored record, or returned. The browser keeps holding it as it does today.
3. **The game shows Habitica's gear; it never makes or grants it.** Every wardrobe choice is
   checked against the owner's latest owned list when someone looks. What you wear here is only
   how you look; your stats come from your battle gear on Habitica, as they do today.
4. **We would rather owe the player than charge them twice.** A charge whose outcome is unknown is
   never sent again. It is credited only when a balance check shows the gold left Habitica.

---

## 1. Scope

### In 0.6

| Piece | From | Notes |
|---|---|---|
| The purse | ideas.md, habitica-gold.md | A gold balance per account, a ledger currency like embers |
| Top up from Habitica | owner, 2026-10-07 | A **Top up** button in the Menu's Habitica card: it syncs, shows the consent card, then moves the gold. Two a UTC day, no amount cap |
| Unknown outcomes | owner, 2026-10-07 | Credited automatically once a balance check shows the drop (2.3) |
| The purse log | habitica-gold.md §5 | Every top-up with Habitica's gold before and after, and every gold spend and sale. Habitica keeps no record, so this is the only one |
| Gold at the sellers | ideas.md ("Gold and embers as two currencies") | Hazel, Finn and the fair stall take gold as well as embers; Silas sells timber, stone and fiber for gold only, a few bundles a day |
| Gold between players | ideas.md | A price in gold on a gate-shelf slot. A visitor buys it; the gold goes to whoever stocked it |
| The wardrobe | habitica-boundary.md, ideas.md | A Wardrobe tab in the Character panel: per slot, Habitica's look, a piece you own, or nothing |
| Owned gear read | habitica-boundary.md checklist | `items.gear.owned` joins the fields read, on both sides, in the same change |
| The read-only promise rewritten | habitica-boundary.md "close to the line" 4, habitica-policy.md TODO | README, connect guide, import contract and the About card say exactly what the purse writes |
| Art round | | Small: section 9 |

### Left for later, on purpose

- **Telling Habitica staff** (the app-submission form). The owner's call: only once the purse is
  polished. Not in 0.6. The owner's live check against a throwaway Habitica account (10.3) comes
  first.
- **A top-up row on the sign-in card.** habitica-gold.md offered it; the owner chose the Top up
  button in the account settings. Sign-in stays a read.
- **Gold in letters and gold handed over in person.** The shelf is the one way gold moves between
  players in 0.6 (question 6).
- **Silas's Yard for gold** (cottage pieces, buildings, furniture). The homestead stays priced in
  embers and materials (question 5).
- **Saved outfits** (named sets you switch between). The wardrobe holds one look in 0.6.
- **Backgrounds, hair, skin and shirts.** Habitica's `preferences` and purchased backgrounds are
  appearance, not gear; the wardrobe covers gear only.
- **Player decorating with the interior kit.** The roadmap notes put it "with the gold purse and
  wardrobe era"; it is its own design and doesn't need gold.
- **Guests' purse and look.** There are no guest accounts until the standalone track; section 5
  says what they will see.
- **Our own gear art** (the standing "backups for everything Habitica supplies" goal). The
  wardrobe draws Habitica's sprites, as the avatar does today.

---

## 2. The gold purse

### 2.1 What the player sees

**The purse card.** The Menu's Habitica card (`src/ui/MenuPanel.svelte:182-185`, "Sync your
Habitica hero") gets a purse block under the sync controls, for a signed-in Habitica hero:

```
┌ Sync your Habitica hero ──────────────────────────────┐
│  Tansy · level 23 mage            [ Sync now ]        │
│  …                                                    │
│ ─────────────────────────────────────────────────────  │
│  YOUR PURSE                                           │
│  ◉ 240 gold                                           │
│  Gold moved in from Habitica. It buys goods from      │
│  sellers and from friends' shelves. It can't go back. │
│                                                       │
│  [ Top up from Habitica ]              Purse log ▸    │
│  Top-ups left today: 2 of 2                           │
└───────────────────────────────────────────────────────┘
```

**Top up from Habitica** does three things in order:

1. **It syncs**, exactly as **Sync now** does today (`syncCharacter`,
   `src/ui/ConnectGuide.svelte:225`): the same safety rules (Hearthwick or the Commons, no gate
   walk, no talk, no creatures near: `syncBlocker`, `ConnectGuide.svelte:104`), the same embers
   toast. A sync that's blocked or fails stops here with its own message. If the tab has no token
   in memory (a reload without Remember), the card asks the player to connect first, as Sync does.
2. **It shows the consent card**, with the gold the sync just read:

   ```
   ┌ Move gold from Habitica into your purse ─────────────┐
   │                                                      │
   │  You have 1,240 gold on Habitica.                    │
   │  Move [        ] gold                                │
   │                                                      │
   │  This spends Habitica gold. Your Habitica balance    │
   │  goes down by this amount, the same as buying a      │
   │  reward there. Purse gold can't go back to Habitica, │
   │  and it can't buy your own Habitica rewards.         │
   │                                                      │
   │  Glimway adds a reward called "Glimway purse" to     │
   │  your Habitica Rewards for a moment, buys it, and    │
   │  removes it. Habitica keeps no record of this; your  │
   │  purse log does.                                     │
   │                                                      │
   │  Top-ups left today: 2 of 2.                         │
   │                                                      │
   │  [ Not now ]                  [ Move 200 gold ]      │
   └──────────────────────────────────────────────────────┘
   ```

   - The amount starts **empty**. The main button stays disabled until it holds a whole number
     from 1 to the gold shown, and its label repeats the number. There's no "All" button and no
     pre-ticked box. **Not now** is the same size and just as easy to press.
   - The card is shown every time. Nothing remembers a "don't ask again".
3. **It moves the gold** (2.2). The card's button reads *Moving gold…* and the card stays calm:
   no spinner animation, just the line. Most top-ups finish in a second or two. If Habitica is
   slow, the line becomes *Checking with Habitica…* and the card waits (up to about a minute)
   for the answer.

**What the player is told afterwards**, one line each, in the card and as a toast:

| Outcome | Line |
|---|---|
| Moved | *"200 gold moved into your purse. Habitica: 1,240 → 1,040."* |
| Moved, after a check | *"Habitica was slow to answer, but your gold there went down by 200, so it's in your purse."* |
| Not enough | *"Habitica says there isn't that much gold there now. Nothing moved."* |
| Not moved | *"Habitica didn't take the gold, and your balance there didn't change. Nothing moved, and it didn't use up a top-up."* |
| Not confirmed | *"Habitica didn't answer, and we couldn't tell whether your gold moved. Nothing is in your purse yet; your purse log shows this one as not confirmed."* |
| Token refused | *"Habitica didn't accept your token. Connect again and try once more."* |
| Leftover reward (added to any line) | *"If a reward called 'Glimway purse' is still in your Habitica Rewards, don't buy it. It's removed the next time you top up."* |

**The purse log** (**Purse log ▸**) opens a sheet with the last 50 lines, newest first:

```
  9 Oct   Top-up · 200 gold · moved          Habitica 1,240 → 1,040
  9 Oct   Bought timber ×4 from Silas         − 6
  9 Oct   Ivy bought a whittled fox from your shelf   + 12
  8 Oct   Top-up · 500 gold · not confirmed  Habitica 1,740 → ?
```

**Where gold shows elsewhere** (question 2):

- **The HUD** shows gold beside embers (`src/ui/Hud.svelte:151-159`) on desktop, only once the
  purse holds some. Phones don't show it in the HUD; it's in the panels below.
- **The Character panel's Hero page** gets a Purse line under Embers (`CharacterPanel.svelte:133`),
  with a link to the Menu's purse card.
- **Prices** say which currency: *"Buy a lump of tallow · 1 ember"* and *"… · 2 gold"* are two
  choices at Hazel's (3.1); the shelf shows *"12 gold"* on a priced slot (3.2).

### 2.2 The top-up, step by step

`POST /api/purse/top-up` with `PurseTopUpRequest { op, token, amount }`. It's keyed like every
operation and needs the play lease, but it isn't a plain `keyedOp` (`server/internal/api/op.go:31`):
the Habitica calls run between two short transactions and never inside one.

**0. The token comes off the request first.** The handler copies `req.Token` to a local and sets
the field to `""` before anything reads the request, the way login does
(`server/internal/api/login.go:59-60`). That matters here because the generic idempotency path
hashes the whole payload (`opIdem`, `server/internal/api/op_idempotency.go:29`); the top-up keeps
its own key (below) and never puts the token near a hash, a row or a log. The route label is
logged and nothing else (`server/internal/api/routes.go:18-19`).

**1. Reserve** (transaction 1, no Habitica calls inside):

- The lease (`requireLease`, `op.go:20`).
- `profile_source` is `habitica` (`needs-habitica` otherwise; `server/internal/profile/profile.go:20`).
- A repeated `op.key` returns that top-up as it reads now: no new Habitica calls, and the token
  is dropped at once. The same key with a different amount is `idempotency-mismatch`, as
  elsewhere.
- No other top-up for this account is still working (`purse-busy`).
- Fewer than two top-ups counted today, UTC (`top-up-limit`; 2.5).
- The amount is a whole number from 1 to 99,999,999 (Habitica's gold cap; `invalid-quantity`).
- Insert a `purse_topups` row, state `reserved`. Commit.

**2. Habitica** (a worker on a context detached from the browser's, so a closed tab can't cut a
call in half; a hard limit of 60 seconds; the token lives only in the worker's memory):

| Step | Call | What follows |
|---|---|---|
| a. Leftovers | `DELETE /api/v3/tasks/glimway-topup-<id>` for each earlier row of this account marked `leftover` | 200 or 404 clears the mark. Anything else leaves it for next time and carries on |
| b. Gold | `GET /api/v3/user?userFields=stats.gp` | `_id` must be the account's Habitica subject. 401 or 403: settle `not-moved`, note `habitica-auth`. The gold is floored (`gold_before`). Less than the amount: settle `not-enough`, stop |
| c. Create | Mark the row `created` (a small transaction), then `POST /api/v3/tasks/user` `{"type":"reward","text":"Glimway purse: 200 gold","notes":"Glimway is moving gold into your purse. It removes this reward when it's done.","value":200,"alias":"glimway-topup-<id>"}` | 201: go on. Anything else, a timeout included: settle `not-moved` (nothing was scored, so nothing was charged), mark `leftover` (the task may exist), and go to e |
| d. Score | Mark the row `scoring`, then `POST /api/v3/tasks/glimway-topup-<id>/score/down` | 200: the charge happened; `gold_after` is the response's `data.gp`, floored. Settle `moved`. 401 "Not Enough Gold": settle `not-enough`. 429: Habitica refused before running it; wait `Retry-After` (at most 5 s) and send it once more. Anything else (a timeout, a network error, a 5xx): **unknown. Never send the score again.** Mark `checking` and go to 2.3 |
| e. Delete | `DELETE /api/v3/tasks/glimway-topup-<id>`, after every create, whatever the outcome | Fails: mark `leftover` |

- **Score `down`, never `up`.** `up` can roll a Habitica drop and award an achievement
  (habitica-gold.md §1), which would grant a Habitica item.
- **Never `PUT /user` with `stats.gp`** (habitica-gold.md §1).
- Every call carries the existing `X-Client` (`server/cmd/glimway-server/main.go:78`), a 10 s
  timeout, and redirects off (as `habitica.New` does today, `server/internal/habitica/client.go:31-33`).
- At most 12 calls in the worst case (two leftovers, the read, create, two scores, five checks,
  delete), plus the browser's sync read just before. Habitica allows 30 a minute per user, and a
  top-up is started by the player, so the 30-second pacing for background scripts doesn't apply
  (habitica-policy.md).

**3. Settle** (transaction 2): the row gets its final state, `gold_before`, `gold_after`,
`settled_at`, and for `moved` the purse is credited: `balances.gold += amount` and one `ledger`
row (`currency 'gold'`, reason `habitica-topup`, ref the top-up id), the same "no write replaces a
balance" rule as embers (`store.Credit`, `server/internal/store/store.go:258`). The player's version
moves, so the next answer carries the new balance. The worker's copy of the token goes out of
scope.

**The answer.** The POST waits for the worker up to 8 seconds. If it settled, it answers with the
final row and the new `PlayerState`. If not, it answers with the row as `working`, and the client
polls `GET /api/purse` every 3 seconds until the row settles (the worker's 60-second limit bounds
it). A closed tab loses nothing: the worker finishes, and the next purse read shows the outcome.

### 2.3 Unknown outcomes and the balance check

When the score call's outcome is unknown, the worker reads the balance again, with the token it
still holds, at about 2, 5, 10, 20 and 35 seconds after the failed call (`GET ?userFields=stats.gp`
each time):

| What a check reads | Then |
|---|---|
| Gold at or below `gold_before − amount` | **Moved.** Credit it now; `gold_after` is that reading. This is the owner's "credited automatically once a balance check confirms it" |
| By the last check, gold at or above `gold_before` | **Not moved.** Nothing credited; it doesn't count toward the day |
| By the last check, anything else, or every check failed | **Not confirmed.** Nothing credited; it counts toward the day; the log says so |

- The checks keep going past the first unclear reading because a score that timed out on our side
  may still be running on Habitica's. The last check, at 35 seconds, is meant to be after any such
  request has finished; lane B confirms Habitica's request timeout when it builds this, and moves
  the last check if it's longer.
- **The rare wrong answers, accepted.** If the player spends Habitica gold in the same seconds as a
  timed-out charge that didn't happen, the drop reads as ours and the purse gets gold it shouldn't.
  If they earn at least the amount in those seconds, a charge that did happen reads as not moved
  and we owe them. Both need a timeout and a coincidence; both leave `gold_before` and the readings
  in the log.
- **Not confirmed has nothing more to check.** Habitica keeps no gold history and the deleted
  reward keeps none either (habitica-gold.md §1), so a later sync can't tell. These rows are rare
  and the owner settles them from the command line (2.6, question 1). They don't block the next
  top-up.

### 2.4 A server that stops mid-top-up

The worker's state lives in the row, so nothing needs a background job:

- **A row is "working"** while it's `reserved`, `created`, `scoring` or `checking`. A partial
  unique index lets an account have only one.
- **When someone looks** (the purse read, the next top-up's reserve, `PlayerState`), a working row
  older than 90 seconds has no live worker behind it (the worker's limit is 60). It's settled then
  as `unconfirmed` if it got as far as `scoring` or `checking`, `not-moved` if it stopped at
  `reserved` or `created`, and marked `leftover` from `created` on. Time is worked out, not
  ticked (crafts.md rule 3).
- A leftover reward sits in the player's Habitica Rewards, priced at the amount, until the next
  top-up deletes it first thing (2.2 step a). Its notes say what it is. If the player clicks it,
  Habitica takes the gold and we credit nothing; the result line warns them (2.1).

### 2.5 The daily limit

- **Two top-ups per UTC day per account** (owner, 2026-10-07), from UTC midnight like the server's
  other daily caps (`utcDay`, `server/internal/api/item_wardens.go:11`).
- **They count:** `moved`, `unconfirmed`, and any working row. **They don't:** `not-enough`,
  `not-moved`, and a refused token. A top-up that moved nothing never uses up the day.
- **No amount cap** (owner). The amount is a whole number from 1 to the gold the worker reads.
- `PlayerState.purse.top_ups_left` carries what's left, so the card and the consent line agree
  with the server.

### 2.6 The owner's command line

Two subcommands beside the existing ones (`server/cmd/glimway-server/main.go:142` onwards):

- `purse list [--unconfirmed]`: id, account, amount, state, gold before and after, when.
- `purse settle <id> moved|not-moved`: only for an `unconfirmed` row. `moved` credits the purse
  (ledger reason `purse-settle`, ref the id); both mark the row settled by the owner. The owner
  decides after asking the player whether their Habitica gold dropped; the stored `gold_before`
  is the evidence.

### 2.7 Server and client

| | Server | Client |
|---|---|---|
| Habitica writes | `server/internal/habitica` grows four calls: `Gold`, `CreateReward`, `ScoreDown`, `DeleteTask`, each returning a coded `*habitica.Error` (never a body) as `VerifyLimited` does (`client.go:48-101`). The package comment ("the server's only upstream call: proof at login", `client.go:1`) is rewritten | The browser's Habitica client stays read-only (`src/lib/habitica/client.ts:94-97`); it never writes |
| Top-up | `purse-top-up` (2.2), the worker, the lazy settling of stale rows (2.4) | Reuses `syncCharacter`, then the consent card; sends the token from `memoryCredentials()` (`src/ui/habitica-local.ts:65`); polls the purse read while `working` |
| Balance | `balances.gold`, ledger currency `gold`; `PlayerState.purse` | `ui.stats.gold`, beside `ui.stats.embers` |
| Log | `GET /api/purse`: the purse, the last 50 top-ups and gold ledger lines, with names for shelf trades | The log sheet |
| Prediction | — | None for the top-up: it waits for the world's answer and shows **Needs a connection** offline |

---

## 3. Spending gold

Gold is the second currency, beside embers. Embers stay what you earn by playing (owner): lanterns,
rests, gates, the homestead and the stable keep their ember prices. Gold buys **goods**, and moves
**between players** through shelves. A debit never takes the purse below zero
(`CHECK(gold>=0)`), and every spend or sale is a `ledger` row with `currency 'gold'`.

### 3.1 The sellers

A seller's good can carry a price in embers, in gold, or both (`ItemGood`,
`proto/glimway/content/v1/items.proto:248-257`). Where both are set, the talk offers both as two
choices, each with its own label from content:

```
  Hazel
  "Tallow's an ember a lump and worth two, the pot renders sweet…"
    › Buy a lump of tallow · 1 ember
    › Buy a lump of tallow · 2 gold
    › Not yet
```

- The `items` operation's `buy` (`marketBuy`, `server/internal/api/market.go:19`) takes a new
  `pay` field: `embers` (the default, today's behaviour) or `gold`. A good without that price is
  `invalid-good`. Short of gold is `insufficient-gold`.
- **Caps count both currencies together.** The day's count stays the item-stack ledger lines
  (`market.go:42-51`), which every buy writes whatever it was paid with.
- **Silas sells materials, for gold only.** A new seller row at Silas's yard, standing where he
  mends (the `silas` mender row in `content/items.json` that `src/game/commons.ts:314` already
  reads for his spot: the Commons, tile 51, 21, within 4 tiles):

  | Good | Price | Cap a day |
  |---|---|---|
  | Timber ×4 | 6 gold | 3 |
  | Stone ×4 | 8 gold | 3 |
  | Fiber ×4 | 5 gold | 3 |

  The caps keep gold from replacing gathering: a top-up of thousands still buys twelve timber a
  day. Silas's line: *"Offcuts from the yard. I'll not sell you the good beams, you'll want to
  fell those yourself."* Numbers are tuning (section 11).
- **Gold prices on today's goods** (tuning): tallow 2, flour 2, the willow rod 5, madder scraps 2.
- On the client the talk's choices come from the seller rows (`src/game/entities/world-talk.ts:218-223`);
  a gold choice's action is `buy:<seller>:<item>:gold`. The fair stall's choices
  (`src/game/entities/village-life.ts:101`) do the same.

### 3.2 Friends' shelves

The gate shelf today holds free gifts: a member stocks a slot, and each traveller takes one a day
(`shelfMutation`, `server/internal/api/home_shelves.go:153`; the panel says so,
`src/ui/GateShelfPanel.svelte:181`). 0.6 lets a member put a price on a slot.

- **Stocking** takes an optional `price` in gold (0, the default, is a free gift as today; up to
  9,999). The slot shows it: *"Whittled fox · 12 gold"*.
- **Buying** is its own action, `buy`, so a free **Take** never costs anything by surprise. The
  buyer's purse pays the price to **whoever stocked the slot** (`gate_shelf_slots.stocked_by`), in
  one transaction: two `ledger` rows, `shelf-buy` (−) and `shelf-sale` (+), each with the other
  account and the item in its ref so both logs can name them.
- **A bought slot isn't a gift**, so it doesn't use up the one free take a day
  (`gate_shelf_takes`). Free slots keep that rule.
- **You can't buy your own stock** (`own-stock`). A partner on a joint deed can buy what the other
  stocked.
- **Taking a priced slot with `take`** is `invalid-operation`; the panel shows **Buy · 12 gold**
  instead of **Take gift** on it.
- Shelves stay unchecked for distance, as today (`home_shelves.go:174`).
- The panel's lede changes: *"Gifts and goods for travellers on the Commons lane. Take one gift a
  day; buy what has a price."*

### 3.3 Rules that hold everywhere

- **Gold never leaves the game.** No operation sends gold, gems, items or XP to Habitica.
- **Gold isn't earned in the game.** Selling on a shelf moves gold from one player to another; no
  resident, quest, find or sale to a seller creates gold. Its only source is a top-up.
- **One purse per account**, kept across world moves, like embers.
- **Offline:** gold buys need a connection (they spend shared or server state), as ember buys do.

---

## 4. The wardrobe

### 4.1 What the player sees

The Character panel's tabs (`src/ui/CharacterPanel.svelte:29-33`) become **Hero · Wardrobe ·
Companions**, shown only to a Habitica hero as today (`CharacterPanel.svelte:38`).

```
┌ Character ────────────────────────────────────────────┐
│  Hero   [ Wardrobe ]   Companions                     │
│                                                       │
│   ┌────────┐   WHAT YOU WEAR                          │
│   │  hero  │   [ Wear Habitica's look ]               │
│   │preview │                                          │
│   └────────┘                                          │
│  Head          Golden Helm               [ Change ]   │
│  Head extra    As on Habitica · none     [ Change ]   │
│  Eyewear       Nothing                   [ Change ]   │
│  Armor         Admiral's Uniform         [ Change ]   │
│  Body          As on Habitica · none     [ Change ]   │
│  Back          Bear Tail                 [ Change ]   │
│  Weapon        As on Habitica · Staff    [ Change ]   │
│  Shield        As on Habitica · none     [ Change ]   │
│                                                       │
│  Only how you look here. Your stats come from your    │
│  battle gear on Habitica, and Habitica stays as it is.│
└───────────────────────────────────────────────────────┘
```

- **Eight slots**, Habitica's drawn gear types: head, head extra (`headAccessory`), eyewear, armor,
  body, back, weapon, shield. `weaponSpecial` in `rules.Slots` (`server/internal/rules/rules.go:110`)
  is never drawn and isn't offered.
- **Each slot reads** *As on Habitica* (with the piece Habitica shows there now), a piece you own,
  or *Nothing*.
- **Change** opens the gear picker for that slot, the same full-height sheet as the pet picker
  (`src/ui/CompanionsPicker.svelte`): a search field, a row of chips (Warrior, Mage, Rogue, Healer,
  Armoire, Special, Subscriber, from the catalog's `klass`), and a grid of what you own for that
  slot. The first two entries are always **As on Habitica** and **Nothing**.
- **Each tile** shows the piece on a plain figure (skin, shirt, head, and that one piece), cropped
  to the slot: the head and its extras show the head, armor and body the torso, weapon and shield
  the whole figure. The figure uses your own skin and shirt, so it reads as you.
- **Wear the set.** When the piece you pick belongs to a set you own other pieces of (the catalog's
  `set`), a line under the grid offers *"Wear the whole Admiral's set (3 pieces)"*. One tap fills
  those slots.
- **The preview** at the top is your hero, drawn with the same layers as in the world, and changes
  as soon as you pick. Choices take effect at once and hold across sessions and devices. Friends
  see them.
- **Wear Habitica's look** sets every slot back to *As on Habitica*.
- **A piece you no longer own** reads as *As on Habitica* until it's back (4.2). If you don't own
  anything for a slot beyond what's equipped, the picker says so: *"Nothing else for this slot
  yet. Gear you earn on Habitica turns up here after a sync."*
- **Habitica's costume setting still counts.** *As on Habitica* means what Habitica shows: the
  costume when **Show costume** is on there, the battle gear when it's off.

### 4.2 The rules

- **Per account, per slot:** a row in `player_wardrobe` (migration 032) holds a gear key or the
  reserved `none` ("Nothing"). No row means *As on Habitica*. `none` can't collide with a Habitica
  key (they're `type_klass_index`).
- **The `wardrobe` operation** writes the whole choice at once: a map of slot to key or `none`;
  slots left out go back to *As on Habitica*. It checks the profile source (`needs-habitica`),
  each slot name (`invalid-slot`), and each key: in the owned list, known to the catalog, of that
  slot's type, and not a `*_base_0` "none" piece (`gear-not-owned`).
- **Every key is checked when someone looks**, as companions are (`CompanionsFor`,
  `server/internal/store/companions.go:63`). A key no longer owned, or no longer in the catalog,
  reads as *As on Habitica*; the stored row stays until the player changes the slot, so a piece
  that comes back (Habitica lets a warrior re-buy gear lost to death) comes back to its place.
- **No homestead gate.** Unlike the companions, clothes don't need a home. The wardrobe works
  anywhere, in any world (question 4).
- **The look**, one function on each side with shared vectors (`content/vectors/wardrobe.json`):

  ```
  lookFor(profile, chosen) → map slot → key | null
    for each drawn slot:
      chosen[slot] == "none"  → null
      chosen[slot] is a key   → that key
      otherwise               → profile.useCostume ? profile.costume[slot] : profile.equipped[slot]
  ```

  The avatar's existing rules then apply unchanged: a two-handed weapon hides the shield, a `*_base_0`
  piece draws nothing (`src/lib/habitica/avatar.ts:250-254` picks costume or equipped today;
  `:363-372` hides the shield).
- **Stats never change.** Combat reads `equipped` alone (`habitica.Map`, `client.go:196-212`;
  `HabiticaProfile.equipped`, `src/lib/habitica/types.ts:76-77`). The wardrobe is drawn and never
  counted, like Habitica's own costume.
- **Nothing is written to Habitica.** The wardrobe never calls `POST /user/equip`. Habitica's
  equipped gear and costume stay as the player left them.

### 4.3 Reading owned gear

`items.gear.owned` is a map of gear key to a boolean in Habitica: `true` is owned, and `false` is
gear the player had and lost (a warrior's death penalty), which can be bought again there.

- **Both field lists gain it**, in the same change: `USER_FIELDS` (`src/lib/habitica/client.ts:18-19`)
  and the server's sign-in read (`server/internal/habitica/client.go:50`).
- **Both mappers read it**: a key is owned when its value is `true`. `habitica.Map`
  (`client.go:134-143`) and `toHabiticaProfile` (`src/lib/habitica/mapping.ts:230-250`) gain the
  list, sorted, keeping only keys the catalog knows (an unknown key can't be drawn; `assetSourceFor`
  would skip it anyway, `avatar.ts:185-199`).
- **The `profile` operation's raw projection** gains `items.gear.owned`
  (`HabiticaUserGear`, `proto/glimway/v1/profile.proto:37-40`). The browser already posts the
  raw `/user` it read (`src/game/link.ts:1589-1596`); the new field rides along.
- **Size.** A collector's owned map is about 60 KB of JSON; with pets and mounts the profile
  report nears 110 KB, under the 200 KB body limit (`server/internal/api/decode_op.go:14`). Lane C
  adds a test with every catalogued pet, mount and gear key, and raises the limit for
  `/api/profile` alone if it doesn't fit.
- **Stored with the profile.** `rules.Profile` (`rules.go:88-108`) gains `GearOwned`, kept in
  `sync_baselines.profile_json` like the pets and mounts. It is **not** put on `PlayerState`'s
  profile (which every answer carries); the picker reads it from `GET /api/wardrobe`.
- **Checked against a real account** before the release (habitica-boundary.md checklist): lane C
  writes down what a real `owned` map holds (the `*_base_0` starters, mystery items, lost gear as
  `false`) in `docs/habitica-foundations.md`.

### 4.4 Server and client

| | Server | Client |
|---|---|---|
| Choosing | `wardrobe` operation (6.2); writes `player_wardrobe`; the room hears an avatar change | Predicts the new look at once; queues offline in curated areas, like `companions` |
| Reading | `PlayerState.wardrobe` (the resolved choice); `GET /api/wardrobe` (owned keys for the picker, the choice) | The tab, the picker, the preview |
| Your hero | — | `visualProfile` (`src/game/avatar-render.ts:55-61`) draws `lookFor(profile, wardrobe)` as the costume, so the world avatar, the preview and the tiles share one path |
| Presence | `visualAvatar` (`server/internal/api/presence_auth.go:175`) sends the resolved look as `costume` with `use_costume` true when any slot is chosen. **No presence change:** other players' screens draw it with today's code (`loadPresenceAvatar`, `avatar-render.ts:189`) | Nothing new |
| Art | The sprite proxy already allows every catalogued gear sprite (`knownSprites`, `server/internal/api/sprites.go:106`) | Tiles load lazily as the grid scrolls; the proxy fetches four at a time and keeps them, so a big wardrobe fills in over a few seconds the first time |
| Names | — | Gear names from the catalog (`text`, question 3), with the key's words as a fallback |

---

## 5. Guests and the profile source

Guests (`profile_source: none`, [guests.md](guests.md)) have no Habitica, so:

- **No top-up.** The purse card shows no Top up button. `purse-top-up` refuses with
  `needs-habitica` (`profile.EarnsXP` and `profile.For` already branch on the source,
  `server/internal/profile/profile.go:20-42`; the top-up adds the same check).
- **A purse that starts empty.** A guest's purse exists and can fill only by selling on a shelf.
  It can buy what that gold buys. This keeps gold an account thing, not a Habitica thing, so the
  standalone version needs no second path.
- **No wardrobe.** The tab isn't shown, `wardrobe` refuses with `needs-habitica`, and the guest
  looks like Wren, the default guest look (guests.md, "The profile source"). Nothing stands in for
  Habitica gear (boundary rule 2).
- **Linking Habitica later** (guests.md "Linking Habitica later") gives the wardrobe at once; the
  purse keeps what it holds.

Guest accounts arrive with the standalone track, so in 0.6 this is only the checks above and their
tests. guests.md's line "Gold purse, wardrobe: none" becomes "No top-up; a purse that fills from
shelf sales; no wardrobe (Wren's look)".

---

## 6. Operations, content and migrations

### 6.1 Protos

All in one change on the integration branch (lane A). Field numbers checked against `afa8363`:
`PlayerState` ends at `fishing = 10` (`proto/glimway/v1/state.proto:31-35`); the `Envelope` oneof
at `fish_cancel = 39` (`state.proto:39-59`); `HabiticaUserGear` at `costume = 2`
(`profile.proto:37-40`); `ItemsRequest` at `good = 19` (`proto/glimway/v1/items.proto:36-43`);
`Bought` at `embers = 4` (`items.proto:21`); `ShelfSlot` at `stocked_at = 8`, `ShelfRequest` at
`asset = 6` (`proto/glimway/v1/homestead.proto:44-58`); content `ItemGood` at `line = 6`;
`HabiticaGearItem` at `gear_set = 16` (`proto/glimway/content/v1/habitica_gear.proto:71-91`); the
last error is `ERROR_CODE_NO_CAST = 219`.

```proto
// glimway/v1/purse.proto (new)
message PurseTopUp {
  string id = 1;
  int32 amount = 2;
  string state = 3;        // working | moved | not-enough | not-moved | unconfirmed
  google.protobuf.Int32Value gold_before = 4;   // Habitica's, floored; absent until read
  google.protobuf.Int32Value gold_after = 5;
  double started_at = 6;
  google.protobuf.DoubleValue settled_at = 7;
  bool leftover = 8;       // a reward may still be in the player's Habitica Rewards
  string note = 9;         // a code: habitica-auth, timeout, checked, settled-by-owner
}
message Purse {
  int32 gold = 1;
  int32 top_ups_left = 2;  // today, UTC
  PurseTopUp working = 3;  // absent when none is working
}
// The token is used for this one request and never stored, logged or returned.
message PurseTopUpRequest { OpHeader op = 1; string token = 2; int32 amount = 3; }
message PurseTopUpResult { PurseTopUp top_up = 1; }
message PurseLine {
  double at = 1; int32 delta = 2; string reason = 3;   // habitica-topup | market-buy | shelf-buy | shelf-sale | purse-settle
  string item_def = 4; int32 qty = 5; string other_name = 6;   // the shelf trade's other player
}
message PurseRead { Purse purse = 1; repeated PurseTopUp top_ups = 2; repeated PurseLine lines = 3; }   // GET /api/purse

// glimway/v1/wardrobe.proto (new)
// Per slot, resolved: absent = as on Habitica; "none" = nothing worn there; else an owned gear key.
message Wardrobe { map<string, string> chosen = 1; }
message WardrobeRequest { OpHeader op = 1; map<string, string> chosen = 2; }
message WardrobeResult { Wardrobe wardrobe = 1; }
message WardrobeRead { repeated string owned = 1; Wardrobe wardrobe = 2; }   // GET /api/wardrobe

// state.proto
message PlayerState { /* 1–10 as today */ Purse purse = 11; Wardrobe wardrobe = 12; }
message Envelope { oneof result { /* 10–39 as today */
  PurseTopUpResult purse_top_up = 40; WardrobeResult wardrobe = 41; } }

// profile.proto
message HabiticaUserGear { /* 1–2 */ map<string, google.protobuf.Value> owned = 3; }

// items.proto
message ItemsRequest { /* 1–19 */ string pay = 20; }   // "" or "embers" | "gold", for buy
message Bought { /* 1–4 */ int32 gold = 5; }

// homestead.proto
message ShelfSlot { /* 1–8 */ int32 price = 9; }       // gold; 0 is a free gift
message ShelfRequest { /* 1–6 */ int32 price = 7; }    // with stock; action gains "buy"

// content/v1/items.proto
message ItemGood {
  // embers: 0..1000 (0 = not for embers); was 1..1000
  optional int32 gold = 7 [(buf.validate.field).int32 = {gte: 1, lte: 100000}];
  optional string gold_label = 8 [(buf.validate.field).string = {min_len: 1, max_len: 80}];
  // CEL: embers > 0 || has(gold); has(gold) == has(gold_label)
}

// content/v1/habitica_gear.proto
message HabiticaGearItem { /* 1–16 */ optional string text = 17; }   // English name from Habitica's content
```

- **New error codes**, appended as 220–224: `purse-busy`, `top-up-limit`, `insufficient-gold`,
  `own-stock`, `gear-not-owned`. Reused: `needs-habitica` (210), `invalid-quantity`,
  `invalid-slot`, `invalid-good`, `invalid-operation`, `idempotency-mismatch`, `superseded`.
  `habitica-auth`, `habitica-unavailable` and `habitica-rate-limited` don't become refusals of the
  top-up: they end up in the row's `note`, since the row is already reserved by then.
- **The contract number** goes from 5 to 6 (`content/contract.json`): the state, the envelope and
  the item and shelf requests change shape, so 0.5 tabs get the reload notice.
- **Presence doesn't change** (4.4).

### 6.2 The operations

| Operation | Route · result | Server checks and does | Client predicts | Refusal |
|---|---|---|---|---|
| **purse-top-up** | `POST /api/purse/top-up` · `purse_top_up` | 2.2–2.5 | Nothing: *Moving gold…* until the answer | `needs-habitica` / `purse-busy` / `top-up-limit` / `invalid-quantity` |
| **purse** (read) | `GET /api/purse` · `PurseRead` | Settles stale working rows (2.4); the last 50 top-ups and gold lines | — | — |
| **wardrobe** | `POST /api/wardrobe` · `wardrobe` | Profile source `habitica`; each slot drawn; each key owned, catalogued, the slot's type, not a none-piece; writes `player_wardrobe`; avatar change to the room | The new look | `needs-habitica` / `invalid-slot` / `gear-not-owned` |
| **wardrobe** (read) | `GET /api/wardrobe` · `WardrobeRead` | The owned, catalogued keys and the choice | — | — |
| **items `buy`** (grown) | as today | `pay: gold` debits the purse; the good must have a gold price | Gold down, goods in the pack | `invalid-good` / `insufficient-gold` / today's codes |
| **shelf `stock`** (grown) | as today | `price` 0–9,999 | Slot shows the price | `invalid-quantity` / today's codes |
| **shelf `buy`** (new action) | `POST /api/homestead/shelf` · as today | Slot priced; not your own stock; buyer's purse covers it; pays the stocker; no daily take used | Gold down, item in the pack | `own-stock` / `insufficient-gold` / `slot-empty` / `invalid-operation` |
| **shelf `take`** (grown) | as today | A priced slot is `invalid-operation` | As today | As today |
| **profile** (grown) | as today | Maps `items.gear.owned` | — | As today |
| **login** (grown) | as today | Reads `items.gear.owned` | — | As today |

**Offline**, in curated areas: `wardrobe` queues in the outbox (predictable, can't fail on shared
state). The top-up, the reads, gold buys and shelf buys show **Needs a connection**.

### 6.3 Content files

| File | Change | Lane |
|---|---|---|
| `content/items.json` + `items.proto` | `gold` and `goldLabel` on Hazel's, Finn's and the madder stall's goods; the `silas-yard` seller with the three material bundles (3.1) | A |
| `content/habitica-gear.json` + `habitica_gear.proto` | `text` for every catalogued key, from the same public `GET /api/v3/content` the numbers came from, at the same keys; provenance gains the retrieval date for names; `modifications` no longer says text is omitted (question 3) | A |
| `content/vectors/wardrobe.json` | Cases for `lookFor`: as on Habitica with and without costume, `none`, a chosen key, a lapsed key, a two-handed weapon over a chosen shield | A |
| `content/vectors/items-loader.json` | A good with neither price, gold without a label | A |
| `content/contract.json` | 6 | A |

### 6.4 Migration 032 `purse_wardrobe`

0.5 ended at 031 (`031_level_mark.sql`), so 0.6 is **032**, one migration, lane A. Existing
migrations aren't touched.

| Table | What |
|---|---|
| `balances` | gains `gold INTEGER NOT NULL DEFAULT 0 CHECK(gold>=0)` |
| `purse_topups` | `id TEXT` PK; `account_id` FK players; `op_key TEXT NOT NULL`; `amount INTEGER NOT NULL CHECK(amount>0)`; `state TEXT NOT NULL CHECK(state IN ('reserved','created','scoring','checking','moved','not-enough','not-moved','unconfirmed'))`; `gold_before INTEGER`; `gold_after INTEGER`; `note TEXT NOT NULL DEFAULT ''`; `leftover INTEGER NOT NULL DEFAULT 0`; `created_at INTEGER NOT NULL`; `settled_at INTEGER`; `settled_by TEXT` (`worker`, `look`, `owner`). Unique `(account_id, op_key)`; a unique partial index on `account_id` where the state is one of the four working states; an index on `(account_id, created_at)` |
| `player_wardrobe` | `(account_id, slot)` PK; `slot` one of the eight; `gear_key TEXT NOT NULL CHECK(gear_key<>'')` |
| `gate_shelf_slots` | gains `price INTEGER NOT NULL DEFAULT 0 CHECK(price>=0 AND price<=9999)` |

The `ledger` needs no change: `currency` is free text, and `'gold'` joins `'embers'`,
`'material:*'` and `'item:*'` (`content.StackCurrency`, `content/items.go:356`). No backfill: no rows
means an empty purse, Habitica's look and free shelf slots. Upgrade tests use 0.5's fixture
pattern: the owner's account loads, its purse is 0, it looks as Habitica shows it, and ledger
sums are unchanged.

### 6.5 What the client keeps and predicts

- `src/lib/purse.ts`: amounts, the consent copy's numbers, `topUpsLeft`, the log lines' words.
- `src/lib/wardrobe.ts`: `lookFor` (shared vectors), slot names, the picker's grouping by `klass`,
  set lookup, names from the catalog.
- `predict.ts` gains `wardrobe` and the gold side of `buy` and shelf `buy`; `link.ts`'s `TYPED`
  registry and the outbox kinds gain `wardrobe` (`src/lib/api/operations.ts`, `outbox.ts`).
- The top-up isn't predicted and isn't in the outbox.

### 6.6 Copy that changes with the purse

Today the game promises it never writes. These change in the same release, saying exactly what the
purse writes (habitica-boundary.md "close to the line" 4; the TODO in habitica-policy.md):

- **README** "How your Habitica token is handled": *"Glimway is read-only"* (`README.md:60-64`) and
  *"once, at login"* (`README.md:78-81`). New text: the game reads your profile; it writes to
  Habitica only when you press **Top up** and agree, and then only to move the gold you chose (a
  reward created, bought and removed); the token goes to the server for that one request and is
  never stored, logged or returned.
- **The connect guide**: *"The game limits itself to reading"* (`src/content/connect-guide.ts:128`).
- **`docs/import-contract.md:20`**: the browser's `HabiticaClient` stays read-only; add that the
  server writes for a top-up, and nowhere else.
- **`docs/expansion-design.md:36`**: "one read-only `GET /user` per sign-in".
- **The About card** (`src/ui/MenuPanel.svelte:213`): *"your Habitica token never is"* stays true;
  add *"Gold moves from Habitica only when you top up your purse."*
- **`docs/habitica-boundary.md`**: the Gold and Owned gear rows, and its open questions (6.7's
  answers).
- **`docs/habitica-policy.md`**: the "Stop on failure" row and the TODO.
- **`docs/habitica-gold.md`**: a status line pointing here; its sign-in row, owner settling and
  migration 026 are superseded.

### 6.7 "What's new"

Under `[Unreleased] → ### For players` in `CHANGELOG.md` (line 14), in this order:

- You can move gold from Habitica into a purse here. Find it in the Menu, under your Habitica
  hero. It spends Habitica gold, and you're asked each time.
- Purse gold buys goods from Hazel, Finn and the fair stall, and timber, stone and fiber from
  Silas.
- Put a price in gold on things you leave on your gate shelf. Friends pay you when they buy them.
- Wear any Habitica gear you own. Choose it in the Character panel's new Wardrobe tab. Your stats
  and your Habitica outfit stay as they are.

---

## 7. The Habitica boundary

Checked against [habitica-boundary.md](../habitica-boundary.md), rule by rule.

**Mirrored from Habitica (read, never granted):**

| What | Habitica field | Used for |
|---|---|---|
| Gold | `stats.gp` | The consent card (the browser's read) and the top-up's check (the server's own read) |
| Owned gear | `items.gear.owned` (value `true`) | **New.** The wardrobe's picker and checks |
| Worn gear, costume | `items.gear.equipped`, `items.gear.costume`, `preferences.costume` | *As on Habitica*; stats from `equipped` only, as today |
| Gear art | Habitica's sprite host, through the proxy | The wardrobe's tiles and the look |

**Written to Habitica (new, the purse only):** a reward task created, scored `down` once, and
deleted, for the amount the player typed, during a request the player started.

**The game's own:** the purse balance after the move, the wardrobe *choice*, shelf prices, Silas's
material bundles.

**The rules, one by one:**

1. *Never grants a Habitica item, pet, mount, background or currency.* Scoring `down` (never
   `up`) rolls no drop and no achievement. The wardrobe only shows gear the player owns.
2. *No copies.* Nothing stands in for gear: a lapsed piece reads as Habitica's look, a slot with
   nothing owned offers only *As on Habitica* and *Nothing*, guests look like Wren.
3. *Game items fill gaps.* Silas's bundles are Glimway materials. No new item is worn gear.
4. *Gear decides the look.* The wardrobe draws only Habitica gear on the hero. Glimway's tools and
   carried things are drawn as they are today, never in a gear slot.
5. *Writes need consent each time, in Habitica's words, logged in-game.* The consent card on every
   top-up, "this spends Habitica gold", the reward's own name and notes, the purse log. The token
   is used for that request and never kept. README and connect guide change (6.6).
6. *Value flows into the game only.* No operation pays out. Shelf sales move gold between players
   inside the game.
7. *Guests.* No top-up and no wardrobe (section 5).

**The checklist's "a reason to skip Habitica?"** No: gold is earned only on Habitica, and the
wardrobe only shows what Habitica gave you.

**Answers for the boundary doc's open questions** (update it when 0.6 ships): *The wardrobe* — a
player can wear a different outfit in Glimway, chosen from owned gear, without a write to Habitica.
*Habitica gold beyond the purse* — still no Habitica purchases from inside Glimway. *Companions*
and *Mounts* were answered by 0.5 and the doc still lists them (see the report).

---

## 8. Phones

Every new interaction works by touch, through the controls phones already have; targets are at
least 44 CSS px (crafts.md §8).

| Interaction | On a phone |
|---|---|
| The purse card and Top up | The Menu, as today; the button is full width |
| The consent card | A full-height sheet. The amount field is `inputmode="numeric"`, large, and the sheet scrolls so the buttons sit above the keyboard. **Not now** and **Move** are the same size, side by side |
| *Moving gold…* / *Checking with Habitica…* | One line in the sheet, no animation; the sheet can be closed and the outcome comes as a toast |
| The purse log | A full-height sheet, one line per entry, wrapping |
| Gold beside embers | Not in the HUD on phones (no room beside the goal); in the Hero page and the purse card |
| Buying with gold | The talk's choices, as for embers |
| A shelf price | A number field on the stock sheet; **Buy · 12 gold** on the slot |
| The Wardrobe tab | Tabs at the top as the journal's. The preview sits above the slot list, smaller; each slot row is one tap target |
| The gear picker | The pet picker's sheet: search, chips that scroll sideways, a grid three across; *Wear the whole set* sits above the grid when it applies |

---

## 9. Art list

One small request for the image-generation round; `docs/art-request-purse.md` is written from
this list when the round starts. Same direction as `docs/art-request-crafts.md`: **64 texels per
16 px world tile**, 1 px dark warm-brown outlines at that density, light from the upper left,
crisp pixels, transparent backgrounds. Deliver into `assets/generated/purse-pass/` with
`manifest.json`, `atlas.json`, README and `prompts.json` notes.

**No Habitica art is made.** Gear is Habitica's sprites, through the proxy. The gold coin is
Glimway's own and must not look like Habitica's gold icon (a round coin with a lamp stamped on
it, worn at the rim, not Habitica's stacked coin).

| Piece | Canvas (texels) | Notes |
|---|---|---|
| Gold coin | 64 × 64, and a 32 × 32 version for the HUD | Glimway's coin: brass-gold, a small lamp stamped on its face, a worn rim |
| Purse | 64 × 64 | A drawstring leather purse, a coin at its mouth; the purse card's and the log's icon |
| Wardrobe | 64 × 64 | A coat and a hat on a peg rail; the tab's icon where icons show |
| Price tag | 32 × 32 | A paper tag on a string, for priced shelf slots |
| Silas's bundles | — | None: the timber, stone and fiber icons are reused with a ×4 badge drawn in code |

---

## 10. Lanes

### 10.1 The lanes

**One integration branch,** `exp/purse`, cut from `main` at `afa8363`. Lanes merge into it. Each
keeps `go test`, `npm run verify` and its unit tests green, runs only its own changed e2e specs at
the end, and the full suite runs once at the integration gate (e2e load).

| Lane | What | Owns (files) | Depends on | Size | Kind | Model |
|---|---|---|---|---|---|---|
| **A. Contracts** (merges first) | Every proto change in 6.1 and the generated code; contract 6; error codes 220–224; migration 032 (schema only); `items.json` gold prices and Silas's seller; the catalog's `text` names; `wardrobe.json` vectors; the loader rule for `ItemGood` | `proto/**`, generated code, `content/{items,habitica-gear,contract}.*`, `content/vectors/{wardrobe,items-loader}.json`, `server/internal/store/migrations/032_*` | `main` at `afa8363` | **S–M** | backend | MiMo |
| **B. The top-up, server** | The four Habitica calls; `purse-top-up` with its worker, the checks, the leftovers, the lazy settling; `GET /api/purse`; `balances.gold` and the gold ledger helpers (`creditGold`, `debitGold` beside `debitEmbers`, `server/internal/api/mutation.go:60`); `PlayerState.purse`; the `purse` CLI; the fake Habitica's task endpoints and switches (`e2e/server/fake-habitica.ts`); `TestTokenCookieAndBackup` (`server/internal/api/api_test.go:18`) extended to a top-up: the token in no file, backup, log, idempotency row or answer | `server/internal/habitica/**`, `server/internal/api/purse*.go` (new), `server/internal/store/**` for its tables, `server/cmd/glimway-server/main.go` (the CLI case), `e2e/server/fake-habitica.ts` | A | **M–L** | backend, correctness-heavy | MiMo; **Sol reviews** |
| **C. Gold spending and the wardrobe, server** | `pay: gold` in `marketBuy`; shelf `price`, `buy`, `own-stock`; the shelf's ledger lines; `items.gear.owned` in `habitica.Map` and `rules.Profile`; the `wardrobe` operation and read; `rules.Look` with A's vectors; `visualAvatar` sending the look; the profile body-size test; the real-account note in `habitica-foundations.md` | `server/internal/api/{market,home_shelves,wardrobe}.go` (wardrobe new), `presence_auth.go` (`visualAvatar` only), `server/internal/rules/**`, `server/internal/habitica/client.go` (`Map` only; B owns the rest of the package, so C's change lands first or as a small request to B) | A; B's gold helpers (or C writes them and B adopts) | **M** | backend | MiMo; Opus reviews |
| **D. The purse, in the game** | The purse card in the Menu; Top up (sync, consent, polling, outcomes); the log sheet; gold in the HUD and the Hero page (a `PurseLine.svelte` component F places); gold choices in the talk and at the fair stall; shelf prices and **Buy**; predictions for gold buys; `ui.stats.gold`; the copy in 6.6 (README, connect guide, About card, import contract, expansion-design, habitica-boundary, habitica-policy, habitica-gold); the "What's new" lines | `src/ui/{MenuPanel,ConnectGuide,GateShelfPanel,Hud}.svelte`, `src/ui/Purse*.svelte` (new), `src/lib/purse.ts` (new), `src/game/entities/{world-talk,village-life}.ts` (seller choices only), `src/content/connect-guide.ts`, `README.md`, the docs in 6.6, `CHANGELOG.md` | A (fixtures before B and C merge) | **M** | UI/game | Opus |
| **E. The wardrobe, in the game** | `items.gear.owned` in `USER_FIELDS` and `toHabiticaProfile`; `lookFor`; the Wardrobe tab, the gear picker (sharing the pet picker's layout and styles, not a copy of its logic), the tiles, *Wear the whole set*, the preview; `visualProfile` drawing the look; the `wardrobe` prediction and outbox kind; the Character panel's third tab and placing D's `PurseLine` | `src/lib/habitica/{client,mapping,types}.ts`, `src/lib/wardrobe.ts` (new), `src/ui/CharacterPanel.svelte`, `src/ui/{Wardrobe,GearPicker,GearTile}*.svelte` (new), `src/game/avatar-render.ts` | A | **M** | UI/game | Opus |
| **F. Art** | Section 9 as one request | `assets/generated/purse-pass/**`, `docs/art-request-purse.md` | nothing | **S** | art | Luna |

### 10.2 Order

1. **F starts at once**; D and E use the existing ember icon and text until it lands.
2. **A merges** (a day). It fixes the files every other lane reads.
3. **B and C (server) and D and E (game) run in parallel.** D and E work against fixtures from A
   until their server lanes merge.
4. **The seams, each with one owner:**
   - `CharacterPanel.svelte`: E adds the Wardrobe tab and places D's `PurseLine` in the Hero page.
   - `server/internal/habitica`: B owns it; C's `Map` change is a few lines and lands first.
   - The gold ledger helpers: B writes them early (a small first merge); C uses them.
   - `link.ts`'s `TYPED` registry and `predict.ts`: each lane appends its own entries.
   - `MenuPanel.svelte` and `ConnectGuide.svelte`: D alone.
5. **D and E wire F's pack** when it arrives (`atlas-plan.ts`).
6. **The integration gate:** the full e2e suite, then the owner's live check (10.3), then the
   owner's playtest.
7. After the release, the review round (plan.md, "Stepping back between releases").

**e2e,** run only by their lane until the gate: a top-up that moves gold, against the fake
Habitica (D, with B's stub); a top-up refused for not enough gold; a top-up whose score times out
and whose check confirms it (B's stub switch); buying flour from Finn with gold (D); stocking a
priced item and a second player buying it, both purse logs naming the other (D, two players); a
wardrobe choice surviving a reload, and a friend seeing it (E, two players); a lapsed piece reading
as Habitica's after a sync without it (E).

**Server tests that matter most** (B): every row of the 2.2 table and the 2.3 table, each against
the stub; a repeated key making no new calls; the daily count with each state; a working row
settled lazily after 90 s; leftovers deleted first; the token never reaching the database, a
backup, a log line or an answer.

### 10.3 The owner's live check

Agents never hold a Habitica token. Before the purse reaches a real account, the owner tops up a
**throwaway Habitica account** on a local server (habitica-policy.md, "Testing"): one top-up that
moves, one for more than the balance, and a look at that account's Rewards column afterwards (no
leftover). Lane B writes the steps into `docs/habitica-gold.md` as a short "Live check" section.

**The owner's playtest:** top up a small amount, read the log; buy timber from Silas and flour
from Finn with gold; price something on the shelf and have a friend buy it; dress the hero from
the wardrobe, see it from a friend's screen, sync with Habitica's costume toggled, and press *Wear
Habitica's look*.

---

## 11. Open questions, with defaults

These go ahead as written unless the owner says otherwise. Everything the owner already decided
(the button, two a day, no amount cap, automatic credit on a confirming check, staff later) is
taken as decided.

1. **Top-ups no check can confirm.** *Default: they stay "not confirmed", credit nothing, count
   toward the day, don't block the next top-up, and the owner settles them with `purse settle`.*
   Habitica keeps no gold history, so nothing later can tell. The alternative is crediting them
   all and accepting the odd free gold.
2. **Where gold shows.** *Default: beside embers in the HUD on desktop once the purse holds some;
   on phones only in the Hero page and the Menu's purse card.* The phone HUD has no room beside the
   goal.
3. **Gear names.** *Default: add Habitica's English gear names (`text`) to the bundled catalog,
   from the same public content endpoint, under the same GPL-3.0 notice as the numbers.* Without
   them the picker would show names made from keys ("Admirals Uniform").
4. **The wardrobe needs no homestead.** *Default: it works anywhere.* Companions are gated on a
   homestead because pets need somewhere to live; clothes don't. A later "dress at the wardrobe at
   home" idea could be a furnishing.
5. **Silas's Yard stays embers and materials.** *Default: yes.* Gold buys goods and materials, but
   the homestead is the game's long progression and earning it stays in play. Silas's offcut
   bundles give gold a use at the yard without buying the house.
6. **Gold between players is the shelf only.** *Default: no gold in letters and no gold handed
   over in person in 0.6.* Selling covers trading; a plain gift of gold moves Habitica value from
   one account to another with nothing in return, which the owner may want to think about first.
7. **Shelf prices and the daily take.** *Default: a bought slot doesn't use up the free take; you
   can't buy your own stock; the gold goes to whoever stocked the slot; a price is 1 to 9,999.*
8. **The top-up syncs first, so it shares the sync's safe places.** *Default: yes, Hearthwick or
   the Commons,* as the owner's "syncs, then tops up" reads. A top-up alone needs no safe place, so
   the alternative is a Top up that skips the sync away from town and shows the last synced gold.
9. **The off-hand name.** *Default: the wardrobe calls Habitica's slot "Shield", and Glimway's own
   "off hand" is renamed "at your belt" in the copy now* (`src/content/inventory.ts:70`,
   `src/content/errors.ts:70-71`). The boundary doc left the name to the owner (its item 1); the
   wardrobe puts both on one screen, so it's worth settling in this release. Drawing the carried
   thing at the hip stays for later.

**Tuning, not decisions** (playtest them, change data): Silas's bundle sizes, gold prices and caps;
the gold prices on Hazel's, Finn's and the stall's goods; the check times after a timeout (2, 5,
10, 20, 35 s); the 8-second wait before the POST answers *working*; the 50 lines in the log.
