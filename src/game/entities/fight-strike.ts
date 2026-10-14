/** Server fight intent at the press: a basic swing or a cast is selected, stamped,
 * sent and predicted in one go, on the one counter the socket shares (contract 10).
 * Local enemies (curated fights) keep their animation's delayed landing in Hero. */
import { at as locationAt } from '../../lib/location.ts'
import { normalFacing } from '../../lib/presence-client.ts'
import { strikeHits, type Strike, type EnemyState, type StrikeHit } from './fight-rules.ts'
import type { FightCastIntent, FightTargetRef, FightSwingIntent } from '../../lib/presence.ts'
import type { FightInterp } from '../../lib/fight-interp.ts'

interface SwingFeed {
  fights: FightInterp
  nextSwing(): number
  swing(intent: FightSwingIntent): boolean
}
interface CastFeed {
  fights: FightInterp
  nextSwing(): number
  ability(id: string, x: number, y: number, fight?: FightCastIntent): boolean
}
type Point = { x: number; y: number }

/** Gate before prediction, cooldowns or mana: enemy workings start on unsafe ground. */
export function canStartFight(area: string, feet: Point, ability?: string): boolean {
  return area !== 'outdoors' || ability === 'ward-light' || !locationAt('outdoors', feet.x, feet.y).safe
}

/** Whether this screen observes a server room now (a seed, a room, a drawn instant). */
function observing(feed: { fights: FightInterp } | null): { tick: number; offsetMs: number } | null {
  const seen = feed?.fights.seen()
  return feed && feed.fights.seed && feed.fights.rooms.size && seen ? seen : null
}

export function pressServerSwing<E extends EnemyState & { fight?: FightTargetRef }>(strike: Strike, enemies: readonly E[], feed: SwingFeed | null): StrikeHit<E>[] {
  const seen = observing(feed)
  if (!feed || !seen || !strike.swing || !canStartFight('outdoors', strike.swing.feet)) return []
  const counter = feed.nextSwing()
  const crit = feed.fights.crit(counter, strike.critChance)
  const normalized = { ...strike, swing: { ...strike.swing, facing: normalFacing(strike.swing.facing) } }
  const hits = strikeHits(normalized, enemies.filter(e => !!e.fight), crit)
  const { feet, facing } = normalized.swing
  if (!feed.swing({ kind: 1, x: feet.x, y: feet.y, facing: { ...facing }, tool: strike.kind === 'tool', swingCounter: counter, seenTick: seen.tick, seenOffsetMs: seen.offsetMs, predicted: hits.map(hit => hit.enemy.fight!).slice(0, 16) })) return []
  return hits.slice(0, 16)
}

/** Bolts predict no target at cast time; their local projectile shows impact. */
export function sendServerBolt(feet: Point, facing: Point, feed: SwingFeed | null): boolean {
  const seen = observing(feed)
  if (!feed || !seen || !canStartFight('outdoors', feet)) return false
  return feed.swing({ kind: 2, x: feet.x, y: feet.y, facing: normalFacing(facing), tool: false, swingCounter: feed.nextSwing(), seenTick: seen.tick, seenOffsetMs: seen.offsetMs, predicted: [] })
}

/**
 * Cast a signature or level-20 move at the press (shared-fights.md 1.6). It
 * always tells the room (the relay friends draw from); while a server room is
 * observed it carries a FightCast on the shared counter, so the socket's
 * allowAbility owns its cost and the sim applies it. `strike`: the blow the
 * screen predicts on server enemies now (Cleave, Mend, Shadowstep's projected
 * end), its crit from the seed; none for Fingersnap's bolt and the moves.
 * Returns the predicted hits on server enemies (none unless the fight part went),
 * and whether the cast was sent at all.
 */
export function pressServerCast<E extends EnemyState & { fight?: FightTargetRef }>(id: string, at: Point, facing: Point, strike: Strike | null, enemies: readonly E[], feed: CastFeed | null): { sent: boolean; fight: boolean; hits: StrikeHit<E>[] } {
  if (!feed) return { sent: false, fight: false, hits: [] }
  const seen = observing(feed)
  if (!seen) return { sent: feed.ability(id, at.x, at.y), fight: false, hits: [] }
  if (!canStartFight('outdoors', at, id)) return { sent: false, fight: false, hits: [] }
  const counter = feed.nextSwing()
  const crit = strike ? feed.fights.crit(counter, strike.critChance) : false
  const hits = strike ? strikeHits(strike, enemies.filter(e => !!e.fight), crit).slice(0, 16) : []
  const sent = feed.ability(id, at.x, at.y, { seenTick: seen.tick, seenOffsetMs: seen.offsetMs, facing: normalFacing(facing), swingCounter: counter, predicted: hits.map(hit => ({ ...hit.enemy.fight! })) })
  return { sent, fight: sent, hits: sent ? hits : [] }
}
