# Fingersnap runtime asset spec

This is the one drop-in art contract for future art and for what already
shipped. Ownership split: the art/content agent (snap_mimo) maintains the
sprite slots, delivered-pack notes and the wanted list here alongside
`ASSETS.md`; the game-runtime agent (Agent A) maintains the wiring notes and
owns `BootScene`/`WorldScene` call sites. Character/terrain placeholders
generated at boot in `src/game/textures.ts` remain the fallback layer; the
**expansion pack** and the **runtime art pass** (below) are the primary art
sources.

## Packed atlases (what ships)

Players never download the full-resolution sheets. `npm run atlases`
(`scripts/build-atlases.ts`) reads every pack's sheets and manifests from
`assets/generated/**` (never modified) and writes
`public/assets/fingersnap/packed/`; `src/game/atlas-plan.ts` is the plan the
build and the runtime share, `src/game/packed.ts` loads it in
`BootScene.preload`. What `public/assets/fingersnap/` holds now: the five
small JSON manifests (`commons-pass/manifest.json`,
`runtime-pass/manifest.json`, `items-pass/manifest.json`, `expansion/manifest.json`,
`expansion/animations.json`) and `packed/` (~9 MB, was 60 MB):

- **Canvas-blitted packs — dense, box-filtered.** The Commons pass (173
  native frames + 20 off-size samples), the runtime pass (27 frames), the
  items pass (170 frames), and the expansion terrain tileset (4×4 cells, one
  16-px world tile each) are baked in headless Chromium at `ART_DENSITY`
  (4) texels per world px: each frame's measured source rect is
  box-filtered (area-averaged, alpha-weighted) into its destination rect on
  a native canvas 4× its world size, packed (`commons.png`, `runtime.png`,
  `items.png`, `terrain.png`), and copied back out 1:1 at boot. The build
  reads every frame back from the encoded PNG and fails on any difference;
  `e2e/atlases.spec.ts` checks the game holds exactly the packed texels and
  draws each texture at its native world size. Off-size samples (the
  refitted 2×1 decorations, the Wilds decor boxes, the mirrored fence
  corner) come from `commonsBlitPlan`; `blitFrame` fetches them by key.
  Terrain cells delivered at 64 px (the playtest-1 seamless tiles) pass
  through texel for texel.
- **Dense textures at runtime** (`src/game/density.ts`). A dense texture's
  frame reports its world size (so `image.width`, origins, physics bodies,
  hit areas, depth and camera framing are what they were) while its UVs span
  the whole canvas; the game draws it nearest-neighbour (`pixelArt`). Code
  that reads pixels gets them through `artSource` / `drawArt` /
  `artCanvas` (a composite canvas whose context is scaled to world px).
  Sampling ties are biased by `TIE_BIAS` (1/64 texel) so the ground and
  sprites don't shimmer as the camera moves. Phones (screen short side
  under 600 CSS px, always framed at 2 canvas px per world px) keep
  `PHONE_ART_DENSITY` (2), box-filtered from the packs at boot; the Canvas
  renderer gets density 1. The packed atlases are staging: their GPU
  copies are released once the frame textures exist.
- **Ground.** The village, Commons, cottage and Woodland ground is a Phaser
  tilemap (`src/game/area/terrain.ts`) over a boot-built tileset of the 16
  terrain cells and the Commons' path-edge overlays (extruded 1 texel), its
  layers scaled to 16-px tiles: it costs no texture memory past the tileset
  (a baked 4× ground would be ~60 MB for the Commons). The Wilds keep their
  per-pixel floor.
- **GPU-scaled atlases — same look, re-sampled.** The hero walk, enemies,
  foreground occluders and props are drawn with `setScale(display / frame
  size)` and the camera zooms 1.5–5× (1.3× more in the lantern beat), so the
  game samples them on screen at up to 5 (6.5) screen px per world px. Each
  frame is baked at that largest on-screen size (never above its source;
  sizes in `SCALED_ATLASES`) as a Phaser atlas under its old texture key and
  frame names, trim and pivot kept, so call sites didn't change. They aren't
  bit-identical (the screen samples a smaller texture), but read the same; a
  frame drawn larger than its listed size would be upsampled.
- **Illustrations.** `fingersnap-village` (title background, full screen:
  every source pixel kept, 1536×1024) and `fingersnap-shrine` (journal header
  only: 1200×800) ship as WebP (q 0.9). The game no longer loads them as
  Phaser textures (nothing drew them).
- **Committed output.** Baking needs a browser, so deploy builds don't run
  it; `tests/atlases.test.ts` fails when any input's sha256, the plan, or the
  generator version changed without a re-run, and when `public/assets/fingersnap/`
  holds anything but the manifests and `packed/`.

## Expansion pack (delivered October 2, 2026)

`assets/generated/expansion/` → `public/assets/fingersnap/expansion/` keeps
the manifest and animations; the art ships packed (see "Packed atlases"). Typed helpers live in
`src/game/expansion.ts` (content agent's module, built from
`assets/generated/expansion/integration.js`); the runtime agent owns the
wiring in `BootScene`/`WorldScene`.

- **Terrain** (`fingersnap-terrain`): 16 named tiles with unequal source
  cells — the atlas build normalizes them into a uniform 4×4 runtime
  tileset of 64-texel cells (16 world px at 4×); `buildGround` lays them out
  as 16px world tiles via an explicit `TERRAIN_TO_EXPANSION` mapping (grass→grass, flowers→
  flower-grass, paths→packed-dirt, water→pond-water, bridge→wood-planks,
  stone→cobblestone/shrine-stone, roofs/walls→wood/dark-wood-planks…). Source
  PNG is never treated as an even grid.
- **Hero** (`fingersnap-demo-walk`): 4-direction walk (`demo-walk-up/down/
  left/right`, 4 frames each, from `animations.json`). Displayed ~20px tall in
  the 16px-tile world (suggested 40px at 32px tiles, halved); body stays
  10×6 at the feet via explicit `setSize`/`setOffset`.
- **Enemies** (`fingersnap-enemies`): slime (wisp-a/b) and mushroom (wisp-c)
  at ~14px with idle anims; explicit 10×6 foot bodies. The guardian keeps its
  procedural placeholder in this pack — no guardian asset here (delivered
  later by the runtime art pass below).
- **Foreground** (`fingersnap-foreground`): oak/pine canopies over existing
  tree bases, leafy/stone arches at area gates, fern clusters, cottage roof —
  visual occluders only, **no new collision**; placed via
  `placeFingersnapOccluder` with foot-anchored origins at small-world widths
  (26–118px).

## Runtime art pass (delivered October 3, 2026)

`assets/generated/runtime-pass/` → `public/assets/fingersnap/runtime-pass/`
keeps the manifest; the frames ship packed (see "Packed atlases"). Typed helpers live in
`src/game/runtime-art.ts` (content agent's module, ported from
`assets/generated/runtime-pass/integration.js`); the runtime agent owns the
wiring in `BootScene`/`WorldScene`. Manifest contract is validated by
`tests/runtime-art.test.ts`. Original PNGs stay byte-unchanged.

- **Source sheets** (`fingersnap-npcs` 1024×1535, `fingersnap-guardian`
  1536×1024, `fingersnap-class-effects` 1254×1254): high-resolution
  transparent sheets, **not** evenly spaced spritesheets. `manifest.json`
  carries individually measured `sourceRect`/`destinationRect` per frame
  (**27 frames**). Never load the PNGs with `frameWidth` or any grid
  assumption; never pre-scale or flatten them (transparent pixels may hide
  original backdrop RGB — that is fine and never rendered).
- **Native textures** — `createRuntimeArt` blits each measured rect into an
  exact native-size canvas (`imageSmoothingEnabled = false`, nearest
  neighbor), so origins and foot baselines stay fixed between frames:
  - NPCs (`mara-idle-0/1`, `pip-idle-0/1`, `orrin-idle-0/1`): **16×16**,
    origin **(0.5, 1)**, destinationRect sitting on the canvas foot
    baseline. All three share one common scale so Pip's smaller stature
    survives; do not stretch each character to fill its slot.
  - Guardian (`guardian-idle`, `guardian-windup`, `guardian-lunge`,
    `guardian-hurt`, `guardian-defeat`): **24×24**, origin **(0.5, 1)**,
    same foot-baseline rule and a common scale (the collapsed defeat pose
    stays smaller instead of being enlarged). These are **discrete combat
    states**, not one automatically looping attack/walk animation.
  - Class effects, origin **(0.5, 0.5)** center anchor for
    rotation/expansion: `cleave-0..3` **18×18**, `magic-bolt-0..3` **8×8**,
    `dash-trail-0..3` **18×18** and `healing-pulse-0..3` **32×32** (the last
    two were proposed slots the spec had not sized; they are adopted at
    those sizes now).
- **Animations** (created by `createRuntimeArt`): `mara-breathing`,
  `pip-breathing`, `orrin-breathing` — 2 frames, 1.5 fps, looping; do not
  stack the code bob on top of breathing unless intentionally desired.
  `effect-cleave`, `effect-dash-trail`, `effect-healing-pulse` — one-shot at
  12 fps; `effect-magic-bolt` loops at 12 fps. Effects are cosmetic only:
  they define **no** hit areas and no healing radius. Rotate centered
  effects by facing; place the cleave canvas center at the attacker and the
  trail center at its emission point.
- **Native helper contract** — `src/game/runtime-art.ts`, exact exports,
  call in this order:
  1. `preloadRuntimeArt(scene, base?)` in `BootScene.preload` (default base
     `/assets/fingersnap/runtime-pass/`; loads the three sheets plus
     `manifest.json` under `fingersnap-runtime-art`).
  2. `createRuntimeArt(scene)` after preload completes and before
     `WorldScene` starts — builds the 27 canvas textures and 7 animations.
     Idempotent (existing keys are skipped); returns the manifest.
  3. `installRuntimeAliases(scene, { replaceExisting? })` optionally and
     deliberately, only after procedural fallback textures exist. Default
     `replaceExisting: false` leaves existing keys alone; `true` replaces
     supported keys with copies of the new frames. Run replacement only in
     boot setup, before dependent sprites are created.
- **Compatibility aliases** (only applied with `replaceExisting: true`):
  `mara`→`mara-idle-0`, `pip`→`pip-idle-0`, `orrin`→`orrin-idle-0`,
  `guardian0`→`guardian-idle`, `guardian1`→`guardian-lunge`,
  `slash`→`cleave-2`, `bolt`→`magic-bolt-0`. Unchanged scenes keep working
  against these static keys; breathing wiring and new guardian states are
  explicit runtime work.
- **Collision stays authored** — preserve the explicitly authored NPC 10×8
  and guardian 20×10 foot collision bodies; never infer collision from
  source alpha or visual bounds. Code tinting, timers, death handling,
  physics bodies, and quest events remain runtime responsibilities. Facing
  is a `flipX` away (sheets are authored facing right/down as noted in the
  pack README).

## Commons pass (delivered October 5, 2026)

`assets/generated/commons-pass/` (archive of record: sheets, atlases,
prompts, drafts, preview, validation). `public/assets/fingersnap/commons-pass/`
holds only `manifest.json`; the frames ship packed (see "Packed atlases"). The pack answers
`docs/art-requests.md` and replaces the code-drawn placeholders, which stay
the fallback layer. Typed helpers: `src/game/commons-pass.ts` (loader, port
of the pack's `integration.js`) and `src/game/commons-pass-install.ts` (the
boot-time swap onto placeholder keys). Contract: `tests/commons-pass.test.ts`.

- **Native textures** — `createCommonsPass(scene)` builds one canvas per
  manifest frame (173) at its native size under `commons-art:<frame>`,
  measured `sourceRect` → `destinationRect`, nearest-neighbour, origins as
  the manifest gives them (standing art `(0.5, 1)`, icons `(0.5, 0.5)`, the
  floor tile `(0, 0)`), and the 11 looping animations as
  `commons-art:<animation>` (`silas/elara/finn/hazel/ada-breathing`,
  `hearth-fire-animation`, `camp-flame-animation`, `campsite-animation`,
  `paper-folded/scroll/slate-animation`). A frame whose sheet failed to load
  is skipped, so is an animation missing a frame. Ask for them with
  `commonsArt(scene, frame)` / `commonsAnim(scene, animation)` (null when
  absent) and fall back to the placeholder.
- **Boot order** (`BootScene.create`): placeholders (`generateTextures`,
  `generateCommonsArt`, `generateDecorationArt`) → `createCommonsPass` →
  `installCommonsPass(scene, HOMESTEAD_DATA.items)` → the `silas-breathing`
  fallback animation → the runtime pass. The swap copies delivered frames
  onto the placeholder keys the scenes use (`silas`, `cottage*`, `camp-*`,
  `room-fire-*`, `workshop-*`, `mailbox-flag`, `gatepost`, `gate-leaf`,
  `hame`, `commons-well`, `notice-board`, yard props, `stall-*`,
  `well-canopy`, `mended-bridge`, `candle-hull`, `library-sign`,
  `paper-*`) and builds composites: `bunting-64/96` (the swag repeated),
  `room-walls` (plank floor with the 2×2 flip pattern under the grid and
  doorway, code-drawn side/near walls, delivered back wall on top),
  `deco-<id>` / `deco-<id>-q` (delivered furniture; the 2×1 bookshelf, hearth
  and tool rack refitted to their footprint width, rising above it like the
  placeholders), `plot-sign(-reserved)` (board widened to the placeholder's
  40 px so the 5-px name fits), and `mailbox` (the flag taken down).
  Hedge/fence runs (`ensureSceneryTexture`) compose the modular pieces:
  horizontal runs one piece a tile with joins painted over, a back hedge's
  outer end turning down the plot side (`hedge-h-<n>-turnw|turne`); vertical
  hedges repeat the upright piece's middle; vertical fences use the corner
  piece's post (the delivered upright fence piece is a stacked spool).
- **Scene wiring** (collision bodies, interaction spots, depths unchanged
  unless noted): Silas plays `commons-art:silas-breathing` and his dialogue
  bust is `portrait-silas` (64 px, shown 1:1); the settled warden rests in
  `guardian-settled` (heart-lamp glow moved onto its chest), not the defeat
  frame; tier 2 is the complete `cottage-workshop` (never stacked on
  tier 1); the room's hearth moved right to where the delivered wall has it
  (`ROOM_HEARTH.x` 173, bench under the shelf at x 115) with the 4-frame
  hearth fire; the camp flame and paper pickups animate (static with reduced
  motion); the Hearthwick Library is the delivered building (scenery with
  `groundUnder`, door moved to the middle tile, sign standing out front);
  Amberwake/Closure Night windows use `window-lamp-glow`; The Breaking
  floats the three candle hulls; Commons path edges are painted into the
  ground (`pathEdgeOverlays`, dirt and cobble, grass side). Wilds: resource
  nodes show available/depleted art (no fade), camps are tent + fire ring +
  pack with a flame until cleared, player and Echo lanterns are the
  fallen-hero lantern lit/unlit, Echo props are `echo-<member>-faint` until
  settled then `-solid` (never flipped: Hollis's fox keeps its long ear on
  the viewer's right), the Amberwash cairn is `cairn-white-stones`, and the
  decor atlas takes the delivered log, mossy boulder, cairn, turncaps
  (never mirrored) and iron-oak stump fitted to the generator's frame sizes
  (the White Quiet keeps its frosted woods but for drift-stone and white
  cairns). Dead birch and reed pool are loaded but the code-drawn snag and
  reeds fit the generator better.
- **UI icons** — `WorldScene` emits every `icon-*` frame as a data URL
  (`EV.artIcons`); `src/ui/ArtIcon.svelte` shows it at a whole multiple of
  16 px, falling back to the code-drawn `Icon`: materials, trinkets and
  crafted goods in the Character panel, workshop, Silas's yard balance,
  mail and loot toasts (`ToastPayload.art`), emotes in the picker.
- **Residents** — Elara (the Commons, by the Wilds arch, with the
  `wilds-pack` and `wilds-fire-ring` as her camp), Finn (at the door of
  the Tolley mill: code-drawn in `src/game/mill-art.ts` until the art pack
  has one, see `docs/art-requests.md`), Hazel (the square) and Ada (under her window) are NPCs in
  `WorldData.npcs`, drawn from `commons-art:<name>-idle-0/1` with their
  breathing animations (`src/game/entities/npcs.ts`; a tinted quest-NPC
  placeholder if the pack didn't load). Their busts are emitted under their
  first-name speaker names (`COMMONS_RESIDENT_PORTRAITS`). Words:
  `src/content/residents.ts`.
- **Loaded but not placed** — `commons-gateway` (a front-facing arch; the
  Commons gate is crossed east–west, so it keeps the side-on gateposts and
  gate leaf), the campsite composite and its animation (the plot keeps the
  detached windbreak, cot and ring at their authored spots and bodies),
  `workshop-addon`, `dead-birch-turncaps`, `reed-pool`, `fence-straight-v`, `fence-gateway`, `hedge-corner-ne/nw`,
  path `end-*` pieces.

## Items pass (delivered October 5, 2026)

`assets/generated/items-pass/` (archive of record: 12 sheets, per-sheet
atlases, `manifest.json`, `jobs.json`, `request-index.json`, `drafts/`,
`preview.html`, `validation.json`, `frame-inspection.json`, `build_manifest.py`,
`integration.js`, README and COVERAGE). `public/assets/fingersnap/items-pass/`
ships only `manifest.json`; the frames ship baked into the packed atlas
(`items.png`). Typed helpers: `src/game/items-pass.ts` (loader, `items-art:`
native textures, `itemIcon` helper with discrete states and fallbacks,
`itemIconUrls`). Contract: `tests/items-pass.test.ts`.

- **Native textures** — `createItemsPass(scene)` builds one canvas per
  manifest frame (170) at its native size under `items-art:<frame>`,
  measured `sourceRect` → `destinationRect`, nearest-neighbour. 110
  inventory icons (`item-*`, 16×16) and 60 world sprites (`world-*`,
  various sizes).
- **Aliases & states** — 9 `commons:` aliases resolve directly to existing
  `commons-art:` textures (e.g. `timber` → `commons:icon-timber`) without
  duplicating them. Tool wear conditions and item variants are discrete states
  (`manifest.stateGroups`, 31 groups), never auto-looping animations.
- **Tolley Mill art** — `installItemsPass(scene)` replaces code-drawn
  placeholders with delivered art for `mill-house` (64×64), `mill-hopper`
  (16×20), `mill-wheel-0..3` (32×32), `mill-wheel-mended-0..3` (32×32), and
  `mill-froth-0..1` (14×6). Authored looping animations: `mill-wheel`,
  `mill-wheel-mended`, and `mill-froth`. The waterwheel sits against the east
  wall of the mill with its lower edge in the mill-race water.
- **Icon helpers** — `itemIcon(itemId, state?, fallback?)` resolves item IDs
  to texture keys, respecting `commons:` aliases and discrete states, with
  a 16×16 placeholder fallback (`items-art:fallback`) when no art exists.
  `itemIconUrls(scene)` exports data URLs for Svelte UI.

## Delivered generated art (October 2, 2026)

`assets/generated/` holds original generated art with provenance in
`assets/generated/manifest.json` and `assets/generated/prompts.json`; the
props ship as a packed atlas and the illustrations as WebP (see "Packed
atlases"):

| Key | Content | Runtime use |
|---|---|---|
| `fingersnap-props` (atlas) | 12 transparent props | In-world props: `lantern-post` (village lantern), `lantern-shrine` (ruin shrine), `trail-sign` + `stone-milestone` + `mushroom-cluster` + `grappling-rope` (woodland), `patched-bench` + `bread-basket` + `flower-planter` + `tool-crate` (village), `treasure-chest` (ruin) |
| `fingersnap-village` | Flattened village scene | UI illustration only (intro screen, journal header) — **never** used as a walkable map or terrain source |
| `fingersnap-shrine` | Flattened shrine scene | UI illustration only (journal header in the ruin) |

Sizing rule: the manifest's suggested display heights (64/56/40px) assume a
larger avatar than the demo's 16px hero. Runtime uses a deliberate
small-world scale instead: lantern-post 32, lantern-shrine 40, trail-sign 24,
stone-milestone 18, patched-bench 18, tool-crate/flower-planter/backpack 16,
grappling-rope 14, treasure-chest 20, bread-basket/mushroom-cluster 12
(display height in px; aspect preserved; origin (0.5, 1)). Collision boxes are
authored explicitly per prop in `src/game/worlds.ts` — never inferred from the
images. The lanterns have no lit frame; lighting is an additive `glow`
overlay anchored near the lamp.

## How rendering works

- Phaser `pixelArt: true`, `roundPixels: true` — all textures render with
  nearest-neighbor. Provide art at native pixel sizes; never pre-scale.
- Tiles are 16×16 on screen. Ground tiles are authored at 8×8 and painted at
  2× into one ground canvas per area at scene build time.
- Depth is y-sorted: entity depth = feet y. Anchor every standing sprite at
  **bottom-center** of its visual body (see per-slot origin below).
- Replacement path: load real textures in `BootScene.preload` under the same
  texture keys (or let `installRuntimeAliases` copy the runtime-pass frames
  onto those keys), or replace the corresponding `addArtTexture` call in
  `textures.ts`. No scene code changes needed — everything references keys.

## Sprite slots

### Terrain sheet `terrain` (generated; replaceable per-tile)

One canvas sheet, 7 columns of 16px tiles. Tile ids in `TERRAIN`
(`src/game/textures.ts`), in order: grass_a, grass_b, grass_c, flowers, path_a,
path_b, dirt, sand, water_a, water_b, bridge, stone_a, stone_b, stone_crack,
wall_stone, wall_moss, roof, roof_edge, wall_house, door, window, fence.
Rules: seamless tiling, 8×8 art upscaled to 16×16, palette warm/cozy, bridge
and fence may use transparency (ground shows through).

### Characters (16×16, origin (0.5, 1), body 10×8 at feet)

| Key | Who | Frames needed |
|---|---|---|
| `fingersnap-demo-walk` | Player, 4-direction walk (**delivered** — replaced `hero0`/`hero1`; the procedural `hero0` stays as a texture-missing fallback) | 4 frames × 4 directions |
| `mara` | NPC quest giver | **delivered** (runtime pass): `mara-idle-0/1` front-facing breathing pair + `mara-breathing`; side-facing still wanted |
| `orrin` | NPC elder | **delivered** (runtime pass): `orrin-idle-0/1` + `orrin-breathing`; side-facing still wanted |
| `pip` | NPC child | **delivered** (runtime pass): `pip-idle-0/1` + `pip-breathing`; side-facing still wanted |
| `wisp` | Woodland enemy | superseded by `fingersnap-enemies` (slime/mushroom idle anims) |

Imported characters do NOT use these slots: they compose layered official
Habitica sprites at runtime (`src/game/avatar-render.ts`, static with a code
bob). Optional runtime niceties, not required: small additive class-effect FX
beyond the delivered effect sequences — remaining extras (hit `spark`,
under-entity `shadow`, lantern `glow`) stay code-driven.

### Guardian shade (24×24, origin (0.5, 1), body 20×10 at feet)

**Delivered** (runtime pass): five discrete states `guardian-idle`,
`guardian-windup`, `guardian-lunge`, `guardian-hurt`, `guardian-defeat`.
Select them from the combat state machine; do not loop all five as a walk.
Static aliases `guardian0` (idle) and `guardian1` (lunge) cover unchanged
references. flipX by facing. A telegraph flash is code-tinted white over
`guardian-windup`; a death dissolve is code-driven over `guardian-defeat`.
Keep the authored 20×10 foot body.

### Props

| Key | Size px | Origin | Notes |
|---|---|---|---|
| `tree` | 16×18 drawn in 16×24 box | (0.5, 1) | trunk base = collision, ~12×6 |
| `bush` | 16×12 (in 16×16 box) | (0.5, 1) | |
| `rock` | 14×10 (in 16×16 box) | (0.5, 1) | |
| `well` | 14×15 | (0.5, 1) | village centerpiece |
| `mural` | 16×11 | (0.5, 1) | quest clue, mounted near wall |
| `lantern_off` | 16×25 (in 16×28 box) | (0.5, 1) | shrine + village lantern, dark glass |
| `lantern_on` | same slot as `lantern_off` | (0.5, 1) | lit variant, same silhouette |

### Effects (partly art, partly code-generated)

Delivered (runtime pass, center-anchored, rotate by facing): `cleave-*`
18×18 under `slash` / `effect-cleave` (attack arc), `magic-bolt-*` 8×8 under
`bolt` / `effect-magic-bolt` (projectile, loops), `dash-trail-*` 18×18 under
`effect-dash-trail` (one-shot trail), `healing-pulse-*` 32×32 under
`effect-healing-pulse` (one-shot pulse). Still code-generated, no art
needed: `spark` 4×4 (hit particles), `shadow` 14×7 (soft ellipse under
entities), `glow` 64×64 (additive radial halo over lit lanterns).

## Wanted for the real art pass

Delivered so far: 4-direction hero walk (`fingersnap-demo-walk`); NPC
front-facing breathing pairs, the five guardian states, and the four class
effect sequences (runtime pass, October 3). Still wanted:

1. NPCs: left/right-facing idle or walk frames for Mara, Pip, and Orrin
   (the runtime pass covers front-facing breathing only).
2. Enemy move sets: walk/attack frames for the slime/mushroom/beetle trio
   beyond idle/squash/windup/hurt.
3. Terrain: keep 8×8-authored tiles; add path edge variants later if
   desired.
4. Palette: warm cozy; outline dark warm brown `#3a2a28` on characters.
5. Audio (ambience, UI, interaction) — tracked as a pending deliverable in
   `ASSETS.md`, not an art slot.
