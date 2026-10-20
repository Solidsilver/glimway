# Height lab, round 4: notes

*exp/height-lab-4, 2026-10-20. Lane agent: Claude Opus 5.5. Built from the owner's calls in
[cave-levels.md](cave-levels.md), in Argon's order
([cave-levels-argon.md](responses/cave-levels-argon.md)), with Sol's cautions
([cave-levels-sol.md](responses/cave-levels-sol.md)).*

## Short answer

- **HUD.** It says "level" with two decimals in caves too (`In the cave · level -2.43 · …`).
- **Smooth heights.** Cave levels are fractional: a ramp tile's level is its middle, so levels
  change evenly down every ramp with no step at a whole level. The hero's and Wren's lights use
  their height as it is, not rounded. Walking down the four-level ramp, the most the light a tile
  ahead changes for one pixel walked is 0.034; with the old rounding it jumped by 0.70 at a half
  level (unit test).
- **No more ghosting.** The cave is one opaque image (no level slices, no alpha by depth), so
  nothing of the surface shows through cave floor or walls once you're in. Levels above and below
  yours are **darker, never tinted**: the light does it, inside the one lighting pass, so people on
  other levels darken too. The baked cool-by-depth stone tint is gone. The dev panel has a slider
  for how dark ("Underground, levels above and below get darker: 60% at most", 0–90%).
- **Argon's second bug is fixed.** The rock south of the shoulder's east tunnel (rows 22–24) was
  taken for the sunny cliff face round the second mouth, so it wasn't painted and the cliff and a
  pine showed through. Now rock is the sunny face only beside an arch, or where no tunnel runs
  just behind the face's top.
- **The mouth floor from outside, lit live.** From outside you see the real cave floor in each
  arch, in the cave's own light at that place: daylight reach, crystals, Wren's lantern, your own
  light, the sliders. No grass under the arch, the stone doesn't change as you step through, and
  it isn't lit twice once you're in.
- **Built and rough slopes.** Cut stairs on built ramps, wavy rock ribs and scree on rough ones, a
  pale lip where a ramp leaves a floor and a soft crease at its toe, dark rims where a floor drops
  away north, east or west. "Cave floors: Mixed / Built / Rough" in the dev panel; Mixed is cut
  stone on the ways in (the shoulder's tunnels, the mountain's east mouth down to the first bend)
  and rough rock everywhere else (the chamber, the deep cave, the mountain's west mouth).

## How it works

**Levels** (`light.ts caveLevels`): a `Float32Array`. Flat floor: its height. Ramp: the mean of
its open edges (its middle). Drop face: down the face. Rock and water: the nearest floor's.

**Light height without rebuilding shadows** (Sol's caution). A light's visibility is still worked
out only when it crosses a tile. The level penalty (a level is two tiles of reach) is no longer
baked with it: each light keeps the tile levels round it and the penalty is worked out from its
height as it is, so a light moving down a ramp changes evenly and `move()` with a new height costs
nothing extra. Node (this host, the hero walking ramp E and back, a 112×72-texel view): round 3
0.23 ms a frame; now 0.27 ms with the same work, 0.33 ms with the depth darkening and the arch
mask on (`.agent/bench-light.ts`, not committed). On CI, the HUD's light time at the screenshot
spots averages 0.62 ms against round 3's 0.37 ms there: still well under a millisecond.

**Depth darkening** (`lighting.ts fill`, `depthDark`): the cave layer's light at each texel is
multiplied by `1 − cap × smoothstep(|Δlevel| / 2)`, Δlevel the texel's smooth level less the
hero's. Your own level is clear, a level off is half the cap, two and more the cap. The same factor
for red, green and blue (a test checks no tint). It applies only on cave material, not on the open
air seen out of a mouth, and scales with how far into the cave's view you are, so it isn't there
outside.

**The mouth floor** (designed before it was built):

1. *Material.* The floor under each arch is cut from the cave's image into its own image, always
   drawn, under the surface's things (the lintel and faces still cover it, someone standing in
   front of the mouth stays in front) and under the cave's image (which fades in over three tiles
   as before and has the same pixels there).
2. *The opening.* `fill` takes a portal mask: on the arch tiles the light is the cave's at full
   weight whatever the view's mix, with moving lights of both layers. Outside, the light image is
   drawn whenever an arch is on screen; the rest of it is the surface's daylight, so the valley and
   the face stay sunny.
3. *Why it doesn't change or double.* It's one image under the one light, multiplied once. At the
   portal the view is 0 and the arch uses the cave's light at any view, so the light there is the
   same on both sides of the step.

**Slopes** (`art.ts paintCave`): stairs are a step every 8 px of the climb (two a tile), a dark
crease at each foot and a pale nosing at each top, with blocks along each tread. Rough ramps have
a wavy rib every 7 px (pale crest, shadow below) over fractured rock, and loose pebbles. Lips and
toes are soft (×1.16 pale, ×0.78–0.9 shade) so a walkable ramp never looks like a drop (a drop's
rim is ×0.45). Where cut stone meets rough rock the edge is ragged, not a tile's. The rock face
over a floor has its strata follow the floor's level.

## Screenshots (CI run 39513914425, `lab/height-4/`, 3/4 size)

The spec (`e2e/height-lab-screens.spec.ts`) now saves 186 shots: round 3's 32, then walks down and
back up both of the shoulder's ramps and the mountain's ramps A, B and E (several places on each,
some inside a tile next to where round 3 cut its level images), the owner's three ghost spots, the
ledge at darkness 0/60/90%, both floor styles switched, and every mouth (the mountain's two, the
shoulder's two) from two tiles out, one out, the portal and one/two/three in, at daylight reach 3
and 10 with your light close and none. I looked at every one. `states.json` has the level, how
far into the cave's view, daylight, light at the hero and the light's ms for each round 4 shot.

| Image | What to look at |
|---|---|
| `s-ghost1-east-ramp-top` | Owner image 1's spot. The tunnel's south wall (rows 22–24) is dark rock: no pale cliff or pine through the passage. The stairs fall away west, darker with depth. |
| `s-ghost2-east-ramp-mid` | Owner image 2's spot, mid-ramp (level 0.10). Even light along the ramp, no seam; rock south of it, not the cliff. |
| `s-ghost3-north-ramp-entry` | Owner image 3's spot, in the arch's top row, a third into the cave's view. The ramp ahead is one even fade (round 3 cut it at a whole level). |
| `s-north-down-4` | Halfway down the shoulder's first ramp (level −0.50): cut stairs, the rough chamber ahead in crystal light, the sunny face and valley behind. |
| `s-east-down-7` | Low on the east ramp, the ragged edge where the cut stairs meet the chamber's rough floor. |
| `m-a-down-4` | The mountain's first descent, cut stairs (level −0.30). |
| `m-b-2` | Ramp B, rough: wavy ribs across the climb, the cut corridor behind it. |
| `m-e-up-4` | The long exit ramp at level −2.43: rough ribs, floors above and below darker. |
| `m-built-ramp-b` | The same ramp B with the floors switched to Built: stairs. |
| `m-rough-cavern` | The cavern with floors switched to Rough. |
| `m-ledge-darkness-0-60-90` | From the ledge (−2), the cavern two levels below at darkness 0, 60 and 90%: the crystals still glow. |
| `mouth-m-east-sky3-dim-out1`, `…-sky10-dim-out1` | The east mouth from outside with your light at none: the arch's back row is darker at reach 3 than at 10 (sampled: 23% vs 32% brightness). |
| `mouth-m-west-sky3-dim-out2` | The west mouth from two tiles out: rough rock in the arch, its back in shadow. |
| `mouth-m-east-sky3-lantern-portal` | At the portal: the same flagstones as from outside, behind the lintel. |
| `mouth-m-east-walk-in-sky3`, `mouth-s-second-walk-in-sky3` | Two out, one out, portal, one, two, three in. The floor never changes; the hill dims over three steps as before. |

**How to get them all:** `gh run download 39513914425 -n e2e-full-evidence` (kept 7 days), under
`height-lab/` (`r4-*.png`, `states-r4.json`, `states-r4-mouths.json`).

## What the owner should check

1. Walk down the shoulder's east ramp and the mountain's ramps slowly, both ways: no ghosting,
   no seam, other levels just darker. Try the darkness slider; 60% is the default.
2. Stand in front of each mouth: stone in the arch, never grass. Switch daylight reach 3/10 and
   your light to None and back: the arch's back row should follow. Step in: nothing changes
   underfoot.
3. "Cave floors: Built / Rough / Mixed": do the stairs and the ribs read as climbing at phone
   size? Does a ramp's top lip ever look like a drop?
4. Two things that look as round 3 designed them, worth a look now the ghosting is gone:
   - **Your own lantern lights the arch from outside** when you stand near a mouth (it counts on
     the arch from both sides, so the floor doesn't brighten in one frame as you step through).
     With your light at None you see only daylight and crystals in it.
   - **The open air near a mouth still shows from inside.** From the shoulder's east tunnel you see
     the dark rock of its south wall, then the sunny plateau with its pines below it (the land in
     front of the second mouth, round 3's "open air"). If that reads as seeing through the hill,
     the open air's reach could stop behind a tunnel wall; I haven't changed it.

## Left for later

- The light costs about 0.25 ms more a frame than round 3 on CI (still under 1 ms); the per-texel
  weights could be skipped when there's no arch on screen and no depth to apply.
- The ledge's drop face stays mostly dark below the lip: your light's reach falls off with height
  down the face. Readable as a drop, but a little light on the face would help if wanted.
- Iteration 2's questions are untouched: mouth direction and identity, ramp length and landings,
  and both responses' lists (bounded plans, roof clearance, chunk caches).
