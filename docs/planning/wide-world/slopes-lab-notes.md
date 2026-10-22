# Slopes lab, round 2a (exp/slopes-lab)

2026-10-22. A dev-only comparison on the same hand-made 144×144 field. The owner
wants visible height, readable routes and combat, and gentle uphill slowdown.
This round supplies the five drawing presets; hidden-route/picking, tunnel and
valley-mist work is deferred to 2b for the surviving styles.

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
(90,95), the saddle (72,31), the outcrop cliff foot (103,108), and rocky path
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
pass works in screen space; a second full-screen mask would lose field/sprite
ownership on lifted views and add upload work. This round therefore uses cached
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

Round 2b CI evidence and measured frame tails are added below after inspection.
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
