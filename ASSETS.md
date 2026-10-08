# Glimway asset register

Provenance and license record for every asset used in the project. The
runtime-facing loading notes live in `docs/runtime-asset-spec.md` (art slots
and wanted list kept by the art/content agent there; wiring notes by the
runtime agent); `assets/ASSETS_GUIDE.md` is the delivered handoff from the
asset agent. This file is the register of record.

## Art direction

Stay close to **Habitica pixel art**: crisp deliberate pixels, readable
silhouettes, warm lived-in cozy-fantasy palette (emerald foliage, teal
shadows, amber lantern light, russet wood/roofs, golden weathered stone),
consistent top-down three-quarter RPG view (not isometric). Style alignment
is intentional and recorded here; **no Habitica or BrowserQuest files are
copied or extracted**. Depicting similar subject matter in a similar style
does not import Habitica's asset license. When licensed Habitica assets are
introduced later, they enter this register individually with their own
license lines (see "Third-party assets" below).

## Licences

Decided 2026-10-07 (reasons in `docs/licensing-and-funding.md`). Each
register below carries its own licence line.

- **Our art: CC0 1.0** (public domain dedication). Every register of our own
  art (A, B's output, D, E, F, G, H, J) is AI-generated: made with OpenAI's
  image generation through Codex, then measured, cut and packed by scripts,
  not repainted. With no human author there is likely no copyright to
  license, so it is dedicated to the public domain and needs no credit. The
  notices are `assets/generated/LICENSE` (the source packs) and
  `public/assets/fingersnap/LICENSE` (the packed copies the game loads).
- **Future human-made art** gets its own folder with its own `LICENSE`
  (for example CC BY-SA 4.0), chosen per work, and its own register here
  with its licence and attribution line. Don't mix it into the CC0 folders.
- **Code: AGPL-3.0-or-later** (`LICENSE` at the root), including the code
  that draws the Register B placeholders.
- **Third-party CC0 sound**: Kenney's audio packs (Register I), in
  `public/assets/audio/kenney/` with its own `LICENSE`. No credit required;
  credited anyway.
- **Habitica's material keeps Habitica's terms**, kept apart and labelled:
  the sprites in `public/assets/habitica/` are CC BY-NC-SA 3.0, © HabitRPG,
  Inc. (notice: `public/assets/habitica/LICENSE`); the gear numbers in
  `content/habitica-gear.json` are GPL-3.0-derived (notice:
  `content/habitica-gear.NOTICE.md`). See "Third-party assets" below.

The provenance records here and in `assets/generated/` stay: they show what
was generated and what, if anything, was made by people.

## Register A — original generated art pack (delivered)

Delivered 2026-10-02 by the external asset agent to `assets/generated/`;
runtime copies the loadable files to `public/assets/fingersnap/` (copies are
the same bytes; the originals in `assets/generated/` are the archive of
record).

Provenance: original artwork generated 2026-10-02 with the built-in
image-generation tool ("built-in image_gen"). Exact source prompts:
`assets/generated/prompts.json` (keys `village`, `props`, `ruin`; prompts
instruct "Original artwork; do not reproduce any existing game scene" and
explicitly avoid people/UI/text). Generation metadata:
`assets/generated/manifest.json`. Handoff notes: `assets/generated/README.md`,
`assets/ASSETS_GUIDE.md`. Visual and dimensional review recorded in the
handoff README (PNG sizes, alpha, atlas bounds checked).

| File | Key(s) | Size | Role | Source prompt key |
|---|---|---|---|---|
| `fingersnap-village.png` | `fingersnap-village` | 1536×1024 | Village scene illustration; runtime background/map reference (UI/reference only) | `village` |
| `fingersnap-shrine.png` | `fingersnap-shrine` | 1536×1024 | Shrine/ruin scene illustration; runtime background/map reference (UI/reference only) | `ruin` |
| `fingersnap-props.png` + `fingersnap-props.atlas.json` | `fingersnap-props` | 4 cols × 3 rows atlas | 12 static transparent props, Phaser JSON-hash atlas | `props` |
| `manifest.json`, `prompts.json`, `README.md` | — | — | Provenance metadata (not game art) | — |

Atlas frames (12): `lantern-post`, `patched-bench`, `trail-sign`,
`stone-milestone`, `bread-basket`, `flower-planter`, `tool-crate`,
`expedition-backpack`, `treasure-chest`, `lantern-shrine`,
`mushroom-cluster`, `grappling-rope`. Frames are hand-measured with 1 px
padding; origins and suggested display heights are in the manifest.

Known limits (recorded, not defects): flattened scenes are not tilesets or
collision maps; prop frames are static (no animation/open states); generated
pixel art is not authored on a strict 16/32 px grid and may need grid cleanup
to match eventual avatar scale.

Provenance attributes for the register table: **Author** — Glimway project
(external asset agent via built-in image_gen). **Source** — original
generation, prompts in-repo. **Modifications** — none yet (atlas frames are
measured from the sheet, not edited). **Licence** — CC0 1.0 (public domain; see "Licences"). **Attribution** — none required.

## Register B — original procedural placeholders (current)

Style-aligned placeholder art generated procedurally by project code (shapes,
tiles, and simple pixel figures drawn in code; no external files, no
third-party sources). Used by the runtime for anything the delivered pack does
not cover (walkable-area marks, temporary sprites, UI stand-ins).

| Item | Source | Author | Licence | Notes |
|---|---|---|---|---|
| Code-drawn placeholder shapes/tiles/sprites produced at runtime or build time | Project source (`src/game/` placeholder generators, runtime-owned) | Glimway project | Generators: AGPL-3.0-or-later (code). What they draw: CC0 1.0, as Register A | Original; style direction per "Art direction" above; no third-party bytes |

Each placeholder generator is original code; treat its output as original
art. When a delivered or licensed asset replaces a placeholder, keep the row
for history and move the replacement into Register A or C.

## Register D — expansion art pack (delivered)

Delivered 2026-10-02 (second drop, same day) by the external asset agent to
`assets/generated/expansion/` (the archive of record).
`public/assets/fingersnap/expansion/` ships only `manifest.json` and
`animations.json`: the terrain cells ship baked into `packed/terrain.webp`,
and the foreground, demo-walk and enemy sheets as GPU-scaled atlases in
`packed/` (`scripts/build-atlases.ts`).

Provenance: original artwork generated 2026-10-02 with the built-in
image-generation tool ("built-in image_gen"). Exact source prompts:
`assets/generated/expansion/prompts.json` (keys `terrain`, `foreground`,
`hero-walk`, `enemies`; hero-walk prompt explicitly says "original demo
adventurer NOT a Habitica asset"). Generation metadata:
`assets/generated/expansion/manifest.json`; animation defs:
`animations.json`; atlas builder that measured frames:
`build_atlases.py`. The pack's integration reference was ported to
`src/game/expansion.ts` (runtime-owned call sites) and the archived copy
removed (2026-10-07).

| File | Key(s) | Source size | Role | Prompt key |
|---|---|---|---|---|
| `fingersnap-terrain.png` + `.atlas.json` | `fingersnap-terrain` | 1254×1254 (uneven grid) | 16 named ground tiles (grass…paths) | `terrain` |
| `fingersnap-foreground.png` + `.atlas.json` | `fingersnap-foreground` | 1254×1254 | 6 transparent occluders (canopies, arches, roof, ferns) | `foreground` |
| `fingersnap-demo-walk.png` + `.atlas.json` | `fingersnap-demo-walk` | 1254×1254 | 16 frames, 4-direction demo walk (stand-in hero) | `hero-walk` |
| `fingersnap-enemies.png` + `.atlas.json` | `fingersnap-enemies` | 1448×1086 | 12 frames: slime/mushroom/beetle idle+squash+windup+hurt | `enemies` |
| `animations.json` | `glimway-expansion-animations` | — | 7 animation defs (4 walks, 3 enemy idles) | — |
| `manifest.json` | `glimway-expansion-manifest` | — | Tile index map, frame lists, `runtimeTexture` key | — |

Frame names: terrain `grass, flower-grass, forest-moss, packed-dirt,
cobblestone, mossy-cobblestone, shrine-stone, cave-gravel, pond-water,
shallow-water, wood-planks, dark-wood-planks, path-vertical, path-horizontal,
path-crossroads, path-t-junction` (runtime tileset index order 0–15 as in
manifest); foreground `oak-canopy, pine-canopy, leafy-arch, cottage-roof,
stone-arch, fern-cluster`; walk `walk-{down,left,right,up}-0..3`; enemies
`{slime,mushroom,beetle}-{idle,squash,windup,hurt}`.

Recorded limits/quirks: terrain source cells are **uneven** (1254 px sheet is
not an even 4×4 of 256 px; hand-measured atlas rects ~314 px are
authoritative) — the atlas build box-filters each cell into a uniform 4×4
tileset at ART_DENSITY (`packed/terrain.webp`, loaded as
`fingersnap-terrain-runtime`); the demo walker
is an original stand-in, not a Habitica avatar; enemy windup/hurt frames are
available but no full combat anim set; trimmed frames carry
`spriteSourceSize` offsets (handled by Phaser atlas loader); no collision or
walkability metadata (runtime authors it).

Provenance attributes: **Author** — Glimway project (external asset agent
via built-in image_gen). **Source** — original generation, prompts in-repo.
**Modifications** — none to source PNGs; atlas rects measured by
`build_atlases.py`; the shipped tileset and atlases are resampled by
`scripts/build-atlases.ts`. **Licence** — CC0 1.0 (public domain; see "Licences"). **Attribution** — none required.

## Register E — runtime art pass (NPCs, guardian, class effects)

Delivered 2026-10-03 by the external asset agent to
`assets/generated/runtime-pass/`; runtime-loaded copies live at
`public/assets/fingersnap/runtime-pass/` (same bytes; the generated copy is
the archive of record).

Provenance: original artwork generated 2026-10-03 with the built-in
image-generation tool ("built-in image_gen"; pack `prompts.json` records
`date` 2026-10-03 and `tool`). Exact source prompts:
`assets/generated/runtime-pass/prompts.json` (generation keys `npcs`,
`guardian`, `effects`; a cleanup prompt removes halos, glow, shadows, haze
and background pixels outside sprite outlines while preserving poses,
colors, positions and arrangement). Generation metadata and measured
rectangles: `manifest.json` — 27 frames with `sourceRect`/`destinationRect`,
7 animation defs, 7 compatibility aliases (rects measured by
`build_manifest.py`). Handoff notes and the validation record:
`assets/generated/runtime-pass/README.md`. Browser preview `preview.html`
(validation only, not game art). The pack's integration reference was
ported to `src/game/runtime-art.ts` (content agent's module; runtime-owned
call sites) and the archived copy removed (2026-10-07); manifest contract
covered by `tests/runtime-art.test.ts`.

| File | Key(s) | Source size | Role | Prompt key |
|---|---|---|---|---|
| `fingersnap-npcs.png` | `fingersnap-npcs` (source sheet) | 1024×1535 | Mara/Pip/Orrin, 2 breathing poses each (6 measured frames → 16×16 native) | `npcs` |
| `fingersnap-guardian.png` | `fingersnap-guardian` (source sheet) | 1536×1024 | Stone guardian idle/windup/lunge/hurt/defeat (5 measured frames → 24×24 native) | `guardian` |
| `fingersnap-class-effects.png` | `fingersnap-class-effects` (source sheet) | 1254×1254 | Cleave, magic bolt, dash trail, healing pulse, 4 stages each (16 measured frames) | `effects` |
| `manifest.json` | `glimway-runtime-art` | — | 27 measured frame rects, 7 animation defs, 7 compat aliases | — |
| `build_manifest.py`, `preview.html`, `README.md`, `prompts.json` | — | — | Provenance/helper metadata (not game art) | — |

Frame keys: `mara-idle-0/1`, `pip-idle-0/1`, `orrin-idle-0/1`,
`guardian-idle|windup|lunge|hurt|defeat`, `cleave-0..3`, `magic-bolt-0..3`,
`dash-trail-0..3`, `healing-pulse-0..3`. Animation keys: `mara-breathing`,
`pip-breathing`, `orrin-breathing` (2 frames, 1.5 fps, looping),
`effect-cleave` / `effect-dash-trail` / `effect-healing-pulse` (4 frames,
12 fps, one-shot), `effect-magic-bolt` (4 frames, 12 fps, looping).
Compatibility aliases: `mara`→`mara-idle-0`, `pip`→`pip-idle-0`,
`orrin`→`orrin-idle-0`, `guardian0`→`guardian-idle`,
`guardian1`→`guardian-lunge`, `slash`→`cleave-2`, `bolt`→`magic-bolt-0`;
applied only deliberately via `installRuntimeAliases(..., { replaceExisting:
true })` in boot setup.

Recorded limits/quirks: the PNGs are high-resolution sheets with
hand-measured rectangles — never treat them as even grids, never load them
with `frameWidth`, never pre-scale or overwrite them; transparent pixels may
hide original backdrop RGB (never rendered; do not flatten against black);
NPCs share one common scale (Pip stays smaller) and sit on a fixed foot
baseline in their 16×16 canvases; guardian poses share one common scale
(defeat stays collapsed) in 24×24 canvases and are discrete combat states,
not a loop; native canvases are deliberately small and lose source detail;
dash-trail 18×18 and healing-pulse 32×32 were proposed sizes the spec had
not defined (adopted in `docs/runtime-asset-spec.md` with this delivery);
NPC poses are front-facing only; no collision or walkability metadata
(runtime keeps the authored NPC 10×8 and guardian 20×10 foot bodies); no
audio.

Provenance attributes: **Author** — Glimway project (external asset agent
via built-in image_gen). **Source** — original generation, prompts in-repo.
**Modifications** — cleanup prompt pass (background/halo removal) applied at
generation time; source PNGs byte-unchanged since delivery; runtime canvas
textures are derived at load time (not files). **Licence** — CC0 1.0 (public domain; see "Licences"). **Attribution** — none required. This
generated pack does not inherit Habitica's artwork licence.

## Register F — Commons pass (Commons, homes, village life, Wilds, icons)

Delivered 2026-10-05 to `assets/generated/commons-pass/` (archive of
record: 22 source sheets, per-sheet atlases, `manifest.json`, prompts,
`preview.html`, validation and inspection data, `build_manifest.py`, README
and COVERAGE). Mara, Orrin and Pip dialogue portraits were added 2026-10-08
with `portrait-residents-job.json`. `public/assets/fingersnap/commons-pass/` ships only
`manifest.json`; the frames ship baked into the packed atlas (see the
2026-10-05 changelog entry on packed atlases).

Provenance: original artwork generated 2026-10-05, with the three dialogue
busts added 2026-10-08 using the built-in image-generation tool; prompts in
`jobs.json`, `portrait-job.json`, and `portrait-residents-job.json`; no
Habitica artwork copied (pack README). 176 measured frames, 11 looping
animations, 11 aliases; answers `docs/art-requests.md` in full including
the optional Hazel, Ada and Wilds sets. Integration: `src/game/commons-pass.ts`
(loader, `commons-art:` native textures) and
`src/game/commons-pass-install.ts` (installs the frames under the keys the
scenes draw with); contract in `tests/commons-pass.test.ts`; wiring notes in
`docs/runtime-asset-spec.md`. The packed art always ships (owner decision,
2026-10-07): the Register B placeholders it covers were retired.
**Licence** — CC0 1.0 (public domain; see "Licences"). **Attribution** — none required.

Recorded limits/quirks: sources are irregular high-resolution atlases
(never a grid); native canvases are tiny, so detail simplifies at 16 px;
transparent pixels can carry backdrop RGB; the delivered upright fence piece
and the front-facing gateway don't fit the Commons layout (loaded, not
placed); 2×1 decorations and the plot sign board are refitted/widened at
runtime from the measured crops (source bytes untouched).

## Register G — Items pass (tools, supplies, keepsakes, home goods, papers, world sprites, mill)

Delivered 2026-10-05 to `assets/generated/items-pass/` (archive of
record: 12 sheets, per-sheet atlases, `manifest.json`, `jobs.json`,
`request-index.json`, `preview.html`, `validation.json`,
`frame-inspection.json`, `build_manifest.py`, README and
COVERAGE). `public/assets/fingersnap/items-pass/` ships only `manifest.json`;
the frames ship baked into the packed atlas (`items.webp`, 1.1 MB).

Provenance: original artwork generated 2026-10-05 with the built-in
image-generation tool; prompts in `jobs.json` / `request-index.json`; no
Habitica artwork copied (pack README). 170 measured frames, 3 looping
mill animations, 31 state groups, 118 aliases (including 9 `commons:`
aliases); answers `docs/art-requests.md` items pass in full. Integration:
`src/game/items-pass.ts` (loader, `items-art:` native textures, `itemIcon`
helper with discrete states and fallbacks, `itemIconUrls`); Tolley mill
replacement in `installItemsPass`; contract in `tests/items-pass.test.ts`;
wiring notes in `docs/runtime-asset-spec.md`. The code-drawn mill
(`src/game/mill-art.ts`) it replaced was retired. **Licence** — CC0 1.0 (public domain; see "Licences"). **Attribution** — none required.

Recorded limits/quirks: sources are irregular high-resolution sheets
(never a grid); native canvases are tiny (16×16 for item icons); tool
conditions and variants are discrete states (never auto-looping); the Tolley
Mill waterwheel and froth are the three authored looping animations.

## Register H — playtest-1 pass (ground, residents, buildings, held tools)

Committed 2026-10-06 (round 1: ground, transitions, walking residents, held
tools, a player-body prototype) and 2026-10-07 (rounds 2–3: flagstone and
water-bed variants, three village houses, the Brackenwood footbridge, a
seamless pond bed) to `assets/generated/playtest1-pass/` (the archive of
record, ~39 MB: 23 source sheets, `atlas.json` with 427 measured frames and
the source catalog, `manifest.json`, `animations.json` with 82 sequences,
`prompts.json`, `validation.json`, `preview.html`, README and COVERAGE).
Nothing from the pass ships as its own file: `scripts/build-atlases.ts`
samples only the frames in use into `packed/ground.webp` (the ground tiles,
seam-healed after baking, and the pond bed, seamless as delivered and cut
into 4×4 tiles unhealed), `packed/people.webp` (the eight
residents and the held tools) and `packed/buildings.webp` (the houses and
the bridge).

Provenance: original artwork generated with Codex built-in image generation
(`prompts.json` records the date, 2026-10-06, the generator, the shared
style and one request per sheet, rounds 2–3 included). Integration:
`src/game/atlas-plan.ts` (`PLAYTEST1_DIR`, `GROUND_TILES`, `PEOPLE`,
`BUILDINGS`, `HELD_*`), `src/game/ground-tiles.ts`, `src/game/people.ts`,
`src/game/buildings.ts`; staleness and contract checks in
`tests/atlases.test.ts`.

| Source | Frames used | Ships in | Role |
|---|---|---|---|
| `ground/fingersnap-ground-base.png`, `ground/fingersnap-ground-flagstone-variants.png` | the ground tiles named in `GROUND_TILES` | `ground.webp` | Village and Commons ground |
| `water/fingersnap-pond-bed-seamless.png` | `pond-bed-seamless` (4×4 tiles) | `ground.webp` | Pond floor |
| `residents/fingersnap-resident-{mara,pip,orrin,silas,elara,finn,hazel,ada}.png` | `resident-<id>-*` (25 poses each) | `people.webp` | Walking, idle and sitting residents |
| `hand-items/fingersnap-held-tools.png` | `held-*` (8 tools × 4 directions) | `people.webp` | Tools in the hand |
| `houses/fingersnap-house-{west,middle,ada}.png`, `bridge/fingersnap-brackenwood-bridge.png` | `BUILDINGS` | `buildings.webp` | Village houses, the footbridge (worn, mended) |
| `ground/fingersnap-ground-transition-*.png`, `ground/fingersnap-ground-waterbed-variants.png`, `player-body/…` | none | — | Delivered, not used yet (the player body is a prototype) |

Recorded limits/quirks: sources are irregular high-resolution sheets with
measured rects (never a grid); the base ground tiles are not bit-seamless
(the build heals the seams; README "Art notes"); resident sheets carry stray
pixels in unreferenced cells, which are never sampled; the player body is a
prototype without clean recolour layers. The residents' and held tools'
measured crops in `atlas.json` are not trusted: some cut a figure in half or
span two cells, and each resident frame was fitted to its own box (breathing
jumped, playtest 2026-10-07). The build finds each figure on the sheet itself
(`src/game/figures.ts`, by the sheet's row layout), samples only that
figure's pixels, draws a person's frames at one scale per facing
(`PERSON_HEIGHT` over that facing's median figure height) with every foot
point on the canvas's, and measures the held tools' grips on the baked art,
mirroring any that lean right so all lean out from the hand. The Tolley mill
wheel's frames (items pass) are fitted the same way to one wall height and
pivot, mirrored to put the wall against the mill. `e2e/sprite-anchors.spec.ts`
checks the shipped texels.

Provenance attributes: **Author** — Glimway project (Codex built-in image
generation). **Source** — original generation, prompts in-repo.
**Modifications** — none to source PNGs; the shipped packs are box-filtered
to ART_DENSITY and the ground tiles (not the pond bed) seam-healed by
`scripts/build-atlases.ts`.
**Licence** — CC0 1.0 (public domain; see "Licences"). **Attribution** — none required.

## Register J — Indoors pass (Round 2b rooms and shared kit)

Delivered 2026-10-08 to `assets/generated/indoors-pass/`; generated source sheets, measured crops, and metadata are the archive of record. `public/assets/fingersnap/indoors-pass/` ships `manifest.json`; the 176 named frames are packed into `packed/indoors.webp` and indexed under `indoors.frames` in `packed/atlases.json` when the atlas build is run. Room wiring remains with the code lanes.

Provenance: original art generated 2026-10-08 with the built-in image generation tool; prompts and generation IDs are recorded in `prompts.json` and `round2-jobs.json`. Edge-connected neutral checkerboard pixels were converted to alpha. Hand-measured crops are aspect-contained on transparent native-size canvases, with 64 texels per 16 px tile. Round 2b crops include a 4 px transparent gutter; all 176 frame crops were audited for small edge fragments, with five legacy fragments removed (`edge-audit.json`). `manifest.json` and `atlas.json` record frame geometry; `furnishings.json` records 48 placeable pieces with facing/state frames, footprint, base, size, mount, and offered surfaces. Contact and room preview sheets are in `.agent/screens/`; `assets/generated/indoors-pass/README.md` lists them.

| File | Keys / contents | Role |
|---|---|---|
| `sheets/floors-seamless.png` | `plank-floor-0..3`, `flagstone-floor-0..3` | Four variants per seamless floor family |
| `sheets/interior-detail.png`, `interior-kit.png` | walls, openings, stairs, rugs, counters, first-pass room pieces | First-pass architecture and pieces retained for compatible use |
| `sheets/library-round2.png` | library shelves, desk, nook, signs | Round 2b library signatures |
| `sheets/shared-kit-round2.png` | generic reusable furnishing kit | Shared building and player-home dressing |
| `sheets/kitchen-round2.png` | kitchen signature furniture | Hazel's kitchen |
| `sheets/mill-loft-round2.png` | mill and loft signature furniture | Finn's mill and sack loft |
| `sheets/round2-crops/` | 75 individual transparent frames | Precisely measured Round 2b frames |
| `manifest.json`, `atlas.json`, `furnishings.json`, `edge-audit.json` | 176 frames, 90 sources, 16 animation/state groups, 48 piece definitions | Frame and placement contracts and crop-edge audit |
| `.agent/screens/*-pass.png`, `*-in-room.png` | room contact sheets and five mock-ups | Visual review |

Three slow loops: cauldron steaming, millstone turning, and gear wheel turning. Other states are static. Round 2b replaces interior use of the prior oven, table, crock shelf, tallow pot, bread rack, mill machinery/sacks/hoist, and library shelf/table/donation shelf/window seat families; the exact old keys and replacement policy are in `docs/art-request-indoors.md`. First-pass floors, walls, openings, exterior overlays, and quest icons remain. Known limitations: mill machinery turns are approximate; exterior windows still need alignment to exact building masks; the seated desk is a combined desk/resident art state. **Licence** — CC0 1.0 (public domain; see "Licences"). **Attribution** — none required.

## Register I — sound (Kenney's CC0 packs, delivered 2026-10-07)

Sound effects cut from three of Kenney's audio packs (kenney.nl), all
**CC0 1.0** (each pack's `License.txt` says so: "Creative Commons Zero, CC0
… Credit (Kenney or www.kenney.nl) would be nice but is not mandatory").
Downloaded from kenney.nl on 2026-10-07:

- **Interface Sounds** (1.0): https://kenney.nl/assets/interface-sounds
- **RPG Audio**: https://kenney.nl/assets/rpg-audio
- **Impact Sounds** (1.0): https://kenney.nl/assets/impact-sounds

Files: `public/assets/audio/kenney/` (notice: `public/assets/audio/kenney/LICENSE`),
41 MP3s, about 113 KB together. The game plays them through the sound module
(`src/game/sound.ts`; cue table `src/game/sound-bank.ts`).

**Edits, the same for every file:** leading and trailing silence trimmed
(below -50 dB), folded to mono at 44.1 kHz, levelled so each clip's loudest
50 ms sits at -14 dBFS RMS with peaks kept under -1 dBFS, a 20 ms fade-out
(shorter on very short clips), metadata stripped, encoded as MP3 (LAME VBR
quality 5). MP3 because every target browser decodes it, Safari on iPhone
included (Safari only began playing Ogg Vorbis in 18.4), so one format serves
all and no fallback is needed. The mix between cues is set in code (`gain`
in the cue table), not in the files.

| File | Cue | Pack | Source file |
|---|---|---|---|
| `ui-click.mp3` | click | Interface Sounds | `select_002.ogg` |
| `ui-confirm.mp3` | confirm (a purchase, an upgrade) | Interface Sounds | `confirmation_001.ogg` |
| `ui-refuse.mp3` | fizzle (refused: no mana, can't place, an error) | Interface Sounds | `error_008.ogg` |
| `ui-notice.mp3` | notice (a toast) | Interface Sounds | `glass_001.ogg` |
| `discover.mp3` | discover (journal, a paper found) | Interface Sounds | `glass_004.ogg` |
| `calm.mp3` | calm (a creature settled) | Interface Sounds | `confirmation_003.ogg` |
| `coins.mp3` | ember (embers gained) | RPG Audio | `handleCoins2.ogg` |
| `pickup.mp3` | pickup (into the bag) | RPG Audio | `handleSmallLeather.ogg` |
| `door-open.mp3` | door-open (into the cottage, the Library) | RPG Audio | `doorOpen_1.ogg` |
| `door-close.mp3` | door-close (out of the cottage) | RPG Audio | `doorClose_4.ogg` |
| `swing-1.mp3`, `swing-2.mp3` | swing | RPG Audio | `knifeSlice.ogg`, `knifeSlice2.ogg` |
| `roll.mp3` | roll (the dodge) | RPG Audio | `cloth2.ogg` |
| `step-path-1.mp3`, `step-path-2.mp3`, `step-path-3.mp3`, `step-path-4.mp3` | footsteps on path, dirt, sand | RPG Audio | `footstep00.ogg`, `footstep01.ogg`, `footstep03.ogg`, `footstep07.ogg` |
| `step-grass-1.mp3`, `step-grass-2.mp3`, `step-grass-3.mp3`, `step-grass-4.mp3` | footsteps on grass | Impact Sounds | `footstep_grass_000.ogg`, `_001`, `_002`, `_003` |
| `step-stone-1.mp3`, `step-stone-2.mp3`, `step-stone-3.mp3`, `step-stone-4.mp3` | footsteps on stone, cobbles | Impact Sounds | `footstep_concrete_000.ogg`, `_001`, `_003`, `_004` |
| `step-wood-1.mp3`, `step-wood-2.mp3`, `step-wood-3.mp3`, `step-wood-4.mp3` | footsteps on planks, bridges, indoors | Impact Sounds | `footstep_wood_000.ogg`, `_001`, `_002`, `_004` |
| `chop-1.mp3`, `chop-2.mp3` | chop | Impact Sounds | `impactWood_heavy_000.ogg`, `impactWood_heavy_001.ogg` |
| `quarry-1.mp3`, `quarry-2.mp3` | quarry (break) | Impact Sounds | `impactMining_000.ogg`, `impactMining_001.ogg` |
| `clink.mp3` | clink (a blow off the warden's stone) | Impact Sounds | `impactMining_002.ogg` |
| `dig.mp3` | dig | Impact Sounds | `impactSoft_medium_001.ogg` |
| `plant.mp3` | plant | Impact Sounds | `impactGeneric_light_000.ogg` |
| `craft.mp3` | craft (Workshop, Hearth) | Impact Sounds | `impactPlank_medium_000.ogg` |
| `hit-1.mp3`, `hit-2.mp3` | hit | Impact Sounds | `impactPunch_medium_000.ogg`, `impactPunch_medium_001.ogg` |
| `crit.mp3` | crit | Impact Sounds | `impactPunch_heavy_000.ogg` |
| `hurt.mp3` | hurt (the hero takes a blow) | Impact Sounds | `impactSoft_heavy_001.ogg` |

Each path above is under `public/assets/audio/kenney/`; the step and
multi-variant rows list their files in order.

Still procedural (Web Audio notes, no files): the dialogue voices, the quest
and lantern stings, the warden's falter and settle, the cast, the windup
tell, the area chime, the placement pop and the defeat fall.

**Ambience: none yet.** Kenney has no fitting ambience loop. The module has a
slot for one per area (`AMBIENCE` in `src/game/sound-bank.ts`); CC0 loops
from Freesound (village day, woods, wind in the Wilds, a hearth indoors)
would go in their own register here.

**Licence** — CC0 1.0 (Kenney's packs; our edits CC0 too). **Attribution** —
not required; credited anyway as a courtesy (Menu About card, README).

## Register C — pending delivered art (not yet in repo)

Expected from the external asset agent; **not present, not licensed, not
integrated**. When delivered, copy into `assets/generated/` (or a dated
subfolder), attach the exact source prompts, and add a Register A-style table.
**Licence** — none yet. Generated art joins the CC0 folders; human-made art
goes in its own folder with its own `LICENSE` and register.

| Expected asset | Purpose | Status |
|---|---|---|
| ~~Stone warden/guardian frames~~ | Guardian encounter beats the enemy trio can't cover | **delivered** (Register E: idle/windup/lunge/hurt/defeat) |
| Enemy walk/attack move sets (beyond idle/squash/windup/hurt) | Light real-time combat | pending |
| NPC side-facing frames (left/right) for Mara, Pip, Orrin | Walk/idle beyond the front-facing breathing pair | pending |
| Weather/occlusion variants, interior/mask layers | Depth over flattened scenes | pending |
| ~~Audio (UI, interaction)~~ | Warmth and feedback | **delivered** (Register I: Kenney CC0 packs) |
| Audio: ambience loops | Warmth between actions | pending (no fitting Kenney loop; CC0 from Freesound later; slot in `src/game/sound-bank.ts`) |
| Licensed Habitica avatar/equipment/pet/mount composition | "Make it your character" milestone (license-verified) | pending |

## Next asset priorities (requested 2026-10-02; first three delivered)

1. ~~Terrain tiles~~ — **delivered** (Register D `fingersnap-terrain`).
2. ~~Avatar walking~~ — **delivered** as original demo stand-in (Register D
   `fingersnap-demo-walk`). Replace with licensed Habitica avatar composition
   at the "Make it your character" milestone.
3. ~~Enemies~~ — **delivered** as trio idle sets (Register D
   `fingersnap-enemies`); guardian/warden frames delivered separately in
   Register E.

Next in priority order now:

1. **Stone warden / guardian frames** — ~~the quest's required encounter
   (`defeat-guardian`), with readable telegraph and defeat pose.~~
   **delivered** (Register E: idle/windup/lunge/hurt/defeat; telegraph =
   windup + code tint).
2. **NPC side-facing frames** — left/right idle or walk for Mara, Pip, and
   Orrin; Register E covers front-facing breathing only.
3. **Terrain collision/walkability annotation** — not art, but the companion
   deliverable so terrain tiles become real movement (runtime authors it from
   tile ids if metadata can't be generated).
4. **Enemy movement/combat frames** — walk/attack for the trio once combat
   prototyping starts (milestone 3).
5. ~~**Audio** — ambience, UI, interaction~~ — UI and interaction
   **delivered** (Register I, Kenney CC0); ambience still pending (Register C row).

Style bar for all: keep to the Art direction above ("stay close to Habitica
pixel art"); clean pixel grid; strong silhouettes; Register D palette.

## Third-party assets (Habitica, introduced 2026-10-03)

Any non-original asset must be registered here **before** it enters the repo,
one row each:

| File | Source URL | Author | License + link | Attribution text | Modifications | Register date |
|---|---|---|---|---|---|---|
| `content/habitica-gear.json` | `https://habitica.com/api/v3/content` (public static GET; snapshot of HabitRPG/habitica `develop` @ `789bbe4ab779febbed92d92b533c70f41b9f7b09`) | HabitRPG, Inc. and Habitica contributors | GPL-3.0 — https://github.com/HabitRPG/habitica/blob/develop/LICENSE (notice: `content/habitica-gear.NOTICE.md`) | "Gear statistics derived from Habitica's content data (GPL-3.0)." | Flattened to per-key numeric stats; i18n text/notes omitted; no numeric values changed | 2026-10-03 |
| `public/assets/habitica/*.png` (41 files, scoped subset) + `manifest.json` | `https://habitica-assets.s3.amazonaws.com/mobileApp/images/{name}.png` (byte-identical copies; sha256 in manifest) | HabitRPG, Inc. (Habitica art) | CC BY-NC-SA 3.0 — https://creativecommons.org/licenses/by-nc-sa/3.0/ (notice: `public/assets/habitica/LICENSE`) | "Avatar, gear and companion art from Habitica (habitica.com), © HabitRPG, Inc., licensed CC BY-NC-SA 3.0." | None (byte-identical); subset selection only | 2026-10-03 |
| `public/assets/audio/kenney/*.mp3` (41 files, Register I) | https://kenney.nl/assets/interface-sounds, https://kenney.nl/assets/rpg-audio, https://kenney.nl/assets/impact-sounds | Kenney (www.kenney.nl) | CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/ (notice: `public/assets/audio/kenney/LICENSE`) | "Sound effects by Kenney (kenney.nl), CC0." (courtesy, not required) | Trimmed, mono, levelled, MP3 (Register I) | 2026-10-07 |
| Layer order / sprite naming facts (docs/habitica-assets.md) | `website/client/src/components/avatar.vue`, `sprite.vue`, `spritesmith-main.css`, `constants/gifSprites.js` (same revision) | HabitRPG, Inc. and Habitica contributors | GPL-3.0 (code; facts recorded, no code copied) | same as data row | Recorded as documentation facts only | 2026-10-03 |

Rules (from the plan): Habitica source code is GPL v3; Habitica original
artwork/content is CC BY-NC-SA 3.0; BrowserQuest-derived artwork/content is
CC BY-SA 3.0. Individual files may carry individual licenses — verify each.
Adapted assets keep share-alike conditions. Keep notices in credits. Free
access does not settle noncommercial-license questions; revisit before any
monetization or partnership.

### Third-party use boundaries (Glimway)

- The CC BY-NC-SA art subset is **non-commercial**: no store listing, ads,
  sponsorship, or paid version while it ships. Our own art is CC0 and
  free of this limit, but the limit binds every instance that serves the
  Habitica sprites (from the repo or through the sprite proxy).
- Share-alike: distributing a build that includes the cached art subset
  requires the same CC BY-NC-SA 3.0 terms for those files (see license
  link). Keep this register + attribution text in any shipped credits.
- The GPL v3 data snapshot: if the catalog is redistributed as part of a
  binary or data package, GPL source-availability obligations apply to the
  derived data. The whole source is published under AGPL-3.0-or-later
  (`https://github.com/Solidsilver/glimway`), with the catalog and its GPL-3.0 notice
  (`content/habitica-gear.NOTICE.md`), which satisfies that.

## Credits text (ship in-game)

Text of record:

> Avatar, gear and companion art from [Habitica](https://habitica.com),
> © HabitRPG, Inc., licensed
> [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/);
> gear statistics derived from Habitica's content data (GPL-3.0). Glimway is
> not affiliated with or endorsed by Habitica.
>
> Sound effects by [Kenney](https://kenney.nl) (CC0).

This is the About card in the Menu (`src/ui/MenuPanel.svelte`). Never call
any instance, the main one included, "official".

## Changelog

- 2026-10-02 — Register created. Art direction recorded (Habitica-aligned
  pixel art, original work only). Register A populated from the delivered
  `assets/generated/` pack with prompt provenance. Placeholder policy set.
  Next priorities listed (terrain tiles, avatar walking, enemies). License
  decision pending; no public deployment until chosen.
- 2026-10-02 — Register D added for the expansion pack
  (`assets/generated/expansion/` + `public/assets/fingersnap/expansion/`):
  terrain, demo 4-direction walks, enemies, foreground atlases, animations,
  prompts and manifest recorded; uneven terrain-sheet normalization noted.
  First three priorities now delivered; next priorities re-ordered (guardian
  frames, walkability annotation, enemy combat frames). License still
  pending.
- 2026-10-03 — Third-party assets introduced (Register note + rows above):
  Habitica gear-data snapshot (GPL v3) in `content/habitica-gear.json`
  and a 41-file scoped art subset (CC BY-NC-SA 3.0) under
  `public/assets/habitica/` with `manifest.json` (sha256s). API register:
  `docs/habitica-assets.md`. Attribution/credits text added. Non-commercial
  and share-alike boundaries recorded. No account credentials used.
- 2026-10-03 — Register E added for the runtime art pass
  (`assets/generated/runtime-pass/` + `public/assets/fingersnap/runtime-pass/`):
  NPC breathing pairs (16×16), five discrete guardian states (24×24), and
  four class-effect sequences (cleave/bolt/dash-trail/healing-pulse) with
  measured source/destination rects for 27 frames. Integration helper ported
  to `src/game/runtime-art.ts` (type-only Phaser, no new deps); manifest
  source/animation/alias contract covered by `tests/runtime-art.test.ts`;
  native-helper contract recorded in `docs/runtime-asset-spec.md`. Guardian
  priority now delivered; wanted list re-set (side-facing NPC frames, enemy
  move sets, audio). License still pending; this pack keeps separate
  provenance from Habitica's artwork license.
- 2026-10-05 — Register F added for the Commons pass
  (`assets/generated/commons-pass/` + a trimmed
  `public/assets/fingersnap/commons-pass/`): residents and busts, the
  settled warden, homes and the cottage room, decorations and workshop
  furniture, the Commons set, village life, paper pickups, Wilds props,
  nodes, camps, lanterns, Echo props and UI icons wired over the code-drawn
  placeholders (which remain the fallback). License still pending.
- 2026-10-05 — Shipping copies replaced by packed atlases
  (`scripts/build-atlases.ts` → `public/assets/fingersnap/packed/`, 3.6 MB;
  `public/assets` 45.2 MB → 3.9 MB). Source PNGs in `assets/generated/**`
  untouched and remain the archive of record; `public/` keeps only the
  pack manifests. Canvas-blitted frames are pixel-identical; GPU-scaled
  atlases are re-sampled at their largest on-screen size; the two
  illustrations ship as WebP. See `docs/runtime-asset-spec.md` ("Packed
  atlases").
- 2026-10-06 — The dense packs (`commons`, `runtime`, `items`, `terrain`)
  ship as lossless WebP instead of PNG (`cwebp -lossless -z 9 -exact`):
  identical texels, 5.7 MB → 3.6 MB (`commons.webp` 2.1 MB, `items.webp`
  1.1 MB). The build fails unless the WebP decodes to the PNG's exact
  texels. See `docs/runtime-asset-spec.md` ("Packed atlases").
- 2026-10-06 — Dense packs: the Commons, runtime and items passes and the
  terrain tileset are baked at 4 texels per world px (64 per 16-px tile),
  box-filtered from the sources, and drawn at the same world size
  (`src/game/density.ts`; phones keep 2×). `packed/` grows to ~9 MB
  (`commons.png` 3.4 MB, `items.png` 1.7 MB). See
  `docs/runtime-asset-spec.md` ("Packed atlases").
- 2026-10-05 — Register G added for the Items pass
  (`assets/generated/items-pass/` + a trimmed
  `public/assets/fingersnap/items-pass/`): inventory icons for tools,
  supplies, keepsakes, home goods, papers, plus world sprites and the
  Tolley mill with its running waterwheel and mended wheel animations.
  Frames ship packed into `items.png` (144 KB); `public/assets` remains
  ~4.1 MB (~17 MB source copy removed from public). License still pending.
- 2026-10-07 — Register H added for the playtest-1 pass
  (`assets/generated/playtest1-pass/`, rounds 1–3): ground, pond bed,
  walking residents, held tools, village houses and the Brackenwood bridge,
  shipping only as baked frames in `ground.webp`, `people.webp` and
  `buildings.webp`. Register D updated: the expansion art ships packed, not
  as copies, and the terrain tileset is baked by the atlas build. The four
  archived `integration.js` references (expansion, runtime, Commons, items)
  removed; their ports in `src/game/` remain. License still pending.
- 2026-10-07 — The game is renamed Glimway (it was Fingersnap). Licences
  chosen: our art CC0 1.0 (`LICENSE` in `assets/generated/` and
  `public/assets/fingersnap/`; the folder keeps its old name because the
  packs' provenance scripts write there), code AGPL-3.0-or-later. Habitica's
  sprites get a notice (`public/assets/habitica/LICENSE`) and the gear
  catalog a GPL-3.0 notice. Credits corrected: Habitica's art is by
  HabitRPG, Inc.; "Weirdly Wonderful" was wrong and is gone.
- 2026-10-07 — Register I added: the game's first sound files, 43 MP3s cut
  from Kenney's Interface Sounds, RPG Audio and Impact Sounds packs (CC0),
  trimmed, levelled and encoded by script; per-file sources recorded. Kenney
  credited in the Menu and the README as a courtesy. Register C's audio row
  split: UI and interaction delivered, ambience still pending. Audio files
  go through Git LFS like the art.
- 2026-10-08 — Register I: `ui-open.mp3` and `ui-close.mp3` removed (the
  owner found the panel open and close sound grating); 41 MP3s remain.
