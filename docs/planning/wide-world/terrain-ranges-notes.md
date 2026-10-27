# Natural mountain ranges: slopes-gen@2

2026-10-26, `exp/terrain-ranges`. This is the database-free Go/world-lab
terrain recipe for the parallel in-game terrain lane. The original
`slopes-gen@1` remains available, including its default constructors.

## Selecting the recipe

```go
sampler, err := wilds.NewSlopeSamplerRecipe(seed, wilds.SlopeRecipeV2)
// sampler.Corner, sampler.Tile and sampler.Surface retain their old contracts.
plan, err := wilds.NewSlopePlanRecipe(ctx, seed, wilds.SlopeRecipeV2, x, y, w, h)
```

`SlopeRecipe` and `NewSlopeSampler` / `NewSlopePlan` still select `@1`.
Unknown recipe IDs fail explicitly. The existing world-lab CLI adds
`--slope-recipe slopes-gen@2`; the render API accepts
`"slopes":"height","slopeRecipe":"slopes-gen@2"` with the existing
region/atlas fields. Kinds, reach, routes and tunnel views use the same selector.
The dev world-lab UI has no new selector; use its render API or the CLI.

The hard contract is unchanged: absolute 1/256-level Uint16 corners,
levels 0–15, the four terrain kinds, shared `(w+1)*(h+1)` grid, sparse
overrides, floor-divided corner ownership, and SL2 encoding. Walking still
requires every bilinear corner's `gx*gx+gy*gy <= 64*64`, exact shared edges
and no incident discontinuity flags. The codec and client code are unchanged.

## What changed

The former east–west bars become rotated, winding ridges with a tributary
spur. Seeded orientation, phase, length, shoulder width and saddle position
vary each owner. Three bending scales form the main crest; height,
width and fine crown roughness vary along it. The spur's shoulder merges
with the main range using a maximum rather than adding two mountain lifts.
This leaves a sheltered bowl between diverging ridges without doubling the
height at their junction. Crag ribbons close the bowl's head until there is
an eight-tile opening; this is an analytic feature rule, never a component-size
exemption or a post-generation relabelling of stranded floor.

Lower shoulders stay broad and mostly walkable. A wide low saddle cuts the
upper rock, and the final graph supplies both a pass and a longer end route.
Ridge heights use lane B's continuous Upland and Relief fields. Warped smooth
rolling terms add hills between ranges. Categorical biome borders never
multiply height. Biome dressing remains separate.

Spires use rotated asymmetric diamond sections with steep sides and small
level-15 crowns. Their footprints are deliberately marked unreachable before
connectivity is calculated. Placement selects the candidate farthest from
protected ground. If an outcrop would overlap a spire, the outcrop moves to
the opposite side. Outcrops retain the gentle northern approach and explicit
south scarp. Fine relief and features fade outside the flat protected apron,
with mountains withheld until the existing far-home envelope allows them.

Features fit within radius 250 of centres jittered by at most 32 tiles:
`250+32 < 288`, half the 576-tile owner spacing. They vanish before owner
borders. The globally sampled base field is the only height there, so sampling
a containing owner needs no adjacent plan. Field interpolation remains on
absolute 8-tile nodes, and scarp metadata keeps its pure local lip lookup.
No new chunk-relative smoothing, neighbour fetch or unbounded planning is used.

## Access evidence and limits

The three reference seeds (`map`, `slopes-17`, `slopes-991`) each certify the
same 48×48-chunk home window as @1: 1,327,104 tiles rooted at `(12,30)`.
All ordinary walkable floor reaches home; each range has a clear pass and a
longer route with that saddle's neck closed. Every seed retains four isolated
summit components. Tunnel candidates have home-connected endpoints and cross
blocked rock; they are metadata only.

Tests also certify sixteen independently seeded complete feature owners at
positive and negative coordinates, constrain pass paths to a narrow corridor,
and check cardinal clearance around each path tile. They check height bounds,
all four terrain kinds, protected fixed/home footprints and the existing
near-home held/backland fixtures. Those fixtures retain @1's flat geometry and
reach the actual home. Two separate cold test processes, shuffled warm samplers,
independent tile sampling, codec round trips and paired corner/flag seam checks
cover negative coordinates, owner boundaries, scarps and spires.

This remains finite height-only access evidence. The recipe does not load or
reconcile arbitrary stored held terrain from another recipe, solve weekly
cover blockers, migrate production pins, or prove global region links. Existing
production held-land code is unchanged and covered by the full Go suite.
The in-game lane must keep stored geometry and its required approaches when
it adds terrain persistence. No water, caves, biome dressing or deployment is
included here.

## Measurements and inspected images

Final measurements and reproduction coordinates follow. PNG sidecars contain the full-domain certificate,
geometry digest, exact route waypoints, biome shares and per-fixture budgets.

All **15 retained PNGs were opened and inspected**. Inspection drove a more
varied crest profile, smaller irregular spire crowns, and stronger rolling
hills with a crop outside the protected apron. The comparison retains the
same seed and coordinates; no screenshot uses invented water or cave geometry.

| Seed / recipe | Stranded components / tiles | Intentional summit components / tiles | Pass steps, each range | End-route steps, same endpoints | Largest height / bare whole chunk B |
|---|---:|---:|---|---|---:|
| map / @1 | 0 / 0 | 4 / 208 | 208, 208, 208, 208 | 496, 518, 508, 496 | 2,441 / 2,879 |
| map / @2 | 0 / 0 | 4 / 162 | 307, 277, 285, 302 | 473, 541, 497, 518 | 2,441 / 2,879 |
| slopes-17 / @2 | 0 / 0 | 4 / 165 | 316, 257, 316, 304 | 508, 533, 550, 476 | 2,435 / 2,873 |
| slopes-991 / @2 | 0 / 0 | 4 / 170 | 315, 316, 309, 316 | 467, 518, 517, 398 | 2,429 / 2,867 |

Each @2 seed has four retained tunnel candidates and reaches level 15.
All corner gradients on ordinary floor remain at or below 0.25 level/tile.
Rotated crossings use cardinal steps, so their distances include Manhattan
travel in their chosen directions. The alternative closes only the saddle
neck, not the full footprint. Route waypoints preserve every cardinal bend;
these are tile distances, not travel-time or diagonal-distance estimates.

Warm chunk generation plus encoding uses a fresh sampler, 80 timed samples
after one discarded warm-up, with nearest-rank percentiles. These numbers
come from the paired `map` atlas workers at nice 10 in the Nix shell:

| Fixture | @1 warm p95 ms | @2 warm p95 ms | @2 bare whole B |
|---|---:|---:|---:|
| Flat | 0.299 | 0.147 | 591 |
| Hills / near-home shoulder | 0.446 | 0.668 | 1,841 |
| Mountainside | 0.420 | 0.820 | 1,841 |
| Pass | 0.427 | 0.680 | 1,841 |
| Spire | 0.438 | 0.804 | 1,913 |
| Synthetic override probe | 0.241 | 0.148 | 961 |

The added @2 outcrop fixture is **0.816 ms p95 / 2,879 B** on `map`.
Across the three @2 atlas workers, warm p95 ranges from **0.146 to 0.853 ms**.
Against @1's historical **0.26–0.66 ms**, the new upper bound grows by about
**0.19 ms**: the extra ridge/fork profiles, warps and trigonometric evaluations
cost more than a straight rib. Flat @2 chunks exit before field/feature sampling
inside the protected apron and are faster. These are shared-host measurements,
not a phone/rendering benchmark. Every measured p95 remains below 1 ms and the
existing lab's 5 ms gate.

The largest bare whole payload is **2,879 B**, versus @1's historical maximum
**2,891 B**; it leaves **3,265 B** of the 6 KiB budget for future dressing.
The p50/p95 bare whole size remains **1,841 / 1,841 B** (height envelope
**1,403 / 1,403 B**). Rotation and branching add no wire fields: the same
25×25 grid and sparse flag planes carry them. Generated overrides remain zero.
Whole size includes the undressed WorldChunk protobuf and framed SL2 data;
it does not establish a dressed production payload budget.

Cold field assembly for all 2,304 chunks is **1.25–1.41 seconds** in the three
@2 atlas workers, versus **1.00 second** in the retained @1 `map` worker.
This is a full finite diagnostic, not the cold latency of a production region
planner. Decode, exact connectivity, routes and biome accounting are outside
the warm chunk timer.

All crops/views for each seed/recipe produced the same encoded geometry digest:

| Seed / recipe | SHA-256 |
|---|---|
| map / @1 | `98c250d33537f6bc0b23446e1166771c9fa95be908ef5e9fec0b1e07e3cf2570` |
| map / @2 | `25af1dee6d8db2c53ca44422dce7f15404ddc5fee32d98c20ba790b3bf11ef6c` |
| slopes-17 / @2 | `267ae7ae88129c5476f71802e3beba8752babf66a10e46e7fe643cb0deebaf18` |
| slopes-991 / @2 | `69a9bb23c7e93aec234f7ac5c493bc5b8ff8a9ea3a0b674268024ba63899e5a1` |

## Where to look

All image links are under [lab/terrain-ranges/](lab/terrain-ranges/), each
with a `.png.json` sidecar. Chunk rectangles below are inclusive.

| Images | Chunk rectangle / scale | What to inspect |
|---|---|---|
| [@1 atlas](lab/terrain-ranges/map-v1-atlas.png), [@2 atlas](lab/terrain-ranges/map-v2-atlas.png) | −24,−24..23,23 / 8 px per chunk | Same country and apron, differently oriented ranges and stronger low hills. Atlas samples chunk centres and can miss narrow spires. |
| [@1 height](lab/terrain-ranges/map-v1-height.png), [@2 height](lab/terrain-ranges/map-v2-height.png) | −24,−24..23,23 / 1 px per tile | Full field comparison: bars versus winding crests, forks, bowls and angular pinnacles. |
| [@1 range](lab/terrain-ranges/map-v1-range.png), [@2 range](lab/terrain-ranges/map-v2-range.png) | 3,5..20,22 / 2 | Branch, broad sides, saddle, separate spire and outcrop. |
| [@2 routes](lab/terrain-ranges/map-v2-routes.png), [@2 reach](lab/terrain-ranges/map-v2-reach.png) | −24,−24..23,23 / 1 | Gold pass versus cyan end detour; all ordinary floor green, deliberate spires purple, no stranded pink. |
| [@2 tunnels](lab/terrain-ranges/map-v2-tunnels.png) | 3,5..20,22 / 2 | Candidate across rock with already reachable white endpoints. |
| [@2 pass](lab/terrain-ranges/map-v2-pass.png) | 9,10..12,13 / 6 | Clear saddle between the crag ribbons around world (260,295). |
| [@2 spire](lab/terrain-ranges/map-v2-spire.png) | 15,16..17,18 / 6 | Warped angular section, level-15 crown at (395,419). |
| [@2 outcrop](lab/terrain-ranges/map-v2-outcrop.png) | 4,15..6,19 / 6 | Walkable northern approach and deliberate south cliff at (128,447). |
| [@2 hills](lab/terrain-ranges/map-v2-hills.png) | −2,−23..4,−18 / 4 | Gentle rolling country beyond the protected apron. |
| [slopes-17 atlas](lab/terrain-ranges/slopes-17-v2-atlas.png), [slopes-991 atlas](lab/terrain-ranges/slopes-991-v2-atlas.png) | −24,−24..23,23 / 8 | Two more seeds with different range orientation and the same access gates. |

Reproduce the entire set, from the repository root:

```sh
nix develop -c nice -n 10 sh docs/planning/wide-world/lab/terrain-ranges/render.sh
```

Or render one view:

```sh
nix develop -c nice -n 10 go run ./server/cmd/worldlab region \
  --slopes height --slope-recipe slopes-gen@2 --seed map \
  --rect=3,5,20,22 --scale 2 /tmp/terrain-range.png
```

Local validation passed: full `go vet ./...`, `go test ./...`, dev-tag server
and API checks; all focused slope/worker gates rerun after the image-driven
morphology adjustments. The retained script passes `sh -n`, and all fifteen
sidecars were checked for consistent digests, zero stranded tiles, level-15
bounds, four tunnel candidates and meaningful detours. No JS dependencies,
Vite or Playwright were needed on this host; browser checks run in CI.

## Walkable high shoulders: revision of @2 (2026-10-26)

This section supersedes the @2 morphology and measurements above. The owner’s
screenshots showed a real access failure: the old recipe had walkable skirts,
but **zero ordinary walkable tiles above level 6 in all twelve measured ranges**.
The guess that most of the *whole footprint* was closed was too strong:
73.77–82.41% was walkable. Almost all that usable area was low ground. Upper
ribs compressed the remaining rise into 12–24 tiles and then explicitly marked
that entire rib as crag. Merely relaxing the crag mask would have left steep
unwalkable slopes. The walk limit and four-corner collision contract stay fixed.

The new profile distributes the full climb across a smooth 76–124-tile
half-width, with 92–111-tile end tapers and an 82-tile saddle support. Bend
amplitude, target height and tributary height vary independently per owner;
a quarter of owners omit the tributary, and the others use differing lower
spurs. A radial envelope vanishes by radius 250. Peak amplitude reserves
headroom below level 14 before sampling, while the independent spires retain
level-15 crowns. The base field, protected apron, outcrop scarp and spire
construction are unchanged. No codec, client or contract changes are involved.

Closed ground is deliberately sparse: 2–5-tile winding crest half-widths,
interrupted crag bands on one flank, outcrop south scarps and the separate
pinnacles. The measured closed share is **3.72–5.64%** of the footprint, well
under the requested 25% ceiling. Crag masks use continuous ridge coordinates
and curved outlines, never whole-level contour thresholds. They do not create
the broad staircase of closed upper sides. The analytic bands are crag; explicit
discontinuous cliff faces remain on the outcrops. No connectivity-driven
relabeling, stranded-component exemption or increased walking limit is used.

Pass endpoints now sit 88 tiles either side of the saddle, on its approaches.
At 112 tiles, the axis-aligned rectangle between diagonal endpoints could also
contain a route around the fading near-home end, with exactly the same Manhattan
length. The shorter endpoint pair measures a pass against a genuinely longer
alternative; the clearance and narrow-corridor tests remain unchanged. The
new regression also closes the pass neck and routes from home to each range’s
highest ordinary walkable tile: every measured range can reach level 8+ without
using its pass.

### Per-range measurements

The footprint is the union of the analytic main shoulder support, active
tributary support, a 29-tile-radius pinnacle envelope and the outcrop approach
plus face (76 by 70 tiles). Main/tributary support is bounded by radius 250 in
the revised recipe. It includes zero-height outer fringes and home-envelope
fades, but excludes the unrelated remainder of the 576-square owner. The old
recipe had a tributary in every owner. Counts exclude deliberately unreachable
spire ground from walkable area. Heights use the mean of the four exact
Uint16 corners. The p95 gradient uses the conservative maximum of the four
bilinear corner gradients across the footprint, excluding the separate spire
and explicit cliff faces; it includes the old closed upper shoulders. This
measures the shape, independently of the crag label.

Kinds are percentages in **slope / steep / crag / cliff** order. High areas
are absolute tile counts (and percentages of the full footprint) strictly
above levels 3, 6 and 9. The final column counts home-connected ordinary tiles
at level 8 or higher. Raw rows are retained beside the images.

Before (86c9eb2b):

| Seed | Owner | Footprint tiles | Kinds % | Walkable % | Above 3 / 6 / 9 tiles (% footprint) | p95 level/tile | Home ≥8 tiles |
|---|---|---:|---|---:|---|---:|---:|
| map | -1:-1 | 64447 | 78.43 / 1.70 / 19.46 / 0.40 | 78.27 | 13100 (20.33%) / 0 (0.00%) / 0 (0.00%) | 0.3534 | 0 |
| map | 0:-1 | 64187 | 75.82 / 1.62 / 22.51 / 0.04 | 75.66 | 3174 (4.94%) / 0 (0.00%) / 0 (0.00%) | 0.3192 | 0 |
| map | -1:0 | 68192 | 78.83 / 1.61 / 19.18 / 0.39 | 78.67 | 1169 (1.71%) / 0 (0.00%) / 0 (0.00%) | 0.2912 | 0 |
| map | 0:0 | 64369 | 76.86 / 1.69 / 21.05 / 0.41 | 76.70 | 4742 (7.37%) / 0 (0.00%) / 0 (0.00%) | 0.3826 | 0 |
| slopes-17 | -1:-1 | 64386 | 73.95 / 1.68 / 23.96 / 0.41 | 73.77 | 21798 (33.86%) / 0 (0.00%) / 0 (0.00%) | 0.4793 | 0 |
| slopes-17 | 0:-1 | 68424 | 77.38 / 1.52 / 21.04 / 0.06 | 77.22 | 18287 (26.73%) / 0 (0.00%) / 0 (0.00%) | 0.4239 | 0 |
| slopes-17 | -1:0 | 74923 | 79.04 / 1.44 / 19.16 / 0.35 | 78.88 | 22757 (30.37%) / 0 (0.00%) / 0 (0.00%) | 0.3771 | 0 |
| slopes-17 | 0:0 | 66090 | 78.16 / 1.66 / 19.78 / 0.40 | 78.01 | 4704 (7.12%) / 0 (0.00%) / 0 (0.00%) | 0.3331 | 0 |
| slopes-991 | -1:-1 | 65532 | 77.23 / 1.65 / 20.72 / 0.40 | 77.05 | 9247 (14.11%) / 0 (0.00%) / 0 (0.00%) | 0.3587 | 0 |
| slopes-991 | 0:-1 | 64115 | 76.51 / 1.60 / 21.82 / 0.07 | 76.31 | 18256 (28.47%) / 0 (0.00%) / 0 (0.00%) | 0.4399 | 0 |
| slopes-991 | -1:0 | 73122 | 78.84 / 1.49 / 19.30 / 0.36 | 78.68 | 22788 (31.16%) / 0 (0.00%) / 0 (0.00%) | 0.3984 | 0 |
| slopes-991 | 0:0 | 65714 | 82.60 / 1.64 / 15.37 / 0.40 | 82.41 | 10936 (16.64%) / 0 (0.00%) / 0 (0.00%) | 0.2988 | 0 |

After:

| Seed | Owner | Footprint tiles | Kinds % | Walkable % | Above 3 / 6 / 9 tiles (% footprint) | p95 level/tile | Home ≥8 tiles |
|---|---|---:|---|---:|---|---:|---:|
| map | -1:-1 | 76406 | 95.58 / 1.43 / 2.65 / 0.34 | 95.44 | 36516 (47.79%) / 15072 (19.73%) / 5608 (7.34%) | 0.1810 | 8231 |
| map | 0:-1 | 84832 | 95.98 / 1.23 / 2.76 / 0.03 | 95.86 | 31299 (36.90%) / 13539 (15.96%) / 4094 (4.83%) | 0.1617 | 6770 |
| map | -1:0 | 84604 | 95.84 / 1.30 / 2.55 / 0.31 | 95.71 | 25103 (29.67%) / 9700 (11.47%) / 2369 (2.80%) | 0.1799 | 4306 |
| map | 0:0 | 83972 | 96.28 / 1.30 / 2.11 / 0.31 | 96.16 | 30112 (35.86%) / 12721 (15.15%) / 3637 (4.33%) | 0.1615 | 6196 |
| slopes-17 | -1:-1 | 83755 | 95.43 / 1.29 / 2.97 / 0.31 | 95.29 | 53250 (63.58%) / 21806 (26.04%) / 9393 (11.21%) | 0.1657 | 12836 |
| slopes-17 | 0:-1 | 66487 | 94.36 / 1.69 / 3.88 / 0.06 | 94.20 | 35253 (53.02%) / 15749 (23.69%) / 7482 (11.25%) | 0.2115 | 9797 |
| slopes-17 | -1:0 | 72923 | 94.37 / 1.58 / 3.69 / 0.36 | 94.21 | 41344 (56.70%) / 17056 (23.39%) / 7716 (10.58%) | 0.2001 | 10229 |
| slopes-17 | 0:0 | 84555 | 95.79 / 1.30 / 2.60 / 0.31 | 95.67 | 36259 (42.88%) / 15501 (18.33%) / 5489 (6.49%) | 0.1749 | 8269 |
| slopes-991 | -1:-1 | 67357 | 94.43 / 1.60 / 3.58 / 0.39 | 94.25 | 31388 (46.60%) / 13456 (19.98%) / 5472 (8.12%) | 0.1940 | 7703 |
| slopes-991 | 0:-1 | 81998 | 95.69 / 1.23 / 3.03 / 0.05 | 95.54 | 49479 (60.34%) / 21685 (26.45%) / 10060 (12.27%) | 0.1801 | 13368 |
| slopes-991 | -1:0 | 81435 | 95.15 / 1.33 / 3.19 / 0.32 | 95.01 | 46032 (56.53%) / 18914 (23.23%) / 8380 (10.29%) | 0.1934 | 11301 |
| slopes-991 | 0:0 | 76074 | 96.19 / 1.41 / 2.05 / 0.34 | 96.03 | 30452 (40.03%) / 9767 (12.84%) / 3225 (4.24%) | 0.1603 | 4635 |

All twelve ranges now have **4,306–13,368** home-connected tiles at level 8+.
Typical upper shoulder gradients (p95) are **0.1603–0.2115** levels/tile,
64–85% of the 0.25 limit. All ordinary tiles still obey the exact limit.
The original three full 48×48-chunk certificates and sixteen independent
positive/negative owners keep zero unintended stranded tiles and isolated
spires. The new high-ground gate additionally requires at least 75% walkable
footprint, at least 50 home-connected level-8 tiles per range, pass-independent
access and p95 gradient at most 90% of the walk limit.

### Inspected evidence and budgets

All twelve world-lab PNGs below were opened and inspected. Both sets use seed
`map`, the same world coordinates and scale. The atlas is a full-resolution
region render over chunks −24,−24..23,23 (1 px/tile), rather than the sparse
chunk-centre atlas mode. The range crop is 3,5..20,22 (2 px/tile). Cropping
retains the full-domain certificate. Hillshade inspection confirms broad
high shoulders in place of thin upper ribs; kinds and reach show thin rock
ribbons, open high sides and the same separate pinnacles.

| View | Before atlas / range | After atlas / range |
|---|---|---|
| Kinds | [atlas](lab/terrain-walkable/before-atlas-kinds.png), [range](lab/terrain-walkable/before-range-kinds.png) | [atlas](lab/terrain-walkable/after-atlas-kinds.png), [range](lab/terrain-walkable/after-range-kinds.png) |
| Walkable reach | [atlas](lab/terrain-walkable/before-atlas-reach.png), [range](lab/terrain-walkable/before-range-reach.png) | [atlas](lab/terrain-walkable/after-atlas-reach.png), [range](lab/terrain-walkable/after-range-reach.png) |
| Height + hillshade | [atlas](lab/terrain-walkable/before-atlas-height.png), [range](lab/terrain-walkable/before-range-height.png) | [atlas](lab/terrain-walkable/after-atlas-height.png), [range](lab/terrain-walkable/after-range-height.png) |

The map certificate’s home-connected area grows from **1,268,192 to 1,313,519**
tiles. It retains four isolated summit components / 162 walkable summit tiles,
zero stranded tiles, four tunnel candidates and the level 0–15 bounds.
Pass/end-route steps for the four owners are now **242/380, 218/462, 224/430,
238/386**. Endpoint distances changed, so these are not speed comparisons.

Paired map atlas workers, Nix shell, nice 10, GOMAXPROCS=2, 80 warm samples:

| Fixture | Before warm p95 ms | After warm p95 ms | After bare whole B |
|---|---:|---:|---:|
| flat | 0.146 | 0.220 | 591 |
| hills | 0.694 | 0.852 | 1841 |
| mountainside | 0.840 | 0.659 | 1841 |
| outcrop | 0.833 | 0.957 | 2879 |
| override-probe | 0.175 | 0.176 | 961 |
| pass | 0.689 | 0.766 | 1841 |
| spire | 0.828 | 0.754 | 1913 |

Largest bare whole payload stays **2,879 B**; p50/p95 stays **1,841/1,841 B**,
and generated overrides stay zero. Cold full-field assembly was 1.410 seconds
before / 1.238 seconds after. These shared-host timings include scheduler
noise; the same coordinates and budgets remain near the previous recipe and
under the existing 5 ms warm gate. They do not measure client rendering or
future dressed production chunks. Every retained after sidecar has geometry
digest `b8a01a2d96fc2026900dca215e95c775b2bee1346cffb19f6a53948ef3b827bf`.

Reproduce after renders and per-range measurements:

```sh
nix develop -c sh docs/planning/wide-world/lab/terrain-walkable/render.sh
nix develop -c go test -run TestSlopeRangesWalkability -v ./server/internal/wilds
```

For before renders, build worldlab at 86c9eb2b and pass that binary as the second
argument to `render.sh before /tmp/worldlab-before`.

The CI-only E2E test reads the actual dev terrain route for its player’s seed,
finds a continuous 36-tile shoulder rising at least 3.6 levels to level 8+,
checks flat Wilds cover collision, warps only to its foot, and uses keyboard
movement until the hero has climbed at least three levels. It captures foot
and high-ground frames in both top-down and ¾ lift modes. Vite and Playwright
are never run on this host.
