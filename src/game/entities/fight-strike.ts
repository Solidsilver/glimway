/** A basic server swing is selected, stamped, sent and predicted in one press.
 * Local enemies retain their animation's delayed landing decision in Hero. */
import { normalFacing } from '../../lib/presence-client.ts'
import { strikeHits, type Strike, type EnemyState, type StrikeHit } from './fight-rules.ts'
import type { FightTargetRef, FightSwingIntent } from '../../lib/presence.ts'
import type { FightInterp } from '../../lib/fight-interp.ts'

interface SwingFeed {
  serverFights: boolean
  fights: FightInterp
  nextSwing(): number
  swing(intent: FightSwingIntent): boolean
}
export function pressServerSwing<E extends EnemyState & { fight?: FightTargetRef }>(strike: Strike, enemies: readonly E[], feed: SwingFeed | null): StrikeHit<E>[] {
  const seen = feed?.fights.seen()
  if (!feed?.serverFights || !feed.fights.seed || !feed.fights.rooms.size || !seen || !strike.swing) return []
  const counter = feed.nextSwing()
  const crit = feed.fights.crit(counter, strike.critChance)
  const normalized = { ...strike, swing: { ...strike.swing, facing: normalFacing(strike.swing.facing) } }
  const hits = strikeHits(normalized, enemies.filter(e => !!e.fight), crit)
  const { feet, facing } = normalized.swing
  if (!feed.swing({ kind: 1, x: feet.x, y: feet.y, facing: { ...facing }, tool: strike.kind === 'tool', swingCounter: counter, seenTick: seen.tick, seenOffsetMs: seen.offsetMs, predicted: hits.map(hit => hit.enemy.fight!).slice(0, 16) })) return []
  return hits.slice(0, 16)
}

/** Bolts predict no target at cast time; their local projectile shows impact. */
export function sendServerBolt(feet: { x: number; y: number }, facing: { x: number; y: number }, feed: SwingFeed | null): boolean {
  const seen = feed?.fights.seen()
  if (!feed?.serverFights || !feed.fights.seed || !feed.fights.rooms.size || !seen) return false
  return feed.swing({ kind: 2, x: feet.x, y: feet.y, facing: normalFacing(facing), tool: false, swingCounter: feed.nextSwing(), seenTick: seen.tick, seenOffsetMs: seen.offsetMs, predicted: [] })
}
