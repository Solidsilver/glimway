# Height lab round 4b (the way into a cave) — Argon code review

*Branch: `exp/height-lab-4`, 2026-10-20. Reviewer: Argon.*

## Summary against the owner's three complaints

1. **"Walking into a cave is a tiny bit sudden"** — Four switchable transitions (`blend`, `eased`, `stages`, `iris`) and the `1 tile / 3 tiles` crossfade length switch are wired into `LabSection.svelte` (`src/game/height-lab/LabSection.svelte:21-22`) and `wayIn()` (`src/game/height-lab/light.ts:327-343`).
2. **"Some things flash, like the fog"** — Surface ground fog (`src/game/height-lab/scene.ts:551`), thing fog twins (`scene.ts:595`), climbing edge haze (`scene.ts:607`), camera zoom (`scene.ts:615`), background color (`scene.ts:538`), and cave crystals/movers (`scene.ts:575`) now interpolate with `v.cave` / `v.alpha` instead of flipping on `inCave` at the portal step.
3. **"Mid-transition shows more of the cave than you see once inside (darkness over the corners gets lit by the transition; two hard tile-aligned dark rectangles beside the passage)"** — The CPU crossfade (`litPixels`) prevents surface daylight from lighting the unlit cave passage mid-transition, and `caveCover` softens the outer `KIND.rock → KIND.none` edge. **However, several bugs remain in the crossfade composition, the cliff-lip rock boundary, `stages`, `iris`, and mover tinting.**

---

## Findings (worst first)

### 1. [Critical] `blend` and `eased` CPU crossfade double-darkens the buried hillside over the cave's footprint (`(1 - v.alpha) * (1 - v.cave)` vs `1 - v.cave`) and shines underground lights onto the surface (`src/game/height-lab/scene.ts:647-699`, `src/game/height-lab/lighting.ts:598-610`)

- **What happens:**
  1. When `fade` is `true` (`look.way === 'blend' || look.way === 'eased'`), `drawLight()` (`src/game/height-lab/scene.ts:647-663`) first draws `this.lightView` (`MULTIPLY` at `BAND.dark = 900,000`) over the surface ground and props with weights `[{ layer: CAVE, weight: view }, { layer: SURFACE, weight: 1 - view }]` and `cap: undefined`.
  2. Next, `drawCrossfade()` (`src/game/height-lab/scene.ts:672-699`) draws `this.crossfade` (`NORMAL` blend at `BAND.dark + 1 = 900,001`, image `alpha = v.alpha`). Inside `litPixels()` (`src/game/height-lab/lighting.ts:598-610`), `out[o + 3]` is set to `a = src[s + 3]` (`255 * cover`, which is `255` across the tunnel floor and the inner `1.5` tiles of `KIND.rock` on each side) even where the cave is unlit (`CAVE_AMBIENT = 0.05`, so `out[o + 0..2] ≈ [2..5]`).
  3. Because `this.crossfade` uses `NORMAL` (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`) blending over a surface $S$ that `this.lightView` has already multiplied by $1 - v.\text{cave}$ in the unlit part of the hill:
     - **Outside the cave's rock halo** ($\text{cover} = 0$, e.g. `cols <= 52` and `cols >= 61` at the mountain's east mouth): the buried hillside is at $(1 - v.\text{cave}) \cdot S$ (`50%` at $t = 0.5$, `30%` at $t = 0.7$).
     - **Over the unlit cave tunnel and its rock halo** ($\text{cover} = 1$, `cols 54–59`): `this.lightView` dims $S$ by $1 - v.\text{cave}$ and `this.crossfade`'s opaque black pixels occlude that dimmed surface by another $1 - v.\text{alpha}$, leaving $(1 - v.\text{alpha})(1 - v.\text{cave}) \cdot S = (1 - t)^2 \cdot S$ (`25%` at $t = 0.5$, `9%` at $t = 0.7$—more than **3× darker** than the adjacent hillside).
     - As a result, a dark vertical column/silhouette of the unlit cave corridor still cuts up the middle of the green hillside during the crossfade (the exact side effect `706fab2c` intended to remove).
  4. Conversely, near the hero's lantern or crystals, passing `{ layer: CAVE, weight: view }` to `this.lightView` while `this.caveImage` is hidden shines underground cave lights onto the **surface** grass and pine trees underneath `this.crossfade`.

### 2. [High] Hard tile-aligned horizontal step (`1.0 → 0.0`) where `KIND.rock` meets `sunnyFaceRock` along the cliff top lip (`src/game/height-lab/light.ts:366-401`, `src/game/height-lab/art.ts:382-397, 488`, `tests/height-lab.test.ts:524-539`)

- **What happens:**
  1. In both `.agent/owner-walk-in-mid.png` and `.agent/owner-walk-in-inside.png`, the dark rock regions flanking the mountain's east mouth (`cols 53–55` and `cols 58–60`) terminate in a sharp horizontal tile edge at `row 70 | 71` (where the flat level-1 cliff lip `row 70` meets the 3-row cliff face `rows 71–73`). Even once fully inside (`owner-walk-in-inside.png`), `row 70` shows an 8 px lit green grass lip on the left (`cols <= 52`) and right (`cols >= 61`)—from `Lighting.bake(CAVE)` (`src/game/height-lab/lighting.ts:407-419`) bilinearly interpolating `openAir = 1` on `row 71` with `0` on `row 70`—that is abruptly cut out in a rectangular notch across `cols 53–55` and `cols 58–60` by opaque `KIND.rock`.
  2. `caveCover()` (`src/game/height-lab/light.ts:366-401`) only measures distance `dist` from walkable cave floor/water/face (`light.ts:375`) and fades `cover` over `d = 1.5 .. 2.75` tiles toward the outer `KIND.none` edge. It does **not** fade `cover` approaching `sunnyFaceRock` (`light.ts:394`).
  3. At `row 70, cols 54–55` and `cols 58–59`, `d` from the tunnel floor (`cols 56–57`) is `0.25 .. 1.25 < 1.5`, so `area.cover` is **`1.0`** on the bottom texel of `row 70` and drops to **`0.0`** in a single texel at `row 71` (where `sunnyFaceRock` is `true` and `paintCave` `src/game/height-lab/art.ts:397` skips painting).
  4. The unit test in `tests/height-lab.test.ts:524-539` missed this step because:
     - It only checks horizontal neighbors (`x` and `x + 1`), never vertical neighbors (`y` and `y + 1`).
     - Its condition `if (a.cover[y * tw + x]! > 0 && a.cover[y * tw + x + 1]! > 0)` (`tests/height-lab.test.ts:535`) skips every boundary where `cover` drops to `0`.

### 3. [High] `stages` ("Dark first, then the cave") shines cave tunnel light and crystal glow onto the surface hillside while the cave floor is still at `alpha = 0`, and `cap` carves a dark trench over the cave's footprint (`src/game/height-lab/light.ts:330-333`, `src/game/height-lab/scene.ts:650-662`, `src/game/height-lab/lighting.ts:354-380`)

- **What happens:**
  1. In `wayIn()` (`src/game/height-lab/light.ts:330-333`), for `p = walked / (t + 1) <= 0.4` (the first `1.6` walked tiles when `crossfade = 3`), `alpha` is `0` while `light` (`v.cave`) ramps from `0` to `0.82`.
  2. While `v.alpha === 0`, `this.caveImage` is hidden (`src/game/height-lab/scene.ts:556`) and `cap.alpha > 0.001` (`src/game/height-lab/lighting.ts:355`) is inactive. Yet `drawLight()` (`scene.ts:650-653`) blends `CAVE` light (`cave.sky` mouth daylight, the hero's lantern, and crystals) at up to `82%` weight into `this.lightView` over the **surface** grass, surface cliff faces, and pine trees—lighting a tunnel-shaped strip of green surface grass in the middle of a darkening hillside before any cave stone appears.
  3. Once `v.alpha > 0.001` (`p > 0.4`), `cap` (`src/game/height-lab/lighting.ts:354-380`) clamps `acc` to `own / cap.alpha` only where `cover > 0`, darkening the hillside over the cave's footprint much more than the hillside outside `cover`.

### 4. [High] `iris` pops a 56 px dark ring on the portal step (`walked = 0, v.cave = 0`) and clips `caveImage` with a hard un-antialiased `GeometryMask` circle (`src/game/height-lab/scene.ts:507-519, 553-560`, `src/game/height-lab/lighting.ts:309-320`)

- **What happens:**
  1. `iris()` (`src/game/height-lab/scene.ts:508`) returns `{ x, y, r: r0 + v.cave * ..., soft: 32 }` whenever `v.layer === CAVE && v.cave < 0.999`, **including when `v.cave === 0`** (`walked = 0` at the portal).
  2. In `Lighting.fill()` (`src/game/height-lab/lighting.ts:309-320`), `if (iris)` overwrites `wBase` and `wSrc` with `wi` regardless of `v.weight = 0`. Stepping from the tile outside the mouth onto the portal tile (`walked = 0, v.cave = 0, caveAlpha = 0`) therefore pops a `r0 + soft = 24 + 32 = 56 px` radius dark circle onto the cliff face and hilltop before the hero has walked into the cave.
  3. As the iris opens, `this.caveImage` is drawn at `caveAlpha = 1` with `this.irisMask` (`src/game/height-lab/scene.ts:557-559`), a hard stencil circle at radius `iris.r`, while the light ring softens from `iris.r` to `iris.r + 32 px`, leaving a hard circular stencil cut across the cave floor and rock walls at `d = iris.r`.

### 5. [Medium] Unclamped `amb + mov` per layer in `Lighting.fill` creates a spotlight halo around surface lights as the surface dims (`src/game/height-lab/lighting.ts:346-352`)

- **What happens:**
  1. In `Lighting.fill()` (`src/game/height-lab/lighting.ts:346-352`), each view accumulates `b * amb[d]! + m * mov[d]!` without clamping `amb[d] + mov[d]` to `[0, 1]` on its own layer first.
  2. On the `SURFACE` layer, `amb = 1.0` (full daylight) and Wren's `FRIEND_LIGHT` adds up to `0.9` (`amb + mov = 1.9`). When fully on the surface (`b = m = 1`), `clamp01(1.9) = 1.0`, so Wren's lantern is invisible in daylight.
  3. During the way-in crossfade (`0 < b < 1`, e.g. `b = 0.5` in `w-eased-s-second-06.png` and `w-stages-s-second-06..08.png`), `b * (amb + mov) = 0.5 * 1.9 = 0.95` while the surrounding plateau dims to `0.5 * 1.0 = 0.50`, creating a bright warm spotlight halo around Wren on the sunny plateau as the hillside dims. Clamping `amb + mov` per layer (`b * clamp01(amb + mov) + (m - b) * mov`) eliminates this halo while preserving cross-layer moving lights on portal tiles (`m = 1, b = 0`).

### 6. [Medium] `byTint` during `blend` and `eased` crossfades tints cave movers with `1 - v.cave` surface daylight, omits `depthDark`, and lifts Wren's label above `LightView` (`src/game/height-lab/scene.ts:578-591`)

- **What happens:**
  1. During `fade`, `byTint = fade && onCave && !t.glows` (`src/game/height-lab/scene.ts:578`) moves all `t.parts` of every cave mover to `BAND.dark + 2` (`900,002`, above `this.lightView` and `this.crossfade`) and tints `t.parts[0].o` by `v.cave * c[ch]! + 1 - v.cave` (`scene.ts:584`).
  2. Adding `1 - v.cave` (surface daylight) to `onCave` movers causes cave creatures (`mushroom`) and Wren deep in dark tunnels to brighten toward full daylight whenever the hero is near a mouth (`v.cave` small), and causes the hero at the arch (where `portal` otherwise keeps light at `100% CAVE`) to flash toward `100%` daylight on the first step in when `look.cave === 'dim'`.
  3. `this.lighting.at(CAVE, t.x, t.y - 8)` (`scene.ts:583`) does not include `depthDark`, so movers on deeper cave levels lose their level-difference darkening during the crossfade.
  4. Moving all `t.parts` to `BAND.dark + 2` (`scene.ts:580`) also puts `t.parts[1]` (the untinted drop shadow) and `t.parts[2]` (Wren's `"Wren"` text label) above the darkness pass.

### 7. [Medium] Redundant WebGL texture upload (`hl-light-cave`) and full-viewport CPU work in `drawCrossfade` / `litPixels` (`src/game/height-lab/scene.ts:362, 672-699`, `src/game/height-lab/lighting.ts:560-612`)

- **What happens:**
  1. `drawCrossfade()` (`src/game/height-lab/scene.ts:673-674`) calls `this.caveLightView.draw(...)` and immediately `this.caveLightView.hide()`. `LightView.draw()` (`scene.ts:799-801`) executes `putImageData`, `tex.refresh()` (`gl.texImage2D`), and `tex.setFilter(LINEAR)` on `'hl-light-cave'` every crossfade frame even though `'hl-light-cave'` is never rendered—only its CPU `Uint8ClampedArray` is read via `this.caveLightView.texels()`. Calling `this.lighting.fill()` directly into a reusable `Uint8ClampedArray` eliminates the second `LightView`, canvas, `putImageData`, and WebGL upload.
  2. `litPixels()` (`src/game/height-lab/lighting.ts:578-586`) allocates `new Int32Array(w)` and `new Float32Array(w)` every frame and loops over the high-water `tex.width × tex.height` (`scene.ts:695`), even when the non-empty cave bounds within the view are much narrower (`cols 53–60` = 128 px wide out of ~430 px).

### 8. [Low] `onSceneEnd` leaks `irisShape` / `irisMask`, removes `'hl-crossfade'` before destroying `this.crossfade`, and retains `cavePixels` (`src/game/height-lab/scene.ts:192-202, 277, 367-368, 685`)

- **What happens:**
  1. `this.irisShape = this.make.graphics({}, false)` and `this.irisMask = this.irisShape.createGeometryMask()` (`src/game/height-lab/scene.ts:367-368`) are created off the display list (`add: false`) and are never destroyed in `onSceneEnd()` (`scene.ts:192-202`), leaking on every `scene.restart()` and when leaving the lab.
  2. `onSceneEnd()` (`scene.ts:200`) removes texture `'hl-crossfade'` without first destroying `this.crossfade` (`Phaser.GameObjects.Image`), and leaves `this.cavePixels` (the full-cave `Uint8ClampedArray`), `this.crossfadeTex`, and `this.crossfadeData` referenced on the scene instance.

---

## Verification of Round 4 mouth floor from outside

- Checked `paintCave()` (`src/game/height-lab/art.ts:488, 555`) and `Lighting.fill()` (`src/game/height-lab/lighting.ts:321-337`):
  - `mouthImages` (`hl-cave-mouth-0`, `hl-cave-mouth-1`) are cut from `area.arches[i] === 1 && drawn(i)` where `l.kind[i]` is `KIND.flat`, so their pixel alpha remains `255` (`art.ts:488`) and they stay at `alpha = 1` at `BAND.caveGroundOut - 1` (`scene.ts:561`).
  - In `Lighting.fill()`, the `portal` mask (`lighting.ts:321-337`) runs after `iris` and sets `wBase = 1` for `CAVE` (`0` for `SURFACE`) and `wSrc = 1` for moving sources on both layers, while `cap` is inactive outside (`v.layer === SURFACE`). The Round 4 mouth floor seen from outside remains intact.
