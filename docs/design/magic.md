# A bigger magic system

Status: direction and rules agreed with the owner 2026-10-07; numbers await a playtest. Topic from [ideas.md](../ideas.md) ("A bigger magic system").

## Where we are today

- One spell exists: **Fingersnap**, the mage's signature and the classless starter's
  (`src/lib/combat.ts`). It's a mana-costed bolt (15 mana, 0.6 s cooldown). The other
  classes have Cleave, Shadowstep and Mend. All four are combat-only.
- Mana is imported once from Habitica, then lives in the game. Lanterns, the hearth and
  rests refill it. The game never writes it back.
- The lore says something different: *"The magic of the Wilds is not a spell. It is
  simply the act of remembering."* The real power in the world is the **naming**:
  speaking to a flame exactly what it holds still. Keepers name lamps, the Oak Hall's
  mark names a stump, the player speaks the naming to the Warden, and the Saltings
  *ride* the drift instead of fighting it. "Old ways" (two lamps with one naming
  become one place) is already pencilled in as a late reward.

## The heart of it (draft)

Magic in Glimway is **telling the world what it is**. A naming holds a thing still,
calls it back, or lets it go. It reaches fighting and the world alike (gathering,
crafting, travel, other players), and it should feel like a craft you practise, not a
skill bar.

## Chosen direction (owner, 2026-10-07)

**Four crafts, one per class, with class-only abilities.** Magic covers both combat
and the world. Each Habitica class gets its own craft, rooted in a role the lore
already has, and abilities that only that class can use. No sharing across classes.

(Considered and set aside: one shared craft of collected namings with class flavour
only; and a single contextual Fingersnap with no system behind it.)

## The four crafts

Each class has five abilities: its combat signature from today, one more combat
ability, and three **workings** (world abilities). All numbers are first guesses for
a playtest. Mana costs sit against today's pools: 20 for a fresh hero, and roughly
40–80 imported from Habitica in the level 10–30 range (mages higher).

Workings are used from the action button when you stand at a valid target (like
**Speak** at the Warden), so phones need no new button for them. The workings that
act on obstacles are the **class ways** in the shared obstacle catalogue (see
"Obstacles: one catalogue" below), so the level a working unlocks at and the size of
thing it can move are separate gates. Combat abilities
use the ✦ button; the second one needs a second button (see "Phones").

### Warrior: Holding

Lore: warden-stone that walks back to its place, the oak-mark that tells the land a
stump still has a purpose, Orrin's bridges. The warrior's magic is *weight*: making a
thing stay.

| Lv | Ability | Mana | Rule |
|---|---|---|---|
| 10 | **Cleave** (combat, today) | 12 | Unchanged. |
| 10 | **Heave** (working) | 12 | At a **heavy thing** (a fallen trunk, a boulder, a rockfall across a path), shift it aside. The way behind it (a side clearing, a cache, a shortcut) stays open for everyone until the next turning. |
| 15 | **Pin** (working) | 10 | At a planting outside lamplight, or a wandering thing, hold it where it is until the next turning. Works on your own land and on a homestead you're visiting only if you're on its deed. |
| 20 | **Stand** (combat) | 14 | Plant your feet for 1.5 s (you can't move). An enemy whose lunge would reach you stops short and staggers for 0.8 s. No damage reduction, so it isn't Habitica's Defensive Stance. Cooldown 4 s. |
| 30 | **Brace** (working, capstone) | 25 | At a **broken span** (a large gap, a fallen bridge) or a **deep ford**, hold it so anyone can cross until the next turning. Small gaps are the healer's to mend; large spans stay the warrior's. Behind spans sit the best of the Wilds' side places. |

### Mage: Naming

Lore: the Keepers, anchor-lights, the Warden's naming. The mage's magic is
*telling a light what it holds*.

| Lv | Ability | Mana | Rule |
|---|---|---|---|
| 10 | **Fingersnap** (combat, today) | 15 | Unchanged. |
| 10 | **Name a lamp** (working) | 10 | At a **dark lamp** out in the Wilds (a hollow post, a dark lamp stone, a fallen-hero lantern), light it with no oil: a rest spot for everyone until the next turning. When anyone lights a **way-lamp** or homestead lantern post, a mage's naming **stands in for the hearth oil** (the base and other materials are still needed). Setting and naming permanent way-lamps is the Keeper's hand, open to everyone (below). |
| 15 | **Read a route stone** (working) | 8 | At any route stone, choose a place you've been; a guide pin points the way. Pairs with the carter's map. As a class way it also reads where an old ford was across a river with no crossing, and shows it. |
| 20 | **Kindle** (combat) | 16 | Name a spot (about 3 tiles across) for 6 s; it burns hollow light and enemies inside move at 60 %. Cooldown 5 s. |
| 30 | **Old ways** (working, capstone) | 30 + 1 storm-grade drop | Stand at a lit lamp (a way-lamp or a named dark lamp), then another, and give both one naming: they become one place, and **anyone in the world** can step through. Amber holds what magic alone can't, so a pair **lasts past turnings**. Each mage keeps at most 2 pairs; naming a third lets the oldest go. |

### Healer: Mending

Lore: Hazel's remedies, the surgeon's amber casts, Ada who "simply waited
correctly". The healer's magic is *putting a thing back as it was*.

| Lv | Ability | Mana | Rule |
|---|---|---|---|
| 10 | **Mend** (combat, today) | 18 | Unchanged. |
| 10 | **Mend** (working) | 12 | Mend a thing. **In the world**, it's the healer's class way past obstacles: a silted or sick **spring** (fresh water and a rest spot), a broken **footbridge** or small gap, a **cracked lamp**; it holds until the next turning. **A carried tool** gets back a quarter of its uses; a blunt or cracked heirloom comes back to *dull* (usable), never fully mended: the full mend stays a visit to the bench, Orrin or Silas. |
| 15 | **Settle** (working) | 8 | Clear *unmoored* from yourself or another player standing beside you. |
| 20 | **Ward-light** (combat) | 20 | A still circle (about 2.5 tiles across) for 5 s that pulses three small heals to **anyone in it**, other players included. It heals Glimway's own health only, never Habitica's. Cooldown 8 s. |
| 30 | **Mended glade** (working, capstone) | 25 | On open ground in the Wilds or on a homestead, mend a glade (about 4 tiles across) until the next turning. **Anyone** sitting or resting in it heals slowly, about 1 health every 5 s, worked out from time spent there. It mends Glimway health only, and never lifts a hero from 0 health (that still takes embers or a real Habitica heal). One glade per healer at a time; a new one lets the old one go. Owner pick, 2026-10-07, over Tend. |

### Rogue: Drift-reading

Lore: the Blind Routes, the Saltings' drift-tables, Elara's turncaps. The rogue's
magic is *going with the drift instead of against it*.

| Lv | Ability | Mana | Rule |
|---|---|---|---|
| 10 | **Shadowstep** (combat, today) | 10 | Unchanged. |
| 10 | **Read the drift** (working) | 6 | For 20 s, glints show what the drift has moved nearby: dropped things, found things, hidden caches. As a class way it finds stepping stones upstream, a gap in the scree, or a shortcut, open to everyone until the next turning. |
| 15 | **Walk a blind route** (working) | 15 | For 5 minutes you can't become unmoored, and you leave a line of tilted turncaps others can follow until the next turning. |
| 20 | **Echo** (combat) | 12 | Leave a drift-echo of yourself where you stand; enemies aim at it for 3 s. (Replaces the earlier "Slip", which was too close to Shadowstep.) Cooldown 6 s. |
| 30 | **Sense the turning** (working, capstone) | 20 | At a route stone, learn what the next turning will bring: the outer places that will appear, marked on the map for your party. The world is generated from a seed, so the server can work this out ahead of time. |

## Learning: Habitica level unlocks (owner, 2026-10-07)

Abilities unlock by **Habitica level**, read from `stats.lvl` (already imported). The
craft follows the hero's **current class**; because unlocks hang on level, not on
practice, changing class in Habitica loses nothing: you simply have the other
craft's abilities at the same level.

Draft ladder (each class, same levels):

| Level | Unlocks |
|---|---|
| 10 (Habitica's class choice) | The combat signature (Cleave, Fingersnap, Shadowstep, Mend) and the first world working |
| 15 | Second world working |
| 20 | Second combat ability |
| 30 | Third world working (the capstone: Old ways, Sense the turning, …) |

Levels 11–14 are skipped on purpose: that's when Habitica hands out its own class
skills, and the two shouldn't feel like the same event.

Rough pace, assuming a player earns about 100 XP a day on Habitica (Habitica's curve
is about `0.25·L² + 10·L + 140` XP per level): 10→15 in about two weeks, 15→20 in
about three, 20→30 in about two months.

**Rebirth.** Habitica's Orb of Rebirth sets level back to 1. The game remembers the
**highest level it has seen** (like the XP mark for embers), so rebirth never takes
magic away.

**Veterans.** A player who connects above level 30 gets every ability at once, with no
ceremony. Agreed (owner, 2026-10-07).

**Lamps: the Keeper's hand and the mage's naming** (owner, 2026-10-07, settling the
clash with the world design).

- **The Keeper's hand is for everyone.** Learned from Mara, it's a Keeper's craft,
  not magic: writing down where a lamp stands. Anyone who has it sets and names
  **way-lamps**, which are permanent and push the frontier.
- **The mage's naming is the deeper magic.** It lights dark lamps out there without
  oil (a rest spot until the turning), stands in for the hearth oil when anyone
  lights a way-lamp or lantern post, and at level 30 makes the **Old ways**.
- **Old ways stay the mage's capstone.** Only a mage gives two lamps one naming;
  **anyone in the world walks through** the pair. This replaces "Old ways" for
  everyone in `docs/hands-on-design.md` section 5 and `docs/items/overview.md`;
  update both when this ships.
- **The cost:** a world without a level-30 mage has no fast travel. The way back is
  then the frontier rule (never more than a few chunks from light), the turncap jar
  and the carter's map.

## Classless players and guests (owner, 2026-10-07)

No magic. A hero with no class (a guest, a player under level 10, or one who opted
out of classes) **fights with what's in hand**: the basic attack from the weapon slot,
and **no signature ability** (no F key, no ✦ button). Fingersnap is too strong for a
starting player. Mana still exists for them (rests, remedies) but has nothing to spend
on in a fight.

Change to today's code: the `STARTER` kit in `src/lib/combat.ts` loses its
signature, and the HUD hides the ability button when the kit has none. The guest demo
(Wren) must still be beatable without the bolt: check the wisp and Warden fights,
since the starter currently relies on Fingersnap for range.

## Cost: mana for everything (owner, 2026-10-07)

Every ability, combat and working, costs mana. Nothing else is spent, except Old ways'
one storm-grade drop. Mana comes back as it does today: lanterns, the hearth, rests,
remedies, a slow trickle while sitting. So the loop runs *real tasks → embers →
a lantern rest → mana → magic*, without magic ever paying out embers or XP.

**The server owns mana** (owner: more work moves to the server). Today mana lives in
the progress document and a save upload can set it. Proposed:

- Workings are **server operations**: the server checks class, level mark, mana and
  the target, debits the mana and records the change, like a gathering claim.
- Combat stays in the client's frame loop. A save upload may only **lower** mana,
  never raise it; every refill is a server operation (lantern, hearth, rest, remedy).
  So the server's mana is never higher than the truth, which is all a working needs.

## Shared changes and the turning

What a working changes in the world is **shared**: everyone in the world sees the
heaved boulder, the braced span, the mended spring, the named lamp, the turncap line.

**Split by what made the change** (owner, 2026-10-07, settling the clash with the
world design):

- **Done by magic** (heave, brace, pin, mend, a named dark lamp, a mended glade, a
  turncap line): holds **until the next turning** (the end of the wick,
  `nextTurning` in `content/calendar.go`), **wherever it is**, lamplight or not.
- **Built with materials or lit as a way-lamp** (a plank crossing, a footbridge
  mended with plank and rope, a way-lamp, a lantern post): lasts **for good inside
  lamplight**, as the world design has it.
- **Old ways pairs** last past turnings: the storm-grade drop holds them.

So the same footbridge can be crossed two ways: a healer's Mend lets everyone over
until the turning; plank and rope (the tool way) fixes it for good if it's in
lamplight. Magic stays something you practise; building and lamps stay the
permanent way.

House line: *magic holds until the land turns; what's built and lit holds longer.*

**Pins reset too, even on your own land** (owner, 2026-10-07). A pin is magic, so it
holds until the turning; lantern posts stay the permanent way to hold ground. A lapsed pin
doesn't snap back: the planting just starts wandering again from where it stands.

Server shape: a new kind of shared entity alongside camps and nodes in the Wilds
state (`docs/expansion-design.md`, "Shared changes, personal claims"), keyed by
world, epoch and entity, with the turning as its reset. Lazy: a change carries the
turning it expires at, and is simply ignored once that time has passed.

## Obstacles: one catalogue (owner, 2026-10-07)

The world design's class ways past obstacles and this doc's workings are **one list**,
kept as a single obstacle catalogue in `content/` (JSON with Go and TS readers).
Each obstacle kind names its **class working** and its **tool way**.

- **A working unlocks on this doc's ladder** (levels 10, 15, 30 for workings).
- **Your level sets how big a thing it can move**, using the world design's size
  tiers: **small** at any level, **medium** from 15, **large** from 30, **huge** from
  50. Distance from Hearthwick sets how big the obstacles get.
- **Every obstacle always has a tool way**, so heroes with no class (guests, players
  under level 10) are never shut out. Class ways are class-only; tool ways are for
  everyone.

First draft of the catalogue (sizes, tools and the land each appears in come from
the world design and get settled there):

| Obstacle | Class way (working, unlock level) | Tool way |
|---|---|---|
| Fallen trunk, boulder, rockfall | Warrior: **Heave** (10) | Axe or pick; a crafted piece when large |
| Deep ford | Warrior: **Brace** (30), holds it while others cross | Waders |
| Broken span, large gap | Warrior: **Brace** (30) | A crafted plank bridge |
| River with no crossing | Mage: **Read a route stone** (15), shows the old ford; Rogue: **Read the drift** (10), finds stepping stones | Plank and rope |
| Dark lamp out in the Wilds | Mage: **Name a lamp** (10), lit until the turning | Hearth oil (and the Keeper's hand for a permanent way-lamp) |
| Silted or sick spring | Healer: **Mend** (10) | Spade |
| Broken footbridge, small gap | Healer: **Mend** (10) | Plank and rope |
| Cracked lamp | Healer: **Mend** (10) | Lamp head and wick |
| Gap in the scree, hidden way | Rogue: **Read the drift** (10) | Rope ladder |

Two players together can pass anything their combined ways cover, which keeps the far
land social.

## Phones

Workings need nothing new: they appear on the action button at a valid target.
The second combat ability (level 20) needs a second ability button, which the phone
ring and the desktop HUD (`F`, plus one more key, e.g. `R`) must make room for.

## Habitica boundary notes

- Never spend or write Habitica mana; Glimway's mana stays game-local.
- Ward-light and Settle help other players with Glimway's own health and status only.
  They aren't party buffs and never touch Habitica.
- Don't copy Habitica class skills (Burst of Flames, Ethereal Surge, Earthquake,
  Chilling Frost, Healing Light, Protective Aura, Blessing, Searing Brightness,
  Brutal Smash, Defensive Stance, Valorous Presence, Intimidating Gaze, Pickpocket,
  Backstab, Tools of the Trade, Stealth). Party stat buffs are Habitica's territory;
  Glimway magic acts on the world.
- Reading level or class to shape magic is fine; earning XP or level in the game is not.

## Art needed

- **Ability icons:** 20 (5 per class) for the ability buttons, journal and unlock
  notice. 16 px like item icons.
- **Effects:** Stand (a ground ring), Mended glade (soft green-gold ground with a
  few flowers, shared look for everyone), Kindle (a patch of hollow light), Ward-light
  (a still circle with pulses), Echo (a faded copy of the hero), Read the drift
  (glints, reusing the paper glint), Old ways (a lamp-pair glow and a step-through
  shimmer), a generic "working" cast on the hero. Today's class effects
  (`fingersnap-class-effects`) cover the four signatures.
- **World props:** heavable boulder, trunk and rockfall (shut and shifted), broken
  span (broken and braced), spring (silted and mended), footbridge (broken and
  mended), cracked lamp (cracked and mended), hollow lamp (dark and named), turncap line marks, lamp-pair mark.
- **Hero poses:** none required (reuse the swing); a planted "stand" pose is nice to have.

## Open questions

- **The mage bolt's name.** Owner is 50/50: keep **Fingersnap** unless something
  better turns up. Candidates: **Glim** (old word for a small light, and the root of
  "Glimway"; the description can keep the gesture: "a fingersnap throws a glim"),
  **Strike** (as in striking a light), **Wick-flick**.
- **Guest demo without the bolt:** confirm the wisp and Warden fights still work with
  the basic attack only.

## Build order

1. **Groundwork.** Ability table in `content/` (JSON, with Go and TS readers, like the
   other content). Highest-level mark. Classless kit loses its signature; HUD hides
   the button. Server-owned mana: save may only lower it; refills become server ops.
2. **One working per class (level 10)** on a new shared "held until the turning"
   entity, driven by the obstacle catalogue: Heave, Name a lamp, Mend (tools and
   world), Read the drift. Needs the obstacle props and the server generator placing
   them, so it follows the open map and lake country (plan releases 0.5–0.6); Name a
   lamp lands with the Keeper's hand and way-lamps (0.7).
3. **Level 15 workings:** Pin, Read a route stone, Settle, Walk a blind route.
4. **Level 20 combat:** Stand, Kindle, Ward-light, Echo, and the second ability
   button (desktop and phone ring). Ward-light's heal on others goes through presence.
5. **Capstones:** Brace (broken spans in the generator), Sense the turning, the Mended
   glade, and Old ways last (lamp pairs, travel between them, updates to
   `hands-on-design.md` and `items/overview.md`).
