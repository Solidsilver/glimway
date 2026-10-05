// Irregular source sheets are cropped by manifest rectangles at native size.
export function preloadItemArt(scene, manifest, baseUrl = manifest.baseUrl) {
  for (const source of manifest.sources) scene.load.image(source.key, baseUrl + source.file);
}

export function resolveItemFrame(manifest, itemId, state) {
  if (state !== undefined) {
    const frame = manifest.frames.find(f => f.itemId === itemId && f.state === state);
    if (!frame) throw new Error('Unknown item art state: ' + itemId + ' / ' + state);
    return frame;
  }
  const key = manifest.aliases[itemId];
  if (!key) throw new Error('Unknown item art: ' + itemId);
  if (key.startsWith('commons:')) return key;
  const frame = manifest.frames.find(f => f.key === key);
  if (!frame) throw new Error('Missing item frame: ' + key);
  return frame;
}

export function createItemArt(scene, manifest) {
  const keys = {};
  for (const frame of manifest.frames) {
    const key = 'items-art:' + frame.key;
    keys[frame.key] = key;
    if (scene.textures.exists(key)) continue;
    const texture = scene.textures.createCanvas(key, frame.width, frame.height);
    const context = texture.getContext();
    context.imageSmoothingEnabled = false;
    const s = frame.sourceRect, d = frame.destinationRect;
    context.drawImage(scene.textures.get(frame.source).getSourceImage(), s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
    texture.refresh();
    texture.setFilter(0);
  }
  for (const animation of manifest.animations) {
    const key = 'items-art:' + animation.key;
    if (!scene.anims.exists(key)) scene.anims.create({key,
      frames: animation.frames.map(frame => ({key: keys[frame]})),
      frameRate: animation.frameRate, repeat: animation.repeat});
  }
  for (const [alias, target] of Object.entries(manifest.aliases)) {
    keys[alias] = target.startsWith('commons:') ? 'commons-art:' + target.slice('commons:'.length) : keys[target];
  }
  return keys;
}

export function placeItemArt(scene, manifest, itemId, x, y, state) {
  const resolved = resolveItemFrame(manifest, itemId, state);
  if (typeof resolved === 'string') return scene.add.sprite(x, y, 'commons-art:' + resolved.slice('commons:'.length));
  return scene.add.sprite(x, y, 'items-art:' + resolved.key).setOrigin(...resolved.origin);
}
