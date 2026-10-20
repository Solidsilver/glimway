# Height-and-caves spike: notes

*exp/height-spike, 2026-10-20. Lane agent: Claude Opus 5.5.*

## Short answer

**Real levels work in this engine, and I recommend them** over drawn height. The rule that makes
them cheap is to work in **screen-space tiles**: a cliff's face takes up real tiles on the ground in
front of it (3 rows a level), so nothing walkable is ever hidden behind higher land, and plain
y-sorting still gives the right draw order. Collision becomes one rule about tile edges. The cave is
a second layer with the same x/y, joined to the surface by portal edges at its mouths. The visual
transitions (fog or sky when you climb, dark round a light in a cave) are cheap: a few alpha
changes a frame plus one overlay image.

The costs are in the rest of the game, not in drawing: arcade-physics collision, the server's
movement checks, creatures' paths, the map and building all have to read levels. Details below.

## How to walk it

- **One click:** the dev panel → *Height lab* → **Walk the height lab**. The page reloads with
  `?lab=height`, and after Continue the lab starts instead of the world. **Leave the lab** in the same
  section returns to the world. Add `&perf=1` to the URL for the perf overlay (`__fsPerf` works as usual).
- Only builds with dev tools have it (Vite dev, or `GLIMWAY_DEV_TOOLS=1` for staging). Checked: a
  release `npm run build` has none of it (no `HeightLab`, `hl-faces` or panel text in `dist/`); a
  dev-tools build has the lab as its own lazy chunk (`scene-*.js`).
- It saves, sends and reads nothing. Your save and position are untouched.
- The switches (dev panel, while in the lab; remembered for the tab):
  climbing fog **Fog / Sky / Nothing**, camera **Eases out / Stays**, edge **haze On / Off**,
  cave **Close light / Wide light / All dim**, and a **Levels overlay** (blue level 1, orange level
  2, red faces, green ramps and trails, violet cave floor; thin black lines are shut edges).
- A line at the top of the screen shows where you are (surface level as a number, or cave daylight
  in %), the lab's own update time, the object count, and build time (with the ground's paint time).

### What to look at

You start in the valley, south of a cliff. Wren (an orange-tinted copy of the hero, labelled) walks
a loop through everything; follow them to find the way.

1. **The ramp** (west, cols 16–18): a three-lane slope up the plateau's face. Walk off its sides:
   you can't. You slow a little on slopes.
2. **The plateau** (level 1): a little drier and paler. Look back south from its lip: the valley
   should fade slightly toward the fog or sky colour, and the camera eases out a bit.
3. **The switchback** (north-east, the shoulder's face): three legs, side by side, joined only at
   their turns. Check that you can't step from one leg to the next, and that faces above a leg draw
   behind you.
4. **The shoulder and lookout** (level 2): stony ground, a cairn, and an east edge that drops two
   levels straight to the valley. The valley should look clearly far below: faded land, haze at the
   screen's edges, the camera further out. Try Fog against Sky against Nothing here.
5. **The cave mouth** (the dark arch in the plateau's face, centre). Watch Wren go in from outside
   first: they show in the arch, their head goes behind the lintel, then they're gone. Then walk in
   yourself: the surface fades as daylight drops over six tiles, the cave floor and rock come in,
   and the dark closes round you. Try Close light, Wide light and All dim.
6. **The chamber** (level -1, under the plateau and the shoulder's edge): pillars, a black pool,
   crystals glowing through the dark, a mushroom creature wandering. With the Levels overlay on,
   the cave's floor shows violet; note where it lies, walk out, and you'll find the plateau and the
   shoulder's edge above that spot.
7. **The second way out**: a tunnel climbs east under the shoulder and comes out of a mouth in the
   shoulder's face onto the plateau. Coming out, the surface returns as daylight comes back.
8. **Others on other levels**: Wren in the cave doesn't show on the plateau above, and the slime on
   the plateau keeps to its level: it wanders near home and never walks off the cliff.

Things I could not check without a browser (please look): the cliff faces' and arches' placeholder
art, whether the fog amounts feel right, how shimmery the eased-out zoom is (the zoom becomes
fractional while climbing; see "What I'd do differently"), and the Pixelify label on Wren.

## How levels are represented

All in `src/game/height-lab/levels.ts` (pure, tested in `tests/height-lab.test.ts`).

**Per tile, per layer:**

| field | type | meaning |
|---|---|---|
| `edge` | 4 × float32 (n, e, s, w) | the ground's height at each edge, in levels; NaN = shut |
| `kind` | u8 | for drawing: flat, slope, face, mouth, water, rock, prop |
| `ground` | u8 | ground palette index (content ground ids, plus cave floor and rock) |
| `sky` | float32 | daylight 0–1 (cave only; 1 on the surface) |
| `seen` | float32 | how much of someone here the surface can see (cave: the arch only) |
| `faceTop`, `faceRow`, `faceRows` | f32, i8, i8 | for faces: the level it rises to, which row it is |

**The one walking rule:** you can step from tile A to B across edge d when A's edge d and B's
opposite edge are both open and at the same height. That gives:
- cliffs where heights differ, faces (all edges shut), water and props (shut);
- ramps (a tile whose n edge is 1 and s edge is 0; lanes beside each other share a mid-height side
  edge so a wide ramp is walkable across);
- winding trails (each tile open only toward the tiles before and after it, so legs of a switchback
  can lie side by side);
- height inside a tile is the inverse-distance mix of its open edges, so it rises smoothly up a
  ramp and bends round a trail's turn.

**Layers and portals:** the surface and the cave are each a grid. A portal is an edge (layer, tile,
direction) whose far side is on another layer. Walking across it moves you onto that layer. Both
directions are stored.

**Movement:** a 10×4 foot box (the hero's real body). The middle of the box moves one tile at a time
by the rule; every other tile the box touches must be one step away (a corner through either side).
Movement is axis by axis, so you slide along cliffs.

### Mapping it onto a generated chunk

A chunk is 24×24 = 576 tiles. Stored compactly:
- Most tiles are flat: store **one `int8` top height per tile** (576 B), and derive the faces with
  `deriveFaces` (the same rule I used: land that drops k levels to the south puts 3k face rows in
  front of it). Generate the height in screen space directly: don't generate in world space and
  project, or land behind cliffs would hide (see below).
- **Carved tiles** (ramps, trails, mouths, a tile whose edges differ from its flat height) as a
  short list: `{tile index u16, kind u8, edges 4×int8 in quarter levels}`, around 7 B each. The lab
  has 28 slope tiles in 5,184; a mountain range would have a few hundred per chunk at most.
- **Caves** as their own chunk on another layer: `WildsChunkKey.layer` already exists and only layer
  0 is used. Layer 1 holds the cave's tiles in the same format, and only exists where a cave does.
  Most chunks have no layer 1.
- **Portals** as a list on the surface chunk: `{tile u16, dir u2, to layer u8}`. The cave chunk
  stores the reverse ones (or derives them).
- `sky` and `seen` are derived on the client (BFS from portals) and needn't be stored.
- A cliff can cross a chunk edge: `deriveFaces` needs the row above the chunk's top, so the
  generator (or client) must read one neighbouring row, as the ground painter already reads context
  tiles round a chunk.
- Server checks (movement, reach, fights) need the same edge data. Faces derive the same way on
  both sides from the heights, so only carved tiles and portals have to be agreed on.

## What changed, and what the real thing would need

The spike is isolated: `src/game/height-lab/` (levels, area, art, look, scene, the dev panel's
section) plus 11 lines in `BootScene.ts` and 2 in `DevPanel.svelte`. It doesn't use WorldScene,
arcade physics or the chunk window.

**Physics.** The lab moves walkers by the edge rule on tile data instead of arcade bodies. Arcade
can't express "shut only between these two tiles at different heights" without a thin static body on
every height-changing edge for every level pair, and bodies per layer switched on and off per
walker. For the real thing I'd keep arcade for things that aren't tiles (props' footprints, other
bodies) and add the edge check as the tile part of movement: a `process` callback or a
pre-step clamp. That's the biggest single change. It touches `hero.ts` (velocity, dodge, Shadowstep's
dash), knockback, `__fsDevWalk` and every e2e test that steers.

**Depth sorting.** Plain y-sort still works inside a layer, *because* of screen-space faces: a face
tile is y-sorted by its own row's foot, so someone on the valley floor stands in front of the face,
someone on a trail leg stands in front of the face rows above that leg, and someone on the plateau
is behind (and never overlaps) the face below them. Two new needs:
- **Layer bands**: the layer you're on draws above the other one. Someone just inside a mouth is
  drawn below the surface's things, so they show in the arch but behind its lintel.
- **Ground per level** as separate images (the lab cuts the painted ground into one image a level).
  The open map paints one image per chunk; it would paint one per level present in the chunk (most
  chunks: one).

**Rendering.** Per frame: layer alphas, fog alphas, the dark's position. Climbing fog is (a) each
level's ground image fading toward the camera's background, which is set to the fog colour, and (b)
a *fog twin* per surface thing (the same frame, `setTintFill(fog)`, on top, as opaque as the thing is
far below you). Twins are hidden when there's no fog, so they cost nothing on flat land. That doubles
the surface's sprites while you're high up: fine at the lab's ~1,150 objects, but worth a shader
(one colour-mix uniform per level) in the real thing. The cave's dark is one 512 px radial image
plus four rectangles round it, following the hero: no render texture and no per-frame drawing.

**Camera.** Eases out by 7% a level (switchable). In a cave it holds the base zoom.

**What it would mean elsewhere:**
- **Presence.** Every position needs `layer` (and z for drawing, derivable from the tile). A remote
  player on another layer is hidden, or shown in the arch by `seen` (done in the lab). The server
  must know layers to scope who's near whom: two players in the same x/y, one in the chamber and
  one on the plateau, are not together.
- **Fights.** Reach and hits must check layers, and probably height: no hitting across a cliff
  between levels (or allow it downward, as a choice). Projectiles need the edge rule or a "flies
  over" rule. Knockback must use the edge rule or it pushes people off ledges through the rule.
- **Creatures.** Pathing is the edge graph (the lab's creatures and Wren use plain BFS over it).
  Server-run creatures need the same data, which is the strongest reason the carved tiles and
  portals belong in the chunk, not only in the client.
- **Lamps.** Light radii should stop at layer boundaries: a lamp on the plateau shouldn't light the
  chamber below. In caves a lamp is a natural light hole in the dark (the lab's crystals fake this by
  drawing above the dark). Real lights in the dark need a render texture with holes erased per light
  (one screen-size RT a frame: affordable, but measure on phones).
- **Holds.** A hold's area is x/y today. It must say which layer, or a hold on the plateau would
  claim the chamber under it. Building on a level is fine; building on a face or ramp should be
  refused.
- **The map.** Draw the surface with shaded height (the faces read well from above), and caves as a
  separate view or an inset when you're in one. Layer 1 chunks are only on the map once found.
- **Desire paths** work per layer unchanged. Paths on ramps need the ramp's art, not path decals.

## Frame cost

Measured here (Node, this host's CPU; no browser on the host, so no GPU numbers):
- Building the area's data: **6 ms**. All 11 of Wren's route legs by BFS: **4.7 ms** in all.
- `move()` (one walker, one frame): **0.1 µs**. Four walkers a frame: nothing.
- The ground painter: **57 ms a 24×24 chunk**, so ~0.5 s for the lab's 9 chunks, on the main thread
  at start (behind the fade). The open map paints in workers already; levels add only the cut into
  level images and the height shading (a pass over the pixels), which would go in the same worker.
- Objects: 180 face tiles, 356 props, each with a fog twin; ~1,150 display objects in all. Faces,
  props and twins each batch into one draw (shared atlases; the fog is a tint, a vertex attribute).
  Draws: ~10–15 a frame (3 level images, cave image, two atlases, sprites, overlays).
- Per frame while climbing, every still thing gets a new alpha and depth (~1,100 setters, one
  display-list sort). On flat land, only the walkers.

**Phone estimate.** CPU per frame: the lab's update should be well under 1 ms on a mid phone (the HUD
shows it). The extra GPU work is overdraw: fog twins double the surface's sprite pixels while you're
high up, and the dark is one full-screen blended quad plus four rects in a cave. That's similar to
what the Wilds' canopy fades already draw. Memory: the level images are 1152² (5.3 MB) for level 0
and smaller for the others. In the real thing it's one image per level per chunk, and most chunks
have one. **Please read the HUD's numbers and `?perf=1` on a phone** while walking from the valley
to the lookout and into the chamber; that's the measurement I couldn't take.

## What I'd do differently in the real thing

- **Generate in screen space.** If the generator makes world-space height and projects it (higher
  land shifted up 3 rows a level), land just north of a plateau ends up hidden behind it: walkable
  but unseen. Making the height map in screen space and deriving faces in front avoids that by
  construction. (The only cost: a mountain is "taller" on screen to the south than the north, which
  reads as the usual 3/4 view.)
- **Fog as a shader**, not twins: one colour-mix per draw from the thing's level. Twins were the
  quickest way to try it here.
- **Snap the zoom.** Easing the camera out makes the zoom fractional, and pixel art shimmers at a
  fractional zoom. Ease between two whole-pixel zooms, or snap when you stop climbing.
  WorldCamera's scroll snapping would also apply.
- **Draw faces as art.** The faces here are code placeholders tiled per tile (strata, a grassy lip,
  moss at the foot). Real ones want a short kit: top, middle and foot rows, ends, inner and outer
  corners, an arch, ramp sides. Recolour per biome by tint (the lab already tints them by level:
  warm for the plateau, cool for the shoulder).
- **Side drops** (cliffs facing east or west) are only a dark rim here, since in 3/4 view a side
  wall is edge-on. It reads, but a 2–3 px rock strip on the high side would read better.
- **Caves need light design.** The dark round the hero is the strongest effect in the lab. Lamps,
  crystals and the hero's lantern should each be a light hole (render texture), and daylight at a
  mouth should cast a pale wedge onto the floor.
- **Mouth shapes.** Here a mouth is always 2 wide and opens south. North-facing mouths would be
  hidden behind their hill in 3/4 view, so either the generator only opens mouths to the south, east
  and west, or north ones get a "dark hole in the ground" look.
- **Overpasses** (a trail crossing over a tunnel on the same layer) don't exist in this model. Keep
  tunnels on the cave layer and they're never needed.

## Recommendation

**Real levels, with the screen-space rule, in a few discrete heights (I'd cap it at 4 surface
levels), and caves as layer-1 chunks joined by portal edges.** Reasons:
- What the owner asked for (climb a mountain, walk into a cave, all seamless) is exactly what this
  gives, and it looks like height, not a painting of it.
- Drawn height (one walkable plane, mountains as masses with trails) would need special collision
  for every mountain anyway (you can't walk over the mass), and it can't do "the land below fades as
  you climb" because there's no "below". The edge rule is about as cheap as solid-tile collision and
  much more expressive.
- The data is small (int8 heights plus a short list of carved tiles), fits the existing chunk key's
  unused `layer`, and the server can run the same rule.
- The cost is in game systems that assume one plane (physics, presence, fights, creatures, holds,
  map). The order I'd do them in: movement and creatures first (needed to play), then presence and
  fights, then holds and the map.

If the system work is too much for 0.14, a fallback that keeps the data shape: ship heights and
faces for **looks and walls only** first (cliffs are walls, ramps are the only way up, fog on
climbing), and caves through mouths, with fights and presence still treating everyone as on one
plane, except hiding players on another layer. That's most of the feel for a fraction of the
change, and the data doesn't need to change later.

## Files

- `src/game/height-lab/levels.ts`: the rules (edges, portals, the mover, BFS, sampling).
- `src/game/height-lab/area.ts`: the hand-made area (heights → faces → carving → cave → light).
- `src/game/height-lab/art.ts`: ground cut by level and shaded; faces, cave, overlays.
- `src/game/height-lab/scene.ts`: the scene (bands, fog twins, the dark, walkers).
- `src/game/height-lab/look.ts`, `LabSection.svelte`: the switches and the dev panel's section.
- `tests/height-lab.test.ts`: cliffs stop you, the ramp climbs smoothly, the switchback's legs
  don't join, mouths switch layers both ways, the chamber lies under the plateau and the shoulder,
  and every leg of Wren's loop can be walked.
- Hooks outside the folder: `src/game/scenes/BootScene.ts` (start the lab under `?lab=height`, dev
  builds only) and `src/ui/dev/DevPanel.svelte` (the section).

To drop the spike: delete the folder and the test, and revert those two hooks.

## Checks

- `nix develop -c npm run verify`: passes (2771 unit tests, type checks, svelte-check, build).
- CI on `exp/height-spike` head 2cf066de: run 39457468112, **success** (12 min).
- No E2E specs added (as briefed); the lab itself has not run in a browser yet.
