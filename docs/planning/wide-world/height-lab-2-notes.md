# Height lab, round 2: notes

*exp/height-lab-2, 2026-10-20. Lane agent: Claude Opus 5.5.*

## Short answer

- **Cave darkness now belongs to the world.** Light in a cave comes from sources at places in the
  world: daylight through each mouth, fading along the floor; crystals; open air in front of a mouth;
  and the hero's own light, the only source that moves. Where none of them reach it's dark, the same
  wherever you stand. One tile inside the mouth, the cave beyond is already dark (the owner's
  screenshot case is now a test). The surface still fades out with the daylight as you walk in, so
  the crossfade you liked is still there.
- **Fog goes both ways.** The level you're on is clear. Levels above and below fade with their
  distance from yours: toward fog (or sky) on the surface, toward the dark underground. From the
  valley, the mountain's upper faces and terraces are hazy. From the summit, the valley is.
- **Caves have levels.** Cave floors have heights inside the cave layer, with ramps and drops (cave
  faces) derived the same way as on the surface. **I recommend keeping a cave's floors as levels in
  one cave layer**, and adding another layer only where a passage has to pass under another. Reasons
  below.
- **A second area:** a mountain five levels above the valley with a trail that winds to the summit, a
  saddle over to the far side, and a deep cave under it that winds down four levels to a cavern, with
  a dead end and a second way out. You pick the area in the dev panel.

## What changed, and why

| File | What |
|---|---|
| `light.ts` (new, pure) | Daylight by walked distance from each mouth; open air; crystal light, which rock stops; the dark map (texels); the hero's light; the crossfade amount. |
| `mountain.ts` (new) | The mountain area, plus `asciiLayer` (prints a layer as text, for reading areas in a terminal). |
| `areas.ts` (new) | Picks the area. |
| `area.ts` | Helpers exported for both areas. `deriveFaces` takes a mask (a cave's floor). `lightArea` works out an area's light from its authored plan. The old daylight code moved to `light.ts`. |
| `art.ts` | The cave is painted as one image per floor level, with drops (cave faces), a pale lip at a drop and a little more cool dark on deeper floors. The dark map image, the hero's light brush, snow on the summit, face tints for levels 4–5. |
| `scene.ts` | Draws the dark as a render texture. Fog by level difference both ways, and depth darkening underground. Restarts on an area or daylight switch. The lab's line shows the area, the cave floor, daylight and light at the hero, and the dark's draw time. |
| `look.ts`, `LabSection.svelte` | New switches (below). `fogFor` lives here, so tests can read it. |
| `levels.ts` | `SURFACE` / `CAVE` moved here (`area.ts` re-exports them). |
| `tests/height-lab.test.ts` | 9 new tests (14 in all). |

Nothing outside `src/game/height-lab/` and the test changed. The hooks in `BootScene.ts` and
`DevPanel.svelte` are the same as before.

## How light works now (in world terms)

Each cave tile has a **still light** from 0 to 1, worked out once when the area is built:

1. **Daylight.** Count tiles walked along the floor from the tiles just inside each mouth. Daylight
   is full there and gone `skyTiles` tiles in (default 6; switchable 3/6/10). Because it uses walked
   distance, light follows a tunnel round its bends and doesn't pass through rock. Walls take the
   light of the floor beside them.
2. **Open air.** In front of a mouth, the cave layer has nothing, so you look out at the surface.
   That land, and everything at or below it that joins it without climbing, is fully lit. Under the
   hill, where the cave layer has nothing, it's dark.
3. **Crystals.** Each lights a round patch that fades out over 5.5 tiles. A level of height difference
   counts as two tiles of distance, and a straight line through rock stops the light, so a crystal
   lights its own room but not the next tunnel over.
4. Sources combine like light does: dark = (1 − daylight) × Π(1 − crystal).

The still light is baked into a **dark map**: one texel per 4 px, bilinear between tile middles,
softened by a short blur. It's drawn smoothed over the whole area, at most 97% dark. While you're in
the cave, each frame a render texture the size of the view gets the dark map drawn into it, and
**the hero's light** erased from it round them (close, wide or none). Nothing else depends on where
the hero is.

The **crossfade** from the surface view to the cave view is kept, but it's no longer a dimmer:

- The surface fades with the daylight where you stand, as before. That's the transition you liked,
  and from inside you can still see the lit valley through the mouth.
- The cave's floors and its dark come in over the first walked tile inside (switchable: 1 or 3
  tiles). After that the dark you see is the world's. Walking further only changes what your own
  light reveals.

The test `cave light belongs to the world` checks that, away from the hero's own light, the dark
drawn at any point is the same with the hero at the arch, one tile in, halfway, or in the chamber,
for every light setting.

**Lamps** fit straight in. A lamp is a source like a crystal (still, so baked in, or erased each
frame like the hero's light if it can be carried or switched). The per-frame cost is one erase per
moving light in view.

## How fog works now

`fogFor(dz) = clamp((|dz| − 0.3) × k, 0, max)`: symmetric, clear within a third of a level. The
dev panel sets the strength: light (k 0.25, max 0.55), medium (0.42, 0.72; the old value), strong
(0.6, 0.85).

- On the surface, a level's ground image fades toward the camera's background (the fog or sky
  colour), and every thing's fog twin covers it by the same amount. Faces use their own row's height,
  so a cliff gets hazier toward its top when you're below it, and toward its foot when you're above.
- Underground (**darkness by depth**), the same rule applies to the cave's floor images and the
  people on them, toward the dark. From the ledge, the cavern two floors down is dim. Look up from
  the cavern and the ledge is dim too. Crystals are lights, so they don't fade: you see them glowing
  far below. Switch: *Underground, other floors: Darken / Stay clear*.
- The camera's ease-out is capped at three levels (the mountain would otherwise zoom out 35%).

## How deep caves are represented, and why

**Floors are levels inside the one cave layer.** The cave layer is a grid of edge heights, exactly
like the surface. A cave floor is a height map plus a mask. Drops (a floor higher to the north) are
derived as faces, `ROWS_PER_LEVEL` rows a level, by the same `deriveFaces`. Then ramps are carved.
The deep cave goes from 0 to −4 in one layer: a ramp down, a corridor, a ramp, a long corridor, a
ledge with a two-level drop in front of it, a long ramp down into the cavern, and a four-level ramp
back up to the second mouth.

The trade-off between levels in layer −1 and further layers (−2, −3, …):

| | Levels in one cave layer (chosen) | A layer per depth |
|---|---|---|
| **Chunks** | One cave chunk (layer 1) per surface chunk that has a cave, whatever its depth. Same format as the surface: int8 heights plus carved tiles. | A chunk per layer per place. Sparse, but more keys, more fetches, and more to stream near you. |
| **Saves / positions** | (x, y, layer); height is derived from the tile. Nothing new. | The same fields, more layer values. |
| **Presence** | One scope for the whole cave. "Together" uses the same height rule as cliffs on the surface. | A scope per layer. Players in the cavern and on the ledge above would be in different scopes, though they can see each other. |
| **Fights** | Reach and hits use the same rule as on surface cliffs (no hitting across a drop, or downward only, as decided for the surface). | Across layers: none, simply. |
| **Seeing** | You see other floors (faded by depth): the ledge looking down into the cavern works. | Another layer is hidden until you cross into it: every stair is a mouth-style crossfade, and the "look down into the cavern" moment is lost. |
| **Limit** | No floor over another floor at the same tile, in screen space. A lower floor lies south of a higher one, or beside it. A cave must move across the map as it descends, and can't pass under itself. | Passages can cross under each other, and caves can stack in place. |

So: **levels in one layer by default; a further layer only where a passage must pass under another**
(rare, and a generator can mostly avoid it, or keep it for special places). The data allows both
(a layer index plus heights), so this is the generator's choice, not a format change. Fights,
presence and creatures should treat height within a layer the same way they will on the surface.
Then caves need no extra rules.

## The new areas

**Mountain and deep cave** (96 × 96 tiles, 4 × 4 chunks; *Area* switch in the dev panel):

- The valley (level 0, south), with a tarn and woods.
- The way up: a ramp (0→1), then four switchbacks on the faces (1→2 east, 2→3 east, 3→4 west,
  4→5 east), each three legs side by side. It winds back and forth up the range.
- The summit (level 5, snowy, a cairn) looks south over the terraces and north over the flank to
  the far meadow.
- The saddle: a level-3 pass (cols 59–71) between two level-4 masses. From the saddle, two ramps
  go down north to the flank (2) and the far meadow (1). The far side can only be reached over the
  saddle; a test shuts the saddle's ramp and finds no way.
- The deep cave: the east mouth in the first face (cols 56–57). The tunnel goes north and down to −1,
  bends east, slopes to −2, and runs north under the saddle. A **branch east** slopes to −3 and ends
  in a crystal-lit pocket (a dead end, with a mushroom). The main way turns west along a **ledge**
  (−2) over the **cavern** (−4): a two-level drop, six rows of rock face, crystals and a pool below.
  At the ledge's west end, a long ramp goes down into the cavern. **The other way out:** from the
  cavern's south side, a tunnel climbs four levels to the west mouth (cols 40–41), back into the
  valley.

Wren's loop there: valley → ramp → the four switchbacks → summit → back down to the saddle → the far
meadow → back over → the east mouth → down the cave → the dead end → the ledge → the cavern → out
the west mouth. A slime lives on the far meadow, and mushrooms in the cavern and the pocket.

The first area is unchanged in shape. Its chamber is darker now away from the crystals, which is
the point.

## Switches (dev panel, while in the lab)

- **Area:** Plateau and shoulder / Mountain and deep cave (rebuilds the scene).
- **Levels above and below fade to:** Fog / Sky / Nothing. **Fog per level:** Light / Medium / Strong.
- **Underground, other floors:** Darken / Stay clear.
- **Climbing, the camera:** Eases out / Stays. **Haze at the edges:** On / Off.
- **In a cave, your own light:** Close / Wide / None (None: only the world's light).
- **Daylight reaches in:** 3 / 6 / 10 tiles (rebuilds the light).
- **The cave's view comes in over:** 1 tile / 3 tiles.
- **Levels overlay:** surface levels 1–5 blue, orange, red, cyan, white. Cave floors from pale violet
  (0) to deep blue (−4). Faces and drops red, slopes green.

## Frame and build costs

Measured in Node on this host (no browser here, so no GPU numbers):

| | Shoulder | Mountain |
|---|---|---|
| Area data (incl. light) | 8.5 ms | 14.7 ms |
| of which the dark map (blur) | 6.2 ms (288² texels) | 11.1 ms (384² texels) |
| daylight + still light | 0.8 ms | 0.9 ms |
| Wren's route (BFS, all legs) | 5.8 ms (11 legs) | 5.3 ms (15 legs) |
| `move()` per call | 0.08 µs | 0.04 µs |
| Face tiles / props | 180 / 356 | 1,047 / 358 |
| Ground painter (est., 57 ms a chunk) | ~0.5 s (9 chunks) | ~0.9 s (16 chunks) |

- **Objects.** The mountain has ~1,400 still things, each with a fog twin: about 2,900 display objects
  (the shoulder has about 1,100). While you climb, every still thing gets a new alpha a frame, so
  that's about 1,400 setter rounds on the mountain. Expect a few tenths of a millisecond on desktop;
  please read the line on a phone. This is the strongest argument yet for **fog as a shader** (one
  colour-mix per draw from the thing's level), which removes the twins and the per-frame loop.
- **The dark,** per frame in a cave: one clear, one draw (the dark map) and one erase (the hero's
  light) into a view-sized render texture, then one blended quad on screen. That's about the same GPU
  work as the old dark image plus four rectangles, plus a framebuffer switch. The lab's line shows
  its CPU time as `(dark … ms)`. On the surface it costs nothing (hidden).
- **Memory:** the dark map is 384² RGBA (0.6 MB) for the mountain. Mountain level images: six
  surface levels (level 1 is the biggest, about the whole 1536² area, ~9 MB at most) and five cave
  floors, each cropped to its own bounding box.
- `npm run verify` passes (2780 unit tests, type checks, svelte-check, build). The release build
  contains none of the lab: no `HeightLab`, `hl-darkmap`, `hl-lantern` or panel text in `dist/`.

## What to look at

Dev panel → *Height lab* → **Walk the height lab** (or `?lab=height`, `&perf=1` for perf).

**In the first area (Plateau and shoulder):**

1. **The cave mouth, the owner's case.** From the valley, walk into the arch (centre of the
   plateau's face). One tile inside, the chamber and the far tunnel should already be dark. Only the
   daylit tunnel by the mouth, the crystals' patches, and the round of your own light show. Walk on:
   the dark shouldn't change at any spot; your light reveals the cave as you go. Compare with the
   first screenshot (`owner-cave-entering.png`). Turn **your own light: None** to see the world's
   light alone: daylight trickling in at the mouth and the crystals' rooms.
2. **Walk out again.** The surface fades back with the daylight, the valley outside lit all along.
   Try *The cave's view comes in over: 3 tiles* for a slower crossfade.
3. **Daylight reaches in: 3 / 10 tiles.** It changes how far the mouth's light goes up the tunnel.
4. **Fog both ways.** Stand in the valley and look at the plateau and the shoulder: their ground,
   faces and trees should be a little hazed (more for the shoulder). Climb to the lookout: the valley
   fades as before, and the plateau, one level down, a bit less.

**In the mountain (Area: Mountain and deep cave):**

5. **The climb.** Follow Wren up the ramp and the four switchbacks. On each terrace, the one below
   and the one above should be equally faded, and the summit should be hazy from far below. Try *Fog
   per level* light/medium/strong.
6. **The summit:** snow, a cairn, the terraces stepping down south, the flank and far meadow north.
7. **The saddle:** from the level-3 terrace, walk north through the pass between the two masses, and
   down the two ramps to the far meadow. That's walking across a range.
8. **The deep cave:** back down in the valley, the east arch. Down the tunnel (−1), east down a
   slope (−2), north along a long dark corridor with a crystal halfway. Take the **branch east** to
   the dead end's lit pocket. Back, then west along the **ledge**: the cavern is two floors below,
   darkened by depth, with crystals glowing in it. Walk the long ramp down, and the cavern comes
   clear as you reach its floor; look back up and the ledge is dim. Leave by the tunnel south: a long
   climb to the west arch, then out into daylight.
9. **The Levels overlay** in the cave shows each floor's depth as a shade of violet to blue, and the
   drop under the ledge in red.

Things I couldn't check without a browser (please look):
- whether the 4 px dark map reads smooth at zoom 3 (I expect so: it's drawn smoothed);
- the render texture's erase on a phone, and the ms the line shows;
- the cave drop's art (code placeholder strata);
- the 1-tile crossfade: whether it's too quick to read as a transition (3 tiles is the switch);
- the mountain's north flank: five rim lines close together, since north-facing drops in 3/4 view are
  only rims. Whether that reads as a slope is a look-and-see.

## What I'd do next in the real thing

- **Fog as a shader** (see costs). It also makes depth darkening per sprite free.
- **Lights as data in the chunk** (crystals, lamps, mouths), with the still light baked per chunk in
  the ground worker. Only moving lights are erased each frame.
- **Generator rule for caves:** go down by moving across the map (ramps, south-facing drops). Cap a
  cave at a few levels below its mouth, and keep "under another passage" for a second layer, used
  rarely.
- North-facing descents (like the saddle's far side) want a short "steps down" art piece. The rim
  alone is thin.

## Checks

- `nix develop -c npm run verify`: passes.
- Lab tests: `node --test tests/height-lab.test.ts`, 14 pass. New: light is the same at a world
  position wherever the hero stands; just inside the mouth the cave is already dark; crystals light
  their surroundings and the crossfade is a view, not a dimmer; fog is symmetric by level difference;
  the mountain's loop walks and reaches level 5; the far side is reachable only over the saddle; the
  deep cave winds down floor by floor; its legs join only where they should (the drop is shut, the
  dead end meets the main way once and has no exit, the second way out avoids the east mouth); deeper
  floors are dark and crystals light the cavern.
- CI on `exp/height-lab-2` head d56c6e27: run 39470225731, **success** (verify, e2e smoke, e2e on the GPU runner). The run before it (39467006837) was cancelled by that push.
