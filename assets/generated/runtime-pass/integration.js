// Native runtime texture preparation for the generated Fingersnap sheets.
// Keep PNG originals unchanged. Copy this helper into the game's source tree.
export function preloadRuntimeArt(scene, base = '/assets/fingersnap/runtime-pass/') {
  for (const key of ['fingersnap-npcs', 'fingersnap-guardian', 'fingersnap-class-effects']) {
    scene.load.image(key, `${base}${key}.png`);
  }
  scene.load.json('fingersnap-runtime-art', `${base}manifest.json`);
}

export function createRuntimeArt(scene) {
  const manifest = scene.cache.json.get('fingersnap-runtime-art');
  for (const item of manifest.frames) {
    if (scene.textures.exists(item.key)) continue;
    const source = scene.textures.get(item.source).getSourceImage();
    const output = scene.textures.createCanvas(item.key, item.width, item.height);
    if (!output) throw new Error(`Cannot create texture ${item.key}`);
    const context = output.context;
    context.imageSmoothingEnabled = false;
    const s = item.sourceRect, d = item.destinationRect;
    context.drawImage(source, s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
    output.refresh();
  }
  for (const definition of manifest.animations) {
    if (scene.anims.exists(definition.key)) continue;
    scene.anims.create({
      key: definition.key,
      frames: definition.frames.map(key => ({ key })),
      frameRate: definition.frameRate,
      repeat: definition.repeat,
    });
  }
  return manifest;
}

// Only call this deliberately after procedural fallback textures are installed.
// This gives existing scene references their expected keys. It does not wire
// new combat states or alter collisions, which remain runtime-agent work.
export function installRuntimeAliases(scene, { replaceExisting = false } = {}) {
  const manifest = scene.cache.json.get('fingersnap-runtime-art');
  for (const [alias, key] of Object.entries(manifest.aliases)) {
    if (scene.textures.exists(alias)) {
      if (!replaceExisting) continue;
      scene.textures.remove(alias);
    }
    const source = scene.textures.get(key).getSourceImage();
    const output = scene.textures.createCanvas(alias, source.width, source.height);
    if (!output) throw new Error(`Cannot create alias ${alias}`);
    output.context.imageSmoothingEnabled = false;
    output.context.drawImage(source, 0, 0);
    output.refresh();
  }
}
