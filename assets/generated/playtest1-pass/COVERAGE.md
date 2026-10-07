# Playtest-1 coverage

| Request | Delivered in this pass | Notes |
|---|---|---|
| Grass (4), flowered grass (2), moss (2) | `ground-base` frames | 8 base tiles |
| Packed dirt (3), old cobbled road (3) | `ground-base` frames | 6 base tiles |
| Farmland (2), square flagstones (3), sand (2) | `ground-base` + `ground-village-flagstones-03/04` | The mislabeled original flagstones-02 is sand; two plaza variants added |
| Gentle animated water (5 frames) | `water-gentle-0..4` | 3 fps looping animation; frame 4 was mislabeled sand-02 |
| Alternate shallow-water stone beds (3 variants) | `ground-water-bed-variant-01..03` | Separate stationary water tiles; distinct submerged stones, matching-edge borders |
| Grass transitions to dirt, road, flagstones, sand, water | 5 transition atlases | 24 cells each; first 16 have cardinal mask metadata; extra eight are alternate shapes |
| Resident down/up/left/right, idle (2), walk (4), sit-down | `resident-{name}-*` | 8 people × 25 frames = 200 frames, fixed foot anchor |
| Directional hand-held tools | `held-{tool}-{direction}` | 8 items ×4 directions =32 frames; hand anchors included |
| Player base poses and color-family atlas | `player-body/fingersnap-player-body-index-atlas.png` | 4 directions × idle/walk/swing, 4 sitting poses, 4 hair references. Prototype only: 4 hair styles, and color families are not exact index layers; fifth style and clean separated recolor layers remain outstanding. |


## Playtest 2 additions

| Three village houses | `house-west`, `house-middle`, `house-ada` | Transparent sprites; 6×4 / 7×4 tile footprints, door column 2, window column 4, foot point at bottom-centre |
| Brackenwood footbridge | `brackenwood-bridge-worn`, `brackenwood-bridge-mended` | Two states in 128×128 canvases; deck rectangle 128×64 centered vertically |
| Seamless pond floor | `pond-bed-seamless` | One still 256×256 texture for 4×4 tiles; generated water-bed art is cyclically offset so its joins run across natural texture content |
| Production layered player body | Not included in this pass | Optional request remains open; round-1 body is still a prototype |
