// Phaser scene helpers. Source PNG files are never modified.
export function preloadFingersnapExpansion(scene, base = '/assets/fingersnap/expansion/') {
  for (const key of ['fingersnap-terrain', 'fingersnap-foreground', 'fingersnap-demo-walk', 'fingersnap-enemies']) {
    scene.load.atlas(key, `${base}${key}.png`, `${base}${key}.atlas.json`);
  }
  scene.load.json('fingersnap-expansion-manifest', `${base}manifest.json`);
  scene.load.json('fingersnap-expansion-animations', `${base}animations.json`);
}

export function createFingersnapAnimations(scene) {
  for (const definition of scene.cache.json.get('fingersnap-expansion-animations')) {
    if (scene.anims.exists(definition.key)) continue;
    scene.anims.create({
      key: definition.key,
      frames: definition.frames.map(frame => ({ key: definition.texture, frame })),
      frameRate: definition.frameRate,
      repeat: definition.repeat,
    });
  }
}

// The generator produced a 1254px sheet, not an evenly divisible 4x4 grid.
// Named atlas rectangles are authoritative. Construct a uniform tileset at
// runtime for Phaser Tilemaps rather than treating the PNG as 32px source cells.
export function createFingersnapTerrain(scene, tileSize = 32) {
  const manifest = scene.cache.json.get('fingersnap-expansion-manifest');
  const key = manifest.terrain.runtimeTexture;
  if (scene.textures.exists(key)) return scene.textures.get(key);
  const output = scene.textures.createCanvas(key, tileSize * 4, tileSize * 4);
  if (!output) throw new Error('Could not create Fingersnap terrain texture');
  const context = output.context;
  context.imageSmoothingEnabled = false;
  const source = scene.textures.get('fingersnap-terrain');
  for (let index = 0; index < 16; index++) {
    const name = manifest.terrain.tiles[index];
    const frame = source.get(name);
    context.drawImage(frame.source.image, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight,
      (index % 4) * tileSize, Math.floor(index / 4) * tileSize, tileSize, tileSize);
  }
  output.refresh();
  return output;
}

// Occluder texture origins depend on where they attach in the world. Keep
// canopy depth anchored to its trunk/ground footpoint, not its top-left corner.
export function placeFingersnapOccluder(scene, frame, x, footY, displayWidth = 96) {
  const image = scene.add.image(x, footY, 'fingersnap-foreground', frame);
  image.setOrigin(0.5, 1).setScale(displayWidth / image.width).setDepth(footY);
  return image;
}
