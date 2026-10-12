/**
 * Projectiles: the mage bolt group (basic and signature share it), its
 * in-flight flicker animation, and the per-frame hit/expiry sweep.
 */
import { COMBAT_TUNING } from '../../lib/combat-timing'
import type Phaser from 'phaser'
import type { Effects } from './fx'
import type { EnemySystem } from './enemies'
import { boltReaches } from './fight-rules'

export class Projectiles {
  private group: Phaser.Physics.Arcade.Group

  constructor(scene: Phaser.Scene, private fx: Effects, private enemies: () => EnemySystem) {
    this.group = scene.physics.add.group()
  }

  /** Live bolt count (diagnostics read this between frames). */
  get length(): number {
    return this.group.getLength()
  }

  /**
   * Mage bolt (basic and signature share the projectile): delivered 8x8
   * flicker loop while in flight, rotated to the travel direction, destroyed
   * on hit/expiry by update. Falls back to the static aliased `bolt`.
   */
  spawn(x: number, y: number, dir: Phaser.Math.Vector2, damage: number): void {
    const animated = this.fx.effectReady('magic-bolt-0', 'effect-magic-bolt')
    const bolt = this.group.create(x, y, animated ? 'magic-bolt-0' : 'bolt') as Phaser.Physics.Arcade.Sprite
    bolt.setDepth(y + 1)
    if (animated) bolt.play('effect-magic-bolt')
    if (dir.x !== 0 || dir.y !== 0) bolt.setRotation(Math.atan2(dir.y, dir.x))
    bolt.setVelocity(dir.x * COMBAT_TUNING.attack.boltSpeed, dir.y * COMBAT_TUNING.attack.boltSpeed)
    bolt.setData('damage', damage)
    bolt.setData('life', COMBAT_TUNING.attack.boltLifetimeSeconds)
  }

  update(dt: number): void {
    for (const boltObj of [...this.group.getChildren()] as Phaser.Physics.Arcade.Sprite[]) {
      const life = (boltObj.getData('life') as number) - dt
      boltObj.setData('life', life)
      let hit = false
      for (const enemy of [...this.enemies().enemies]) {
        if (boltReaches(boltObj, enemy)) {
          this.enemies().damageEnemy(enemy, boltObj.getData('damage') as number, boltObj.x)
          hit = true
          break
        }
      }
      if (hit || life <= 0) boltObj.destroy()
    }
  }
}
