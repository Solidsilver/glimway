# Terrain access spike

2026-10-21, lane A, `exp/terrain-spike`. This experiment is accessible only
through the world lab. It changes no live generator, protocol, database, or
game movement. The owner's decision remains “spike first, then pick.”

Recommend the region plan and an exact certificate before publishing terrain.
Keep the pure local south-face stencil whichever access strategy is chosen.
Independent chunk repair fits the warm budget but does not guarantee access:
it strands the saved-player fixture and new ground between diagonal holds.
The prototype region solve needs a preparation/cache stage and substantial cold
optimization before production; it exceeds the proposed 250 ms cold allowance.

## What was built

`server/internal/wilds/terrain_*.go` implements a bounded 480×192-tile access
domain: twenty chunks along a bent ridge, eight across it. The structural stub
has broad benches, two crowns, a principal saddle, two broad bowls, and a small
deliberate corner-bowl stress fixture. `TerrainFields.Top(x,y)` is the only
dependency lane B needs to replace. The stub's floating-point trigonometry is
for this lab, not a proposed lasting production field recipe.

Both strategies start with identical structural samples, south faces, and
mandatory constraints. Flat levels are 0–3. A non-iterative four-row plateau
filter samples at most three rows each way; composing it with the nine-row
south shadow needs **12 rows north and three south**. Faces consume exactly
three rows per dropped level. N/E/W differences remain blocked rims. Unit
fixtures cover every drop, negative coordinates, and lips on either side of a
chunk seam. No iterative neighbour-dependent contour relaxation is used.

Ramps have two lanes, matching absolute edges in **1/256 level**, a maximum
rise of one level in four tiles, and up to 24 ramp tiles per run. Boundaries are
quantized once and shared by the two adjacent tiles. Built/rough changes only
style. A separate twelve-tile, three-level ramp crosses a chunk seam in the
codec and foot-box tests. The generated plans also use multi-level ramps.

The region solver first realizes a crossing at the saddle, then joins exact
components with bounded straight ramps. It marks two realized walking routes:
through the saddle and around the east end, in distinct crossing corridors.
It recomputes exact components after every repair. Optional components smaller
than sixteen tiles that cannot take a ramp may become explicit nonwalkable rock;
their structural tops remain, and the rejected tile count is exported. Protected
floor is never rejected. This is a simple measured solver, not the proposed
coarse A* / refinement-core production implementation.

The chunk solver uses the same ramp candidate rules inside `2..21` of its own
24×24 tiles. It tries to connect all local components, which is stronger than
only joining raised components to the lowest trunk. It cannot alter the rim,
overwrite a protected landing, or change another chunk. Tiny optional interior
shelves may become rock under the same rule. It reports remaining failures;
it does not silently flatten a neighbour's boundary or teleport a saved hero.
This is the seam-preserving interpretation of Argon's per-chunk repair, not a
claim that no more sophisticated shared-boundary algorithm could work.

Mandatory fixtures are three flat legacy chunks at `(3,5)`, `(4,4)`, `(5,5)`
(including diagonal corners), every one of their 288 old open boundary edges,
a full level-zero gate apron at chunk `(9,6)`, and an old valid foot position
where the new stencil would put a face. All constraints are gathered before
new-side landings, so corner results do not depend on neighbour order. These
are synthetic old geometry fixtures; no live database or player is touched.

## Measurement method

Each final process measures twenty fresh whole-domain assemblies per strategy
and 160 warm chunks in a shuffled order. Region warm time includes clipping
and encoding; local warm time includes fresh field sampling, local repair and
encoding, not clipping an already-repaired map. Decoding and certificate
inspection follow the warm timer. Chunk outputs are decoded and compared with
the cold assembly, including 14,016 directed seam-edge records. Different
heights across an intentional cliff are blocked edges, not seam errors.

Two independent CLI invocations, shuffle seeds 71 and 991, use seed
`terrain-17` (field seed `1139476189`, structural variant 5). PNG JSON sidecars
hold timings, recipe, field seed, anchors, geometry SHA-256, component summaries,
stranded bounds, and byte counts. Timings are wall clock on the shared development
host at nice 10, not CPU-isolated estimates. Percentiles use nearest rank.

The codec is a **lab byte envelope**, not a protobuf schema change: two packed
2-bit planes for structural tops and kinds, a packed reservation plane, sorted
sparse exact-edge/style records, and explicit face spans where derivation would
otherwise be ambiguous. Decode validates sizes, order, heights, spans and
canonical re-encoding. The first encoding stored every protected flat as an
edge override and exceeded 6 KiB; packing reservations removed that cost.

The whole-chunk number is an actual undressed `WorldChunk` protobuf (ground
palette and solid bits) plus the height envelope and its four-byte length.
It **does not establish the 6 KiB budget for dressed chunks**: biomes, plants,
entities, sites and future wire integration still need their own measurements.
Stored region-plan bytes include all framed chunk geometry/reservations and
the seed/anchor/held-exit manifest. Local repair has zero persisted access-plan
bytes, plus the reported mandatory-constraint manifest; its full encoded
snapshot size is separately exported for comparison. These are encoded bytes,
not Go heap measurements or an implemented database table.

| Metric | Region plan | Per-chunk repair |
|---|---:|---:|
| Process A cold assembly ms, p50 / p95 / max | 675.027 / 678.320 / 684.736 | 115.037 / 115.702 / 115.919 |
| Process B cold assembly ms, p50 / p95 / max | 678.804 / 695.489 / 695.492 | 114.815 / 117.758 / 117.833 |
| Process A warm chunk ms p95 | 0.015 | 1.258 |
| Process B warm chunk ms p95 | 0.019 | 1.356 |
| Persisted access-plan bytes | 92,407, including constraints | 0; 7,592 shared constraint-manifest bytes |
| Full encoded snapshot bytes, including constraints | 92,407 | 97,002 |
| Height bytes per chunk, p50 / p95 / max | 434 / 1,004 / 1,384 | 434 / 1,062 / 1,240 |
| Bare whole-chunk bytes, p50 / p95 / max | 875 / 1,445 / 1,825 | 875 / 1,503 / 1,681 |
| Stranded components / tiles | 0 / 0 | 2 / 36 |
| Held exits kept | 288 / 288 | 288 / 288 |
| Mandatory anchors reached | 5 / 5 | 4 / 5 |
| Mismatched seam edges, each process | 0 / 14,016 compared | 0 / 14,016 compared |
| Ramps | 16 | 84 |
| Optional floor tiles rejected, this seed | 0 | 0 |

Both warm strategies meet **5 ms p95**. The measured bare whole chunks fit
**6 KiB** with room left for dressing, whose final budget is still unproven.
The region cold p95 is **678–695 ms**, about 2.7–2.8× the proposed 250 ms
allowance; it must not be put directly on the normal chunk-generation path.
The local cold number is the comparison's entire 160-chunk assembly, not an
access plan that local generation needs to store or prepare.

The two processes produced identical full geometry/style/reservation digests:

```text
region 840d6ff853709f469bdaf175fb29cd9df67f6185391b7689f5c2576ff5835a6e
chunk  be40ee319d99ac181ee1e2bb896736c3746b94e0328b1ef379411d8d4e3d3f6b
```

## Where local access fails

For `terrain-17`, region planning leaves **zero stranded components or tiles**,
keeps **288/288 held exits**, and reaches **5/5 anchors**. Chunk repair leaves
**two components, 36 tiles**: the corner bowl's 32 tiles at
`x=310..313,y=66..73`, and the four-tile protected saved-player landing at
`x=207..208,y=96..97`. It keeps all held exits but reaches only **4/5 anchors**.
The landing is deliberately on a chunk boundary. A private chunk repair cannot
cut through its two-row rim to give this protected floor an exit.

The corner bowl is a deliberate adversarial fixture: its four-tile-wide floor
falls entirely inside the two-column rims of adjacent chunks. A region ramp can
use a longer approach outside that private interior. Its presence is evidence
against a guarantee, not a frequency estimate for real generated country.

All eleven structural variants (the complete seed `%11` axis-offset space of
this stub) were tested. A control removes only that narrow corner bowl, keeping
the broad bowls and all mandatory fixtures:

| Field variant | Region stranded tiles | Local stranded components / tiles | Local anchors | Local control stranded tiles |
|---:|---:|---:|---:|---:|
| 0 | 0 | 1 / 40 | 5/5 | 0 |
| 1 | 0 | 1 / 44 | 5/5 | 0 |
| 2 | 0 | 1 / 32 | 5/5 | 0 |
| 3 | 0 | 2 / 36 | 4/5 | 4 |
| 4 | 0 | 3 / 48 | 4/5 | 16 |
| 5 | 0 | 2 / 36 | 4/5 | 4 |
| 6 | 0 | 1 / 32 | 5/5 | 0 |
| 7 | 0 | 2 / 379 | 5/5 | 347 |
| 8 | 0 | 2 / 401 | 5/5 | 369 |
| 9 | 0 | 2 / 423 | 5/5 | 391 |
| 10 | 0 | 2 / 445 | 5/5 | 413 |

Thus local repair strands something in **11/11 stress-fixture variants** and
**7/11 controls**; it strands the saved anchor in **3/11**. Four controls strand
large unprotected terraces between diagonal holds (347–413 tiles), despite all anchors still
being reachable. These eleven related variants are not eleven independent
production regions, so these fractions must not become world prevalence claims.
Both strategies retain all 288 held exits in all variants. Region certificates
pass in all eleven, with 14–17 ramps versus 75–86 local ramps.

The certificate is rooted at the gate on the final edge graph, not a solid-bit
flood fill and not a promise that cropped boundaries lead home. Every floor
component must join that root. The lab's 10×4 px hero can follow cardinal tile
centres across each exact matching edge; Go foot-box checks copy the height lab
contract and test a three-level seam-crossing ramp and closed outer sides.
This does not certify mounts or arbitrary production sprite clearances.

## Images inspected

I opened and visually inspected every committed PNG below. The sidecar for each
is the same filename with `.json` appended; all metrics refer to the full domain.

- [Region levels and realized routes](lab/terrain-spike/region-levels.png):
  benches/crowns survive, the saddle and east-end crossing form a loop, and
  legacy landings visibly cut into the ridge. Gold/orange marks ramp style.
- [Region exact components](lab/terrain-spike/region-reach.png): every floor is
  green, including the protected saved landing and the corner bowl.
- [Chunk exact components](lab/terrain-spike/chunk-reach.png): the same seed
  shows the magenta corner bowl and the much smaller saved-landing failure.
- [Corner and saved-position close-up](lab/terrain-spike/corner-and-save.png):
  chunk lines cross the inaccessible bowl on the right; the protected four-tile
  landing at the lower left is purple under its cyan protection tint and white
  anchor. This is the same component graph, not a fresh cropped flood fill.
- [Terrace between diagonal holds](lab/terrain-spike/valley-failure.png):
  `terrain-3`, variant 10, strands **413 tiles at x=97..118,y=121..142** in the
  new chunk between the three cyan held chunks, plus the separate 32-tile corner
  bowl. The 413-tile failure persists when the narrow corner bowl is removed.

## Reproduce and integration limits

From the repository root, use the dev shell and nice priority:

```sh
nix develop -c nice -n 10 go run ./server/cmd/worldlab region \
  --terrain region --terrain-samples 20 --terrain-order 71 \
  --seed terrain-17 --rect=-1,-1,20,8 --scale 3 --road /tmp/region-levels.png
nix develop -c nice -n 10 go run ./server/cmd/worldlab region \
  --terrain chunk --terrain-samples 20 --terrain-order 991 \
  --seed terrain-17 --rect=-1,-1,20,8 --scale 3 --reach /tmp/chunk-reach.png
```

In glim-dev, open the existing world lab and choose **Terrain access experiment
→ Ridge: region plan / Ridge: per-chunk repair**. The camera moves to the finite
domain, tile inspection is suppressed for this synthetic preview, and Stats
includes both strategies and expandable JSON. Reach is green for home-connected
floor, magenta for stranded, grey outside the known domain. Turn reach off for
levels and ramps; road shows the realized region routes. White crosses are
anchors, cyan tint marks protected land, dark bands are faces and fine dark
lines are N/E/W rims. Existing worker isolation, cancellation, resource limits
and cache keys apply. Browser verification runs in CI, never on this host.

For the next lane: keep the local face rule and exact encoding semantics; replace
only `TerrainFields`, introduce bounded core/shared-boundary contracts, and
optimize/index ramp candidates before caching/prefetching cold plans. Do not
publish a region without its final certificate. The measurements favour region
ownership for correctness and fewer contour cuts, but this spike does not prove
multi-region global links, real held-blob conversion, weekly blocker safety,
mount clearance, dressed payloads, or production cold latency. No migration,
pin persistence, new biome, water, cave or live generation is included.

Local validation: the required `server/` dev-shell `go test ./...`, dev-tag
server/CLI/lab tests, `go vet`, and `npm run verify` (2,814 Node tests,
TypeScript/Svelte checks, production build). Targeted coverage includes all
eleven variants and controls, face stencils and halo bounds, exact codec round
trips/rejections, a generated multi-level ramp, a twelve-tile three-level seam
and hero foot-box sweep, HTTP worker isolation/shuffled order, and cancellation.
The added Playwright test exercises both preview selections, the camera jump,
the two strategy summaries, and suppression of live-world arrival; it runs only
in CI. The final CI run is reported with the branch handoff.
