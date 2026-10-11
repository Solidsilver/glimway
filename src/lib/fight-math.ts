import { COMBAT_TUNING } from './combat-timing.ts';

/** Keep the operation order: the Go twin and the current kit agree exactly. */
export function combatFormula(stat: number, formula: { base: number; maximumBonus: number; halfway: number; decimalPlaces: number }): number {
  const scale = 10 ** formula.decimalPlaces;
  return Math.round((formula.base + formula.maximumBonus * (stat / (stat + formula.halfway))) * scale) / scale;
}

/** Murmur3's uint32 finalizer of seed XOR counter; all multiplies wrap.
 * A roll is unsigned / 2^32, with a strict < chance comparison. One roll
 * per swing/cast, no dependence on target id or order, no mutable RNG.
 */
export function fightCritRoll(seed: number, swingCounter: number): number {
  let word = (seed ^ swingCounter) >>> 0;
  word ^= word >>> 16;
  word = Math.imul(word, 0x85ebca6b);
  word ^= word >>> 13;
  word = Math.imul(word, 0xc2b2ae35);
  word ^= word >>> 16;
  return (word >>> 0) / 0x100000000;
}
export function fightCrit(seed: number, swingCounter: number, chance: number): boolean {
  return fightCritRoll(seed, swingCounter) < chance;
}

/** Existing tool rounding, then crit multiplier, then stunned multiplier.
 * Damage remains fractional; only display text rounds it to an integer.
 */
export function fightDamage(base: number, crit: boolean, stunnedMultiplier = 1, tool = false): number {
  const attack = COMBAT_TUNING.attack;
  const damage = tool ? Math.max(1, Math.round(base * attack.toolDamageFraction)) : base;
  return damage * (crit ? attack.critMultiplier : 1) * stunnedMultiplier;
}

/** Positions are sprite feet. Slash centre is offset by unit facing;
 * bolt reach is checked at the bolt's current centre, not its cast origin.
 * The boundary is strict (<), matching the current local hit boxes.
 */
export function fightReach(kind: 'slash' | 'bolt', x: number, y: number, facingX: number, facingY: number, enemyX: number, enemyY: number): boolean {
  const a = COMBAT_TUNING.attack;
  const sx = kind === 'slash' ? x + facingX * a.slashOffsetX : x;
  const sy = kind === 'slash' ? y - a.originYOffset + facingY * a.slashOffsetY : y;
  const dx = enemyX - sx;
  const dy = enemyY - a.enemyYOffset - sy;
  const radius = kind === 'slash' ? a.slashRadius : a.boltRadius;
  return dx * dx + dy * dy < radius * radius;
}
