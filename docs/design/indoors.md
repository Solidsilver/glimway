# 0.4 Indoors

Status: **design, ready for lanes**, 2026-10-08. Written from the code at `a0cd842` (0.3 lane A
merged). Rechecked the same day against `exp/server-first` at `a7bbff0`, with all of 0.3's lanes
merged: the quest model (5.1), protos, contract and migration numbers (6). The owner's earlier decisions are in
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

### 2.8 Furnishings: one system for every piece, everywhere (owner, 2026-10-08)

The owner asked for "a clean, universal system that works well everywhere": the shared interior
kit (7.0, rule 8) dresses the village's rooms now, and the same pieces furnish players' own
houses later. Pieces may have animations or states (a pot empty, filled or steaming), and there
are rules for what can go on what (books on almost anything, rugs only on the floor), but states
and rules must never make things feel less natural or less free to arrange.

**One catalogue, `content/furnishings.json`.** Every placeable piece is one entry: today's 31
home goods in `content/homestead.json` (moved, not copied; homestead keeps its tiers, prices and
`where` by referring to furnishing ids) and the interior kit. An entry has:

- `id`, `name`, and its art per **facing** (`front`, `left`, `right`, and `diag` for the 45° pieces
  the style rules allow); a piece lists only the facings it has.
- `footprint` in tiles and a **`base`** box (the part that touches what it stands on; collision
  uses only this, 7.0 rule 4).
- **`mount`**: what the piece stands on. One of `floor`, `wall` or `surface`; `floor` pieces may
  also stand on a rug.
- **`offers`** (optional): the surfaces it provides for other pieces: `top` (a table, a chest, a
  counter, a desk) or `shelves` (rows of a shelf unit), each with a size in small-item slots.
- **`size`**: `small` (a book, a candle, a cup, a plant pot), `medium` (a lamp, a basket, a
  crate), or `large` (furniture). **The rule is one table:** `small` goes on any `top` or `shelves`
  slot or the floor; `medium` goes on a `top` that's big enough, or the floor; `large` only on the
  floor; `wall` pieces only on walls; a rug (`layer: under`) only on the floor, under everything,
  and never blocks. No per-item exceptions: a piece's `size` and `mount` decide.
- **`states`** (optional): named states, each with its frames and an optional slow `loop`
  (`pot`: `empty`, `filled`, `steaming`). One state is the default. A state changes only by
  something that happens (a quest beat, cooking, a resident's routine, later a player's use),
  never by idling. A piece with no states is still. A state never changes where the piece can go.
- `tags` for the game's own uses (`seat`, `light`, `books`, `section:stories`), not for placement
  rules.

**One validator, both languages.** `validateFurnishings` (TS and Go, shared vectors) checks the
catalogue, and `canPlace(piece, onto, at)` answers the placement rule above for any piece onto the
floor, a wall or another piece's surface. Rooms (`content/rooms.json`) place furnishings by id
with a facing, and optionally a parent (the table a candle stands on); the loader checks every
placement with `canPlace`. The cottage keeps its current floor placement in 0.4 but reads its
pieces from the catalogue; standing pieces on other pieces in your own house is the later
decorating release, and it needs no new rules, only the UI and the server's placement operation
calling the same `canPlace`.

**Lanes.** A: the catalogue's schema, loaders and validators, `canPlace` with vectors, moving the
home goods in, and the server reading homestead items through it. B: rendering by facing, state
and parent (stacked pieces drawn on their parent's surface), base-box collision, rooms placed
from the catalogue. Luna: the kit's art per facing and state.

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

**Revised after the owner's first playtest (2026-10-08).** The owner liked the back shelves and
asked for a cozier room with a keeper. This replaces the map, the donation shelf's place and
"nobody keeps the library" above; open question 3 is now answered.

```
##############
#SS=SS=SS=SS=#    S  tall shelves along the back wall, straight on, under the wall's top line
S............S    S  shelves along both side walls too (side-on art): the room is lined with books
S.RRRR.......S    R  the reading table, chairs either side; the lamp sits on it
S.RRRR...EE..S    E  Elara's desk (where she sits while she's in)
S............S
S.........NNN#    N  the reading nook: the window seat set into an alcove in the wall,
S.........NNN#       cushions and a lamp, a plain seat with the bench's seated regen
#.....@......#
######DD######    out to the village at (4, 18)
```

- **Sections.** The shelves carry small painted signs for four sections: *Stories*, *Histories*,
  *Recipes* and *Field notes*. Each section's shelves open `LibraryPanel` filtered to papers of
  that kind (the panel's existing kinds; a section with none opens the whole collection).
- **The donation shelf goes;** donating moves to Elara (below). The floating shelf on the right
  is gone.
- **Elara keeps the library, part of each hour.** She joins `residents.json`: 30 minutes at her
  desk in the library, 30 at her usual spot on the square, offset 10 (so the library is kept
  while Hazel bakes, and someone is in the square most of the hour). Lore: she says she's
  studying the drift; the library is where she does it. Talking to her while she's in opens the
  panel on the whole collection, with **Donate** in her conversation (the panel's donate view).
  While she's out the shelves still work; only donating waits for her, and the door's knock line
  says where she is.
- **Later, not 0.4:** an upstairs reading loft.

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
- The **client** uses `cycleAt` with the server's clock. 0.3's client keeps no server-time offset
  (checked), so lane B adds one to `game/clock.ts`, from the `Date` header or `vitals_at`; the
  90-second grace covers whatever skew is left. The dev clock (`setGameNow`) and the server's
  `-dev-clock` flag (shipped in 0.3, `server/cmd/glimway-server/dev_clock.go`) move both sides
  together for tests.
- **Walking at the change.** The client checks the cycle every second while a resident is on
  screen. At a change it walks them to the door (a straight two-leg path to the door tile) and
  fades them through it; in the room, they fade in at the doorway and walk to their spot. If you
  weren't watching, they're simply where the clock says. The walk is drawing only.
- Today's strolls (`npc-routines.ts`) keep playing at the outdoor spots; they stop being Hazel's
  whole day.

---

## 5. The quest tree

### 5.1 What 0.3 shipped, and what 0.4 adds

Checked against `exp/server-first` at `a7bbff0`, with all of 0.3's lanes merged.

**What 0.3 shipped.**

- `content/quests.json` holds one quest, `lantern-road`, with five steps: `accepted`,
  `clue-found`, `guardian-defeated`, `lantern-lit`, `complete`. A step has only `id`, `at` (an
  area), `items`, `marks`, `papers`, `embers` and `witness`. None of quests.md's `goal`,
  `objective`, `where`, `do` or `note` fields exist yet; the words and the needle still come from
  TypeScript (`QUEST_STEPS`, the goal guide's `GOALS`, `advanceQuest` in `src/lib/state.ts`).
- **A step is the state you reach.** quests.md's model is different. `quest-step {quest, to}`
  (`server/internal/api/story_ops.go`) checks that `to` is the step after the one in your record,
  or the first step if you have no row. It checks that `where.area` equals `to.at` exactly. Then
  it writes `to` as your record and pays **`to`'s** items, marks, papers and embers once (outcome
  `quest-gift:<quest>:<to>`). So the record says how far you've got, not what to do next. A quest
  is done when the record holds its last step. There's no `done` value; "no row" means not
  started.
- **Everything assumes one quest.**
  - The handler refuses any quest but `lantern-road` and reads `QuestRules[0]`.
  - `content.QuestIndex` searches only that quest.
  - The snapshot holds one `State.Quest` string, which `store/state.go` loads and saves as the
    single `lantern-road` row.
  - Both loaders (`content/story.go`, `src/lib/story-tables.ts`) only accept `at` values from the
    four outdoor areas.
  - The client's `link.questStep(event)` sends `quest: LANTERN_ROAD` with a stage from its
    `QUEST_STEP` table.
- `content/papers.json` find rules name lantern-road steps by id (`"stage": "clue-found"`,
  `"complete"`, and others).

**0.4 keeps 0.3's model.** It doesn't switch to quests.md's "current step" record. A step entry
is **what you do to get there**:

- quests.md's `goal`, `objective`, `where` and `do` on an entry describe the way *to* it. They
  show on the HUD and the Quests page while the step before it is your record.
- `at`, the grants and the new `gate` are checked and paid on arrival.
- Starting a quest is reaching its first step.

This is the smallest change to working code, and the existing step ids already read well this
way ("guardian-defeated" is where you've got to).

| quests.md said | 0.4 does |
|---|---|
| The record holds the current step, or `done` | The record holds the last step **reached**, as 0.3 does. Done is "the record is the last step" |
| `start` (a trigger) puts the quest in your record | The first step's `do` *is* the start: reaching it starts the quest. `start: { "new": true }` stays, meaning the quest is listed with its first step's goal before you have a row (the opening) |
| Gates, triggers and grants belong to the step being left | They belong to the step being **reached** (`to`) |
| `grants: { embers, items, papers, give, unlock }` | 0.3's flat fields stay (`items`, `marks`, `papers`, `embers`). 0.4 adds a flat **`give`** for server items. Unlocks are server marks in `marks` (no separate `unlock`) |
| Plain steps are client-written, gated steps are "server steps" | Every step is a `quest-step`. A `gate` adds checks to that same operation |
| `gate.at: "orrin"` | Renamed **`gate.with`**, because 0.3's step already has an area `at`. "You're with Orrin now": your `where.area` is one of his spots near now (section 4) |
| A step always has a place | `at` stays an exact area or room, **or is empty** when the person moves (`with` does the check) or the trigger can happen anywhere (`carry`, `open`, `sync`, `flag`) |
| `needs: "world"` | Dropped. Everyone plays on a server since 0.3 |
| `world`, `project` gates | Deferred to their first user (section 1) |
| Ember grants at most 5 on plain steps | At most 5 on any step, as a loader check, so quests don't become an ember tap |

**What has to generalise from one quest to many** (lane A2 on the server, lane C on the client):

- `State.Quest` becomes a map, and the store loads and saves every `quest_progress` row.
- The handler and `QuestIndex` look up the quest by id.
- The loaders accept rooms and an empty `at`.
- `link.questStep` takes `(quest, to)`.
- `QuestStage`/`advanceQuest` give way to a table-driven predictor in `src/lib/quests.ts`.
- `forStages` becomes `when: ["lantern-road:clue-found"]`.

**No step renames.** The lantern road keeps `accepted` … `complete`. The renames in quests.md 4
came from its "current step" model, where `accepted` meant "now copy the stone". In 0.3's model
the old names already say where you've got to. Renaming would also touch `papers.json` find
rules, the gift outcomes 028 just wrote and about 130 references in `src/`, for no gain. New
quests name their steps for what you did (`set-sponge`, `grease-hoist`).

### 5.2 What the server checks per trigger

The client still decides when a trigger fired (it saw the talk end) and sends `quest-step` to
the step whose `do` it was. 0.3 checks only `at`; 0.4 adds what the server can know:

| Trigger | Server check |
|---|---|
| `talk: <npc>` | `where.area` is where that person is: a quest NPC's fixed area (the step's `at`), or a resident's spots near now (an empty `at` and a `with` gate) |
| `use: <spot>` | `where.area` is the spot's area (rooms and curated spots share one id space) |
| `reach: <area>` | `where.area` is that area |
| `defeat: <enemy>` | The `defeated:<enemy>` mark exists |
| `carry: <item>` | The item is held: a server item row, or a `quest-item` mark |
| `flag: <mark>` | The mark exists (a server mark like `lit:road-1`, or a client one) |
| `open: journal` | Nothing to check |
| `sync: embers` | A ledger credit with reason `sync` exists after the record's `reached_at` (when the previous step was reached) |

Refusals use 0.3's codes (`not-next-step`, `wrong-area`) plus the new ones in section 6.

### 5.3 Gates

All keys must hold; the operation checks them in one transaction, in this order, then spends:

| Gate | Holds when | Spends | Refusal |
|---|---|---|---|
| `with: "<resident or npc>"` | `where.area` is one of their spots near now | No | `not-here` |
| `wait: { "hours": n }` or `{ "turnings": n }` | That long since this quest last reached a gated step (or its first step, if none was gated) | No | `not-yet` |
| `item: { "def", "qty", "keep" }` | You hold them; `keep: false` takes them through the items code | Optional | `short` |
| `embers: n` | Your balance covers it; debited with reason `quest`, ref `<quest>:<step>` | Yes | `short` / `needs-earned` as spends today |

- **Waits count from the last gated step reached**, or from the quest's first step when none
  before it had a gate, so every wait has a moment to count from (`gate_at`, section 6). `turnings` counts wicks
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
- **A quest card**: title, blurb on first open, the `goal` and `objective` of the next step (the
  one you're heading for), steps reached ticked, future steps as `· · ·` (no spoilers). A wait shows when it opens. Done quests
  fold to one line at the bottom of their shelf.
- **Notes**: the step `note`s you've written, newest first, opening in the existing note view.
- **Pin** on every open quest card. Opening the journal while the opening's next step is
  `note-lean` lands on this page with that quest at the top (quests.md 3).
- Keyboard: J opens the journal on Quests; the tab keys work as today.

### 5.5 Pinning

- **One pin slot** per account and device in localStorage (0.3's C1 keys `guide-pin.ts` by
  account). It holds `quest:<id>` or `guide:<id>`. Pinning one unpins the other.
- **The HUD** (`Hud.svelte`): the goal line, the needle and the edge glint follow the pinned
  quest's next step `where`. With nothing pinned, they follow the road's current quest, as they
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
| **The Lantern Road** | road, ch. 1 | after the opening, talking to Mara | (existing) | 0.3, ids unchanged; gains `goal`, `objective`, `where`, `do`, `note`, `moment` from TypeScript |
| **Three Fingers off Plumb** | road, ch. 0 | every new save | the opening, `open: journal`, the finger-wisp | quests.md 3, unchanged |
| **Your Own Day** | village | after `signpost:see-mara`, talking to Mara | `sync`, `needs: habitica` | quests.md 3, unchanged |
| **Set to Rise** | village | after the opening, talking to Hazel | `item`, `with`, `wait` | new |
| **The Stuck Hoist** | village | after the opening, talking to Finn | stairs, `use` in a loft, `item` | new |
| **A Seat by the Lamp** | village | after the opening, walking into the library | `embers` | new |

**The quests.md examples move to 0.3's model** by shifting each step's `goal`/`where`/`do` onto
the step it leads to. For the opening that's mechanical: its step ids already name what you did
(`meet-orrin`, `fetch-finger`, … `light-first-lamp`), and `meet-orrin` (talking to Orrin) is
both its first step and its start. *Your Own Day* becomes `do-something` (`sync`) then
`show-mara`, its first step being Mara's talk that opens it (`hear-mara`).

**Set to Rise** (Hazel's kitchen). Hazel's sponge wants flour and a couple of hours.

```json
{
  "id": "set-to-rise", "title": "Set to Rise", "line": "village",
  "blurb": "Hazel's starter wants feeding, and Finn has the flour.",
  "after": ["signpost"],
  "steps": [
    { "id": "hear-hazel", "at": "", "do": { "talk": "hazel" }, "gate": { "with": "hazel" },
      "items": [], "marks": [], "papers": [], "embers": 0, "witness": "" },
    { "id": "fetch-flour", "goal": "Bring Hazel a sack of flour",
      "objective": "Hazel's out of the fine sift. Finn sells it at the mill, a sack an ember.",
      "where": { "npc": "finn" }, "at": "", "do": { "carry": "flour" },
      "items": [], "marks": [], "papers": [], "embers": 0, "witness": "" },
    { "id": "set-sponge", "goal": "Help Hazel set the sponge",
      "objective": "Take the flour to Hazel in her kitchen and set the sponge with her.",
      "where": { "npc": "hazel" }, "at": "", "do": { "talk": "hazel" },
      "gate": { "with": "hazel", "item": { "def": "flour", "qty": 1, "keep": false } },
      "items": [], "marks": [], "papers": [], "embers": 0, "witness": "" },
    { "id": "let-it-rise", "goal": "Come back when it has risen",
      "objective": "A sponge won't be hurried. Come back to Hazel's kitchen in a couple of hours.",
      "where": { "area": "in:village:bakery", "spot": "sponge-bowl" }, "at": "", "do": { "talk": "hazel" },
      "gate": { "with": "hazel", "wait": { "hours": 2 } },
      "items": [], "marks": [], "papers": [], "embers": 2, "witness": "",
      "give": [{ "def": "keepers-twists", "qty": 2 }],
      "note": { "title": "Set to Rise",
        "body": "Hazel says you can't hurry a sponge, only leave it somewhere warm and trust it. Two twists for my trouble, still hot. She burnt the ends of one on purpose." } }
  ]
}
```

Hazel, starting it: *"I've a sponge that wants feeding and not a pinch of fine sift in the
house. Finn's got it. Finn always has it, he just has to stop counting long enough to sell it."*
Coming back too early, she says the predicted time in her own words: *"Not yet. Look at it. It's
thinking. Give it another hour."*

The wait on `let-it-rise` counts from reaching `set-sponge`, the last gated step. `at` is empty
throughout because Hazel moves; the `with` gate checks she's where you are.

In the two tables below, each row is a step you reach, by doing its **Do**. The first row
starts the quest.

**The Stuck Hoist** (the mill and the loft). Finn can't get sacks down; the hoist in the loft
has seized.

| Step | Do | `at` | Gate | Grants |
|---|---|---|---|---|
| `hear-finn` | `talk: finn` | — | `with: finn` | |
| `look-hoist` | `use: mill-hoist` | `in:village:mill:2` | | |
| `get-tallow` | `carry: tallow` (Hazel sells it) | — | | |
| `grease-hoist` | `use: mill-hoist` | `in:village:mill:2` | `item: tallow ×1, keep: false` | embers 3 |
| `tell-finn` | `talk: finn` | — | `with: finn` | `give: oatcakes ×1`, note *"Forty turns and a squeak"* |

Finn, starting it: *"The hoist's seized. I've sacks up there and none down here, and Hazel needs
flour, and Mara needs flour, and I'm counting the wrong thing again. Would you look? Stairs are
at the back. Mind the third one."* It walks you up your first stairs and back and forth between
the two rooms, without saying so.

**A Seat by the Lamp** (the library). The reading lamp's oil comes from the village stores, so
Mara wants an ember for it. A note on the lamp in her hand: *"One ember the oil. Ledger. — M.H."*

| Step | Do | `at` | Gate | Grants |
|---|---|---|---|---|
| `find-library` | `reach: in:village:library` | `in:village:library` | | |
| `browse-shelf` | `use: library-shelf` | `in:village:library` | | |
| `oil-lamp` | `use: reading-lamp` | `in:village:library` | `embers: 1` | mark `library:lamp` |
| `read-awhile` | `use: reading-table` | `in:village:library` | | embers 2, note *"A Seat by the Lamp"* |

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

- **New accounts start with it.** `start: { "new": true }` lists it, with `meet-orrin`'s goal on
  the HUD, before the account has a row. Player creation writes nothing. Existing accounts get it
  as done (migration 029), so the owner isn't sent back to Orrin.
- **The finger-wisp**: a curated `EnemySpot` near Brackenwood's west entry, low health,
  telegraphed hops, Slash alone enough (Fingersnap leaves classless heroes in 0.5).
- **The journal glow**: the HUD's book button gets the edge glint's glow while the next step's
  `where` is `{ "ui": "journal" }`.
- **Pip's walk-on** on reaching `set-post`. 0.3 deletes `nudges.ts` with local play, so the walk-on is
  a small scripted beat of its own in the village scene.
- **Mara's top-up**: a hero who reaches the first lamp with fewer than 3 embers gets topped back
  up once, as a grant on reaching `see-mara`, computed by the server (`embers: 5`, plus up to 3 more while
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
  map<string, double> reached_at = 7;   // when the record's step was reached
  map<string, double> gate_at = 8;      // when this quest last reached a gated step (or its first)
}

// operations.proto: QuestStepResult says what the gates took and the grants gave.
message ItemQty { string def = 1; double qty = 2; }
message QuestStepResult {
  // … 0.3's fields 1–6 …
  double embers_spent = 7;
  repeated ItemQty taken = 8;
  repeated ItemQty given = 9;       // `give`; unlocks come back in 0.3's `marks`
}
```

**Checked against 0.3's final protos** (`exp/server-first` at `a7bbff0`). `proto/` hasn't changed
since lane A:

- `Story` ends at `play_seconds = 6`, so 7 and 8 are free.
- `QuestStepResult` ends at `embers = 6`, so 7–9 are free.
- No message is called `ItemQty` yet.
- The last error code is `ERROR_CODE_REPORT_REQUIRED = 207`.

- **New error codes**, appended as 208–210: `not-yet` (a `wait` gate), `not-here` (a `with` gate, or a
  resident elsewhere), `needs-habitica` (a `needs` the profile source fails). Embers and items
  reuse `short` and `needs-earned`.
- **The contract number** goes from 3 to 4 (`content/contract.json` is `3` on `exp/server-first`),
  so 0.3 tabs get the reload notice.
- **Presence:** no message change. Room ids are areas.
- **Rooms and residents** aren't served: both sides embed the same `content/` files.

### 6.2 Content files

| File | Change | Owner |
|---|---|---|
| `content/rooms.json` (+ `rooms.go`, `src/lib/rooms.ts`) | New | A (schema), B (room data) |
| `content/residents.json` (+ loaders) | New; takes `items.json`'s `rules.residents` | A |
| `content/items.json` | Seller rows gain `with`; `rules.residents` removed | A |
| `content/quests.json` | The six quests; the new fields (`title`, `blurb`, `line`, `chapter`, `after`, `start`, `needs`; per step `goal`, `objective`, `where`, `do`, `gate`, `give`, `note`, `moment`) beside 0.3's | A (schema, both loaders, validators), C (quest data) |
| `content/story.json` | A `library:` server namespace | A |
| `content/clock.*`, `src/lib/clock.ts`, `content/vectors/clock.json` | `cycleAt`, `cycleSpotsNear`, vectors | A |
| `content/vectors/quests.json`, `rooms.json` | Loader vectors both sides run | A |

The quest loaders (`content/story.go`, `src/lib/story-tables.ts`) keep 0.3's checks and add
quests.md's:

- `at` is a known area or room, or empty only with a `with` gate or an anywhere trigger;
- `with` names a quest NPC or resident;
- no `world`/`project` gate yet;
- ember grants are at most 5;
- `give` items exist in `items.json`;
- `where.spot` and `use` name a known spot;
- `after` refs exist and nothing cycles.

### 6.3 Migrations (after 0.3's 028)

0.3 used 026–028 (`exp/server-first` has `028_story_move.sql` and its Go backfill), so 0.4 starts
at **029**. It needs only one:

| # | Name | Lane | What |
|---|---|---|---|
| **029** | `quest_tree` | A | `quest_progress` gains `reached_at INTEGER NOT NULL DEFAULT 0` (when the record's step was reached) and `gate_at INTEGER NOT NULL DEFAULT 0` (when this quest last reached a gated step, or its first step). Existing rows get both set to the migration time. For every account with a `lantern-road` row, insert `('signpost', 'light-first-lamp')`, so the opening counts as done. Accounts with no row get nothing: they see the opening from its `start: new` |

No history table: a wait only ever counts from the last gate. No step or gift-outcome renames
(5.1): 028's `quest-gift:lantern-road:guardian-defeated` and `…:complete` stay as they are. The
opening's 5-ember gift isn't paid to accounts that get it as done.

Upgrade tests use 0.3's fixture pattern (`story_upgrade_test.go`):

- the owner's story at each lantern-road stage;
- an account with no row;
- a home rest after the cottage move;
- ledger sums unchanged.

No place migration: 0.3 never saved `cottage`, and the new rooms have no saved places yet.

---

## 7. Art list

### 7.0 Interior style rules (from the owner's first playtest, 2026-10-08)

The owner's verdict on the first pass: the rooms felt out of place and not lived-in, the mill
most of all. These rules hold for every room and every later interior.

1. **Proper perspective.** Every piece faces one of four ways: straight on (front), side-on
   (left or right wall), or exactly 45°. No in-between "cockeyed" three-quarter angles. Pieces
   against the back wall are front-on, pieces against a side wall are side-on, and a free-standing
   piece is front-on unless it reads better at 45°.
2. **Scale to the people.** Size each piece against the residents and the hero: a flour sack is
   knee-to-waist high, a millstone about chest high, a door a head taller than a person. Match
   the residents' pixel density and shading, not finer: props shouldn't look painted at a
   different resolution from the people standing next to them.
3. **Lived-in.** Each room gets a dressing layer of small, non-blocking things: a rug, things on
   the walls (tools, shelves, pegs, a calendar, a picture), crates and barrels in corners, a
   plant, a lamp or candles, signs of the owner's trade and life (Finn's cap on a peg, Hazel's
   flour handprints, Elara's charts). Corners and walls are full; the floor's walking space stays
   clear.
4. **Collision is the base, not the box.** A piece blocks only where it touches the floor (its
   base or feet), never its whole picture rectangle. Tall pieces overlap the player from behind
   by draw order. Dressing never blocks.
5. **Stairs belong to a wall.** Stairs run along a wall (up the side or back wall), and the floor
   above has its opening directly over them, with a railing. A ladder is fine where stairs would
   crowd a small room.
6. **No baked backgrounds, no stretching.** True transparency; art is placed at its native
   aspect, never scaled to a footprint.
8. **One shared interior kit.** Dressing comes from one kit of generic pieces that fit any
   building: rugs, shelves, wall pegs and tools, crates, barrels, sacks, baskets, plants, lamps and
   candles, pictures and calendars, curtains, small tables, chairs and stools, a chest. Each room
   is that kit plus a few signature pieces (Hazel's oven, Finn's millstone, Elara's desk). Every kit
   piece gets an id, a footprint, a base box and a facing like the home goods in
   `content/homestead.json`, so that **later** players can place the same pieces in their own
   cottage: turning a kit piece into a home good (bought, crafted or found) is a data change, not
   new art. In 0.4 the kit only dresses the village's rooms.
7. **Still by default.** Props don't idle-animate. Only something the current quest or plot points
   at may move or glow (the quest marker says so already); working machines (the millstone, the
   oven's fire) may have a slow loop.


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
| **A. Contracts and the server** | **A1** (merges first, S–M): the proto changes and error codes, contract 4; `rooms.json`, `residents.json` schemas, both loaders and validators, the three rooms from section 3; the quests schema growth and validators; the clock's cycle helpers with vectors; `story.json` namespaces. **A2** (M–L): the room family in `validArea`, safe areas, home rest, presence rooms, gathering; sellers that follow residents; `quest-step` triggers, gates and grants; `reached_at`/`gate_at` in `PlayerState`; quests by id instead of the one `State.Quest` (snapshot, store, handler, `QuestIndex`); migration 029 with upgrade tests | `proto/**` and generated code, `content/{rooms,residents,story,clock,contract}.*`, the schema and loaders of `content/quests.*`, `content/items.json` seller and resident rows, `content/vectors/{clock,quests,rooms}.json`, `src/lib/{rooms,residents,clock}.ts`, `server/internal/**`, `migrations/029_*` | 0.3 merged | **L** | Codex |
| **B. Rooms in the game** | The room area kind and builder; doors, doorways and stairs on the interactions path, `ExitDef.side/kind`; the cottage as `in:home:<gate>`; camera and lighting; residents on the cycle (placement, the walk at a change, knock lines, indoor routines); smoke and lit windows; the library door into the room, shelves and table opening the panel; the finger-wisp spot; Pip's walk-on; the server-time offset; wiring the indoors art pack (`atlas-plan.ts`) | `src/game/**` except `entities/goal-guide.ts`, `guide-pin.ts` and the quest calls in `link.ts`/`session.ts`; `src/lib/presence-client.ts`; room data in `content/rooms.json` after A1 | A1 (fixtures before it merges) | **L** | Opus |
| **C. Quests and the Quests page** | The predictor in `src/lib/quests.ts` (gates, wait times, `needs`); the Quests page, the pin slot, the HUD's goal line from `where`; the goal guide's room graph (from B's `roomParent`); the six quests' data and lines; `when: ["quest:step"]` refs replacing `forStages` and `QuestStage`; `link.questStep(quest, to)` and offline only for steps with no gate; the journal glow; rumours; "Needs a connection" and "not yet" lines | `src/ui/**`, `src/App.svelte`, `src/content/**`, `src/lib/quests.ts`, `src/game/entities/goal-guide.ts`, `src/game/guide-pin.ts`, the quest calls in `src/game/{link,session}.ts`, quest data in `content/quests.json` after A1 | A1 | **L** | Opus |
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

These go ahead as written unless the owner says otherwise. **Confirmed by the owner on
2026-10-08:** 1 (the 60-minute hour), 8 (small rewards), 9 (rooms bigger inside) and 10 (light
pools, no day/night).

1. **The cycle's length and shape.** *Default: a 60-minute hour; Hazel 40 in / 20 out, Finn 25
   at the stones, 10 in the loft, 25 at his door, offset 20.* layers.md suggested 40/20; one hour
   reads naturally ("she's in on the hour"), and the offset keeps one of them in most of the time.
   It's content, so tuning after the playtest is a data change.
2. **Doors that latch when nobody's home.** *Default: never latch; knock, hear where they are,
   go in.* Places are places (layers.md), quests never wait on someone being home (quests.md 5),
   and a latched door adds a server rule for nothing.
3. **Who's in the library.** *Answered 2026-10-08: Elara, part of each hour (section 3.3, revised).* Was: *nobody.* It's self-serve today and Mara's oil note on the
   lamp carries the village's voice. A librarian can come with a later resident.
4. **The `world` and `project` gates.** *Default: deferred to Aldo's kiln and chapter 2.*
   They're cheap but have no 0.4 user, and building a gate with its first quest keeps it right.
5. **Renaming the lantern road's step ids.** *Default: no* (changed 2026-10-08, after checking
   0.3). In 0.3's shipped model a step id is where you've got to, and `guardian-defeated` already
   reads that way. A rename would touch `papers.json`, 028's gift outcomes and about 130
   references in `src/` for nothing. New quests name steps for what you did.
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
