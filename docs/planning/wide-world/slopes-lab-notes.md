# Slopes lab, round 2a (exp/slopes-lab)

2026-10-22. A dev-only comparison on the same hand-made 144×144 field. The owner
wants visible height, readable routes and combat, and gentle uphill slowdown.
This round supplies the five drawing presets; hidden-route/picking, tunnel and
valley-mist work is deferred to 2b for the surviving styles.

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
[lab/slopes/spots.json](lab/slopes/spots.json). The lifted view moves drawing north,
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
they fade out toward steep rock. Terraces remain visual: collision stays smooth.
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
band texture, six rows of faces, then props/grid. Upload and paint work share a
5 ms scheduling budget, including entry and preset restarts (the former visible-
window synchronous bypass is removed). Cold views fill progressively. Paint strips
are one tile wide/high and fog-band scans yield every sixteen rows. This is a
scheduling target, not a bound on a whole frame
or a single indivisible texture upload. Browser tails below are the evidence;
old Node totals of ~100 ms per chunk do not describe current frame costs.

## Evidence and owner questions

The CI-only `e2e/height-lab-slopes.spec.ts` captures six matching spots under each
preset, a fog-off saddle under each, and a moderate-lift phone frame, all with
HUD and overlays hidden. JSON beside each PNG records field position, height,
kind and settings. `timing.json` records raw rAF intervals and p50/p95/p99/max,
counts over 33/50 ms, paint/upload/update distributions and slow-frame attribution.
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
