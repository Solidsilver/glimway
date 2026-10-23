# Slopes lab, round 2d: grounded sprite shadows (exp/slopes-shadows)

2026-10-22. The 2c light layer, terrain shadows, sprite tint and linear speeds
remain. Proxy shadows replace the sheared sprite drawing by default. Earlier
rounds below are historical; 2d supersedes their sun path and sprite shadows.

## How to walk 2d

Open **Height lab → Walk the height lab**, then **Area → Slopes, hills and
passes**. Choose **Reset to Shading baseline**. Check **Facing shade →
Restrained**, **Contour detail → Off**, **Small terraces → Off**, **Lift strength
→ None**, **Slope gait → On**, **Sunlight → On**, **Sun strength: 100%**,
**Sprite shadows → Proxy**, **Uphill slowdown: 60%**, and **Downhill quickening:
6%**. Uncheck **Sun follows the game clock** to enable **Time of day**.
Keep **Levels overlay → Off**, **Levels above and below fade to → Fog**, and
**Fog per level → Medium**. Close the dev panel between changes to judge the art.

Field coordinates below match the CI evidence; the original spawn is (70,96).
The screenshot HUD is not a control label or a coordinate overlay.

| Stop | Field tile | Time of day and what to watch |
|---|---|---|
| Owner's meadow | 86,75 | Boulder at 87,73, pines and birch at 87,78. Step through **9.6, 10.6, 11.3, 11.6, 11.9, 12.2, 12.5, 13.7, 16.8 h**. Watch trunk bases, the boulder's underside and your feet. |
| Hills meadow | 26,81 | **9.6, 12.0, 16.8 h**. Check feet and tree contacts on rolling ground, including overlapping evening shadows. |
| Knoll, sunny / shaded-facing sides | 86,87 / 86,96 | **12.0 h**. Compare the compact rounded hero shadow on the two receiving slopes. “Shaded” here names the hill's facing; it does not promise terrain occlusion. |
| Spire | View toward 40,40 from 40,52 | **16.8 h**. Check the long terrain shade; the hero is near the lower screen edge. |
| Terrain shade | 69,34 | **7.2 / 16.8 h**. Only faint foot contact should remain, without a dark directional body shadow. |
| Phone meadow | 86,75 | **9.6 h**, portrait. Check that feet and shadow remain readable beside the touch controls. |

At the meadow compare **Sprite shadows → Proxy / 2c silhouette** at **11.6 h**
and **16.8 h**. This compares caster shapes using the same new sun; it does not
restore the old noon spin. Return to **Proxy**. Try **Sun strength: 50% / 100% /
200%** if a contact is hard to see. The sun rises east, stays north at noon and
sets west. Its azimuth moves steadily at 15°/hour and elevation tops at 66°;
noon shadows stay short while dawn/dusk shadows lengthen.

The owner's questions, at every stop:

- Does every shadow leave from where the object touches the ground?
- Do the noon steps change gently?
- Does it look hand-made rather than a flat cutout?

Also check whether the hero's noon shadow now reads as a soft, rounded pixel-art
contact shape; whether a rock feels planted; and whether only faint contact
remains in terrain shade. Proxy bodies have a broader base, a narrower rounded
end and a one-world-pixel dithered rim. Trees use round crown slices above a
trunk; rocks use low rounded slices. Pixel snapping and ordered edge dithering
supply the handmade edge; direction stays continuous to avoid quantisation pops.

Projection uses the local receiving plane and the same sun as the ground.
Contacts persist faintly in terrain shade; overlapping sprite casts take the
darker value, and directional casts fade with terrain visibility. These local
proxies do not wrap around distant cliffs. The phone capture establishes
framing only; it does not establish mobile performance.

### Evidence and review (2d)

[Source CI run 39911879693](https://github.com/Solidsilver/glimway/actions/runs/39911879693),
code `a6a28250`, passed the GPU E2E suite: **17 passed, 0 flaky, 0 failed**.
All 2,878 local Node tests pass, including a raster regression for a rounded
noon body shadow on flat and sloping ground; all typechecks and Svelte checks
are clean. Playwright and Vite ran only in CI.

All 20 originals and 19 crops from this run were inspected at full size,
after inspecting the same 39 from the handoff run 39909944507. Originals,
matching state JSON and hashes are in [the 2d evidence index](lab/slopes/2d/README.md).

| Frames | Contact / noon progression / art judgment |
|---|---|
| Meadow, all nine times | Pine trunks and birch bases connect to their casts; the boulder has a small shadow emerging beneath its front. Each noon step moves a short shadow gently through south. Rounded proxy masses and pixel edges replace the recognisable sheared sprite drawing. |
| Meadow silhouette references, 11.6 / 16.8 h | The old flat tree outlines and long evening strips remain visible for comparison; both use the new sun path. |
| Hills meadow, 9.6 / 12.0 / 16.8 h | Bases stay planted across the rolling ground. The noon hero contact is rounder and shorter; evening casts stretch consistently and overlapping shadows retain one darkness. |
| Knoll, sunny / shaded-facing at noon | The hero's previous narrow rectangle is now a shorter rounded taper with a dithered rim. Both sides retain foot contact and respond to the receiving slope. These are facing-shade comparisons, not full terrain occlusion. |
| Terrain shade, 7.2 / 16.8 h | Hero terrain visibility and directional opacity are zero in both state samples. Visually, only a faint foot contact remains; tree casts also fade. |
| Spire, 16.8 h | Long terrain shade reads across the mountain. The original frames the feature with the hero at its lower edge; its centre crop cannot judge the hero's contact. |
| Phone meadow, 9.6 h | Hero, rock and trunks remain grounded and legible at portrait size; touch controls leave the relevant feet clear. |

Desktop time scrubbing through 41 sun positions recorded 237 rAF intervals:
**p50/p95 16.7 ms, p99/max 16.8 ms**, none over 33 or 50 ms. Raw intervals and
chunk costs remain in [2d-evidence.json](lab/slopes/2d/2d-evidence.json).
This short desktop sample and one phone still do not measure mobile pacing
or guarantee a worst-case world-streaming budget.

## Slopes lab, round 2c: one sun (exp/slopes-sun)

2026-10-22. Dev-only, on the same hand-made field. The 2b and 2a notes below
are historical; their fixed NW light and smoothstep speeds are superseded here.

## How to walk 2c

Open **Height lab → Walk the height lab**, then **Area → Slopes, hills and
passes**. Choose **Reset to Shading baseline**, then **Slopes, drawn as (round
1’s styles) → Shading by facing**. Reset now selects **Facing shade →
Restrained**, **Contour detail → Off**, **Small terraces → Off**, **Lift strength
→ None**, **Uphill slowdown: 60%**, **Downhill quickening: 6%**, **Slope gait →
On**, **Sunlight → On**, **Sun strength: 100%**, **Time of day: 12.0 h**, and
**Sun follows the game clock** unchecked. Existing numeric saved speeds are
preserved; old Off/Gentle become 0/12. Reset chooses the new recommendation.

The uphill range is **0–80%**, downhill **0–20%**, and sun strength **0–200%**.
The directional speed response is linear: at the owner's typical 0.10 uphill
component, 40/60/80% caps give ×0.84/×0.76/×0.68. Across the slope stays ×1.
Start with **60% uphill / 6% downhill**, compare **0% / 0%**, then **40% / 6%**,
and try **80% / 20%** as the strong endpoint. On the knoll's 56 px uphill run,
Node field times are 0.509091 s at 0%, 0.757295 s at 40%, 1.001386 s at 60%,
and 1.478355 s at 80%. The 60/6 downhill run is 0.485304 s. These are simulated
field travel times at 110 px/s, not browser frame measurements.

Keep **Levels overlay → Off**, **Levels above and below fade to → Fog**,
**Fog per level → Medium**, and close the dev panel to judge the picture.
At the owner's path between walls (about 72,48), move **Time of day** through
**7.2 h**, **12.0 h**, and **16.8 h**. The sun rises east, tilts north at noon,
and sets west; morning/evening light is warmer. Shadows go west in the morning,
south at noon and east in the evening. Revisit the knoll's north and south
sides (86,87 and 86,96), hills (30,88), outcrop approach (103,82), and spire
(view toward 40,40 from 40,52). At evening the spire casts a long terrain shadow.
Compare your own shadow in that shade with its shape in open sun.

**Sun follows the game clock** disables the manual slider and reads the
existing UTC game/server clock (06:00 dawn, 12:00 noon, 18:00 dusk). The existing
dev clock advances it; follow its reload instruction after advancing the server.
At night this area uses dim blue ambient. The lamp and cave lighting rework
remains out of scope. All paused cave controls and other lab areas remain.

The light layer uses 8 px texels per 24-tile chunk, Lambert normals from the
bilinear field, cool ambient, and half-tile terrain rays bounded to a 64-tile
halo. Ground albedo is cached independently of facing, sun strength and time.
Moving the sun invalidates only light jobs; nearest chunks update first under
a 3 ms frame budget, in four-row steps. Sprites sample that light map at their
feet. Their alpha masks are flattened and sheared with the same sun ray,
anchored at the foot, shortened/lengthened by the receiving slope, and faded
by terrain visibility. The old ground rims, contact strips, old face-atlas
lighting, and translucent contact shadows in the lab's prop atlas are gone.
The normal game's atlas is untouched. Silhouettes approximate a local plane;
they do not wrap across a distant cliff. Terrain shadows are bounded and the
low-resolution map softens their edge.

Questions for the owner:

- Is 60/6 enough uphill effort on the pass, while across-slope travel stays comfortable?
- Do all morning/noon/evening shadows agree, with the old west-side strip gone?
- Do the hero, Wren, trees and boulders feel planted, and does the silhouette shape help?
- Is the northward noon tilt enough to read the hills? Is dawn/dusk too warm or dark?
- Does fading a sprite's shadow in terrain shade read naturally?

### Evidence and performance (2c)

[Final source run 39895401202](https://github.com/Solidsilver/glimway/actions/runs/39895401202),
code `c35f8e92`: **15 browser tests passed, 0 flaky, 0 failed, 0 helper retries**
in 5.4 minutes. The suite includes the retained cave, generated-area and five
slope-preset regressions. Frontend checks and all 2,868 Node tests pass. Node
coverage includes linear speeds and migration; bilinear Lambert and ambient;
wall shadow direction/length; alpha projection and visible-foot bounds;
terrain-shadow fading; the tilted arc; shared chunk samples; and independent
albedo caching. Full repository verification also runs on CI.

The 13 new matching originals, state JSON, raw timing data and hashes are in
[the 2c evidence index](lab/slopes/2c/README.md). All 13 were inspected at full
size for cast direction, visible foot contact and fixed dark strips. Morning
casts go west, noon casts are short and southward, and evening casts go east.
The knoll and hills keep readable feet; the old west-side contact strip is
absent in the comparison views. The terrain-shade pair at 69,34 has visibility
**1 in morning / 0 in evening**; own-shadow alpha is **0.46 / 0**. The spire
frame shows the long terrain shade and shaded cliff material; it frames the
feature, with the hero near the lower edge. The phone frame keeps feet clear
of touch controls. The local-plane silhouette does not wrap across distant
cliffs; 8 px terrain samples soften the cast boundary.

Desktop is 1280×800 on the CI NVIDIA runner. **Time of day** was scrubbed through
41 positions, dawn to dusk, 80 ms apart. The retained sample is 242 browser rAF
intervals: **p50 16.7 ms, p95 16.8 ms, p99 16.8 ms, maximum 33.4 ms**, one
interval over 33 ms, none over 50 ms, and **no long tasks**. Scrubbing is smooth
in this measured desktop sample. Mobile scrubbing and long sessions remain
unmeasured; the phone evidence is a still frame.

| Light recompute scope | Completed chunks | Median | p95 | Maximum |
|---|---:|---:|---:|---:|
| Whole capture | 303 | 5.5 ms | 7.4 ms | 9.9 ms |
| Scrubbing only | 125 | 5.9 ms | 7.5 ms | 8.9 ms |

These are per-chunk CPU work plus texture-upload submission, summed over the
progressive steps, excluding time waiting between frames; they are not GPU
timer measurements or whole-frame costs. Jobs run nearest first under a 3 ms
frame budget. Distant chunks can catch up after a fast scrub. The albedo paint
counter stays **39 → 39** through the scrub, with identical hero position.
Sprite masks are shared by atlas frame and cached once; the sun changes only
their GPU transforms. An earlier per-caster canvas version had 250 ms scrub
p95; that was fixed before these retained frames. Transparent atlas padding
was also excluded so the projected foot meets the sprite's visible foot.

CI field times (56 px at 110 px/s):

| Uphill / downhill | Uphill | Downhill |
|---|---:|---:|
| 0% / 0% | 0.509091 s | 0.509091 s |
| 40% / 6% | 0.757281 s | 0.485246 s |
| 60% / 6% | 1.001552 s | 0.485246 s |
| 80% / 20% | 1.477760 s | 0.437460 s |

The retained five-preset runs match field time for every slider pair; the
Node plane tests check exact across-slope speed, monotonicity and rotation.
The recommendation remains **60% uphill / 6% downhill**.

Host audit: Playwright and the browser server ran only in CI. One early local
`npm run verify` also invoked its Vite production-build step, contrary to the
brief's host restriction; this was reported immediately, and no later local
Vite or browser work was run. Subsequent local checks used the individual
Node, TypeScript and Svelte commands in `nice -n 10 nix develop`.

---

# Slopes lab, round 2b: shading plus feel (exp/slopes-2b)

2026-10-22. A dev-only comparison on the same hand-made 144×144 field. Round 2b
adds speed sliders, coded slope gait and sunlight to the owner’s preferred
shading-by-facing view. The five drawing presets remain available. Hidden-ground
picking and the tunnel inside the lift are dropped from this round; caves reopen
with the terrain work. The older 2a comparison is retained below.

## How to walk 2b

Open **Height lab → Walk the height lab**, then **Area → Slopes, hills and
passes**. Click **Reset to Shading baseline**. This chooses **Facing shade →
Restrained**, **Contour detail → Off**, **Small terraces → Off**, **Lift strength →
None**, **Uphill slowdown: 12%**, **Downhill quickening: 0%**, **Slope gait → On**,
**Sunlight → On**, and **Sun strength: 100%**. Presets still change only their
four drawing controls. Old saved **Off** slowdown becomes 0%; **Gentle** becomes
12%. All cave controls and the other areas stay available.

Start with 12% uphill and 0% downhill. My comparison recommendation is **12%
uphill / 6% downhill**: at the knoll's roughly 0.2-level slope the directional
curve gives about 11% less uphill speed and 5% more downhill speed. Compare 0/0
first, then 12/6, then the deliberately strong 40/20 endpoints. The sliders
control speed, not time added. Crossing a slope remains ordinary speed; diagonal
input is normalized. Wren uses the same caps.

Keep **Levels overlay → Off**, **Levels above and below fade to → Fog**, **Fog per
level → Medium**, **Climbing, the camera → Eases out** fixed, and close the panel.
Visit the hills (30,88), the knoll's northwest side (82,87) and southeast side
(90,95), the saddle (72,31), the outcrop’s gentle approach (103,82), and rocky path
(53,42). At each stop compare **Sunlight → Off / On**. Off keeps the original
facing-shaded ground and contact shadows as a reference; On extends that sun to
sprite tints and soft SE cast shadows. At 100% the ground is shaded once, with
the same palette as the reference. With sunlight On, **Sun strength** scales the
ground facing response, sprite tint and cast-shadow opacity together.

Then walk up and down the knoll with **Slope gait → Off / On**. On follows actual
field speed, including collision, with a roughly one-pixel uphill lean or
backward downhill lean and an occasional three-pixel scuff near the walking
limit. Wren gets the same coded gait. This uses the existing walk frames; no new
art is necessary for this comparison. More convincing knee bends, planted feet
or an uphill boot push would require drawn uphill/downhill frames later.

Implementation: `sun.ts` supplies one NW direction, the ground-normal facing,
bounded sprite tint and local-plane shadow ray. Ground and sprites share the
facing response. Existing cliff lips already follow NW light. The cave light
pass works in screen space; sharing that mask would need extra handling for
overlapping lifted surfaces and add upload work. This round therefore uses cached
ground shading, per-sprite tint and one shared soft shadow texture, preserving
Wren's base tint. Shadows approximate the local receiving plane and use modest
caster heights; they do not trace across cliffs or make tree-shaped silhouettes.
The sun direction is a parameter for a later clock; no moving sun is added.

Questions for the owner:

- Do the sunny/shaded sides make the hero look planted on the knoll and hills?
- Does 12/6 give enough height feel, or is downhill at 0 more comfortable?
- Does the small lean help, and do steep-foot scuffs read as effort rather than noise?
- Are shadows strong enough to anchor trees and boulders while keeping routes readable?
- Would drawn uphill/downhill feet add enough to justify a later art lane?

### Measured browser tails and travel (2b)

[First pass, run 39868180623](https://github.com/Solidsilver/glimway/actions/runs/39868180623),
code `58a7473d`: **13 passed, 0 flaky, 0 failed, 0 helper retries**. Full repository
verification and smoke are green too. No Playwright or Vite was run on this host.
The first GPU attempt failed before tests because the host’s container manifest
referenced removed firmware. The owner refreshed it; the retry passed container
and NVIDIA renderer checks.

Desktop is 1280×800 on the CI GPU runner. The first-pass real-key walks combine
4 s east and 3 s north, with identical 12% uphill / 0% downhill controls and
slope gait On. Values are milliseconds; raw samples are retained in
[timing-first-pass.json](lab/slopes/2b/timing-first-pass.json).

| Sunlight | Walk p95 / p99 / max | Switch p99 / max | Upload p95 / max | Long tasks during walking |
|---|---|---|---|---|
| Off | 16.8 / 33.3 / 50.0 | 16.8 / 33.3 | 10.8 / 16.1 | One, 62 ms |
| On | 16.7 / 16.8 / 33.4 | 16.8 / 83.3 | 11.1 / 13.7 | None |

One sample does not show that sunlight is faster. The order is Off then On,
with scene restarts, a shared runner, progressive painting and cache reuse;
the 83.3 ms On switch shows that the whole-frame tail can still exceed the
5 ms scheduling target. Upload/paint samples are scene-lifetime distributions
through the walking sample, rather than isolated walking costs. The last 120
scene updates had p95/max 8.1/9.6 ms Off and 8.5/9.6 ms On. Phone frame costs
and long-duration/many-caster budgets remain unmeasured.

The corrected-capture repeat, [run 39871217203](https://github.com/Solidsilver/glimway/actions/runs/39871217203),
code `5d551760`, again passed all 13 browser tests with no flakes or helper retries.
Its raw data is in [timing.json](lab/slopes/2b/timing.json):

| Sunlight, repeated sample | Walk p95 / p99 / max | Switch p99 / max | Upload p95 / max | Long tasks during walking |
|---|---|---|---|---|
| Off | 16.8 / 33.2 / 1933.2 | 16.8 / 16.8 | 10.9 / 15.0 | One, 1944 ms |
| On | 16.7 / 16.8 / 33.3 | 16.8 / 83.4 | 12.3 / 15.3 | None |

**Unresolved tail:** the Off eastward walk had a 1.93 s rAF gap and a matching
1.944 s browser main-thread task. The scene’s >20 ms update log contains only a
41.8 ms entry (0 ms paint, 5.1 ms upload), so that instrumentation does not locate
the large stall. Unlike the earlier unassigned 2a rAF gap, the long-task observer
now confirms a main-thread stall, but it does not identify its cause. It cannot
be assigned to sunlight or the GPU from this evidence. The On run stayed at
33.3 ms or below; neither pass establishes a stall-free or mobile frame budget.

The deterministic field-time runs matched across **all five presets**, for
every slider pair. These measure movement policy; the separate real-key walks
above measure browser pacing.

| Uphill / downhill sliders | Up 56 px | Down 56 px | Near-across 32 px |
|---|---|---|---|
| 0% / 0% | 0.509091 s | 0.509091 s | 0.290909 s |
| 12% / 0% | 0.571785 s | 0.509091 s | 0.290970 s |
| 24% / 6% | 0.652089 s | 0.482639 s | 0.290031 s |
| 40% / 20% | 0.802346 s | 0.430483 s | 0.287829 s |

The near-across run is straight on a curved knoll, so it includes a small
downhill component. Exactly perpendicular movement on a plane stays ordinary
speed at every slider value, as the Node tests verify. Actual-key gait samples
at 40/20 measured cadence 0.636× uphill and 1.182× downhill, with small signed
leans and scuffs enabled at those slopes. The pure tests also cover rotation,
normalized diagonals, saved settings, tint bounds and shadow rays.

### Visual review (2b)

All 52 slope frames from the first pass were inspected, including the 13 new
sunlight frames at full size and a close view of the shaded-side feet. The
sunny-side hero keeps its warm contrast; the shaded-side sprite takes a bounded
cooler tint. The hero’s model shadow is 5.48 px on the sunny knoll and 21.10 px
on its shaded side, both cast southeast. In the images it stays soft and quiet,
with a readable contact at the feet. Trees and boulders gain the same directional
anchor. The saddle and rocky strip stay readable; the phone frame keeps the
hero’s feet clear of the controls. Ground facing still does most of the broad
relief work; this is a modest improvement to sprite grounding, not a complete
new slope silhouette.

The first outcrop pair framed the cliff and put the hero against the bottom
edge, which made foot contact hard to judge. The capture was moved to the
outcrop’s gentle approach, inspected at full size, and now keeps the feet and
shadow central. All 52 slope frames in the corrected run were inspected too.
The retained 2a cliff-foot reference remains available. The 13 selected originals,
matching state JSON and integrity hashes are indexed in
[the 2b evidence](lab/slopes/2b/README.md).

The round 2a notes below remain the historical comparison.

## How to walk 2a

Open the dev panel's **Height lab**, click **Walk the height lab**, then choose
**Area → Slopes, hills and passes**. In **Slopes, presets**, click
**Reset to Shading baseline**. Reset selects restrained shading with no contours,
terraces or lift, and **Uphill slowdown → Gentle**. Preset buttons change drawing
only; they preserve slowdown, fog, haze and camera settings. Settings persist for
the browser tab; old style/shading settings migrate to their equivalent controls.

For a visual comparison, set **Uphill slowdown → Off** and **Levels overlay → Off**.
Keep **Levels above and below fade to → Fog**, **Fog per level → Medium**, and
**Climbing, the camera → Eases out** fixed. Close the panel before walking. Stand
still and try each button in **Slopes, presets**:

| Exact preset label | Facing shade | Contour detail | Small terraces | Lift strength |
|---|---|---|---|---|
| Shading baseline | Restrained | Off | Off | None |
| Sparse contours | Restrained | Sparse | Off | None |
| Small terraces | Restrained | Off | On | None |
| Moderate lift | Restrained | Off | Off | Moderate (24 px a level) |
| Full lift reference | Current | Off | Off | Full (48 px a level) |

The independent rows are **Facing shade: Off / Restrained / Current**,
**Contour detail: Off / Sparse / Current**, **Small terraces: Off / On**,
**Lift strength: None / Moderate (24 px a level) / Full (48 px a level)** and
**Uphill slowdown: Off / Gentle**. **Slopes, drawn as (round 1’s styles)** keeps
**Shading by facing / Contour hints / Small terraces / True ¾ lift** as shortcuts.
The old “Slopes, with shading” row is now **Facing shade**.

Walk the same route for each preset. Coordinates below are field tiles, also in
[lab/slopes/2a-spots.json](lab/slopes/2a-spots.json). The lifted view moves drawing north,
while walking continues in field coordinates.

| Stop | Field tile | From spawn (70,96); what to judge |
|---|---|---|
| Rolling hills | 30,88 | West 40, north 8; can you tell which side is uphill without lines or HUD? |
| Pass foot → halfway → saddle | 72,70 → 72,48 → 72,31 | North through the gap; walk between the shoulders, watch Wren's loop. |
| Far side | 72,10 | Continue north over the saddle; does the compressed back slope remain readable? |
| Way around | 128,40 | East around the range, then north; an alternative to the pass. |
| Steep band | 56,46 | Walk north into the pale-stone rim; scree stops you. |
| Rocky path | 53,42 | Laid slabs beside scree; can shape alone identify the open strip? |
| Outcrop gentle side → cliff foot | 103,82 → 103,108 | Climb from the north, go round to the south; check lip, wall, talus and contact shadow. |
| Knoll | centred 86,91 | Prop-free cone east of spawn; walk straight up, down and across with slowdown Off, then Gentle. |
| Gully → sand flats | 45,112 → 45,134 | The one way through the sea cliff; a retained access fixture. |
| Plateau comparison | 132,110 → 132,100 | Built ramps and deliberate walls; full lift hides the back edge. |

Repeat the saddle with **Levels above and below fade to → Nothing**. Ground
should communicate relief without fog. Then compare **Uphill slowdown → Off / Gentle**
on the knoll and ordinary hills. Gentle samples the resolved field gradient in
requested movement direction: downhill and across retain full speed, uphill loses
at most 12% at the walking limit. Wren follows the same rule in this area; cave
and old ramp movement retain their previous behavior.

## Reconciled review and terrain contract

The round-1 review in `.agent/REVIEW.md` found two serious bugs: style changes
could strand the hero, and projected tile collision could authorize walking on
drawn steep/crag ground while reporting another surface's height. Both were fixed
before 2a: all styles now use **one field-space collision map and exact field-pixel
position**; lift projects drawing only. Regression tests exercise the reported
positions, actual movement after switching, and routes back to spawn. The server
must never reproduce the painter's projection to authorize movement.

Walkability uses the **maximum bilinear gradient at all four patch corners**,
with squared integer comparisons at 1/256 level, against **0.25 level per tile**.
The former centre-gradient check understated steepness. Full lift compresses a
continuous north-facing walkable patch to as little as one quarter of its field
height; that bound does not prevent a separate foreground ridge hiding it.

The generator lane now has a canonical **shared (w+1)×(h+1) Uint16 corner grid**,
heights 0–3840 in 1/256 level, with sparse four-corner overrides and explicit
intentional discontinuities. Expand that at the lab adapter boundary; this lab's
per-tile corners and prop collision kind are not the wire format. Keep ground
slope/steep/crag/cliff separate from cover. Shared TS/Go vectors should retain
chunk-border ownership/halos, cliff edges, interpolation, steepness thresholds
and edge-mean rounding. A 24×24 base grid is 1,250 raw bytes before overrides,
compared with 4,608 bytes for independent corners on every tile.

## Drawing and streaming changes

Restrained shade uses a saturating warm/cool palette shift, retaining grass color
and sprite contrast. After inspecting the faint hills, the shade response was
increased from 6 to 12: small gradients get a stronger cue while the warm/cool
palette endpoints stay fixed. Sparse contours put broken grass, soil and stone accents at
world-anchored one-level intervals, with light high edges and soft low edges;
they fade out toward steep rock. CI review found wall-like edges, so gaps now
cover half the world cells and the light/shadow pairs are thinner and softer.
The rocky slab strip has broader stones with shallow joints: its former heavy
mortar read as raised edging. Terraces remain visual: collision stays smooth.
Lift is consistently 0, 24 or 48 pixels per level for ground, feet, props, camera,
bounds and cache keys. The closed cliff footprint is drawn as talus at reduced lift.

Cliff rims, lips and contact shadows now follow north-west light. Lifted faces
are painted per pixel with their own height/fog, replacing whole-tile face joins.
Each lifted pixel column resolves its own field source, fixing vertical streaks
from the former middle-column sampling. East/west face-end lighting remains a
visual limitation. The hero's silhouette behind higher foreground ground remains;
companion/target visibility and picking are 2b questions.

The old “two chunks a frame is fine” claim was wrong: painting, splitting fog
bands and uploading whole chunks caused long movement frames. Pure painting now
yields, completed pixels are cached by field/drawing/chunk, and uploads yield by
band texture, one row of faces, eight props, or four grid rows. Upload and paint work share a
5 ms scheduling budget, including entry and preset restarts (the former visible-
window synchronous bypass is removed). Cold views fill progressively. Paint strips
are one tile wide/high and fog-band scans yield every sixteen rows. This is a
scheduling target, not a bound on a whole frame
or a single indivisible texture upload. Browser tails below are the evidence;
old Node totals of ~100 ms per chunk do not describe current frame costs.

## Per-preset observations

| Preset | What reads | Remaining question |
|---|---|---|
| Shading baseline | Quiet ground; warm and cool facing changes give broad hill shape, and the saddle's open route stands out between grey shoulders. | The gentle hills still compete with grass mottling. Is aspect shading alone sufficient while moving? |
| Sparse contours | Broken high/low accents locate the hills and the saddle's rise without the terraces' dense stripes. | Are fragments enough to identify the high side, and do any still suggest built edging? |
| Small terraces | The most explicit small-rise cues: lips and risers make the hills and uphill approach easy to trace. | They imply steps on a smooth surface, and dense bands remain conspicuous on scree. |
| Moderate lift | Less compression and smaller walls than full lift; the pass stays open and props meet the same ground. | The reserved talus below the outcrop is deeper than the face. Does this read as a deliberate apron? |
| Full lift reference | Tall mountains and the saddle's enclosing shoulders are unmistakable; the back-of-plateau silhouette still works. | Strong compression, stretched scree and tall talus make the blocked boundary more dominant; small hills still need facing cues. |

The rocky path tests access independently of material hue: laid slab shapes sit
beside the scree's downhill streaks. Its stair-stepped footprint remains visible.
The fog-off saddle keeps the opening readable in every preset. The phone frame
shows the moderate-lift halfway approach; it proves framing, not a mobile frame
budget. Tall north-facing field-boundary views can expose the finite lab's outer
edge, which is not an unpainted interior chunk.

## Measured browser tails (2a)

[Run 39834935093](https://github.com/Solidsilver/glimway/actions/runs/39834935093),
code `044da89c`, desktop 1280×800 on the CI GPU runner. Full E2E: **11 passed,
0 flaky, 0 failed, 0 helper retries**. The final 39 slopes frames were all inspected;
24 originals and their state JSON are in the [evidence index](lab/slopes/README.md).
The targeted height-lab/dead-export Node suite passed all 76 tests locally; full
repository verification runs in CI. No Playwright or Vite was run on this host.

All values below are milliseconds. Walking combines the 4 s east and 3 s north
real-key runs. Switch recording spans the restart, progressive painting/upload,
wait for all pending work, and a 250 ms settle. It measures the whole browser,
not just Phaser update. Raw samples and long tasks are retained in
[2a-timing.json](lab/slopes/2a-timing.json).

| Preset | Walk p95 / p99 / max | First-tour switch p99 / max | Repeat at spawn p99 / max | Upload p95 / max |
|---|---|---|---|---|
| Shading baseline | 16.7 / 16.8 / 33.3 | 16.8 / 66.7 | 16.8 / 33.3 | 9.3 / 9.8 |
| Sparse contours | 16.8 / 33.3 / 33.4 | 33.3 / 66.6 | 16.8 / 33.4 | 10.2 / 11.9 |
| Small terraces | 16.7 / 16.8 / 16.8 | 16.8 / 49.9 | 16.8 / 33.3 | 9.7 / 10.4 |
| Moderate lift | 16.8 / 16.8 / 16.8 | 16.8 / 66.6 | 16.8 / 50.1 | 5.2 / 5.4 |
| Full lift reference | 16.7 / 16.8 / 16.8 | 16.8 / 66.6 | 16.8 / 50.0 | 5.3 / 5.6 |

Walks recorded **no browser long tasks ≥50 ms**; first-tour preset switches
recorded 53–73 ms main-thread tasks, and the repeated moderate/full switches
recorded 52 ms tasks. Most pacing is 16.7–16.8 ms; a 5 ms work budget still is
not a 5 ms frame guarantee. Paint p95 was 7.0–8.2 ms, with a 25 ms maximum.
The paint/upload columns are scene-lifetime samples through the walk, including
entry work, rather than isolated walking-only step costs.

The previous pass had flat-style upload maxima of 48–49.9 ms; splitting faces,
props and grid work brought these to 9.8–11.9 ms here. That previous pass also
had **one 2166.6 ms sparse-switch rAF gap**, absent from the lab's >20 ms update
log. It did not recur in this final pass. Its cause remains unassigned; there
was no long-task observer in that run, so it cannot be blamed on the GPU or CI
host from these measurements alone. The raw evidence is preserved in
[2a-timing-before-final-batching.json](lab/slopes/2a-timing-before-final-batching.json).

Repeat switching follows the tour at one fixed spawn location. The 48-chunk pixel
cache can evict earlier presets, so this is a repeat/cache-reuse test, not a promise
that every chunk was cached. Complete pending-window fill took roughly 4.3–5.4 s
including the settle wait; the first chunks appear progressively, not after that
whole wait. A cold view can therefore show loading gaps. Memory and phone frame
tails remain unmeasured. Short fixed walks also do not establish a world-wide
streaming budget or worst-case performance.

For every preset, the same knoll run took **0.571788 s uphill over 56 px** with
Gentle, **0.509091 s downhill over 56 px**, **0.290976 s across over 32 px**, and
**0.509091 s uphill with Off**. Every destination and field time matched across
all five presets. The uphill cap refers to speed loss (12%), not time added.

## Evidence and owner questions

The CI-only `e2e/height-lab-slopes.spec.ts` captures six matching spots under each
preset, a fog-off saddle under each, and a moderate-lift phone frame, all with
HUD and overlays hidden. JSON beside each PNG records field position, height,
kind and settings. `timing.json` records raw rAF intervals and p50/p95/p99/max,
counts over 33/50 ms, browser long tasks where supported, paint/upload/update
distributions and slow-frame attribution.
It compares exact uphill/downhill/cross-slope knoll runs across all five presets,
including an uphill Off reference. These simulated field-time runs check movement
policy; the separate real-key walks measure browser frame pacing.

Questions for the owner after walking:

- Which presets should survive into 2b? Is restrained shade enough to read gentle hills?
- Do sparse accents indicate the higher side, or resemble walls/laid edging?
- Do terraces help access reading enough to accept their visible striping and implied steps?
- Does moderate lift give enough height while keeping the far side and routes legible?
- Does the rocky slab strip read as walkable beside blocked scree without depending on hue?
- Is Gentle perceptible but comfortable uphill? Keep the 12% cap or reduce it?
- For surviving lifted styles, which hidden-ground/companion/picking failures should 2b resolve first?

No style is selected for production. Cave mouths, tunnel projection, hidden-route
targeting and valley mist are deferred; all existing cave-levels “Paused” controls
remain available in their original areas. Do not infer phone performance from a
single phone screenshot or desktop timings.
