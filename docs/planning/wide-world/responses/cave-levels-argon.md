# Cave levels and the mouth — Argon decisions & analysis

*Branch: `exp/cave-levels-argon`, 2026-10-20. Analyst: Argon.*

## Decisions (what the fix lane builds, in order)

### Owner's words

- **On the HUD & smooth levels:** *"The lab HUD overlay changes quite a bit in caves. 'Level' looks like it turns into 'floor'? And it's no longer a smooth float but just an integer. I think keeping it 'level' is helpful, and it might be nice to be able to have smooth transitions."* / *"I like option 1."*
- **On the mouth's floor from outside:** *"When outside, it shows the entrance to have the same floor as the surroundings (grass), and it fades into the true cobbled floor of the cave as you transition. Unless it's super technically hard to change, I'd like to have the floor of the cave showing from the outside, depending on how much light is available."*
- **On level-change ghosting, depth darkening in lighting, and built vs. rough cave slopes:**
  - *"A weird visual artifact that shows up whenever the cave is changing levels. Part of the upper tiles overlap and are partially faded and mixed with the cave ones. Once I step into that next level it goes away and shows up on the next tile. Almost like there's some odd ghosting from levels above and below."*
  - *"One idea was stairs, but for more 'rough' cave designs (I love the current ones and might want both), stairs wouldn't fit."* / *"And yeah, I think having both types show in the lab could be helpful."*
  - *"And I think instead of 'fog' in a cave for different levels, the lighting system could just darken levels above and below to get that feeling of depth / travelling down and up (partially)."*

---

### Build order for the Opus fix lane & how to verify on CI screenshots

#### 1. Unify cave height onto the surface's smooth fractional `level` system (`scene.ts`, `light.ts`, `lighting.ts`)

- **What to build:**
  1. **HUD (`src/game/height-lab/scene.ts:583-586`):** Change `floor ${Math.round(v.z)}` to `level ${v.z.toFixed(2)}` so the HUD uses `"level"` and a smooth float everywhere (`In the cave · level ${v.z.toFixed(2)} · daylight …`).
  2. **Smooth level field (`src/game/height-lab/light.ts:240-278`, `src/game/height-lab/area.ts:113, 124`, `src/game/height-lab/lighting.ts:84, 119, 339`):**
     - Change `caveLevels(l: Layer)` from `Int8Array` to `Float32Array`:
       - `KIND.flat`: `l.edge[i * 4]!`
       - `KIND.slope`: midpoint `(lo + hi) / 2` of the tile's open edges (instead of `Math.floor(lo + 0.001)`), so height changes smoothly along every ramp.
       - `KIND.face`: `l.faceTop[i]! - (l.faceRow[i]! + 0.5) / ROWS_PER_LEVEL` (interpolated down the drop face).
       - `KIND.rock` / `KIND.water`: nearest floor's smooth height.
     - Pass fractional `m.thing.z` (not `Math.round(m.thing.z)`) to `this.lighting.move(...)` in `scene.ts:538`, and accept `Float32Array` in `Lighting.setLevels()` (`lighting.ts:119`).
- **How to check on CI (`e2e/height-lab-screens.spec.ts` / `states.json`):**
  - In `states.json` (and the HUD pill at the top of `m07-mid-tunnel.png`), standing mid-ramp at `(CAVE, 56, 63)` or `(CAVE, 30, 35)` shows `In the cave · level -0.50` (a fractional float, labeled `level`, not `floor -1`).
  - Add a unit test in `tests/height-lab.test.ts` verifying that `caveLevels` and `lighting.level(CAVE, ...)` vary smoothly without a half-level jump as a walker moves tile-by-tile down a ramp.

#### 2. Replace cave "fog" alpha with partial depth-darkening inside `Lighting`, keep `caveImages` opaque, and fix `sunnyFaceRock` (`scene.ts`, `lighting.ts`, `light.ts`, `art.ts`)

- **What to build:**
  1. **Keep the cave floor 100% opaque (`src/game/height-lab/scene.ts:478-479`):**
     - Paint the cave into a **single** `hl-cave` texture in `paintCave()` (`src/game/height-lab/art.ts:389-417`) (or keep `ci.img.setAlpha(inCave ? v.cave : 0)` with no `1 - this.depthOf(...)` alpha reduction). Once `v.cave === 1`, the cave floor and its walls have `alpha = 1` everywhere, so the `alpha = 1` surface ground, cliff faces, and pine trees underneath can **never** bleed through.
  2. **Darken levels above and below partially inside `Lighting` instead of cave "fog" (`src/game/height-lab/lighting.ts:209-236`, `src/game/height-lab/scene.ts:497-503, 543-546`):**
     - Remove cave `depthOf` from `Thing.twin` (`scene.ts:497`: `const fog = !onCave && !inCave ? this.fogOf(v.z, t.z) : 0`).
     - Pass the viewer's cave height `z: v.z` and partial depth-darkening strength (when `look.depth === 'darken'`) into `lighting.fill()` for the `CAVE` view (`scene.ts:543-546`).
     - In `Lighting.fill()`, sample the smooth `Float32Array` level field `levels[CAVE]` bilinearly at each texel (or per tile during fill) and multiply the cave light at that texel by `1 - depthDarken(texelZ - viewZ)` (e.g. using `fogFor(texelZ - viewZ, look.fogStrength)` capped around `0.55–0.65` so levels above and below are partially darkened to give the feeling of depth and travelling down/up, while lit floors and crystals below remain readable). Because `LightView` multiplies at `BAND.dark = 900,000`, this darkens both the floor and any movers on other levels smoothly with zero tile seams.
  3. **Fix `sunnyFaceRock` and `openAir` behind tunnels (`src/game/height-lab/light.ts:147-223`):**
     - In `sunnyFaceRock(stack, air, i)` (`light.ts:220-223`), only return `true` for rock tiles immediately flanking a mouth arch (`tx >= m.x0 - 1 && tx <= m.x1 + 1 && ty >= m.lintel && ty <= m.arch[1]`), **never** for rock south of a cave passage (such as `rows 22–24, cols 41–51` south of the east ramp `rows 20–21` in `area.ts`).
     - In `openAir(stack, top)` (`light.ts:147-189`), restrict the open-air flood from each mouth so it does not wrap behind a cliff face where a cave tunnel runs north of the face (or ensure `caveAmbient` keeps tiles south of an interior tunnel dark).
- **How to check on CI (`e2e/height-lab-screens.spec.ts`):**
  - Add 3 shots to `e2e/height-lab-screens.spec.ts` matching the owner's 3 ghosting screenshots:
    - `s09-east-ramp-top` at `(CAVE, 51, 20)` and `s10-east-ramp-mid` at `(CAVE, 46, 20)` in `shoulder`: verify the east-west ramp (`rows 20–21, cols 41–50`) has **no vertical seam**, **no surface moss bleeding through the cobbles**, and **a solid dark south rock wall** at `rows 22–24` (the exterior cliff face and plateau pine tree at `rows 22–26` do not show below the tunnel).
    - `s11-north-ramp-entry` at `(CAVE, 30, 38)` in `shoulder`: verify that looking north onto the ramp (`ty = 37..33`) shows **no green moss or pine tree** ghosting through `ty <= 37`, and the floor darkens smoothly down the slope.
  - Check existing `m09-ledge.png` (`(CAVE, 44, 31)` at `z = -2` overlooking the cavern at `z = -4`): the cavern two levels below is partially darkened by the light pass while its crystals still glow clearly.

#### 3. Show the cave's floor in the mouth from outside, shaded by available light (`art.ts`, `area.ts`, `mountain.ts`)

- **What to build:**
  1. When carving mouths in `buildLabArea()` (`src/game/height-lab/area.ts:324`) and `buildMountain()` (`src/game/height-lab/mountain.ts:140`), set `surface.ground[i]` on the `2×2` `m.arch` tiles to match `cave.ground[i]` (`G['cave-floor']` or `G['cave-rough']`), so `paintGround()` dithers the grass-to-stone transition naturally right at the mouth's southern threshold (`m.arch[1] + 1`).
  2. In `shadeSurface()` (`src/game/height-lab/art.ts:169-175`), for `k === KIND.mouth`, paint the cave floor pixel (`caveFloorPixel`, shared with `paintCave()` for `cave.ground[i]`) instead of tinting grass dark, and multiply it by the available light at that mouth tile (`area.ambient` / `cave.sky[i]`) times an arch-shadow curve (bright daylight on the stone floor at the foot of the arch `ty = m.arch[1]`, fading smoothly into dark shadow under the lintel at `ty = m.arch[0]` and within 2 px of the side walls).
- **How to check on CI (`e2e/height-lab-screens.spec.ts`):**
  - In `m01-approach.png` (`(SURFACE, 56, 77)`) and `s01-approach.png` (`(SURFACE, 30, 42)`): looking at the mouth from outside, the 2×2 arch shows **cobbled/stone cave floor** (no green grass or yellow meadow speckles inside the arch), brightest at the threshold lip and fading into dark under the arch roof.
  - In `m02-arch.png` (`(CAVE, 56, 73)`) and `s02-arch.png` (`(CAVE, 30, 39)`): stepping into the arch transitions without the floor texture swapping from grass to cobble.

#### 4. Both built (`cave-floor`) and rough (`cave-rough`) cave styles + readable slope traversal (`area.ts`, `mountain.ts`, `art.ts`, `look.ts`, `LabSection.svelte`)

- **What to build:**
  1. **Add `'cave-rough'` to `GROUNDS` (`src/game/height-lab/area.ts:62`) and a dev-panel switch (`src/game/height-lab/look.ts`, `src/game/height-lab/LabSection.svelte`):**
     - Add `caveStyle: 'mixed' | 'built' | 'rough'` (default `'mixed'`) to `LabLook` and `LabSection.svelte` (**Cave floor: Mixed / Built / Rough**).
     - In `'mixed'` mode, use **built (`cave-floor`)** in the shoulder cave's tunnels and the mountain cave's entrance passages, and **rough (`cave-rough`)** in the mountain cave's deeper ramps, pocket, ledge, and cavern (and shoulder's central chamber)—so walking the lab shows both styles, and the dev-panel switch lets the owner flip all cave floors to Built or Rough at any time.
  2. **Paint both floor styles and clear slope traversal cues in `paintCave()` (`src/game/height-lab/art.ts:348-388`):**
     - **Built (`cave-floor`):** 5×5px flagged stone on `KIND.flat`. On `KIND.slope`, determine the slope's axis and uphill direction from `l.edge[i * 4 + d]` and draw **broad flagged stone steps perpendicular to the climb direction** (`wy % 5` on N–S ramps, `wx % 5` on E–W ramps: a 1 px pale worn step lip `* 1.25` on the uphill edge + a 2 px dark riser shadow `* 0.55` on the downhill side, suppressing the parallel mortar joint so steps stand out clearly from flat cobbles).
     - **Rough (`cave-rough`):** organic fractured stone floor (multi-scale rock noise + subtle crevices, no square 5×5 mortar grid) on `KIND.flat`. On `KIND.slope`, draw **irregular transverse rock ribs / scree ledges** oriented across the climb direction (`(alongPx + jitter(acrossPx)) % 6 === 0`: a 1 px pale rock crest + 2 px downhill shadow, plus small scattered scree pebbles).
     - **Threshold lip & toe shadow at ramp ends (both styles):** Where a `KIND.flat` tile borders a descending `KIND.slope` tile in any direction (`N, E, S, W`), draw a 2 px pale lip on the flat side and a 3 px drop shadow onto the top of the slope; at the bottom (`slope` meeting lower `flat`), draw a soft toe shadow.
     - **Sloping wall strata beside ramps (`art.ts:373-375`):** When painting `faceBelow` (the north rock wall above the floor), offset the strata's vertical coordinate `gy` by `Math.round(lvl[i]! * 8)` so the rock wall's strata visibly angle up/down along a ramp.
     - **Smooth depth tint (`art.ts:343`):** Use the smooth float height `lvl[i]!` in `const deep = Math.max(0, -lvl[i]!) * 0.06` so the stone color cools and deepens smoothly along every descending ramp.
     - **North/east/west drop rims in caves (`art.ts:362`):** Add a 2 px dark rim + highlight where a cave floor drops off to the north, east, or west (matching `shadeSurface` lines `198–208`).
- **How to check on CI (`e2e/height-lab-screens.spec.ts`):**
  - In `m07-mid-tunnel.png` (N–S ramp), `s10-east-ramp-mid.png` (E–W built ramp), and a new shot `m17-rough-ramp` at `(CAVE, 71, 58)` (E–W rough ramp B in `mountain`): verify that N–S and E–W ramps show clear transverse steps (in built tunnels) or natural rock ribs (in rough tunnels), a visible threshold lip where the ramp starts, and angled strata on the north rock wall above E–W ramps.

---

## Detailed Analysis (from initial code trace)

### 1. The lab's HUD line ("floor" + integer vs. "level" + smooth float)

#### Cause in the code

1. **The HUD explicitly relabels `v.z` as `"floor"` and rounds it with `Math.round(v.z)` when in the cave** (`src/game/height-lab/scene.ts:583-586`):
   ```ts
   const where =
     v.layer === CAVE
       ? `In the cave · floor ${Math.round(v.z)} · daylight ${Math.round(v.sky * 100)}% · light here ${Math.round(here * 100)}%`
       : `Surface · level ${v.z.toFixed(2)}`
   ```
2. **Under the hood, the walker's `z` in the cave is already a smooth fractional float on ramps, computed by the exact same function as on the surface:**
   - Every frame, `place()` (`scene.ts:435-436`) sets `m.thing.z = zAt(this.area.stack, w)` (`levels.ts:181-185`), which calls `zIn(stack.layers[w.layer]!, tx, ty, fx, fy)` (`levels.ts:147-163`).
   - Cave ramps are built with the same `ramp()` helper as surface ramps (`area.ts:226-249`, used for the cave at `area.ts:334, 346` and `mountain.ts:175-179`), which sets fractional heights `lo` and `hi` on the tile's north/south or east/west edges (`area.ts:231-248`).
   - As you walk a cave ramp, `zIn()` interpolates those open edge heights by inverse distance (`1 / dd`, `levels.ts:153-162`), so `v.z` (`this.hero.thing.z`) smoothly changes (e.g. `0.00 → -0.20 → -0.50 → -1.00`) just like on a surface ramp.
3. **Where the cave throws away the fractional part of `z`:**
   - **HUD readout** (`scene.ts:585`): `Math.round(v.z)` turns the smooth float into an integer that snaps halfway up a ramp (`-0.49 → 0`, `-0.51 → -1`).
   - **Moving light height** (`scene.ts:538`): `this.lighting.move(id, m.walker.x, m.walker.y - 10, m.walker.layer, Math.round(m.thing.z))` rounds the hero's and Wren's light `z` to an integer, and `Lighting.levels` (`lighting.ts:84, 119, 339`) stores tile levels in an `Int8Array` (`caveLevels(cave)`, `light.ts:240-278`). When `Math.round(m.thing.z)` flips at a half-level, the light's height penalty (`|levels[j] - s.z| * 32 px`, `lighting.ts:339`) jumps by a full level (`32 px` of radius) in one frame.
   - **Cave floor slices** (`light.ts:240-278`, `art.ts:389-417`, `scene.ts:479`): `caveLevels()` quantizes every slope tile to the integer at its low edge (`Math.floor(lo + 0.001)`, `light.ts:255`), which causes the visual stepping/ghosting analyzed under Point 3 below.

---

### 2. The mouth's floor from outside (`owner-mouth-outside.png`, `owner-mouth-in-arch.png`)

#### Cause in the code

1. **The surface arch tiles (`KIND.mouth`) keep the surrounding valley/plateau ground (`G.meadow` grass or `G.moss`) and paint grass inside the arch** (`area.ts:286-288, 324`, `mountain.ts:98, 140`, `art.ts:78-100`):
   - `buildLabArea()` (`area.ts:286`) and `buildMountain()` (`mountain.ts:98`) fill the valley with `G.meadow` (and the plateau around the second mouth with `G.moss`, `area.ts:288`).
   - When mouths are carved (`area.ts:324`, `mountain.ts:140`), `setClosed(surface, tx, ty, KIND.mouth)` sets `surface.kind[i] = KIND.mouth`, **without changing `surface.ground[i]`**.
   - `paintSurface()` (`art.ts:84-99`) feeds `surface.ground` to `paintGround()`, which paints green grass blades and yellow/brown meadow speckles across the 2×2 arch tiles.
2. **`shadeSurface()` tints those grass pixels dark instead of replacing them with cave floor, leaving 6%–31% of the grass visible** (`art.ts:169-175`):
   ```ts
   if (k === KIND.mouth) {
     // The arch's dark, a little light spilling in at its foot.
     const m = area.mouths.find((mm) => tx >= mm.x0 && tx <= mm.x1)!
     const depth = (ty - m.arch[0]) * T + y
     const edge = Math.min(tx * T + x - m.x0 * T, (m.x1 + 1) * T - 1 - (tx * T + x))
     tint(wx, wy, dark, edge < 2 ? 0.7 : 0.94 - (depth / (2 * T)) * 0.25)
   }
   ```
   At the bottom of the arch (`depth = 31`), the dark tint factor is `0.69`, so `31%` of the green grass and yellow flower speckles show right through (`owner-mouth-outside.png`).
3. **The actual cave floor image (`this.caveImages`) is hidden (`alpha = 0`) when outside and only fades in as `v.cave` rises from `0` to `1` inside the arch** (`scene.ts:451, 478-479`):
   - While `w.layer !== CAVE` (`scene.ts:451`), `v.cave` is `0`, so `ci.img.setAlpha(0)` hides the cave's cobbled floor completely.
   - As you step into the arch (`owner-mouth-in-arch.png`), `v.cave = caveView(walked, this.look.crossfade)` (`scene.ts:453`, `light.ts:236-238`) ramps from `0` to `1` over 3 walked tiles, crossfading the cave's cobbled floor (`hl-cave-0`) over the dark-tinted grass.

---

### 3. Ghosting where a cave changes level (`owner-level-ghost-1..3.png`) & cave level transitions

#### How cave floors differ from the surface's fractional level system

1. **Data and walking (`levels.ts`) are identical:**
   Both `SURFACE` (`0`) and `CAVE` (`1`) are `Layer` grids in `Stack` (`levels.ts:52-76`). Both store 4 `Float32Array` edge heights per tile (`edge`), derive 3-row south-facing drops via `deriveFaces()` (`area.ts:176-195`), carve fractional-edge slopes via `ramp()` (`area.ts:226-249`), and compute a smooth fractional walker height `z` via `zAt()` / `zIn()` (`levels.ts:147-163, 181-185`).
2. **Where the cave system diverges from the surface:**
   - **Multi-level continuous ramps without intermediate terraces or faces:** On the surface, every ramp or switchback climbs **1 level** (`0→1`, `1→2`, etc.) through a visible 3-row cliff face (`KIND.face`). In the cave, ramps are authored as long hallways climbing **1, 2, or 4 levels in one stretch** with no drop faces alongside them:
     - `area.ts:334`: `ramp(cave, 30, 33, 31, 37, S, -1, 0, ...)` (1 level over 5 tiles; seen in `owner-level-ghost-3.png`).
     - `area.ts:346`: `ramp(cave, 41, 20, 50, 21, E, -1, 1, ...)` (**2 levels** over 10 tiles; seen in `owner-level-ghost-1.png` and `owner-level-ghost-2.png`).
     - `mountain.ts:178`: `ramp(cave, 26, 32, 27, 43, N, -4, -2, ...)` (**2 levels** over 12 tiles).
     - `mountain.ts:179`: `ramp(cave, 40, 51, 41, 64, S, -4, 0, ...)` (**4 levels** over 14 tiles).
   - **Slicing continuous ramps and their walls into integer-level textures (`light.ts:240-278`, `art.ts:389-417`):**
     `caveLevels(l)` (`light.ts:248-256`) assigns each tile an integer level `Int8Array`:
     ```ts
     if (k === KIND.flat) z = Math.round(l.edge[i * 4]!)
     else if (k === KIND.slope) {
       let lo = Infinity
       for (let d = 0; d < 4; d++) {
         const e = l.edge[i * 4 + d]!
         if (!Number.isNaN(e)) lo = Math.min(lo, e)
       }
       z = Math.floor(lo + 0.001)
     }
     ```
     It then BFS-floods those integers out to adjacent `KIND.rock` wall tiles (`light.ts:263-276`), and `paintCave()` (`art.ts:389-417`) cuts the cave into separate `hl-cave-${z}` textures per integer `z`.
     - On a 1-level ramp from `0` down to `-1` (`area.ts:334`, rows `37→33`), the top slope tile at `ty = 37` has `lo = -0.2`, so `Math.floor(-0.2 + 0.001) = -1`. Thus **the entire ramp and its walls (`ty = 33..37`) are put into `hl-cave--1`**, creating a sharp integer boundary between `ty = 38` (`level 0`) and `ty = 37` (`level -1`) right at the top of the ramp (`owner-level-ghost-3.png`).
     - On the 2-level east-west ramp from `-1` to `1` (`area.ts:346`, `cols 41–50`), `cols 51–53` are in `hl-cave-1` (`level 1`), `cols 46–50` (`lo = 0.0..0.8`) are in `hl-cave-0` (`level 0`), and `cols 41–45` (`lo = -1.0..-0.2`) are in `hl-cave--1` (`level -1`), slicing the corridor vertically at `col 51 | 50` (`owner-level-ghost-1.png`) and `col 46 | 45` (`owner-level-ghost-2.png`).

#### What draws the faded upper (surface) tiles over the next cave tile

There are **two distinct bugs** visible in `owner-level-ghost-1..3.png`:

1. **Bug 3A — Lowering `caveImages` alpha for depth-darkening makes the cave floor translucent over the opaque surface layer (`scene.ts:477-479, 492-493`):**
   ```ts
   for (const li of this.levelImages) li.img.setAlpha(inCave ? 1 : 1 - this.fogOf(v.z, li.level))
   for (const ci of this.caveImages)
     ci.img.setDepth((inCave ? BAND.caveGroundIn : BAND.caveGroundOut) + ci.level).setAlpha(inCave ? v.cave * (1 - this.depthOf(v.z, ci.level)) : 0)
   ```
   - In Round 2, surface `levelImages` and surface `things` faded out when you entered a cave, so behind `this.caveImages` was only `cam.backgroundColor` (`CAVE_DARK = 0x07060b`). Lowering `ci.img.alpha` by `1 - this.depthOf(v.z, ci.level)` therefore blended the cave floor toward `CAVE_DARK`.
   - In Round 3, `this.levelImages` (`depth = -1,000,000 + level`) and all surface `this.things` (surface cliff faces and pine trees, `depth = 0 + y`) were changed to stay at **`alpha = 1` when `inCave` is `true`** (`scene.ts:477, 492`), so the sunny valley outside a mouth stays drawn while `LightView` (`depth = 900,000`, `MULTIPLY`) darkens the hill above you.
   - Because the surface ground, surface cliff faces, and surface pine trees are now drawn at **`alpha = 1` directly underneath `this.caveImages` (`depth = 500,000 + ci.level`)**, setting `ci.img.setAlpha(v.cave * (1 - this.depthOf(v.z, ci.level)))` on any cave level slice where `|ci.level - v.z| > 0.3` (`look.ts:89-91`) makes that cave floor slice **translucent (`alpha = 0.706` for 1 level difference at medium strength)** instead of darker!
   - Right in front of the hero, `LightView` (`BAND.dark = 900,000`, `scene.ts:543-546`) multiplies the composited screen by the **cave's light**—which is **bright** inside the hero's 80 px lantern radius (and near mouth daylight or crystals). So the hero's own lantern shines through the translucent `alpha = 0.706` cave floor slice onto the `alpha = 1` surface grass, surface cliff face, and surface pine trees underneath, blending ("ghosting") them into the cave tiles.
   - When you step across the seam onto that next slice (`owner-level-ghost-1.png` → `owner-level-ghost-2.png`), `depthOf(v.z, ci.level)` for the slice under your feet drops to `0` (`alpha = 1`), so the ghosting vanishes under you and immediately appears on the *next* integer slice ahead (`col 45`, `hl-cave--1`).

2. **Bug 3B — `sunnyFaceRock()` and `openAir()` strip the south cave wall and light the surface cliff face + pine tree below the east tunnel (`light.ts:147-189, 201-223`, `art.ts:339`):**
   - In `area.ts`, the east cave tunnel (`rows 20–21, cols 41–51`) runs right behind the shoulder's 3-row exterior cliff face (`rows 22–24`) before turning south to exit the second mouth (`cols 52–53, rows 22–24`).
   - `openAir()` (`light.ts:147-189`) floods 22 tiles out from the second mouth `(52, 25)` across the plateau (`row 25`) to `col 36`, and lines `182–187` copy `open[i] = 1` up the entire shoulder cliff face (`rows 22–24, cols 36–59`).
   - `sunnyFaceRock()` (`light.ts:219-223`) returns `true` for any `KIND.rock` tile where the surface is `KIND.face` and `air[i] > 0`, without checking whether the tile is actually at a mouth arch or south of an interior cave tunnel.
   - Consequently, `paintCave()` (`art.ts:339`) skips painting the tunnel's south rock wall at `rows 22–24`, and `caveAmbient()` (`light.ts:211`) lights `rows 22–26` in full daylight, exposing the exterior cliff face and plateau pine tree right below the tunnel in `owner-level-ghost-1.png` and `owner-level-ghost-2.png`.

---

## 4. What else will bite in Iteration 2 (real terrain + caves generator)

Checking `src/game/height-lab/` against `docs/planning/wide-world/land-rules.md` (Iteration 2: *"Terrain and below: height, cliffs, ramps, passes (the Tops) and caves, together"*):

1. **Cave mouths only work in south-facing cliff faces (`area.ts:76-81`, `scene.ts:218-221`, `art.ts:271-278`):**
   - In 3/4 view, only south-facing drops (`top[ty] > top[ty + 1]`) generate vertical `KIND.face` tiles (`3 rows = 48 px` per level) that can hold a `lintel` row and a 2-row `arch`. North, east, and west drops are 1–2 px ground rims (`art.ts:198-208`) with zero vertical face rows.
   - **Generator rule:** Every generated cave mouth must either sit in a south-facing cliff face (at least 1 level high and 4 flat columns wide so `lintel-w`/`lintel-e` have flanking rock) or, if a cave exits on the north/east/west flank of a mountain, carve a small south-facing recess/notch into the slope so the arch itself still faces south.
2. **North-, east-, and west-facing drops inside caves have no visual edge and generate no `KIND.face` (`area.ts:176-195`, `art.ts:358-363`):**
   - `deriveFaces()` only creates `KIND.face` where `top[ty] > top[ty + 1]` (a drop to the south). On the surface, `shadeSurface()` (`art.ts:197-211`) draws a dark ink rim and cast shadow wherever `topAt(tx, ty)` drops to the north, east, or west, whereas `paintCave()` (`art.ts:358-363`) only checks `kindAt(tx, ty + 1) === KIND.face`.
   - **Fix (included in Decision 4 above):** Add the north/east/west drop rim + shadow pass into `paintCave()`.
3. **`deriveFaces()` in caves will sever lower corridors if a south-facing drop doesn't leave `3 * Δz + 2` rows of clearance (`area.ts:185-193`):**
   - When a cave floor at `z = -1` lies immediately north of a cave floor at `z = -3`, `deriveFaces()` overwrites `2 * 3 = 6` rows of the lower floor with unwalkable `KIND.face` tiles.
   - **Generator rule:** Different-level cave passages in the same layer must keep either `>= ROCK_REACH (3)` tiles of `KIND.rock` between them, or—where intended as an overlook ledge—the lower room must extend at least `3 * Δz + 2` rows south of the lip.
4. **Whole-map BFS in `caveLevels()` vs. `24×24` chunk streaming (`light.ts:240-278`):**
   - `daylight()` (`<= 10` tiles), `openAir()` (`<= 22` tiles), and crystals (`radius = 6` tiles) are naturally bounded, whereas `caveLevels()` (`light.ts:263-276`) runs an unbounded BFS across the whole map. In chunked generation (`land-rules.md:44-53`), `caveRock()` (`area.ts:442-463`) already loops over the `±3` tile halo (`ROCK_REACH = 3`) of every walkable cave tile; writing each rock tile's `z` directly during `caveRock()` replaces the whole-map BFS and stays strictly within a 3-tile halo.
5. **Multi-level ramps without landings (`area.ts:346`, `mountain.ts:178-179`):**
   - A 14-tile straight ramp climbing 4 levels (`mountain.ts:179`) has no landmarks or rhythm. Even with smooth levels and slope ribs, the generator should cap single ramp segments at 1 level (`3–5` tiles) with at least a 2-tile flat landing (or bend) between levels.
