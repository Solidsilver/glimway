import { COMBAT_TUNING } from './combat-timing.ts';
import { ENEMY_TUNING } from './enemies.ts';

// Twins of server/internal/rules/fight_math.go. JS never fuses a*b+c; the Go
// side blocks fusing with float64() and keeps this grouping. Keep both as
// they are: the reach vectors hold cases where either slip flips a verdict.
// Rounding: Math.round(x) and Go's Floor(x + 0.5) differ only at
// 0.49999999999999994, which no formula here can produce.

/** Keep the operation order: the Go twin and the current kit agree exactly. */
export function combatFormula(stat: number, formula: { base: number; maximumBonus: number; halfway: number; decimalPlaces: number }): number {
  const scale = 10 ** formula.decimalPlaces;
  return Math.round((formula.base + formula.maximumBonus * (stat / (stat + formula.halfway))) * scale) / scale;
}

/** Murmur3's uint32 finalizer of seed XOR counter; all multiplies wrap.
 * A roll is unsigned / 2^32, with a strict < chance comparison. One roll
 * per swing/cast, no dependence on target id or order, no mutable RNG.
 * Seeds are never zero. Counters wrap: next = (n + 1) >>> 0.
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

/** Where a bolt starts from the caster's feet: ahead along facing x only. */
export function fightBoltSpawn(x: number, y: number, facingX: number): { x: number; y: number } {
  const a = COMBAT_TUNING.attack;
  return { x: x + facingX * a.boltSpawnOffsetX, y: y - a.originYOffset };
}

/** The world tick: every room ticks on one grid, floor(server ms / 100)
 * modulo 2^32 (decision 11). */
export const FIGHT_TICK_MS = 100;

/** A server instant (Unix ms, never negative) on the grid: its tick and the
 * whole milliseconds past it (0-99). Exact for any ms below 2^46. */
export function fightTickAt(unixMs: number): { tick: number; offsetMs: number } {
  const whole = Math.floor(unixMs);
  const ticks = Math.floor(whole / FIGHT_TICK_MS);
  return { tick: ticks >>> 0, offsetMs: whole - ticks * FIGHT_TICK_MS };
}

/** a - b across the uint32 wrap: positive when a is later. */
export function fightTickDiff(a: number, b: number): number {
  return (a - b) | 0;
}

/** How far ahead of the last swing counter the server takes the next one. */
export const FIGHT_COUNTER_WINDOW = 1024;

/** next is 1 to FIGHT_COUNTER_WINDOW past last, across the wrap; a repeat,
 * a counter behind last, or one further ahead is stale. */
export function fightCounterAhead(last: number, next: number): boolean {
  const ahead = fightTickDiff(next, last);
  return ahead >= 1 && ahead <= FIGHT_COUNTER_WINDOW;
}

export type FightCampKind = 'wisp' | 'beetle';

/** When, in whole ticks from the start of a wind-up, the aim locks and the
 * attack launches. Both round towards the player: the lock at the last tick
 * that leaves at least `lock` seconds, the launch at the first tick at or
 * after `windup`, so a telegraph never gives less warning than today's. */
export function fightWindupTicks(kind: FightCampKind): { lock: number; launch: number } {
  const t = ENEMY_TUNING[kind];
  const windupMs = wholeMs(t.windup);
  const lockMs = wholeMs(t.lock);
  return { lock: Math.floor((windupMs - lockMs) / FIGHT_TICK_MS), launch: Math.ceil(windupMs / FIGHT_TICK_MS) };
}
/** elapsedTicks: fightTickDiff(now, the enemy's state_tick); negative is
 * before the wind-up, so neither locked nor launched. */
export function fightAimLocked(kind: FightCampKind, elapsedTicks: number): boolean {
  return elapsedTicks >= fightWindupTicks(kind).lock;
}
export function fightLaunched(kind: FightCampKind, elapsedTicks: number): boolean {
  return elapsedTicks >= fightWindupTicks(kind).launch;
}
/** Seconds from content as whole ms, so 0.8 - 0.5 can't slip past 0.3. */
function wholeMs(seconds: number): number {
  return Math.floor(seconds * 1000 + 0.5);
}

/** A wire facing step (256ths of a turn from +x towards +y) as a unit vector. */
export function fightFacingFromStep(step: number): { x: number; y: number } {
  const angle = ((step & 255) / 256) * 2 * Math.PI;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}
