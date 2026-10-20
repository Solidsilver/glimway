# Life in the wide world: Claude's answer

*2026-10-20, answering [life-brief.md](../life-brief.md). Sureness is marked as **(sure)**,
**(fairly sure)** or **(guess)**.*

## The short version

- **Animals belong to biomes. The Dark belongs to the danger field.** Each biome brings its own
  ordinary animals. The Dark is one thing everywhere: it shows up wherever the danger field says
  it presses, wearing a biome tint. This splits the owner's two wishes ("creatures per biome" and
  "danger as a meta-biome") cleanly.
- **An unmoored beast is an ordinary animal with a fever.** The same den holds wolves either
  way. Where the land is calm they're wary animals that back off. Where the Dark presses they're
  fevered and fight. Break the fever and they run. One sprite does both jobs, and lighting a lamp
  calms the beasts near it.
- **Danger = a lasting field minus live light.** The lasting part (distance from the Wick Tree
  plus a slow "Draught" noise) sits in the generator and stays pure. Light from lamps and holds
  is applied when a fight room wakes, so the generator never reads the database.
- **Ten times fewer fights.** Today a walker meets a camp every 2–3 seconds. Aim for one
  encounter every 30–90 seconds of walking at middling danger, with animals and signs in between.
- **Animals run on the client, from a shared clock.** Herds move along paths that are a pure
  function of seed and wall-clock time, so friends see the same deer and the server simulates
  nothing.
- **Fix the enemy kind enum before the freeze.** `FightEnemyKind` is a proto enum (wisp,
  beetle). Creatures need a content id on the wire. That's a contract change, so it belongs in
  0.14.

## What's there today, counted

From content, not measured in the game **(fairly sure)**:

- `entityKinds` puts 1–2 camps in every generated chunk, and camp-glade places add about 0.07 a
  chunk more. Call it **~1.5 camps a chunk**.
- `Tier()` reaches 3 four chunks past any footprint, so nearly all the open Wilds are tier 3.
  Tier 3 mixes average **~2.4 enemies a camp**, so **~3.7 enemies a chunk**.
- A walker moves at 110 px/s, about 7 tiles a second. A 24-tile chunk takes **~3.5 s** to cross.
  So a walker passes a camp about every 2–3 seconds. That's the "too many" the owner feels.
- Camps respawn 600 s after they fall (`timers.campRespawnSeconds`).
- Behaviour is two hard-coded Go steps (`stepWisp`, `stepBeetle` in `fights/room.go`) picked by
  kind string, plus a third shape (guardian lunge) still on the client. Every behaviour is built
  from the same states: chase, telegraph, lunge, recover, stunned.

## 1. Danger as a field

### What decides it

One number per chunk, **danger 0–5**, made of three parts:

```
lasting = clamp(reach + press + biomeBias, 0, 5)       // pure, pinned with landform
effective = max(0, lasting - light)                     // live, read when a room wakes
```

- **reach** (lasting, pure). Distance from the Wick Tree's footprints (Hearthwick and the Tangle),
  in log bands so the ±4,096 border still has a gradient and isn't "max from minute five":

  | Chunks from home | 0–5 | 6–23 | 24–95 | 96–383 | 384–1535 | 1536+ |
  |---|---|---|---|---|---|---|
  | reach | 0 | 1 | 2 | 3 | 4 | 5 |

  At 3.5 s a chunk: band 2 starts about 1½ minutes out, band 3 about 6 minutes, band 4 about
  20 minutes, band 5 about 1½ hours. Riding shortens all of these. **(guess: tune in the lab)**
- **press** (lasting, pure). The Draught: how hard the Dark leans on this land. Smooth noise with
  features about 48 chunks across, from −1 to +2, hashed with the landform seed (no season), so it
  doesn't move between wicks. This is the owner's "meta-biome": it crosses biome borders. Rare
  peaks (about one per 200×200 chunks) add a further +2 in a 3–6 chunk patch. Those are the seed
  of canon's **frets** (§2.5), later a content release of their own. **(fairly sure)**
- **biomeBias** (lasting, content). Small: woods 0, lake country 0, the Tops 0 with +1 above
  level 2, caves +1 (no daylight), the Whitequiet sets press to its own rule (below).

- **light** (live, from the database). Each lit light source gives a strength. Its chunk gets
  the full strength, and it drops by one per ring (Chebyshev). Take the **max** over sources, never
  the sum, so ten lamps in a row don't make a fortress.

  | Source | Strength | Lowers danger in |
  |---|---|---|
  | Way-lamp camp or lot lantern (Built, fed) | 3 | its chunk −3, ring 1 −2, ring 2 −1 |
  | Communal lamp or relit lamp stone (Common, visited) | 2 | its chunk −2, ring 1 −1 |
  | Dimming Built lamp | 1 | its chunk −1 |
  | A chartered hearth (later) | 4 | wider |

  Fixed places (town, Tangle) are already in `reach`, so light is only what players add.
  **(fairly sure about the shape, guess about the numbers)**

### What lasts and what turns

| Part | Lasts | Turns each wick | Changes live |
|---|---|---|---|
| reach, press, fret patches | ✓ (landform version) | | |
| Which biome, its habitats | ✓ (pinned region) | | |
| Encounter sites, herds, signs | | ✓ (detail) | |
| Light from lamps and holds | | | ✓ at room wake |
| Whether a den is fevered | | | ✓ at room wake |

This keeps `GenerateV3`'s rule: a chunk is a pure function of seed, epoch and position. Lamps
change what *wakes*, not what's *generated*. A lamp lit mid-wick calms its land at the next wake,
with no regeneration and no stored chunk to patch.

The live part needs one lookup next to the place lookup from shared-fights §1.11:
`DangerAt(world, layer, cx, cy) → {lasting, light, effective}`. The hub calls it when it wakes a
room (a lifecycle boundary, so a store read is allowed there). The HUD and map use the same
answer.

### Does a lamp lower danger, and how much

Yes, and it should be the main way players *feel* the world respond. Setting a way-lamp at a
band-3 spot makes its own chunk calm, so the wolves there are just wolves, and its ring 1 band 1.
Pushing lamps outward is how the people reclaim land from the Dark. That's lamps' existing loop
(oil, upkeep, the turning) gaining a reason players can see. It also matches canon §2.5: the Dark
presses where light is thin.

Light never reaches below 0, and it never touches `reach` bands 4–5 far enough to matter. A far
camp's lamp makes a pocket, not a road. **(fairly sure)**

### What the player can read

Before walking in, in this order of cost:

1. **Life itself is the gauge.** Calm land has animals: deer in glades, ducks on the shore,
   birdsong when sound lands. As danger rises the animals thin out. At band 4+ there are none.
   Silence is the warning. Costs nothing extra once animals exist. **(sure this is the best one)**
2. **Signs round encounters.** Each encounter scatters signs in a ring one to two chunks round
   it: clawed bark and bones near a den, rime and a cold-blue ground tint near a Dark haunt. You
   see signs before you see the fight. Decor ids, placed per wick.
3. **Land tint.** A palette shift by `press`: colours drain and cool as the Draught rises. One
   shader parameter per chunk, blended across edges. Frets are the extreme of the same tint.
4. **A HUD word.** Beside today's land chip: *Calm, Uneasy, Pressed, Dark* (0–1, 2, 3, 4–5).
   Effective danger, so a lamp's pocket reads *Calm* at once.
5. **The map.** Explored land is shaded by the band you saw there (stale shading fades, as the
   synthesis says for detail). Unexplored land shows nothing, except **rumours at a lamp**: the
   ledger names the band of a few regions within ~12 chunks ("the Keeper's ledger marks the
   lakes past the ford as pressed"). That uses the rumours system the synthesis already plans.

## 2. Fewer, better encounters

### Densities

Count per **place cell** (3×3 chunks), not per chunk. Below one a chunk, chunk dice give
clumps and gaps; a cell spaces them out. Start here **(guess: tune in the lab)**:

| Effective danger | Hostile encounters per cell | Enemies each | Herds and animals per cell |
|---|---|---|---|
| 0 Calm | 0 (dens show as calm animals) | — | 3–4 |
| 1 | 0.4 | 1–2 | 3 |
| 2 Uneasy | 0.8 | 2 | 2 |
| 3 Pressed | 1.2 | 2–3 | 1 |
| 4 | 1.6 | 2–3 (deep variants) | 0–1 |
| 5 Dark | 2.0 | 3 (deep variants) | 0 |

Fractions are rolled per cell (0.8 means one site with 80% chance). Today's band-3 equivalent is
about 13 camps a cell; this is 1.2, roughly a tenth.

What that gives a walker at 110 px/s: crossing a cell takes about 10 s, and a walker sees about
a cell's width. At band 2 that's an encounter every ~15–25 s in the open, one every 40–90 s if
you count only the ones on your path. That's a lot quieter than today but not empty. Riding halves it.

### A measurable target

Add a **walk rhythm** probe to the world lab: drop a hundred straight walks from home in random
directions, and report the seconds between encounters within 6 tiles of the path, p50 and p90,
per band. Tune densities to targets the owner sets once by feel. My start: band 2 p50 45 s,
band 4 p50 20 s, and p90 never under 8 s (no back-to-back fights unless you seek them).

### What fills the space

A walk should go: quiet, signs, something worth the fight.

- **Animals** (section 3): herds grazing, a heron on the shore, goats up a cliff you can't reach.
- **Signs** round encounters (above): they announce fights and make quiet stretches feel lived in.
- **Forage and nodes**: unchanged for now (2–4 nodes a chunk).
- **Places**: the place cells' landmarks stay as they are. A **camp glade** stays a set fight
  with a chest. It's the "worth a fight" beat and should be about the only fight inside a cell at
  bands 0–1.
- **Nothing.** The synthesis already says an emptier world is fine for now. Empty land between
  lamps is part of the feel.

### Respawn

With a tenth of the camps, a fallen one matters more. Raise `campRespawnSeconds` from 600 to
**1200**, so clearing your way out leaves the way home quieter. **(guess)**

## 3. Creatures per biome, good and bad

### Three families

| Family | What it is | Where | In play |
|---|---|---|---|
| **Animal** | Ordinary beasts of a biome | Habitats in its biome, more where danger is low | Never hostile. Skitter or watch. Later: tracks, forage, mounts |
| **Unmoored beast** | The same animal, fevered (canon §5.4) | Its dens, when effective danger ≥ the den's threshold | Fights with its animal's move. At 0 HP the fever **breaks**: it flees, it doesn't die |
| **Thing of the Dark** | The Draught given a shape (wisps) | Haunts, where effective danger ≥ 2. Any biome, tinted by it | Fights. At 0 HP it **snuffs out** as wisps do now |

Today's two enemies sort into this at once: **beetles are unmoored beasts** (canon §5.4 names
beetles), **wisps are things of the Dark**. That also settles the ideas list's "until then no text
says what they are".

### The fever, in play

- A den holds a group of one animal kind. When its room wakes, the server reads effective danger.
  At or above the den's `feverAt`, the group spawns fevered and fights as a camp does today.
  Below it, the client draws calm animals there and no room wakes for it.
- Fevered beasts look like their animal with a **procedural fever**: darker palette, two ember
  pixels for eyes, a wisp of smoke. No new art.
- **Breaking** plays the fever draining out and the animal bolting for the chunk edge, then
  fading. It's still the server's death event: falls, claims and witnesses don't change.
- After a den falls, the client draws its animals calm, for the rest of the respawn timer. You
  can see that you made the land quieter.

### First roster (examples; the seam matters more)

Moves are today's three: **hop** (wisp), **charge** (beetle), **lunge** (guardian, moved to the
server). New ones are only parameters on those.

| Biome | Animals | Dens (fevered) | Dark (tinted) |
|---|---|---|---|
| **Woods** | deer in glades; fox | **wolf** pack: hop with a flank offset per pack member, so two wolves come at you from two sides. **beetle**: as today | **wisp** |
| **Lake country** | ducks on shore water; heron at reeds | **marsh toad**: slow long hop, big windup, heavy hit; stays on banks. **snapper**: charge, takes half damage unless stunned (`guardedTakes`) | **drowned light**: a wisp that idles over shallows and lures (its idle drifts toward you before it aggros) |
| **The Tops** | goats on high levels (they show off levels you can't reach yet) | **wolf** (shared); **ram**: charge with no scuttle angles and a longer windup, knockback large | **cold light**: wisp tint, gathers in the fog below cliffs |
| **Caves (−1)** | bats: a ceiling flock that scatters and flies off | **cave beetle**: beetle tint, comes in threes | **gloam**: wisp tint, wakes only where no lamp is near; +1 danger |
| **The Whitequiet** | **echo-beasts**: pale impressions of animals walking an old path, gone when you come close | none | none |

**The Whitequiet has no fights.** The Dark uses forgetting but isn't it (canon §2.5); the
Whitequiet *keeps* things (§2.4). Its danger is getting unmoored (the existing meter rises faster
there) and getting lost in the pale, not claws. A whole biome with no fights is a strong contrast,
and it fits trinkets and Echoes. **(fairly sure; owner's call, Q2)**

## 4. The spawning algorithm

### Per cell, per wick (pure, in the generator)

A new pass beside the places pass in `cells.go`, run per place cell, seasoned seed:

1. Read lasting danger and biome at the cell centre (fields are cheap to sample).
2. Roll the hostile count and the herd count from the density table, using **lasting** danger
   (light isn't known to the generator). Sites for bands above the effective band simply don't
   wake. That means a lamp hides some sites; it never adds one. **(sure that's the right
   direction)**
3. For each site, pick an **encounter** from the biome's list, weighted by habitat score at
   candidate spots: `shore` (next to water), `trail` (within 2 tiles of a path, for Dark haunts
   that hunt travellers), `glade`, `ruin` (near a place landmark), `cliff-foot`, `cave-hall`. Pick a
   chunk in the cell and a rough tile from the lasting fields only, as places do today.
4. Spacing: at least 1½ chunks between hostile sites, at least 1 chunk from a place's clearing,
   never inside a fixed block's keep-out (as today).

### Per chunk (pure, in the generator)

5. The chunk's detail pass snaps each of its sites to the nearest open tile (today's `pick`),
   emits the site as an entity (`kind: "den" | "haunt" | "herd"`, `encounter: <id>`,
   `minDanger`), and lays **signs** as decor in its ring.
6. Herds get a **home** and a **loop**: three to five waypoints on open tiles, generated with the
   chunk.

Camps from `entityKinds` go away; `camp` stays as a place's own encounter. Id format stays
`<kind>:<cx>:<cy>:<i>`, so fall records and claims key the same way.

### Live (the server, only near players)

7. A room wakes only for chunks with a den or haunt in a player's 3×3, as now. On wake it calls
   `DangerAt`, drops haunts below their `minDanger`, and spawns dens fevered or not. Calm dens
   don't need a room at all. Fewer camps means fewer rooms: this makes the server *cheaper*.
8. Encounters stay leashed in their chunk (decision 3 stands). A small addition: **idle
   wander** inside the home circle (a slow step to a random point within 48 px every few seconds),
   so a resting camp looks alive. Ten lines in `step`.
9. Camp size scaling, claims and falls: unchanged.

### Animals (the client, from a shared clock)

10. A herd's position is `loop(seed, wall-clock time)`: the herd walks its waypoints at a fixed
    pace on a cycle of a few minutes. Every client computes the same thing, so friends see the
    same deer in the same place with no server traffic and no sim. **(fairly sure)**
11. When you come within the flee radius, your client plays the skitter: the animals run away
    from you, then drift back onto the loop as you leave. Friends may see the skitter at slightly
    different moments. That's harmless for animals that never touch rules.
12. Animals are not solid and never block a path. They can't be attacked in 0.14 (fun with zero
    XP; never a reason to farm deer).

If animals later carry rules (tracking, taming, mounts), they move into the room sim then,
with the same content entry.

### Day and night

There's no time of day today (`clock.json` has wicks and days only). Don't add one in 0.14. Keep
a slot in content (`active: "any" | "night"`) so a later dusk cycle can wake night haunts. **(sure)**

### Caves and levels

Cave sites come from the same pass on layer −1, with `cave-hall` habitat and +1 danger. A creature
keeps its spawn level and its leash is level-aware, as the synthesis already says. Dens near ramps
sit clear of the ramp tiles so a fight never blocks the only way up. Goats spawn only on levels
above the nearest trail, so you see them and can't reach them yet.

## 5. Fit with the extension seam

### Content shapes

`content/creatures.json` replaces `enemies.json`'s per-kind blocks:

```json
{
  "moves": ["hop", "charge", "lunge"],
  "creatures": {
    "wolf": {
      "family": "beast",
      "sprite": "wolf",
      "animal": { "temper": "wary", "flee": 64, "pace": 40 },
      "fever": {
        "move": "hop", "hp": 14, "contact": 1,
        "tuning": { "aggro": 110, "hopRange": 56, "windup": 0.45, "flank": 18 },
        "breaks": "flee"
      }
    },
    "deer": { "family": "animal", "sprite": "deer", "animal": { "temper": "skittish", "flee": 112, "pace": 30 } },
    "wisp": {
      "family": "dark", "sprite": "wisp",
      "fever": { "move": "hop", "hp": 10, "tuning": { "...": "today's wisp block" }, "breaks": "snuff" },
      "tints": { "lake-country": "drowned", "tops": "cold", "caves": "gloam" }
    }
  },
  "deep": { "fromDanger": 4, "hpScale": 1.5, "windupScale": 0.9, "palette": "deep" }
}
```

Each biome's content entry gains a `life` block:

```json
"life": {
  "biomeBias": 0,
  "herds": [ { "creature": "deer", "group": [2, 4], "habitat": "glade", "weight": 3 } ],
  "encounters": [
    { "id": "wolf-den", "kind": "den", "creatures": ["wolf", "wolf"], "feverAt": 2, "habitat": "glade", "weight": 3 },
    { "id": "beetle-den", "kind": "den", "creatures": ["beetle", "beetle"], "feverAt": 1, "habitat": "ruin", "weight": 2 },
    { "id": "wisp-haunt", "kind": "haunt", "creatures": ["wisp", "wisp"], "minDanger": 2, "habitat": "trail", "weight": 2 }
  ],
  "signs": { "den": ["clawed-bark", "bones"], "haunt": ["rime"] }
}
```

The density table is world-wide content (`wilds.json` `life.density`), not per biome. A biome
leans on it only through `biomeBias`.

### Go

- **Moves are the only Go.** `stepWisp` and `stepBeetle` become `stepHop` and `stepCharge`
  reading parameters from the creature's `fever.tuning`, plus `stepLunge` for the guardian shape.
  New knobs are optional fields: `flank`, `guardedTakes`, `scuttleAngle` (0 means a straight
  charge), `lure`. A new creature is a content entry. A new *move* is a Go piece, and it should be
  rare: one per creatures release at most.
- **A biome's Go piece** (from the synthesis seam) may add habitat tags (`shore`, `cliff-foot`).
  It never touches fights.
- **Wire: change `FightEnemyKind` from an enum to a content id string** (or add a `creature`
  string beside it and stop growing the enum). Every new creature would otherwise be a contract
  change, and the contract freezes in 0.15. **(sure; the most time-bound item here)**
- Chunk wire: `WildsEntity` gains `encounter` and `minDanger`, and `Tier` becomes the lasting
  danger band (0–5). Chests and node yields read danger instead of tier through a small map in
  content.
- The client's `creatures.ts` and `fight-rules.ts` already mirror Go by kind. They should key by
  move, with the same vectors.

## 6. Art

The art model's time goes to biome identity, not variety. My order:

**New sprites, smallest set that makes biomes differ (5):**

| Sprite | Biome | Frames |
|---|---|---|
| wolf | woods, Tops | idle, walk (4), hop (2), flee reuses walk |
| deer | woods | idle, graze, run (4) |
| duck (or heron, not both) | lake country | float, waddle (2), fly off (2) |
| goat | Tops | idle, walk (2) |
| toad | lake country | idle, hop (2) |

Bats can be a two-frame flap of a dark shape: a particle sprite more than a creature. That's
nearly free.

**Recolours and procedural (no art model time):**

- Every fevered beast: palette darken plus ember eyes plus smoke, as a shader or atlas pass.
- Deep variants (danger 4–5): a further palette step.
- Wisp tints: drowned light (green-blue), cold light (white-blue), gloam (violet-black).
- Cave beetle: beetle recolour. Snapper: beetle with a shell recolour (or wait for its own sprite).
- Ram: goat with a darker palette and a horn overlay of a few pixels, or wait.
- Echo-beasts: any animal sprite drawn pale and translucent.
- Signs: clawed bark is an oak variant, bones and rime are small decor tiles.

The minimum that still makes biomes feel different is **wolf, deer, duck, goat**: one animal
each, and the wolf doubles as the first new fight. Toad and fox can wait.

## 7. Slicing

### Now, before 0.14 (content-only)

A density fix that ships on dev at a turning (unheld wick chunks regenerate then anyway):

- `entityKinds` camp `min 0, max 1` (about 0.5 a chunk, a third of today).
- Tier 3 mixes lean small: `wisp` and `beetle` back in, `wisps-beetle` down to weight 1.
- Expect `gen_v3_test`, `client_fixtures_test` and render goldens to need refreshing.

That's still too many by this answer's target, but it's a one-line change the owner can feel
this week. **(fairly sure)**

### Through 0.14's five iterations

1. **Walk any way:** the danger field's lasting part (reach bands + press) in the world lab as an
   overlay, with the walk rhythm probe. The cell encounter pass replaces `entityKinds` camps,
   still with wisps and beetles only. `DangerAt` with lamp light at wake. HUD danger word. The
   `FightEnemyKind` wire change. Beetles break and flee instead of dying.
2. **Lake country:** `creatures.json` and biome `life` blocks; client herds from the clock; deer
   (woods) and ducks (lakes); the wolf den; drowned light; signs; land tint.
3. **The Tops:** goats on high levels, cold light, level-aware leash (already planned).
4. **Below:** bats, cave beetles, gloam, cave +1.
5. **Far roads and tuning:** deep variants for bands 4–5, map danger shading, ledger rumours of
   bands, density tuning rounds against the walk rhythm targets.

### Later, a creatures release

- Animals with rules: tracks to follow, forage (antler sheds, feathers, down), taming, mounts.
- Frets as places: pushing a fret back with light, song and restoration (canon §2.5).
- Enemies that leave their chunk (packs that roam, with a room hand-off), as shared-fights §5
  already defers.
- A dusk cycle and night haunts.
- New moves: spit (a slow bolt from the bolt code), ambush (hidden until near).
- The fallen (canon §5.4–5.5): named people, the force-or-unwind choice. They're a story system,
  not a spawn table.
- Toad, fox, heron, snapper, ram as their own sprites.

## 8. Open questions for the owner

1. **Do animals run on the client from a shared clock, or in the server's rooms?**
   *Client* (recommended): free, friends see near the same thing, no rooms wake for them.
   *Server*: exact and shared, but every chunk with a deer wakes a room. Moves to the server only
   when animals carry rules.
2. **The Whitequiet: no fights at all, or rare ones?**
   *None* (recommended): a quiet biome with its own danger (unmooring and getting lost).
   *Rare Dark haunts*: more familiar, less distinct.
3. **Do lamps calm the land?**
   *Yes, max-not-sum, strengths 3/2/1* (recommended). *Yes, but only Built lamps*. *No* (danger
   is geography only).
4. **Unmoored beasts break and flee rather than die?**
   *Yes, and the den shows calm animals until respawn* (recommended, matches canon §5.4).
   *Yes, just flee*. *No, they die as now*.
5. **Deep variants for danger 4–5 in 0.14?**
   *Yes, palette and stat steps only* (recommended: far land should bite, and it costs no art).
   *Wait for the creatures release*.
6. **Ship the content-only density fix before 0.14?**
   *Yes, at the next turning on dev* (recommended). *No, wait for the new algorithm*.
7. **Respawn time.** *1200 s* (recommended), *600 s as now*, or *once a wick for dens*
   (stronger, and makes cleared land feel claimed).
8. **The first new creature, if only one fits:** *wolf* (recommended: woods and Tops, a new
   fight shape from one Go knob), *deer* (animals first, no fight), or *toad* (sells lake country).
