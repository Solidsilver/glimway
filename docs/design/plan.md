# The next stretch: one plan from six brainstorms

Status: agreed with the owner, 2026-10-07 (items 1–3 and the order decided; defaults at the end stand). It combines the six design docs in this folder
([world](world.md), [layers](layers.md), [pets](pets.md), [magic](magic.md),
[quests](quests.md), [fishing](fishing.md)). It names the shared foundations, the places where the
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
| **Guest accounts** | world, layers, fishing, magic | Designed in [guests.md](guests.md) (owner, 2026-10-07): a guest is an invite-only account with a key phrase (passkeys later); every table keys on an opaque `account_id`; one **profile source** seam (`habitica` or `none`) answers class, level, look, companions and ember earning. Guests earn embers from story and gifts only, so ember gates stop them for now. The no-server game is dropped: Glimway needs a server. Steps 1–4 must land before W1. |
| **The protobuf contract** | world (chunks), layers (enemy state over presence) | Stage 1 is in review now. The remaining HTTP domains follow `docs/proto-migration.md`. |
| **World changes with expiry** | world, magic, fishing, layers | One server table of shared changes keyed by world, realm, layer, chunk, epoch and entity. Each change carries when it ends: at the next turning, when its chunk turns, or never. Reads ignore expired rows, so nothing has to clean up on a timer. |
| **One interactions path** (cleanup phase 3) | layers (doors, stairs), pets (pet a pet), magic (workings on the action button), fishing (Cast/Reel) | Every one of these adds an interactable. Do the cleanup first so each feature adds one registration instead of a fifth nearest-wins loop. |
| **A clock module** | layers, world, fishing, pets, magic | Shared Go and TypeScript helpers for cycles, elapsed-time recovery and "the next turning", with shared test vectors. |
| **Server-owned mana** | magic, shared enemies | A save upload may only lower mana; every refill is a server operation. This is magic's step 1 and has no other dependency. |
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

## Proposed order, as releases

Each release is a minor version with its own art round, written as one request.

| Release | Contents | Lanes |
|---|---|---|
| **0.2 Foundations** | Versioning and proto stage 1 (in review now), the "What's new" card, the remaining proto domains | Codex for the server, Opus for the client |
| **0.3 Indoors** | Cleanup phase 3's interactions path and WorldScene split first. Then: rooms are places, Hazel's kitchen, Finn's mill with its loft, the library, resident cycles; pets steps 1–3 (fixes, friends' pets, Companions, yard pets); the quest tree with a Quests tab, pinning and the tutorial hook | Opus (game and UI), Codex (area checks, save ids) |
| **0.4 Crafts** | Guest accounts steps 1–2 (account ids, the profile source seam; server lane, no behaviour change); magic groundwork (ability table, highest-level mark, server mana, classless change); level-20 combat abilities, client-side; the stable and riding; fishing at the mill pond with one recipe | mixed |
| **0.5 The open map** | Guest accounts steps 3–6 (key phrase, title screen, dropping local guest play, devices, linking), world changes with expiry, the Go generator for today's Tangle and Whitequiet, per-chunk epochs | Codex-heavy |
| **0.6 Lake country** | Fields and water, reed and clay, crossings, pottery and Aldo's kiln, fishing in generated waters, level-10 workings on real obstacles | mixed |
| **0.7 Lamps** | The Keeper's hand, way-lamps and the frontier, the mage's naming, the Old ways, chapter 2 (the broken span) | mixed |
| **0.8 Shared fights** | The server enemy sim at camps, combat abilities in server rooms | Codex-heavy |
| **0.9 and on** | Caves, the next lands, capstones, home water | — |

**Decided (owner, 2026-10-07): interleave.** The cleanup the features lean on comes first. The
polish update (sound, the player body, phone resolution, UI steps 8 and 9) runs alongside 0.3 and
0.4 as its own lanes. The gold purse and the Habitica wardrobe follow 0.4, before the open map.
The server-world track starts after the guest planning session.

### Cleanup phases 2–4, adjusted
- **Already covered:** the generated error catalog (phase 2), which the proto enum replaced.
- **Do before 0.3:** the event bus and `lib/tile.ts` (phase 2), the interactions path, the
  WorldScene split and the server file splits (phase 3). Features land on top of them.
- **Skip or shrink:** client Wilds generator work (`wildsFor(session)`, area-build inputs for
  chunks). The server generator replaces it in 0.5. Area-build inputs for hand-made rooms are still
  worth doing with interiors.
- **Unchanged:** panels and CSS, App's layer value, the account flow, art-loading collapse,
  migrations, and the formatter and folders last.

## Art, by release
- **0.3:** an interior kit (floors, walls, doorways, stairs, a ladder, windows, counters); Hazel's
  kitchen, Finn's mill and loft, and the library; smoke and lit windows; quest icons.
- **0.4:** 20 ability icons and effects (Stand, Kindle, Ward-light, Echo); the stable and stall
  bays; a rod, a float and the first fish; a cooked dish.
- **0.6:** lake-country ground, water and props; reed and clay icons; the kiln (cold and lit);
  pottery pieces and glazes; the fen-light; heavable boulders and logs.
- **0.7:** way-lamps, dark lamp stones, route stones, the lamp-pair mark.
- **Caves:** a cave set, mouths, a boss chamber, naming shards, cave enemies.

## Open questions with a default
These go ahead as written unless the owner says otherwise.
- **Quest gates on the server** (item 4): yes.
- ~~**A second pass on quests**~~: done (content format, gates on the server, the opening). Quests steps 1–5 go in 0.3; the quest operation ships with Aldo's kiln (0.6); the Keeper's hand and chapter 2 in 0.7. Chapter 2's 50 embers are pooled into the world's project.
- ~~**Guest accounts planning session**~~: done, see [guests.md](guests.md).
- **The mage bolt's name:** stays Fingersnap.
- **Fishing's open questions** stay with the fishing tab until the owner calls it done.
