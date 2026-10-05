// Source PNGs are irregular atlases. Always use measured manifest rectangles.
export function preloadCommonsArt(scene, manifest, baseUrl = manifest.baseUrl) {
  for (const source of manifest.sources) scene.load.image(source.key, baseUrl + source.file);
}

export function createCommonsArt(scene, manifest) {
  const keys = {};
  for (const frame of manifest.frames) {
    const key = 'commons-art:' + frame.key;
    keys[frame.key] = key;
    if (scene.textures.exists(key)) continue;
    const texture = scene.textures.createCanvas(key, frame.width, frame.height);
    const context = texture.getContext();
    context.imageSmoothingEnabled = false;
    const s = frame.sourceRect, d = frame.destinationRect;
    context.drawImage(scene.textures.get(frame.source).getSourceImage(), s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
    texture.refresh();
    texture.setFilter(0); // Phaser.Textures.FilterMode.NEAREST
  }
  for (const animation of manifest.animations) {
    const key = 'commons-art:' + animation.key;
    if (!scene.anims.exists(key)) scene.anims.create({ key,
      frames: animation.frames.map(frame => ({key: keys[frame]})),
      frameRate: animation.frameRate, repeat: animation.repeat });
  }
  for (const [alias, frame] of Object.entries(manifest.aliases)) keys[alias] = keys[frame];
  return keys;
}

export function placeCommonsArt(scene, manifest, frameKey, x, y) {
  const key = manifest.aliases[frameKey] || frameKey;
  const frame = manifest.frames.find(item => item.key === key);
  if (!frame) throw new Error('Unknown Commons art frame: ' + frameKey);
  return scene.add.sprite(x, y, 'commons-art:' + key).setOrigin(...frame.origin);
}

// Alternate reflected floor cells in a 2x2 arrangement when seamless joins
// matter. This uses the same source texture; no source PNG is modified.
export function floorTileOrientation(column, row) {
  return { flipX: (column & 1) === 1, flipY: (row & 1) === 1 };
}
