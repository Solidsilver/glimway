# One sun: slopes lab 2c evidence

Original PNGs and matching state JSON from [CI run 39895401202](https://github.com/Solidsilver/glimway/actions/runs/39895401202), code `c35f8e92`, downloaded from `e2e-full-evidence`. These files are unmodified originals. Integrity hashes are in [sha256.json](sha256.json).

The walking guide and measured results are in [slopes-lab-notes.md](../../../slopes-lab-notes.md#how-to-walk-2c). [metrics.json](metrics.json) summarizes chunk CPU/upload-submission costs, browser scrubbing, and field travel times; [2c-evidence.json](2c-evidence.json) retains raw rAF and light-map samples. Chunk costs sum active work across progressive steps, excluding the frames spent waiting.

| View | Morning (07:12) | Noon (12:00) | Evening (16:48) |
|---|---|---|---|
| Owner's path near 72,48 | [Frame](2c-owner-morning.png) | [Frame](2c-owner-noon.png) | [Frame](2c-owner-evening.png) |
| Hills | [Frame](2c-hills-morning.png) | — | [Frame](2c-hills-evening.png) |
| Outcrop approach | [Frame](2c-outcrop-slope-morning.png) | — | [Frame](2c-outcrop-slope-evening.png) |
| Terrain shade comparison near 69,34 | [Sunny](2c-terrain-shade-morning.png) | — | [Shaded](2c-terrain-shade-evening.png) |

At noon: [north/sunny knoll](2c-knoll-sunny-noon.png), [south/shaded-facing knoll](2c-knoll-shaded-noon.png). Also: [spire at evening](2c-spire-evening.png), [phone at the owner's path in morning](2c-phone-owner-morning.png).

Visual review checks the sun direction against all casts, visible foot contact, and fixed bands. The knoll's shaded-facing side still receives direct light under the high noon sun; the separate terrain-shade pair is the proof of full terrain occlusion and zero own-shadow opacity. The silhouette uses a local receiving plane, so it does not wrap over a distant cliff. The terrain map has 8 px texels and a bounded 64-tile ray halo. The spire frame deliberately frames the feature rather than the hero.
