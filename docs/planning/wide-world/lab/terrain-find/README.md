# Finding generated terrain

The real game's dev Terrain section warps to features from the world's own
`slopes-gen@2` plan. The **Height** layer on the world map shows the
unexplored country too. No generator shapes or terrain contract changed.

## Destinations and map

| Arrival | Top-down | True ¾ lift |
| --- | --- | --- |
| Certified pass | [Pass](top-pass.png) | [Pass](lift-pass.png) |
| Range crest's walkable shoulder | [Crest](top-crest.png) | [Crest](lift-crest.png) |
| Spire view, outside its unreachable footprint | [Spire](top-spire.png) | [Spire](lift-spire.png) |
| Outcrop's gentle side | [Top](top-outcrop-top.png) | [Top](lift-outcrop-top.png) |
| Below the south cliff | [Foot](top-outcrop-foot.png) | [Foot](lift-outcrop-foot.png) |
| Hills | [Hills](top-hills.png) | [Hills](lift-hills.png) |
| Tunnel candidate, still metadata | [Tunnel](top-tunnel.png) | [Tunnel](lift-tunnel.png) |

World map: [18%](map-18.png), [closer, 50%](map-close.png), and
[height switched off](map-off.png). Exact targets, stands, arrivals, camera
states and map reads are in [evidence.json](evidence.json).

## Bounds and certification

- `GET /api/dev/terrain/features?x=12&y=60[&recipe=slopes-gen@1]`
  searches exactly the surrounding 3×3 owner squares, each 576² tiles. It
  selects the nearest planned feature of each kind. Hills retain a bounded
  set of broad, raised, ordinary-ground samples outside the ranges.
- Each owner's resolved surface is certified using exact corner-gradient,
  shared-edge and discontinuity rules. Stands must be in the open transit
  rim's component, with cardinal clearance and no deliberate spire mask.
  Those continuous rims compose the terrain's backbone to home; the home
  owner's component must also contain the Commons at (12,30). The tests
  additionally compare returned stands with larger actual-home graphs for
  three seeds and both recipes. A pass must have an exact crossing through
  its planned saddle; a tunnel candidate needs connected mouths and blocked
  intervening rock. Owner summaries have a 32-entry server cache.
- This certificate concerns height geometry. Cover is separate: the
  existing dev warp can move off a tree to nearby open ground within its
  24-tile search. The spire view temporarily fits the pinnacle and lifted
  crown, then restores ordinary framing after another destination or walking
  away. The in-game terrain bake still has its existing attached-window
  limit; distant ground outside it can look flat.
- `GET /api/dev/terrain/map?c=cx,cy&c=…[&recipe=…]` accepts at most 256 chunks.
  Each chunk carries 36 samples at four-tile spacing: centre height, kind
  and gradient. Thin south faces are retained; spire and saddle icons come
  directly from the analytic plan. No SL2 surfaces are generated or sent by
  this route. Server and per-opening client caches hold at most 1,024 chunks;
  extreme zoom-outs shade only the nearest 1,024 visible chunks. Pan/zoom
  reads are debounced and cancelled on closing or disabling the layer.
- Both routes compile only in dev builds, use the caller's session world
  seed, and have the existing hooks/world-lab account gates and recipe
  selection. Nothing is written to the world.

CI runs the two real-game terrain proofs with one worker after the other
selected specs, so cold owner planning and bakes don't compete with the
existing frame-time budget. Its threshold stays unchanged. The combined
CI summary retains all passes and their original reports, including
`terrain-proof-e2e-results.json`.
