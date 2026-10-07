# Glimway — asset handoff for build agents

The generated source assets live in `assets/generated/`. They are saved in this project, not just displayed in the conversation or held in the image generator's cache.

## Runtime integration

For a Vite/Svelte game, copy the three PNGs and `fingersnap-props.atlas.json` into `public/assets/fingersnap/`. Keep the original files and provenance in `assets/generated/`. Alternatively, use your bundler's asset imports and supply the resulting URLs to Phaser.

`assets/generated/manifest.json` defines stable texture keys, filenames, dimensions, twelve named prop frames, recommended origins, and starting display heights. `fingersnap-props.atlas.json` uses Phaser's JSON hash atlas format. The atlas has individually measured frames, not equal grid cells.

Example Phaser scene integration after placing the files under `public/`:

```ts
preload() {
  this.load.image('fingersnap-village', '/assets/fingersnap/fingersnap-village.png');
  this.load.image('fingersnap-shrine', '/assets/fingersnap/fingersnap-shrine.png');
  this.load.atlas(
    'fingersnap-props',
    '/assets/fingersnap/fingersnap-props.png',
    '/assets/fingersnap/fingersnap-props.atlas.json',
  );
}

create() {
  const lantern = this.add.image(200, 180, 'fingersnap-props', 'lantern-post');
  lantern.setOrigin(0.5, 1);
  lantern.setScale(64 / lantern.height);
  lantern.setDepth(lantern.y);
}
```

Use consistent world scale and nearest-neighbor filtering when appropriate. The props are detailed generated pixel-style artwork, not rigorously authored 16- or 32-pixel sprites. Assess their readability at gameplay scale alongside the Habitica avatar before selecting final sizing.

## Available assets

| File | Available use | Limits |
|---|---|---|
| `fingersnap-village.png` | Static background, opening scene, visual reference for the village | Flattened scene; cannot walk behind individual roofs or trees without masks/layers |
| `fingersnap-shrine.png` | Static background, shrine scene, composition reference | Flattened scene; traversal and collision must be authored separately |
| `fingersnap-props.png` and atlas JSON | Twelve separately addressable transparent props | Static frames; no open-chest state or animation |

Prop names: `lantern-post`, `patched-bench`, `trail-sign`, `stone-milestone`, `bread-basket`, `flower-planter`, `tool-crate`, `expedition-backpack`, `treasure-chest`, `lantern-shrine`, `mushroom-cluster`, `grappling-rope`.

## Gameplay boundary

Do not treat either scene image as a seamless terrain tileset or infer collision from its colors. For a background-based prototype, author separate explicit walkable polygons, interaction points, and foreground occlusion masks. For a tile-based game, author actual modular terrain and building layers using these scenes as references.

Still needed for the full game: licensed Habitica avatar composition and character assets, suitable terrain tiles, foreground layers, enemy frames, combat effects, and audio. Do not claim these three images supply a complete game art pack.

## Provenance and checks

Generated using the built-in image generation tool on October 2, 2026. Exact prompts are in `assets/generated/prompts.json`. The images were visually reviewed. PNG dimensions and real prop transparency were checked; atlas rectangles are in bounds and encompass the twelve main object silhouettes. Engine integration is an example and has not been run in a game project yet.

These are original generated assets, not copies extracted from Habitica. Keep Habitica's assets and license notices tracked separately. A distribution license for this original pack has not yet been selected.
