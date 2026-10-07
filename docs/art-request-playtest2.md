# Art request: playtest-1, round 3 (village houses, the footbridge, pond water)

For the image-generation agent. Same direction and density as `docs/art-request-playtest1.md`
and `assets/generated/playtest1-pass/` (64 texels per 16 px world tile, the Tangle's style:
1 px dark outlines at that density, light from the upper left, crisp pixels, no soft
gradients). Deliver into `assets/generated/playtest1-pass/` as new sheets with frames added
to `manifest.json` and `atlas.json`, plus README and `prompts.json` notes.

## Why

The new ground and residents are in the game and look great. The blockiest things left in
the village are the three houses and the Brackenwood footbridge, which are still flat roof,
wall and plank tiles. The pond also shows a faint grid.

## 0. A fix first

The `atlas.json` from round 2 names two source sheets that its own `sources` list doesn't
include (the flagstone and waterbed variant sheets). Add them so `atlas.json` stands on its
own.

## 1. Three village houses (most important)

Hearthwick's three homes stand in a row along the top of the village, south-facing, seen from
the same three-quarter top-down view as the residents. Each is one standalone sprite (not
tiles) on a transparent background that covers an exact **footprint**:

| House | Footprint (tiles) | Footprint (texels) | Door column | Window column |
|---|---|---|---|---|
| West | 6 wide × 4 tall | 384 × 256 | 2nd from left (index 2) | index 4 |
| Middle (the largest) | 7 wide × 4 tall | 448 × 256 | index 2 | index 4 |
| East: **Ada Cooley's**, the gardener | 6 wide × 4 tall | 384 × 256 | index 2 | index 4 |

- The footprint is solid in the game. The bottom row of the footprint is the front wall,
  with the **door in the door column on the bottom row** and a window in the window column on
  the row above it. Columns count from 0 at the left.
- The roof, chimney and eaves may rise **up to 2 tiles (128 texels) above the footprint**, so
  each canvas is 384×384 or 448×384 with the footprint at the bottom. Nothing may stick out
  past the footprint's left, right or bottom edge (the bottom edge is the ground line).
- Give the three houses distinct personalities that fit the lore in `docs/lore/chronicle.md`
  ("The People of Hearthwick Today"): warm timber-and-plaster cottages, russet or slate roofs,
  amber-lit windows, weathered golden stone footings. Ada's has climbing plants and a window
  box. Match the existing Commons cottages (`commons-pass` `cottage`, `cottage-silas`,
  `cottage-workshop`) and the Hearthwick Library so all the buildings feel like one village.
- In the atlas JSON, give each house the footprint rectangle and a foot point (the bottom
  centre of the footprint).

## 2. The Brackenwood footbridge

A stream 2 tiles wide runs north to south through Brackenwood, and a dirt path crosses it
east to west. Draw a small wooden plank footbridge that carries the path across:
- The deck covers exactly **2 tiles wide × 1 tile tall** (128 × 64 texels) over the water.
  Planks run north to south (across the walking direction), with low rails along the north
  and south edges.
- The rails and posts may extend up to half a tile above and below the deck (canvas 128×128,
  deck centred vertically). Abutments meet the sandy banks at both ends.
- Match the existing `mended-bridge` art in the Commons pass (same wood and style). Make two
  states: **worn** (a missing plank, sagging rail) and **mended**.

## 3. Pond water that tiles cleanly

The three still water beds (`waterbed-variants`) look good, but a faint line shows where tiles
meet, because their edges don't match. Please deliver either:
- the same three beds made seamless, so any bed meets any other along every edge with no
  visible join (the stones may run across tile edges), or
- one larger seamless water texture, 256×256 texels (4×4 tiles), which the game will cut into
  tiles.

The game adds the moving light itself, so keep the beds still and evenly lit (no vignette or
darker corners).

## 4. Optional, if there's room: the player body, production version

The round-1 body is a prototype. A production version needs:
- separate layer PNGs (skin, hair, shirt, trousers or skirt, boots), each in exactly three flat
  index colours (light, mid, shadow), with the colours listed in the README;
- all five hairstyles (short, long, tied back, curly, **bald**);
- a third swing frame;
- clean edges (no anti-aliased or semi-transparent pixels);
- the same 64×128 canvas and foot point (32,128) as the residents, with a **hand anchor per
  frame** in the atlas JSON so held tools line up with the hand.

## Order of value

0, 1, 2, then 3, then 4.
