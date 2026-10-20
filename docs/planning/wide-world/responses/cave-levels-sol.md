# Cave levels and the mouth — Sol's analysis

2026-10-20. Discussion draft for the owner and the Opus fix lane. Docs only.

## Decisions

Discussion in progress. The owner: “I agree in most aspects.” This is not yet a
final approval of every option below.

Preferred cave depth-shading direction, in their words: “a ‘darkness’, where
lower and higher levels are actually darker - since they're a bit out of view.”
“There's no color difference here, just a brightness/darkness change.”

Updated recommendation: apply a neutral brightness multiplier to cave material,
smoothly based on absolute height difference from the hero. Preserve opaque
coverage and the colours contributed by the actual light sources. Keep the
current level clearest; darken both higher and lower levels. The owner's
proposal is being discussed; darkness strength and final scope remain open.
When they finish, put the ordered build and CI screenshot checks here first.

## What I inspected

Read `scene.ts`, `light.ts`, `lighting.ts`, `area.ts`, `mountain.ts`, `art.ts`,
`look.ts`, and `levels.ts` in `src/game/height-lab/`, both height-lab notes, and
`docs/planning/wide-world/land-rules.md`. Also read the existing
`e2e/height-lab-screens.spec.ts` to make the proposed checks concrete.

Personally opened all five owner images:

- `owner-mouth-outside.png`: the dark arch still contains the speckled meadow
  pattern visible outside it; the stone tunnel floor is absent.
- `owner-mouth-in-arch.png`: the floor under the hero is now flagstone, with the
  sunny grass and approach still visible below the arch.
- `owner-level-ghost-1.png`: a pale horizontal surface face, including its green
  lip, remains visible through the stone passage beside/below the hero.
- `owner-level-ghost-2.png`: the much wider crop makes the surface cliff, lip,
  and even outside ground/vegetation below especially clear through/around the
  passage. This is recognisable surface art, not just two shades of cave stone.
- `owner-level-ghost-3.png`: the passage ahead blends with a different ground
  pattern at a horizontal boundary while the hero's tile is clearer.

These crops have no coordinates or HUD state. The render path below explains
the visible mixing; exact positions and the moving-boundary sequence should be
captured by the fix lane on CI. I did not run Vite, Playwright, or a browser.

## 1. HUD: “floor” and an integer

**Cause.** `src/game/height-lab/scene.ts:576` (`updateHud`, especially lines
584–588) explicitly branches on layer: the cave says `floor ${Math.round(v.z)}`
and the surface says `level ${v.z.toFixed(2)}`. The 250 ms update throttle is at
line 578. This is a formatting difference, not a discrete cave movement model.

The hero's actual `z` comes from `zAt` for either layer (`scene.ts:429–453`).
`src/game/height-lab/levels.ts:147–162` computes the weighted height of the open
edges at the foot's position; `levels.ts:181–185` calls it for the current
layer. Both surface and cave ramps already give fractional levels while walking.
The cave HUD conceals those fractions.

| Option | Cost / consequence | Recommendation |
|---|---|---|
| Say “level” and show two decimals in both places | Small, local HUD edit; exposes existing smooth movement | Do this |
| Increase HUD refresh from 4 Hz | Small; more DOM updates, less numerical stepping | Only if 4 Hz still feels distracting in a walk |
| Animate a separate displayed height | More state and lag; can disagree with collision height | Unnecessary |

Keep the useful cave daylight and light readings. Show negative levels below
zero using the same height datum as the entrance; don't create floor numbering.
CI: stop on a cave ramp and a surface ramp, show “level” and fractional `z` in
both; then walk partway within a single cave ramp tile and record changing
state/HUD values. Decimal formatting alone is not evidence of smooth movement.

## 2. The mouth floor is grass until entering

**Cause, in three parts.**

1. `src/game/height-lab/art.ts:78–99` paints the surface ground everywhere,
   including mouth tiles. Carving a mouth closes its surface edges but leaves
   the ground palette underneath (`area.ts:319–324`; `mountain.ts:135–140`).
   `art.ts:169–174` dark-tints that existing ground inside the arch. It never
   replaces it with cave stone. Grass flecks therefore survive the tint.
2. The real cave floor is already painted (`art.ts:308–357`), but
   `scene.ts:478–479` sets **every cave ground image to alpha zero outside**.
   Inside, its alpha is multiplied by the hero's entrance crossfade. The
   geometry itself is appearing as the hero enters, rather than merely being
   revealed by the light available at its position.
3. `scene.ts:538–545` hides the light image when the cave view is zero; otherwise
   it blends surface and cave light by one hero-dependent amount across the
   view. Simply making all cave images visible outside would reveal the whole
   underground layout over the surface and light it as daylight.

**Recommend:** draw the true stone floor through the entrance while outside,
clipped to the mouth's visible opening, lit by the cave's local daylight and
sources. Keep the camera/view transition the owner likes. Separate three
things: material coverage, what the opening exposes, and light at that place.
An exposed stone floor should stay stone as the hero crosses the portal.

| Option | Cost / consequence |
|---|---|
| Paint a fixed dark stone patch into the surface mouth | Smallest; fixes the grass immediately, but a fixed tint won't respond correctly to daylight reach or nearby lights |
| Expose a clipped piece of the real cave floor with its local lighting | Recommended, medium: opening mask, correct depth under the lintel, and local lighting during the view blend; reuse existing floor art and light fields |
| Render all cave geometry and solve general visibility from outside | Large; needs a full cave visibility/occlusion solution and is excessive for this mouth fix |

`light.ts:58–115` already provides daylight along the walkable passage, and
`light.ts:202–216` combines that with cave ambient. Reuse that information.
`seen` (`light.ts:91–92`) is an actor visibility approximation for the arch,
not a general mask for floor visibility or lighting. The mask must preserve the
lintel, keep buried tunnels hidden, and avoid painting rock over the sunny face
again (`light.ts:220–222`, `art.ts:339`).

A locally prelit mouth patch is one possible small implementation, but it must
not be multiplied by cave light twice once inside. Another is extending light
composition to choose the cave's light within the exposed opening even while
the hero is outside; `lighting.ts:209–228` currently accepts constant view
weights, so that is real work. Merely changing the image alpha is insufficient.

CI: capture outside, at the portal, one/two/three tiles in, and the same route
out for both mountain mouths and the shoulder's two heights. Stone must already
show outside; its pattern must not morph from grass; the valley and face stay
sunny, the lintel covers the hero correctly, and hidden rooms remain hidden.
Repeat with daylight reach 3 and 10 and own light dim/lantern. Preserve the
current three-tile transition as the baseline.

## 3. Ghosting at a level change

### Cave floors and surface levels: the distinction that matters

The premise that the cave has integer movement while the mountain has
fractional movement needs correcting: **they already share the same movement
system**. “Floor” describes a cave rendering/light bucket, not a separately
stacked world or a teleport to another height.

| Concept | Surface | Cave |
|---|---|---|
| Layer | `SURFACE = 0` | `CAVE = 1`, one layer for all current cave heights (`levels.ts:315–317`) |
| Flat terrain | Whole authored heights, equal open edges | Same, including negative heights |
| Drop/cliff | Unequal neighbouring heights block crossing; south faces occupy three rows per level | Same `deriveFaces`, with a cave-floor mask (`area.ts:176–194`, `mountain.ts:142–179`) |
| Ramp/trail | Different entrance/exit edge heights; blocked sides where required | Same `ramp` helper (`area.ts:226–248`); mountain cave ramps A–E at `mountain.ts:175–179` |
| Height at the hero's feet | `zIn` / `zAt`, fractional within the ramp | Exactly the same functions, also fractional |
| Painted ground grouping | Integer `groundLevel`, ramps grouped by their low edge (`art.ts:42–54`) | Integer `caveLevels`, ramps grouped by their low edge rounded down (`light.ts:240–258`) |
| Level-distance effect | Ground alpha toward fog with the background behind it | Ground alpha advertised as darkening, but surface ground and surface things remain behind it |

`levels.ts:132–138` requires matching edge heights for a step, including portals.
`ramp` assigns fractional edge heights, and `zIn` interpolates them. The cave
doesn't need conversion to this system; it needs the existing fractional height
to survive presentation. Both renderers use integer buckets, so simply copying
surface ground grouping won't remove the artifact.

### What actually draws the faded upper tiles

1. The surface ground remains fully opaque in cave view (`scene.ts:477`).
2. Surface cliff faces and props remain drawn: they use their original surface
   band and `vis = 1` even underground (`scene.ts:491–497`). Cross-layer fog is
   zero. Those are the green lips and pale rock faces recognisable in images
   1 and 2. The cave floor is above them when inside.
3. Cave images are cut into disjoint integer-level tile groups
   (`art.ts:389–415`). They do **not** paint several cave floors at the same
   pixel. Their image alpha is `view * (1 - depthFog)` (`scene.ts:479`).
   `depthFog` uses the absolute difference between the hero's fractional level
   and the image's integer bucket (`scene.ts:460–461`, `look.ts:81–91`).
4. Whenever that alpha is below one, the already-drawn surface shows through.
   The later MULTIPLY light pass (`scene.ts:594–635`) darkens the combined
   colour. It cannot erase the surface pattern that has already leaked into
   the cave floor. A lantern can make that pattern easier to see.

For example, with full cave view and medium fog, a floor bucket one level from
the hero has fog `(1 - 0.3) * 0.42 = 0.294`: about **29% of the underlying
surface** remains in the blend. At two levels it is 71.4%. On a ramp the
current tile can itself be in a bucket more than 0.3 from the hero's true height.
As they walk, the relative fades change and a neighbouring bucket becomes
clearer. This explains a seam apparently moving to the next level/tile; it
isn't evidence of a stale previous frame.

There are two secondary contributors to distinguish on CI:

- The entrance crossfade also lowers cave alpha even at zero depth difference.
  It causes the mouth's material morph as well as exposing underlying surface.
- Outer cave rock intentionally has partial texture alpha (`art.ts:329–341`,
  `art.ts:386`). That edge can still reveal surface after fixing ground image
  alpha. It should fade into opaque underground darkness where covered, while
  keeping truly exposed outside land visible through the mouth.

The mismatch is in composition: the comment says ground fades toward the camera
background, but intervening surface pixels stop that happening. Turning depth
off is a useful diagnostic; it is not the recommended visual design.

### Fix options and recommendation

| Option | Cost / consequence | Verdict |
|---|---|---|
| Turn off underground level darkening | Tiny; removes this source of translucency, loses the ledge/cavern depth cue, leaves entrance and rock-edge cases | Diagnostic / temporary fallback |
| Preserve opaque cave coverage and multiply all RGB channels by the same brightness factor | Medium; neutral tint or black coverage can work without a shader, with careful coverage and depth ordering | Updated recommendation, matching the owner's preference |
| Cut surface coverage out wherever underground geometry occludes it, then fade to dark | Medium to large; surface ground, faces, props and translucent rock all need consistent masking; must preserve the bright valley through mouths | Useful alternative/complement, not a blanket surface hide |
| General shader combining material, fog and light | Large; cleaner eventual pass, but adds renderer and Canvas fallback work | Defer unless the fix lane finds the simpler composition untenable |

Keep opaque cave material coverage separate from depth shading. Following the
owner's preference, apply neutral depth darkening: multiply all three colour
channels by the same factor, without making the surface visible. This replaces
the original recommendation to blend toward the slightly coloured `CAVE_DARK`.
For example, a factor of 0.7 retains 70% of each channel; the exact strength
needs visual tuning. Crystal and lantern colours still come from world lighting.
Audit the existing baked cool-by-depth adjustment (`art.ts:342–343`, `381`)
as well: it changes channel proportions and should be removed if depth alone
is to cause no colour shift. Authored material colours can still differ.
For smooth ramps, use fractional height for their shading or give the locally
traversed continuous slope consistent shading; copying integer buckets still
leaves brightness bands. The current integer buckets can remain a batching
detail. A dark underlay alone blocks surface leakage but does not, by itself,
remove bucket-boundary brightness changes.

**Keep one cave layer with the shared edge-height rules.** More layers are
needed only for actual overlapping passages at the same screen tile. A layer
per integer depth would add portals, visibility transitions and streaming
scopes while losing the ledge's view down into the cavern. It would not repair
this alpha blend. Round 2's representation choice remains sound.

### Make climbing/descending readable in built and rough caves

The existing slope cue is just a 15% darker horizontal line every four world
pixels (`art.ts:357`), over the same flagstone pattern as flat floor. It neither
follows all slope directions clearly nor distinguishes natural and built work.
Surface ramps have related worn-step shading (`art.ts:176–183`).

| Cue | Fit and cost | Recommendation |
|---|---|---|
| Directional slope shading, rough floor texture and a small lip/contact shadow at slope joins | Natural caves; medium art/painter work across north/south/east/west and turns | Default rough-cave treatment |
| Irregular rock steps | Natural caves; medium art work, useful on steeper runs | Optional rough variant, keep smooth walking heights |
| Cut stairs and regular risers | Built caves; medium art work using the same traversal geometry | Built variant, not a universal cave requirement |
| Neutral brightness reduction with distance above/below the hero's level | Medium as part of the composition fix; replaces the existing depth colour shift | Owner's preferred depth cue; support it with readable slope geometry |
| Short slide through fog/dark at a connector | More transition state and input/camera tuning; briefly hides geometry | Reserve for a real shaft/overlap connector, not each ordinary ramp |

Recommend two art styles over the existing ramps: rough slopes/occasional rock
steps in natural passages, regular stairs in built ones. Use lip and shadow to
explain slope joins; a lip must not make a walkable slope look like a blocked
drop. Retain obvious faces for actual unwalkable drops. Don't use a global
brightness pulse to announce a descent: keep the world lighting the owner likes.

CI: capture multiple positions along the first mountain descent at (56,62–66),
the east/west slope at (69–74,58), and the long four-level exit at (40,51–64),
in both directions. Include within-tile movement near bucket boundaries, with
depth darkening on and off. Then capture the ledge (44,31), cavern (42,44),
and outer rock edges. Pass: no surface grass/cliff pattern in cave material;
other heights still darken without a depth-induced hue shift; no moving bright seams; rough versus built slopes
read at phone scale; the ledge's drop remains visibly blocked. Fix lane should
extend the current stationary screenshot set with a short walking sequence and
state samples; a single screenshot per flat floor misses the failure.

## Iteration 2: things to settle before generator adoption

These are integration consequences, not extra work approved for this lab lane.

1. **Bounded shared plans and chunk halos.** `deriveFaces` writes southward
   three rows per dropped level (`area.ts:185–192`); `caveRock` reaches three
   tiles (`area.ts:434–462`); daylight and open air currently solve across the
   entire lab (`light.ts:58–188`). A neighbour generated independently must
   agree on face footprints, ramp endpoints, mouth masks and portal edges.
   Use lasting feature plans with owners and bounded extents as required by
   `land-rules.md:44–53`, not chunk-local carving followed by edge repair.
   Daylight also needs nearest-mouth information across chunk boundaries;
   a cave without a mouth in the current chunk must not lose daylight on reload.
2. **Validate access and the roof together.** The lab's hand-drawn routes leave
   room for faces and ramps. Generated caves need explicit roof clearance,
   non-overlap and full foot-box traversal checks, plus consistent portal
   heights. `caveRock` only uses a rough surface-above test and even reads the
   north edge with a zero fallback (`area.ts:445–457`); that is not a general
   roof-clearance proof. Protect held land, saved heroes and existing openings
   (`land-rules.md:99–107`) and test the actual `fits`/`move` rule, not just a
   BFS centreline (`levels.ts:200–258`).
3. **Separate physical height from light buckets.** Cave light levels are
   `Int8Array` (`light.ts:241`); the moving lantern height is rounded
   (`scene.ts:538`), and a one-level difference costs 32 px of reach
   (`lighting.ts:71–72`, `339`). This can make lighting change at rounding
   thresholds even after the floor composite is fixed. Consider float target
   heights sampled on ramps and unrounded source height, with measured cache
   cost: `Lighting.move` invalidates visibility when `z` changes
   (`lighting.ts:145–149`). Simply passing a continuously changing `z` can
   rebuild visibility every frame. Smooth the height penalty separately from
   tile occlusion caching. The surface currently has no level grid registered
   with lighting (`area.ts:133–136`), which matters when lights move outdoors.
4. **Streaming/memory and mutations.** Lighting presently allocates full-area
   texel maps (`lighting.ts:89–100`, `249–270`) and ground uses full-area
   canvases cut into potentially large level bounding boxes (`art.ts:78–127`,
   `308–415`). Adopt chunk-local caches with sufficient neighbour context;
   invalidate ambient, occlusion and sources when relevant geometry/lights
   change. Include lights outside the viewport whose radius reaches it.
   Measure the land-rules chunk budget (5 ms p95, 6 KiB), light build cost,
   texture upload and phone frame cost separately; lab build/frame figures do
   not establish a streaming budget.
5. **Visibility is not illumination or access.** `caveStops` allows light over
   cave drops while walking blocks them (`light.ts:191–198`), intentionally
   letting the cavern below a ledge be lit. Daylight follows the walking graph,
   whereas `openAir` follows surface top heights rather than all walking
   obstructions (`light.ts:167–174`). Keep those policies explicit, and keep
   buried geometry hidden even if a light could reach it. Lamps are currently
   layer-local (`lighting.ts:187–189`, `228`); a lantern crossing a mouth does
   not automatically illuminate both sides. Test that boundary separately.
6. **Readability from every direction and dressing clearance.** Mouth authoring
   and sprite lintels here assume south-facing two-column arches; `Mouth` has
   no orientation (`area.ts:76–82`). Surface mouth shading finds a mouth by
   column alone (`art.ts:171`), ambiguous if generated mouths share columns at
   different rows. Give mouths identity, bounds and orientation before general
   placement. Export real masks/bounds for faces, slopes and mouths to dressing,
   preserving approaches and hero visibility (`land-rules.md:119–135`); the
   lab's hand-authored keep-clear radii and neighbour checks aren't sufficient
   for arbitrary tall sprite crowns. Reserve water integration after terrain;
   neither a cave pool nor the later flow map may erase traversal guarantees.

## Validation and handoff state

Analysis is based on direct inspection of the five supplied PNGs and source,
not a new rendered reproduction. No game code changed. No dependencies installed
or tests run for this documentation-only draft; plain `node` is unavailable in
this shell. CI checks above describe required evidence for the fix lane, not
checks already passed. Awaiting the owner's choices before finalising,
committing or pushing this response.
