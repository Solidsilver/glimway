/**
 * The fight's rules, apart from Phaser (docs/design/shared-fights.md 1.3–1.5,
 * game step-back F7): what a blow reaches and does, how a hit shoves, and
 * what touching an enemy costs you. The hero and EnemySystem draw and move
 * things; these decide. Node tests drive them (tests/fight-rules.test.ts).
 *
 * The numbers are content (content/enemies.json, content/combat.json
 * `attack`), and a slash's or bolt's reach and a hit's damage are judged by
 * the same helpers the server's sim uses (src/lib/fight-math.ts, with Go
 * twins and shared vectors), so the game's own path is the one the vectors
 * pin. Only the signatures' reaches (BLOW) are still numbers here.
 *
 * An enemy is read here as `EnemyState`: where it stands and how it fares,
 * never its sprite or body. A local enemy's state is its physics body; a
 * server enemy's will be the room's snapshots.
 */
import { STAND_MARGIN, inCircle } from '../../lib/combat-moves.ts'
import { COMBAT_TUNING } from '../../lib/combat-timing.ts'
import { ENEMY_TUNING, KNOCK } from '../../lib/enemies.ts'
import { fightBoltSpawn, fightDamage, fightReach } from '../../lib/fight-math.ts'
import type { EnemyType } from '../worlds'

/**
 * Cozy-demo combat tuning (content/enemies.json): every real attack is
 * telegraphed (a windup pose, a "!" and a rising tone) so it can be read and
 * dodged; bumping into an enemy that isn't attacking only stings. KNOCK:
 * knockback impulses (px/s) applied over KNOCK.time through physics.
 */
export { ENEMY_TUNING, KNOCK }

const ATTACK = COMBAT_TUNING.attack

/**
 * The signatures' blows, not yet in content (fight-math judges only the
 * slash and the bolt): each reach (px), and its centre from the feet: `ahead`
 * along the facing, `up` above the feet. Lane F-E moves these to
 * content/combat.json when abilities go into the sim.
 */
const BLOW = {
  cleave: { reach: 40, aheadX: 22, aheadY: 18, up: 6 },
  /** Shadowstep's strike after a real dash, and after a dash a wall stopped. */
  snapstrike: { reach: 34, up: 6 },
  snapstrikeStill: { reach: 22, up: 6 },
  mend: { reach: 70, up: 8 }
}

export type EnemyPhase = 'chase' | 'telegraph' | 'lunge' | 'sweep' | 'recover' | 'stunned'

/** An enemy as the rest of the game reads it: no sprite, no body. */
export interface EnemyState {
  readonly id: string
  readonly type: EnemyType
  /** Its feet, world px. Its middle, where blows are measured to, is COMBAT_TUNING.attack.enemyYOffset above. */
  readonly x: number
  readonly y: number
  readonly hp: number
  readonly maxHp: number
  readonly state: EnemyPhase
  readonly dead: boolean
}

type Point = { readonly x: number; readonly y: number }

/**
 * A blow as the hero means it, at the moment it lands: a circle of reach and
 * the damage before a tool's share or a crit. Who it hits, and what that
 * does, are decided from it (strikeHits, then the enemy's owner).
 */
export interface Strike {
  readonly kind: 'slash' | 'tool' | 'cleave' | 'snapstrike' | 'mend'
  /** The reach's centre, world px (where it's drawn). */
  readonly x: number
  readonly y: number
  readonly reach: number
  /** The weapon's damage: a tool's swing does its share of it (fightDamage). */
  readonly damage: number
  /** 0: this blow never crits. */
  readonly critChance: number
  /** A slash's or tool's swing: the feet and facing it's judged from (fightReach), as the server judges it. */
  readonly swing?: { readonly feet: Point; readonly facing: Point }
}

/** The melee slash (or a tool's swing, at a share of the weapon's damage) just ahead of the feet. */
export function slashStrike(feet: Point, dir: Point, kit: { meleeDamage: number; critChance: number }, tool: boolean): Strike {
  return {
    kind: tool ? 'tool' : 'slash',
    x: feet.x + dir.x * ATTACK.slashOffsetX,
    y: feet.y - ATTACK.originYOffset + dir.y * ATTACK.slashOffsetY,
    reach: ATTACK.slashRadius,
    damage: kit.meleeDamage,
    critChance: kit.critChance,
    swing: { feet: { x: feet.x, y: feet.y }, facing: { x: dir.x, y: dir.y } }
  }
}

/** Cleave: a wide arc further out in front. It never crits. */
export function cleaveStrike(feet: Point, dir: Point, damage: number): Strike {
  const b = BLOW.cleave
  return { kind: 'cleave', x: feet.x + dir.x * b.aheadX, y: feet.y - b.up + dir.y * b.aheadY, reach: b.reach, damage, critChance: 0 }
}

/** Shadowstep's strike where the dash ended: wider after a real dash, and twice the crit chance. */
export function snapstrike(feet: Point, travelled: boolean, damage: number, critChance: number): Strike {
  const b = travelled ? BLOW.snapstrike : BLOW.snapstrikeStill
  return { kind: 'snapstrike', x: feet.x, y: feet.y - b.up, reach: b.reach, damage, critChance: critChance * 2 }
}

/** Mend's damaging pulse around the hero. It never crits. */
export function mendStrike(feet: Point, damage: number): Strike {
  return { kind: 'mend', x: feet.x, y: feet.y - BLOW.mend.up, reach: BLOW.mend.reach, damage, critChance: 0 }
}

/**
 * Whether a strike crits: one roll in [0, 1) per swing or cast, shared by
 * every enemy it reaches (contract 10). Math.random today; fightCritRoll(seed,
 * counter) once the server judges. A blow that can't crit never does.
 */
export function strikeCrits(strike: Strike, roll: number): boolean {
  return strike.critChance > 0 && roll < strike.critChance
}

/** Whether a strike reaches an enemy: a swing through fightReach, a signature's circle to the enemy's middle. */
export function strikeReaches(strike: Strike, enemy: EnemyState): boolean {
  if (strike.swing) {
    const { feet, facing } = strike.swing
    return fightReach('slash', feet.x, feet.y, facing.x, facing.y, enemy.x, enemy.y)
  }
  const dx = enemy.x - strike.x
  const dy = enemy.y - ATTACK.enemyYOffset - strike.y
  return dx * dx + dy * dy < strike.reach * strike.reach
}

export interface StrikeHit<E> {
  enemy: E
  amount: number
  crit: boolean
}

/**
 * The enemies a strike reaches, in the order given, each with its damage
 * (fightDamage: a tool's share, then the crit). `crit` is the strike's one
 * roll (strikeCrits), the same for all of them. Judged against the enemies
 * as this screen has them.
 */
export function strikeHits<E extends EnemyState>(strike: Strike, enemies: readonly E[], crit: boolean): StrikeHit<E>[] {
  const hits: StrikeHit<E>[] = []
  for (const enemy of enemies) {
    if (!strikeReaches(strike, enemy)) continue
    hits.push({ enemy, amount: fightDamage(strike.damage, crit, 1, strike.kind === 'tool'), crit })
  }
  return hits
}

/** Where the mage's bolt leaves the hand (fightBoltSpawn). */
export function boltSpawn(feet: Point, dir: Point): Point {
  return fightBoltSpawn(feet.x, feet.y, dir.x)
}

/** Whether a bolt, at its centre, has reached an enemy (fightReach). */
export function boltReaches(bolt: Point, enemy: EnemyState): boolean {
  return fightReach('bolt', bolt.x, bolt.y, 0, 0, enemy.x, enemy.y)
}

/**
 * What a hit that landed does: null when it can't hurt (the warden is not
 * fought down; a blow only clinks). A dazed beetle (charged into something)
 * is wide open: it takes more, and it shows as a crit.
 */
export function hitOutcome(enemy: EnemyState, amount: number, crit: boolean): { amount: number; crit: boolean } | null {
  if (enemy.type === 'guardian') return null
  // fightDamage's last factor: `amount` already carries the tool's share and the crit.
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
