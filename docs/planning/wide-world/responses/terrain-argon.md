# Terrain, Height & Biomes — Design Response (Argon)

This document answers `docs/planning/wide-world/terrain-brief.md` for the terrain, height, and first biome pass of the wide world (`0.14` iterations 2+). It reconciles the physical rules (`docs/planning/wide-world/land-rules.md`), the owner's synthesis calls (`docs/planning/wide-world/synthesis.md`), the height-lab screen-space model (`src/game/height-lab/`), and the shipping `GeneratorV3` / `LandformV1` server pipeline (`server/internal/wilds/`).

---

## 1. Fields and Regions

### 1.1 Why `lands.go` Draws Circular Arcs Today (and How to Fix It)

In `server/internal/wilds/lands.go:175-200`, `fieldOwner` assigns a tile `(tx, ty)` to the cell whose seed `(sx, sy)` minimizes $(d_x^2 + d_y^2) / s^2$ via the cross-multiplication:

```go
if d*bestS*bestS < bestD*s*s || (d*bestS*bestS == bestD*s*s && c.less(best))
```

where `s = c.size` (`lands.go:121-159`) varies between `3` (`clearing`), `4` (`glade`, `crag`, `scree`, `marsh`), `5` (`wood`), and `6` (`meadow`, `fen`, `moor`).

**The geometric bug:** A Voronoi diagram where Euclidean distance is divided by per-site weight $s_i$ ($\|p - p_i\| / s_i = \|p - p_j\| / s_j$ with $s_i \neq s_j$) is a **multiplicatively weighted Voronoi diagram**. By Apollonius's theorem, the locus of points satisfying $\|p - p_i\| = (s_i / s_j)\|p - p_j\|$ for $s_i < s_j$ is **not a line—it is an Apollonius circle** enclosing the smaller-weight site $p_i$. When a `size: 3` clearing or `size: 4` crag sits beside a `size: 6` meadow or moor, its unwarped boundary is a literal circle of radius $\frac{s_i s_j}{|s_j^2 - s_i^2|}\|p_i - p_j\|$, and the small $\pm 6$-tile sinusoidal warp in `warped(tx, ty)` (`lands.go:165-170`, `landWarpAmp = 6`) only wobbles the rim of that circle.

**The fix (two parts):**

1. **Replace multiplicative weighting with an additive Power / Laguerre distance plus anisotropic domain warp:**
   Instead of dividing $d^2$ by $s^2$, compare additive power distance:
   $$D_i(w) = \|w - p_i\|_A^2 - r_i^2$$
   where $r_i = \text{size}_i \cdot \text{step} \cdot 0.22$ is a radius bias and $\|v\|_A^2$ stretches along a local strike angle $\theta(tx, ty)$ (derived from the macro upland gradient so ridges and valleys elongate along contour lines, ratio $1.45 : 1$). The bisector of $\|w - p_i\|^2 - r_i^2 = \|w - p_j\|^2 - r_j^2$ is a **straight hyperplane**, never an Apollonius circle, while still letting a `size: 6` meadow claim a wider territory than a `size: 3` clearing.
2. **Replace the single-frequency $\sin$ table warp (`lands.go:165-170`) with a 2-octave curl/simplex domain warp:**
   `sin64` on axial `tx * 5` and `ty * 7` (`lands.go:167-168`) has axis-aligned periods of $51.4$ and $36.7$ tiles that visibly repeat across atlas views. Replace `warped(tx, ty)` with a 2-octave value/simplex displacement (wavelengths $96$ tiles amp $14$ tiles + $32$ tiles amp $5$ tiles, using integer lattice hashes from `hash.go:14-31`).

### 1.2 Continuous World Fields and Their Scales

All continuous fields are pure, deterministic integer functions of `(landSeed, tx, ty)` where `landSeed = seed(worldSeed, fmt.Sprintf("landform:v%d", LandformVersion))` (`epoch_v3.go:73-75`). Every value is a signed 16-bit fixed-point integer in `[-1024, 1024]` (or `[0, 1024]`), evaluated via a shared 2D triangle/simplex lattice noise helper `fieldNoise(seed uint64, tx, ty, wavelength int) int` in a new file `server/internal/wilds/fields.go`.

| Field | Range | Wavelengths (tiles / chunks) | Role & Physical Meaning |
| :--- | :--- | :--- | :--- |
| `Upland(tx, ty)` | `[0, 1024]` | **Macro:** $1536\text{ tiles}$ ($64\text{ chunks}$, weight $0.60$)<br>**Meso:** $576\text{ tiles}$ ($24\text{ chunks}$, weight $0.28$, ridged $|\text{noise}|$)<br>**Local:** $192\text{ tiles}$ ($8\text{ chunks}$, weight $0.12$) | Base continental/massif elevation (`land-rules.md` Rule 5). Drives region biome selection (`the-tops` where macro upland is high) and quantizes into levels `0..3`. Clamped to `0` within the home basin envelope around Hearthwick and the Tangle. |
| `Relief(tx, ty)` | `[0, 1024]` | **Meso:** $768\text{ tiles}$ ($32\text{ chunks}$, weight $0.70$)<br>**Local:** $192\text{ tiles}$ ($8\text{ chunks}$, weight $0.30$) | Roughness / dissectedness. High `Relief` turns level transitions into multi-level cliffs (`k = 2..3`) and craggy benches; low `Relief` spreads transitions into wide terraces and gentle rough slopes. |
| `Wetness(tx, ty)` | `[0, 1024]` | **Macro:** $1152\text{ tiles}$ ($48\text{ chunks}$, weight $0.65$)<br>**Meso:** $384\text{ tiles}$ ($16\text{ chunks}$, weight $0.35$)<br>**Plus:** $+220\cdot(1 - \text{Upland}/1024) - 180\cdot\text{RidgeExposure}$ | Hydrological moisture (`land-rules.md` Rules 6, 7, 11). Lowlands and windward valleys accumulate moisture; exposed high ridges shed it. Preparatory hook: in the water round, river corridors add $+350$ within $16$ tiles. |
| `Warmth(tx, ty)` | `[0, 1024]` | **Latitudinal trend:** $\text{clamp}(560 + (ty + 240)/3, 180, 900)$<br>**Macro noise:** $1536\text{ tiles}$ ($64\text{ chunks}$, amp $\pm 220$)<br>**Lapse rate (`Rule 8`):** $-280 \cdot (\text{Upland}/1024)$ | Thermal regime (`land-rules.md` Rules 8, 9). Cooler northward ($-y$) and cooler at altitude (lapse rate), with large macro weather waves so cold basins (`whitequiet`) can form both in the north and in high inland plateaus without turning the map into horizontal stripes. |
| `TreeCover(tx, ty)` | `[0, 1024]` | **Derived field** + **Local:** $144\text{ tiles}$ ($6\text{ chunks}$, amp $\pm 180$) | Derived from `Wetness`, `Warmth`, and `Upland` per Rule 9 & Rule 14: peaks at moderate warmth and moderate-high wetness; suppressed where `Upland > 680` (timberline on `the-tops`), where `Wetness > 820` on flat ground (open fen/bog), or where `Relief` forms cliff faces. |

**Fast chunk evaluation (`<= 0.4 ms` per chunk):**
Because macro and meso wavelengths are $192\text{–}1536$ tiles ($8\text{–}64$ chunks), a $24 \times 24$ chunk (`chunk.go:7`) spans at most $1/8$ of the shortest meso wavelength. `w.fill()` (`base_v3.go:349`) evaluates the macro/meso octaves on a **coarse $5 \times 5$ lattice** covering the chunk plus its 2-tile border (`step = 6` tiles, 25 sample points) and bilinearly interpolates per tile, adding only the cheap high-frequency detail hash per tile.

### 1.3 Regions (~32 Chunks Across) and Biome Selection

Above the existing 16-tile `landCell` (`lands.go:18`, `landCellStep = 16`), introduce **Regions** in `server/internal/wilds/regions.go`:

- **Grid & jitter:** `regionStep = 768` tiles ($32 \times 32$ chunks). Each lattice cell `(rx, ry)` has a deterministic seed point `(sx, sy)` jittered within the central $480 \times 480$ tiles of the cell (`margin = 144` tiles), plus a Laguerre size weight $r \in [0, 160]$ tiles.
- **Boundary warp:** To find the owning region `(rx, ry)` and border distance at `(tx, ty)`, warp `(tx, ty)` by a 2-octave region domain warp (`wavelength1 = 512` tiles, `amp1 = 110` tiles; `wavelength2 = 160` tiles, `amp2 = 32` tiles) and pick the nearest jittered region seed under additive Laguerre distance.
- **Outputs at any tile `(tx, ty)`:**
  ```go
  type RegionSample struct {
      Primary   RegionCoord // (rx, ry) of owning region
      Secondary RegionCoord // (rx, ry) of runner-up region
      DistTiles int         // approximate distance in tiles to the Primary/Secondary bisector (0 at border)
  }
  ```
- **Home region exception (`synthesis.md`):** Any region whose seed lies within the home envelope (`cx in -12..12, cy in -12..12`), or the region owning `(0, 0)`, is forced to `hearthwick-woods` (`woods` / `meadow` sub-lands).
- **Natural region biome assignment (`unpinnedBiome(rx, ry)`):** Sample `Upland`, `Wetness`, and `Warmth` at the region's seed `(sx, sy)` (averaged over a 5-point cross of radius $128$ tiles):
  1. **Northern Whitequiet place (`synthesis.md`):** A dedicated region coordinate `(rx = 0, ry = -2)` (centred near `cx = 0..16, cy = -72..-52`, ~60 chunks north of Hearthwick, well inside the $\pm 4,096$ border) is always `whitequiet` with landmark place kind `"whitequiet-sanctuary"`.
  2. **`whitequiet` (biome):** Selected when `Warmth < 340` AND `Upland < 680` (cold, quiet snow-held woods and hollows; outside the inner 16-chunk ring around Hearthwick).
  3. **`the-tops` (biome):** Selected when `Upland >= 580` OR (`Upland >= 480` AND `Relief >= 560`).
  4. **`hearthwick-woods` (biome):** Selected otherwise (partitioned at the sub-region `landCell` level into `woods` where `TreeCover >= 480` and `meadow` where `TreeCover < 480`).
- **Home-ring guarantee ("each biome reaches within one or two regions of home at least once", `synthesis.md`):**
  On the 8 region cells of the first ring around `(0, 0)` ($\max(|rx|, |ry|) == 1$, whose centres sit $\sim 24\text{–}36$ chunks from Hearthwick and whose inner edges reach chunk $10\text{–}16$), if natural field sampling produces zero `the-tops` regions on that ring, the ring cell with the highest `Upland(sx, sy)` is promoted to `the-tops` (and its `Upland` field receives a smooth Gaussian boost of $+260$ fading to $0$ at the region border). Similarly, if the first or second northern arc ($ry \in \{-1, -2\}, rx \in \{-1, 0, 1\}$) has no `whitequiet` besides `(0, -2)`, `(rx = 1, ry = -1)` or `(-1, -1)` (whichever is colder) is promoted to `whitequiet`.

### 1.4 Region Pinning (`biome@version`) and the Cost of "Seen Land Never Changes"

Per `synthesis.md`, a region is pinned to `biome@version` (e.g. `the-tops@1`) when a player first enters or glimpses it, so future biome definitions (`new-biome@2`) can appear in unvisited regions without mutating regions players have already found.

- **How it works at runtime:**
  1. When the server generates a chunk `(cx, cy)` (`store/chunks.go:196`) or serves a `WildsGlimpse` (`api/wilds.go`), it collects the $3 \times 3$ region coordinates `(rx, ry)` around `(cx / 32, cy / 32)`.
  2. It queries `region_pins` (cached in an in-memory per-world map on `wilds.Service`, populated on world load and updated on insert) for those `(world_id, rx, ry)` keys.
  3. Any unpinned `(rx, ry)` whose region actually owns at least one tile in the generated/glimpsed chunk is inserted (`INSERT OR IGNORE INTO region_pins ...`) with `biome = unpinnedBiome(rx, ry)` and `biome_version = CurrentBiomeVersion(biome)`.
  4. The generator receives a `RegionLookup func(rx, ry int) (biome string, version int)` closure. Even if a later release adds `salt-marsh@1` or bumps `the-tops@2`, any `(rx, ry)` already in `region_pins` continues to run its pinned `biome@version` rules.
- **Concrete cost of "seen land never changes" (and how to bound it):**
  1. **Glimpse radius inflation:** If every distant map-pan `WildsGlimpse` pinned regions, a player panning the map window would pin dozens of regions without ever walking near them. **Rule:** Only pin a region `(rx, ry)` when a **chunk inside it is actually generated** (`EnsureChunks` in `store/chunks.go:196`, i.e., within the near window around a player's sight anchor `player_sight`), OR when a held chunk sits inside it. Distant unvisited `WildsGlimpse` tiles evaluate `unpinnedBiome` live until someone walks within sight range ($3\text{–}4$ chunks) and materializes a chunk.
  2. **Code maintenance cost of `@version` branches:** Keeping old generator code paths forever for `@1`, `@2`, `@3` would bloat `server/internal/wilds/`. **Bound:** `biome_version` pins the **region's biome identity and its declarative `LandRule` / height-curve table** in `content/wilds.json`, NOT separate copies of the Go meshing pipeline. We keep at most 2 historical curve presets per biome; unheld wick chunks still turn on wick rollovers unless held (`holds` table), while the region's *identity* (`the-tops` vs `whitequiet` vs `hearthwick-woods`) stays pinned for the life of the world.

### 1.5 Biome Edge Blending (`land-rules.md` Rule 10)

A region border is never a 1-tile line:

- **Width:** `ecotoneWidth = 16` tiles ($8$ tiles on each side of the Laguerre bisector, so `DistTiles <= 8` in each region).
- **Elevation & level blending:** When `Primary` and `Secondary` regions have different elevation curves (e.g. `hearthwick-woods` meeting `the-tops`), the target continuous height $H(tx, ty)$ blends across `DistTiles in [0..8]` using smoothstep $t = \text{smoothstep}(0, 16, 8 \pm \text{DistTiles})$. This guarantees `the-tops` steps up through level `1` foothills along its rim before reaching level `2` and `3` interior massifs.
- **Palette & sub-land dither:** Within `DistTiles <= 8`, `landAt` (`lands.go:205`) computes a deterministic tile hash `h = mix(seed, tx, ty) & 255`. If `h > 128 + DistTiles * 16`, the tile adopts the `Secondary` region's border sub-land (`foothill`, `timberline`, or `frost-edge`).
- **Decor & tree thinning:** Tree placement probability (`base_v3.go:453`) interpolates between the two biomes' densities across the 16-tile zone, and decor pieces from both biomes interleave so `woods` thins into scattered wind-bent pines before open `the-tops` rock or frost-rimmed `whitequiet` birch.

---

## 2. Height Model in the Generator

### 2.1 How Continuous Fields Become Discrete Levels `0..3`

Surface levels are integer values `L(tx, ty) in {0, 1, 2, 3}` (`synthesis.md`, `src/game/height-lab/levels.ts:13`).

1. **Continuous elevation $H(tx, ty) \in [0, 1024]$:**
   - In `hearthwick-woods` (`woods` / `meadow`) and `whitequiet`: $H(tx, ty)$ is scaled into $[0, 460]$ so 85–90% of tiles sit at `level 0`, with occasional `level 1` knolls, river bluffs, or frost-heaved drumlins ($H \ge 340$).
   - In `the-tops`: $H(tx, ty) = \text{Upland}(tx, ty)$ modulated by ridge/valley noise, spanning $[180, 1024]$ across levels `0, 1, 2, 3`.
   - **Home & Kept Envelope:** Within $6$ tiles of any fixed chunk (Hearthwick, Commons, lots), the Tangle (`cx in -1..1, cy in -2..0`), or the Wend river corridor (`wend.go`), $H(tx, ty)$ is multiplied by a smooth ramp down to `0` so all kept/fixed borders sit at `level 0`.
2. **Initial Quantization Thresholds:**
   - `level 0`: $H < 340$
   - `level 1`: $340 \le H < 560$
   - `level 2`: $560 \le H < 780$
   - `level 3`: $H \ge 780$

### 2.2 Enforcing the Screen-Space South-Face Invariant (`3 * k` Rows)

In `src/game/height-lab/levels.ts:17` and `area.ts:186-211`, every level costs `ROWS_PER_LEVEL = 3` tile rows ($48\text{ px}$) of south-facing cliff face (`KIND.face`). If tile `(tx, ty)` has plateau level $L_{\text{top}}$ and drops to a lower plateau level $L_{\text{bot}} < L_{\text{top}}$ to its south ($+y$), there **must** be $3 \cdot (L_{\text{top}} - L_{\text{bot}})$ contiguous rows of south cliff face (`face` tiles with `faceTop = L_top, faceBot = L_bot`) between the northern plateau lip and the southern floor.

Conversely:
- **North-facing drops** (moving $-y$ from higher $L$ to lower $L$): require **0 face rows** (`height-lab-4-notes.md`; drawn as a dark northern rim + cast shadow in `art.ts:197-211`).
- **East/West-facing drops** (moving $\pm x$): require **0 face rows** (`art.ts:201-208`), *except* where they cross a south-facing cliff band (where the cliff band's own `3 * k` rows terminate cleanly or step).

**How the generator guarantees valid `3 * k` south faces everywhere without iterative global relaxation:**

Instead of quantizing $H(tx, ty)$ independently per tile (which would create $1$- or $2$-tile-tall south overhangs that cannot fit $3 \cdot k$ face rows), level quantization uses a **North-to-South Morphological Envelope (`levelAt(tx, ty)`)**:

1. **Minimum N–S Plateau Run (`minPlateauDepth = 4` tiles):**
   Before placing south faces, we filter the 1D column profile $L_0(tx, y)$ along $y$ using a local window of radius $12$ tiles (`[-12, +12]` in $y$): any plateau segment of level $L$ whose N–S span is $< 4$ tiles is merged down into the lower of its north/south neighbours.
2. **South-Shadow Reservation Rule:**
   For any tile `(tx, ty)`, look north along column `tx` for $d \in [1..9]$ tiles:
   $$L_{\text{caster}}(tx, ty) = \max_{d=1..9} \{ L_{\text{plat}}(tx, ty - d) \mid 3 \cdot (L_{\text{plat}}(tx, ty - d) - L_{\text{plat}}(tx, ty)) > d - 1 \}$$
   In plain English: if a plateau of level $L_{\text{top}}$ ends at row $y_0$ and drops to level $L_{\text{bot}}$ at row $y_0 + 1$, then rows $y_0 + 1 \dots y_0 + 3(L_{\text{top}} - L_{\text{bot}})$ are deterministically occupied by the **south cliff face** (`kind = TileFace`, `faceTop = L_top`, `faceBot = L_bot`, `faceRow = 0 .. 3k-1`).
   Because $k \le 3$, the maximum south face height is $3 \times 3 = 9$ rows. Thus, evaluating `tileHeight(tx, ty)` at any world tile requires inspecting **at most 12 tiles north and 4 tiles south** along column `tx`!
3. **Why this is a breakthrough for chunk seams:**
   Because `tileHeight(tx, ty)` is a **pure local function of $H(tx \pm 2, ty - 12 \dots ty + 4)$** (a $5 \times 17$ tile stencil), two adjacent chunks evaluating their shared edge tiles (`ty = 0` of south chunk vs `ty = 23` of north chunk) compute the **exact same `level`, `faceTop`, `faceBot`, and `faceRow`** without ever needing cross-chunk message passing! A $9$-row cliff that starts at `ty = 21` of chunk `(cx, cy)` seamlessly places rows `0, 1, 2` in `(cx, cy)` and rows `3..8` in `(cx, cy + 1)`.

### 2.3 Cliffs, Ramps, Switchbacks, and Saddles (`land-rules.md` Rule 5)

Each tile in `server/internal/wilds` gets a height descriptor `HeightCell` (mirrors `src/game/height-lab/levels.ts:74-103`):

```go
type SlopeKind uint8
const (
    SlopeNone  SlopeKind = 0 // flat plateau at Level
    SlopeFace  SlopeKind = 1 // impassable south cliff face (FaceRow 0..3k-1 from FaceTop to FaceBot)
    SlopeSouth SlopeKind = 2 // ramp carved into a 3-row south face (1 level over 3 rows, N=top, S=bot)
    SlopeNorth SlopeKind = 3 // north-climbing slope on plateau (2..3 rows, S=bot, N=top)
    SlopeEast  SlopeKind = 4 // east-climbing slope (2..3 cols, W=bot, E=top)
    SlopeWest  SlopeKind = 5 // west-climbing slope (2..3 cols, E=bot, W=top)
)

type SlopeStyle uint8
const (
    StyleRough SlopeStyle = 0 // natural scree/grass/snow ramp (beyond routes)
    StyleBuilt SlopeStyle = 1 // dressed stone steps with low cheek walls (on routes/places)
)
```

**Where ramps, switchbacks, and saddles are placed:**

1. **Deterministic Contour Ramps (`passHash`):**
   Along every level contour ($L \to L+1$), the contour is partitioned into **contour segments of length $18$ tiles** using cell coordinates `(tx / 18, ty / 18)`. In each segment that contains a level transition of $k = 1$:
   - If the transition is a **south-facing 3-row cliff** ($L+1$ north to $L$ south) and has a straight run of $\ge 3$ columns (`tx-1, tx, tx+1`), the deterministic best column pair (`width = 2` tiles) is carved into a `SlopeSouth` ramp (`3` rows tall, edge heights interpolating $L+1 \to L+2/3 \to L+1/3 \to L$ as in `src/game/height-lab/area.ts:238-252`).
   - If the transition is a **north, east, or west drop** of $k = 1$, a $2 \times 2$ or $2 \times 3$ `SlopeNorth` / `SlopeEast` / `SlopeWest` ramp (`area.ts:255-263`) is cut into the upper lip, with `StyleRough` by default.
2. **Multi-Level Cliffs ($k \ge 2$) and Switchbacks:**
   Where `Relief` is high and a cliff drops $k = 2$ ($6$ rows) or $k = 3$ ($9$ rows) at once, a single straight ramp is forbidden (`land-rules.md` Rule 5: *"Tall mountains step up through foothills and benches rather than rising as one sheer wall"*). Instead, where a pass crosses a $k = 2$ drop, the generator inserts a **switchback bench** at intermediate level $L+1$ (`width = 6` tiles, `depth = 4` tiles, just like `src/game/height-lab/mountain.ts:75-83`): a 2-tile-wide `SlopeSouth` climbs from $L \to L+1$ on the east end of the bench, traverses $3\text{–}4$ flat tiles at $L+1$, and climbs a second 2-tile-wide `SlopeSouth` from $L+1 \to L+2$ on the west end.
3. **Saddles:**
   Local saddle points of $H(tx, ty)$ ($\nabla H \approx 0$ with positive curvature across the ridge and negative along the pass) automatically lower $H$ by $-140$ across a $5$-tile corridor, creating walkable level-1 or level-2 mountain passes between level-3 peaks.
4. **Built vs. Rough Slopes (`height-lab-4-notes.md`):**
   - Any ramp whose tile lies within $3$ tiles of the old road (`road.go`), a cell route (`routes.go`), a story site (`StorySite`), or a place landmark (`WildsPlaceMark`) gets `StyleBuilt` (dressed stone steps with 3px side cheek walls and worn centre tread, `src/game/height-lab/art.ts:242-286`).
   - All other natural ramps get `StyleRough` (slanted dirt/scree/moss/snow tracks blending into the surrounding terrain, `src/game/height-lab/art.ts:288-323`).

### 2.4 Guaranteeing Reachability (`land-rules.md` Rule 2)

Rule 2 requires that **every walkable plateau, place, camp, node, and held chunk is reachable on foot without jumping cliffs**, and **no saved player is ever stranded**.

We enforce this at three nested levels:

1. **Macro / Meso Level (Inter-Plateau Guarantee):**
   - Every discrete plateau component of level $L > 0$ within a chunk's $24 \times 24$ interior either:
     - (a) has area $\ge 16$ tiles and receives **at least two ramps** (on distinct compass sides or separated by $\ge 6$ tiles) connecting it to level $L-1$ via the contour-segment ramp pass; OR
     - (b) if a small isolated plateau knob ($< 16$ tiles) cannot fit a 3-row south face + 2-tile ramp without colliding with chunk borders or water, **it is flattened down to $L-1$ during `base_v3.go`** (or kept as an explicitly unwalkable rocky tors/crag solid, never receiving entities, sites, or spawns).
2. **Chunk-Local Level-Aware `ensureReach` (`base_v3.go:503-595`):**
   - Upgrade `ensureReach` (`base_v3.go:503`) to use **edge-height connectivity** (`canStep(a, b)` matching `src/game/height-lab/levels.ts:127-139`: two 4-adjacent tiles connect iff neither is `solid`, neither is `SlopeFace`, and their shared edge heights match within $\epsilon$).
   - **Step 1 (Same-level clearing):** Connected components on the same level $L$ that are separated only by trees/boulders (`solid` decor) have a 1-tile clearing cut through the interior (`2..S-3`), exactly as `ensureReach` does today (`base_v3.go:542-593`).
   - **Step 2 (Cross-level ramp carving):** If after clearing solids a walkable plateau component at level $L > 0$ still has no edge-height-connected path to the chunk's main `level 0` (or lowest-level) trunk component, `ensureReach` scans the boundary between the stranded plateau and the trunk component inside `2..S-3`:
     - If it finds a 3-row south face (`SlopeFace`, $k=1$), it converts 2 adjacent columns of that face into a `SlopeSouth` ramp.
     - Otherwise, if it finds a north/east/west 1-level step, it converts a $2 \times 2$ block into `SlopeNorth`/`SlopeEast`/`SlopeWest`.
     - **Fallback:** If no valid ramp site exists (e.g. a narrow 1-tile spire), it demotes the stranded component's tiles to the trunk level $L-1$ and re-runs face rows.
   - **Step 3 (Entity placement guard in `detail_v3.go`):** Camps, nodes, chests, story sites, and place marks (`detail_v3.go`) are ONLY placed on tiles belonging to the chunk's trunk-connected walkable component. No entity can ever spawn on an unwalkable crag or cliff lip.
3. **Held Chunks & Saved Players (`store/chunks.go` & `WorldScene.ts`):**
   - **Held chunk borders (`base_v3.go:191-316`):** Any stored chunk in `holds` (or `still` / `fixed`) passed in `Kept` (`base_v3.go:192`) has its boundary level profile read (`0` for all legacy `v3` held chunks; `c.TileLevel(tx, ty)` for `v4` held chunks). Within $6$ tiles of a `Kept` neighbour edge, the new chunk's continuous elevation $H(tx, ty)$ smoothly blends to match the `Kept` neighbour's boundary level along that edge, and `heldThrough` (`base_v3.go:258`) carves a same-level walkable corridor from every open edge tile of the held chunk into the new chunk's main trunk component.
   - **Unstranding saved players on regeneration:** If a player's saved `player_place` (`x, y` in `outdoors`) lands on a tile that, after chunk regeneration, is now a `SlopeFace` or `solid` tile, `arrive()` (`src/game/scenes/world-arrival.ts`) and server sight validation (`server/internal/api/sight.go`) spiral-search outward (up to radius $12$ tiles) for the nearest walkable flat plateau tile in the chunk's main connected component and nudge the player there on load.

### 2.5 Preparing for the Next Rounds (Water & Caves)

- **Water (Rules 6 & 7 — next round):**
  - Because every tile has an underlying continuous scalar `H(tx, ty) in [0..1024]` (`fields.go`), the water round does not have to guess which way "downhill" is on a flat level-0 or level-1 plateau: $-\nabla H(tx, ty)$ gives a globally coherent downhill drainage vector everywhere.
  - We also expose `BasinDepth(tx, ty) int` in `fields.go` (local closed minima of $H$ where `Wetness > 650` and `Relief < 350`), which pre-forms flat-bottomed **hollows** on level `0` (for meadow ponds and marshes), level `1–2` **cirque shelves** in `the-tops` (for alpine tarns), and **frozen kettle basins** in `whitequiet`. When a river crosses a south-facing cliff face (`SlopeFace`), those `3 * k` face rows become a **waterfall** (`k` levels tall) rather than a ramp.
- **Caves (`docs/planning/wide-world/cave-levels.md` — next round):**
  - Cave mouths (`cave-levels.md:43-47`) require a south-facing cliff face (`SlopeFace`, $k \ge 1$, so $\ge 3$ face rows: 1 `lintel` row + 2 `arch` rows) with a straight horizontal run of $\ge 2$ columns where the plateau behind (`ty - 1 .. ty - 8`) stays at level $\ge L_{\text{bot}} + 1$.
  - To guarantee `the-tops` has plenty of natural cave-mouth candidates without reserving ramps on every straight wall, the contour-segment pass in `the-tops` explicitly leaves at least one **unbroken 4-column south cliff face (`k >= 1`) backed by $\ge 8$ tiles of solid upland** per $2 \times 2$ chunk area, taggable via a helper `IsCaveMouthCandidate(tx, ty) bool`.

---

## 3. The Three Biomes

### 3.1 `hearthwick-woods` (`woods` and `meadow`)

- **Physical Regime (Rules 5–9):** Lowland basin (`Upland < 480`, `Warmth 450..700`, `Wetness 400..750`). 90% of tiles sit at `level 0`. Occasional `level 1` rises ($3$-row south faces with grassy/mossy `StyleRough` slopes or `StyleBuilt` stone steps on the old road) appear $\ge 6$ chunks outside Hearthwick as low wooded bluffs and rolling hills.
- **Sub-Lands & Rules 11–17:**
  - `woods` (`TreeCover >= 480`): Deciduous canopy (`tree` oak/ash/birch, `bush`, `fern`, `mushroom-ring`, `fallen-log`). Under Rule 14, trees cluster with $2\text{–}3$-tile canopy clearings around `glade` and `clearing` cells; under Rule 11, south-facing `level 1` slopes have sunnier `meadow_warm` grass and fewer ferns, while north-facing bases below a `level 1` rim have damp `moss` ground and denser ferns/mushrooms.
  - `meadow` (`TreeCover < 480`): Open `grass` and `clover` expanses with wildflower patches (`flower-patch`), lone erratic boulders (`rock` with Rule 13 smaller daughter stones and tall grass lee), and hedgerow shrub clusters along `woods` borders (Rule 10).
- **What changes near Hearthwick and the Tangle:**
  - **Hearthwick (`cx: -2..2, cy: -1..2`) & Lot Chunks (`fixed.go:24-95`) & The Tangle (`cx: -1..1, cy: -2..0`):** Remain strictly at `level 0` (`H(tx, ty) == 0`) with a $6$-tile flat apron around their outer perimeter so every gate, road exit, and homestead lane connects seamlessly at `level 0`.
  - **The Still Epoch (`the Tangle`):** Keeps `GeneratorV3` / `LandformV1`'s exact `level 0` layout (or pins `level 0` everywhere inside `still`) so existing Tangle discoveries, lanterns, and Echo sites do not shift.
  - **The Commons & Old Road (`road.go`):** Where the old road climbs a `level 1` bluff further out in `hearthwick-woods`, it automatically cuts a 2-tile-wide `StyleBuilt` stone staircase (`SlopeSouth` or `SlopeNorth`) through the bluff (`Rule 16`).

### 3.2 `the-tops` (Upland Ridge, Crag, Scree, High Meadow)

- **Physical Regime (Rules 5, 8, 9):** High elevation (`Upland 520..1024`), high relief (`Relief 450..950`), cooler temperatures (`Warmth 260..520` via altitude lapse rate), wind-exposed ridges. Spans all four surface levels (`0, 1, 2, 3`).
- **Sub-Lands (added to `content/wilds.json`):**
  1. `foothill` (`level 0..1` outer rim): Bracken, heather, wind-bent pines (`tree` variant `pine`), stone outcrops, and `StyleRough` grassy-scree ramps stepping up from `hearthwick-woods` into `level 1`.
  2. `high-meadow` (`level 1..2` benches & saddles): Sheltered alpine turf (`grass_alpine`, `heather`) tucked in concave benches between cliffs; hosts mountain grazing clearings and future tarn basins.
  3. `scree` (`level 1..2` below south-facing cliffs): Rule 12 & Rule 13 talus aprons! Directly south of any `SlopeFace` (`1..4` tiles from the cliff toe), ground transitions to `scree` / `gravel` with clustered angular `rock` and small talus rubble decor.
  4. `crag` (`level 2..3` ridges & summits): Above timberline (`Rule 8 & 9`: zero tall deciduous trees on `level 3`; only stunted krummholz shrubs on `level 2` leeward ledges). Exposed `stone_slate` / `crag_rock` ground, wind-scoured lichen, cairn story sites (`SITE_KIND_CAIRN`), and broad flat summit tables (`level 3`) with panoramic sightlines over lower levels.
- **Slopes & Ruined Traces (Rule 16):** Natural passes use `StyleRough` scree/bedrock ramps and 2-stage switchbacks; ancient ridge trails and cairn approaches use weathered `StyleBuilt` mountain steps.

### 3.3 `whitequiet` (The Cold Biome + The Named Northern Place)

Per `synthesis.md`, **Whitequiet is both a cold region biome (`whitequiet`) AND a specific named northern sanctuary place (`whitequiet-sanctuary`)** inside the prime northern Whitequiet region at `(rx = 0, ry = -2)`.

- **Physical Regime (Rules 5, 8, 9):** Low warmth (`Warmth < 340`), low-to-moderate relief (`Upland 150..520`, predominantly `level 0` and `level 1` gentle frost benches, with rare `level 2` wind-carved ice/stone ridges on its northern rim), moderate wetness (`Wetness 350..700` held as snowpack and hoarfrost).
- **Sub-Lands (added to `content/wilds.json`):**
  1. `frost-wood` (`TreeCover >= 420`): Pale silver-barked birch and snow-laden spruce (`tree` variants `frost-birch`, `snow-pine`), wide hushed spacing (`Rule 14`: lower understory density than `woods`, because deep snow suppresses brambles), ground palette `snow_soft` with `frost_moss` rings under tree drip-lines (`Rule 11`).
  2. `snow-hollow` (`TreeCover < 420`, low `Upland`): Open, wind-smoothed snowfields (`snow_drift`) broken by dark erratics (`Rule 13`), frozen reed beds in low hollows (`SITE_KIND_REEDS`), and pale lichen stones.
  3. `rime-ridge` (`level 1..2` benches): Exposed slate and packed wind-crust (`snow_crust`, `stone_frost`) with `StyleRough` snow-packed ramps and `StyleBuilt` frost-heaved stone steps near ancient markers.
- **The Named Place (`whitequiet-sanctuary` at region `(0, -2)`):**
  - Anchored at the heart of the northern Whitequiet region (`cx = 0, cy = -64`, ~1,500 tiles north of Hearthwick) as a `3 x 3` chunk **curated/hybrid place cell** (or multi-chunk landmark reserve) on a sheltered `level 1` amphitheatre surrounded by a horseshoe of `level 2` `frost-wood` and `rime-ridge` cliffs to the north, east, and west, opening south via a wide `StyleBuilt` stone stair (`SlopeSouth`).
  - At its centre stands the **Whitequiet Great-Cairn / Hushed Stone** (`WildsPlaceMark` kind `"whitequiet"`), a windless clearing where snow falls straight down, enemies never spawn within a $16$-tile sanctuary radius, and a communal hearth/lamp stone lets travellers rest and warm up in the deep north.

---

## 4. Wire and Storage

### 4.1 Proto Encoding of Levels, Faces, and Slopes (`proto/glimway/v1/wilds.proto`)

Today `WorldChunk` (`proto/glimway/v1/wilds.proto:40-63`) carries `ground` ($288\text{ bytes}$, 4 bits/tile) and `solid` ($72\text{ bytes}$, 1 bit/tile). To carry height, cliff faces, and slopes for all $576$ tiles ($24 \times 24$) with zero ambiguity and minimal bytes, we add **one compact `bytes height = 25;` field** (plus optional `string biome = 26;` for region HUD/map naming) to `WorldChunk` and `WildsGlimpse`:

```protobuf
message WorldChunk {
  // ... existing fields 1..24 ...
  // Per-tile height descriptor (576 bytes when any tile in the chunk is non-flat
  // or level > 0; empty/omitted when every tile in the chunk is flat level 0).
  bytes height = 25;
  // The region biome id owning this chunk's centre ("hearthwick-woods", "the-tops", "whitequiet").
  string biome = 26;
}

message WildsGlimpse {
  WildsChunkKey chunk = 1; string land = 2; bool river = 3;
  uint32 level = 4; string biome = 5;
}
```

**Bit packing of each byte in `WorldChunk.height` (1 byte per tile = 576 bytes max):**

| Bits | Field | Values | Meaning |
| :--- | :--- | :--- | :--- |
| `0..1` (2 bits) | `level` | `0..3` | For flat tiles: plateau level `0..3`. For `SlopeFace`: `faceBot` (`0..2`). For ramps (`SlopeSouth/N/E/W`): lower level `bot` (`0..2`, since `top = bot + 1`). |
| `2..4` (3 bits) | `kind` | `0..5` | `0 = Flat`, `1 = SlopeFace`, `2 = SlopeSouth`, `3 = SlopeNorth`, `4 = SlopeEast`, `5 = SlopeWest`. |
| `5..7` (3 bits) | `meta` | `0..7` | **When `kind == SlopeFace`:** encodes `(faceTop - faceBot, faceRow)` or direct `faceRow` ($0\dots 8$) + `span` via lookup table (Wait: for $k \in \{1,2,3\}$ there are $3 + 6 + 9 = 18$ possible `(k, row)` pairs! Let's pack `kind + meta` cleanly in the upper 6 bits `bits 2..7` = $0\dots 63$!). |

**Exact 1-byte (`uint8`) opcode layout per tile (`bits 0..1` = base `level` $0\dots 3$; `bits 2..7` = 6-bit `shape` $0\dots 63$):**

- `shape == 0`: **Flat plateau** at `level` (`0..3`). (Byte `0x00` = flat level 0!)
- `shape in 1..18`: **South cliff face (`SlopeFace`)** with base `faceBot = level`:
  - `1..3`: $k = 1$ (`faceTop = level + 1`), `faceRow = 0..2`
  - `4..9`: $k = 2$ (`faceTop = level + 2`), `faceRow = 0..5`
  - `10..18`: $k = 3$ (`faceTop = level + 3`), `faceRow = 0..8`
- `shape in 19..30`: **South ramp (`SlopeSouth`, $k = 1$, 3 rows)** from `top = level + 1` to `bot = level`:
  - `19..21`: `StyleRough`, `row = 0..2` (`left` or interior column)
  - `22..24`: `StyleRough`, `row = 0..2` (`right` edge column, for cheek rendering)
  - `25..27`: `StyleBuilt`, `row = 0..2` (`left` column)
  - `28..30`: `StyleBuilt`, `row = 0..2` (`right` column)
- `shape in 31..54`: **North / East / West ramps (`SlopeNorth`, `SlopeEast`, `SlopeWest`, $k = 1$, 2 or 3 tiles long)** from `bot = level` to `top = level + 1`:
  - 3 directions $\times$ 2 styles (`Rough` / `Built`) $\times$ 4 step fractions (`1/3`, `1/2`, `2/3`, `full`) = 24 codes (`31..54`).
- `shape in 55..63`: Reserved for next rounds (waterfall face rows, cave mouth lintel/arch/threshold).

**Budget verification (`budget_v3_test.go:79-129`):**
- **Byte size:**
  - For flat `level 0` chunks (Hearthwick, Tangle, most of `hearthwick-woods`): `height` is all `0x00`, so `proto.go` omits `height` (`nil`), costing **0 bytes**!
  - For chunks with elevation (`the-tops`, bluffs): `height` is exactly **576 bytes** (+ 3 bytes protobuf tag/varint = **579 bytes**). Current `GeneratorV3` chunks average $1.6\text{–}2.4\text{ KiB}$ raw proto (`chunkRawBudget = 6144` bytes in `budget_v3_test.go:19`). Adding $579$ bytes brings mountain chunks to $\sim 2.2\text{–}3.0\text{ KiB}$, leaving **$> 3.1\text{ KiB}$ of headroom** under the $6\text{ KiB}$ budget.
- **CPU time (`p95 <= 5 ms`):**
  - Coarse $5 \times 5$ field sampling + bilinear interpolation + 17-tile column stencil + contour-segment ramp lookup uses pure integer math (`int64` / `uint64`) with zero heap allocations per tile. Estimated added time per chunk is **$\sim 0.35\text{ ms}$**, keeping `p95` well under $2.5\text{ ms}$ (vs the $5\text{ ms}$ budget in `budget_v3_test.go:127`).

### 4.2 Generator Version vs. Landform Version (`epoch_v3.go`)

- **Recommendation:** Bump `LandformVersion` from `LandformV1 = 1` to **`LandformV2 = 2`** (`epoch_v3.go:17-18`), and keep `GeneratorVersion = GeneratorV3 = 3` (or bump to `GeneratorV4 = 4` if we want `wilds_chunks.generator_version` to self-tag height-capable chunks; keeping `GeneratorV3 = 3` avoids creating a duplicate `wild_epochs` row since `wild_epochs_current` indexes `(world_id, kind, generator_version, starts_at)` in `034_open_map.sql:20`).
- Specifically: keep `GeneratorV3 = 3` on `wild_epochs`, bump `LandformVersion = LandformV2 = 2` in `epoch_v3.go:18`, and store `WorldChunk.Height` whenever any tile is non-zero. Old clients or `v3` held chunks with empty `height` simply decode as flat `level 0`.

### 4.3 Region Pin Table & Migration `041_terrain_height_biomes.sql`

Add migration `server/internal/store/migrations/041_terrain_height_biomes.sql`:

```sql
-- Region biome pins (synthesis.md): pinned when a chunk in the region is first
-- generated so future biome additions never mutate already-found regions.
CREATE TABLE region_pins(
 world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
 rx INTEGER NOT NULL,
 ry INTEGER NOT NULL,
 biome TEXT NOT NULL,
 biome_version INTEGER NOT NULL DEFAULT 1,
 pinned_at INTEGER NOT NULL,
 PRIMARY KEY(world_id, rx, ry)
);

-- As in 039 and 040: drop unheld wick chunk bodies and their unheld generated
-- entity state so the open world remakes them with LandformV2 height & biomes.
-- Held chunks (in holds), the still epoch (the Tangle), and fixed town/lot
-- chunks keep their stored bodies untouched; player paths (world_changes),
-- places found, and lanterns stay.
DELETE FROM wilds_chunks
 WHERE epoch_id IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=wilds_chunks.epoch_id
     AND h.layer=wilds_chunks.layer AND h.cx=wilds_chunks.cx AND h.cy=wilds_chunks.cy);
DELETE FROM fight_fall_witnesses
 WHERE layer=0 AND epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=fight_fall_witnesses.epoch
     AND h.layer=0 AND h.cx=fight_fall_witnesses.cx AND h.cy=fight_fall_witnesses.cy);
DELETE FROM fight_falls
 WHERE layer=0 AND epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=fight_falls.epoch
     AND h.layer=0 AND h.cx=fight_falls.cx AND h.cy=fight_falls.cy);
DELETE FROM entity_state
 WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND length(entity_id)-length(replace(entity_id,':',''))=3
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=entity_state.epoch AND h.layer=0
     AND substr(entity_state.entity_id,instr(entity_state.entity_id,':')) LIKE ':'||h.cx||':'||h.cy||':%');
DELETE FROM camp_claims
 WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND length(entity_id)-length(replace(entity_id,':',''))=3
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=camp_claims.epoch AND h.layer=0
     AND substr(camp_claims.entity_id,instr(camp_claims.entity_id,':')) LIKE ':'||h.cx||':'||h.cy||':%');
DELETE FROM personal_claims
 WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND length(entity_id)-length(replace(entity_id,':',''))=3
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=personal_claims.epoch AND h.layer=0
     AND substr(personal_claims.entity_id,instr(personal_claims.entity_id,':')) LIKE ':'||h.cx||':'||h.cy||':%');
DELETE FROM discoveries
 WHERE epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')
   AND length(entity_id)-length(replace(entity_id,':',''))=3
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.epoch_id=discoveries.epoch AND h.layer=0
     AND substr(discoveries.entity_id,instr(discoveries.entity_id,':')) LIKE ':'||h.cx||':'||h.cy||':%');
```

**What happens to existing held chunks:**
Every held chunk in `holds` retains its stored protobuf blob (`height` empty = flat `level 0`). When a neighbour chunk is generated beside that held chunk (`store/chunks.go:367-437`), `kept` passes the held chunk to `w.fill()`, which clamps $H(tx, ty) \to 0$ across the 6-tile seam buffer so the new `LandformV2` terrain meets the held `level 0` chunk without any cliff step or broken path.

---

## 5. The Client

### 5.1 Porting Height-Lab into the Real Wilds Client (Reuse vs. Rewrite)

Here is the exact file-by-file disposition of `src/game/height-lab/`:

| Height-Lab File | Disposition | Target in Real Client & How It Integrates |
| :--- | :--- | :--- |
| `src/game/height-lab/levels.ts` | **Promote & Reuse (~85%)** | Move pure math (`EdgeHeights`, `ROWS_PER_LEVEL = 3`, `canStep`, `levelTint`, `levelFog`) to `src/game/wilds/levels.ts`. Replace the monolithic `AreaGrid` lookup with a chunk-aware `wildsTileHeight(tx, ty)` and `wildsEdgeHeights(tx, ty)` backed by the loaded chunks in `src/game/wilds/store.ts`. |
| `src/game/height-lab/art.ts` | **Port into Paint Worker (~80% reuse)** | Currently `src/game/wilds/paint-worker.ts` paints a $384 \times 384$ RGBA bitmap per chunk off-thread (`terrain.ts:72-122`). Port `drawFaceCell`, `drawBuiltSlopeCell`, `drawRoughSlopeCell`, and the N/E/W cliff rim + cast-shadow pass from `height-lab/art.ts:154-323` **directly into `src/game/wilds/paint-worker.ts`**! Because `paintChunk` already receives a $26 \times 26$ padded tile grid (`paint-worker.ts:20`, including 1-tile neighbour ring), passing a `Uint8Array(26 * 26)` of `height` bytes lets the Web Worker paint all cliff strata, mossy ledges, stone stair treads, rough scree tracks, lip highlights, and drop shadows straight into the chunk's single $384 \times 384$ ground texture! |
| `src/game/height-lab/look.ts` & `lighting.ts` | **Promote & Reuse (~90%)** | Promote `Lighting` (`height-lab/lighting.ts:47-146`) and the level-fog postFX shader (`height-lab/look.ts:34-97`) into `src/game/lighting/unified-lighting.ts` and `src/game/wilds/level-fog.ts`. Attach once to `WorldScene.cameras.main` when `this.world.open` is true (`WorldScene.ts:446`). |
| `src/game/height-lab/scene.ts` | **Extract Collision & Depth (~40% reuse)** | Do **not** port `HeightLabScene` itself; instead port its edge-height movement blocker (`height-lab/levels.ts:127-139`) into `Hero` / `AttachedChunk` collision and its level-aware depth offset (`y + level * 0.5`) into `AttachedChunk`. |
| `src/game/height-lab/area.ts` & `mountain.ts` | **Keep in Height-Lab Only** | The server generator (`server/internal/wilds/`) replaces client-side procedural height generation. |

### 5.2 How `WildsWindow`, `AttachedChunk`, Collision, and Fog Work Together

1. **Zero Extra Sprites for Cliffs and Slopes (`src/game/wilds/window-chunk.ts` & `paint-worker.ts`):**
   - In `src/game/wilds/terrain.ts:75-100`, `paintWildsChunk` builds the $26 \times 26$ `cells` array and now also a $26 \times 26$ `heights` `Uint8Array` (from `chunk.height` + the 4 neighbours' border `height` bytes).
   - Inside `paint-worker.ts`, after painting the base terrain splats and transitions, any tile with `shape != 0` runs the ported pixel-art painters from `height-lab/art.ts`:
     - `SlopeFace` (`shape 1..18`): paints the layered stone/earth cliff face (`faceRow 0..3k-1`), top grass/snow overhang lip (`faceRow == 0`), horizontal strata seams every 3 rows, and basal ambient occlusion (`faceRow == 3k-1`).
     - `SlopeSouth` / `N` / `E` / `W`: paints `StyleBuilt` stone steps + cheek walls or `StyleRough` slanted scree/turf tracks.
     - Flat plateau tiles with a lower N, E, or W neighbour (detected from the $26 \times 26$ `heights` ring): paints the 2px dark stone rim and 4px drop shadow along that edge (`height-lab/art.ts:197-211`).
     - **Base level brightness (`levelTint`):** Each tile's pixels in `paint-worker.ts` are multiplied by the subtle level value shift (`level 0: 0.94`, `level 1: 1.00`, `level 2: 1.05`, `level 3: 1.10`) so higher plateaus read brighter even before shader fog.
2. **Edge-Aware Collision (`src/game/wilds/window-chunk.ts` & `src/game/entities/hero.ts`):**
   - Today `AttachedChunk` (`window-chunk.ts:138-145`) spawns a $16 \times 16$ static Arcade body on every `solid` tile.
   - `SlopeFace` tiles (`shape 1..18`) have `solid = 1` set by the server generator, so Arcade physics automatically blocks walking into a south cliff face.
   - What about **North, East, and West cliff drops** (and ramp cheek walls), where both the upper lip tile and the lower floor tile are walkable (`solid = 0`), but the **edge between them** has $|\Delta h| \ge 0.5$?
   - **Solution:** Add a lightweight **edge-step clamp** in `Hero.preUpdate` (and `EnemySystem` / `AvatarVisual`), gated on `this.world.open`: before applying velocity `(vx, vy)` for frame $\Delta t$, check if the hero's foot box crosses from tile `(tx0, ty0)` into `(tx1, ty1)`. If `tx1 != tx0` or `ty1 != ty0`, call `canStepWilds(tx0, ty0, dir)` (which compares the two tiles' `EdgeHeights` from the loaded chunk's `height` byte in $O(1)$ array lookup). If `!canStepWilds`, zero the velocity component across that tile edge and clamp the foot coordinate to the tile rim (`2px` inset). This matches `HeightLabScene`'s exact feel (`height-lab/scene.ts:392-425`) and requires **zero extra Arcade physics bodies**!
3. **Level-by-Level Atmospheric Fog (`height-lab-4-notes.md`):**
   - When the hero walks onto a tile with level $L_{\text{hero}}$ (interpolated smoothly on ramps), `WildsWindow` updates a smoothed float `cameraLevel` ($\tau = 180\text{ ms}$).
   - For each attached chunk in `WildsWindow`, we upload a tiny **$24 \times 24$ R8 level texture** (or sample a $120 \times 120$ window-wide level texture covering the $5 \times 5$ attached chunks = $14.4\text{ KiB}$ total) to the camera's `LevelFogPostFX` shader (`height-lab/look.ts:34-97`).
   - Tiles with $L_{\text{tile}} < \text{cameraLevel}$ receive cool atmospheric mist ($\alpha = \text{clamp}((\text{cameraLevel} - L_{\text{tile}}) \cdot 0.14, 0, 0.36)$, tinted toward `#8fa4b8` by day and `#1c2638` at night), making `level 3` summits in `the-tops` feel high above the misty `level 0` valley floor without adding a single Phaser display object.
4. **Unified `Lighting` (`height-lab/lighting.ts`):**
   - Replace ad-hoc outdoor dark overlays with the unified `Lighting` class (`src/game/height-lab/lighting.ts:47`), which combines time-of-day ambient sky colour, player lantern glow, communal lamps (`WildsCommunalLamps`), and campfires into one shared lightmap RT.

### 5.3 Phone Draw and Memory Cost

- **Extra draw calls per chunk:** **0** (all cliff faces, built/rough slopes, rims, and level brightness tints are baked into the existing $384 \times 384$ chunk ground canvas inside `paint-worker.ts`).
- **Extra post-FX passes:** **1** lightweight fragment pass (`LevelFogPostFX` on `cameras.main`), sampling one $120 \times 120$ (`14.4 KiB`) R8 window level texture.
- **Extra RAM per attached chunk:** `576 bytes` (`Uint8Array(576)`) for `chunk.height` $\times 25$ attached chunks = **`14.4 KiB` total**.
- **Extra Arcade physics bodies:** **0** (cliff edges use $O(1)$ `canStepWilds` edge-height clamping on `chunk.height`).

---

## 6. The World Lab (`server/internal/worldlab/`)

To inspect and verify fields, regions, levels, cliff faces, and level-aware reachability without booting the game client, we extend `server/internal/worldlab/` (`lab.go`, `render.go`, `worldlab.go`, `server/cmd/worldlab/main.go`, and `server/cmd/worldlab/index.html`):

### 6.1 New Overlays (`OverlayNames` in `worldlab.go:42`)

Add four new overlay flags to `OverlayNames` (`main.go:60`, `render.go:195`):

1. **`height` (hypsometric tint + contour lines + cliff faces):**
   - Renders levels `0..3` with distinct elevation relief shading (`level 0` valley green `#4e6e58`, `level 1` buff `#8fa068`, `level 2` ochre `#b89864`, `level 3` alpine slate/ivory `#d8d4cc`).
   - Draws $1\text{px}$ dark contour lines on N/E/W level steps, bands of dark terracotta (`#5a3d31`) on `SlopeFace` rows (`3 * k` rows), bright cyan ticks (`#4ce0d2`) on `StyleRough` ramps, and gold ticks (`#f2c14e`) on `StyleBuilt` stairs.
2. **`biomes` (region boundaries + ecotone bands + pins):**
   - Colors regions by biome (`hearthwick-woods` forest green, `the-tops` ridge amber/slate, `whitequiet` pale ice-blue `#cfe4f2`), outlines the 16-tile ecotone blend band (`DistTiles <= 8`), and marks the region seed `(sx, sy)` with its `biome@version` label and a pin icon if pinned.
3. **`fields` (continuous scalar inspection):**
   - Supports `--field upland|relief|wetness|warmth|treecover|basin` to render any raw continuous field $[0..1024]$ as a magma/viridis heatmap at `atlas` or `region` scale so we can tune wavelengths and lapse rates visually before quantizing.
4. **Upgraded `reach` (`lab.go:199-243`):**
   - Upgrade `reach()` in `server/internal/worldlab/lab.go:199-243` from flat 4-neighbour `solid` BFS to **edge-height-aware BFS** (`canStepTile(a, b)` checking `SlopeFace` and edge heights).
   - Flood-fills from the Hearthwick gates (`lab.go:220-231`):
     - Reachable walkable tiles are tinted green (`rgb{70, 210, 120}`, `render.go:240`).
     - **Unreachable walkable plateau tiles** (e.g. a mountain bench missing a ramp) are highlighted in **magenta (`rgb{235, 65, 210}`)** and counted separately in `Stats.UnreachablePlateauTiles` (`worldlab.go:70`) so CI and `worldlab region -reach` fail immediately if any plateau is stranded!

### 6.2 `TileInfo` Hover Inspector & Version Diff (`worldlab diff`)

- Extend `TileInfo` (`worldlab.go:93-106`) returned by `/api/tile` in `worldlab serve` so hovering any tile in `server/cmd/worldlab/index.html` displays:
  - `Region`: `(rx, ry)`, `Biome`: `"the-tops@1"`, `EcotoneDist`: `11`
  - `Fields`: `Upland: 684, Relief: 590, Wetness: 310, Warmth: 380, TreeCover: 190`
  - `Height`: `Level: 2, Slope: "face (row 2/3, 2->1)"` or `"ramp-south (rough, row 1/3)"`, `Reachable: true`
- Extend `DiffStats` (`worldlab.go:78-90`) in `worldlab diff` with:
  - `LevelChanged int`, `BiomeChanged int`, and `StrandedDelta int`, plus support for `--pin-file pins.json` so we can verify in `worldlab diff` that adding a new biome rule changes unpinned regions while leaving pinned regions **100% byte-identical**.

---

## 7. The Build Plan

Ordered from riskiest/foundational to visual polish, structured into **5 shippable, testable lanes**. Every lane leaves all tests green and can be inspected visually in `worldlab` or the game client.

```mermaid
flowchart LR
  L1["Lane 1: Fields, Regions & Height Stencil (Server + Worldlab)"] --> L2["Lane 2: Biomes, Slopes, Reachability & Wire (Server + Proto)"]
  L1 --> L3["Lane 3: Client Height Paint Worker & Edge Collision"]
  L2 --> L4["Lane 4: Migration 041, Region Pins & Whitequiet Sanctuary"]
  L3 --> L4
  L3 --> L5["Lane 5: Level Fog PostFX & Unified Lighting in WorldScene"]
  L4 --> L5
```

### Lane 1 — Continuous Fields, Laguerre Regions & the `3*k` Height Stencil (Server + Worldlab)
- **Why first (highest risk):** Proves the core mathematical invariants—eliminating the Apollonius circles in `lands.go`, tuning the macro/meso field scales (`Upland`, `Relief`, `Wetness`, `Warmth`), and proving that the local 17-tile column stencil produces valid `3*k` south cliff faces across chunk seams with zero seam cracks.
- **Files touched:**
  - New `server/internal/wilds/fields.go` (2D lattice noise, coarse $5 \times 5$ chunk interpolator, `Upland`, `Relief`, `Wetness`, `Warmth`, `TreeCover`, `BasinDepth`).
  - New `server/internal/wilds/regions.go` ($32$-chunk Laguerre regions, 2-octave domain warp, home-ring biome guarantee, 16-tile ecotone distance).
  - New `server/internal/wilds/height.go` (`HeightCell`, $L \in \{0..3\}$ quantization, N-to-S `3*k` face reservation stencil, contour-segment ramp & switchback placement).
  - Update `server/internal/wilds/lands.go` (replace multiplicative `d * bestS * bestS < bestD * s * s` with additive Laguerre distance + 2-octave warp).
  - Update `server/internal/worldlab/` (`worldlab.go`, `lab.go`, `render.go`, `main.go`, `index.html`) with `height`, `biomes`, `fields`, and level-aware `reach` overlays.
- **What it proves:** `worldlab atlas -biomes`, `worldlab region -height -reach` show natural non-circular regions, `the-tops` and `whitequiet` within 1–2 regions of Hearthwick, unbroken `3*k` south faces across chunk boundaries, and `0` unreachable plateau tiles.
- **Rough size:** Medium (~650 LoC Go + ~180 LoC worldlab).

### Lane 2 — The Three Biomes, Rule 8–17 Details, Level-Aware `ensureReach` & Proto Wire
- **Can run in parallel with:** Lane 3 (once the 1-byte `height` encoding table from Section 4.1 is agreed).
- **Files touched:**
  - `proto/glimway/v1/wilds.proto` + generated Go/TS protobufs (`WorldChunk.height = 25`, `WorldChunk.biome = 26`, `WildsGlimpse.level = 4`, `WildsGlimpse.biome = 5`).
  - `content/wilds.json` (new lands `foothill`, `high-meadow`, `scree`, `crag`, `frost-wood`, `snow-hollow`, `rime-ridge` + palettes and decor rules).
  - `server/internal/wilds/base_v3.go`, `detail_v3.go`, `proto.go`, `epoch_v3.go` (`LandformV2 = 2`, Rule 10 ecotone dither, Rule 11–14 aspect/talus/tree clustering, Rule 16 `StyleBuilt` stairs on roads/routes, level-aware `ensureReach`, kept-chunk 6-tile level clamping).
  - `server/internal/wilds/budget_v3_test.go` (assert `p95 <= 5 ms`, raw proto `<= 6 KiB`, zero seam mismatches on `height` bytes, and 100% level-aware reachability across 100 random chunks).
- **What it proves:** Server emits complete height- and biome-aware `WorldChunk` protobufs within the $5\text{ ms}$ and $6\text{ KiB}$ budgets.
- **Rough size:** Medium (~550 LoC Go + JSON content).

### Lane 3 — Client Height Paint Worker, Palettes & Edge-Height Collision
- **Can run in parallel with:** Lane 2.
- **Files touched:**
  - New `src/game/wilds/levels.ts` (promoted from `src/game/height-lab/levels.ts`: `decodeHeightByte`, `EdgeHeights`, `canStepWilds`, `levelTint`).
  - `src/game/wilds/paint-worker.ts` & `src/game/wilds/terrain.ts` (port `drawFaceCell`, `drawBuiltSlopeCell`, `drawRoughSlopeCell`, N/E/W rim + drop shadow, level tint, and new `the-tops` / `whitequiet` ground palettes into the off-thread chunk painter).
  - `src/game/wilds/window-chunk.ts`, `src/game/wilds/store.ts`, `src/game/entities/hero.ts` (pass `chunk.height` to worker, apply `canStepWilds` edge-height clamping on N/E/W cliff drops and ramp cheeks).
- **What it proves:** Players can walk out of Hearthwick into `the-tops` and `whitequiet`, see `3*k` cliff faces, built stone stairs, and rough scree ramps rendered at 60 fps on phone, climb ramps to `level 3`, and be stopped cleanly by cliff edges.
- **Rough size:** Medium (~500 LoC TS).

### Lane 4 — SQLite `region_pins`, Migration `041`, Held-Seam Verification & Whitequiet Sanctuary
- **Depends on:** Lanes 2 & 3.
- **Files touched:**
  - `server/internal/store/migrations/041_terrain_height_biomes.sql` + `history.json`.
  - `server/internal/store/chunks.go` (load/insert `region_pins` on chunk generation, pass pinned `RegionLookup` to `wilds.GenerateChunk`, spiral-unstrand check for saved player positions).
  - `server/internal/wilds/places.go` / `detail_v3.go` (the northern `whitequiet-sanctuary` landmark amphitheatre at region `(0, -2)`).
- **What it proves:** Existing worlds upgrade cleanly, held chunks stay at `level 0` with smooth 6-tile seam transitions into new `LandformV2` neighbours, visited regions pin `biome@version`, and the northern Whitequiet place is reachable and discoverable.
- **Rough size:** Small–Medium (~350 LoC Go + SQL).

### Lane 5 — Level-by-Level Fog PostFX & Unified `Lighting` in `WorldScene`
- **Depends on:** Lane 3.
- **Files touched:**
  - Promote `src/game/height-lab/lighting.ts` $\to$ `src/game/lighting/unified-lighting.ts` and `src/game/height-lab/look.ts` $\to$ `src/game/wilds/level-fog.ts`.
  - `src/game/wilds/window.ts` & `src/game/scenes/WorldScene.ts` (maintain the $120 \times 120$ window level texture, smooth `cameraLevel` as the hero climbs, attach `LevelFogPostFX` and `Lighting`).
- **What it proves:** Standing on a `level 3` summit in `the-tops` wraps `level 0..2` below in progressive atmospheric mist; night, dusk, and lantern pools use the unified height-lab lighting model.
- **Rough size:** Small (~300 LoC TS).

---

## 8. Risks and Open Questions for the Owner

### Top Technical Risks & Mitigations

1. **Cross-Chunk South Cliff Seams (`3*k` rows crossing `ty = 23 -> ty = 0`):**
   - *Risk:* A `level 3 -> 0` drop starting near the bottom of chunk `(cx, cy)` needs $9$ rows of `SlopeFace`, spilling up to $8$ rows into `(cx, cy + 1)`. If each chunk quantized levels only inside its own $24 \times 24$ grid, the south chunk wouldn't know a cliff started north of its border.
   - *Mitigation:* Our North-to-South Morphological Stencil (Section 2.2) evaluates $H$ on `(tx, ty - 12 .. ty + 4)` in world tile coordinates. Both chunks run the identical deterministic function on the shared world coordinates, guaranteeing byte-for-byte agreement across `ty = 23 / 0` without cross-chunk state.
2. **Canopy & Tall Prop Occlusion Against Cliff Faces:**
   - *Risk:* A tree planted at `level 0` immediately south of a `SlopeFace` (`ty = faceBotRow + 1`) has a canopy extending $32\text{–}48\text{ px}$ upward on screen, visually overlapping the upper plateau lip at `level 1` or `2` and breaking the height illusion.
   - *Mitigation:* Under Rule 12 (`scree` / talus toe) and `base_v3.go`, forbid tall trees within $2$ tiles south of any `SlopeFace` (`ty + 1, ty + 2`), allowing only low `rock`, `scree`, `fern`, or `bush` pieces there so the cliff face and its base read clearly.
3. **Player Path Laying (`WildsPaths` / `GroundChange`) on Ramps and Cliff Faces:**
   - *Risk:* Players laying `"stone"` or `"plank"` tiles (`proto/glimway/v1/wilds.proto:170`) on a `SlopeFace` or a ramp could overwrite the cliff or ramp art.
   - *Mitigation:* Server path validation refuses `GroundChange` on `SlopeFace` tiles (already `solid`), and when a player lays `"stone"` on a `StyleRough` ramp (`SlopeSouth/N/E/W`), the client renders it by upgrading that ramp tile's visual style from `StyleRough` to `StyleBuilt` (dressed stone steps!).

### Open Questions for the Owner (with Concrete Recommendations)

1. **Laying Stone on a Rough Ramp $\to$ Built Stone Steps?**
   - *Question:* When a player lays a stone path (`GroundChange: "stone"`) across a natural `StyleRough` slope in the Wilds, should that tile visually upgrade into `StyleBuilt` dressed stone steps (and count as a laid tile for `Ways` between places)?
   - *Recommendation:* **Yes.** It connects player road-building (`Ways`) directly to the height model—turning a rough mountain scramble into a player-built stone staircase—at zero extra protocol cost (`GroundChanges` already exists).
2. **Glimpse Pinning vs. Sight-Window Pinning (`region_pins`):**
   - *Question:* Should panning the distant map window (`WildsGlimpse`) pin a region's `biome@version`, or should a region only pin when a player walks close enough for the server to generate a chunk in it (`EnsureChunks`)?
   - *Recommendation:* **Pin only on chunk generation (`EnsureChunks`), not on `WildsGlimpse`.** Map glimpses can reach dozens of chunks ahead of where anyone has walked; pinning only when a chunk is materialized preserves unvisited regions on the map periphery for future `@version` biome updates.
3. **Whitequiet Sanctuary Coordinates & Safe-Rest Rule:**
   - *Question:* We placed the named northern `whitequiet-sanctuary` place in the prime northern region `(rx = 0, ry = -2)` around `cx = 0, cy = -64` (~1,500 tiles / ~8–10 minutes' walk north of Hearthwick), with a 16-tile enemy-free hush around its central cairn/hearth. Does that distance and safe-haven rule match your vision for Whitequiet?
   - *Recommendation:* **Keep `cy = -64` (~64 chunks north) with a 16-tile sanctuary radius.** It is far enough north through `hearthwick-woods` and an intervening region to feel like a true expedition, while sitting comfortably inside the $\pm 4,096$-chunk border.
4. **The Still Epoch (The Tangle) Height:**
   - *Question:* Should the Tangle (`cx: -1..1, cy: -2..0`, `still` epoch) stay completely flat at `level 0` to preserve all existing Echo sites and paths, or gain `level 1` hollows?
   - *Recommendation:* **Keep the Tangle strictly at `level 0`.** It is the introductory onboarding woods and bridging corridor between the Commons and the wider Beyond; keeping `still` at `level 0` avoids any migration churn for onboarding quests and Echo sites while `level 1..3` begins immediately outside it.
