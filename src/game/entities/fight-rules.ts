/**
 * The fight's rules, apart from Phaser (docs/design/shared-fights.md 1.3–1.5,
 * game step-back F7): what a blow reaches and does, how a hit shoves, and
 * what touching an enemy costs you. The hero and EnemySystem draw and move
 * things; these decide. Node tests drive them (tests/fight-rules.test.ts),
 * and the server's sim ports them from content with shared vectors.
 *
 * An enemy is read here as `EnemyState`: where it stands and how it fares,
 * never its sprite or body. A local enemy's state is its physics body; a
 * server enemy's will be the room's snapshots.
 */
import { STAND_MARGIN, inCircle } from '../../lib/combat-moves.ts'
import type { EnemyType } from '../worlds'

/**
 * Cozy-demo combat tuning: every real attack is telegraphed (a windup pose,
 * a "!" and a rising tone) so it can be read and dodged; bumping into an
 * enemy that isn't attacking only stings.
 */
export const ENEMY_TUNING = {
  // lock: seconds before launch when the aim freezes (with a white flash) —
  // the moment to step aside. reach: how near a bump stings (an attack's own
  // reach, hopReach/chargeReach/lungeReach, is a little longer).
  wisp: { hp: 10, contact: 1, reach: 12, hopReach: 14, chase: 38, aggro: 90, hopRange: 46, windup: 0.5, lock: 0.18, hopSpeed: 175, hopTime: 0.24, hop: 2, recover: 0.65, cooldown: 1.4 },
  beetle: { hp: 18, contact: 1, reach: 12, chargeReach: 15, walk: 30, aggro: 130, keepAway: 64, chargeRange: 120, windup: 0.8, lock: 0.3, chargeSpeed: 220, chargeTime: 0.85, charge: 3, stun: 1.4, recover: 0.5, cooldown: 2.1, stunnedTakes: 1.5 },
  guardian: { hp: 44, contact: 1, reach: 12, lungeReach: 18, lunge: 3, lungeSpeed: 250, telegraph: 0.65, cooldown: 3.2 }
} as const

/** Knockback impulses (px/s) applied over KNOCK.time through physics. */
export const KNOCK = { small: 170, guardian: 60, player: 150, time: 0.13 }

/** The hero's blows: reach (px) and the offsets of each reach's centre from the feet. */
const BLOW = {
  slash: 26,
  /** A tool swung at a creature does this share of the weapon's damage. */
  toolShare: 0.5,
  cleave: 40,
  /** Shadowstep's strike after a real dash, and after a dash a wall stopped. */
  snapstrike: 34,
  snapstrikeStill: 22,
  mend: 70
}

export type EnemyPhase = 'chase' | 'telegraph' | 'lunge' | 'sweep' | 'recover' | 'stunned'

/** An enemy as the rest of the game reads it: no sprite, no body. */
export interface EnemyState {
  readonly id: string
  readonly type: EnemyType
  /** Its feet, world px. Its middle, where blows are measured to, is 6 px above. */
  readonly x: number
  readonly y: number
  readonly hp: number
  readonly maxHp: number
  readonly state: EnemyPhase
  readonly dead: boolean
}

/**
 * A blow as the hero means it, at the moment it lands: a circle of reach and
 * the damage before a crit. Who it hits, and what that does, are decided
 * from it (strikeHits, then the enemy's owner).
 */
export interface Strike {
  readonly kind: 'slash' | 'tool' | 'cleave' | 'snapstrike' | 'mend'
  /** The reach's centre, world px. */
  readonly x: number
  readonly y: number
  readonly reach: number
  readonly damage: number
  /** 0: this blow never crits, and rolls nothing. */
  readonly critChance: number
}

type Point = { readonly x: number; readonly y: number }

/** The melee slash (or a tool's swing, at a share of the weapon's damage) just ahead of the feet. */
export function slashStrike(feet: Point, dir: Point, kit: { meleeDamage: number; critChance: number }, tool: boolean): Strike {
  return {
    kind: tool ? 'tool' : 'slash',
    x: feet.x + dir.x * 14,
    y: feet.y - 7 + dir.y * 12,
    reach: BLOW.slash,
    damage: tool ? Math.max(1, Math.round(kit.meleeDamage * BLOW.toolShare)) : kit.meleeDamage,
    critChance: kit.critChance
  }
}

/** Cleave: a wide arc further out in front. It never crits. */
export function cleaveStrike(feet: Point, dir: Point, damage: number): Strike {
  return { kind: 'cleave', x: feet.x + dir.x * 22, y: feet.y - 6 + dir.y * 18, reach: BLOW.cleave, damage, critChance: 0 }
}

/** Shadowstep's strike where the dash ended: wider after a real dash, and twice the crit chance. */
export function snapstrike(feet: Point, travelled: boolean, damage: number, critChance: number): Strike {
  return { kind: 'snapstrike', x: feet.x, y: feet.y - 6, reach: travelled ? BLOW.snapstrike : BLOW.snapstrikeStill, damage, critChance: critChance * 2 }
}

/** Mend's damaging pulse around the hero. It never crits. */
export function mendStrike(feet: Point, damage: number): Strike {
  return { kind: 'mend', x: feet.x, y: feet.y - 8, reach: BLOW.mend, damage, critChance: 0 }
}

/** A roll in [0, 1) for a crit: Math.random today; a seed and a swing counter once the server judges. */
export type CritRoll = () => number

export interface StrikeHit<E> {
  enemy: E
  amount: number
  crit: boolean
}

/**
 * The enemies a strike reaches, in the order given, each with its damage and
 * whether it crits (one roll per enemy reached, none for a blow that can't
 * crit). Judged against the enemies as this screen has them.
 */
export function strikeHits<E extends EnemyState>(strike: Strike, enemies: readonly E[], roll: CritRoll): StrikeHit<E>[] {
  const hits: StrikeHit<E>[] = []
  for (const enemy of enemies) {
    const dx = enemy.x - strike.x
    const dy = enemy.y - 6 - strike.y
    if (dx * dx + dy * dy >= strike.reach * strike.reach) continue
    const crit = strike.critChance > 0 && roll() < strike.critChance
    hits.push({ enemy, amount: crit ? strike.damage * 2 : strike.damage, crit })
  }
  return hits
}

/**
 * What a hit that landed does: null when it can't hurt (the warden is not
 * fought down; a blow only clinks). A dazed beetle (charged into something)
 * is wide open: it takes more, and it shows as a crit.
 */
export function hitOutcome(enemy: EnemyState, amount: number, crit: boolean): { amount: number; crit: boolean } | null {
  if (enemy.type === 'guardian') return null
  if (enemy.type === 'beetle' && enemy.state === 'stunned') return { amount: amount * ENEMY_TUNING.beetle.stunnedTakes, crit: true }
  return { amount, crit }
}

/**
 * The shove a hit gives (px/s, for KNOCK.time): away from the blow
 * sideways, half as much up or down from the hero's feet (straight back the
 * hero's facing when on top of it). Null: a charging beetle is too heavy to
 * stop, and the warden doesn't rock mid-lunge.
 */
export function knockFrom(enemy: EnemyState, fromX: number, hero: { y: number; facing: Point }): Point | null {
  if ((enemy.type === 'beetle' || enemy.type === 'guardian') && enemy.state === 'lunge') return null
  let x = enemy.x - fromX
  let y = (enemy.y - hero.y) * 0.5
  if (x * x + y * y < 0.01) {
    x = hero.facing.x
    y = hero.facing.y
  }
  // As Phaser's Vector2.normalize: by the inverse length, and a zero stays zero.
  const len = x * x + y * y
  if (len > 0) {
    const inv = 1 / Math.sqrt(len)
    x *= inv
    y *= inv
  }
  const speed = enemy.type === 'guardian' ? KNOCK.guardian : KNOCK.small
  return { x: x * speed, y: y * speed }
}

/** A wisp knocked mid-windup or mid-hop loses the attack: a quick hit is a real answer. */
export function knockInterrupts(enemy: EnemyState): boolean {
  return enemy.type === 'wisp' && (enemy.state === 'telegraph' || enemy.state === 'lunge')
}

/**
 * What touching an enemy costs, by its kind and what it's doing: attacks
 * hit hard over their own reach, a bump only stings, and some moments are
 * safe (a dazed beetle; the warden finding its feet). `sweep` is the
 * warden's arm sweep (./warden.ts WARDEN).
 */
export function contactThreat(enemy: EnemyState, sweep: { reach: number; damage: number }): { reach: number; damage: number } {
  const lunging = enemy.state === 'lunge'
  switch (enemy.type) {
    case 'guardian': {
      const t = ENEMY_TUNING.guardian
      if (lunging) return { reach: t.lungeReach, damage: t.lunge }
      if (enemy.state === 'sweep') return sweep
      return { reach: t.reach, damage: enemy.state === 'recover' ? 0 : t.contact }
    }
    case 'wisp': {
      const t = ENEMY_TUNING.wisp
      return lunging ? { reach: t.hopReach, damage: t.hop } : { reach: t.reach, damage: t.contact }
    }
    case 'beetle': {
      const t = ENEMY_TUNING.beetle
      if (lunging) return { reach: t.chargeReach, damage: t.charge }
      return { reach: t.reach, damage: enemy.state === 'stunned' ? 0 : t.contact }
    }
  }
}

/**
 * Touching, judged on this screen against the enemy as it's drawn
 * (shared-fights.md decision 9): a creature's lunge that would reach a
 * planted hero (Stand) stops short and staggers; otherwise anything inside
 * its reach hurts. `dist` runs from the enemy's middle to the hero's.
 */
export function touchOutcome(enemy: EnemyState, threat: { reach: number; damage: number }, dist: number, planted: boolean): 'stagger' | 'hurt' | null {
  if (threat.damage <= 0) return null
  if (planted && enemy.type !== 'guardian' && enemy.state === 'lunge' && dist < threat.reach + STAND_MARGIN) return 'stagger'
  return dist < threat.reach ? 'hurt' : null
}

/**
 * A Ward-light pulse (this hero's or a friend's) mends the hero standing
 * inside its circle, unless they're resting at 0 HP or it carries no heal.
 */
export function wardMends(hero: Point, hp: number, pulse: { x: number; y: number; r: number; heal: number }): boolean {
  return pulse.heal > 0 && hp > 0 && inCircle(hero.x, hero.y, pulse.x, pulse.y, pulse.r)
}
