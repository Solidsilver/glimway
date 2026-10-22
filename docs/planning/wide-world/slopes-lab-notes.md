# The slopes round in the height lab (exp/slopes-lab): notes

*2026-10-21, Claude Opus 5.5. The owner walked the generated slice near home and found "a bunch
of plateaus with walls/cliffs". They want walkable slopes by default and cliffs on purpose
([terrain-decisions.md](terrain-decisions.md), "After walking it" and "Further thoughts"). This
round is a hand-made area and four drawing styles to walk and choose from. It is not the
generator. Dev only: no live generation, protocol, database or normal-world change.*

## Short answer

- **Height lab → Area → Slopes, hills and passes.** A new hand-made area, 6×6 chunks (144×144
  tiles), authored as a **smooth height field**: every tile has four corner heights at 1/256
  level, shared with its neighbours. The only exceptions are where a cliff is meant, and there
  the tiles disagree. You spawn on low ground in the valley.
- It has rolling hills, a **two-massif range** (peaks around 11–12) with a too-steep scree band,
  crags at the tops, **a pass** (a saddle at about 6) and **an unreachable spire (level 15)**.
  There is also an outcrop (a slope up from the north, a 3-level cliff south), a sea cliff with
  one way down (a gully), and a plateau patch like today's generator makes. The range ends in
  the east, so you can go round it.
- **Slopes, drawn as: Shading by facing / Contour hints / Small terraces / True ¾ lift.** A
  second switch, **Slopes, with shading (on contours, terraces, lift): On / Off**, adds the
  facing shade to the other three. Switching keeps you on the same ground.
- **Walking limit: one level over four tiles** (`MAX_WALK_SLOPE = 0.25` in `slopes.ts`).
- **My read of the frames:** shading alone shows the big shapes (a mountainside, which way a
  hill faces) but not small rises; contours or terraces with shading show both. Terraces read
  most like "this is a slope you can walk". The lift is built properly (a projected map, cliffs
  opening into their faces) and makes heights feel tall, but the ground it squashes (facing
  away) is hard to read. The owner picks.

## Shared values with the generator lane (exp/slopes-gen)

As the orchestrator asked, so the two lanes join:

| | Here | Where |
|---|---|---|
| Heights | Continuous per tile corner, 1/256 level (`Q = 256`), levels 0–15 (`MAX_LEVEL`) | `slopes.ts` |
| Walking limit | A rise of at most 1 level over 4 tiles: `MAX_WALK_SLOPE = 0.25` (gradient magnitude from the tile's corners) | `slopes.ts` |
| Ground kinds | `slope` (walkable, flat included), `steep`, `crag`, `cliff`: `groundKind()` maps the lab's kinds to these names | `slopes.ts` |

Inside the lab the kinds stay the lab's own: `KIND.flat`/`KIND.slope`, the new `KIND.steep` and
`KIND.crag` (`levels.ts`), and `KIND.face` for cliff. `groundKind()` is the translation. Nothing
I walked made me want to change these values (see "The steepness limit" below). One difference
from a pure corner grid: corners are stored **per tile**, so a cliff is just two neighbours that
disagree. A shared (w+1)×(h+1) corner grid can't express a cliff without a second layer; the
generator lane should decide how its wire carries that.

## What was built

- **`src/game/height-lab/slopes.ts`**: the area, as pure data.
  - The **field**: per-tile corners (nw, ne, se, sw), kind, ground and slope. The authored
    height is a smooth base (valley at 1, far side at 3, the range, the hills, the coast's rise),
    with **authored pieces** on top: the sea (0), the gully, the spire (15), the outcrop, and the
    plateau patch with its ramps. Each piece's height is evaluated at the corners, so a piece
    joins its surroundings smoothly where it's meant to and makes a cliff at its edge where it
    isn't.
  - **Kinds**: walkable if the slope ≤ the limit; `steep` past it; `crag` where the ground is
    above 9.2 (patchy), steeper than 0.8, round the spire's foot, and along the outcrop's raised
    sides. Trees and boulders are kept off cliff edges and paths.
  - **Two maps from one field.** The flat map (shading, contours, terraces) takes a map tile to
    be a field tile. Cliffs take their faces off the land south of them by the **local face rule**
    (3 rows a level; `round(3 × drop)` rows, as the spike). The lifted map (true ¾ lift) is
    described under the styles below.
  - Named **spots** for the spec and these notes, and a Wren loop over the pass.
- **`slopes-paint.ts`** (pure pixels, so node can render previews) and **`slopes-art.ts`**
  (textures, the crags' standing rock). Ground is the Wilds' own painter. Higher land is drier,
  then stonier, with old snow above 11. Scree is its own grey grit with short dashes down the
  fall line and loose stones; steeper than 0.55 it is bare rock. Crags are broken rock with a
  standing rock drawn on each, so they read as unwalkable in every style. Where the walkable
  ground meets steep ground there is a rim of pale stones.
- **`scene.ts`**: the slopes area streams by chunk like the generated area. Switching style
  repaints; the lift rebuilds the map and puts you on the same field tile. Fog is **by height
  difference** here: a level's worth of fog per 4 levels of difference (`FOG_LEVELS`), drawn
  in half-level images cut by each pixel's height, so it fades in small steps along the ground.
  Haze and the climbing zoom scale to the taller range. Faces are tinted by height and get their
  fog depth per 3 rows.
- **The dev panel** (`LabSection.svelte`): the area, and the two switches (shown only on this
  area). The **levels overlay** now shows too-steep ground orange and crags violet.
- **Every option in cave-levels.md "Paused" still works**; the other three areas are unchanged
  (their specs pass).

## Height range, and what it costs

Levels run **0–15**: the sea at 0, the valley at about 1, the coast at about 2.8, the far side at
3, the pass at about 6, peaks at 11–12, and the spire at 15. The old hand-made mountain stopped at 5.

What 15 levels cost:

- **On the wire.** The 2-bit tops can't hold it. With corner heights at 1/256, a level needs 8
  bits of fraction and 4 of whole level, so 16 bits a corner (12 used). A 24×24 chunk is 625
  corners in a shared grid (1.25 KB raw), or 2,304 per-tile corners (4.5 KB raw) if cliffs are
  stored the way they are here. Smooth fields compress well: deltas between neighbours are
  usually under a level, a byte or less each, so expect well under 1 KB a chunk after deltas and
  deflate. That's a guess; the generator lane should measure it.
- **On screen.** In the flat styles the 15-level spire is a 19-row face (its drop over the land
  round it), and the sea cliff is 8. In the lift, the map gains a 47-row margin on top (3 × 15 +
  2) so the highest ground still fits. The summit is drawn 45 rows (720 px) north of where it
  lies. That's fine in a chunked world (it's just an offset), but a client has to stream chunks
  that far south of the view to draw what's lifted into it.
- **Fog.** At the old 1-level fog the range washed out from the valley. Fog by height difference
  (4 levels a step) keeps it readable.

## The steepness limit

**`MAX_WALK_SLOPE = 0.25`: one level over four tiles** (12 px of rise in 16, steeper than it
sounds, because a level is 3 rows tall). Why:

- Every hill is gentler (the hills top out at about 0.2), so hills are walkable anywhere.
- The generator's built ramps are 1/3 a tile, steeper than this. That fits the owner's call
  that stone laid on a rough slope becomes built steps.
- It stays **under 1/3**. In the true ¾ lift, ground facing away from you squashes by
  `1 − 3 × slope` and vanishes at 1/3. Under the limit, walkable ground never hides behind a hill.
- In the frames, the boundary falls where it looks right: the range's lower 60% is walkable, and
  the scree band starts where the profile visibly steepens.

The walking rule itself is unchanged: a tile past the limit is closed, and its own kind.

## The four styles: what works and what doesn't

Judged on the CI frames (run 39723432696), with one question per frame: can you tell uphill from
downhill, and walkable from not, without the HUD?

**Shading by facing** (light from the north-west, the top left)
- Works: big shapes. The mountainside is lit on one side and shaded on the other, the outcrop
  rises, and the pass sits between two shoulders. It never adds lines, so the ground stays clean.
- Doesn't: gentle hills (slopes under about 0.1) barely change, so standing in the hills you
  can't tell which way is up. The first frames were lit from the south (like the cliffs' sunny
  faces) and read inverted: the outcrop looked like a pit. North-west light fixed that, but
  the cliffs' sunlit lips and this light now come from different sides. Nobody has flagged it.
- Generator cost: none on the wire (from heights); a per-pixel shade at paint time.

**Contour hints** (a grass edge every half level, dark on the low side, stronger every 2 levels)
- Works: shows exactly where the ground rises and how fast, even on hills too gentle to shade.
  Tight lines warn of steep ground before you reach it. With shading on, it's the most
  informative style.
- Doesn't: on its own a line doesn't say which side is higher (the light/dark edge is too
  subtle at game zoom). It looks like a map, not a place. On scree the lines are dense.
- Generator cost: none on the wire; paint-time only.

**Small terraces** (steps a fifth of a level high, each with a lip and a short riser facing you)
- Works: reads as a place, not a map: "this slope is walkable, step by step". Risers face you
  on slopes that rise northward, so up and down read from the step shapes. Best on hills and
  the pass approach.
- Doesn't: on steep ground the steps crowd into a stripe pattern. Without shading it looks like
  ploughed fields. It also suggests there are steps to walk up, which there aren't (walking is
  smooth).
- Generator cost: none on the wire; paint-time only.

**True ¾ lift** (the ground projected north 3 rows a level as it rises)
- Built properly: `liftColumn` projects each column from the near edge back with a horizon.
  Where a tile's near edge stands above the land in front, the gap is its face, by the same 3
  rows a level. Walk data is computed from the projection, so the hero walks the lifted ground
  with the existing edge rules (tested: the pass, the spire and the gully all hold in the lifted
  map). Trees and crags stand where their tile shows.
- Works: heights feel tall, the scree band stands like a mountain wall, and cliffs and slopes
  finally agree (a cliff is just a very steep slope).
- Doesn't:
  - Ground facing away from you squashes into a thin band, hard to read (north sides of hills).
  - Camera-facing scree stretches into long walls.
  - Moving north on a slope facing you, the ground slides under you faster than you walk. That
    feels odd but is honest.
  - At a field edge, faces from the per-tile corners show as jagged steps (the face tiles are
    whole tiles while the ground warps by pixel).
  - It hides the plateau patch's north edges entirely.
- Where it stopped:
  - Water, caves and portals are not projected (this area has none).
  - The level images' fog is by the projected ground's height, so a tall face shows the fog of
    the land at its foot.
  - No smoothing of the face/ground boundary below a tile.
- Generator cost: none on the wire (it's a view of the same heights). On the client, a column
  projection per chunk (~100 ms painting a chunk here, in JS) and a map margin as tall as the
  highest ground. Walk data from the projection has to be the same on the server if it ever
  checks movement, so the projection would need to be deterministic and shared, not a client
  nicety.

**With shading on/off.** Off, contours and terraces lose most of their up/down reading, and the
lift loses its sense of which side faces the light. I'd keep shading on under any of them.

**Fog alone.** Fog by height difference is in, but it only separates heights far apart. The
styles carry the near cues. One side effect: the half-level fog edges show as faint lines on
steep ground (they follow the ground, so they read as rough contours).

## What's unfinished (for the reviewer)

- **No tunnel stub.** The cave machinery expects a cliff face with an arch and a hand-placed
  cave layer, and the lift doesn't project the cave layer. A cheap stub in the flat styles only
  would have broken the lift, so I skipped it. "Under" is the one route choice not here.
- **Lift edges**: jagged faces at tile seams where per-tile corners meet (see above), and fog by
  the foot's height on tall faces.
- **Light direction**: the slopes are lit from the north-west, but the cliffs' sunlit lips
  assume the south. They should agree before this goes anywhere real.
- **Crag placement** is a height threshold plus noise, not authored ridgelines; they come out as
  patches rather than jagged edges.
- **Contour lines** don't say which side is higher on their own.
- **Painting cost**: about 120 ms a chunk in node (flat) and about 100 ms (lift), plus about 20 ms
  to cut fog bands. That's fine streamed two a frame, but slow for a real client: a GPU shader
  should do the shading and lines.
- The HUD line on desktop still sits over the game's top buttons (the known nit). I didn't
  make it longer.

## Where to walk (field tiles; the flat styles' map tiles are the same)

Directions are from spawn. In the lift the map moves things north, so use the spots in the spec
state (`slopes.spots`, already converted) or walk from spawn.

| What | Field tile | From spawn (70, 96) | Look for |
|---|---|---|---|
| Spawn | 70, 96 | — | Low valley ground; the range north, hills west, the sea south. |
| Rolling hills | 30, 88 | 40 W | Walkable anywhere; contours or terraces show the rises best. |
| Pass, foot | 72, 70 | 26 N | The path starts up the range. |
| Pass, halfway | 72, 48 | 48 N | The scree band closes in on both sides. |
| Pass, saddle | 72, 31 | 65 N | About level 6, shoulders too steep either side. |
| Pass, far side | 72, 10 | 86 N | Down to the upland at 3. |
| Too-steep band | 56, 46 | 14 W, 50 N | Walk north: you stop at the scree's pale rim. |
| Crags | 90, 40 | 20 E, 56 N | Look north at broken rock and standing crags below the east peaks. |
| Spire | 37, 49 (stand) / 40, 36 (top) | 33 W, 47 N | A level-15 column over the west massif's crags; no way up. |
| Outcrop, gentle side | 103, 82 | 33 E, 14 N | Walk south: up onto it, about 3 levels. |
| Outcrop, edge | 103, 95 | 33 E | The lip over its cliff. |
| Outcrop, cliff foot | 103, 108 | 33 E, 12 S | Look north at the 10-row face. |
| Sea cliff, top | 30, 118 | 40 W, 22 S | The cliff's lip; the sand flats about 2.8 below. |
| Gully (the one way down) | 45, 112 → 45, 124 | 25 W, 16 S | Walk south down it to the sea. |
| Sea (sand flats) | 45, 134 | 25 W, 38 S | Under the cliff. |
| Plateau patch | 132, 110 → 132, 100 | 62 E, 14 S | Whole levels 2–4, cliffs, three ramps up the middle (cols 131–133). |
| Round the east end | 128, 40 | 58 E, 56 N | The long way north, round the range. |

## Proof

- **Node tests** (`tests/height-lab-slopes.test.ts`):
  - Heights are 1/256 and 0–15, and continuous except across authored pieces.
  - Walkable ground is never past the limit, and steep and crag tiles are closed.
  - The hills have no cliffs or steep ground.
  - The pass is walkable end to end through the saddle, in **both** maps; the way round the east
    end works too.
  - The spire's top is unreachable in both maps.
  - The sea is reached only through the gully, in both maps.
  - The too-steep band stops a walk north.
  - The outcrop climbs one side and has a face of `round(3 × drop)` rows on the other.
  - Every south drop makes its faces by the local rule.
  - The lifted map opens cliffs into 3 rows a level.
  - Wren's loop walks.
- **Playwright** (`e2e/height-lab-slopes.spec.ts`, CI only):
  - Every feature under every style, with the HUD hidden.
  - The three overlay styles without shading.
  - Switching style keeps the hero on the same ground.
  - A walk up the pass in the lift; the steep band stopping a walk.
  - The levels overlay, a HUD frame, and a phone frame.
- **CI**: run 39723432696, green: verify, e2e smoke, e2e full. I looked at all 82 frames (as
  contact sheets of the four styles side by side) over four rounds and fixed what read badly:
  - Tile-row striping in the shading.
  - Seams between fog images.
  - Fog bands cut by tile, showing as blocks on steep ground.
  - Inverted relief from south light.
  - Scree that swirled like wood grain.
  - Biome tints that turned the pass yellow.
  - Trees standing on cliff faces.
- **Frames** in [lab/slopes/](lab/slopes/), with `spots.json`:
  - `<style>-<feature>.png`: the styles side by side for the hills, the pass saddle, the steep
    band, the crags, the spire, the outcrop's two sides, the sea cliff, the gully and the
    plateau patch.
  - `steep-walk-1.png`: a walk north stopped at the scree.
  - `phone-pass-mid.png`: the phone frame.
