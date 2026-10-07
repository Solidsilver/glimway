# Playtest-1 coverage

| Request | Delivered in this pass | Notes |
|---|---|---|
| Grass (4), flowered grass (2), moss (2) | `ground-base` frames | 8 base tiles |
| Packed dirt (3), old cobbled road (3) | `ground-base` frames | 6 base tiles |
| Farmland (2), square flagstones (2), sand (2) | `ground-base` frames | 6 base tiles |
| Gentle animated water (4 frames) | `water-gentle-0..3` | 3 fps looping animation |
| Grass transitions to dirt, road, flagstones, sand, water | 5 transition atlases | 24 cells each; first 16 have cardinal mask metadata; extra eight are alternate shapes |
| Resident down/up/left/right, idle (2), walk (4), sit-down | `resident-{name}-*` | 8 people × 25 frames = 200 frames, fixed foot anchor |
| Directional hand-held tools | `held-{tool}-{direction}` | 8 items ×4 directions =32 frames; hand anchors included |
| Player base poses and color-family atlas | `player-body/fingersnap-player-body-index-atlas.png` | 4 directions × idle/walk/swing, 4 sitting poses, 4 hair references. Prototype only: 4 hair styles, and color families are not exact index layers; fifth style and clean separated recolor layers remain outstanding. |
