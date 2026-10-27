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

## Finding the features

With **Height terrain** on, the Terrain section offers **Go to the nearest:**
pass, range crest (a walkable shoulder), spire view, outcrop top, outcrop foot
(below the cliff), hills, and tunnel candidate. Each uses the existing dev
warp and reports the feature, distance in chunks, compass direction and
arrival level. The spire itself stays unreachable; a tunnel candidate is
metadata, not an open tunnel.
The spire view temporarily fits its footprint and lifted crown on screen;
choosing another feature or walking away restores normal camera framing.
Normal cover can move a warp to nearby open ground (the existing warp's
24-tile search); the returned stand's certificate concerns height terrain.

Ranges sit near the centres of 576-tile owner squares, roughly twelve
chunks diagonally from home. Walking straight north can go between them,
as in the owner's map screenshot. The buttons use the current world's seed
and the generator's plan, searching only the surrounding 3×3 owners. Each
stand is in its owner's certified transit-rim component; those continuous
rims form the terrain's backbone to home. The home owner's component must
also contain the Commons at (12,30). This is height-only certification:
trees and other cover still have their separate collision rules.

The world map's **Height** toggle defaults to on while Height terrain is on.
It shades explored and unexplored ground by level and facing, marks crags
grey and south cliffs brown, and shows **◇ passes / ▲ spires**. Switching
Height off restores the ordinary map. Reads use `/api/dev/terrain/map`
(36 samples per chunk, at most 256 chunks per request), never whole SL2
surfaces. Each opening caches at most 1,024 chunks; at extreme zoom-outs
only the nearest 1,024 visible chunks receive height. Feature summaries
are cached for at most 32 owners server-side. Both routes are compiled and
mounted only in dev builds, with the same account gates and recipe
selection as `/api/dev/terrain`.

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
- Only the attached chunks (the 3×3 plus chunks kept near a seam) are baked.
  On a wide screen the view can reach
  a little past them: there the flat painted ground shows, without light or
  materials, until you walk closer.
- Turning the switch on mid-walk re-paints the attached chunks once (to keep
  their ground for the bake).

## Numbers

Measured on the self-hosted GPU CI runner in
[run 40416490519](https://github.com/Solidsilver/glimway/actions/runs/40416490519),
revision `d803f1332695a76b22d1053a80a7431991d3bb11`. Raw values are in
[evidence.json](lab/terrain-ingame/evidence.json), `budget`:

| Measurement | Samples | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Terrain update + lift pass, ms/frame | 396 | 0.8 | 1.5 | 3.7 |
| Main-thread bake-start work, ms | 30 | 0.8 | 1.7 | 2.0 |
| Worker bake, ms/chunk | 45 | 31.5 | 40.7 | 75.1 |

Frame and bake-start timings cover three east/west walking pairs in the
lift, after a warp and settling; bake-start work is timed separately from
the frame budget. Worker bake timings span the test, including earlier
arrivals and mode changes. These are terrain timings, not total browser
frame times or end-to-end chunk-attach latency.

The final sample holds **12 terrain textures for 12 chunk images** (the
window keeps extra attached chunks near seams). The passing test also
checks **zero terrain textures after switching off**. The retry meets the
spec's frame p95 < 2 ms and bake-start p95 < 16 ms gates. The run is green,
but the full-suite report is **156 passed, 1 flaky, 0 failed**: this terrain
test first failed at **3.1 ms frame p95**, then passed on retry. The saved
frames and budget are from that passing retry; the frame budget still
shows variability between attempts.

In equal 700 ms key holds, uphill/downhill travel was **69.84/84.04 px**
top-down and **69.84/82.17 px** lifted (ratios 0.831 and 0.850). Both modes
crossed the seam at tile x=24, y=177 and stopped at tile (-127, 459), below
the cliff row y=458. The lifted ridge cover mask is **150/345 pixels**;
top-down cover is zero. The run's chosen climb is (-173, 273) south toward
y=281; its ridge is (213, 274). These coordinates depend on the run's seed.

## Frame review

Personally viewed all **25 PNGs** from a fresh download of this run's
`e2e-full-evidence` artifact: twelve full frames, their twelve crops, and
the switch-off frame. No new visual fix was needed. The sampled raised
chunk joins have no visible cracks, gaps or dark seam; the cliff has an
exposed face and a readable shaded lip. Bare cliff/crag strips have no
visible trees standing inside them. The top-down facing shade and edge
treatment agree with the same run's lab 2e cliff reference. The lifted
ridge keeps the covered lower part of the hero as a dark silhouette while
the upper part remains visible. The faint avatar body also appears in
top-down and switch-off frames, so it is not the terrain cover effect.
The previously listed limits, including flat blitter decals and the bake
window's extent, remain.

Each pair below links the full frame and its 400×280 crop:

| View | Top-down | ¾ lift |
| --- | --- | --- |
| Seam approach | [Full](lab/terrain-ingame/top-seam.png), [crop](lab/terrain-ingame/top-seam-crop.png) | [Full](lab/terrain-ingame/lift-seam.png), [crop](lab/terrain-ingame/lift-seam-crop.png) |
| Seam crossed | [Full](lab/terrain-ingame/top-seam-crossed.png), [crop](lab/terrain-ingame/top-seam-crossed-crop.png) | [Full](lab/terrain-ingame/lift-seam-crossed.png), [crop](lab/terrain-ingame/lift-seam-crossed-crop.png) |
| Climb foot | [Full](lab/terrain-ingame/top-climb-foot.png), [crop](lab/terrain-ingame/top-climb-foot-crop.png) | [Full](lab/terrain-ingame/lift-climb-foot.png), [crop](lab/terrain-ingame/lift-climb-foot-crop.png) |
| After downhill measurement | [Full](lab/terrain-ingame/top-climb-after.png), [crop](lab/terrain-ingame/top-climb-after-crop.png) | [Full](lab/terrain-ingame/lift-climb-after.png), [crop](lab/terrain-ingame/lift-climb-after-crop.png) |
| Cliff stop | [Full](lab/terrain-ingame/top-cliff.png), [crop](lab/terrain-ingame/top-cliff-crop.png) | [Full](lab/terrain-ingame/lift-cliff.png), [crop](lab/terrain-ingame/lift-cliff-crop.png) |
| Behind ridge | [Full](lab/terrain-ingame/top-ridge.png), [crop](lab/terrain-ingame/top-ridge-crop.png) | [Full](lab/terrain-ingame/lift-ridge.png), [crop](lab/terrain-ingame/lift-ridge-crop.png) |

[Terrain switched off](lab/terrain-ingame/off.png).
