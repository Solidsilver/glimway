# Slopes 2e: edge shading and partial see-through

These are unmodified PNGs and their matching state JSON from [CI run 40059811180](https://github.com/Solidsilver/glimway/actions/runs/40059811180) (code `5dcd2785`, artifact `e2e-full-evidence`). I inspected all 17 originals and 17 crops at full size. [sha256.json](sha256.json) holds the integrity hashes. [2e-evidence.json](2e-evidence.json) holds each frame’s edge settings, its edge count across the loaded chunks, and the hero’s cover counts.

For how to walk these views, see [How to walk 2e](../../../slopes-lab-notes.md#how-to-walk-2e). The ramp frames are taken at the owner’s spot (130,93, 7.8 h, Restrained facing, contours off). Each one is shown in True ¾ lift (`lift`) and in Shading by facing (`facing`), at edge shading off, default (60%) and strong (100%), with scale by height on and with it off (`-unscaled`).

| View | Original | Detail | State |
|---|---|---|---|
| cliff-edge-facing | [Frame](2e-cliff-edge-facing.png) | [Crop](2e-cliff-edge-facing-crop.png) | [JSON](2e-cliff-edge-facing.json) |
| cliff-edge-lift | [Frame](2e-cliff-edge-lift.png) | [Crop](2e-cliff-edge-lift-crop.png) | [JSON](2e-cliff-edge-lift.json) |
| hills-meadow-facing | [Frame](2e-hills-meadow-facing.png) | [Crop](2e-hills-meadow-facing-crop.png) | [JSON](2e-hills-meadow-facing.json) |
| hills-meadow-lift | [Frame](2e-hills-meadow-lift.png) | [Crop](2e-hills-meadow-lift-crop.png) | [JSON](2e-hills-meadow-lift.json) |
| ramp-facing-default | [Frame](2e-ramp-facing-default.png) | [Crop](2e-ramp-facing-default-crop.png) | [JSON](2e-ramp-facing-default.json) |
| ramp-facing-default-unscaled | [Frame](2e-ramp-facing-default-unscaled.png) | [Crop](2e-ramp-facing-default-unscaled-crop.png) | [JSON](2e-ramp-facing-default-unscaled.json) |
| ramp-facing-off | [Frame](2e-ramp-facing-off.png) | [Crop](2e-ramp-facing-off-crop.png) | [JSON](2e-ramp-facing-off.json) |
| ramp-facing-strong | [Frame](2e-ramp-facing-strong.png) | [Crop](2e-ramp-facing-strong-crop.png) | [JSON](2e-ramp-facing-strong.json) |
| ramp-facing-strong-unscaled | [Frame](2e-ramp-facing-strong-unscaled.png) | [Crop](2e-ramp-facing-strong-unscaled-crop.png) | [JSON](2e-ramp-facing-strong-unscaled.json) |
| ramp-lift-default | [Frame](2e-ramp-lift-default.png) | [Crop](2e-ramp-lift-default-crop.png) | [JSON](2e-ramp-lift-default.json) |
| ramp-lift-default-unscaled | [Frame](2e-ramp-lift-default-unscaled.png) | [Crop](2e-ramp-lift-default-unscaled-crop.png) | [JSON](2e-ramp-lift-default-unscaled.json) |
| ramp-lift-off | [Frame](2e-ramp-lift-off.png) | [Crop](2e-ramp-lift-off-crop.png) | [JSON](2e-ramp-lift-off.json) |
| ramp-lift-strong | [Frame](2e-ramp-lift-strong.png) | [Crop](2e-ramp-lift-strong-crop.png) | [JSON](2e-ramp-lift-strong.json) |
| ramp-lift-strong-unscaled | [Frame](2e-ramp-lift-strong-unscaled.png) | [Crop](2e-ramp-lift-strong-unscaled-crop.png) | [JSON](2e-ramp-lift-strong-unscaled.json) |
| seethrough-full-48 | [Frame](2e-seethrough-full-48.png) | [Crop](2e-seethrough-full-48-crop.png) | [JSON](2e-seethrough-full-48.json) |
| seethrough-legs-24 | [Frame](2e-seethrough-legs-24.png) | [Crop](2e-seethrough-legs-24-crop.png) | [JSON](2e-seethrough-legs-24.json) |
| seethrough-legs-48 | [Frame](2e-seethrough-legs-48.png) | [Crop](2e-seethrough-legs-48-crop.png) | [JSON](2e-seethrough-legs-48.json) |

Edge counts in the JSON cover every chunk loaded around the view, not only what is on screen. The meadow and cliff counts include plateaus and cliffs elsewhere in the area. To judge clutter, look at the meadow frames themselves.

You can see the see-through at the hero’s legs in the crops. In legs-48, 58 of the sprite’s 178 opaque pixels draw as the outline, starting 12 rows down. In full-48, all 177 do. In legs-24, only 6 (the feet) do.

The full-size visual findings are recorded in [Evidence and review (2e)](../../../slopes-lab-notes.md#evidence-and-review-2e).
