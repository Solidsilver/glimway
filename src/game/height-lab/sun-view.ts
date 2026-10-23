/** Phaser adapter for the independent, cheap sun map and alpha silhouettes. */
import Phaser from 'phaser'
import { buildSunMap, SUN_RES, type SunMap } from './sun-map.ts'
import { type DaySun } from './sun.ts'
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

/** Alpha masks are made once per atlas frame, shared by every caster and
 * across scene restarts, like the lab's other art textures. Sun scrubbing
 * only changes image transforms; no canvas work or texture uploads. */
function silhouetteMask(scene: Phaser.Scene, body: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite): string {
  const frame = body.frame, key = `hl-sun-mask-${body.texture.key}-${frame.name}`
  if (scene.textures.exists(key)) return key
  const canvas = document.createElement('canvas')
  canvas.width = frame.cutWidth; canvas.height = frame.cutHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(frame.source.image as CanvasImageSource, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight, 0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = '#191b26'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = 'source-over'
  const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height
  copy.getContext('2d')!.drawImage(canvas, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.filter = 'blur(0.6px)'; ctx.drawImage(copy, 0, 0); ctx.filter = 'none'
  const texture = scene.textures.addCanvas(key, canvas)!
  texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
  return key
}

export class SilhouetteShadow {
  readonly image: Phaser.GameObjects.Image
  constructor(private scene: Phaser.Scene, x: number, y: number) {
    this.image = scene.add.image(x, y, '__WHITE').setOrigin(0.5, 1)
  }
  project(body: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite, dx: number, dy: number, x: number, y: number): void {
    const key = silhouetteMask(this.scene, body)
    if (this.image.texture.key !== key) this.image.setTexture(key)
    const length = Math.hypot(dx, dy)
    // This is silhouetteTransform's affine matrix: width perpendicular to
    // the ray, source height flattened away from the foot. The negative Y
    // scale puts the upside-down alpha mask onto the receiving plane.
    this.image.setPosition(x, y).setRotation(length ? Math.atan2(-dx, dy) : 0)
      .setScale(body.displayWidth / this.image.width, -Math.max(2, length) / this.image.height).setFlipX(body.flipX)
  }
  destroy(): void { this.image.destroy() }
}
