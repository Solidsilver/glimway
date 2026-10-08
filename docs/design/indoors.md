# 0.4 Indoors

Status: **design, ready for lanes**, 2026-10-08. Written from the code at `a0cd842` (0.3 lane A
merged; B, C1, C2 and D still building). The owner's earlier decisions are in
[plan.md](plan.md), [layers.md](layers.md) ("Chosen so far", "Interiors and floors") and
[quests.md](quests.md). Defaults for anything still open are in section 9.

**The aim.** Village buildings get insides you can walk into, save in and meet friends in. Hazel
and Finn go in and out on a shared clock. The quest tree gets its page in the journal, a pin,
the opening that teaches the game, and gates that the server checks. Everything is built on
0.3's model ([server-first.md](server-first.md)): the client sends operations, predicts and
draws, and the server decides.

**Three rules for this release:**

1. **A room is an area.** It has an id, a parent and a place in `where`. There is no second
   kind of "inside". The cottage stops being a view.
2. **Time is worked out, never ticked.** Resident cycles and quest waits are functions of the
   clock, computed by the same helper in Go and TypeScript and checked by shared vectors.
3. **One quest operation.** 0.3's `quest-step` grows gate checks. No new route.

---

## 1. Scope

### In 0.4

| Piece | From | Notes |
|---|---|---|
| Rooms are places | layers.md build step 1 | The `in:` area family through `where`, presence, saves and the server's area rules. Doors and stairs as explicit transitions. The cottage becomes `in:home:<gate>` |
| Three village interiors | layers.md step 2 | Hazel's kitchen, Finn's mill, the library reading room |
| Floors | layers.md step 3 | The mill's sack loft, reached by stairs. The first floor-to-floor transition |
| Resident cycles | layers.md "Going in and out" | Hazel and Finn on a shared 60-minute cycle. Smoke, lit windows, the knock line |
| The quest tree, steps 2–6 | quests.md build order | The Quests page and pin (2), the opening (3), Your Own Day (4), rumours (5), gates on `quest-step` (6) |
| Three small room quests | new here | One per room, each proving a gate (section 5.6) |
| Art round | plan.md "Art, by release" | Section 7 |

### Left for later, on purpose

- **The `world` and `project` gates.** They have no user until Aldo's kiln (lake country) and
  chapter 2 (lamps). The loader refuses them until then, so nobody writes a quest that can't
  run. Building them with their first user keeps them honest.
- **The Keeper's hand, chapter 2, Aldo's kiln.** As planned (Lamps, lake country).
- **More interiors.** Mara's house, Orrin's workshop, Silas's cottage, Ada's front room. The
  format makes each one data plus art; none is needed for 0.4.
- **The cottage cellar and the Hall tier upstairs** (layers.md "Later").
- **Caves and anything at layer `-1`** (layers.md steps 4–8).
- **Day and night.** No global light cycle. Rooms are lit warm and the village keeps today's
  look (Closure Night's tint stays the only night).
- **Fishing at the mill pond.** 0.5. The pond stays outdoors; nothing here touches it.
- **Roofs lifting off** (layers.md direction C). Not chosen.
- **A pin that follows you across devices.** Device-local, as guides are (section 9).

---

## 2. Rooms as places

### 2.1 Ids and parents

```
in:<parent>:<place>            in:village:bakery      in:village:library
in:<parent>:<place>:<floor>    in:village:mill:2      (floor 1 is the plain id)
in:home:<gate>                 the cottage on homestead <gate>
```

- `<parent>` is an outdoor area id: `village` for the three new rooms. Rooms inside rooms
  aren't needed; a floor is a sibling with a number, not a child.
- Two helpers, the same in Go (`content/rooms.go`) and TypeScript (`src/lib/rooms.ts`):
  - `roomParent(area)`: the area you step out to (`in:village:mill:2` → `in:village:mill`,
    `in:village:mill` → `village`). The goal guide's graph uses this.
  - `rootArea(area)`: the outdoor area a room belongs to (`in:village:mill:2` → `village`,
    `in:home:12` → `home:12`). Every rule that asks "where is this, really?" uses this.
- **Known ids** are the rooms in `content/rooms.json` plus `in:home:<gate>` for a valid
  `HomeGate`. Anything else in `where` is a stateful `invalid-position`, as unknown areas are
  in 0.3. Pixel bounds are checked against the room's size.

### 2.2 What the server checks

Today `validArea` (`server/internal/api/payload_validation.go:55`), the safe-area list
(`rules.go:15,36`), `validPresenceRoom` (`api/presence_socket.go:20`) and the nearness checks
each list area ids by name. 0.4 teaches them one family:

| Check | Rule for a room |
|---|---|
| `where` validity (`validArea`, `finiteWhere`) | A known room id, and `x, y` inside its pixel bounds |
| Safe area (profile sync, rest) | `rootArea` is safe. The village rooms are safe; `in:home:<gate>` is your own home's |
| Home rest by the hearth | `where.area` is `in:home:<gate>` for a gate on your deed (was: the doorstep on `home:<gate>`) |
| World move, leave | As `rootArea` |
| Gathering | Refused indoors (no gathering target lists a room) |
| Sellers and menders | Seller rows that follow a resident (2.5) check against the resident's spot now |
| Pickups, repairs, placed papers | Only where a row names the room id explicitly |
| Witness beats | The room is its own witness room |
| Fall | Can't happen indoors (no fights); if one arrives it's handled as a curated fall |
| Report `place` | Accepted and recorded like any area: reload inside and you're still inside |

**What the server doesn't check: the way in.** 0.3 doesn't check travel between outdoor areas
("No travel check", server-first.md 1.1), and rooms follow it. A player can't reach a room
without a door on their screen, and nothing a room holds is worth forging a `where` for under
the friends-on-invites trust model. Checking door adjacency would need a travel history the
server doesn't keep.

**A room that leaves the content.** If a saved place names a room that no longer exists, the
next state read resets the place to the room's door on its parent, or to the village spawn if
the parent is unknown too. This is 028's "unknown areas reset" rule, kept as a read-time rule.

### 2.3 Presence in rooms

- **Each room is its own presence room**, keyed (world, area id) as outdoor areas are.
  `validPresenceRoom` accepts known room ids. The client's area-to-room map
  (`src/lib/presence-client.ts:127`) passes room ids through unchanged.
- Friends indoors see each other; a visitor in your cottage now appears inside it, and you
  appear inside theirs. The 32-per-room limit is plenty.
- Nobody outside sees who's inside. The building shows only whether its **resident** is home
  (2.6), because the client doesn't hear other rooms' presence and shouldn't have to.
- Emotes, the witness relay and avatars work unchanged.

### 2.4 Doors, stairs and ladders

Today exits are edge rectangles inferred from the map edge (`area/exits.ts:19`), and the cottage
door is an interactable that calls `WorldScene.enterRoom` (`WorldScene.ts:829`). 0.4 makes both
explicit, on the one interactions path from the 0.2 cleanup:

| Kind | How you use it | Example |
|---|---|---|
| **Front door** (outside → in) | Face the door tile and press the action button: **Go in** (or **Knock**, 2.6) | The bakery door at village (7, 7) |
| **Doorway** (in → out) | Walk out through the gap in the near wall, as the cottage does today | Every room's `D` tiles |
| **Stairs** | Walk onto the top or bottom step | The mill's stairs to the loft |
| **Ladder, trapdoor** | Press: **Climb up**, **Climb down** | Kept in the kit for the cellar later; not used in 0.4's three rooms |

`ExitDef` (`worlds.ts:59`) gains `side: 'north' | 'south' | 'east' | 'west'` (the side you
step out of, so the chevron and the arrival facing are right) and `kind: 'edge' | 'door' |
'stair'`. Edge exits keep inferring their side. Each transition names its entry tile on the
other side, so going out puts you on the doorstep facing away from the door.

### 2.5 How a room is authored: `content/rooms.json`

One file, embedded by Go and imported by TypeScript, validated by both loaders. A room is a
small grid written as rows of characters, so a room can be read and edited by eye. Props sit
on top with footprints. Art keys are names, so a room loads before its art does (missing art
falls back to the kit's placeholder tiles, as buildings do today).

```json
{
  "legend": {
    "#": "wall", "=": "back-wall", "w": "window", ".": "planks", ":": "flagstone",
    "D": "doorway", "^": "stairs-up", "v": "stairs-down", "@": "arrive"
  },
  "rooms": [
    {
      "id": "in:village:bakery",
      "name": "Hazel's kitchen",
      "parent": "village",
      "map": [
        "##############",
        "#==w==OOO==w=#",
        "#ss...OOO..pp#",
        "#......:.....#",
        "#..TTTT......#",
        "#..TTTT...b..#",
        "#...........c#",
        "#............#",
        "#.....@......#",
        "######DD######"
      ],
      "doors": [
        { "id": "front", "kind": "door", "at": "D", "side": "south",
          "to": "village", "outside": { "tx": 7, "ty": 7 }, "entry": { "tx": 7, "ty": 8 } }
      ],
      "props": [
        { "art": "kitchen-hearth", "char": "O", "solid": true },
        { "art": "kitchen-crocks", "char": "s", "solid": true },
        { "art": "kitchen-tallow-pot", "char": "p", "solid": true },
        { "art": "kitchen-worktable", "char": "T", "solid": true },
        { "art": "kitchen-sponge-bowl", "char": "b", "solid": true },
        { "art": "kitchen-bread-rack", "char": "c", "solid": true }
      ],
      "spots": {
        "kitchen-hearth": { "tx": 7, "ty": 3, "label": "Warm your hands" },
        "sponge-bowl": { "tx": 10, "ty": 5, "label": "Look in the bowl" }
      },
      "lights": [ { "tx": 7, "ty": 2, "kind": "hearth", "r": 5 } ],
      "outside": { "building": "house-west", "window": { "tx": 9, "ty": 6 }, "chimney": { "x": 72, "y": 52 } }
    }
  ]
}
```

- **Grid characters** from `legend` are ground: walls and the back wall are solid, floors
  walkable, `D` is the doorway, `^`/`v` stair tiles become stair exits, `@` is where you arrive
  through the front door.
- **Prop characters** (any other letter) are claimed by one `props` row. Each connected group of
  that letter is one prop, its footprint, which is solid when `solid` is true; the art is drawn with its foot at the
  footprint's bottom centre. The loader checks every letter is claimed and every group is a
  rectangle.
- **`spots`** are interactable ids, named once across all content (the quest `use` trigger and
  `where.spot` name them). The loader checks they sit on or next to a walkable tile.
- **`doors`** with `kind: "door"` also add the front-door interactable on the parent map at
  `outside`, replacing the solid door tile's dead end. The parent map isn't edited by hand.
- **`lights`** are warm light pools (2.7). **`outside`** tells the parent which building art
  gets the lit window and chimney smoke.
- **The cottage** isn't in this file: its layout comes from `content/homestead.json`'s indoor
  grid, as `src/game/cottage.ts` builds it now. It registers as the `in:home:` family.

Lane A writes the schema, both loaders, the validators and the three rooms below. After that,
the room *data* (maps, props, spots) belongs to lane B for tuning; the schema stays A's.

### 2.6 Residents and buildings: `content/residents.json`

Today resident spots live in `content/items.json` (`rules.residents` for Hazel and Ada; Finn
borrows his seller row's tile). They move to their own file, with the cycles (section 4):

```json
{
  "periodMinutes": 60,
  "graceSeconds": 90,
  "residents": [
    {
      "id": "hazel",
      "offsetMinutes": 0,
      "home": "in:village:bakery",
      "spots": {
        "kitchen": { "area": "in:village:bakery", "tx": 4, "ty": 6 },
        "square":  { "area": "village", "tx": 12, "ty": 15 }
      },
      "cycle": [ { "spot": "kitchen", "minutes": 40 }, { "spot": "square", "minutes": 20 } ]
    },
    {
      "id": "finn",
      "offsetMinutes": 20,
      "home": "in:village:mill",
      "spots": {
        "stones": { "area": "in:village:mill", "tx": 8, "ty": 4 },
        "loft":   { "area": "in:village:mill:2", "tx": 7, "ty": 5 },
        "door":   { "area": "village", "tx": 30, "ty": 23 }
      },
      "cycle": [ { "spot": "stones", "minutes": 25 }, { "spot": "loft", "minutes": 10 }, { "spot": "door", "minutes": 25 } ]
    },
    { "id": "ada", "spots": { "window": { "area": "village", "tx": 35, "ty": 8 } }, "cycle": [ { "spot": "window", "minutes": 60 } ] }
  ]
}
```

- **Sellers follow a resident.** A seller row in `items.json` swaps its fixed `area, tx, ty` for
  `"with": "hazel"`. The server's nearness check (`nearTile`, `item_slots.go:19`) asks the cycle
  where Hazel is now, and Hazel sells tallow from her worktable or her basket alike.
  Rows that don't move (the madder stall) keep their fixed tile.
- **The knock line.** Each resident has one line per spot for when you try their door and
  they're elsewhere, kept in TypeScript with the rest of their words
  (`src/content/residents.ts`). Finn, out at the door: *"Wheel's turning, I'm round the
  front."* Hazel, in the square: *"Out with the basket. Shop's open, mind the oven."*
- **Doors never latch.** You can always go in. When the resident is out, the door's action
  says **Knock**, plays the knock line, then lets you in to an empty room with the hearth
  banked. Quests never wait on someone being home (quests.md 5, "Interiors").

### 2.7 The client side

**Building the scene.** One new area kind, registered like the Wilds chunks
(`registerAreaKind`, `worlds.ts:800`), builds a `WorldData` from a room row: ground and solid
grids from the map, props from footprints, exits from doors and stairs, the room's spots on the
interactions path. `WorldScene` restarts per area exactly as today, so entering a room is a
normal area change (`transitionTo` → `moveTo`): the report carries the new place, presence
switches room, and a reload comes back inside. `enterRoom` and `SceneData.room` go.

**Camera.** Rooms are smaller than the screen. `world-camera.ts` already centres a map smaller
than the view (the cottage); rooms use that, with the zoom chosen so the room's height fills
about 80% of the play area between the HUD insets, capped at the outdoor zoom's top. Outside
the walls is the room's dark wood colour, not black. No follow inside a room unless it's wider
than the view (none of 0.4's are).

**Lighting, cheaply.** No lighting engine:

- each `lights` row draws a soft warm pool (a code-made radial texture, additive, gently
  flickering for a hearth);
- a dark vignette at the room's edges (one texture, multiply);
- windows in the back wall show daylight (their art).

**Outside, from the cycle.** A building with a resident shows chimney smoke and a lit window
while the resident's spot is inside it. The library's window is always softly lit. Both are
overlays on the existing building art (`buildings.ts`), toggled when the cycle changes.

**Phones.** Rooms are small, so the phone framing (2 CSS px per world px) shows a whole room;
the touch controls' action button does doors and stairs.

---

## 3. The places

Maps are tiles (16 px each). Legend for all three: `#` wall, `=` back wall, `w` window, `.`
plank floor, `:` flagstone, `D` doorway, `^` stairs up, `v` stairs down, `@` arrival.
Letters are props, named under each map.

### 3.1 Hazel's kitchen, `in:village:bakery` (14 × 10)

Behind the bakery on the west house (`VILLAGE_HOUSES[0]`, door at village (7, 7), the basket out
front at (6, 8)). The warmest room in Hearthwick: flour on everything, the oven never quite out.

```
##############
#==w==OOO==w=#    O  oven and hearth, the pot hanging in it
#ss...OOO..pp#    s  shelves of crocks       p  the tallow pot on its stand
#......:.....#    :  the hearth's flagstone apron
#..TTTT......#    T  the worktable (Hazel kneads here)
#..TTTT...b..#    b  the sponge bowl on a stool
#...........c#    c  bread rack
#............#
#.....@......#
######DD######    out to the village at (7, 8)
```

- **Interactables:** the hearth (**Warm your hands**: a seated-style slow regen while you
  stand there, like the benches), the sponge bowl (flat or risen, used by *Set to Rise*), the
  tallow pot (flavour line; tallow is bought from Hazel herself).
- **Residents:** Hazel, 40 minutes in, 20 out in the square. Indoors she moves between the
  worktable and the hearth (a two-stop routine in `npc-routines.ts`).
- **What you can do:** buy tallow (her seller row now follows her), talk (her lines, topics and
  late papers as today), start *Set to Rise*, warm up.

### 3.2 Finn's mill, `in:village:mill` (14 × 11) and the sack loft, `in:village:mill:2` (12 × 8)

The Tolley mill on the pond's west edge (village (28, 19), door at (29, 22)). The wheel turns
outside on the east wall, so the gear train inside turns with it. The hopper with Aldo's tally
stays **outside** where it is (27, 22): the canon hint lives there, unchanged.

```
##############
#==w=====GGG=#    G  gear train on the east wall, turning with the wheel
#.....MM.GGG.#    M  the millstones under their hopper
#.....MM.....#
#..kk........#    k  the chute and the meal bin
#..kk.....^^.#    ^  stairs up to the loft
#.........^^.#
#.ff.........#    f  flour sacks
#.ff....n....#    n  Finn's counting stool, where he can hear the wheel
#......@.....#
######DD######    out to the village at (29, 23)
```

```
############
#=w=====w==#
#.ff..ff...#    f  sacks waiting to go down
#.ff..ff...#
#.vv.....HH#    v  stairs down to the mill floor
#.vv.....HH#    H  the sack hoist and its hatch over the yard
#..........#
############    the roof beams cross the top as a foreground overlay
```

- **Interactables:** the counting stool (**Sit**: you hear the wheel; Finn's count line if he's
  there), the millstones (a look line), the hoist (**Look at the hoist**; *The Stuck Hoist*).
- **Residents:** Finn, 25 minutes at the stones, 10 in the loft, 25 out at his door, offset 20
  minutes from Hazel so the two are rarely both out.
- **What you can do:** buy flour wherever Finn is, talk, climb to the loft (the first stairs),
  fix the hoist.
- **Floors:** the stairs are a pair of stair exits with `side` set: walking onto `^^` puts you in
  the loft on the tile just east of `vv`, facing east, and walking onto `vv` puts you beside `^^`
  on the mill floor.

### 3.3 The library reading room, `in:village:library` (14 × 10)

The small reading house on the square's quiet side (village (2, 14), door at (4, 17)).

```
##############
#=SS=SS=w=SS=#    S  tall shelves along the back wall (the collection)
#............#
#.RRRR.......#    R  the reading table, chairs either side; the lamp sits on it
#.RRRR.......#
#..........dd#    d  the donation shelf
#............#
#..ee........#    e  the window seat
#.....@......#
######DD######    out to the village at (4, 18)
```

**The room and the panel.** The room is the way in; the panel stays the way you read. The
library door stops opening the panel (`entities/papers.ts:93`) and becomes a front door. Inside:

- the **tall shelves** open `LibraryPanel` on its collection, as the door does today;
- the **donation shelf** opens the same panel on its donate view;
- the **reading table** seats you (**Sit and read**) and opens the panel's reader on the paper
  you last read, with the seated regen of a bench;
- the window seat is a plain seat.

The shelves show how full the village library is: three art states by the shelf count the
panel already loads (`GET /api/library`). Nothing in the panel changes; it's reached from the
room. Nobody keeps the library: no resident lives here, as today.

### 3.4 The cottage, `in:home:<gate>`

Same room, same furniture, same hearth rest. It becomes a real place: you save inside, presence
puts visitors inside with you, and the home rest checks `in:home:<gate>` against your deed. The
door on the homestead map becomes a front door (`homestead-talk.ts:601` stops calling
`enterRoom`). Homestead placements keep their `scene: 'indoor'` key.

---

## 4. Resident cycles

**Who is where when.** A resident's place is a pure function of the clock:

```
minute = floor((now_unix / 60 - offsetMinutes) mod periodMinutes)   // the cycle starts at :offset
spot   = the cycle phase that minute falls in
since, until = when that phase started and ends (Unix seconds)
```

Everyone in every world sees Hazel in the same place at the same moment. Nothing is stored and
nothing ticks.

| Resident | 0–20 | 20–40 | 40–45 | 45–55 | 55–60 |
|---|---|---|---|---|---|
| Hazel (offset 0) | kitchen | kitchen | square | square | square |
| Finn (offset 20) | door | stones | stones | loft | door |

(Minutes past the UTC hour.) Both are out at once for five minutes an hour.

**The helper.** The 0.3 clock module (`content/clock.go`, `src/lib/clock.ts`) gains:

- `cycleAt(resident, now) → { spot, since, until }`;
- `cycleSpotsNear(resident, now, graceSeconds) → spots[]`: the current spot, plus the previous
  one for `graceSeconds` after a change and the next one for `graceSeconds` before it.

Shared vectors go in `content/vectors/clock.json` (both sides run them): phase edges, offsets
that wrap the hour, the grace window on both sides, and a single-phase resident (Ada).

**How the server and client agree.**

- The **server** uses `cycleSpotsNear` for every check that involves a resident: seller
  nearness, the `talk` trigger and the `with` gate (section 5). A player who clicked buy at
  :39:58 and arrived at :40:03 isn't refused.
- The **client** uses `cycleAt` with the server's clock. If 0.3's client doesn't already keep a
  server-time offset (from the `Date` header or `vitals_at`), lane B adds it to `game/clock.ts`;
  the 90-second grace covers whatever skew is left. The dev clock (`setGameNow`) and the server's
  test `-dev-clock` flag move both sides together for tests.
- **Walking at the change.** The client checks the cycle every second while a resident is on
  screen. At a change it walks them to the door (a straight two-leg path to the door tile) and
  fades them through it; in the room, they fade in at the doorway and walk to their spot. If you
  weren't watching, they're simply where the clock says. The walk is drawing only.
- Today's strolls (`npc-routines.ts`) keep playing at the outdoor spots; they stop being Hazel's
  whole day.

---

## 5. The quest tree

### 5.1 What 0.3 lands, and what 0.4 adds

0.3 (lane B) lands `content/quests.json` with the lantern road only, its step ids equal to
today's stage names, the `quest_progress` table, and `quest-step {op, quest, to, where}`
checking that `to` follows the current step and that `where.area` matches the step's area,
then paying the step's items, marks, papers and embers once. Every step is already an
operation; there are no client-merged steps left (server-first.md, superseding quests.md 2).

0.4 grows the same file and the same operation. **The file format is quests.md section 1** (its
quest and step fields, triggers, gates and grants tables), with these changes for server-first:

| quests.md said | 0.4 does |
|---|---|
| Plain steps are client-written, gated steps are "server steps" | Every step is a `quest-step`. A `gate` adds checks to that same operation |
| `gate.at: "orrin"` | Renamed **`gate.with`**, because 0.3's step already has an area `at`. "You're with Orrin now": your `where.area` is one of his spots near now (section 4) |
| `needs: "world"` | Dropped. Everyone plays on a server since 0.3 |
| `world`, `project` gates | Deferred to their first user (section 1) |
| `give` and `unlock` on server steps only | Allowed on any step |
| Ember grants at most 5 on plain steps | At most 5 on any step: a loader check that keeps quests from becoming an ember tap |

If lane B lands field names that differ from quests.md's, 0.4 keeps B's names; the meaning
here is what matters.

**Gates and triggers belong to the step being left.** The record holds the step you're on;
`quest-step {quest, to}` says "I did this step's `do`, move me to `to`". The server checks the
current step's trigger and gate, then moves the record and pays that step's grants. `to` is the
next step id or `done`. Starting a quest is `quest-step {quest, to: <first step>}` with no row
yet: the server checks `after` and `needs`.

### 5.2 What the server checks per trigger

The client still decides when a trigger fired (it saw the talk end). The server checks what it
can know:

| Trigger | Server check |
|---|---|
| `talk: <npc>` | `where.area` is where that person is: a quest NPC's fixed area, or a resident's spots near now |
| `use: <spot>` | `where.area` is the spot's area (rooms and curated spots share one id space) |
| `reach: <area>` | `where.area` is that area |
| `defeat: <enemy>` | The `defeated:<enemy>` mark exists |
| `carry: <item>` | The item is held: a server item row, or a `quest-item` mark |
| `flag: <mark>` | The mark exists (a server mark like `lit:road-1`, or a client one) |
| `open: journal` | Nothing to check |
| `sync: embers` | A ledger credit with reason `sync` exists after the current step's `since` |

Refusals use 0.3's codes (`not-next-step`, `wrong-area`) plus the new ones in section 6.

### 5.3 Gates

All keys must hold; the operation checks them in one transaction, in this order, then spends:

| Gate | Holds when | Spends | Refusal |
|---|---|---|---|
| `with: "<resident or npc>"` | `where.area` is one of their spots near now | No | `not-here` |
| `wait: { "hours": n }` or `{ "turnings": n }` | That long since the previous gate passed on this quest (or the quest's start if none) | No | `not-yet` |
| `item: { "def", "qty", "keep" }` | You hold them; `keep: false` takes them through the items code | Optional | `short` |
| `embers: n` | Your balance covers it; debited with reason `quest`, ref `<quest>:<step>` | Yes | `short` / `needs-earned` as spends today |

- **Waits count from the previous gate**, or from the quest's start when no step before it had a
  gate, so every wait has a moment to count from (`gate_at`, section 6). `turnings` counts wicks
  with `content.CalendarAt`, as quests.md 2 describes.
- **The client predicts the wait** from the quest's last gate time in `PlayerState.story`
  (section 6), so the dialogue can say "Come back in about two hours" or "after the turning"
  without asking the server. A `not-yet` refusal means the prediction and the server disagreed;
  the state that comes with it fixes the client's view.
- **Offline.** Steps with no gate queue in the outbox, as in 0.3. A step with a gate shows
  **Needs a connection** offline, as spends do.

### 5.4 The Quests page

The journal's "Lantern Road" tab (`JournalPanel.svelte`, `Tab = 'road'`) becomes **Quests**. "How
do I…?" and Papers stay as they are.

```
┌ Journal ───────────────────────────────────────────┐
│ [ Quests ]  Papers   How do I…?                    │
│                                                    │
│ THE ROAD                                           │
│ ▸ The Lantern Road                      [ Pin ◆ ]  │
│     Copy the route stone in Brackenwood            │
│     ✓ Hear Mara out                                │
│     • Copy the route stone      ← current          │
│     · · ·                                          │
│ ✓ Three Fingers off Plumb                 (done)   │
│                                                    │
│ THE VILLAGE                                        │
│ ▸ Set to Rise                           [ Pinned ◆ ]│
│     Let the sponge rise · ready in about 1 h 20 m  │
│ ▸ The Stuck Hoist                       [ Pin ◆ ]  │
│ 🔒 Your Own Day                                    │
│     Connect Habitica in the Menu to take this one  │
│                                                    │
│ NOTES                                              │
│   A Wisp on the Finger · Three Fingers off Plumb   │
└────────────────────────────────────────────────────┘
```

- **Shelves** by `line`: the Road (by `chapter`), the Village, Crafts (empty in 0.4, hidden until
  it has something). A quest shows only once it's in your record, or locked if its `needs`
  fails and its `after` holds.
- **A quest card**: title, blurb on first open, the current step's `goal` and `objective`, done
  steps ticked, future steps as `· · ·` (no spoilers). A wait shows when it opens. Done quests
  fold to one line at the bottom of their shelf.
- **Notes**: the step `note`s you've written, newest first, opening in the existing note view.
- **Pin** on every open quest card. Opening the journal while the opening's `note-lean` step is
  current lands on this page with that quest at the top (quests.md 3).
- Keyboard: J opens the journal on Quests; the tab keys work as today.

### 5.5 Pinning

- **One pin slot** per account and device in localStorage (0.3's C1 keys `guide-pin.ts` by
  account). It holds `quest:<id>` or `guide:<id>`. Pinning one unpins the other.
- **The HUD** (`Hud.svelte`): the goal line, the needle and the edge glint follow the pinned
  quest's current step `where`. With nothing pinned, they follow the road's current quest, as they
  follow the story today. A done or locked pin falls back the same way.
- **The goal guide** (`entities/goal-guide.ts`) swaps its `GOALS` table for `where`. Its `ROAD`
  graph gains every room as a child of `roomParent`, built from `rooms.json`, so "the mill loft"
  is two steps from the village square. `where.npc` for a resident asks the cycle: the needle
  points at the mill door while Finn is in, at his door spot while he's out.

### 5.6 The quests 0.4 ships

Six quests. Three come from quests.md as written; three are small and new, one per room, each
proving a gate on something cozy.

| Quest | Line | Starts | Proves | Source |
|---|---|---|---|---|
| **The Lantern Road** | road, ch. 1 | after the opening, talking to Mara | (existing) | 0.3, step ids renamed |
| **Three Fingers off Plumb** | road, ch. 0 | every new save | the opening, `open: journal`, the finger-wisp | quests.md 3, unchanged |
| **Your Own Day** | village | after `signpost:see-mara`, talking to Mara | `sync`, `needs: habitica` | quests.md 3, unchanged |
| **Set to Rise** | village | after the opening, talking to Hazel | `item`, `with`, `wait` | new |
| **The Stuck Hoist** | village | after the opening, talking to Finn | stairs, `use` in a loft, `item` | new |
| **A Seat by the Lamp** | village | after the opening, walking into the library | `embers` | new |

**Lantern road renames.** 0.4 renames the road's steps to what you do (quests.md 4's table:
`hear-mara`, `copy-stone`, `settle-warden`, `light-shrine`, `tell-mara`), so dialogue `when`
refs read as steps. Migration 030 maps the rows and gift outcomes (section 6).

**Set to Rise** (Hazel's kitchen). Hazel's sponge wants flour and a couple of hours.

```json
{
  "id": "set-to-rise", "title": "Set to Rise", "line": "village",
  "blurb": "Hazel's starter wants feeding, and Finn has the flour.",
  "after": ["signpost"], "start": { "talk": "hazel" },
  "steps": [
    { "id": "fetch-flour", "goal": "Bring Hazel a sack of flour",
      "objective": "Hazel's out of the fine sift. Finn sells it at the mill, a sack an ember.",
      "where": { "npc": "finn" }, "do": { "carry": "flour" } },
    { "id": "set-sponge", "goal": "Help Hazel set the sponge",
      "objective": "Take the flour to Hazel in her kitchen and set the sponge with her.",
      "where": { "npc": "hazel" }, "do": { "talk": "hazel" },
      "gate": { "with": "hazel", "item": { "def": "flour", "qty": 1, "keep": false } } },
    { "id": "let-it-rise", "goal": "Come back when it has risen",
      "objective": "A sponge won't be hurried. Come back to Hazel's kitchen in a couple of hours.",
      "where": { "area": "in:village:bakery", "spot": "sponge-bowl" }, "do": { "talk": "hazel" },
      "gate": { "with": "hazel", "wait": { "hours": 2 } },
      "grants": { "give": [{ "def": "keepers-twists", "qty": 2 }], "embers": 2 },
      "note": { "title": "Set to Rise",
        "body": "Hazel says you can't hurry a sponge, only leave it somewhere warm and trust it. Two twists for my trouble, still hot. She burnt the ends of one on purpose." } }
  ]
}
```

Hazel, starting it: *"I've a sponge that wants feeding and not a pinch of fine sift in the
house. Finn's got it. Finn always has it, he just has to stop counting long enough to sell it."*
Coming back too early, she says the predicted time in her own words: *"Not yet. Look at it. It's
thinking. Give it another hour."*

**The Stuck Hoist** (the mill and the loft). Finn can't get sacks down; the hoist in the loft
has seized.

| Step | Do | Where | Gate | Grants |
|---|---|---|---|---|
| `look-hoist` | `use: mill-hoist` | the loft | | |
| `get-tallow` | `carry: tallow` | Hazel (she sells it) | | |
| `grease-hoist` | `use: mill-hoist` | the loft | `item: tallow ×1, keep: false` | embers 3 |
| `tell-finn` | `talk: finn` | Finn | | `give: oatcakes ×1`, note *"Forty turns and a squeak"* |

Finn, starting it: *"The hoist's seized. I've sacks up there and none down here, and Hazel needs
flour, and Mara needs flour, and I'm counting the wrong thing again. Would you look? Stairs are
at the back. Mind the third one."* It walks you up your first stairs and back and forth between
the two rooms, without saying so.

**A Seat by the Lamp** (the library). The reading lamp's oil comes from the village stores, so
Mara wants an ember for it. A note on the lamp in her hand: *"One ember the oil. Ledger. — M.H."*

| Step | Do | Where | Gate | Grants |
|---|---|---|---|---|
| (start) | `reach: in:village:library` | | | |
| `browse-shelf` | `use: library-shelf` | the tall shelves | | |
| `oil-lamp` | `use: reading-lamp` | the reading table | `embers: 1` | mark `library:lamp` |
| `read-awhile` | `use: reading-table` | the reading table | | embers 2, note *"A Seat by the Lamp"* |

`library:lamp` is a server mark (a new `server` namespace in `content/story.json`). With it,
the lamp on the reading table is lit whenever you're in the room, and Sit and read works; before
it, the table offers only the oil. Net, the quest pays one ember back, and it teaches that
embers are spent in the world.

**Canon care.** None of the three reveals anything the reveal order holds back. Finn's hopper
tally and linseed box, Hazel's card and Joss stay with their late lines and papers.

### 5.7 The tutorial hook

The opening (*Three Fingers off Plumb*) is the tutorial, as quests.md 3 writes it out: walking,
talking, the basic attack on the finger-wisp, picking up, the journal, embers, lighting a lamp.
0.4 builds it:

- **New accounts start with it.** Player creation writes `quest_progress('signpost',
  'meet-orrin')`. Existing accounts get it as done (migration 030), so the owner isn't sent back
  to Orrin.
- **The finger-wisp**: a curated `EnemySpot` near Brackenwood's west entry, low health,
  telegraphed hops, Slash alone enough (Fingersnap leaves classless heroes in 0.5).
- **The journal glow**: the HUD's book button gets the edge glint's glow while a step's `where`
  is `{ "ui": "journal" }`.
- **Pip's walk-on** after `set-post`. 0.3 deletes `nudges.ts` with local play, so the walk-on is
  a small scripted beat of its own in the village scene.
- **Mara's top-up**: a hero who reaches the first lamp with fewer than 3 embers gets topped back
  up once, as a grant on `see-mara` computed by the server (`embers: 5`, plus up to 3 more while
  the balance is short, at most once, outcome `quest-gift:signpost:topup`).
- **The rooms quests are its second half**, never required: doors (Hazel), stairs (Finn), the
  library and spending an ember in the world (the lamp), and coming back later (the sponge).
  Hazel's intro already sends new players to her; her first-talk line gains *"…and if you've a
  minute after, I've a sponge that wants feeding."*

**Rumours** (quests.md step 5) ship too, since lines are now keyed by `quest:step`: residents get
**Heard anything?**, naming the next step of an open, unpinned quest in their voice. Small; lane C.

### 5.8 Where the words live

As quests.md 1 says: dialogue rules swap `forStages` for `when: ["quest:step"]`; each new quest
gets `src/content/quests/<id>.ts` with its lines, knock lines and "not yet" variants; resident
lines key by the road's step. The server never needs the words.

---

## 6. Operations and migrations

**No new routes.** Everything rides on 0.3's operations.

### 6.1 Proto changes

All in `proto/glimway/v1`, one change on the integration branch (lane A1):

```proto
// state.proto: Story grows two maps, keyed by quest id (Unix seconds).
message Story {
  // … 0.3's fields …
  map<string, double> step_since = 7;   // when the current step began (the record's `since`)
  map<string, double> gate_at = 8;      // when this quest last passed a gated step (or began)
}

// operations.proto: QuestStepResult says what the gates took and the grants gave.
message ItemQty { string def = 1; double qty = 2; }
message QuestStepResult {
  // … 0.3's fields 1–6 …
  double embers_spent = 7;
  repeated ItemQty taken = 8;
  repeated ItemQty given = 9;
  repeated string unlocked = 10;     // server marks from `unlock` grants
}
```

(Field numbers follow whatever 0.3 finally assigns; these are the next free ones.)

- **New error codes**, appended: `not-yet` (a `wait` gate), `not-here` (a `with` gate, or a
  resident elsewhere), `needs-habitica` (a `needs` the profile source fails). Embers and items
  reuse `short` and `needs-earned`.
- **The contract number** goes from 3 to 4 (`content/contract.json`), so 0.3 tabs get the reload
  notice.
- **Presence:** no message change. Room ids are areas.
- **Rooms and residents** aren't served: both sides embed the same `content/` files.

### 6.2 Content files

| File | Change | Owner |
|---|---|---|
| `content/rooms.json` (+ `rooms.go`, `src/lib/rooms.ts`) | New | A (schema), B (room data) |
| `content/residents.json` (+ loaders) | New; takes `items.json`'s `rules.residents` | A |
| `content/items.json` | Seller rows gain `with`; `rules.residents` removed | A |
| `content/quests.json` | The six quests; gate and grant fields | A (schema, validators), C (quest data) |
| `content/story.json` | `library:` and `unlock:` server namespaces | A |
| `content/clock.*`, `src/lib/clock.ts`, `content/vectors/clock.json` | `cycleAt`, `cycleSpotsNear`, vectors | A |
| `content/vectors/quests.json`, `rooms.json` | Loader vectors both sides run | A |

The quest loader adds to quests.md's checks: `with` names a quest NPC or resident; `wait` order
(5.3); no `world`/`project` gate yet; ember grants at most 5; `give` items exist in `items.json`;
`where.spot` and `use` name a known spot; `where.area` is a known area or room.

### 6.3 Migrations (after 0.3's 028)

| # | Name | Lane | What |
|---|---|---|---|
| **029** | `quest_times` | A | `quest_progress` gains `since INTEGER NOT NULL DEFAULT 0` (when the current step began) and `gate_at INTEGER` (the last gated step passed, or the quest's start). Existing rows get `since = gate_at = ` the migration time. No history table: a wait only ever counts from the last gate |
| **030** | `quest_ids` | A | Renames the lantern road's step ids in `quest_progress` (`accepted` → `copy-stone`, `clue-found` → `settle-warden`, `guardian-defeated` → `light-shrine`, `lantern-lit` → `tell-mara`, `complete` → `done`) and its gift outcomes (`quest-gift:lantern-road:guardian-defeated` → `quest-gift:lantern-road:settle-warden`, `…:complete` → `…:tell-mara`). Inserts `signpost = done` for every account with a lantern-road row. Accounts with none get `signpost = meet-orrin` |

If 0.3's B lands the lantern road already holding a step before `accepted` (Mara's first talk),
030 maps it to `hear-mara`. Upgrade tests use the existing fixture pattern: the owner's story at
each stage, gifts paid, a home rest after the cottage move, ledger sums unchanged.

No place migration: 0.3 never saved `cottage`, and the new rooms have no saved places yet.

---

## 7. Art list

For the image-generation round, as one request (`docs/art-request-indoors.md` is written from
this list when the round starts). Same direction as `docs/art-request-playtest2.md`: **64
texels per 16 px world tile**, 1 px dark outlines at that density, light from the upper left,
crisp pixels, no soft gradients, three-quarter top-down view, transparent backgrounds. Deliver
into `assets/generated/indoors-pass/` with `manifest.json`, `atlas.json`, README and
`prompts.json` notes. Every sprite lists its footprint (tiles), canvas (texels) and foot point
(bottom centre of the footprint). Animated pieces are horizontal strips, frames left to right,
same canvas each.

### 7.1 The interior kit (tiles and pieces)

| Piece | Footprint (tiles) | Canvas (texels) | Frames / states | Notes |
|---|---|---|---|---|
| Plank floor | 1 × 1 | 64 × 64 | 4 variants | Warm worn boards running east–west; seamless in any order |
| Flagstone floor | 1 × 1 | 64 × 64 | 4 variants | Golden stone, for hearth aprons and the mill floor's wet end |
| Back wall | 1 × 2 | 64 × 128 | 3 variants | Timber frame and plaster, the top row is the wall's top edge |
| Back wall, window | 1 × 2 | 64 × 128 | 1 | Small paned window with daylight; the sill catches light |
| Side and near walls | 1 × 1 | 64 × 64 | 8 pieces | Left, right, near, the four corners, a near-wall end beside a doorway |
| Doorway | 2 × 1 | 128 × 64 | 1 | The gap in the near wall, threshold boards, a little daylight spilling in |
| Stairs up | 2 × 2 | 128 × 128 | 1 | Wooden stairs rising toward the back wall, with a rail |
| Stairs down | 2 × 2 | 128 × 128 | 1 | The opening in an upper floor, rail around it, steps going down out of sight |
| Ladder | 1 × 2 | 64 × 128 | 1 | For the cellar later |
| Trapdoor | 1 × 1 | 64 × 64 | 2 (shut, open) | For the cellar later |
| Rug | 3 × 2 | 192 × 128 | 2 designs | Rag rug; braided round rug |
| Counter | 3 × 1 | 192 × 128 | 1 | Rises up to 1 tile above its footprint |
| Room surround | 1 × 1 | 64 × 64 | 1 | Dark wood seen beyond the walls (fills the screen around a small room) |

### 7.2 Hazel's kitchen

| Piece | Footprint | Canvas | Frames | Notes |
|---|---|---|---|---|
| Oven and hearth | 3 × 2 | 192 × 192 | 4 (fire) | Brick bread oven with a hearth beside it, the pot hanging on a crane; rises 1 tile into the back wall |
| Worktable | 4 × 2 | 256 × 128 | 1 | Scrubbed table, flour drifts, a dough on a board |
| Shelves of crocks | 2 × 1 | 128 × 128 | 1 | Crocks, jars, a salt pig; rises 1 tile |
| Tallow pot on its stand | 2 × 1 | 128 × 128 | 3 (steam) | Rises 1 tile |
| Sponge bowl on a stool | 1 × 1 | 64 × 128 | 2 (flat, risen) | Cloth over the bowl; risen domes under it |
| Bread rack | 1 × 1 | 64 × 128 | 1 | Loaves and a tray of twists, one with burnt ends |
| Hazel kneading | — | the resident sprite's canvas | 4 | Optional: her existing sprite, arms working the dough |

### 7.3 Finn's mill and loft

| Piece | Footprint | Canvas | Frames | Notes |
|---|---|---|---|---|
| Millstones under the hopper | 2 × 2 | 128 × 192 | 4 (turning) | Rises 1 tile; flour dust at the eye |
| Gear train | 3 × 2 | 192 × 192 | 4 (turning) | Wooden pit wheel and wallower on the east wall, turning at the outdoor wheel's pace |
| Chute and meal bin | 2 × 2 | 128 × 128 | 1 | |
| Flour sacks | 2 × 2 | 128 × 128 | 2 variants | Tied sacks, one slumped |
| Counting stool and window | 1 × 1 | 64 × 64 | 1 | A three-legged stool; tally scratches on the sill |
| Sack hoist and hatch | 2 × 2 | 128 × 192 | 2 (seized, working) + 3 (rope swing) | Pulley on a beam over a hatch; seized has a frayed, kinked rope |
| Roof beams | 12 × 1 | 768 × 64 | 1 | Foreground overlay across the loft's top; drawn over the player |

### 7.4 The library reading room

| Piece | Footprint | Canvas | Frames | Notes |
|---|---|---|---|---|
| Tall shelf | 2 × 1 | 128 × 192 | 3 (sparse, half, full) | Rises 2 tiles up the back wall; the state shows the village shelf count |
| Reading table with the lamp | 4 × 2 | 256 × 160 | 2 (unlit, lit) + 3 (flame) | Two chairs either side; the lamp's tin note tag visible |
| Donation shelf | 2 × 1 | 128 × 128 | 3 (fill) | A lower shelf with a slot box and a card |
| Window seat | 2 × 1 | 128 × 128 | 1 | Cushion, a book left open |

### 7.5 Outside: smoke and lit windows

| Piece | Canvas | Frames | Notes |
|---|---|---|---|
| Chimney smoke | 64 × 128 | 6 (loop) | Soft grey curls rising and thinning; placed on the bakery's and the mill's chimneys |
| Lit window, west house (bakery) | 64 × 64 | 1 | Warm amber glow fitted to the delivered `house-west` window (index 4, row above the door) |
| Lit window, mill | 64 × 64 | 1 | Fitted to the mill house's window |
| Lit window, library | 64 × 64 | 1 | Fitted to the Hearthwick Library's window; softer, a reading lamp's glow |

Windows are drawn over the existing building art, so each must match its window's exact shape
and position (the atlas notes give each building's window rectangle).

### 7.6 Quest icons and the opening

| Piece | Canvas | Frames | Notes |
|---|---|---|---|
| Shelf icons: road, village, craft | 64 × 64 each | 1 | A lantern on a post; a loaf and a cup; a mallet and a bowl |
| Pin mark | 64 × 64 | 2 (unpinned, pinned) | A brass map pin |
| Gate marks: waiting, needs embers, locked | 64 × 64 each | 1 | An hourglass of sand; a small ember; a padlock with a ledger ribbon |
| Signpost standing plumb, east finger missing | the existing signpost's canvas | 1 | The leaning version exists; this is it stood straight with a gap |
| East finger in the bracken | 128 × 64 | 1 | The painted finger (ASHWATCH, older SALLOW FD under it) half in bracken |
| Keepsake icons: east finger, tally token | 64 × 64 each | 1 | Inventory icons; the token is a punched wheel-tax receipt |

---

## 8. Lanes

**One integration branch,** `exp/indoors`, cut from `expansion` once 0.3 lands, the same way as
0.3: lanes merge into it, each keeps `go test`, `npm run verify` and its unit tests green, runs
only its own changed e2e specs at the end, and the full suite runs once at the integration gate.

| Lane | What | Owns (files) | Depends on | Size | Model |
|---|---|---|---|---|---|
| **A. Contracts and the server** | **A1** (merges first, S–M): the proto changes and error codes, contract 4; `rooms.json`, `residents.json` schemas, both loaders and validators, the three rooms from section 3; the quests schema growth and validators; the clock's cycle helpers with vectors; `story.json` namespaces. **A2** (M–L): the room family in `validArea`, safe areas, home rest, presence rooms, gathering; sellers that follow residents; `quest-step` triggers, gates and grants; `step_since`/`gate_at` in `PlayerState`; player creation starting the opening; migrations 029 and 030 with upgrade tests | `proto/**` and generated code, `content/{rooms,residents,story,clock,contract}.*`, the schema and loaders of `content/quests.*`, `content/items.json` seller and resident rows, `content/vectors/{clock,quests,rooms}.json`, `src/lib/{rooms,residents,clock}.ts`, `server/internal/**`, `migrations/029_*`, `030_*` | 0.3 merged | **L** | Codex |
| **B. Rooms in the game** | The room area kind and builder; doors, doorways and stairs on the interactions path, `ExitDef.side/kind`; the cottage as `in:home:<gate>`; camera and lighting; residents on the cycle (placement, the walk at a change, knock lines, indoor routines); smoke and lit windows; the library door into the room, shelves and table opening the panel; the finger-wisp spot; Pip's walk-on; the server-time offset; wiring the indoors art pack (`atlas-plan.ts`) | `src/game/**` except `entities/goal-guide.ts` and `guide-pin.ts`; `src/lib/presence-client.ts`; room data in `content/rooms.json` after A1 | A1 (fixtures before it merges) | **L** | Opus |
| **C. Quests and the Quests page** | The predictor in `src/lib/quests.ts` (gates, wait times, `needs`); the Quests page, the pin slot, the HUD's goal line from `where`; the goal guide's room graph (from B's `roomParent`); the six quests' data and lines, `when` refs, the lantern road renames in dialogue; the journal glow; rumours; "Needs a connection" and "not yet" lines | `src/ui/**`, `src/App.svelte`, `src/content/**`, `src/lib/quests.ts`, `src/game/entities/goal-guide.ts`, `src/game/guide-pin.ts`, quest data in `content/quests.json` after A1 | A1 | **M–L** | Opus |
| **D. Art** | Section 7 as one request; delivered, checked against footprints, with prompts and notes | `assets/generated/indoors-pass/**`, `docs/art-request-indoors.md` | nothing | **M** | Luna |

**Order:**

1. **D starts at once**: art takes longest and needs no code. B and C use the kit's placeholder
   tiles until it lands.
2. **A1 merges** (a day or two). It fixes the files every other lane reads.
3. **A2, B and C run in parallel.** B and C meet at one seam: B exports `roomParent` and the
   cycle-backed "where is this person" from `src/lib/rooms.ts`/`residents.ts` (A's loaders), and
   C reads them. Neither edits the other's files; a needed change is a small request.
4. **B wires D's pack** when it arrives.
5. **The integration gate**: the full e2e suite, then the owner's playtest (the opening on a
   fresh account; the three room quests; two players in the mill at once; a reload in the loft;
   a visit to a friend's cottage).
6. After the release, the review round (plan.md, "Stepping back between releases").

**e2e.** New specs, run only by their lane until the gate: entering and leaving each room;
stairs; reload inside; two players in one room (presence); a resident moving at a cycle change
(dev clock); the opening end to end; *Set to Rise* across a wait (dev clock); the Quests page and
pin. Keep the opening's spec on a seeded fresh account so it doesn't run the whole game.

---

## 9. Open questions, with defaults

These go ahead as written unless the owner says otherwise.

1. **The cycle's length and shape.** *Default: a 60-minute hour; Hazel 40 in / 20 out, Finn 25
   at the stones, 10 in the loft, 25 at his door, offset 20.* layers.md suggested 40/20; one hour
   reads naturally ("she's in on the hour"), and the offset keeps one of them in most of the time.
   It's content, so tuning after the playtest is a data change.
2. **Doors that latch when nobody's home.** *Default: never latch; knock, hear where they are,
   go in.* Places are places (layers.md), quests never wait on someone being home (quests.md 5),
   and a latched door adds a server rule for nothing.
3. **Who's in the library.** *Default: nobody.* It's self-serve today and Mara's oil note on the
   lamp carries the village's voice. A librarian can come with a later resident.
4. **The `world` and `project` gates.** *Default: deferred to Aldo's kiln and chapter 2.*
   They're cheap but have no 0.4 user, and building a gate with its first quest keeps it right.
5. **Renaming the lantern road's step ids.** *Default: yes, in 030.* The dialogue `when` refs read
   as steps (quests.md 4); nobody but the owner plays, so a clean rename beats a mapping layer.
6. **Mara's 3-ember top-up in the opening.** *Default: a server-computed grant on `see-mara`,
   once.* Guests are gone, but a connected hero can still spend down to nothing before the lamp,
   and the opening must not strand anyone (quests.md 3).
7. **The pin across devices.** *Default: device-local, per account,* as guides are. Moving it to
   the server is one mark later if the owner misses it on the phone.
8. **The room quests' rewards.** *Default: as written (two twists and 2 embers; 3 embers and
   oatcakes; a lit lamp and a net ember back).* Small on purpose: they teach, they don't pay.
9. **Room sizes bigger than their buildings.** *Default: yes.* The kitchen is 14 × 10 behind a
   6 × 4 house. Cozy games do it, and rooms that matched footprints would be a corridor.
10. **Lighting.** *Default: light pools and a vignette, no day/night.* A light cycle is its own
    design (it touches every outdoor map and the art); 0.4 doesn't need it.
11. **Where Finn sells when he's in the loft.** *Default: anywhere he is,* like Hazel. The seller
    row follows him; buying flour from the loft is fine.
