/** Phaser adapter for the independent, cheap sun map and alpha silhouettes. */
import Phaser from 'phaser'
import { buildSunMap, sampleVisibility, SUN_RES, type SunMap } from './sun-map.ts'
import { silhouetteBounds, type DaySun } from './sun.ts'
import { buildShadowLayer, casterProxy, dither, SHADOW_KEEP, type Caster, type CasterKind, type ShadowProxy } from './sun-shadow.ts'
import { EDGE_KEEP, EDGE_MAX_DARK, chunkEdgesSteps, combineShade, edgeKey, type EdgeSettings } from './edges.ts'
import type { SlopesInfo } from './slopes.ts'

export class SunChunk {
  readonly image: Phaser.GameObjects.Image
  private texture: Phaser.Textures.CanvasTexture
  private data: ImageData
  private work: Generator<void, { map: SunMap; dark: Float32Array | null; px: Uint8ClampedArray | null; rim: Uint8ClampedArray | null }> | null = null
  revision = ''
  map: SunMap | null = null
  /** Still casters' shadow darkness, one cell a world pixel (null: none drawn). */
  dark: Float32Array | null = null
  /** Those shadows, multiplied over the ground and light, under every sprite. */
  readonly shade: Phaser.GameObjects.Image
  private shadeTexture: Phaser.Textures.CanvasTexture
  private shadeData: ImageData
  private cost = 0
  /** 2e: this chunk's edge amounts, kept across sun changes (they're the field's), and the rim's additive image. */
  edges: { key: string; dark: Float32Array; rim: Float32Array; edges: number } | null = null
  readonly rim: Phaser.GameObjects.Image
  private rimTexture: Phaser.Textures.CanvasTexture
  private rimData: ImageData
  constructor(private scene: Phaser.Scene, private key: string, readonly x: number, readonly y: number, readonly width: number, readonly height: number) {
    // Half-texel alignment: maps sample the boundary itself. Crop off the
    // halo in world space, so multiply overlays never overlap at seams.
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(width / SUN_RES) + 3
    canvas.height = Math.ceil(height / SUN_RES) + 3
    this.texture = scene.textures.addCanvas(key, canvas)!
    this.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
    this.data = new ImageData(canvas.width, canvas.height)
    const ctx = this.texture.context
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); this.texture.refresh(); this.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
    this.image = scene.add.image(x - SUN_RES * 1.5, y - SUN_RES * 1.5, key).setOrigin(0).setScale(SUN_RES).setDepth(-999_000).setBlendMode(Phaser.BlendModes.MULTIPLY)
    // Geometry mask clips only this light image to its chunk.
    const clip = scene.make.graphics({ x: 0, y: 0 }).fillStyle(0xffffff).fillRect(x, y, width, height)
    const mask = clip.createGeometryMask()
    this.image.setMask(mask)
    this.image.once('destroy', () => { mask.destroy(); clip.destroy() })
    const shade = document.createElement('canvas'); shade.width = width; shade.height = height
    if (scene.textures.exists(`${key}-shade`)) scene.textures.remove(`${key}-shade`)
    this.shadeTexture = scene.textures.addCanvas(`${key}-shade`, shade)!
    this.shadeTexture.setFilter(Phaser.Textures.FilterMode.NEAREST)
    this.shadeData = new ImageData(width, height)
    this.shade = scene.add.image(x, y, `${key}-shade`).setOrigin(0).setDepth(-998_990).setBlendMode(Phaser.BlendModes.MULTIPLY).setVisible(false)
    const rim = document.createElement('canvas'); rim.width = width; rim.height = height
    if (scene.textures.exists(`${key}-rim`)) scene.textures.remove(`${key}-rim`)
    this.rimTexture = scene.textures.addCanvas(`${key}-rim`, rim)!
    this.rimTexture.setFilter(Phaser.Textures.FilterMode.NEAREST)
    this.rimData = new ImageData(width, height)
    this.rim = scene.add.image(x, y, `${key}-rim`).setOrigin(0).setDepth(-998_985).setBlendMode(Phaser.BlendModes.ADD).setVisible(false)
  }
  /** `casters` (still trees and rocks that can reach this chunk) is read
   * once the light is done; null draws no still shadows. */
  start(info: SlopesInfo, sun: DaySun, strength: number, enabled: boolean, revision: string, casters: (() => readonly Caster[]) | null = null, edges: EdgeSettings | null = null): void {
    this.revision = revision
    this.cost = 0
    const { x, y, width, height } = this
    const chunk = this
    this.work = (function* () {
      const map = yield* buildSunMap(info, x, y, width, height, sun, strength, enabled)
      // Edges are the field's: worked out once per setting, not per sun.
      const on = !!edges && edges.strength > 0
      if (on && chunk.edges?.key !== edgeKey(edges)) {
        chunk.edges = { key: edgeKey(edges), ...(yield* chunkEdgesSteps(info, x, y, width, height, edges)) }
      }
      const layer = casters && enabled ? yield* buildShadowLayer(map, x, y, width, height, casters(), strength, sun.daylight) : null
      if (!on) return { map, dark: layer?.dark ?? null, px: layer?.px ?? null, rim: null }
      // Edge bands over the casts, capped; weaker in terrain shade (the sun already darkens it there).
      const e = chunk.edges!
      const px = new Uint8ClampedArray(width * height * 4).fill(255)
      const rim = new Uint8ClampedArray(width * height * 4)
      const dark = layer?.dark
      const lit = enabled && sun.daylight > 0
      let rims = false
      for (let i = 0; i < width * height; i++) {
        const lx = i % width, ly = (i - lx) / width
        const ed = Math.min(EDGE_MAX_DARK, e.dark[i]! * edges.strength)
        const cd = dark ? dark[i]! : 0
        if (ed > 0 || cd > 0) {
          const vis = ed > 0 && lit ? (sampleVisibility(map, x + lx + 0.5, y + ly + 0.5) >= dither(x + lx, y + ly) ? 1 : 0) : 1
          for (let c = 0; c < 3; c++) px[i * 4 + c] = combineShade(1 - cd * SHADOW_KEEP[c]!, ed * EDGE_KEEP[c]!, vis) * 255
        }
        const r = e.rim[i]! * edges.strength * (1 - cd)
        if (r > 0) { rims = true; rim[i * 4] = r * 255; rim[i * 4 + 1] = r * 245; rim[i * 4 + 2] = r * 210; rim[i * 4 + 3] = 255 }
        if ((i + 1) % (width * 64) === 0) yield
      }
      return { map, dark: dark ?? null, px, rim: rims ? rim : null }
    })()
  }
  /** A few rows per step; returns the complete chunk's CPU+upload cost. */
  step(): number | null {
    if (!this.work) return null
    const t = performance.now(), next = this.work.next()
    this.cost += performance.now() - t
    if (!next.done) return null
    const upload = performance.now()
    this.map = next.value.map
    this.data.data.set(next.value.map.px)
    this.texture.context.putImageData(this.data, 0, 0)
    this.texture.refresh(); this.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
    this.dark = next.value.dark
    if (next.value.px) {
      this.shadeData.data.set(next.value.px)
      this.shadeTexture.context.putImageData(this.shadeData, 0, 0)
      this.shadeTexture.refresh(); this.shadeTexture.setFilter(Phaser.Textures.FilterMode.NEAREST)
    }
    this.shade.setVisible(!!next.value.px)
    if (next.value.rim) {
      this.rimData.data.set(next.value.rim)
      this.rimTexture.context.putImageData(this.rimData, 0, 0)
      this.rimTexture.refresh(); this.rimTexture.setFilter(Phaser.Textures.FilterMode.NEAREST)
    }
    this.rim.setVisible(!!next.value.rim)
    this.cost += performance.now() - upload
    this.work = null
    return this.cost
  }
  get pending(): boolean { return this.work !== null }
  /** Still-shadow darkness at a world pixel (0 outside or before it's drawn). */
  darkAt(wx: number, wy: number): number {
    const lx = Math.floor(wx) - this.x, ly = Math.floor(wy) - this.y
    return this.dark && lx >= 0 && ly >= 0 && lx < this.width && ly < this.height ? this.dark[ly * this.width + lx]! : 0
  }
  destroy(): void { this.image.destroy(); this.shade.destroy(); this.rim.destroy(); this.scene.textures.remove(this.key); this.scene.textures.remove(`${this.key}-shade`); this.scene.textures.remove(`${this.key}-rim`) }
}

/** Shadow proxies, made once per atlas frame, kind and scale (like masks). */
const proxyCaches = new WeakMap<Phaser.Textures.TextureManager, Map<string, ShadowProxy>>()
export function frameProxy(scene: Phaser.Scene, texture: string, frameName: string | number | undefined, kind: CasterKind, scale = 1): ShadowProxy {
  let cache = proxyCaches.get(scene.textures)
  if (!cache) { cache = new Map(); proxyCaches.set(scene.textures, cache) }
  const frame = scene.textures.getFrame(texture, frameName), key = `${texture}-${frame.name}-${kind}-${scale.toFixed(4)}`
  const old = cache.get(key)
  if (old) return old
  const canvas = document.createElement('canvas'); canvas.width = frame.cutWidth; canvas.height = frame.cutHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(frame.source.image as CanvasImageSource, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight, 0, 0, canvas.width, canvas.height)
  const proxy = casterProxy(kind, ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, scale)
  cache.set(key, proxy)
  return proxy
}

/** A walking caster's shadow: a small canvas redrawn only when its pixel
 * position, the light, or the still shadows under it change. */
export class MoverShadow {
  readonly image: Phaser.GameObjects.Image
  private texture: Phaser.Textures.CanvasTexture
  private data: ImageData
  private drawn = ''
  static readonly SIZE = 192
  constructor(private scene: Phaser.Scene, private key: string) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = MoverShadow.SIZE
    if (scene.textures.exists(key)) scene.textures.remove(key)
    this.texture = scene.textures.addCanvas(key, canvas)!
    this.texture.setFilter(Phaser.Textures.FilterMode.NEAREST)
    this.data = new ImageData(MoverShadow.SIZE, MoverShadow.SIZE)
    this.image = scene.add.image(0, 0, key).setOrigin(0).setDepth(-998_980).setBlendMode(Phaser.BlendModes.MULTIPLY).setVisible(false)
  }
  /** `multiply(wx, wy)` gives each pixel's RGB multiplier, or null for none. */
  draw(stamp: string, x0: number, y0: number, w: number, h: number, multiply: (wx: number, wy: number) => readonly [number, number, number] | null): void {
    this.image.setVisible(true)
    if (stamp === this.drawn) return
    this.drawn = stamp
    const S = MoverShadow.SIZE, px = this.data.data
    px.fill(255)
    // A body's longest (capped) shadow fits; anything past the canvas is cut.
    for (let iy = 0; iy < Math.min(h, S); iy++) for (let ix = 0; ix < Math.min(w, S); ix++) {
      const m = multiply(x0 + ix, y0 + iy)
      if (!m) continue
      const i = (iy * S + ix) * 4
      px[i] = m[0] * 255; px[i + 1] = m[1] * 255; px[i + 2] = m[2] * 255
    }
    this.texture.context.putImageData(this.data, 0, 0)
    this.texture.refresh(); this.texture.setFilter(Phaser.Textures.FilterMode.NEAREST)
    this.image.setPosition(x0, y0)
  }
  hide(): void { this.image.setVisible(false) }
  destroy(): void { this.image.destroy(); this.scene.textures.remove(this.key) }
}

/** Alpha masks are made once per atlas frame, shared by every caster and
 * across scene restarts, like the lab's other art textures. Sun scrubbing
 * only changes image transforms; no canvas work or texture uploads. */
interface Mask { key: string; x: number; y: number; w: number; h: number; frameW: number; frameH: number }
const maskCaches = new WeakMap<Phaser.Textures.TextureManager, Map<string, Mask>>()
function silhouetteMask(scene: Phaser.Scene, body: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite): Mask {
  let cache = maskCaches.get(scene.textures)
  if (!cache) { cache = new Map(); maskCaches.set(scene.textures, cache) }
  const frame = body.frame, key = `hl-sun-mask-${body.texture.key}-${frame.name}`
  const old = cache.get(key)
  if (old && scene.textures.exists(key)) return old
  const full = document.createElement('canvas'); full.width = frame.cutWidth; full.height = frame.cutHeight
  const source = full.getContext('2d', { willReadFrequently: true })!
  source.drawImage(frame.source.image as CanvasImageSource, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight, 0, 0, full.width, full.height)
  const bounds = silhouetteBounds(source.getImageData(0, 0, full.width, full.height).data, full.width, full.height)
  const canvas = document.createElement('canvas'); canvas.width = bounds.w + 4; canvas.height = bounds.h + 4
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(full, bounds.x, bounds.y, bounds.w, bounds.h, 2, 2, bounds.w, bounds.h)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = '#191b26'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = 'source-over'
  const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height
  copy.getContext('2d')!.drawImage(canvas, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.filter = 'blur(0.6px)'; ctx.drawImage(copy, 0, 0); ctx.filter = 'none'
  scene.textures.addCanvas(key, canvas)!.setFilter(Phaser.Textures.FilterMode.LINEAR)
  const mask = { key, ...bounds, frameW: full.width, frameH: full.height }
  cache.set(key, mask)
  return mask
}

export class SilhouetteShadow {
  readonly image: Phaser.GameObjects.Image
  constructor(private scene: Phaser.Scene, x: number, y: number) {
    this.image = scene.add.image(x, y, '__WHITE').setOrigin(0.5, 1)
  }
  project(body: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite, dx: number, dy: number): void {
    const mask = silhouetteMask(this.scene, body)
    if (this.image.texture.key !== mask.key) this.image.setTexture(mask.key)
    const length = Math.hypot(dx, dy)
    // This is silhouetteTransform's affine matrix: width perpendicular to
    // the ray, source height flattened away from the foot. The negative Y
    // scale puts the upside-down alpha mask onto the receiving plane.
    const sx = body.displayWidth / mask.frameW, sy = body.displayHeight / mask.frameH
    const footY = body.y + (mask.y + mask.h - mask.frameH * body.originY) * sy
    // Crop padding before projection and move the pivot to the visible foot.
    // Origin X retains the source frame's centre even for asymmetric poses.
    const originX = (mask.frameW * .5 - mask.x + 2) / (mask.w + 4)
    this.image.setOrigin(body.flipX ? 1 - originX : originX, (mask.h + 2) / (mask.h + 4))
      .setPosition(body.x, footY).setRotation(length ? Math.atan2(-dx, dy) : 0)
      .setScale(sx, -Math.max(2, length) / mask.h).setFlipX(body.flipX)
  }
  destroy(): void { this.image.destroy() }
}
