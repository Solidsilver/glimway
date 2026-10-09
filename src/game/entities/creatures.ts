/**
 * The creatures' behaviour each frame: wisps hop at you, beetles keep their
 * distance and charge, and both wander home when you're out of sight. Every
 * attack is telegraphed (./enemies.ts setEnemyPose, telegraph).
 */
import Phaser from 'phaser'
import { sfx } from '../sfx'
import { ENEMY_TUNING, type Enemy, type EnemyDeps, type EnemySystem } from './enemies'
import type { CombatField } from '../../lib/combat-moves'

export class Creatures {
  private readonly scene: Phaser.Scene
  private readonly deps: EnemyDeps

  constructor(private readonly sys: EnemySystem) {
    this.scene = sys.scene
    this.deps = sys.deps
  }

  /** Idle wandering near home, used by small enemies out of aggro range. */
  private wander(enemy: Enemy, dt: number, speed: number): void {
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.wanderTimer -= dt
    if (enemy.wanderTimer <= 0) {
      enemy.wanderTimer = 1 + Math.random() * 1.6
      const angle = Math.random() * Math.PI * 2
      enemy.dirX = Math.cos(angle)
      enemy.dirY = Math.sin(angle)
    }
    const blocked = body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down
    const home = new Phaser.Math.Vector2(enemy.homeX - enemy.sprite.x, enemy.homeY - enemy.sprite.y)
    if (blocked && enemy.detourTimer <= 0) {
      // Walking into a tree (now that enemies collide): slide sideways for a
      // moment instead of pushing into it forever.
      const side = home.lengthSq() > 0.01 ? home.clone().normalize() : new Phaser.Math.Vector2(enemy.dirX, enemy.dirY)
      const sign = Math.random() < 0.5 ? 1 : -1
      enemy.dirX = -side.y * sign
      enemy.dirY = side.x * sign
      enemy.detourTimer = 0.6
    }
    enemy.detourTimer = Math.max(0, enemy.detourTimer - dt)
    body.setVelocity(enemy.dirX * speed, enemy.dirY * speed)
    if (home.length() > 90 && enemy.detourTimer <= 0) body.setVelocity(home.x * 0.5, home.y * 0.5)
    if (Math.abs(enemy.dirX) > 0.2) enemy.sprite.setFlipX(enemy.dirX < 0)
  }

  /**
   * Kindle (crafts.md 4.3): inside a patch of hollow light a creature moves
   * at the patch's `slow` of whatever speed it just set — walking, hopping,
   * charging or being knocked back alike. Called right after the velocity
   * is set. Never the Warden.
   */
  slowIn(enemy: Enemy, field: CombatField | undefined): void {
    if (!field || enemy.type === 'guardian') return
    const k = field.slowAt(enemy.sprite.x, enemy.sprite.y)
    if (k < 1) (enemy.sprite.body as Phaser.Physics.Arcade.Body).velocity.scale(k)
  }

  /**
   * Slimes and mushrooms: shuffle closer, then a telegraphed hop at where
   * you stood when the windup ended. Step aside (or roll) and it lands short.
   */
  updateHopper(enemy: Enemy, dt: number, dist: number, px: number, py: number): void {
    const t = ENEMY_TUNING.wisp
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.attackTimer -= dt
    enemy.stateTimer -= dt
    switch (enemy.state) {
      case 'chase': {
        if (dist >= t.aggro) {
          this.wander(enemy, dt, 26)
          break
        }
        const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
        if (dist > t.hopRange * 0.7) body.setVelocity(dir.x * t.chase, dir.y * t.chase)
        else body.setVelocity(0, 0)
        if (Math.abs(dir.x) > 0.2) enemy.sprite.setFlipX(dir.x < 0)
        if (enemy.attackTimer <= 0 && dist < t.hopRange) {
          enemy.state = 'telegraph'
          enemy.stateTimer = t.windup
          enemy.lungeX = 0
          enemy.lungeY = 0
          body.setVelocity(0, 0)
          this.sys.telegraph(enemy, t.windup)
        }
        break
      }
      case 'telegraph': {
        body.setVelocity(0, 0)
        this.sys.lockAim(enemy, t.lock, t.hopSpeed, px, py)
        if (enemy.stateTimer <= 0) {
          // A shove can skip the lock frame; never launch without an aim.
          this.sys.lockAim(enemy, Infinity, t.hopSpeed, px, py)
          enemy.state = 'lunge'
          enemy.stateTimer = t.hopTime
          enemy.sprite.clearTint()
          this.sys.setEnemyPose(enemy, 'idle')
          if (!this.deps.reducedMotion) {
            this.scene.tweens.add({ targets: enemy.sprite, scaleY: enemy.sprite.scaleY * 1.25, scaleX: enemy.sprite.scaleX * 0.85, duration: t.hopTime * 500, yoyo: true })
          }
        }
        break
      }
      case 'lunge': {
        body.setVelocity(enemy.lungeX, enemy.lungeY)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'recover'
          enemy.stateTimer = t.recover
          body.setVelocity(0, 0)
          this.sys.setEnemyPose(enemy, 'squash')
        }
        break
      }
      default: {
        // recover: squashed and open for a moment after landing.
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'chase'
          enemy.attackTimer = t.cooldown * (0.8 + Math.random() * 0.5)
          this.sys.setEnemyPose(enemy, 'idle')
        }
      }
    }
  }

  /**
   * Beetles: plod toward you, paw the ground, then charge in a straight line
   * locked at the end of the windup. A charge that hits a tree or wall leaves
   * the beetle dazed and taking extra damage.
   */
  updateBeetle(enemy: Enemy, dt: number, dist: number, px: number, py: number): void {
    const t = ENEMY_TUNING.beetle
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.attackTimer -= dt
    enemy.stateTimer -= dt
    switch (enemy.state) {
      case 'chase': {
        if (dist >= t.aggro) {
          this.wander(enemy, dt, 18)
          break
        }
        const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
        // Keep a charging distance: approach from afar, back off up close.
        if (dist > t.keepAway + 16) body.setVelocity(dir.x * t.walk, dir.y * t.walk)
        else if (dist < t.keepAway - 16) body.setVelocity(-dir.x * t.walk * 0.7, -dir.y * t.walk * 0.7)
        else body.setVelocity(0, 0)
        if (Math.abs(dir.x) > 0.2) enemy.sprite.setFlipX(dir.x < 0)
        if (enemy.attackTimer <= 0 && dist < t.chargeRange) {
          enemy.state = 'telegraph'
          enemy.stateTimer = t.windup
          enemy.lungeX = 0
          enemy.lungeY = 0
          body.setVelocity(0, 0)
          this.sys.telegraph(enemy, t.windup)
        }
        break
      }
      case 'telegraph': {
        body.setVelocity(0, 0)
        if (enemy.lungeX === 0 && enemy.lungeY === 0) {
          const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y)
          if (Math.abs(dir.x) > 4) enemy.sprite.setFlipX(dir.x < 0)
        }
        this.sys.lockAim(enemy, t.lock, t.chargeSpeed, px, py)
        if (enemy.stateTimer <= 0) {
          this.sys.lockAim(enemy, Infinity, t.chargeSpeed, px, py)
          enemy.state = 'lunge'
          enemy.stateTimer = t.chargeTime
          enemy.sprite.clearTint()
          this.sys.setEnemyPose(enemy, 'squash')
          sfx('swing')
        }
        break
      }
      case 'lunge': {
        body.setVelocity(enemy.lungeX, enemy.lungeY)
        const crashed = body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down
        if (crashed) {
          enemy.state = 'stunned'
          enemy.stateTimer = t.stun
          body.setVelocity(0, 0)
          this.sys.setEnemyPose(enemy, 'hurt')
          sfx('hit')
          if (!this.deps.reducedMotion) this.scene.cameras.main.shake(90, 0.004)
          this.deps.fx.floatText(enemy.sprite.x, enemy.sprite.y - 18, 'Dazed!', '#ffe08a', false)
          this.deps.fx.sparkBurst(enemy.sprite.x, enemy.sprite.y - 8, 6)
        } else if (enemy.stateTimer <= 0) {
          enemy.state = 'recover'
          enemy.stateTimer = t.recover
          body.setVelocity(0, 0)
          this.sys.setEnemyPose(enemy, 'idle')
        }
        break
      }
      case 'stunned': {
        body.setVelocity(0, 0)
        if (!this.deps.reducedMotion) enemy.sprite.setAngle(Math.sin(enemy.stateTimer * 30) * 6)
        if (enemy.stateTimer <= 0) {
          enemy.sprite.setAngle(0)
          enemy.state = 'chase'
          enemy.attackTimer = t.cooldown
          this.sys.setEnemyPose(enemy, 'idle')
        }
        break
      }
      default: {
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'chase'
          enemy.attackTimer = t.cooldown * (0.8 + Math.random() * 0.4)
        }
      }
    }
  }

}
