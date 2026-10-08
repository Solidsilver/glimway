# Layers: interiors, floors, tunnels and caves

Status: designed with the owner, 2026-10-07. Direction A for interiors and
floors, plus generated caves on the server's open map (`docs/design/world.md`).
Ready for a brief: steps 1–3 of the build order need nothing from other
designs.
Source: `docs/ideas.md` ("Layers, interiors and multi-storey buildings",
"Tunnels and caves").

## The heart of it

A place can have places inside it. Step through a door, down a ladder or
into a cave mouth, and you're somewhere new that still belongs to where you
came from. Houses get insides, so residents can live and trade indoors. The
ground gets an underside, so there's somewhere to spelunk. Stack the two and
you get upstairs.

## Where today's code stands

- **One scene, rebuilt per area.** `WorldScene` restarts with a new
  `WorldData` for every area change (`transitionTo`, `enterRoom`). An area is
  an open string id (`village`, `commons`, `home:<gate>`,
  `chunk:<region>:<cx>:<cy>`) resolved through `AREA_KINDS` /
  `registerAreaKind` in `src/game/worlds.ts`. Exits are tile rects on the map
  edge; `label: null` already gives a doorway with no sign.
- **One interior already exists, as a view.** The cottage room
  (`src/game/cottage.ts`, `areaId: 'cottage'`, 14×14 tiles) is drawn as its
  own map, but the save says you're at your doorstep on `home:<gate>`.
  Reloading puts you outside, presence shows you standing at the door, and
  nobody else is drawn inside.
- **Placed furniture already has a layer key:** `scene: 'indoor' | 'outdoor' |
  'gate'` on homestead placements.
- **Saves, presence and the server all whitelist area ids.** Valid save areas
  are village, woodland, ruin, commons, wilds and `home:N` (`state.ts`,
  `rules.go`). Presence rooms are (world, area) and `validPresenceRoom`
  refuses anything else. Sync, rest, gathering caps, pickups, repairs,
  sellers and menders all check area ids by name.
- **No depth anywhere.** No elevation, z, stairs, caves or underground. Village
  houses are solid footprints. Shops are outdoor proximity spots.
- **Bosses:** only the Stone Warden, and it's settled by speaking a naming,
  not beaten down.

## Directions on the table

### A. Rooms are places (generalise the cottage room)

Every interior, floor and cave is its own small area with a **parent**: an id
like `in:village:mill` or `in:village:mill:2`, entered by a door or stair
exit and left back to the parent at a fixed spot. The cottage room becomes the
first of these instead of a view.

- Fits today's one-scene rebuild exactly; a floor is just another room whose
  exit is a stair.
- Needs one new id family taught to saves, presence rooms and the server's
  area checks (mostly "treat `in:<parent>:…` like its parent" for safety,
  sync and gathering).
- Art: an interior kit (floors, walls, doorways, stairs, windows, counters)
  plus per-building furniture. Each interior is hand-authored.
- Cost: small to medium. The plumbing is a few days; the cost grows with how
  many buildings get insides.

### B. Under the Wilds (generated caves)

A layer beneath the Wilds: some chunks have a cave mouth into an
under-chunk (`under:<region>:<cx>:<cy>`), generated from the same epoch seed,
with tunnels between them and a chamber at the deep end.

- Repeatable spelunking that turns with the outer Wilds each wick.
- Lore fits well: amber is "the woods' own memory, congealed" and the
  Sapping Grounds are amber country, so seams of amber underground are
  natural. Dark matters: your lantern's light is the map.
- Needs a cave generator, Go parity for its entities and loot, and new enemy
  kinds. Medium to large.

### C. Stacked layers on one map (roofs lift off)

Buildings stay on the outdoor map; walking in fades the roof and you see the
inside in place. Floors would be z-levels on the same map.

- Most seamless and charming for small buildings, and you still see people
  passing outside.
- Every map needs per-layer collision and drawing, presence needs a z, and
  each building's art needs a cut-away. Large refactor of `WorldData`.
- Could come later as a cosmetic touch for one-room buildings only.

### Chosen so far (owner, 2026-10-07)

- **Direction A for houses and the basics.** Interiors and floors are rooms
  with a parent.
- **Interiors are real places.** You can save inside one, it has its own
  presence room, and it inherits its parent's rules (safe area, sync, rest).
- **Generated caves as well**, made on the server (below).
- **Boss rooms are hand-made**, set into generated caves.
- **First interiors:** Hazel's kitchen, Finn's mill and the library. The first
  two already trade at their doors, so their residents and shops move inside.

## Generating on the server

Proposal from the owner: the server generates the Wilds and caves; the client
only explores and renders.

- **Why:** one copy of the rules (no TypeScript generator mirrored in Go with
  parity vectors), and the server knows the real map, so it can check that
  loot is reachable and later that gathering happened on a real tile.
  Generation itself is cheap today. Phone cost is painting and props, which
  stay on the client either way.
- **Generate once, store, serve.** When a chunk is first needed, the server
  generates it and stores the layout for its epoch. Stored layout replaces the
  "client keeps every generator version" rule.
- **The line:** anything a rule touches comes from the server (walls, floor
  kinds, entrances, nodes, chests, enemies, loot). Anything only the eye sees
  stays on the client (painted edges, tile variants, scatter), still seeded so
  everyone sees the same thing.
- **Guests:** play generated places through the server like everyone else
  (see "Guests on the server"). No baked snapshot.
- **Offline (connected):** fetched chunks are kept on the device.
- **The Tangle may change** (owner, 2026-10-07): it regenerates once when
  server generation ships, so it's a rewrite in Go, not an exact port.
- **One worldgen for everything:** the open map and its caves share one
  server-side generator, designed in `docs/design/world.md` ("The open map"):
  continuous noise fields plus structure cells, per-chunk epochs, a frontier
  about 3 chunks past the nearest lit lamp. Lit chunks keep their layout and
  entity ids when a wick turns.
- **Cost:** the generator is world.md's to cost. For layers, the cave pass
  (tunnels, chamber and vault placement, naming pieces) is the addition.

## Coordinates: generated layers and hand-made rooms

- **Generated places** are chunks of one open map per world, keyed
  `(world, realm, layer, cx, cy)`: surface `0`, underground `-1`. The fixed 3×3
  regions are gone; the Tangle and the Whitequiet become the map's first rings
  (`docs/design/world.md`, direction D, "The open map", locked by the owner
  2026-10-07). Epochs are per chunk.
- **Hand-made rooms** (interiors, floors, boss chambers placed by hand) keep
  direction A's parent ids, e.g. `in:village:mill`, `in:village:mill:2`.
- **Realms** (owner's later idea of other dimensions) are the `realm` in the
  key: another dimension is its own map, reached through a link. Nothing here
  needs to change for it.

## Caves: generated tunnels, hand-made rooms

- **Mouths:** cave mouths are structures placed by world.md's cell pass (a
  cliff foot, a river bank, a sinkhole) and link to layer `-1` below.
- **Footprint:** a cave is a few chunks at layer `-1` (one to four to start),
  starting under its mouth. The cell pass reserves that footprint so two caves
  never claim the same chunk underground.
- **Layout:** tunnels laid out from the epoch seed, a hand-made boss chamber at
  the deep end, a few hand-made vaults along the way. Loot rolls from tables on
  the server. Every cave differs; the big moments are authored.
- **Epoch:** the whole cave follows the epoch of the surface chunk its mouth is
  in. If that chunk is in lamplight, the cave keeps its layout when the wick
  turns.
- **Frontier:** a mouth exists only where the surface is generated, so caves
  sit inside the frontier (about 3 chunks past the nearest lit lamp). A cave's
  footprint may run under land past the frontier; it's part of the cave, not
  of the surface.
- **Way back:** the mouth you came in by is always the way out. A lamp named
  inside a cave can join the old ways later.

## Cave bosses: beaten, settled, or both

Not decided. The options:

| | Beaten | Settled with a naming | Fought open, then named |
|---|---|---|---|
| Fits the canon | Weakest: the one big encounter today (the Warden) is settled, not slain | Best: the Warden pattern, lamps and namings | Good: the Warden already "stands open after a lunge" |
| Each class | Warriors and rogues shine; mages and healers support | Mostly reading and exploring; fighters get little | Everyone: fight to open it, find and speak the naming |
| Weekly repeats | Fine: fights repeat well | Weak: the same naming each week becomes rote unless namings are generated from pieces found in the cave | Good, if the naming pieces are found in the cave |
| Build cost | Boss behaviour and art per boss; co-op fighting in a shared room isn't built | Lowest: naming text and a lock-and-latch moment | Highest: both, though it reuses the Warden's code |
| Habitica | Closest to Habitica's boss quests, so keep it clearly not a copy | Clearly Glimway's own | Clearly Glimway's own |

**Chosen (owner, 2026-10-07): fought open, then named.** The pieces of the
naming are found along the tunnels, so exploring the cave is how you finish
it. Each epoch's cave generates its own naming, so it never goes rote.

### Fighting together

Today every fight is local: two players at the same Tangle camp each fight
their own copy, and presence only carries `pos` and `emote`. The expansion
design's sketch for co-op (the first player in a room owns its enemies and
streams them) was never built.

**All enemies are shared** (owner, 2026-10-07): small cave enemies too, not
only bosses.

Ways to run shared enemies:

| | One player's game runs them | The server runs them |
|---|---|---|
| How | The first player in a room simulates its enemies and streams their state at 8 Hz; others send hits to that player; when they leave, the next player takes over from the last state | A sim loop per active room on the server, using the stored map it now has |
| For | Reuses today's enemy code; solo and guests unchanged (you're always your own host); cheap on the server | Nobody's leaving hands anything over; harder to cheat |
| Against | Hand-over and lag need care; a modified client could cheat (accepted under the trust model) | Enemy behaviour rewritten in Go and kept in step with the client for guests; server CPU per room |
| Cost | Medium to large | Large |

**Chosen (owner, 2026-10-07): the server runs them.** It fits generating on
the server: the server holds the map, so it can move enemies against real
walls.

- **Only while someone's there.** A room's sim starts when the first player
  joins and stops when the last leaves. Nothing ticks in an empty room: camp
  and boss state between visits is worked out lazily from elapsed time, as
  respawn timers are today.
- **Where:** generated places (the open map and its caves). Curated story fights (the woodland's fixed enemies, the Warden) stay
  on the client, since they're single-player story beats and guests play them.
- **A room is a chunk** (world.md). Camp enemies are leashed and never cross a
  chunk edge. In a cave, each cave chunk is its own room, and the boss chamber
  sits whole inside one chunk.
- **The loop:** about 10 steps a second per active room; enemy position,
  facing, state and health go out over presence at 8 Hz, batched within the
  1024-byte message limit. Clients draw enemies smoothed, slightly behind.
- **Hits on enemies:** the client sends what it did (swing, bolt, cleave,
  dash) and where; the server checks range and cooldown against its own
  enemy positions and applies the damage. The client shows the hit flash at
  once and the server's result a moment later.
- **Hurt on you:** judged on your own screen against the enemies you see, as
  today. Health and mana are game-local vitals, and dodging must feel fair at
  8 Hz.
- **Combat numbers:** the server derives each player's kit (from class, level,
  gear, as `src/lib/combat.ts` does) from the reported profile it already
  records. A small port to Go.
- **Bosses** run the same way, with their scripted pattern (moves, lunges,
  standing open) played by the server.
- **Naming pieces are shared in the room.** A piece one player finds counts for
  everyone in the cave. Anyone can speak the naming once all are found;
  everyone present settles it together (like witnessing).
- **Rewards stay personal.** Everyone in the room when a camp falls or a boss
  settles may claim it once. The server now knows the fight really happened,
  which closes the "a claim doesn't prove a fight" gap in the trust model.
- **Alone it's the same fight.** Boss guard and camp size scale with how many
  are in the room when the fight starts.
- **Curated story fights stay on the client** (owner, 2026-10-07): the
  woodland's enemies and the Warden.
- **Guests get a server** (owner, 2026-10-07), so there's one enemy sim and one
  generator, both in Go, and no client copy to keep alike. It also opens the
  way to a version of the game without Habitica. See "Guests on the server"
  below; it reaches well past this design.
- **Order:** ship server-run enemies at Tangle camps first, before caves exist.

Cost: large. The new pieces are the Go room sim and enemy behaviour (wisp,
beetle, then bosses), new presence messages (enemy state, action), the kit
port, and the client switching between server enemies and its local sim.

## Guests on the server

Owner decision, 2026-10-07. It changes a founding principle: today a guest has
"no account, no server, no network requests" (README), and the expansion
design's principles say "Guest play keeps working... needs no account and no
server". This is a platform change of its own and probably wants its own brief;
this section only lists what layers needs from it and what it touches.

What layers needs: generated places (the Wilds, caves) and shared enemies
exist only on a server, so a guest who wants them needs a server identity.

**Agreed (owner, 2026-10-07):** guests need an invite like everyone else; a
guest is an account without Habitica. The rest gets its own planning session,
outside this design.

What it touches:

- **Admission.** Worlds are invite-only (allowlist or codes), and "open public
  servers" is a non-goal. Either a guest still needs an invite (a guest is
  just an account without Habitica), or a server offers open guest play with
  tight limits. The first keeps today's model and the home server's load
  small.
- **Identity.** A device key instead of a Habitica login, with the guest hero
  (Wren) as today. Linking Habitica later reuses the guest-save migration
  path.
- **Which world.** A guest's own solo world, or joining a friend's by invite.
- **The no-server game.** A static build with no server would keep the
  village and the story, but no Wilds and no caves.
- **The Habitica boundary.** Rule 7 already covers a hero with no Habitica
  self. A non-Habitica version would need its own way to earn embers and its
  own look (the "backups for everything Habitica supplies" goal in
  `docs/ideas.md`).

## Interiors and floors (direction A in detail)

- **Ids:** `in:<parent>:<place>` and `in:<parent>:<place>:<floor>`, e.g.
  `in:village:kitchen`, `in:village:mill:2`. The cottage becomes
  `in:home:<gate>`. Each interior is a hand-made room in content, small (up to
  about 14×14 tiles like the cottage).
- **Rules come from the parent.** One server helper maps an interior to its
  parent for safe-area, sync, rest and world-move checks, so the inside of a
  village building counts as the village. No gathering indoors. Pickups and
  repairs list interiors explicitly when they want them.
- **Saves:** an interior is a real save area. The whitelist (`state.ts`,
  `rules.go`) accepts known interior ids from content plus `in:home:<gate>`.
  Reload inside and you're still inside.
- **Presence:** each interior is its own room. Friends see each other indoors,
  and a visitor to your cottage now appears inside it. Room limit (32) is
  plenty.
- **Doors and stairs:** a door is an exit on the building's door tile in the
  parent map and a door exit inside back to the doorstep, as the cottage does
  today. Stairs and ladders are exits between floors. Exits today are inferred
  from the map edge (`area/exits.ts`); doors and stairs need an explicit side.
- **Residents indoors:** Hazel cooks in her kitchen and Finn works in the mill;
  their seller rows (`content/items.json`, area plus tile) gain a second spot
  inside, so the server's nearness checks work in both places. The library
  door stops opening a panel and leads into a reading room; the shelf inside
  opens it.
- **Going in and out** (owner, 2026-10-07): indoor residents follow a daily
  pattern, inside part of the time and at their door or about the village the
  rest. It's worked out from the clock when you look, with no ticks.
  - The game has no time of day today, only UTC calendar days
    (`src/lib/calendar.ts`).
  - **Chosen (owner, 2026-10-07): a short shared cycle.** Each resident
    repeats a loop on the shared UTC clock (say 40 minutes inside, 20 out,
    offset per resident so they don't all move at once). Everyone in a world
    sees Hazel in the same place, the server can check where she is, and a
    player who always plays at lunch still sees both.
  - Cycles live in content beside the seller rows (`inside`, `out`, `offset`
    in minutes, and the out spot), read by both the client and the server.
  - Not chosen: parts of each player's own day, because friends in other
    time zones would see her in different places.
  - Either way, the place shows it: chimney smoke and a lit window when
    someone's in, and knocking on a door with nobody home gets a line (Finn:
    "Wheel's turning, I'm round the back").
  - A resident walks between spots only if you're watching at the change;
    otherwise they're simply where the clock says.
- **First interiors:** Hazel's kitchen, Finn's mill (ground floor plus the sack
  loft upstairs, the first floor-to-floor stair) and the library.
- **Later:** a cellar for the cottage (homestead storage, a hand-made room at
  layer `-1` in spirit), the Hall tier as an upstairs, more residents who
  mostly live indoors.

## Art and content needed

Each line is a written art request for a round.

- **Interior kit:** plank and flagstone floors, wall faces with windows, a
  doorway, stairs up and down, a ladder and trapdoor, rugs.
- **Hazel's kitchen:** hearth with pot, worktable, shelves of crocks, the
  tallow pot.
- **Finn's mill:** millstones, gear train turning with the wheel, flour sacks,
  the chute; the sack loft with hoist and beams.
- **Library:** shelves, reading table, a lamp, the donation shelf.
- **Caves:** a cave floor and wall set that tiles on any shape, three mouth
  sprites (cliff foot, river bank, sinkhole), props (amber seams, roots
  through the ceiling, drips, pale mushrooms), the lantern-light darkness
  effect, a boss-chamber set, a naming-piece pickup (a carved stone shard),
  two or three cave enemy kinds, and one boss to start.
- **Content:** each interior's layout and lines; cave vault and boss-chamber
  templates; boss patterns; naming fragments that combine into a generated
  naming.

## The Habitica boundary

- Nothing here grants or copies Habitica things. Rewards are Glimway's own:
  materials (amber, stone), papers, keepsakes.
- Cave bosses are settled with namings, which keeps them clearly apart from
  Habitica's boss quests. The planned "party boss mirror" stays a separate
  idea.
- Guests on the server stay under rule 7 (no Habitica self, Wren as stand-in).

## Open questions

None left for the layers design itself. Carried elsewhere:

- Guests on the server: its own planning session.
- The generator, frontier and rings: `docs/design/world.md`.
- Which cave enemy kinds and which first boss: an art and content round once
  step 7 is near.

## Build order (draft)

Small shippable steps. Steps 4, 5 and 6 belong to other designs and gate the
caves.

1. **Rooms are places.** `in:` ids through saves, presence and the server's
   area checks; doors with an explicit side; the cottage becomes a real place
   (visitors appear inside). Small.
2. **Village interiors.** Hazel's kitchen, Finn's mill, the library; Hazel
   and Finn go in and out on their shared cycles, with smoke, lit windows and
   a knock line. Needs the interior kit and three rooms of art. Small to
   medium, mostly art and content.
3. **Floors.** Stairs and the mill's sack loft. Small.
4. **The open map on the server** (world.md). The generator, chunk serving and
   storage, the Tangle and Whitequiet as first rings.
5. **Guests on the server** (own planning session). Must land with or before
   step 4, or guests lose the Wilds when it ships.
6. **Server-run shared enemies** at open-map camps: Go room sim, wisp and
   beetle, enemy-state and action messages, kit port, claims that prove a
   fight. Large.
7. **Caves, first version.** The cave pass (mouths, footprint, tunnels), cave
   art, two enemy kinds, one boss chamber with a server-played pattern, naming
   pieces shared in the room. Medium to large.
8. **More caves.** More bosses and vaults, cave lamps joining the old ways,
   the cottage cellar.
