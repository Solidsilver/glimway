# Slopes lab: recommendations for the next comparison round

2026-10-22. Design brief following review of the uploaded
`procedural_elevation_and_ui_reference.md` and the owner's answers. This document
proposes lab additions; it does not implement them or select a production style.

## 1. What the owner wants to decide

The owner wants **a balance between convincing visible height and readable routes
and combat**, with **a gentle uphill slowdown** on ordinary hills. Climbing could
come later, so steep ground and crags should remain distinct terrain that future
equipment or abilities can open.

The lab should answer:

1. Which combination makes gentle hills and tall mountains read clearly while walking?
2. Can players find a pass, a way around, and a tunnel without diagnostic overlays?
3. How much vertical lift helps before compressed slopes and hidden ground hurt play?
4. Does uphill slowdown feel gentle and consistent in every direction and drawing style?
5. Which atmosphere and detail effects add depth without obscuring the world?

**Recommended starting combination:** directional shading, restrained material
changes, sparse contour accents, and gentle uphill slowdown. Compare that with
moderate lift and the existing full lift before choosing. Retain small terraces
as a comparison option because the owner previously requested them.

All numerical settings below are proposed lab starting values, not owner-approved
balance constants or measured results.

## 2. Start from the existing work

Read [terrain-decisions.md](terrain-decisions.md),
[slopes-gen-notes.md](slopes-gen-notes.md), and the slopes worktree before building.
Paseo located the lab workspace at:

`/home/solidsilver/.paseo/worktrees/3bmbzaxc/exp-slopes-lab`

Inspected worktree head: `54705947`. The main checkout was on `dev` and did not
contain the lab lane. Recheck branch state when resuming. Merge and release
decisions belong to the existing workflow.

The worktree already contains:

- A hand-made 144×144-tile area with hills, a two-massif range, a pass, a way
  around, steep scree, crags, a level-15 spire, an outcrop, a sea-cliff edge/gully,
  and a plateau comparison patch.
- Shading, contour hints, small terraces, and full ¾ lift, with optional shading
  under the other styles. Ground uses the Wilds painter; scree has directional
  detail and the steep boundary has pale stones.
- Fog by height difference, scaled for the taller mountains.
- Field-space walking in every style, four-corner steepness checks, and exact
  field-position preservation when changing style.
- A silhouette for the hero when higher foreground terrain hides them; other
  hidden movers are currently suppressed.
- Incremental painting, caching, and slow-frame paint/upload diagnostics.

**Do not rebuild these as new features.** The worktree's
`docs/planning/wide-world/slopes-lab-notes.md` predates review fix `6eb60556` in
several places: walking no longer uses the projected map. Head also contains
later performance instrumentation. Update those notes when extending the lab.
Verify current behavior rather than treating old cost estimates as measurements
of head. Existing evidence does not validate new options or every later fix.

The generator experiment on `dev` supplies a separate canonical surface contract:
shared Uint16 corners in 1/256 level, sparse overrides, explicit discontinuities,
and slope/steep/crag/cliff kinds. Its straight ranges demonstrate geometry/access,
not the target natural appearance.

## 3. Controls and comparison presets

Keep the four styles and extend their controls so the owner can isolate one
effect on the **same terrain, at the same field position and camera zoom**.
Visual changes must preserve movement edges and terrain kinds.

| Control | Proposed choices | Purpose |
|---|---|---|
| Facing shade | Off / restrained / current | Compare relief against texture and sprite contrast |
| Contour detail | Off / sparse / current | Try occasional cues without striping every hillside |
| Small terraces | Existing style | Retain the comparison; collision stays smooth |
| Lift strength | None / moderate / current full | Compare height against compression and occlusion |
| Rock detail | Existing / refined directional | Compare clarity, rather than adding random noise |
| Uphill slowdown | Off / gentle | Separate movement feel from projection |
| Valley atmosphere | Off / subtle tint / tint + local mist | Isolate atmosphere from essential height cues |
| Test lighting | Day / dim or night | Check readability as ambient light changes |

Offer these presets instead of requiring every possible combination:

| Preset | Configuration |
|---|---|
| Shading baseline | Restrained shade; no contours, terraces, lift, or valley effect |
| Sparse contours | Baseline plus sparse contours |
| Small terraces | Existing terraces with restrained shade |
| Moderate lift | Baseline plus moderate lift; optional sparse contours |
| Full lift reference | Current full lift plus facing shade |

Compare visuals with slowdown off first, then compare Off/Gentle on the favored
presets. Preserve existing fog, haze, and camera zoom controls; fix their values
across an A/B comparison. Include a fog-off pass to prove the ground communicates
relief. Provide reset to a documented preset and safe migration of saved settings.

## 4. Shading, contours, rock, and cliffs

### Directional shade and consistent lighting

Use the current north-west relief-light direction as the starting point. Resolve
the documented conflict with cliff lips that assume light from the south.
Terrain, cliff rims, contact shadows, and placed props should agree sufficiently
that a rise does not read as a hole.

Use restrained palette shifts rather than unrestricted black/white multiplication.
Preserve grass color identity and hero contrast. If gentle hills need stronger
cues, tune the shade response before globally darkening mountains. Keep structural
relief readable at night without pretending the daytime sun remains fully present;
coordinate it with existing lighting.

### Sparse contour accents

Keep current half-level contours as a reference. Add a sparse mode with fewer
bands and/or sections masked into broken grass tips, soil edges, and stone
clusters. Suppress dense bands on steep rock. The bright/dark pair should help
identify the high side without resembling a retaining wall.

Inspect at game zoom and in motion. Anchor patterns to world coordinates so they
do not crawl as the camera moves. Terraces and contours remain visual treatments
of the same smooth walking surface.

### Material cues and directional detail

Refine existing scree rather than replacing it wholesale. Compare broad, quiet
material masses with a few downhill stone runs and fractured crag accents. Keep
variation smooth around changing slope aspect: a rotating local noise frame must
not create swirls, seams, or unstable texture near flat summits.

Material alone is not the movement rule. Include walkable rocky ground and a
stone path or built-step strip beside steep rock. Shape and detail, as well as
color, should distinguish walkable rock from blocked mountainside. This fixture
uses an already walkable strip unless built-step access already exists; adding a
new step-access mechanic is outside this comparison.

Give intentional cliffs readable lips, toes, contact shadows, and side joins.
Inspect east/west joins, corners, and diagonal edges rather than prescribing 45°
bevels everywhere. Correct known jagged face/ground joins and face-fog sampling
where still present. Keep shadows conservative enough to preserve routes below.

## 5. Moderate lift and visibility

Current full lift is **48 world pixels per level**: three 16-pixel rows. Start
the moderate comparison at **24 pixels per level**, retaining 48 as the reference.
Do not lower mountain heights to make the comparison work.

For `screenY = fieldY - k × height + margin`, use consistent units. With the
gradient in levels per tile, vertical compression is
`1 - (k / TILE_PX) × dh/dy`. At the 0.25 walking limit, 48 pixels/level can
compress a north-facing walkable patch to one quarter of its field-space height;
24 reduces that compression. This does **not** guarantee visibility behind a
separate ridge or cliff.

Parameterize the complete presentation coherently: ground, cliff faces, props,
feet, effects, camera target, projected bounds, and input mapping. Preserve the
local cliff collision footprint. Reduced lift must not leave an unexplained
reserved strip: render it intentionally, for example as talus, and inspect the
result. Do not displace an already expanded cliff twice. Include relevant
settings in paint-cache keys.

Keep movement, speed, and authoritative access in field coordinates. Where one
screen point overlaps several surfaces, define picking using the visible surface
and interactable ownership rather than assuming one global inverse transform.
Do not secretly change speed to compensate for screen compression.

Use the existing silhouette as the starting visibility policy. Add a short route
behind a ridge/plateau with a companion, target marker, resource, and cave-mouth
marker. If silhouette alone fails to make the route readable, trial a small local
terrain reveal around the hero as a second policy. Build that alternative only
if the existing policy fails the route test.

Check that players can:

- Follow the route without watching HUD coordinates.
- Distinguish hidden ground from blocked ground.
- Keep track of a companion and understand when a target is out of sight.
- Click the apparent object without selecting another surface or level.

Use lab targets or existing interactions; a new combat system is outside this
brief. Visibility does not implicitly grant attacks/interactions through rock.
If real targeting is absent, label marker checks as a proxy and leave full combat
validation explicitly unresolved.

## 6. Gentle uphill slowdown

The current hero rule applies a blanket 0.8 multiplier on `KIND.slope`, including
downhill and cross-slope travel. Replace that rule **for the smooth slopes area**
with a directional comparison. Preserve older cave/ramp behavior unless reviewed
separately.

For normalized requested field movement direction `d`, compute the local resolved
bilinear gradient `g` in **levels per tile**. The gradient points uphill. A proposed
starting curve is:

```text
uphill = max(0, dot(g, d))
t = clamp(uphill / 0.25, 0, 1)
speedMultiplier = 1 - 0.12 * smoothstep(0, 1, t)
```

This caps the starting slowdown at 12% on the steepest ordinary uphill ground,
with much less effect on gentle hills. Offer Off/Gentle; expose the cap as a
slider only if the initial comparison warrants it.

Requirements:

- Flat, downhill, and perpendicular-to-gradient travel retain ordinary speed.
- Normalize diagonal input. Rotating the hill and movement together gives the
  same result. Use surface derivatives rather than a texture or screen slope.
- Apply the same policy to comparable companions so Wren's loop remains useful.
  Sample continuously and substep as needed to prevent boundary pulses and
  frame-rate-dependent travel.
- No downhill acceleration, automatic sliding, stamina, or climb animation in
  this round. Steep/crag/cliff access remains unchanged.

Expose gradient, uphill component, multiplier, and field travel time in optional
diagnostics. Record uphill/downhill/cross-slope runs on a constant slope. The same
run must take the same field-space time in every style; projected distance differs.

## 7. Valley atmosphere as an optional comparison

Use one modest hollow and one elevated hollow, adding fixtures only if needed.
Compare subtle cool tint and low mist. Drive the mask from an authored local
basin or bounded surrounding relief; `height < 0` is unsuitable and the unsigned
surface format need not change.

Keep basin mist separate from existing fog above and below the hero. Limit
opacity, preserve feet and path edges, and compare the identical scene without
mist. Allow dry hollows to look dry: do not turn every valley into a marsh or add
moisture-dependent vegetation generation here.

This comes after shading, movement, and visibility. Retain it only if it adds
depth without hiding essential terrain information.

## 8. Test route and missing fixtures

Reuse the hills, pass, way around, spire, outcrop, gully, and plateau. Add compact
fixtures only where they answer a missing question:

| Fixture | What it proves |
|---|---|
| Matching N/S/E/W and diagonal slopes | Readability and slowdown work in every direction |
| Back side of hill and plateau | Compression, occlusion, silhouette, picking |
| Rocky path beside steep scree | Access cues work without relying only on hue |
| Tree, boulder, companion, target, resource on a slope | Feet, shadows, sorting, interaction anchors agree |
| Negative-coordinate chunk seam | Heights, contours, textures, projected bounds join |
| Low hollow and elevated hollow | Atmosphere follows local shape rather than absolute altitude |
| Short tunnel under a shoulder, with two mouths | Route under a mountain; projected mouth integration |

Reuse existing cave layers and transitions for the tunnel. Preserve the owner's
Even/3-tile default and existing alternatives. Cave-layer identity stays separate
from surface elevation. Mouth floors, lintels, and approaching feet must meet in
each view. Do not claim lift is integration-ready while its cave entrance is
only an unprojected marker. If the stub needs substantial cave architecture,
record that blocker and finish the independent comparisons first.

Walk both ways: hills → uphill approach → pass → far side → way around → hidden
route → tunnel → outcrop → gully. Inspect daylight and dim light, sparse and denser
vegetation, desktop and phone. Add a non-snowy high-altitude surface option so snow
does not carry the height cue alone; this does not decide future snow biome rules.

## 9. Order of work and evidence

1. **Resume and reconcile.** Finish outstanding review/CI work in the existing
   lane and update stale notes. Record baseline behavior and frame costs. Retain
   existing tests and fixtures.
2. **Core comparison.** Add restrained shade, sparse contours, coherent moderate
   lift, and gentle directional slowdown. Fix conflicting cliff lighting.
3. **Readability and integration.** Add missing orientation, picking, hidden-route,
   and tunnel checks. Refine rock and cliff joins where they help the comparison.
4. **Atmosphere.** Compare tint/mist and non-snowy high ground after core relief
   is readable.
5. **Owner playtest.** Supply the route, presets, observations, limitations, and
   questions. Record a choice before promotion to the normal game.

Capture matching screenshots at hills, saddle, far side, cliff join, hidden route,
and tunnel mouth, plus short movement recordings and at least one phone route.
Save field position, settings, height, kind, speed multiplier, and frame diagnostics
beside evidence. Inspect normal play with overlays off; diagnostics explain failures.

Use targeted tests for meaningful invariants: all-corner access, directional
slowdown and rotation, unchanged field position/access across styles, picking
ownership, and cave-entry continuity. Run applicable repository checks during
implementation; screenshots cannot prove reachability.

Measure cold painting, cache reuse, upload stalls, memory, and frame-time tails
while walking and changing style. Existing incremental painting is the starting
point. A 5 ms paint-step target does not establish a smooth whole frame. Do not
infer phone performance from Node timings or rewrite the renderer as a GPU shader
without measured need. Report loading gaps and stalls as well as steady-state FPS.

The comparison is ready for an owner decision when the same terrain is walkable
under every preset, slowdown matches the stated policy, height/access are readable
without overlays, and remaining cave, targeting, or performance failures are
clearly demonstrated rather than hidden by selected screenshots.

## 10. Keep outside this round

Do not rebuild the world generator, migrate production heights, alter held land,
add water simulation, introduce climbing gear, or redesign the UI/art catalogue
in this lab extension. Preserve steep/crag kinds for future climbing and hollows
and continuous slopes for future water.

Natural range networks, varied orientations, less regular pass placement, drainage,
and world-wide access planning remain generator research questions. A small
hand-made diagonal ridge helps here; a generator rewrite is unnecessary.

The uploaded research is inspiration, not an algorithm contract. Its downhill
gradient label and uphill projection claim are incorrect; its slope bands use
incompatible units; altitude-only valley rules are too narrow. Current surface
and access contracts take precedence. The hotbar 0 is the empty-hands key, and
mailbox inputs already have styling; those suggestions do not belong in this work.
