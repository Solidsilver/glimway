# Fingersnap starter artwork

Original artwork generated with the built-in image generation tool for this project. These files complement the planned Habitica character assets; they are not extracted from Habitica and do not inherit its asset license simply by depicting Fingersnap.

## Contents

- `fingersnap-village.png`: village scene illustration and world composition reference.
- `fingersnap-props.png`: transparent atlas of twelve static environment and adventure props, arranged in four columns and three rows.
- `fingersnap-shrine.png`: woodland shrine scene illustration and map composition reference.
- `prompts.json`: exact generation prompts and provenance.
- `fingersnap-props.atlas.json`: twelve individually measured frames for Phaser's JSON hash atlas loader.
- `manifest.json`: asset keys, dimensions, frame names, origins, and suggested display sizes.

## Art direction

Cute, lived-in woodland fantasy. Emerald foliage, teal shadows, amber lanterns, russet wood and roofs, and golden weathered stone. Repairs, gardens, everyday objects, and reclaimed ruins suggest a world with history. Consistent three-quarter top-down view; no isometric diamond grid.

## Intended use

The scenes can serve as static backgrounds or references for handcrafted maps. They are not seamless terrain tilesets, collision maps, or layered editable maps.

The prop atlas includes individually measured sprite-frame coordinates. Review display scale alongside the Habitica avatar before integrating it into Phaser. No collision data is supplied. Generated pixel art may need pixel-grid cleanup to match the eventual Habitica sprite scale. See `../../Assets Guide.md` for loading instructions and implementation limits.

No character artwork is included: use the licensed Habitica avatar, equipment, pet, and mount assets through the planned adapter and asset register. Choose a distribution license for this original artwork before public release.
