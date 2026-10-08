# Quests: a tree of stories

Status: direction agreed with the owner 2026-10-07. Second pass 2026-10-07
(the content format, where state lives, the opening, migration, hooks into the
other designs, build order), asked for by [plan.md](plan.md). Ready to become a
build brief once the owner has read the open questions at the end.

## The pitch

Today Glimway has one quest, stored as one word in the save. This turns it into
a tree: quests written as data, each a short line of steps, joined by "this
opens after that". New quests drop in without code. The first one is the
village asking you for a hand on your first morning, and by the time Mara asks
you to walk the lantern road you've talked to people, swung your weapon, kept
a note and spent your first embers, without anyone saying "tutorial".

## Agreed in the first pass (unchanged)

- **Two journal pages.** "How do I…?" stays for mechanics (claim a plot, gather,
  build). A new **Quests** page holds the story. A quest shows up there only once
  you've come across it in the world.
- **One pin.** You pin a quest or a guide, and the HUD's goal line, its needle and
  the edge glow follow its current step.
- **The main road is paced by Habitica and the calendar.** Later chapters ask for
  embers and wait for a turning (one wick, 7 days in `content/calendar.json`).
- **The opening is the crooked signpost.** Chapter 2 is the broken span. The
  Keeper's hand is a branch beside it.

## How it works today

- `src/lib/state.ts` holds `quest: QuestStage`, one of `new`, `accepted`,
  `clue-found`, `guardian-defeated`, `lantern-lit`, `complete`. `advanceQuest`
  applies five fixed events. Objectives and HUD goals are two tables beside it.
- The stage word is read all over: dialogue `forStages` in `src/content/world.ts`,
  resident lines in `src/content/residents.ts`, quest papers in
  `src/content/papers.ts`, stage banners in `App.svelte`, the needle's `GOALS`
  table in `src/game/entities/goal-guide.ts`, and the journal's `QUEST_STEPS`.
- The server stores it in the progress document. `rules.Merge` keeps whichever
  stage is further on, `rules.QuestItems` is a hard-coded allowlist of the four
  quest items a client may write, `gifts()` in `api.go` pays the two quest ember
  gifts once each, and `storyBeats()` in `witness.go` turns two stages into
  witness moments.
- Guides (`src/lib/guides.ts`, `src/content/guides.ts`) are checklists that tick
  themselves from what you have, with steps remembered as `guide:<id>:<n>` flags.
  The pin is one per device in localStorage (`src/game/guide-pin.ts`).

All of that keeps working; it reads from the tree instead of from one word.

## 1. The quest tree as content

### The file

`content/quests.json`, embedded by Go (`content/embed.go`, like `projects.json`)
and imported by TypeScript, holds the shape of every quest: ids, order,
prerequisites, triggers, gates, grants, the short goal and objective text, and
journal notes. Spoken lines stay in TypeScript (see "Where the words live"),
because the server never needs them and dialogue already has logic in it (spend
choices, notes, "Hear it again").

**Each quest is a straight line of steps.** Branching happens between quests:
a quest opens after other quests or steps. That keeps the save simple (one step
id per quest), keeps the merge rule what it is today (the further step wins), and
still makes a tree.

### A quest

| Field | Meaning |
|---|---|
| `id` | kebab-case, unique, never reused |
| `title`, `blurb` | The Quests page: name and one line under it |
| `line` | Which shelf: `road` (the main story), `village` (people and places), `craft` (learning a trade) |
| `chapter` | Optional number, for the road's ordering (0 is the opening) |
| `after` | Optional list of refs that must be reached first: `"lantern-road"` (that quest done) or `"signpost:see-mara"` (that step reached) |
| `start` | How you come across it. Absent means "as soon as `after` holds". Otherwise a trigger (below), such as talking to Finn |
| `needs` | Optional: `"habitica"` (connected heroes only) or `"world"` (needs a server world). Shown locked to everyone else, never hidden, so guests know it exists |
| `steps` | The line, in order |

### A step

| Field | Meaning |
|---|---|
| `id` | Named for what you do (`fetch-finger`), unique within the quest |
| `goal` | The HUD line, 40 characters at most (today's `SHORT_GOALS` rule) |
| `objective` | The journal's full sentence |
| `where` | What the needle points at: `{ "area", "npc" }`, `{ "area", "spot" }` (an interactable id), `{ "area", "enemy" }`, or `{ "ui": "journal" }` (the book button glows instead) |
| `do` | The trigger the client watches for (below) |
| `gate` | Optional. What the server must check before the step counts (below). A step with a gate is a **server step** |
| `grants` | Optional. What passing it gives (below) |
| `note` | Optional journal page written when the step is done: `{ "title", "body" }` |
| `moment` | Optional banner when the step is done: `{ "eyebrow", "title" }` (today's table in `App.svelte`) |
| `witness` | Optional witness beat name (today's `"warden"` and `"lantern"` in `witness.go`) |

### Triggers (`do` and `start`)

Each is one small object. The client's quest logic asks "is this met now?",
the way guide steps do.

| Trigger | Met when |
|---|---|
| `{ "talk": "orrin" }` | That person's dialogue for this step finishes (today's `event` on a dialogue rule) |
| `{ "use": "route-stone" }` | That interactable's dialogue for this step finishes |
| `{ "defeat": "finger-wisp" }` | That curated enemy is defeated |
| `{ "carry": "east-finger" }` | The item is in your pack |
| `{ "reach": "woodland" }` | You stand in that area (optionally `"spot"`) |
| `{ "flag": "lit:road-1" }` | That save flag is set, whoever set it (the client or a server operation) |
| `{ "open": "journal" }` | You open that panel |
| `{ "sync": "embers" }` | A Habitica sync pays at least one ember from XP while this step is current |
| `{ "new": true }` | `start` only: every new save begins with this quest |

### Gates (server steps only)

All keys in a gate must hold. The server checks them in one transaction (see
section 2).

| Gate | Holds when | Spends? |
|---|---|---|
| `"embers": 50` | Your balance covers it | Yes, debited with reason `quest`, ref `<quest>:<step>` |
| `"wait": { "turnings": 1 }` | That many turnings have passed `since` the previous gate on this quest (default) or `since` a project's completion (`"since": "project:dorrits-span"`) | No |
| `"wait": { "hours": 3 }` | That many real hours since, same `since` rule (for the kiln's slow firing) | No |
| `"world": "project:aldo-kiln:complete"` | That world flag is set, or (from 0.5) that shared world change exists and hasn't expired | No |
| `"project": "dorrits-span"` | You have given anything to that village project, or it's already complete | No |
| `"item": { "def": "iron-oak", "qty": 4, "keep": false }` | You carry those server items; `keep: false` takes them | Optional |
| `"at": "orrin"` | Your saved area is where that person is right now (their fixed spot, or their resident cycle once they live indoors) | No |

A `wait` must come after an earlier gate or name a `since`, so the server always
has a moment to count from. The loader rejects a quest that breaks this.

### Grants

| Grant | Who pays it |
|---|---|
| `"embers": 5` | On a plain step, the server pays it once on the merge that first passes the step (today's `gifts()`), at most 5 per step. On a server step, inside the operation |
| `"items": ["east-finger"]` | Quest keepsakes: plain strings in the save's inventory, client-written. The server's allowlist becomes "every item a quest grants or carries" instead of the hard-coded four |
| `"give": [{ "def": "lamp-head", "qty": 1 }]` | Server items (rows in the items table). Server steps only |
| `"unlock": "keeper:hand"` | A capability the server enforces (setting way-lamps, building the kiln). Server-owned flags, like today's `lit:` and `opened:`, which uploads can't write. Server steps only |
| `"papers": ["dorrits-second-span"]` | Papers, which keep working as today's quest-sourced papers do, keyed by `{ quest, step }` |

### Checks the loader runs (shared test vectors in `content/vectors/`)

Ids unique and kebab-case; every `after` and `since` ref exists; no cycles;
goals at most 40 characters; `give` and `unlock` only on server steps; ember
grants on plain steps at most 5; every `where` names a known area, NPC, spot or
enemy; every carried or granted item exists in `content/items.json` or is a
known keepsake. Go and TypeScript both load the file and both run the vectors,
as `wilds.json` does today.

### The opening, written out in full

```json
{
  "id": "signpost",
  "title": "Three Fingers off Plumb",
  "line": "road",
  "chapter": 0,
  "blurb": "The frost stood Orrin's signpost up straight, and he won't have it.",
  "start": { "new": true },
  "steps": [
    {
      "id": "meet-orrin",
      "goal": "See what Orrin's grumbling about",
      "objective": "Someone up a ladder by the signpost in the square is arguing with it. Go and see.",
      "where": { "area": "village", "npc": "orrin" },
      "do": { "talk": "orrin" }
    },
    {
      "id": "fetch-finger",
      "goal": "Find the signpost's east finger",
      "objective": "The frost threw the signpost's east finger out past the east gate, into the bracken. A wisp has settled on it. Shoo it off and bring the finger back to Orrin.",
      "where": { "area": "woodland", "enemy": "finger-wisp" },
      "do": { "defeat": "finger-wisp" },
      "grants": { "items": ["east-finger"] },
      "note": {
        "title": "A Wisp on the Finger",
        "body": "A wisp had settled on Orrin's signpost finger and was glowing at the paint. One good swing and it hopped off into the bracken to sulk. The finger says ASHWATCH in fresh paint. Under it, older and nearly gone: SALLOW FD."
      }
    },
    {
      "id": "bring-finger",
      "goal": "Take the finger back to Orrin",
      "objective": "Bring the east finger back to Orrin at the signpost.",
      "where": { "area": "village", "npc": "orrin" },
      "do": { "talk": "orrin" }
    },
    {
      "id": "note-lean",
      "goal": "Write the lean in your journal",
      "objective": "Orrin won't set the post until the lean is written down: three fingers off plumb, leaning east. Open your journal and note it.",
      "where": { "ui": "journal" },
      "do": { "open": "journal" },
      "note": {
        "title": "Three Fingers off Plumb",
        "body": "Orrin's signpost: three fingers off plumb, leaning east. He made me write it down. He says it's the frost. I don't think it's the frost."
      }
    },
    {
      "id": "set-post",
      "goal": "Read the lean back to Orrin",
      "objective": "Read the lean back to Orrin so he can set the post.",
      "where": { "area": "village", "npc": "orrin" },
      "do": { "talk": "orrin" }
    },
    {
      "id": "see-mara",
      "goal": "Find Mara and her ledger",
      "objective": "Pip says Mara has the ledger open in the square and the soup on. Go and see her.",
      "where": { "area": "village", "npc": "mara" },
      "do": { "talk": "mara" },
      "grants": { "embers": 5 },
      "note": {
        "title": "In the Ledger",
        "body": "Mara wrote the signpost into her grandmother's ledger: 'East finger recovered, lean set. Traveller's hand.' Work done and written down is warmth you carry, she says. Here they call it embers."
      }
    },
    {
      "id": "light-first-lamp",
      "goal": "Light the first lamp past the gate",
      "objective": "The road lantern just past the east gate has been dark for thirty years. Light it with your embers.",
      "where": { "area": "woodland", "spot": "road-1" },
      "do": { "flag": "lit:road-1" },
      "moment": { "eyebrow": "One link held", "title": "The First Lamp" },
      "note": {
        "title": "The First Lamp",
        "body": "Lit the road lantern past the east gate. Back in the square, Mara stood up from the ledger to look."
      }
    }
  ]
}
```

The lantern road follows on (`"after": ["signpost"]`, `"start": { "talk": "mara" }`):
its first step is today's "Would you go?" talk, lightly reworded because you've met.

### Where the words live

- Dialogue rules in `src/content/world.ts` swap `forStages: QuestStage[]` for
  `when: string[]` of `"quest:step"` refs, such as `when: ['signpost:meet-orrin']`.
  A rule's `event` becomes "this finishes the step's `talk` trigger".
- Resident lines in `src/content/residents.ts` keep one line per main-road step,
  keyed the same way. A resident talks about your furthest point on the road.
- New quests get their own small file, `src/content/quests/<id>.ts`, holding
  their dialogue rules, so `world.ts` stops growing. The signpost's lines are in
  section 3.

## 2. Where state lives

### The save

```ts
quests: Record<string, string>  // quest id → current step id, or 'done'
```

A quest that isn't in the record hasn't been come across yet. The pin stays
where guides keep it today, one per device in localStorage, but the slot now
holds `quest:<id>` or `guide:<id>`. With nothing pinned the goal line follows
the road's current quest, as it follows the story today.

### Which steps are client-written, which are server operations

| Kind | Examples | Who advances it |
|---|---|---|
| Talk, use, reach, defeat a curated enemy, carry a keepsake, open the journal | Most steps; the whole opening and chapter 1 | The client, in the progress document, merged on upload as `quest` is today |
| A step whose trigger is a server flag | `lit:road-1` (lighting is already a server spend), a way-lamp you lit | The client, once the server's operation has set the flag |
| Any step with a `gate`, `give` or `unlock` | Paying the masons, the span laid at the turning, being made a Keeper's hand, the kiln's first firing | Only the server, through the quest operation below |

Plain steps stay client-written for the same reason discoveries are: a cheat
gains a story beat and at most 5 embers per step, which today's `gifts()`
already accepts. Anything that spends, waits on the clock, depends on the
shared world or hands over server-owned things goes through the server.

### The merge rule

`rules.Merge` moves from one stage word to the record:

1. For each quest in the upload, keep whichever step is further along (the
   index in the content), never going back. Unknown quest or step ids fail the
   upload, as an unknown stage does today.
2. **Clamp at server steps.** An upload can't move a quest past a server step
   unless the server has a gate row for it. So a client can reach the step
   where Orrin asks for embers, but only the operation moves past it.
3. A quest whose `after` doesn't hold in the merged state is dropped from the
   upload.
4. Ember grants on plain steps pay once per `quest-gift:<quest>:<step>` outcome,
   like today's two gifts. Witness beats come from steps with `witness`, first
   passed in this merge, where the step's area matches (today's `beatRoom`).

### The quest operation

One mutation, `quest-step { quest, step }`, keyed and idempotent like every
other spend (`keyedMutation`). It lands in the proto domains when the remaining
HTTP domains move (`docs/proto-migration.md`). In one transaction the server:

1. Finds the step and checks that it is a server step and that your record
   says you're on it (every plain step before it is done).
2. Checks `at` against your saved area and the person's place (a resident's
   cycle is worked out from the clock). Like the sellers' nearness checks
   today this is a plausibility check, since position is client-written; the
   other gates carry the weight.
3. Checks `world` and `project` against the world's project flags (and later
   the shared world changes table).
4. Checks `wait`: finds the `since` time (the previous gate row on this quest,
   or the project's `completedAt`) and compares with `content.CalendarAt(calendar, now)`.
   A turning has passed when the current wick started after that time. If not
   yet, it fails with `not-yet` and the time it opens, so the dialogue can say
   "after the turning, Dark of Leaf-wick".
5. Takes items (`keep: false`) through the items code, as mending does.
6. Debits embers with `debitEmbers(…, "quest", "<quest>:<step>", now)`.
7. Writes a row in a new table, `quest_gates(habitica_id, quest,
   step, passed_at)` (keyed like the progress row, so guest accounts fit
   once they have ids), moves the record to the next step, and pays the grants
   (embers through `store.Credit`, `give` as item rows, `unlock` as a
   server-owned flag).
8. Returns the snapshot. The client tells the payoff after the server says
   yes, the way online spends already do. Offline, the choice is shown
   disabled with "Needs a connection".

### Guests

Guests today play locally with no server. Until guest accounts land (0.5) they
run the same TypeScript rules on their own save, exactly as their ember spends
work now. The opening and chapter 1 have no server steps, so nothing changes
for them. Every quest with a server step ships at 0.6 or later, after guests
become accounts, and then guests go through the server like everyone else. One
thing guest accounts still need: a way to earn embers without Habitica (see
open questions), since chapter 2 asks for them.

## 3. The opening: Three Fingers off Plumb

You come up the Low Road on your first morning. The goal line says "See what
Orrin's grumbling about" and the needle points at a man up a ladder by the
signpost. Nobody explains a control. Each beat needs one thing from you, and
the action button's label already says what that is (`content/controls.ts`).

| Step | What happens | What it teaches |
|---|---|---|
| Meet Orrin | Frost came up under the signpost in the night and stood it plumb. The east finger blew off past the gate. His back won't let him go after it. Two choices, both lead on | Walking to someone, talking, picking a choice |
| Fetch the finger | Just past the east gate, in sight of the road, a wisp sits on the finger glowing at the paint. One wisp, low health, telegraphed hops | Leaving through a gate, the basic attack (Slash from what's in hand), the dodge if it hops at you, picking up |
| Bring it back | Orrin turns it over, sees the old SALLOW FD under the paint, says "Old paint. Leave it." Then: write the lean down first | A second talk; the first hint of the road east |
| Note the lean | The book button glows. Opening the journal shows the note already written in pencil, on the Quests page, with this quest at the top | Where the Journal is, that it keeps your notes and goals |
| Set the post | "Read it back." "Three fingers off plumb, east." Two knocks. Crooked as the day it was set. Pip runs up with a message from Mara | Reading back what you noted; a third person |
| See Mara | Mara writes the job into Wenna's ledger. 5 embers land with a glow on the HUD counter. She explains them in one breath and sends you to the dark lamp | Embers: what they are, where they come from, that they're spent in the world |
| Light the first lamp | The road lantern by where you fought the wisp, 3 embers. It lights; the square turns to look | Spending embers; "never two dark in a row" |

Then Mara asks you to walk the rest of the road, and chapter 1 begins. It takes
five to ten minutes, a short session between real tasks.

**Why Orrin first.** The canon has him resetting the signpost to Dorrit's lean
every spring and saying "frost" when asked. The opening shows the habit and
keeps the secret: he never says her name here. The player's note ("I don't
think it's the frost") is the only nudge. Mara's line about the ladder in her
existing `new` talk already fits.

**The basic attack.** Magic takes Fingersnap from classless heroes, so the first
fight has to work with Slash alone. The finger-wisp is a new curated enemy
(an `EnemySpot` with id `finger-wisp`, placed near Brackenwood's west entry,
apart from `wisp-a`), with the wisp's hops at a lower health. It also suits
heroes who still have Fingersnap, if the tutorial lands before magic's
groundwork does.

**Five embers, not three.** Two pay for a rest at the well if the wisp knocked
you about, and three light the lamp, so Mara names both places. The old quest
paid 2 at the Warden and 3 at the end; those stay. If a guest somehow reaches
the lamp with fewer than 3, Mara tops them back up to 3 once (a flag), so the
opening can't strand anyone.

### The lines

Orrin, `meet-orrin`:
> Mind the ladder. No. Mind the post. Look at it.
> Frost came up under it in the night and stood it straight. Plumb. Like a Hall clerk.
> It's meant to lean. Three fingers off, east. Don't ask why. Frost.
> And the east finger's gone. Wind took it past the east gate, into the bracken. My back says I'm not going after it.
> - *I'll fetch it.* "East gate, left of the path. If there's a wisp sat on it, and there will be, give it a smack. They don't mind. They go off and sulk."
> - *Why does it lean?* "Frost." He looks at you until you go.

Orrin, `bring-finger`:
> That's it. Paint held, mostly.
> *(He rubs a thumb over the old letters under ASHWATCH.)* Old paint. Leave it.
> Right. Before I set it, you write it down. Three fingers off plumb, east. I'm sixty-odd and the ground's worse at remembering than I am.

Orrin, `set-post`:
> Read it back.
> - *Three fingers off plumb, east.* "Good. Hold it there." Two knocks with the mallet. "There. Crooked as the day it was set." He doesn't say who set it.

Pip runs up as Orrin finishes (a walk-on, like the gate nudge):
> Mara says if you're done holding Orrin's ladder, the ledger's open and the soup's on. That's the whole message. I ran it twice to get it right.

Mara, `see-mara`:
> You're the one off the Low Road. And Orrin's had you on the signpost, so you've done a job for the village. That goes in the ledger.
> *"East finger recovered, lean set. Traveller's hand."* There.
> Gran's rule. Work done and written down is warmth you carry. Here we call it embers.

Then, for a connected hero:
> It doesn't have to be done here, either. Whatever you get done in your own day counts. Bring it back and I'll write it in.

For a guest:
> Where you come from, folk carry their own day's work in with them. Pip can tell you how, at the gate.

And to everyone:
> Two embers buys a rest by the well if that wisp knocked you about. Three lights a lamp. The first one past the east gate has been dark thirty years. Never two dark in a row, Gran said. Go on. I want to see it from here.

### Your own day: the guided-task loop

Mara's line opens a small side quest for connected heroes. It never blocks the
road, because you can't finish a real task on demand.

```json
{
  "id": "your-own-day",
  "title": "Your Own Day",
  "line": "village",
  "needs": "habitica",
  "blurb": "Mara will write in what you get done in your own day.",
  "start": { "talk": "mara" },
  "after": ["signpost:see-mara"],
  "steps": [
    {
      "id": "do-something",
      "goal": "Bring Mara something from your day",
      "objective": "Tick off a task, a daily or a habit in Habitica. Every 10 XP you earn there becomes an ember. Then sync from the Menu in Hearthwick or the Commons.",
      "do": { "sync": "embers" }
    },
    {
      "id": "show-mara",
      "goal": "Show Mara what you did",
      "objective": "Tell Mara what you got done, and she'll write it in.",
      "where": { "area": "village", "npc": "mara" },
      "do": { "talk": "mara" },
      "grants": { "items": ["tally-token"] },
      "note": {
        "title": "A Punched Token",
        "body": "Mara didn't ask what I did, only whether it was done. She punched an old wheel-tax token and gave it to me. 'Receipted,' she said. 'The Count House would've wanted it.'"
      }
    }
  ]
}
```

- The objective names Habitica plainly. Guides keep the "no real-life apps"
  rule, but this quest exists to teach the loop, and the ember hint in
  `world.ts` already speaks this way.
- The tally token is a Glimway keepsake (a punched wheel-tax receipt from the
  Carters' Compact), not a Habitica thing.
- Guests see this quest on the Quests page, locked, with "Connect Habitica in
  the Menu to take this one". Pip's gate nudge (`src/lib/nudges.ts`) already
  points them there, and Mara's guest line leads to it.

### What the opening changes in code

- `content/quests.json` gains `signpost` and `your-own-day`; `createNewGame`
  starts with `quests: { signpost: 'meet-orrin' }`.
- A curated `finger-wisp` in `src/game/worlds.ts`'s Brackenwood spots, and the
  `east-finger` and `tally-token` keepsakes.
- The journal opens on the Quests page while `note-lean` is current, and its
  open sets the trigger. The HUD's book button gets the same glow the edge
  glint uses.
- Pip's walk-on reuses the gate nudge's code path.
- Art: the signpost standing plumb with a gap where the east finger goes (the
  leaning version exists), the finger lying in the bracken, the two keepsake
  icons.

## 4. Migration

Nobody plays yet, so keep it small and clean.

- `quest: QuestStage` becomes `quests: Record<string, string>`. The save
  version goes to 2. Version 1 saves load through one small function on each
  side (`validateSave` in TypeScript, the progress decoder in Go), so the
  owner's saves keep working with no database migration:

| v1 `quest` | v2 `quests` |
|---|---|
| `new` | `{ signpost: 'meet-orrin' }` (a fresh start) |
| `accepted` | `{ signpost: 'done', 'lantern-road': 'copy-stone' }` |
| `clue-found` | `{ signpost: 'done', 'lantern-road': 'settle-warden' }` |
| `guardian-defeated` | `{ signpost: 'done', 'lantern-road': 'light-shrine' }` |
| `lantern-lit` | `{ signpost: 'done', 'lantern-road': 'tell-mara' }` |
| `complete` | `{ signpost: 'done', 'lantern-road': 'done' }` |

- The lantern road's steps are renamed for what you do (`hear-mara`,
  `copy-stone`, `settle-warden`, `light-shrine`, `tell-mara`). It's one
  find-and-replace across `world.ts`, `residents.ts`, `papers.ts` and the tests.
- Uploads must be version 2; an old tab is told to reload.
- Removed: `QuestStage`, `QuestEvent`, `QUEST_STAGES`, `TRANSITIONS`,
  `OBJECTIVES`, `SHORT_GOALS`, `QUEST_STEPS`, `JOURNAL_BY_STAGE` (now step
  notes), the `GOALS` table in `goal-guide.ts` (now `where`), the stage banner
  table in `App.svelte` (now `moment`), `questEmbers` in `economy.json` (now step
  grants), `rules.Stages`, `rules.QuestItems` (derived from the content), and
  the two hard-coded beats in `storyBeats` (now `witness`).
- `advanceQuest(state, event)` becomes `advanceStep(state, quest, step)` in a new
  `src/lib/quests.ts`, pure like `guides.ts`. `session.ts` keeps its role of
  calling it and telling the UI.
- The old gift outcomes (`quest-gift:defeat-guardian`) don't carry over, so the
  owner may get those 5 embers again. Not worth code.

## 5. How the tree hooks the other designs

### The Keeper's hand (world.md)

A road quest beside chapter 2. It's for everyone, any class or none, and it is
what lets you set way-lamps.

```json
{
  "id": "keepers-hand",
  "title": "A Keeper's Hand",
  "line": "road",
  "after": ["lantern-road"],
  "needs": "world",
  "start": { "talk": "mara" },
  "steps": [
    { "id": "hear-mara", "goal": "Hear Mara out about the ledger",
      "where": { "area": "village", "npc": "mara" }, "do": { "talk": "mara" } },
    { "id": "copy-cut", "goal": "Copy the cut at the Whitequiet's edge",
      "where": { "area": "wilds", "spot": "far-route-stone" },
      "do": { "use": "far-route-stone" }, "grants": { "items": ["far-naming-copy"] } },
    { "id": "check-ledger", "goal": "Check the cut against the ledger",
      "where": { "area": "village", "npc": "mara" }, "do": { "talk": "mara" },
      "gate": { "at": "mara" },
      "grants": { "give": [{ "def": "lamp-head", "qty": 1 }], "unlock": "keeper:hand",
                  "papers": ["the-form-of-a-naming"] } },
    { "id": "relight-stone", "goal": "Relight the stone at the edge",
      "where": { "area": "wilds", "spot": "far-route-stone" },
      "do": { "flag": "lamp:far-route-stone" }, "witness": "keeper" }
  ]
}
```

- `check-ledger` is a server step only because it hands over a server item and
  a capability. The way-lamp operation (world.md) refuses anyone without
  `keeper:hand`.
- `relight-stone` watches a flag the way-lamp operation sets, so lighting stays
  one operation in one place.
- `far-route-stone` is one of the authored structures at fixed coordinates in
  ring one, beside the Tangle crossing. `the-form-of-a-naming` is a new paper
  to write.

### Relighting Aldo's kiln (world.md, pottery)

A craft quest for Finn, shipping with lake country (0.6). It's the first quest
with server gates, so it proves the operation on something small.

| Step | Do | Gate | Grants |
|---|---|---|---|
| `finn-kiln` | Talk to Finn, who mentions the cold kiln behind the mill | | |
| `look-kiln` | Use the cold kiln: Aldo's mark on the door, his firing tally scratched in the brick | | |
| `relight` | Talk to Finn once the village has finished the "Relight Aldo's kiln" project | `world: project:aldo-kiln:complete`, `at: finn` | |
| `first-firing` | Talk to Finn after the first load has fired | `wait: { hours: 3 }` | `papers` (Finn's first pottery recipe pages), `unlock: craft:kiln` |

- The kiln project goes in `content/projects.json` (river clay, stone, timber).
- `wait: hours` counts from the previous gate (`relight`), and the kiln's own
  firing uses the same lazy-time helper from the plan's clock module.
- `craft:kiln` lets Silas sell the homestead kiln build.
- Canon care: the linseed box and its note stay late (after the eastern lamps,
  per `papers.ts`). The kiln quest only shows Finn missing his father.

### Chapter 2: Dorrit's span (fixed coordinates on the open map)

Lands with lamps (0.7). The crossing where the bridge tore is an authored
structure at fixed coordinates in ring one (world.md, "Today's Tangle"). The
span itself is a shared world change with no expiry: built with materials, so
it lasts for good.

| Step | Do | Gate | Notes |
|---|---|---|---|
| `hear-orrin` | Talk to Orrin | | He won't rebuild it unless it's right. He doesn't say "for her" |
| `find-plank` | Use the half-buried plank at the crossing | | Grants the paper *Dorrit's Second Span* (exists in `docs/lore/texts/`) |
| `show-orrin` | Talk to Orrin with the paper | | He reads her note about trunnels and the breathing bank. "She was right." He'll build it her way: pegged joints that flex, and warden-stone so it walks back to its place after a stir (chronicle, Part VII) |
| `raise-span` | Talk to Orrin | `project: dorrits-span` | You've put your hand to the village project, or it's already done |
| `slack-calm` | Reach the crossing | `world: project:dorrits-span:complete`, `wait: { turnings: 1, since: "project:dorrits-span" }` | The span is laid in the slack calm after the next turning. The world change starts at that turning, so everyone sees it at once |
| `cross` | Reach the far bank | | `witness: "span"`. Past it, an Echo camp |

- **The project** in `content/projects.json`: iron-oak, wooden pegs for
  trunnels, warden slivers, stone, and **50 embers**. Projects take materials
  today; taking embers is a small addition (a contribution that debits through
  `debitEmbers`).
- **This changes the first pass.** The draft had Orrin take 50 embers from each
  player. On the open map the span is one bridge that everyone shares, so I've
  made the 50 embers part of the world's project, alongside the materials.
  Each player's story still needs their own hand in it (any contribution) and
  the turning. A party shares the cost, the way it shares lamps. See open
  questions.
- **The obstacle catalogue.** Dorrit's span is a story structure, not a large
  span from the catalogue, so Brace doesn't open it. Elsewhere, large spans keep
  their warrior and tool ways.
- **The Echo past the span.** The first pass said crossing reveals an Echo of
  the lost expedition. I suggest a camp with four bedrolls, not six: the first
  sign that some of them went on. It's allowed by the reveal order (after the
  road is lit), but it moves the "they survived" thread forward, so it's the
  owner's call.

### Interiors and residents indoors (layers.md)

- **`where` can name a person, not a place.** When Finn is in the mill, the
  needle points at the mill door; when he's out, at his outdoor spot. The goal
  guide asks the resident cycle (content, shared clock) where he is now.
- **The goal guide's map learns rooms.** Its `ROAD` graph gains each interior
  as a child of its parent area, so "the mill loft" is two steps from the
  village.
- **`talk` works wherever the person is.** A step never waits on someone
  being home: if you knock and they're out, the knock line says where they are
  ("Wheel's turning, I'm round the back"), and with a 40/20 minute cycle
  they're never far.
- **`at` gates use the same cycle,** so the server can check "Finn is in the
  mill now and so are you" without anything ticking.
- **Rooms make good quest places.** Aldo's firing tally can sit in the mill's
  sack loft; the library's reading room is where a papers quest ends; Hazel's
  kitchen is where village quests start over a cup.
- **Rumours** (the first pass's open question): residents get one more choice,
  "Heard anything?", that names the next step of an unpinned quest you've come
  across, in their own voice. It's cheap once lines are keyed by `quest:step`.

## 6. Build order

Each step ships on its own and leaves the game playable.

| # | Step | Size | Release |
|---|---|---|---|
| 1 | **The tree, no new story.** `content/quests.json` with the lantern road only; loaders in Go and TypeScript; `src/lib/quests.ts`; save v2 and the v1 loader; merge per quest; allowlist, gifts and witness beats read from content; dialogue `when` refs; shared vectors. The game plays exactly as today | M | 0.3 |
| 2 | **The Quests page and one pin.** The journal's "Lantern Road" tab becomes Quests (shelves, steps, notes, a Pin button); the pin slot holds quests or guides; the goal guide reads `where`; banners from `moment` | M | 0.3 |
| 3 | **The opening.** The signpost quest, the finger-wisp, keepsakes, the journal trigger, Pip's walk-on, Orrin's and Mara's lines, the new-save start; chapter 1's first talk reworded | M | 0.3 |
| 4 | **Your own day.** The `sync` trigger, the locked view for guests, the tally token | S | 0.3 |
| 5 | **Rumours.** "Heard anything?" for residents, alongside interiors | S | 0.3 |
| 6 | **The quest operation.** `quest_gates`, the mutation, gates `at`, `world`, `wait`, `embers`, `item`; grants `give` and `unlock`; "Needs a connection" and `not-yet` in dialogue. Ship it with Aldo's kiln, its first user | M | 0.6 |
| 7 | **The Keeper's hand.** With way-lamps | S | 0.7 |
| 8 | **Chapter 2.** Projects that take embers; the `project` gate and `wait since`; the crossing and span as authored structures; the span as a world change; the Echo past it | L | 0.7 |

Steps 1 to 5 need the interactions cleanup the plan puts before 0.3, and
nothing else. They don't wait for guest accounts or the open map.

## Art

- **0.3:** quest shelf icons (road, village, craft) and a pin mark for the
  Quests page; the signpost standing plumb with the east finger missing; the
  finger in the bracken; icons for the east finger and the tally token.
- **0.6:** Aldo's mark on the kiln door (the kiln itself is in world.md's list).
- **0.7:** the crossing with Dorrit's plank half-buried; the span broken and
  mended (pegged joints, warden-stone footings); the four-bedroll Echo camp.

## Open questions

1. **Chapter 2's 50 embers: pooled or per player?** I've proposed pooled, in
   the world's project, because the span is shared. Per player is closer to the
   first pass but makes the fifth person in a party pay for a bridge that
   already stands.
2. **The four-bedroll Echo.** Is chapter 2 the right place for the first sign
   that the Six didn't all die, or should it wait for chapter 3?
3. **Embers for guest accounts.** Guests can't earn embers from Habitica, and
   chapter 2 asks for them. The guest-accounts planning session should settle
   where a guest's embers come from (story beats only, small village chores,
   or something else).
4. **Sallow Ford** (from the first pass): reaching it or seeing the lamp from
   afar. Still open; chapter 3 decides it.
