# Fingersnap playtest 1 art pass

This pack starts the playtest-1 art request at the priorities that improve the first walk through Hearthwick: **village/Commons ground** and **all eight walking residents**. The generated PNGs are sources; the game’s atlas bake should sample only the rectangles in `manifest.json` / `atlas.json`.

## Pack contents

- 24 original ground cells plus 5 new variants at 64×64 destination texels. Corrected original counts: four grass, two flowered grass, two moss, three packed dirt, three old cobbled road, two farmland, one flagstone, two sand, and five gentle-water frames. Two additional flagstone tiles bring the plaza set to three; three separate water-bed variants add distinct submerged-stone layouts.
- One held-tool atlas with 8 tools in four facing directions (32 frames), each with a `handAnchor` in its 32×32 destination.
- One player-body prototype atlas with 4 directions × (2 idle + 4 walk + 2 swing), 4 sitting poses, and 4 hair references (40 frames).
- Five grass-transition atlases (dirt, cobbled road, flagstones, sand, water), 24 square variants apiece. Cells 0–15 carry the standard N/E/S/W mask fields; cells 16–23 are alternate edge/corner shapes.
- Eight resident atlases, each with 4 directions × (2 idle breathing + 4 walking frames), plus a down-facing sit pose: Mara, Pip, Orrin, Silas, Elara Quill, Finn Tolley, Hazel Penhallow, and Ada Cooley.
- Total: 18 source sheets, 421 measured frames, 82 animation groups.

## Runtime contract

World tile size is 16 px. Ground tile images are authored at 64×64 texels (density 4) and should draw at 16×16 world pixels. Resident canvases are 64×128 texels (density 4), representing 16×32 world pixels; the character artwork is fit to a common per-person scale and anchored to `footPoint: {x: 32, y: 128}`. Idle sequences change the torso only; walking sequences have four steps. `left` and `right` are both supplied; do not mirror them unless a runtime fallback is needed.

`atlas.json` has the requested `frame → source, x, y, w, h` mapping, the native destination rectangle, and a foot point for every person sprite. `manifest.json` adds source dimensions, world size, direction/state, and animation sequences. `animations.json` is a small runtime-facing sequence index. All crops are measured per frame; do not assume one cell size across all sheets.

The existing build packs inputs under `assets/generated/**` with the other delivered art. This pass does not change game scenes, collision, NPC dialogue, or world-map wiring. Add its manifest and textures to the atlas plan and boot setup when wiring it into playtest.

## Art notes

The original ground base is a 6×4 atlas. The former `ground-village-flagstones-02` cell is correctly named `ground-sand-by-water-03`; the former `ground-sand-by-water-02` cell is correctly named `ground-water-gentle-4` and is the fifth frame of the water loop. The two additional plaza tiles and three alternate submerged-stone tiles live in separate source sheets. Water-bed borders average at most 3.4 RGB levels of opposite-edge difference after reduction to 64×64; review in-game for remaining visible seams. The generated transition atlases include a dark separator line at some cell boundaries, so their source rectangles inset 2 px on every side to exclude it. Each transition atlas contains 24 cells rather than exactly 16; the first 16 are indexed by the N/E/S/W mask in `manifest.json`, with eight alternatives following them.

**Tiling needs a visual in-game review.** The art prompt requested seamless base tiles, but edge-pixel checks show the generated base textures are not bit-identical at opposite borders. The assets are useful for the playtest atlas now, but verify repetition at normal camera zoom before relying on them as seamless ground. The PNG source itself is preserved for a future seam-correction pass.

The generator occasionally puts stray semi-transparent pixels in unreferenced bottom-row cells of resident sheets. Those cells are intentionally omitted from `manifest.json`; only the 25 requested poses per person are loaded.

See `COVERAGE.md`, `prompts.json`, `validation.json`, and `preview.html` for the request mapping, generation record, measured checks, and visual browser preview.

## Player-body prototype

The player sheet uses a 64×128 texel destination and a bottom-center foot anchor at (32,128). Rows are down/up/left/right, with idle, walk, and two swing cells; the last row has four directional sitting poses followed by four hairstyle references. The distinct skin, hair, tunic, trouser, and boot colors are useful recoloring targets, but generated shading and edge pixels mean this is not an exact indexed-color atlas and the layers are not split into separate PNGs. It includes four hair references; the requested fifth style and production-ready recolor layers still need a focused pass.
