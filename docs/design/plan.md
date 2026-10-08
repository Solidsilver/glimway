# The next stretch: one plan from six brainstorms

Status: agreed with the owner, 2026-10-07 (items 1–3 and the order decided; defaults at the end stand). It combines the six design docs in this folder
([world](world.md), [layers](layers.md), [pets](pets.md), [magic](magic.md),
[quests](quests.md), [fishing](fishing.md), and later [guests](guests.md)). It names the shared foundations, the places where the
docs disagree and how each was settled, and the order to build in.

## The shape of it

The brainstorms each started from their own idea and arrived at the same few changes underneath.

1. **The server becomes the world's authority.** It generates the open map and caves, runs shared
   enemies, owns mana and the magic that changes the world, keeps fish stock, and holds guests as
   accounts. Today the client generates the Wilds and the server checks entities and loot that
   are mirrored in both languages. After this change, the server decides and the client draws.
2. **Shared changes to the world.** A crossing someone builds (world), a heaved boulder or braced
   span (magic), a fish taken from a pond (fishing) and a naming piece found in a cave (layers)
   are all the same kind of thing: a change one player makes that everyone in the world sees,
   until it expires.
3. **Lamps are the spine.** Way-lamps push the frontier (world), the Keeper's hand quest teaches
   the naming (world, quests), the mage's craft is naming (magic), Old ways links lamps (magic,
   hands-on design), and pottery makes the lamp base (world).
4. **Class picks the way.** Obstacles have a class way and a tool way (world), and each class has
   its own craft of world workings (magic). These are one system and should be designed as one.
5. **Lazy time everywhere.** Resident cycles (layers), kiln firing (world), fish recovery
   (fishing), yard pets wandering (pets) and workings that expire at the turning (magic) are all
   worked out from the clock when someone looks, with no background jobs.
6. **The homestead grows outbuildings:** a kiln (pottery), a stable with stalls (pets), maybe a
   pond (fishing), later a cellar (layers).
7. **A Habitica-free version keeps getting closer.** Guests become accounts without Habitica,
   companions sit on a general layer, and Habitica stays read-only throughout. Every design keeps
   the boundary: nothing is granted or copied from Habitica.
8. **Nobody plays yet** (owner, 2026-10-07), so changes that would break players' habits or data
   are cheap now: riding moving behind a stable (pets), heroes without a class losing Fingersnap
   (magic), the Tangle regenerating once (world). Prefer clean breaks over compatibility code, and
   keep only the owner's own saves loading where that's cheap.

## Shared foundations

Building these once keeps every feature after them smaller.

| Foundation | Used by | Notes |
|---|---|---|
| **Guest accounts** | world, layers, fishing, magic | Designed in [guests.md](guests.md) (owner, 2026-10-07): a guest is an invite-only account with a key phrase (passkeys later); every table keys on an opaque `account_id`; one **profile source** seam (`habitica` or `none`) answers class, level, look, companions and ember earning. Guests earn embers from story and gifts only, so ember gates stop them for now. The no-server game is dropped: Glimway needs a server. Steps 1, 2 and 4 (dropping local play) land with W1 in 0.3; step 3 comes with the standalone version. |
| **The protobuf contract** | world (chunks), layers (enemy state over presence) | Stage 1 is in review now. The remaining HTTP domains follow `docs/proto-migration.md`. |
| **World changes with expiry** | world, magic, fishing, layers | Built in 0.5 with its first writer (owner, 2026-10-07). One server table of shared changes keyed by world, realm, layer, chunk, epoch and entity. Each change carries when it ends: at the next turning, when its chunk turns, or never. Reads ignore expired rows, so nothing has to clean up on a timer. |
| **One interactions path** (cleanup phase 3) | layers (doors, stairs), pets (pet a pet), magic (workings on the action button), fishing (Cast/Reel) | Every one of these adds an interactable. Do the cleanup first so each feature adds one registration instead of a fifth nearest-wins loop. |
| **A clock module** | layers, world, fishing, pets, magic | Shared Go and TypeScript helpers for cycles, elapsed-time recovery and "the next turning", with shared test vectors. |
| **Server-owned mana** | magic, shared enemies | From 0.3 there is no save upload: reports cannot raise mana above a server-computed recovery bound, and other refills are server operations ([server-first.md](server-first.md)). This is magic's step 1 and has no other dependency. |
| **The ability table** | magic, shared enemies | In `content/`, read by Go and TypeScript. The server needs it once enemies and workings run there. |

## Where the docs disagree

### 1. Do changes inside lamplight last? (decided: split by source)
- World, decision 10: a change made inside lamplight lasts for good.
- Magic: anything magic changes resets at the next turning, with no exceptions, even on your own
  land. Only amber holds longer.

**Decided (owner, 2026-10-07): split by what made the change.** Things built with materials (a plank crossing, a
mended footbridge, a way-lamp) last for good inside lamplight. Things done by magic (heave,
brace, pin, a mended glade) hold until the turning, wherever they are. The house line becomes
"magic holds until the land turns; what's built and lit holds longer". It keeps magic as
something you practise, and keeps building and lamps as the permanent way.

### 2. Who names lamps, and who makes the Old ways? (decided)
- World: anyone who has taken the Keeper's hand step sets and names way-lamps, and named lamps
  join the Old ways for fast travel. This matches `hands-on-design.md`.
- Magic: naming is the mage's craft. The mage's "Name a lamp" lights a dark lamp without oil until
  the next turning. The Old ways are a mage-only capstone at level 30, though anyone can walk
  through a pair.

**Decided (owner, 2026-10-07):**
- **The Keeper's hand is for everyone.** Naming a way-lamp is a Keeper's craft (writing down
  where the lamp stands), learned from Mara. Way-lamps are permanent and push the frontier.
- **The mage's naming is the deeper magic.** It lights dark lamps out there without oil (a rest
  spot until the turning), stands in for the hearth oil when lighting a way-lamp or lantern post,
  and at level 30 gives two lamps one naming: the Old ways, which anyone in the world can walk.

The cost is that a world without a level-30 mage has no fast travel. The way back is then the
frontier rule (never more than a few chunks from light), the turncap jar and the carter's map.

### 3. Class ways past obstacles and the class workings are two lists (decided: one catalogue)
- **The two tables don't match.**
  - World: the warrior fells a willow or holds a ford, the mage reads where the old ford was, the
    healer mends footbridges, springs and groves, and the rogue finds stepping stones and gaps.
  - Magic: the warrior heaves and braces, the mage names lamps and reads route stones, the healer
    mends tools and settles, and the rogue reads the drift and walks blind routes.
  - So the healer has no obstacle working in magic, and a broken span is the warrior's in magic
    but the healer's in world.
- **They gate by level differently.** World: obstacle size goes up at levels 15, 30 and 50. Magic:
  abilities unlock at levels 10, 15, 20 and 30.

**Decided (owner, 2026-10-07): one obstacle catalogue in `content/`.**
- Each obstacle kind names its class working and its tool way.
- A working unlocks on magic's ladder. Your level sets how big a thing it can move, using world's
  size tiers (small at any level, medium from 15, large from 30, huge from 50).
- Every obstacle always has a tool way, so heroes without a class (guests, players under level 10)
  are never shut out.
- Rewrite world's class table around the four crafts. The healer's level-10 or level-15 working
  becomes mending things in the world (a spring, a footbridge, a cracked lamp) as well as tools.
  Small gaps go to the healer; large spans stay the warrior's brace.

### 4. Quest state lives on the client (smaller)
Quests propose a `quests` record in the client-written progress document. The other designs move
toward the server, and chapter gates spend embers and wait for turnings, which the server already
owns. **Proposal:** stages that pass a gate (embers spent, a turning passed, a world change) are
server operations. Purely narrative steps can stay client-written, as discoveries are today.
**Superseded by Server-first (0.3):** every step is a server operation; gates add checks to the
same operation ([server-first.md](server-first.md)).

### 5. Smaller fixes to fold in
- `hands-on-design.md` and `items/overview.md` describe the Old ways for everyone. Update them
  once item 2 is decided.
- Removing Fingersnap from the starter kit changes the guest demo and the first fights. The quest
  tutorial ("use your weapon") should teach the basic attack.
- Quests' chapter 2 bridge sits "past the Warden". On the open map it becomes one of the authored
  structures kept at fixed coordinates in the first ring (world, "Today's Tangle").
- Shared enemies and magic's combat abilities meet. In generated places the server applies the
  ability (layers: "hits on enemies") and debits its mana. Curated story fights stay on the client.
- The quests doc is thinner than the others. It has no content format for the tree, and its
  tutorial hook covers inventory and tool use but not the guided-task system or talking. It needs
  a second pass before a brief.
- Fishing is still open: the catch feel, how home water relates to distant waters, species and
  depletion.

## What depends on what

```
proto stage 1 ──► proto domains ──────────────────────┐
cleanup: interactions, WorldScene, server splits ─────┤
                                                      ▼
  independent now:  interiors & floors (layers 1–3)   pets 1–3   quest tree + tutorial
                    fishing at the mill pond (1–2)    magic groundwork   pets 4–5 (stable)
                                                      │
guest accounts (planning, then build) ──┐             │
world changes with expiry ──────────────┤             │
                                        ▼             ▼
                     W1 server generator, same world ─► W2 per-chunk epochs
                                        │
                     W3 lake country ◄──┘──► fishing in generated waters
                        │   └─► W4 pottery (Aldo's kiln, Finn)
                        ▼
                     W5 lamps, frontier, Keeper's hand ─► magic: Name a lamp, Old ways
                        │
                     shared enemy sim (layers 6) ─► magic combat in server rooms
                        │
                     W6 obstacles with class ways (magic workings) ─► W7 next lands ─► caves
```

Since Server-first (0.3), W1 doesn't wait for world changes: that table comes in 0.5 with its
first writer.

## Proposed order, as releases

Each release is a minor version with its own art round, written as one request.

| Release | Contents | Lanes |
|---|---|---|
| **0.2 Foundations** (shipped 2026-10-08) | Versioning and proto stage 1, the "What's new" card, the cleanup lanes | Codex for the server, Opus for the client |
| **0.3 Server-first** | The server owns all state and rules; the client sends intents, predicts and draws (see "Server-first" below). Local guest play is dropped. | Codex-heavy, Opus for the client |
| **0.4 Indoors** | Rooms are places, Hazel's kitchen, Finn's mill with its loft, the library, resident cycles; the quest tree with a Quests tab, pinning and the tutorial hook, its gates as server operations | Opus (game and UI), Codex (area checks, quest operations) |
| **0.5 Crafts** | Pets steps 1–3 (fixes, friends' pets, Companions, yard pets); magic groundwork (ability table, highest-level mark, classless change); level-20 combat abilities, client-side; the stable and riding; fishing at the mill pond with one recipe | mixed |
| **Then, as revisions** | The open map (per-chunk epochs on the server generator), lake country, lamps, shared fights, caves and the next lands, in the order below | — |
| **Standalone (later)** | Glimway without Habitica, with Habitica as one mode: guest accounts steps 3–6 ([guests.md](guests.md)), embers without Habitica, our own look, classes and companions | — |

**Server-first (owner, 2026-10-07).** Before more features, move to a proper client/server
split, so nothing new is built twice (TypeScript and Go) and kept in step by parity tests. The
server already owns items, crafting, gathering, homesteads, mail, the library, worlds and Wilds
loot. 0.3 moves the rest:
1. **Progress as operations.** `PUT /api/progress` (a client-written document the server merges)
   becomes typed operations in protobuf: quest steps, discoveries, rests, vitals. This finishes
   the remaining proto domains (profile, progress, save, envelope).
2. **One set of rules.** Rule tables live in `content/` and both sides read them; the TypeScript
   copies of rules the server decides are deleted. The client keeps only what it needs to predict
   and draw.
3. **The server generates the Wilds.** The same regions and gameplay as today (the Tangle and
   the Whitequiet), served by chunk, with the terrain regenerated in Go. Nothing has to match
   the old TypeScript generator (owner, 2026-10-07); the client generator and the parity tests
   retire. (The open map's new lands and epochs come later.)
4. **Groundwork:** `account_id` and the profile-source seam (guest steps 1–2), the shared clock
   module, server-owned mana. The world-changes table moves to 0.5, with its first writer
   (owner, 2026-10-07).
5. **Local guest play is dropped** (owner: every player today has Habitica). Glimway needs a
   server and a Habitica hero until the standalone version brings guest accounts.

The design: [server-first.md](server-first.md).

Not in 0.3: a live server simulation of enemies and combat. Movement and story fights stay on
your own screen; that stays the shared-fights revision. The polish lane (sound, the player body,
phones, UI steps 8 and 9) runs alongside so the release has something to notice.

The later revisions keep their earlier order:

| Revision | Contents |
|---|---|
| The open map | Per-chunk epochs on the server generator, regeneration at the turning |
| Lake country | Fields and water, reed and clay, crossings, pottery and Aldo's kiln, fishing in generated waters, level-10 workings on real obstacles |
| Lamps | The Keeper's hand, way-lamps and the frontier, the mage's naming, the Old ways, chapter 2 (the broken span) |
| Shared fights | The server enemy sim at camps, combat abilities in server rooms |
| On from there | Caves, the next lands, capstones, home water |

**Decided (owner, 2026-10-07): interleave.** The cleanup the features lean on comes first (done
in 0.2). The polish update (sound, the player body, phone resolution, UI steps 8 and 9) runs
alongside 0.3 and 0.4 as its own lanes. The gold purse and the Habitica wardrobe follow 0.5
Crafts, before the open map.

**Habitica first (owner, 2026-10-07).** The owner and their friends play with Habitica, so that
mode comes first. The standalone game (Habitica as one mode among others) comes later. Local guest
play is dropped in 0.3 (see "Server-first"); guest accounts steps 1–2 (`account_id` and the
profile source) land in 0.3 because they're cheap now and painful to retrofit.

### Cleanup phases 2–4, adjusted
- **Already covered:** the generated error catalog (phase 2), which the proto enum replaced.
- **Do before 0.3:** the event bus and `lib/tile.ts` (phase 2), the interactions path, the
  WorldScene split and the server file splits (phase 3). Features land on top of them.
- **Skip or shrink:** client Wilds generator work (`wildsFor(session)`, area-build inputs for
  chunks). The server generator replaces it in 0.3. Area-build inputs for hand-made rooms are still
  worth doing with interiors.
- **Unchanged:** panels and CSS, App's layer value, the account flow, art-loading collapse,
  migrations, and the formatter and folders last.

## Shared fights: staying fast and fair

Server authority is the standard answer: almost every online action game keeps one source of
truth on the server and hides latency on the client. The usual toolkit, and what Glimway needs
from it at 8–10 Hz with a handful of friends on a home server:

- **Your own hero is predicted.** You move and swing at once on your screen; the server checks.
  (Glimway already works this way: movement is client-side.)
- **Enemies are interpolated.** The client draws them about 100–150 ms in the past, smoothly
  between two server snapshots, so they never jitter.
- **Hits are lag-compensated.** The server keeps about a second of enemy positions and judges
  your swing against where the enemy was on *your* screen when you swung ("favour the attacker",
  as most shooters and action games do).
- **Hurt is judged on your screen** (already decided in layers.md), so a dodge you saw always
  counts. Co-op games often trust the client this way; the trust model is friends on invites.
- **Design hides the rest:** telegraphed enemy attacks (a wind-up of 300 ms or more), generous
  hit boxes, slow cozy enemies. This matters more than the transport.
- **Transport:** the binary protobuf presence socket (WebSocket) is enough at this scale. A
  WebSocket runs over TCP, so one lost packet delays the ones behind it. If measurements on phones
  show stutter, WebTransport datagrams (HTTP/3, unreliable and unordered) are the upgrade; the
  protobuf messages carry over unchanged. Measure first.
- **Prototype one camp first** (wisps at one Tangle camp, two players, a phone on mobile data)
  before building caves on top of it.

## Ways back without a mage

The Old ways stay the mage's capstone. Everyone else gets **one-use crafted items**, so a world
without a mage always has a way home, while the Old ways stay clearly better:

| | Old ways (mage) | Crafted way-home items |
|---|---|---|
| Cost | Mana once | Materials, used up each time |
| Who | Anyone in the world, any number of times | Only the one who uses it |
| Where | Between two named lamps, both ways | One way: home, or to a lamp you named |
| Lasts | Past turnings | Once |

First sketch: a **homing turncap** (a turncap set in amber; crush it and the drift walks you back
to Hearthwick's gate) and a **lamp-ash pouch** (ash from a way-lamp you named; scatter it to step
back to that lamp). Not usable in a fight, with a short pause before you go. Crafted at the bench;
recipes are papers. Numbers and names to settle when lamps are built (the Lamps revision).

## Stepping back between releases

The owner builds mostly with agents, so the risk isn't size, it's drift. After each release:

1. **A global review round.** Fresh reviewers from both model families read the whole project
   (server, game, UI, tooling) as on 2026-10-07, looking for duplication, oversized files, dead
   code and seams the next release needs.
2. **A cleanup lane** acts on it before the next feature lanes start.
3. **Test health:** flaky specs found and fixed, e2e run time checked, coverage of the new
   systems.
4. **Docs:** design docs updated to what was built, and the plan's order revisited.
5. **A playtest by the owner** before tagging.

## Art, by release
- **0.4 Indoors:** an interior kit (floors, walls, doorways, stairs, a ladder, windows, counters); Hazel's
  kitchen, Finn's mill and loft, and the library; smoke and lit windows; quest icons.
- **0.5 Crafts:** 20 ability icons and effects (Stand, Kindle, Ward-light, Echo); the stable and stall
  bays; a rod, a float and the first fish; a cooked dish.
- **Lake country:** lake-country ground, water and props; reed and clay icons; the kiln (cold and lit);
  pottery pieces and glazes; the fen-light; heavable boulders and logs.
- **Lamps:** way-lamps, dark lamp stones, route stones, the lamp-pair mark.
- **Caves:** a cave set, mouths, a boss chamber, naming shards, cave enemies.

## Open questions with a default
These go ahead as written unless the owner says otherwise.
- **Quest gates on the server** (item 4): yes.
- ~~**A second pass on quests**~~: done (content format, gates on the server, the opening). Quests step 1 (the tree as content), with the lantern road only, goes in 0.3, because Server-first needs the transitions on the server; steps 2–5 and the gates go in 0.4; the Keeper's hand and chapter 2 come with Lamps. Chapter 2's 50 embers are pooled into the world's project.
- ~~**Guest accounts planning session**~~: done, see [guests.md](guests.md).
- **The mage bolt's name:** stays Fingersnap.
- ~~**Fishing's open questions**~~: settled with the owner (one-press Reel, Keep/Release, a 10–60 s wait by stock, shared depletion with no personal daily quota, dependable everyday fish at home, the mill-race open all year). See [fishing.md](fishing.md).
