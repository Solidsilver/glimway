/**
 * Shared impact feedback for entities: damage numbers and small callouts,
 * hit-stop frames, spark bursts, and the delivered one-shot effect
 * animations. Purely cosmetic — hit timing, reach and radii stay with the
 * callers and are never inferred from the effect art.
 */
import type Phaser from 'phaser'

export class Effects {
  constructor(private scene: Phaser.Scene, private reducedMotion: boolean) {}

  /** Damage numbers and small callouts, crisp at any zoom. */
  floatText(x: number, y: number, text: string, color: string, big: boolean): void {
    const t = this.scene.add.text(Math.round(x), Math.round(y), text, {
      fontFamily: '"Pixelify Sans", monospace',
      fontSize: big ? '10px' : '8px',
      color,
      stroke: '#2b1d1a',
      strokeThickness: 3,
      resolution: 8
    }).setOrigin(0.5, 1).setDepth(7000)
    if (this.reducedMotion) {
      this.scene.time.delayedCall(550, () => t.destroy())
      return
    }
    t.setScale(big ? 1.5 : 1.2)
    this.scene.tweens.add({ targets: t, scale: 1, duration: 120, ease: 'Back.easeOut' })
    this.scene.tweens.add({ targets: t, y: y - 14, alpha: 0, delay: 220, duration: 520, ease: 'Quad.easeOut', onComplete: () => t.destroy() })
  }

  /** A few frames of freeze on impact so hits land with weight. */
  hitStop(ms: number): void {
    if (this.reducedMotion || this.scene.physics.world.isPaused) return
    this.scene.physics.world.pause()
    this.scene.time.delayedCall(ms, () => this.scene.physics.world.resume())
  }

  sparkBurst(x: number, y: number, count: number): void {
    const particles = this.scene.add.particles(x, y, 'spark', {
      speed: { min: 30, max: 90 },
      lifespan: 380,
      scale: { start: 1, end: 0 },
      emitting: false
    })
    particles.explode(count)
    this.scene.time.delayedCall(620, () => particles.destroy())
  }

  /** True when the delivered runtime-pass effect animation is available. */
  effectReady(texture: string, anim: string): boolean {
    return this.scene.textures.exists(texture) && this.scene.anims.exists(anim)
  }

  /**
   * One-shot delivered effect: plays its manifest animation centered on
   * (x, y), rotated to the given angle (native art faces right), and destroys
   * the sprite when done. Purely cosmetic — hit timing, reach, and radii stay
   * code-authored and are never inferred from the effect art.
   * Returns false when the pack is absent so callers can fall back.
   */
  playEffect(anim: string, texture: string, x: number, y: number, depth: number, angle?: number): boolean {
    if (!this.effectReady(texture, anim)) return false
    const fx = this.scene.add.sprite(x, y, texture).setDepth(depth)
    fx.play(anim)
    if (angle !== undefined) fx.setRotation(angle)
    fx.once('animationcomplete', () => fx.destroy())
    return true
  }
}
