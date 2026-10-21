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

---

## Round 4b: the way in

*Added by Argon (`86ad6168`, CI run `39546306274`), with correctness/cover follow-up by Sol ([height-lab-4b-review-argon.md](responses/height-lab-4b-review-argon.md)).*

### What was happening in the owner's two screenshots

1. **"Some things flash, like the fog."** In Round 4, surface ground fog, thing fog twins, climbing edge haze, the climbing zoom-out, the background colour, and cave crystals/movers outside the arch all switched on `inCave` (`w.layer === CAVE`) in a single frame at the portal step, while the cave's floors and light faded over three walked tiles. All six now interpolate with `v.cave` / `v.alpha` (`scene.ts applyLook`), so nothing flips at the threshold.
2. **"Mid-transition shows more of the cave than you see once inside" (and the two hard dark rectangles beside the passage).**
   - In Round 4, the cave image was drawn at `alpha = v.cave` *under* the shared `MULTIPLY` light pass (`v.cave * CAVE + (1 - v.cave) * SURFACE`). Mid-way in (`v.cave = 0.5`), the unlit tunnel ahead and the `KIND.rock` slabs flanking it (`5%` cave ambient) were multiplied by `52.5%` blended light (half surface daylight!), showing at ~`26%` brightness before dropping to `5%` once fully inside.
   - Worse, `caveRock` (`area.ts`) stamps `KIND.rock` out to `ROCK_REACH = 3` tiles around the floor with a hard tile boundary, so those half-lit rock walls appeared as two sharp tile-aligned dark rectangles beside the passage (`.agent/owner-walk-in-mid.png`).
3. **How Round 4b fixes it:**
   - **Soft rock cover (`light.ts caveCover`).** The cave image's alpha is `1` on walkable floors/ramps/water/drops and feathers smoothly by texel distance across the surrounding `KIND.rock` (`1.5` to `2.75` tiles from the floor), eliminating the outer vertical slab edges.
   - **Lit crossfade over weighted surface light (`lighting.ts litPixels, fill`, `scene.ts drawCrossfade`).** While the way-in transition is active, `this.crossfade` draws the cave's floors and feathered rock walls *already multiplied by the cave's own light* (`litPixels` on the CPU) over the lit surface. Underneath `this.crossfade`, `Lighting.fill` (`over`) weights the surface light by `(1 - h) / (1 - a * cover)` so that after `this.crossfade` blends on top at `a * cover`, the buried hillside dims uniformly by `1 - h` everywhere—with no cave-shaped double-darkening trench over the tunnel footprint, no underground crystal/lantern light leaking onto the surface grass, and per-layer clamping so surface lanterns (Wren on the plateau) don't form a bright halo as the plateau dims.

### The four ways in compared side by side

The dev panel (`LabSection.svelte`) now has **"Way into a cave"** (4 choices) and **"Crossfade"** (`1 tile` / `3 tiles`):

| Way in | Curve (`light.ts wayIn`) | How it looks in motion & in the 11-step CI strips (`w-*`, `pw-*`) | Trade-offs |
|---|---|---|---|
| **As now (`blend`)** | Linear `light = alpha = walked / tiles` over `3` tiles (`1` tile when switched). | Clean and direct now that the mid-transition brightening, fog flash, and double-darkening trench are gone (`w-blend-m-east-07.png`). The hill dims evenly while the lit stone passage fades in at the same rate. | Starts and ends at constant speed (`1/3` per tile), so the very first step past the arch still begins abruptly. |
| **Slower, eased (`eased`)** | Smoothstep `s = t²(3 - 2t)` over `tiles + 2` (`5` tiles at default `3`). | Eases gently out of daylight on the first step in (`6%` at half a tile, `21%` at one tile), moves smoothly through the middle (`w-eased-m-east-07.png`, `w-eased-s-second-08.png`), and settles softly into cave dark over two extra tiles (`w-eased-m-east-09.png`). Directly answers *"a tiny bit sudden"* without changing the spatial layout of the screen. | Takes `5` walked tiles (`1` tile past the arch's back row plus `4` more) to reach `100%` cave view, so a player who stops one tile inside sees the hill only partly dimmed. |
| **Dark first, then the cave (`stages`)** | Over `tiles + 1`: `light` smoothsteps to `1` over the first `55%` of the walk (`0 → 2.2` tiles); `alpha` stays `0` until `40%` (`1.6` tiles) and smoothsteps to `1` over the remaining `60%`. | In phase 1 (`w-stages-m-east-07.png`), the buried hillside above the cliff lip darkens first while only the arch floor is visible; in phase 2, the lit tunnel floor and walls fade in out of the already-darkened hill. | Because `light` reaches ~`98%` dark before `alpha` rises above `8%`, the tile just north of the arch (`row 71`, where the cave floor hasn't faded in yet over the dimmed surface) briefly dips dark underfoot around `1.5–2` tiles in before brightening as the stone floor appears (`w-stages-m-east-08.png`). |
| **From the mouth outward (`iris`)** | Smoothstep circle centered on the nearest mouth's arch, expanding from `r0 = 1.5` tiles to past the viewport's far corner with a `2`-tile (`32 px`) feathered rim (`lighting.ts fill, litPixels`). | The cave's lit floor and darkness open radially outward from the arch as you walk in (`w-iris-m-east-07.png`, `w-iris-s-second-06.png`, `pw-iris-m-east-06.png`). At `walked = 0` (`04`) the iris stays off so nothing pops at the portal; as you step in, the `32 px` feathered rim reveals the tunnel around you first and sweeps across the hillside to the corners. Crystals and cave movers fade in as the feathered rim reaches them (`scene.ts caveShownAt`). | Very theatrical and grounds the transition at the mouth you stepped through, though the circular wipe across a wide desktop viewport is more overtly stylized than an even crossfade. |

### Round 4b screenshots (CI run `39546306274`, `lab/height-4/`)

All 176 way-in screenshots (`w-{blend,eased,stages,iris}-{m-east,m-west,s-second}-00..10.png` on desktop and `pw-{blend,eased,stages,iris}-m-east-00..10.png` on phone) were inspected alongside `.agent/owner-walk-in-mid.png` and `.agent/owner-walk-in-inside.png`. Representative frames copied into `docs/planning/wide-world/lab/height-4/`:

| Image | What to look at |
|---|---|
| [w-blend-m-east-07.png](lab/height-4/w-blend-m-east-07.png) | Same spot as `.agent/owner-walk-in-mid.png` (`1.5` tiles in, `blend` at `50%`). The hillside dims evenly with no cave-shaped trench, the unlit tunnel ahead is never brighter than once inside, and the outer rock walls feather softly instead of cutting hard tile-aligned slabs. |
| [w-blend-m-east-10.png](lab/height-4/w-blend-m-east-10.png) | Same mouth at `3` tiles in (`100%` cave view, compare `.agent/owner-walk-in-inside.png`). |
| [w-eased-m-east-07.png](lab/height-4/w-eased-m-east-07.png), [w-eased-m-east-09.png](lab/height-4/w-eased-m-east-09.png) | `eased` at `1.5` tiles (`21%`) and `2.5` tiles (`50%`) into the mountain's east mouth: gentler entry and landing. |
| [w-eased-s-second-08.png](lab/height-4/w-eased-s-second-08.png) | `eased` at the shoulder's second mouth (`2` tiles in, `35%`): the plateau and switchback stairs dim evenly with no dark trench across the trail and no spotlight halo around Wren. |
| [w-stages-m-east-07.png](lab/height-4/w-stages-m-east-07.png) | `stages` phase 1 (`1.5` tiles in, `light = 65%`, `alpha = 0%`): the hillside darkens first with zero underground light leaking onto the surface grass. |
| [w-iris-m-east-07.png](lab/height-4/w-iris-m-east-07.png), [w-iris-s-second-06.png](lab/height-4/w-iris-s-second-06.png) | `iris` opening from the mountain's east mouth and the shoulder's second mouth with a smooth `32 px` feathered rim (no stencil jag or dark ring). |
| [pw-eased-m-east-08.png](lab/height-4/pw-eased-m-east-08.png), [pw-iris-m-east-06.png](lab/height-4/pw-iris-m-east-06.png) | Phone (`390×844 @ 3x`) way-in frames at the mountain's east mouth for `eased` and `iris`. |

### What the owner should try

1. Open the Dev Panel → **Height lab** and walk in and out of the mountain's east mouth (`Area: Mountain with deep cave`) and the shoulder's second mouth (`Area: Valley, plateau & shoulder`).
2. Step slowly across the arch threshold (`row 73 → 72 → 71`): verify that fog, edge haze, and zoom no longer flash at the portal step, and that the unlit tunnel ahead never flashes brighter mid-transition than once inside.
3. Switch **Way into a cave** between **As now** (`blend`), **Slower, eased** (`eased`), **Dark first, then the cave** (`stages`), and **From the mouth outward** (`iris`), and toggle **Crossfade** between **3 tiles** and **1 tile** (with `1 tile`, `eased` spans `3` eased tiles instead of `5`).

### Recommendation for the default

- **Make `eased` ("Slower, eased") the default** (especially paired with a `2`–`3` tile base crossfade).
  - **Why:** Once the mid-transition brightening and fog flash are fixed, `blend` and `eased` have the cleanest, most natural look: the hill dims evenly while the lit passage comes in at the exact same rate, so lit stone underfoot never dips dark (`stages`) and there is no stylized circular wipe (`iris`). Between `blend` and `eased`, `eased`'s smoothstep onset removes the sudden first-step drop right at the arch (`6%` at half a tile vs `blend`'s `17%`) and eases softly into full cave dark at the end.
  - **Runner-up:** **`iris` ("From the mouth outward")** is well worth trying in the panel—with the feathered `litPixels` alpha and `over` surface weighting, it opens smoothly from the arch around the hero and looks especially good on the narrower phone viewport (`pw-iris-m-east-06.png`).
