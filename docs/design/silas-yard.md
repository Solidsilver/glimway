# Glims and Silas's Yard

Status: **design, confirmed by the owner**, 2026-10-10, from a brainstorm while playtesting 0.6 on
`dev` (`e6ae020`). Two parts, two releases:

- **Part 1, glims (0.6.1).** Embers and the gold purse merge into one currency,
  **glims**. You earn them from Habitica XP as you earn embers today, and a top-up turns Habitica
  gold into them, two gold to a glim, at most 30 glims a day.
- **Part 2, Silas's Yard (0.7).** Silas's cottage becomes a shop you walk into. Silas's talk
  gets as short as Hazel's, a tabbed Yard panel does the selling, and a new clerk, **Pell**,
  keeps the deeds in a side room with a real signing table.

**The problem, in the owner's words:** *"make talking with Silas a bit more regular like other
NPCs, but let's actually update his house to be his shop, and we can buy things there, have
different categories of things – and we need to have a good philosophy on what coins vs embers
buy … just talking with Silas is becoming a lot."* By 0.6, a homeowner talking to Silas
could get nine choices: build on a workshop, see what you've finished, share the deed, give up my
place, three gold bundles, hear it again, just passing (`talkToSilasNow`,
`src/game/entities/homestead-talk.ts:455`, plus `say(…, { yard: true })` at `:396`).

**Rules this design keeps:** [server-first.md](server-first.md) (the server owns state, the
client predicts and draws), [habitica-boundary.md](../habitica-boundary.md) (the game never grants
or duplicates Habitica items), and the purse's five rules from
[purse-and-wardrobe.md](purse-and-wardrobe.md), with "gold" read as "glims" wherever the purse
lives inside Glimway (1.6).

---

## 0. The owner's answers (2026-10-10)

| # | Question | Answer |
|---|---|---|
| 1 | Direction | **A walk-in shop.** His cottage gets an interior with a counter that opens a tabbed panel; his talk shrinks |
| 2 | The place's name | **Silas's Yard** (kept) |
| 3 | Coins vs embers | **One currency, two ways in.** Earned from Habitica XP, as embers are now, plus top-ups that turn Habitica gold into it. The owner first explored mirroring Habitica's gold gains (1.1 says why not) |
| 4 | Its name | **Glims.** The owner: "ember doesn't sound like a currency"; a name from *Glimway* |
| 5 | What a glim is | **A bead of lit amber.** "Something like a crystal that can hold light" (owner, after *The Way of Kings*); coin-adjacent, not a coin |
| 6 | Rate and cap | **2 Habitica gold → 1 glim, at most 30 glims a UTC day** from top-ups |
| 7 | Two top-ups a day too? | **Kept**, beside the cap |
| 8 | Rename depth | **All the way:** protos, the ledger's currency, code names, copy, lore lines |
| 9 | Release | **Glims in 0.6.1**; **the Yard in 0.7**. (First answer: glims into 0.6 before it ships. The owner then chose to ship 0.6.0 with the gold purse as built and bring glims in 0.6.1.) |
| 10 | Who keeps the deeds | **A new clerk NPC: Pell**, the under-clerk from the Count House tally-book scrap, in **a small room of Silas's shop** with a literal deed table (the owner's idea) |
| 11 | Pell's talk | **Deed things only, short;** sharing, invites and giving up live in a **"Manage your deed" panel** (the owner's change) |
| 12 | Give up or sell | **Give up, no refund,** as today: the 14-day take-back stays |
| 13 | Silas's talk | **A line, "See the Yard", the axe or the fox only when they apply, "Just passing"** |
| 14 | Categories | **Build, Furnish, Materials, Mend** |
| 15 | Phone layout | **Tabs across the top** |
| 16 | Where Silas is | **On a cycle:** the counter and the yard, the panel reachable from either |
| 17 | Where Pell is | **Always at the desk** |
| 18 | The building | **His cottage; the front room is the shop**, Pell's office through a side door |
| 19 | Browsing | **Displays in the room open their tab**; the counter (Silas) opens the panel |
| — | Later, the owner's idea | Crafting and mending more of your own things at home, at higher tiers (ideas.md). The workshop bench already mends heirlooms for materials (`repairTool`, `server/internal/api/item_fittings.go:18`) |

**Tuning, not decisions** (playtest, change data): the 2:1 rate, the 30-glim cap, Silas's bundle
prices and caps, the Mend prices, Silas's cycle minutes.

---

# Part 1. Glims (0.6.1)

## 1.1 Why one currency, and why not a gold mirror

Embers already **are** a mirror of Habitica gains, only of XP rather than gold: every 10 XP earned on
Habitica is one ember (`content/economy.json` `xpPerEmber`, credited in
`server/internal/api/profile_report.go:126`), each XP pays once (the highest-credit checkpoint,
`server/internal/api/checkpoint.go`), plus a welcome and quest rewards. The owner asked
whether one currency could instead mirror **Habitica's gold gains** (gain 30 gold and both
show it; spend 10 here; gain 10 more and Habitica shows 40, Glimway 30). The trouble is that
**Habitica keeps no gold history** ([habitica-gold.md](../habitica-gold.md) §1: only `exp` and
`todos` have history), so the server sees only the balance at a sync, and that balance moves both
ways all the time:

- **Missed gains.** Earn 30 gold, buy a 30 gp custom reward, then sync: no change seen.
- **Paid twice.** Check a task, sync, uncheck it, sync, check it again, sync: paid twice. XP
  has the same shape, but a high-water mark fixes it. Gold can't have one, because spending it
  is normal.
- **A windfall from selling Habitica drops** (eggs, food) for gold.
- **Two balances both called "gold" that disagree** look like a bug and blur the boundary.

Gold only by top-up was set aside too: every purchase would spend the Habitica gold that players
set aside for their own custom rewards (their real-world treats), low-level players would be
short, and high-level players would buy past everything.

So: **one currency, two ways in.** The XP mirror is the way everyone earns, for free. A
top-up is an optional boost that turns Habitica gold into the same currency, with a cap so it
speeds a day up and never skips the game.

## 1.2 What a glim is

> A glim is a bead of amber cut to the Count House's measure, holding a glint of light. The
> Compact paid its lamplighters in them, and Hearthwick never stopped. When you get things done,
> a glim catches the light.

It's in keeping with the chronicle: amber is "graded by what it can hold alight"
(`docs/lore/chronicle.md:39`), and the Count House and the wheel-tax's punched tokens are already
the road's money. Glims **don't fade**: money that runs down would feel like a punishment.
Raw **amber** stays a material (lantern posts, sconces). A glim is amber that someone has
already cut and lit. The icon is coin-adjacent: a round, faceted amber bead with a bright core.

Copy: *"12 glims"*, *"a glim"*, never "glim coins". The sync toast: *"3 glims caught the light."*

## 1.3 The rule anyone can apply to a new item

> **Glims pay for what people sell or do for you. The land's materials pay for what's built
> from the land. Some things are only earned, never sold: keepsakes, heirlooms, recipes, and
> anything from Habitica. Glims can stand in for gathering only through a resident's small daily
> bundle.**

| New thing | Rule says |
|---|---|
| A stool Silas finished | Glims |
| The stable | Glims (Silas's labour) **and** timber, stone, fiber (the land's) |
| A piece built from the Wilds (the carved bed, the stone hearth) | Materials (and glims if a resident's labour goes in) |
| Silas clearing a tree off your land | Glims |
| Mending at Silas's counter vs at your own bench | Glims vs materials (`item_fittings.go`, already so) |
| Timber when you're short | Gather it; or Silas's capped bundle, for glims |
| A whittled fox, Brack's axe, a recipe page | Never for sale |
| Habitica gear, pets, mounts | Never in Glimway's shops; the wardrobe only shows what you own |

## 1.4 Glims' rules

1. **Ways in:** the XP mirror (10 XP → 1 glim, as embers now), the welcome, story and quest
   rewards, and **top-ups**. Nothing else makes glims.
2. **Ways out:** spending them, which the seller takes out of play. Nothing pays out to Habitica.
3. **Between players** (shelves, letters, by hand): glims move and are never made or lost (the
   purse's rule 5, 3.5 there). Embers couldn't move between players before; glims can.
4. **The XP-earned share stays.** The balance keeps today's split (`balances.xp_embers`,
   `server/internal/rules/rules.go:68`): a rest at 0 HP can be paid only from glims earned
   from XP (the boundary's health note, `docs/habitica-boundary.md:62-67`). Spending, sending
   and pricing use the other glims first, as spends do now (`server/internal/api/mutation.go:64`).
   **Glims that arrive by top-up, shelf sale, letter or hand are never XP-earned**, so nobody can
   pass a 0-HP rest to a friend.
5. **Prices carry over one for one** from embers. Today's gold prices go away (one price per
   good, 1.7).

## 1.5 The top-up becomes "Turn Habitica gold into glims"

Everything in purse-and-wardrobe.md 2.2–2.6 stands (one consent, one token, never stored; the
reserve, Habitica and settle steps; unknown outcomes), with these changes:

- **The player picks glims, and the card shows the gold.** That avoids odd amounts. The Habitica
  reward is priced in gold, `2 × glims`.
- **The day's cap.** At most **30 glims** a UTC day from top-ups, across at most **two**
  top-ups. Reserve refuses with a new code `top-up-cap` when today's glims (rows `moved`,
  `checking` or `unconfirmed`) plus this one would pass 30. Unconfirmed rows already count
  toward the day; they count toward the cap the same way.
- **"All" becomes "Max".** It fills the field with the most this top-up can be:
  `min(floor(gold / 2), glims left today)`. It still only fills the field and never sends
  (the owner kept that rule in 0.6).

```
┌ Turn Habitica gold into glims ───────────────────────┐
│                                                      │
│  You have 1,240 gold on Habitica.                    │
│  Get [     ] glims   [ Max ]                         │
│  Two gold for each glim: 20 glims costs 40 gold.     │
│                                                      │
│  Today you can still get 30 glims, in up to 2        │
│  top-ups.                                            │
│                                                      │
│  This spends Habitica gold. Your Habitica balance    │
│  goes down by that much, the same as buying a reward │
│  there. Glims can't be turned back into gold.        │
│                                                      │
│  Glimway adds a reward called "Glimway purse" to     │
│  your Habitica Rewards for a moment, buys it, and    │
│  removes it. Habitica keeps no record of this; your  │
│  purse log does.                                     │
│                                                      │
│  [ Not now ]                   [ Get 20 glims ]      │
└──────────────────────────────────────────────────────┘
```

Outcome lines keep their shape: *"20 glims caught the light. Habitica: 1,240 → 1,200 gold."*

## 1.6 What each 0.6 piece becomes

| 0.6 piece (purse-and-wardrobe.md) | With glims |
|---|---|
| The purse (gold balance, 2) | **Gone as a separate balance.** The Menu's Habitica card keeps **Turn gold into glims** and **Purse log ▸** (renamed **Glim log**: every top-up, spend, sale, letter and give) |
| HUD gold beside embers (2.1) | **One counter, glims**, on desktop and phones, where embers are now (`src/ui/Hud.svelte`) |
| Hero page Purse line | Gone; the Hero page's Embers line becomes Glims |
| Two prices at Hazel's, Finn's, the stall (3.1) | **One price each, in glims** (the ember price) |
| Silas's gold-only bundles (3.1) | **Glims, still capped 3 a day each:** timber ×4 · 3, stone ×4 · 4, fiber ×4 · 3 (the gold prices halved, rounded up) |
| Gold prices on shelf slots (3.2) | Glims, 0–9,999 |
| Gold letters (3.3) | Glim letters: a letter carries glims alone, as gold before |
| Gold by hand (3.4) | Glims by hand |
| The conservation test (3.5) | Same test, one currency, plus the XP-earned share (1.4 rule 4) |
| The wardrobe (4) | Unchanged |
| Guests (5) | Unchanged in spirit: a guest earns glims from story and gifts, no top-up |

## 1.7 Contract and data

All the way, per the owner: no "embers" left in names.

- **Protos.** Every `embers` field becomes `glims`, and `xp_per_ember` becomes `xp_per_glim`.
  `welcome_embers`, `clear_tile_embers`, `mender_embers`, quest gates' `embers` and
  `contract.Embers` (`server/internal/store/composition.go:43`) become `glims` the same way.
  `ItemGood` loses `gold`/`gold_label` and its "embers, gold, or both" rule
  (`proto/glimway/content/v1/items.proto:247-270`), and `pay` leaves the `buy` request. Gold
  fields stay only where they mean **Habitica gold**: the top-up's `amount` (gold), `gold_before`
  and `gold_after`. The top-up gains `glims` (the credit). Bump the contract version.
- **Migration 033 `glims`** (032 is applied on the owner's dev database, and
  `server/internal/store/migrations/history.json` pins its hash, so it isn't edited):
  `balances.embers`/`xp_embers` become `glims`/`xp_glims`. Any `gold` balance is turned in at
  2:1 (floored), with one `currency-merge` ledger row, and the column is dropped. Ledger
  `currency` becomes `'glims'` for every `'embers'` and `'gold'` row; gold rows' deltas are halved
  for the log only (dev data, no players). `mail.kind` `'gold'` becomes `'glims'` by the same
  rebuild 032 used (`020_gifts.sql` indexes recreated). `purse_topups` gains `glims`.
  `006_lantern_creations.sql:8` shows that older SQL names `'embers'`; check no view or trigger
  still does.
- **Content.** `content/economy.json` keys, the `silas-yard` seller's goods, every `embers` key
  in `content/homestead.json` and `content/quests.json`, the madder stall, and the vectors.
- **Errors.** `insufficient-embers` and `insufficient-gold` merge into `insufficient-glims`;
  new: `top-up-cap`. Silas's "short on warmth" line becomes *"You're a few glims short for that
  one, neighbour. The wood will wait. Wood's good at waiting."*
- **Keep:** the **Ember Charm** keepsake (an item named for lamp embers, not money) and
  "embers" as a word for real fire in lore and copy.

## 1.8 Copy and docs that change

- **Players' words:** every "ember(s)" price and balance (around 140 `src/` files mention
  embers; most are names), Mara's tutorial beat (`content/quests.json`: *"5 embers land with a
  glow on the HUD counter. She explains them in one breath"*; she now explains glims, with the
  amber line), guides, errors, the sync toast, the What's new lines in `CHANGELOG.md`
  `[Unreleased]`.
- **The promise:** README, the connect guide, the import contract and the About card say
  what a top-up does with glims (purse-and-wardrobe.md 7).
- **Docs:** the Embers and Gold rows in `docs/habitica-boundary.md`; `docs/ideas.md` ("Gold and
  embers as two currencies" is replaced); a "superseded in part" note at the top of
  purse-and-wardrobe.md; a glim line in the chronicle's Commodities.

## 1.9 Art (0.6.1)

| Piece | Canvas | Notes |
|---|---|---|
| Glim | 64×64, plus the HUD size | A round faceted amber bead with a bright core and a small glint; coin-like in size and weight, not stamped. Replaces the ember icon (`Icon name="ember"`) and the 0.6 gold coin (`docs/art-request-purse.md`), which isn't needed: Habitica gold shows only as words on the consent card |
| Glims, a few | 64×64 | Three beads together, for the log, letters and the toast |

Codex, in the 0.6 art request's style.

## 1.10 Lanes (0.6.1)

| Lane | What | Files | Size | Who |
|---|---|---|---|---|
| **G-A. Contract and migration** (first) | 1.7: protos, generated code, contract version, migration 033 with an upgrade test (balances, ledger, mail rows and indexes survive), content keys and vectors | `proto/**`, generated code, `content/**`, `server/internal/store/migrations/033_*` | M | MiMo |
| **G-B. Server** | One credit/debit path for glims with the XP-earned share (`store.Credit` and `store.CreditGold` become one, `server/internal/store/store.go:257`, `gold.go`); `marketBuy` without `pay` (`market.go`); the top-up's 2:1, even amounts and `top-up-cap`; shelves, letters, gives (`home_shelves.go`, `mail.go`, `store/mail.go`, `item_giving.go`); the conservation test with the earned share; the rename in Go names | `server/internal/{api,store,rules}/**` | M–L | MiMo; Sol reviews the top-up change |
| **G-C. Client** | Purse UI → glims (`PurseCard`, `PurseConsent` with **Max**, `PurseLog`, `PurseLine`, `PurseAmount`, `purse.svelte.ts`, `src/lib/purse.ts`), one HUD counter, sellers' single price (`sellerChoices`, `world-talk.ts:218`, `village-life.ts:101`), shelf, mail and give forms, every ember word, the tutorial beat | `src/**` | M | Opus |
| **G-D. Words and docs** | 1.8; the What's new lines | `docs/**`, `CHANGELOG.md`, `README.md` | S | Opus, with G-C |
| **G-E. Art** | 1.9 | `assets/generated/…` | S | Codex |

Order: G-A, then G-B and G-C together (G-C against the generated types), G-D with G-C, G-E any
time. The full e2e runs once at the merge, and it ships as 0.6.1.

Because 0.6.0 shipped with embers and the gold purse, migration 033 converts balances that exist:
embers become glims one for one, and purse gold at the top-up rate, two to a glim, rounded up in
the player's favour. The ledger keeps its old rows as they were. (The orchestrator's default,
2026-10-10; the owner can change it.)

---

# Part 2. Silas's Yard (0.7)

## 2.1 What moves where

| Today (Silas's talk) | In 0.7 |
|---|---|
| Raise a cottage / Build on a workshop | Yard panel, **Build** (it's there already: `src/ui/SilasShop.svelte`) |
| See what you've finished | **See the Yard** (opens the panel) |
| Three gold bundles | Yard panel, **Materials** |
| Mending (by talking near him) | Yard panel, **Mend** (needs Silas in reach) |
| The deed: buy, take back, sign an invite | **Pell's talk** |
| Share the deed, give up my place | **Pell → Manage your deed** panel |
| Hear it again (his cottage/workshop pitch) | His pitch becomes the quote over the Build tab; nothing to replay |
| Brack's felling axe, the fox | **Stay in Silas's talk**, only when they apply |
| Just passing | Stays |
| Clearing a tile (from placement) | Unchanged: the placement tool, glims |

## 2.2 Silas's talk

```
Silas
"Green wood sinks, dry wood sings. Don't hurry a roof."

  › See the Yard                  (opens the panel)
  › Take Brack's felling axe      (only when he can hand it over)
  › Give back the fox             (only while you carry it)
  › Just passing
```

- **The line** is his idle rotation (`BUILDER_NPC_DATA.idleLines`,
  `src/content/expansion-writing.ts:88`), the first meeting's lines once, and the axe's lines when
  they apply (`heirloomBeat`).
- **No deed yet:** after his line, *"Pell keeps the deeds, through the side door. I only build
  what's written on them."* The guide arrow points at Pell.
- **Out in the yard** (his cycle, 2.4), the same talk; See the Yard opens the same panel. Nothing
  waits on where he stands, except Mend (it needs him in reach).
- It's built like the residents' talk (`world-talk.ts:200-225`): one choice for the shop, then a
  single goodbye. `say(…, { yard: true })` and the bundle choices go.

## 2.3 The room: `in:commons:yard`

His cottage on the Commons (`cottage-silas`, `src/game/commons.ts:309`) gets a door and a hanging
sign. Inside, the front room is the shop. Illustrative (authored in `content/rooms.json`):

```
##############
#==w==rrr==w=#    r  the timber rack: boards, stone, fibre bundles      (opens Materials)
#ff...rrr...M#    f  the display corner: a stool, a chair, a rug set out (opens Furnish)
#ff.........M#    M  the mending bench: vice, a hung axe, oil           (opens Mend; needs Silas)
#.....CCC...>#    C  the counter, the plot book, a row of carved foxes  (Silas: opens the panel)
#.....CCC....#    >  the side door to Pell's office
#xx.........b#    x  fox shelf (dressing)   b  crates and a barrel (dressing)
#............#
#......@.....#
######DD######    out to the Commons, below his door
```

- **Displays open their tab** (owner): a spot each, like the kitchen's (`rooms.json` `spots`),
  labelled *"Look at the pieces"*, *"Look at the timber"*, *"Look at the mending bench"*.
- **When Silas is out in the yard,** the counter reads *"Silas is out by the sawhorse. A tin on
  the counter says: LEAVE IT IN THE TIN."* The panel still sells (the Commons' honesty tin). Mend
  says *"Silas mends when he's here."*
- **The display corner shows real home goods** (the stool, the reading chair, the braided rug
  already drawn), set like furnishings, so it needs no new art and changes when the stock does.
- Style: indoors.md 7.0 (four facings, scaled to the people, lived-in, collision at the base).

## 2.4 Silas's hour

A resident cycle in `content/residents.json`, like Hazel's: **counter** (`in:commons:yard`,
behind the counter) for 40 minutes, **yard** (the Commons, by the sawhorse at 48, 18) for 20, with
an offset so he's not out at the same time as Hazel. The server already knows where residents are
by the clock (`nearResident`, `server/internal/api/item_rewards.go:46`).

**Mending and the axe follow him.** Today both check a fixed mender row (Commons 51, 21:
`content/items.json` `menders`, `content.MenderFor`, `item_rewards.go:49,108`). In 0.7 Silas's
mender row names him as a resident, and the check becomes `nearResident(s, "silas", …)`,
wherever his cycle has him. Orrin's row is unchanged.

## 2.5 The Yard panel

`src/ui/YardPanel.svelte` replaces `SilasShop.svelte` (same `Panel`, id `shop`, title *Silas's
Yard*). Above the tabs: Silas's portrait and the line for the tab, then the balance (glims, and
the materials you hold). Tabs as chips, one list at a time:

| Tab | Holds | Price |
|---|---|---|
| **Build** | The next tier (cottage, then workshop) as the featured row; buildings (the stable); lantern posts (the next post's price) | Glims and materials |
| **Furnish** | Every piece not `craftOnly` (`shopSections`, `src/lib/homestead.ts:134`), with chips **All · Indoors · Outdoors** | Glims, or materials for pieces from the Wilds |
| **Materials** | Timber ×4, stone ×4, fiber ×4 from the `silas-yard` seller; each row says *"2 of 3 left today"* | Glims, capped |
| **Mend** | The tools in your pack that need mending and that he can mend; once you have a workshop, a line: *"Your own bench mends these for materials."* | Glims (`mender_glims`) |

- It opens on **Build** while an upgrade is open to you, otherwise on **Furnish**. A display
  opens its own tab.
- A row that can't be bought says why, as now (`why()`, `SilasShop.svelte:61`).
- **Phones:** four short chips (Build · Furnish · Materials · Mend) fit 360 px; the portrait shrinks
  to 40 px; rows wrap as today; the panel is the usual sheet.

## 2.6 Pell and the deed office: `in:commons:yard:deeds`

**Who:** Pell, the under-clerk from *A Scrap from the Count House Tally-Book*
(`docs/lore/texts/count-house-tally-book-scrap.md`), who kept carrying the Brack convoy's "ghost
account" forward: *"My task is only to keep the desk ready for it."* The Count House sent Pell to
keep the Commons plot ledger; Silas is glad of it (*"I read timber, not ink"*). Exact, kind, a
little fussy, always at the desk (owner). The scrap is in the game, so a player who finds it
learns where Pell came from.

```
########
#=PPP=w#    P  pigeonholes of rolled deeds; the Commons plot map pinned above
#.k....#    k  Pell's tall clerk's desk (Pell stands here)
<..TTT.#    T  the deed table with two chairs: where deeds are signed together
#..TTT.#    <  back to the shop
#......#
########
```

**Pell's talk:**

```
Pell
"Plot ledger's open. Mind the ink."

  › The deed to Gate 3 · 10 glims      (no home yet; "First deed: free" for the first)
  › Take back Gate 2 · free            (an old deed you gave up, still held for you)
  › Manage your deed                   (once you're on one)
  › Not today
```

The choices come from today's unclaimed and reclaimable logic (`talkToSilasNow`'s first branches,
`homestead-talk.ts:500-527`), moved over. Pell's first-meeting lines and voice are in lane Y-E.

**Manage your deed** (`src/ui/DeedPanel.svelte`, new):

```
┌ Your deed ─────────────────────────────── ✕ ┐
│ Tansy's Place · Gate 3                      │
│ On the deed: Tansy, Bram                    │
│                                             │
│ SHARE IT                                    │
│ At the table now:                           │
│   Ivy                      [ Offer to sign ]│
│ (Both of you sign at the table.)            │
│                                             │
│ WAITING FOR YOU                             │
│   Rowan's deed · Gate 5    [ Sign ]         │
│                                             │
│ ─────────────────────────────────────────── │
│ [ Give up your place on the deed ]          │
└─────────────────────────────────────────────┘
```

- **Share** lists whoever is at the deed table now (presence in the room), as `shareCandidates`
  does today (`homestead-talk.ts:707`). Both sign within the confirm window.
- **Waiting for you** shows invites, which you sign at the table as today.
- **Give up** opens today's confirm dialog (`src/App.svelte:1033`), with Pell striking the name:
  *"Pell strikes your name from Tansy's Place…"* No refund; the land is held 14 days for you to
  take back (`content/homestead.json` `desolation`).
- No home: the panel isn't offered.

**The table check moves.** `content/homestead.json` `commons.silasTable` becomes `deedTable`
`{ area: "in:commons:yard:deeds", x, y, radius }`. `atTable`
(`server/internal/api/home_membership.go:42`) checks that area and spot. It's still the only
deed operation that checks position.

## 2.7 Server and contract (0.7)

Small. No new operations: the panel uses `buy` (bundles), the homestead buy and upgrade, `repair`
`at: "silas"`, and the existing deed operations.

- `content/rooms.json`: `in:commons:yard`, `in:commons:yard:deeds` (parent `commons`). Rooms'
  area checks already cover rooms (indoors.md 2.2).
- `content/residents.json`: Silas's cycle; Pell with one spot (like Ada).
- `content/items.json`: Silas's mender row names the resident; the `silas-yard` seller as
  set in 0.6.
- `content/homestead.json`: `deedTable`.
- Server: `nearResident` for Silas's mending and the axe (`item_rewards.go`, `item_fittings.go`);
  `atTable` reads `deedTable`. Tests: `homes2_test.go` (sharing at the table),
  `heirlooms_test.go`, `items_test.go` mending, `repairs_test.go` (the fox back to Silas).
- Story and guides: guides' `where: 'silas'` for deed steps become `'pell'`
  (`src/content/guides.ts:56,78,105,116`); "Ask Silas to raise a cottage" stays.
  `home:met-silas` stays; meeting Pell is part of the first deed.

## 2.8 Art (0.7)

In the indoors round's style (indoors.md 7: 64 texels a tile, light from the upper left).

| Piece | Footprint | Notes |
|---|---|---|
| Silas's cottage, the shop face | as `cottage-silas` | The same cottage with a hanging sign (a fox and a saw, *Silas's Yard*) and the door drawn as usable |
| The counter | 3 × 1 | Kit counter dressed: the plot book, a pencil, a row of carved foxes, the tin |
| Timber rack | 3 × 2 | Against the back wall: cut boards, a stone stack, tied fiber |
| Mending bench | 1 × 2 | Side-on: a vice, a hung felling-axe shape, oil and rags |
| Side-wall doorway | 1 × 2 | A kit piece the kit lacks: an inner doorway in a side wall |
| Pigeonholes and plot map | 3 × 2 | Rolled deeds; the Commons lane drawn with gates |
| Clerk's desk | 1 × 1 | A tall standing desk, an inkwell, the ledger |
| Deed table | 3 × 2 | With two chairs (kit chairs) |
| Pell | resident sheet + portrait | Walk and idle, as the other residents; a clerk's sleeve-guards, ink on one finger, careful |

The display corner and the dressing reuse home goods and the kit (2.3).

## 2.9 Lanes (0.7)

| Lane | What | Files | Size | Who |
|---|---|---|---|---|
| **Y-A. Content and server** (first) | 2.7 | `content/{rooms,residents,items,homestead}.json`, vectors, `server/internal/api/{item_rewards,item_fittings,home_membership}.go`, tests | S–M | MiMo |
| **Y-B. Game** | The door into the cottage; the two rooms; Silas's cycle drawn; the new talks (2.2, 2.6); display spots opening tabs; the honesty-tin line; the guide arrows | `src/game/entities/homestead-talk.ts`, `src/game/commons.ts`, `src/game/npc-routines.ts`, `src/game/entities/goal-guide.ts`, `src/content/guides.ts` | M | Opus |
| **Y-C. UI** | `YardPanel.svelte` (replaces `SilasShop.svelte`), `DeedPanel.svelte`, phone layout, the confirm copy | `src/ui/**`, `src/App.svelte` | M | Opus |
| **Y-D. Art** | 2.8 | `assets/generated/yard-pass/` | M | Codex |
| **Y-E. Words** | Pell's voice and lines (first meeting, idle, the deed lines); Silas's lines that change (the Pell pointer, the tin, the Build quotes); maybe a Pell paper later | `src/content/expansion-writing.ts`, a new `src/content/pell.ts` | S | Opus |

Order: Y-A first; Y-B, Y-C and Y-E together; art in parallel, with placeholders not allowed (the
cleanup rule: no placeholder art), so the room merges when Y-D lands.

**Roadmap:** 0.7 is Silas's Yard. Lamps (the Keeper's hand, way-lamps, chapter 2; quests.md
rows 7–8), which other docs call 0.7, move to **0.8**; `docs/design/plan.md`'s release table
needs the row.

---

## 3. Later, on purpose

- **Making and mending more at home** (owner): more bench recipes and more tools mendable at your
  own bench, at higher tiers. The bench already mends heirlooms for materials.
- **A Commons stall** for players (ideas.md, still a maybe).
- **Rotating stock** ("this wick's piece") at the Yard.
- **Pell's paper**: a note on the deed table, a later papers round.
- **Selling a deed back**: not wanted now (answer 12); it would have to end the take-back window.
