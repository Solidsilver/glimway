/** Phaser adapter for the independent, cheap sun map and alpha silhouettes. */
import Phaser from 'phaser'
import { buildSunMap, SUN_RES, type SunMap } from './sun-map.ts'
import { silhouetteTransform, type DaySun } from './sun.ts'
import type { SlopesInfo } from './slopes.ts'

export class SunChunk {
  readonly image: Phaser.GameObjects.Image
  private texture: Phaser.Textures.CanvasTexture
  private data: ImageData
  private work: Generator<void, SunMap> | null = null
  revision = ''
  map: SunMap | null = null
  private cost = 0
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
  }
  start(info: SlopesInfo, sun: DaySun, strength: number, enabled: boolean, revision: string): void {
    this.revision = revision
    this.cost = 0
    this.work = buildSunMap(info, this.x, this.y, this.width, this.height, sun, strength, enabled)
  }
  /** A few rows per step; returns the complete chunk's CPU+upload cost. */
  step(): number | null {
    if (!this.work) return null
    const t = performance.now(), next = this.work.next()
    this.cost += performance.now() - t
    if (!next.done) return null
    const upload = performance.now()
    this.map = next.value
    this.data.data.set(next.value.px)
    this.texture.context.putImageData(this.data, 0, 0)
    this.texture.refresh(); this.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
    this.cost += performance.now() - upload
    this.work = null
    return this.cost
  }
  get pending(): boolean { return this.work !== null }
  destroy(): void { this.image.destroy(); this.scene.textures.remove(this.key) }
}

let shadowId = 0
/** One texture per caster, reused as the sun or its animation changes. The
 * source frame's alpha (not its colour) makes one soft dark silhouette. */
export class SilhouetteShadow {
  readonly image: Phaser.GameObjects.Image
  private key = `hl-silhouette-${shadowId++}`
  private texture: Phaser.Textures.CanvasTexture
  private signature = ''
  private offsetX = 0
  private offsetY = 0
  constructor(private scene: Phaser.Scene, x: number, y: number) {
    const c = document.createElement('canvas'); c.width = c.height = 1
    this.texture = scene.textures.addCanvas(this.key, c)!
    this.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
    this.image = scene.add.image(x, y, this.key).setOrigin(0)
  }
  project(body: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite, dx: number, dy: number, x: number, y: number): void {
    dx = Math.round(dx * 4) / 4; dy = Math.round(dy * 4) / 4
    const w = Math.max(1, Math.round(body.displayWidth)), h = Math.max(1, Math.round(body.displayHeight))
    const signature = `${body.texture.key}:${body.frame.name}:${body.flipX}:${w}:${h}:${dx}:${dy}`
    if (this.signature !== signature) {
      this.signature = signature
      const m = silhouetteTransform(w, h, dx, dy)
      const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([u, v]) => [m.a * u! + m.c * v! + m.e, m.b * u! + m.d * v! + m.f])
      const minX = Math.floor(Math.min(...corners.map(p => p[0]!))) - 2, minY = Math.floor(Math.min(...corners.map(p => p[1]!))) - 2
      const maxX = Math.ceil(Math.max(...corners.map(p => p[0]!))) + 2, maxY = Math.ceil(Math.max(...corners.map(p => p[1]!))) + 2
      this.offsetX = minX; this.offsetY = minY
      this.texture.setSize(maxX - minX, maxY - minY)
      const ctx = this.texture.context, frame = body.frame
      ctx.clearRect(0, 0, this.texture.width, this.texture.height)
      ctx.save()
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e - minX, m.f - minY)
      if (body.flipX) { ctx.translate(w, 0); ctx.scale(-1, 1) }
      ctx.drawImage(frame.source.image as CanvasImageSource, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight, 0, 0, w, h)
      ctx.restore()
      ctx.globalCompositeOperation = 'source-in'
      ctx.fillStyle = '#191b26'; ctx.fillRect(0, 0, this.texture.width, this.texture.height)
      ctx.globalCompositeOperation = 'source-over'
      // A small, uniform soft edge without changing the silhouette's shape.
      const copy = document.createElement('canvas'); copy.width = this.texture.width; copy.height = this.texture.height
      copy.getContext('2d')!.drawImage(this.texture.canvas, 0, 0)
      ctx.clearRect(0, 0, copy.width, copy.height)
      ctx.filter = 'blur(0.6px)'; ctx.drawImage(copy, 0, 0); ctx.filter = 'none'
      this.texture.refresh(); this.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
      this.image.setTexture(this.key)
    }
    this.image.setPosition(x + this.offsetX, y + this.offsetY)
  }
  destroy(): void { this.image.destroy(); this.scene.textures.remove(this.key) }
}
