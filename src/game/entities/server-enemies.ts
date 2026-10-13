/** Rendering owner for every generated camp's enemies (shared-fights.md 1.8).
 * All fight state belongs to the feed; physics bodies are disabled and act never
 * simulates a server enemy. Each enemy life (FightDraw.life) is one sprite: a
 * resync keeps it, a spawn or a cycle's respawn draws a new one, and a death
 * plays only on the room's death event. */
import type { Enemy, EnemyOwner, EnemySystem } from './enemies.ts'
import type { PresenceFeed } from '../presence-feed.ts'
import { presence } from '../presence.ts'
import { fightFacingFromStep, fightWindupTicks } from '../../lib/fight-math.ts'
import { KNOCK, knockFrom } from './fight-rules.ts'
import type { FightDraw } from '../../lib/fight-interp.ts'
import type { FightEvent } from '../../lib/gen/glimway/v2/presence_pb.js'
import { perfFights } from '../perf.ts'

type RenderedEnemy = { enemy: Enemy; draw: FightDraw; tell: number; lock: number; stoppedUntil: number; stopTick: number; hitUntil: number }
/** Where a parked enemy stands (dev playtests: EnemySystem.parkAll). */
const PARKED = -2000
const phases = ['chase', 'chase', 'telegraph', 'lunge', 'recover', 'stunned', 'recover'] as const
/** Each kind's held pose outside a wind-up, as its local behaviour draws it (./creatures.ts). */
const POSES = {
  wisp: { chase: 'idle', lunge: 'idle', recover: 'squash', stunned: 'squash' },
  beetle: { chase: 'idle', lunge: 'squash', recover: 'idle', stunned: 'hurt' }
} as const
export class ServerEnemies {
  private drawn = new Map<number, RenderedEnemy>()
  private readonly system: EnemySystem
  readonly owner: EnemyOwner = {
    observe: () => {}, act: () => {},
    struck: (enemy, _hit, fromX) => {
      const entry = [...this.drawn.values()].find(e => e.enemy === enemy)
      if (entry) entry.hitUntil = this.system.scene.time.now + 90
      const hero = this.system.deps.hero()
      const shove = knockFrom(enemy, fromX, { y: hero.sprite.y, facing: hero.facing })
      if (shove && enemy.fight) this.feed()?.fights.knock(enemy.fight, shove.x * KNOCK.time, shove.y * KNOCK.time)
    },
    stopped: (enemy, seconds) => {
      const entry = [...this.drawn.values()].find(e => e.enemy === enemy)
      // Predicted Stand pose only (the room staggers it). Never change phase, timer, lunge or damage.
      if (entry && entry.stopTick !== entry.draw.row.stateTick) {
        entry.stopTick = entry.draw.row.stateTick
        entry.stoppedUntil = this.system.scene.time.now + seconds * 1000
        this.system.deps?.fx?.floatText(enemy.x, enemy.y - 18, 'Staggered', '#e8d8b0', false)
      }
    }
  }
  private readonly feed: () => Pick<PresenceFeed, 'fights'> | null
  constructor(system: EnemySystem, feed: () => Pick<PresenceFeed, 'fights'> | null = presence) { this.system = system; this.feed = feed }

  observe(): void {
    const feed = this.feed()
    if (!feed) { this.clear(); return }
    const events = feed.fights.observe()
    // Close/removal has already been applied by the pure observation model.
    const rows = feed.fights.draw()
    const seen = new Set<number>()
    for (const draw of rows) {
      const row = draw.row, key = draw.life
      seen.add(key)
      let entry = this.drawn.get(key)
      if (!entry) {
        if (row.state === 6) continue // corpses (a fresh join, a fallen camp's wake) have already died
        const enemy = this.system.spawnWilds(row.id, row.kind === 2 ? 'beetle' : 'wisp', 0, 0, false)
        Object.defineProperty(enemy, 'maxHp', { value: row.maxHp })
        enemy.owner = this.owner; enemy.fight = { room: draw.room, enemy: row.enemy }
        ;(enemy.sprite.body as { enable: boolean }).enable = false
        if (this.system.parkedAll) { enemy.parked = true; enemy.sprite.setVisible(false) }
        entry = { enemy, draw, tell: -1, lock: -1, stoppedUntil: 0, stopTick: -1, hitUntil: 0 }
        const retained = entry
        // Parked (dev only): it stands off the map for everything here (targets, contact, bolts), while its room goes on.
        Object.defineProperties(enemy, { x: { get: () => retained.enemy.parked ? PARKED : retained.draw.x }, y: { get: () => retained.enemy.parked ? PARKED : retained.draw.y } })
        this.drawn.set(key, entry)
      }
      entry.draw = draw
      const enemy = entry.enemy
      enemy.fight = { room: draw.room, enemy: row.enemy }
      if (enemy.dead) continue // leave the confirmed dissolve tween in charge
      if (enemy.parked) { enemy.hp = row.hp; enemy.state = phases[row.state] ?? 'chase'; enemy.sprite.setPosition(PARKED, PARKED).setVisible(false); continue }
      enemy.hp = row.hp
      enemy.state = phases[row.state] ?? 'chase'
      const dir = fightFacingFromStep(row.facing)
      enemy.dirX = dir.x; enemy.dirY = dir.y
      enemy.sprite.setPosition(draw.x, draw.y).setDepth(draw.y).setFlipX(dir.x < 0)
      this.pose(entry)
    }
    for (const { event, elapsedMs } of events) this.event(event, elapsedMs)
    for (const [key, entry] of this.drawn) if (!seen.has(key)) {
      if (!entry.enemy.dead && entry.enemy.sprite.active) entry.enemy.sprite.destroy()
      this.system.forget(entry.enemy); this.drawn.delete(key)
    }
    perfFights(feed.fights)
  }

  private pose(entry: RenderedEnemy): void {
    const { enemy, draw } = entry
    if (enemy.dead) return
    if (this.system.scene.time.now < entry.stoppedUntil) { this.system.setEnemyPose(enemy, enemy.type === 'beetle' ? 'hurt' : 'squash'); return }
    const duration = fightWindupTicks(enemy.type === 'beetle' ? 'beetle' : 'wisp')
    const elapsed = draw.telegraphMs ?? draw.elapsedMs
    const start = draw.telegraphTick ?? draw.row.stateTick
    if (enemy.state === 'telegraph' || (draw.telegraphMs !== undefined && elapsed < duration.launch * 100)) {
      const remaining = Math.max(0, duration.launch * 100 - elapsed)
      if (entry.tell !== start) {
        entry.tell = start
        if (remaining) this.system.telegraph(enemy, remaining / 1000)
      }
      this.system.setEnemyPose(enemy, 'windup')
      if ((draw.aimLocked || elapsed >= duration.lock * 100) && entry.lock !== start) {
        this.lock(entry, start)
      }
    } else {
      if (this.system.scene.time.now >= entry.hitUntil) enemy.sprite.clearTint()
      const poses = enemy.type === 'beetle' ? POSES.beetle : POSES.wisp
      this.system.setEnemyPose(enemy, enemy.state === 'sweep' ? 'idle' : poses[enemy.state])
    }
  }
  private event(event: Omit<FightEvent, '$typeName' | '$unknown'>, elapsed: number): void {
    // The newest life at that index: a removed row's corpse may still be leaving.
    let entry: RenderedEnemy | undefined
    for (const e of this.drawn.values()) if (e.draw.room === event.room && e.draw.row.enemy === event.enemy && (!entry || e.draw.life > entry.draw.life)) entry = e
    if (!entry) return
    if (entry.enemy.parked) {
      // Parked: the room's death still takes it off the list, silently; nothing else plays.
      if (event.kind === 3 && !entry.enemy.dead) { entry.enemy.dead = true; if (entry.enemy.sprite.active) entry.enemy.sprite.destroy(); this.system.forget(entry.enemy) }
      return
    }
    if (event.kind === 3) { this.die(entry); return }
    if (event.kind === 4 && !entry.enemy.dead) {
      const remaining = Math.max(0, 320 - elapsed)
      entry.enemy.sprite.setAlpha(Math.min(1, elapsed / 320))
      if (remaining) this.system.scene.tweens.add({ targets: entry.enemy.sprite, alpha: 1, duration: remaining })
    }
    // Late telegraphs use the server's start time, including sub-tick offset.
    if (event.kind === 1 && entry.tell !== event.tick) {
      entry.tell = event.tick
      const remaining = fightWindupTicks(entry.enemy.type === 'beetle' ? 'beetle' : 'wisp').launch * 100 - elapsed
      if (remaining > 0) this.system.telegraph(entry.enemy, remaining / 1000)
    }
    if (event.kind === 2) {
      const start = entry.draw.telegraphTick ?? entry.draw.row.stateTick
      if (entry.lock !== start) this.lock(entry, start)
    }
  }
  private lock(entry: RenderedEnemy, start: number): void {
    entry.lock = start
    entry.enemy.sprite.setTintFill(0xffffff)
    this.system.scene.time.delayedCall(70, () => {
      if (entry.lock === start && !entry.enemy.dead && entry.enemy.sprite.active && entry.enemy.state === 'telegraph') entry.enemy.sprite.setTint(0xffd0c0)
    })
  }
  private die(entry: { enemy: Enemy }): void {
    if (entry.enemy.dead) return
    entry.enemy.dead = true
    this.system.showDeath(entry.enemy)
  }
  private clear(): void {
    for (const entry of this.drawn.values()) {
      if (entry.enemy.sprite.active) entry.enemy.sprite.destroy()
      this.system.forget(entry.enemy)
    }
    this.drawn.clear()
  }
}
