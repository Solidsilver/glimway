# Slopes by default: generator experiment

2026-10-21, `exp/slopes-gen`, recipe `slopes-gen@1`. This is a Go/world-lab
experiment. The live generators, protocol, database, normal world, and
`src/game/height-lab/` are unchanged. The companion lane can join the chosen
drawing style to this geometry after the owner's playtest.

The three home atlases each certify **2,304 chunks / 1,327,104 tiles**, from
chunks **−24..23** on both axes. Each has **four passes, four isolated spires,
four tunnel candidates, and zero unintended stranded components or tiles**.
The source needs **levels 0–15**: ordinary mountain ribs stay below the spires,
which deliberately reach 15. No heights are clipped to fit the codec.

## Recipe and shared contract

The shared starting values are unchanged: absolute corner heights in **1/256
level**, **0–15** levels, a maximum walkable gradient of **1 level in 4 tiles**,
and the four kinds **`slope`, `steep`, `crag`, `cliff`**. `SlopeWalkLimit` is the
single named steepness constant. Flat ground is `slope`; steep rock and crags
retain their kinds even though their floor is currently closed.

`wilds.SlopeSampler` samples lane B's existing Upland and Relief at globally
aligned **8-tile nodes**, bilinearly interpolates, then quantizes each absolute
corner once. It caches nodes only within that sampler; neither neighbouring
chunks nor generation order can change a corner. Negative coordinates use
floor division. Biome borders never multiply or step height.

- Low country starts with `2.8*Upland`, with Relief scaling a gentle, ±0.22-level
  rolling term at roughly 37/43 tiles. Upland retains lane B's apron and low
  shoulders. A continuous distance envelope keeps Town, other fixed places,
  the Tangle, and about one chunk outside them flat. Lower shoulders rise
  over 3–6 chunks; mountain features fade in from 6–10 chunks out.
- Bounded **24×24-chunk feature owners** each choose a seed-jittered E–W range.
  Its half-length is 176–192 tiles, lower shoulder half-width 96 tiles,
  upper rib half-width 16 tiles, and lift `6 + 4*Upland` levels. The lower
  three levels are broad and smooth; the remaining lift concentrates near
  the crest. A small Relief-scaled serration roughens only the crown.
- Each range has a smooth **64-tile-half-width saddle**. It removes 98% of
  the narrow upper lift and lowers the broad shoulder to 35% at its centre.
  The certified central crossing is three tiles wide. Routes are found on
  the final quantized walking graph, rather than painted across obstacles.
- A 12–14-tile jagged crest mask makes a deliberate **crag ribbon** on either
  side of the saddle. Gradient above the limit becomes **steep**. Gradient
  checks use the Euclidean gradient at all four corners of the bilinear tile,
  which bounds its whole interior, including diagonal motion.
- A nearby **spire** has a 16-tile radius, steep outer sides and a small flat
  crown at level 15. Its footprint is marked unreachable *before* connectivity
  is calculated. Each seed has four deliberately isolated crown components,
  **208 walkable summit tiles** in total. No other disconnected floor gets
  that exemption.
- A one-sided **outcrop** rises gently over a 64-tile northern approach,
  tapers across 38 tiles each side, then drops about two levels southward.
  Only its intentional scarp mask casts a south face. Whole-level drops use
  exactly three rows per level; fractional drops round the footprint up.
  `ResolveSlopeSouthFace` exposes exact lip/toe heights and face row/span for
  future sea/lake-shore callers without implementing water.

The certificate flood-fills exact matching corner pairs on the final kind
graph and roots at the real home anchor **(12,30)**. Cropped borders never imply
access. A failed certificate prevents that preview from being emitted. A
10×4-pixel hero fits cardinal tile-centre routes within 16-pixel tiles; mounts,
free diagonal corner cutting and future projected geometry need their own
clearance checks. Cover and water do not enter this height-only certificate.

Two findings changed the first implementation, without changing the contract:
integer distance steps made tiny slope slivers near sharp ribs, so the mountain
envelope now uses continuous Euclidean distance; a five-tile crown left tiny
usable slivers between its rock and steep sides, so the intentional crag ribbon
now overlaps the steep sides. The final geometry rejects no floor based on its
component size and never labels a failed ordinary component intentional.
Image inspection also caught downhill samples casting faces outside the scarp;
the explicit outcrop mask now prevents that, with a regression test.

## Travel and access

Each pass crosses between `(passX, rangeY−104)` and `(passX, rangeY+104)`:
**208 tile steps**. For the alternative, close only the saddle's neck
(`|x−passX| < 64`, `|y−rangeY| < 24`) and run shortest-path BFS on the same
final geometry between the same endpoints. This lets a walker use the real
tapered end of the rock ribbon; forcing them outside the nominal mountain
footprint would inflate the reported detour. These are cardinal tile distances,
not travel times or a cost-weighted trail plan.

| Seed | Passes | Pass steps | End-route steps | Extra steps | Maximum pass rise/tile |
|---|---:|---:|---:|---:|---:|
| map | 4 | 208 | 496–518 | 288–310 | 0.0228 |
| slopes-17 | 4 | 208 | 470–526 | 262–318 | 0.0262 |
| slopes-991 | 4 | 208 | 492–528 | 284–320 | 0.0238 |

The pass gradients are well under the 0.25 limit; the complete walkable country
includes tiles exactly at the limit. All twelve ranges have their certified
pass and an end alternative. Each atlas has one ordinary home-connected
component plus four intentional summit components. Home-connected tile counts
are **1,292,119 / 1,291,939 / 1,291,612**, respectively for `map`, `slopes-17`,
and `slopes-991`.

Each tunnel candidate is a **48-tile shoulder crossing**, with **28–29 blocked
tiles** and both potential entrances already home-connected. The pink view
shows candidates only. No terrain is opened, excavated or reserved for a tunnel.

## Kinds by biome

These are percentages of **every tile's effective biome**, including lane B's
blend patches and protected-place overrides, across each entire domain.
They measure these three home windows, not world-wide biome quotas.

| Seed | Biome | Slope % | Steep % | Crag % | Cliff % |
|---|---|---:|---:|---:|---:|
| map | hearthwick-woods | 97.263 | 0.324 | 2.369 | 0.043 |
| map | tops | 97.322 | 0.358 | 2.229 | 0.090 |
| map | whitequiet | 97.589 | 0.295 | 2.054 | 0.063 |
| slopes-17 | hearthwick-woods | 96.940 | 0.364 | 2.594 | 0.102 |
| slopes-17 | tops | 98.143 | 0.215 | 1.642 | 0.000 |
| slopes-17 | whitequiet | 97.039 | 0.587 | 2.302 | 0.071 |
| slopes-991 | hearthwick-woods | 96.943 | 0.436 | 2.533 | 0.088 |
| slopes-991 | tops | 97.220 | 0.418 | 2.282 | 0.080 |
| slopes-991 | whitequiet | 98.030 | 0.275 | 1.695 | 0.000 |

## Bytes and timings

The new **lab envelope** packs a shared 25×25-corner lattice into 12 bits per
corner: four coarse bits and eight fractional bits. Uniform corner heights use
a two-byte value. Two-bit kinds and a one-bit intentional mask remain distinct;
cliff tiles append six-byte exact face records. Decode rejects truncation,
padding/trailing bytes, wrong versions, broken shared corners, overflowing
heights, bad spans and walkable gradients past the limit. It canonicalizes by
re-encoding. The old spike's 434-byte uniform height envelope becomes **222
bytes** here; a general smooth chunk is **1,158 bytes**. The old 2-bit height
recipe cannot represent this country and is not used for a fake comparison.

Whole-chunk sizes are the actual undressed `WorldChunk` protobuf size plus the
length-framed height envelope. They include ground and solid planes, but no
plants, entities, biome palette overhead or production height schema. Maximum
bare whole chunks across all 6,912 measured chunks are **2,418 / 2,328 / 2,430
bytes**, leaving at least **3,714 bytes** of the **6 KiB** budget for dressing.
This establishes headroom, not the final dressed payload budget.

Each image is a fresh worker process. Warm measurements create a fresh bounded
sampler and generate and encode the complete height chunk: **80 timed samples
after one warm-up**, nearest-rank percentiles. Decode, certificate inspection,
and the old protobuf-size calculation are outside the timer. No clipping of a
precomputed plan is passed off as generation time. Runs use `nix develop`,
nice 10 on the shared host, so the JSON preserves wall-clock variation.

| Seed | Terrain | Height bytes | Bare whole bytes | Warm p50 / p95 / max ms |
|---|---|---:|---:|---:|
| map | flat | 222 | 658 | 0.486 / 0.499 / 0.571 |
| map | hills | 1,158 | 1,596 | 1.008 / 1.016 / 1.020 |
| map | mountainside | 1,158 | 1,596 | 0.955 / 0.964 / 0.967 |
| map | spire | 1,158 | 1,596 | 1.000 / 1.010 / 1.028 |
| slopes-17 | flat | 222 | 658 | 0.487 / 0.495 / 0.523 |
| slopes-17 | hills | 1,158 | 1,596 | 1.012 / 1.018 / 1.134 |
| slopes-17 | mountainside | 1,158 | 1,596 | 0.963 / 0.971 / 0.976 |
| slopes-17 | spire | 1,158 | 1,596 | 1.021 / 1.046 / 1.192 |
| slopes-991 | flat | 222 | 658 | 0.487 / 0.498 / 0.552 |
| slopes-991 | hills | 1,158 | 1,596 | 1.012 / 1.026 / 1.347 |
| slopes-991 | mountainside | 1,158 | 1,596 | 0.962 / 0.976 / 1.014 |
| slopes-991 | spire | 1,158 | 1,596 | 1.035 / 1.050 / 1.221 |

Cold field assembly is about **2–3 seconds for all 2,304 chunks**; the complete
diagnostic, including exact biome counts, encoding/decoding every chunk, paths
and image, takes about **5–7 seconds**. It is an offline preview, not a claim of
a 250 ms cold region solve. Every measured warm p95 remains below **5 ms**.

## Images inspected and reproduction

I opened and inspected **all nine PNGs**. Each has the same filename plus
`.json` as its sidecar, with full-domain metrics even for crops and atlases.

| Image | What to inspect |
|---|---|
| [map-height.png](lab/slopes-gen/map-height.png) | Continuous hills, broad mountain sides, saddles and isolated spires; altitude colours and hillshading. |
| [map-kinds.png](lab/slopes-gen/map-kinds.png) | Green slope, ochre steep, purple-grey crag ribbons, dark intentional outcrop faces. |
| [map-routes.png](lab/slopes-gen/map-routes.png) | Gold passes and cyan measured end routes on the actual walking graph. |
| [map-reach.png](lab/slopes-gen/map-reach.png) | Home green, deliberate spire footprints purple; no stranded pink. |
| [map-tunnels.png](lab/slopes-gen/map-tunnels.png) | Four pink candidate crossings with white entrances. |
| [map-atlas.png](lab/slopes-gen/map-atlas.png) | Chunk-centre height atlas around home, gold pass markers and purple spire markers. |
| [slopes-17-atlas.png](lab/slopes-gen/slopes-17-atlas.png) | Independent seed, same access contract. |
| [slopes-991-atlas.png](lab/slopes-gen/slopes-991-atlas.png) | Third seed, same access contract. |
| [map-range-close.png](lab/slopes-gen/map-range-close.png) | Three pixels per tile: smooth sides, saddle and a much taller spire. |

The `map` geometry digest is identical across all seven independent workers,
views and crops: `04591e341cfa95e715d0825552b495d1ef9567bf9fefe87b621f620e0e6c2a3f`.
The other two seeds' digests are recorded in their sidecars. Route waypoints
store exact straight cardinal runs, including every bend; distances never use
a diagonal shortcut between those waypoints.

```sh
nix develop -c nice -n 10 go run ./server/cmd/worldlab region \
  --slopes height --seed map --rect=-24,-24,23,23 /tmp/slopes-height.png
# Swap height for kinds, routes, reach or tunnels.
nix develop -c nice -n 10 go run ./server/cmd/worldlab atlas \
  --slopes height --seed slopes-17 --rect=-24,-24,23,23 --scale 8 /tmp/slopes-atlas.png
nix develop -c nice -n 10 go test ./server/internal/wilds ./server/internal/worldlab \
  -run TestSlopes -count=1 -v
```

The dev world-lab render API also accepts `"slopes":"height"` (or another
diagnostic) with the existing region/atlas request fields. It retains worker
isolation, request cancellation and pixel limits, uses embedded rules, and
rejects live-world tile inspection, edited rules and unrelated overlays for
this experiment. The existing Svelte viewer and the sibling height lab were
not changed. No Vite or Playwright ran on this host.

## Joining the chosen height-lab look

The renderer needs four absolute corners per tile in **NW, NE, SE, SW order**,
`kind`, the intentional-unreachable flag, and for a cliff its exact
`FaceTop`, `FaceBottom`, `FaceRow`, `FaceRows`. A shared edge is the pair of
corner heights, not one averaged midpoint. Crossing requires both tiles to
be `slope` and both corner pairs to match exactly. Bilinear height interpolation
and the same gradient limit must drive walking. Preserve the separate steep
and crag kinds so climbing gear can later change access policy.

Shading by facing can use corner derivatives; contour hints or small terraces
must remain visual and preserve the smooth collision field. A true ¾ lift
must derive projection, feet and hit testing from the same heights and keep the
local south-face footprint. Fog can use interpolated height but cannot substitute
for slope shading. The generated gold/cyan routes and candidate entrances are
available as world coordinates in the sidecars; drawing style does not create
new movement edges.

This first recipe deliberately bounds features and proves the finite home
windows. The atlas also makes its repeated E–W owner layout apparent; density,
orientation and more varied range chains need a later recipe pass. It is not
a global region-link proof, a kept-land conversion, a weekly blocker solve,
a production wire migration, water generation, or a cave implementation.
Those remain separate from joining this lane to the owner's chosen look.

Local verification: `go vet ./...`, `go test ./...`, dev-tag server/API checks,
and the final targeted slope tests all pass. Coverage includes independent
sampling order and negative seams, three seed certificates, all fifteen whole
south-face drops, the home apron, intentional scarps, every pass and spire,
codec rejection, HTTP worker transport, cancellation, and byte/time budgets.
