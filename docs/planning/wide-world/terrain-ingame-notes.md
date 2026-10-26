# Height terrain in the real game (exp/terrain-ingame)

2026-10-26. Generated height terrain in the real Wilds, on dev servers only,
behind a dev switch. The live server and normal play keep the flat Wilds:
the terrain is served only by a dev route a release build doesn't compile,
nothing is stored, and with the switch off none of the new code runs.

## How the owner turns it on

1. On glim-dev (any dev-tools build; the account needs the hooks or the
   world lab tool), open the dev panel (`` ` ``) and the **Terrain** section.
2. Tick **Height terrain**. The chunks round you are fetched and baked in a
   second or two; walking is on the terrain's rules at once.
3. **Drawn as: Top-down / True ¾ lift.** Edge shading (strength, band width,
   threshold, scale by height difference, rim), sun strength, **Sun follows
   the game clock** or a fixed **Time of day**, uphill slowdown and downhill
   quickening, and the slope gait are below it. **Defaults** puts back the
   lab's settled values (60% uphill, 6% downhill, 60% edges, 4 px band).

The settings are kept on the device (`glimway:terrain` in localStorage).

## Where to walk

The terrain is `slopes-gen@2` (natural ranges, the Sol lane), regenerated
from your world's seed; `@1` is still served with `?recipe=slopes-gen@1`
(no panel switch yet). Home and the fixed places stay flat; the land rises
a few chunks out. Good first walks from the Commons' gate: north and east
into the first hills, then out to the nearest range for a pass and its
crags. The E2E spec finds, near home, a chunk seam on raised ground, a slope
to climb, a cliff face and ground rising south (to stand behind); its
`evidence.json` names the tiles for the run's seed.

## What's in

- **Wire:** `GET /api/dev/terrain?c=cx,cy&c=…[&recipe=]` (≤ 49 chunks)
  answers each chunk's 24×24 surface in the existing SL2 codec
  (`slopes_codec.go`, unchanged), in order, `int32 cx, int32 cy, uint16
  length, bytes`. The recipe is in `X-Glimway-Terrain-Recipe`. Shared
  vectors `content/vectors/slopes-surface.json` (Go writes, both decoders
  replay: kinds, walkability, open steps, flags, faces, rejections).
- **Shared module `src/game/terrain/`:** the field (bilinear height,
  gradient, the ¾ lift's columns, hiding, partial see-through, slope speed),
  the sun, sun map, proxy shadows, edge shading, gait and ground materials.
  The height lab imports the same files, so the lab and the game are one
  look. The lab now has only the two chosen looks.
- **Movement:** after every physics step the hero's motion (walking, roll,
  dash, knockback) is carried again over the field from the last good feet,
  in 2 px steps, with the per-corner walk rule (both tiles walkable, no
  discontinuity flag, both corner pairs equal) and linear uphill/downhill
  speed. Terrain not yet loaded is closed. Ground nobody walks (steep, crag,
  cliff) is also solid to the open map's stand/placement checks.
- **Drawing:** each attached chunk is baked in a worker from the window's
  own painted ground, with height's tint, scree, crags, talus and cliff
  faces, lit by the one sun (time of day or the clock, a bake every ten game
  minutes), and with 2e edge shading and rim. In the ¾ lift the bake is the
  chunk lifted 48 px a level (chunks drawn north first, seams continuous);
  every world sprite is drawn lifted by its feet's height just for the
  render (positions, depth and physics stay in field space). The hero gets
  the sun's proxy shadow, the slope gait, and partial see-through.

## Known gaps (this first lane)

- **Server-side** fights, enemies, spawning, line of effect and interaction
  reach are still flat; creatures walk slopes without slowing and are not
  held by cliffs. Remote players are drawn lifted but walk on the server's
  flat rules.
- **Sprites on closed ground** (trees, rocks, camps, sites on steep, crag or
  cliff tiles) are hidden, not moved; their collision stays (on ground that
  is closed anyway). Entities placed there are unreachable.
- **Hiding in the lift:** other sprites behind higher ground aren't drawn
  (as in the lab); only the hero has the partial outline. Labels and
  effects are lifted by the height at their own position, not their owner's.
  Decals (flat blitters) and the road's tile art are lifted per piece; the
  flat Wilds' blitter decals aren't lifted.
- **Pointer** clicks and taps aim at field positions, not the lifted
  drawing (swings and "use what's under the cursor" can be off in the lift).
- **Sun on sprites:** only the hero has the proxy shadow; trees cast none
  yet, and sprites aren't tinted by the light at their feet.
- **Fog by height** and the lab's climbing haze/zoom are not in the game.
- **Fixed places** (the Commons, the lots) stay flat images; the generator
  keeps them flat, so they meet the terrain at level 0.
- Turning the switch on mid-walk re-paints the attached chunks once (to keep
  their ground for the bake).

## Numbers

See the CI evidence (`evidence.json`, `budget`) and the frames under
[lab/terrain-ingame/](lab/terrain-ingame/): terrain CPU per frame (p95,
the gate checks ≤ 2 ms on the CI runner), bake time per chunk in the worker,
and the textures held (one per attached chunk).
