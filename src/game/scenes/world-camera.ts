/**
 * The world camera's zoom and framing: how many world pixels a screen
 * pixel shows, and the bounds and follow offset that keep the hero clear of
 * the interface (src/game/viewport.ts), with a soft fade where the map ends.
 */
import Phaser from 'phaser'
import { MAX_SCREEN_SCALE } from '../atlas-plan'
import { playInsets } from '../viewport'
import { TILE } from '../../lib/tile'
import type { WorldData } from '../worlds'

/**
 * World pixels to screen pixels. Phones show about 12 tiles across the
 * short side (390×844 and 844×390 both get 2×: one phone, one game,
 * whichever way it's held); from a 600 px short side up, the old rule
 * (the height over 280, in half steps) holds, and the tile count ramps
 * between the two so no size jumps.
 */
export function zoomFor(w: number, h: number): number {
  const short = Math.min(w, h)
  if (short >= 600) return Phaser.Math.Clamp(Math.round((h / 280) * 2) / 2, 1.5, MAX_SCREEN_SCALE)
  const tiles = 12 + (Phaser.Math.Clamp(short, 440, 600) - 440) * (5.5 / 160)
  return Phaser.Math.Clamp(Math.round((short / (tiles * TILE)) * 2) / 2, 1.5, MAX_SCREEN_SCALE)
}

export class WorldCamera {
  /** What the camera was last framed for (playInsets.rev, zoom, size). */
  private framedFor = ''
  private followOffset = { x: 0, y: 0 }
  private edgeFade: Phaser.GameObjects.Image[] = []

  constructor(
    private scene: Phaser.Scene,
    private world: WorldData
  ) {
    this.apply(scene.scale.width, scene.scale.height)
    const onResize = (size: Phaser.Structs.Size) => this.apply(size.width, size.height)
    scene.scale.on('resize', onResize)
    scene.events.once('shutdown', () => scene.scale.off('resize', onResize))
  }

  private apply(w: number, h: number): void {
    this.scene.cameras.main.setZoom(zoomFor(w, h))
    this.frameCamera()
  }

  /**
   * Fit the camera to the map and to the screen the interface leaves open
   * (src/game/viewport.ts): the bounds reach past each map edge by the
   * inset there, and the follow offset centres the hero in the open
   * rectangle. Near an edge the map scrolls a little into the backdrop and
   * the hero stays clear of the HUD and the thumbs. A map smaller than the
   * open rectangle (a cottage room) sits centred in it.
   */
  private frameCamera(): void {
    const cam = this.scene.cameras.main
    const z = cam.zoom
    const W = cam.width
    const H = cam.height
    this.framedFor = `${playInsets.rev}:${z}:${W}x${H}`
    // Leave at least 40% of the view open on each axis: past that, both
    // insets on the axis shrink in proportion.
    const fit = (a: number, b: number, view: number): [number, number] => {
      const k = Math.min(1, (view * 0.6) / Math.max(1, a + b))
      return [a * k, b * k]
    }
    const [left, right] = fit(playInsets.left, playInsets.right, W)
    const [top, bottom] = fit(playInsets.top, playInsets.bottom, H)
    const axis = (size: number, view: number, a: number, b: number): [number, number] => {
      const open = (view - a - b) / z
      if (size >= open) return [-a / z, size + (a + b) / z]
      return [-a / z - (open - size) / 2, view / z]
    }
    const [bx, bw] = axis(this.world.widthPx, W, left, right)
    const [by, bh] = axis(this.world.heightPx, H, top, bottom)
    cam.setBounds(bx, by, bw, bh)
    this.followOffset = { x: (left - right) / (2 * z), y: (top - bottom) / (2 * z) }
    cam.setFollowOffset(this.followOffset.x, this.followOffset.y)
    this.layEdgeFade(left || right || top || bottom ? 1 : 0)
  }

  /** Re-frame when the insets, the zoom or the size changed (cheap: one string compare a frame). */
  keepFramed(): void {
    const cam = this.scene.cameras.main
    if (this.framedFor !== `${playInsets.rev}:${cam.zoom}:${cam.width}x${cam.height}`) this.frameCamera()
    // startFollow elsewhere (placement, the lantern beat) resets the offset.
    else if (cam.followOffset.x !== this.followOffset.x || cam.followOffset.y !== this.followOffset.y) cam.setFollowOffset(this.followOffset.x, this.followOffset.y)
  }

  /**
   * A soft shadow just inside the map's edges, so where the camera shows the
   * backdrop past an edge the map ends in a fade, not a hard line.
   */
  private layEdgeFade(alpha: number): void {
    if (!this.scene.textures.exists('edge-fade')) {
      const t = this.scene.textures.createCanvas('edge-fade', 1, 16)!
      const ctx = t.getContext()
      const g = ctx.createLinearGradient(0, 0, 0, 16)
      g.addColorStop(0, 'rgba(36,31,49,0.6)')
      g.addColorStop(1, 'rgba(36,31,49,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 1, 16)
      t.refresh()
    }
    if (this.edgeFade.length === 0) {
      const mw = this.world.widthPx
      const mh = this.world.heightPx
      const D = 10
      const mk = (x: number, y: number, w: number, angle: number) =>
        this.scene.add.image(x, y, 'edge-fade').setOrigin(0.5, 0).setDisplaySize(w, D).setAngle(angle).setDepth(6000)
      this.edgeFade = [
        mk(mw / 2, 0, mw, 0), // top: dark at the edge, fading down
        mk(mw / 2, mh, mw, 180),
        mk(0, mh / 2, mh, -90),
        mk(mw, mh / 2, mh, 90)
      ]
    }
    for (const img of this.edgeFade) img.setAlpha(alpha)
  }
}
