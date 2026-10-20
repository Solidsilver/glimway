/**
 * Small native portraits for the dialogue box and the character sheet, cut
 * from the loaded art (EV.portraits), and the delivered UI icons
 * (EV.artIcons). Boot draws them a few at a time, once per game (the art
 * never changes after boot); each world scene sends them again.
 */
import { craftsIconUrls } from './crafts-art'
import { purseIconUrls } from './purse-art'
import { glimsIconUrls } from './glims-art'
import { openMapIconUrls } from './wilds/open-map-art'
import { indoorsIconUrls } from './indoors-art'
import type Phaser from 'phaser'
import { bus, EV } from './events'
import { drain, type Steps } from './art-pass'
import { densityOf } from './density'
import { COMMONS_RESIDENT_PORTRAITS, commonsDataUrl, commonsIconUrls } from './commons-pass'
import { itemIconUrls } from './items-pass'
import { NPC_NAMES } from './entities/npcs'

/** The portraits and icons drawn for each game. */
const drawn = new WeakMap<Phaser.Game, { portraits: Record<string, string>; icons: Record<string, string> }>()

/** Send the portraits and icons (drawn now if boot didn't). */
export function emitPortraits(scene: Phaser.Scene): void {
  if (!drawn.has(scene.sys.game)) drain(drawPortraits(scene))
  const d = drawn.get(scene.sys.game)!
  bus.emit(EV.portraits, { ...d.portraits })
  bus.emit(EV.artIcons, { ...d.icons })
}

/**
 * Small native portraits for the dialogue box and character sheet, a
 * portrait or a pass's icons a step. Each portrait is trimmed to its
 * visible pixels (textures carry transparent padding) and, for people,
 * cropped to head and shoulders, then centered on a square.
 */
export function* drawPortraits(scene: Phaser.Scene): Steps<void> {
  const out: Record<string, string> = {}
  const add = (name: string, key: string, frame: string | undefined, bust: boolean) => {
    try {
      if (!scene.textures.exists(key)) return
      const tex = scene.textures.get(key)
      if (frame && !tex.has(frame)) return
      const f = frame ? tex.get(frame) : tex.get()
      const src = f.source.image as CanvasImageSource
      // Dense textures (./density.ts): read their texels, `k` a world px.
      const k = frame ? 1 : densityOf(tex)
      const w = f.cutWidth * k
      const h = f.cutHeight * k
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(src, f.cutX * k, f.cutY * k, w, h, 0, 0, w, h)
      const data = ctx.getImageData(0, 0, w, h).data
      let minX = w, minY = h, maxX = -1, maxY = -1
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 16) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX < 0) return
      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      const cropH = bust ? Math.max(1, Math.ceil(bh * 0.58)) : bh
      // The portrait stays world-px sized (the UI sizes it by its natural size).
      const size = Math.ceil(Math.max(bw, cropH) / k) + 2
      const o = document.createElement('canvas')
      o.width = size
      o.height = size
      const octx = o.getContext('2d')!
      octx.imageSmoothingEnabled = k > 1
      octx.imageSmoothingQuality = 'high'
      const dx = Math.floor((size - bw / k) / 2)
      const dy = bust ? size - cropH / k : Math.floor((size - bh / k) / 2)
      octx.drawImage(c, minX, minY, bw, cropH, dx, dy, bw / k, cropH / k)
      out[name] = o.toDataURL()
    } catch {
      /* portrait is optional decoration */
    }
  }
  for (const id of ['mara', 'pip', 'orrin']) {
    add(NPC_NAMES[id], scene.textures.exists(`${id}-idle-0`) ? `${id}-idle-0` : id, undefined, true)
    yield
  }
  if (scene.textures.get('fingersnap-props').has('stone-milestone')) add('Route Marker', 'fingersnap-props', 'stone-milestone', false)
  else add('Route Marker', 'mural', undefined, false)
  yield
  add('Hilltop Lantern', 'fingersnap-props', 'lantern-shrine', false)
  add('Hearth Lantern', 'fingersnap-props', 'lantern-post', false)
  add('Road Lantern', 'fingersnap-props', 'lantern-post', false)
  add('Ashwatch Chest', 'fingersnap-props', 'treasure-chest', false)
  yield
  add('You', 'fingersnap-demo-walk', 'walk-down-0', true)
  yield
  // Commons pass: the residents' delivered busts (64 px), and the UI icons.
  for (const [name, frame] of Object.entries(COMMONS_RESIDENT_PORTRAITS)) {
    const url = commonsDataUrl(scene, frame)
    if (url) out[name] = url
    yield
  }
  const icons: Record<string, string> = {}
  for (const urls of [commonsIconUrls, itemIconUrls, indoorsIconUrls, craftsIconUrls, purseIconUrls, glimsIconUrls, openMapIconUrls]) {
    Object.assign(icons, urls(scene))
    yield
  }
  drawn.set(scene.sys.game, { portraits: out, icons })
}
