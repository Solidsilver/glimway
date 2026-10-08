# 0.4 Indoors art pass

Original art generated 2026-10-08 with the built-in image-generation tool.
The ten source sheets are in `sheets/`; prompts and generation file
IDs are in `prompts.json`. `manifest.json` records 101 named frames, source and
destination rectangles, exact requested canvases, footprints, foot points,
origins and 13 animation/state groups. `atlas.json` is the source-resolution
frame map. The packed frames are in `public/assets/fingersnap/packed/` under
`indoors.frames` in `atlases.json`; their clear frame names are the keys in the
manifest.

All canvases use 64 texels per 16px tile. The game packs the whole requested
canvases at density 64 so the room lane can consume them without scaling a
whole sheet. No room call sites were changed.

The image tool rendered a checkerboard backdrop instead of true transparency.
The source sheets preserve the generated sprite pixels while converting
edge-connected neutral checkerboard pixels to alpha. Frame crops are measured
by hand from the source sheets. The packed plank and flagstone families are
seam-healed by the atlas build using the existing minimum-error quilting
helper; other animation strips were not procedurally repaired.

## Known limits

- The generated smoke and lit-window overlays are not fitted to the exact
  existing house-window masks; the three windows should be aligned in the
  integration pass using the building art.
- The millstone and gear frames are close poses but not a mechanically exact
  quarter-turn sequence. Tallow pot states are three steam poses; some other
  repeated frames are static variants rather than precise animation.
- Several generated objects have finer painted shading and smaller pixels
  than the established native art. They are retained as source art and can be
  simplified during pixel cleanup.
- The optional Hazel kneading pose was not generated; it reuses her existing
  resident canvas and is not a new 0.4 art asset.

## Licence

Glimway project, original generated art, CC0 1.0. See `assets/generated/LICENSE`
and the indoors pass entry in `ASSETS.md`.
