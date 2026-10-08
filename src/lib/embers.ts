import economyJson from '../../content/economy.json' with { type: 'json' };
import type { Economy } from './economy.ts';
import { validateSave, type GameState } from './state.ts';

const economy = economyJson as unknown as Economy;

/**
 * Embers: real-life progress turned into something to spend in the world.
 *
 * Source: XP earned in Habitica between two explicit syncs (read-only — the
 * game never writes to the account). Each XP counts once, because the saved
 * profile is the baseline and advances with every accepted sync, exactly like
 * the HP credit rule in sync.ts. A few story beats also grant embers so a
 * player without Habitica can still try every spend.
 *
 * Pure logic only: no network, no Phaser, no randomness.
 */

export const XP_PER_EMBER = economy.xpPerEmber;
/** One-off gift on the first Habitica import (flag-guarded, so reconnecting
 *  after a disconnect does not pay it again). */
export const WELCOME_EMBERS = economy.welcomeEmbers;

export const EMBER_COSTS = economy.costs;

/** Road lanterns along Brackenwood that can be lit as rest spots. */
export const ROAD_LANTERNS = economy.roadLanterns;
export type RoadLanternId = (typeof ROAD_LANTERNS)[number];

const CHEST_ID = economy.chestId;
export const CHARM_ITEM = economy.charmItem;
/** Extra crit chance while carrying the Ember Charm. */
const CHARM_CRIT_BONUS = 0.1;

/** A combat kit with the Ember Charm's crit bonus applied when carried. */
export function withCharm<K extends { critChance: number }>(kit: K, inventory: readonly string[]): K {
  if (!inventory.includes(CHARM_ITEM)) return kit;
  return { ...kit, critChance: Math.min(0.6, kit.critChance + CHARM_CRIT_BONUS) };
}

export const FLAGS = {
  welcome: 'embers:welcome',
  lit: (id: RoadLanternId) => `lit:${id}`,
  chest: `opened:${CHEST_ID}`,
} as const;

/**
 * XP needed to go from `level` to `level + 1` on Habitica's level curve
 * (statHelpers.toNextLevel, checked 2026-10-03): 25·L below level 5, 150 at
 * level 5, then round((L²/4 + 10L + 139.75)/10)·10. Own implementation.
 */
export function xpToNextLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  if (l < 5) return 25 * l;
  if (l === 5) return 150;
  return Math.round((l * l * 0.25 + 10 * l + 139.75) / 10) * 10;
}

/** Total XP an account has earned to reach `level` with `exp` toward the next. */
export function lifetimeXp(level: number, exp: number): number {
  let total = 0;
  for (let l = 1; l < Math.floor(level); l += 1) total += xpToNextLevel(l);
  return total + Math.max(0, exp);
}

export interface XpPoint {
  level: number;
  exp?: number;
}

/**
 * Embers earned between two profile snapshots of the same account. Remainders
 * carry over naturally (both sides are floored on lifetime XP), and losing XP
 * (a Habitica death costs a level) never takes embers away. Returns zero when
 * either side predates XP tracking.
 */
export function embersBetween(before: XpPoint, after: XpPoint): { xp: number; embers: number } {
  if (before.exp === undefined || after.exp === undefined) return { xp: 0, embers: 0 };
  const a = lifetimeXp(before.level, before.exp);
  const b = lifetimeXp(after.level, after.exp);
  if (b <= a) return { xp: 0, embers: 0 };
  return {
    xp: Math.round(b - a),
    embers: Math.floor(b / XP_PER_EMBER) - Math.floor(a / XP_PER_EMBER),
  };
}

/**
 * Credit XP against the paid-out high-water mark. Only XP above the highest
 * lifetime total ever paid counts, so losing XP and earning it back (or
 * unchecking and re-checking a task) pays nothing new. `mark` undefined means
 * no paid history yet: nothing is credited and the mark is established.
 */
export function creditXp(mark: number | undefined, after: XpPoint): { xp: number; embers: number; mark: number | undefined } {
  if (after.exp === undefined) return { xp: 0, embers: 0, mark };
  const now = lifetimeXp(after.level, after.exp);
  if (mark === undefined) return { xp: 0, embers: 0, mark: now };
  if (now <= mark) return { xp: 0, embers: 0, mark };
  return {
    xp: Math.round(now - mark),
    embers: Math.floor(now / XP_PER_EMBER) - Math.floor(mark / XP_PER_EMBER),
    mark: now,
  };
}

/** Add embers. `fromXp` marks them as earned on Habitica (the only kind
 *  that can revive an imported hero from 0 HP). */
export function grantEmbers(state: GameState, n: number, opts: { fromXp?: boolean } = {}): GameState {
  const current = validateSave(state);
  if (!Number.isFinite(n) || n <= 0) return current;
  const add = Math.floor(n);
  return {
    ...current,
    embers: current.embers + add,
    xpEmbers: opts.fromXp ? current.xpEmbers + add : current.xpEmbers,
  };
}

/** The first-import gift, at most once per save. */
export function grantWelcome(state: GameState): { state: GameState; granted: number } {
  const current = validateSave(state);
  if (current.flags.includes(FLAGS.welcome)) return { state: current, granted: 0 };
  return {
    state: { ...current, embers: current.embers + WELCOME_EMBERS, flags: [...current.flags, FLAGS.welcome] },
    granted: WELCOME_EMBERS,
  };
}

export type EmberSpend =
  | { kind: 'rest' }
  | { kind: 'home-rest' }
  | { kind: 'road-lantern'; id: RoadLanternId }
  | { kind: 'chest' };

export type SpendReason = 'short' | 'done' | 'full' | 'needs-earned';

export type SpendCheck =
  | { ok: true; cost: number }
  | { ok: false; cost: number; reason: SpendReason };

/** Who is spending: an imported hero at 0 HP can only be revived by a rest
 *  paid with XP-earned embers (gifts and quest embers don't lift the lock). */
export interface SpendContext {
  imported?: boolean;
}

function isRevive(state: GameState, spend: EmberSpend, ctx: SpendContext): boolean {
  return (spend.kind === 'rest' || spend.kind === 'home-rest') && ctx.imported === true && state.hp <= 0;
}

function spendCost(spend: EmberSpend): number {
  switch (spend.kind) {
    case 'home-rest':
      return EMBER_COSTS.homeRest;
    case 'rest':
      return EMBER_COSTS.rest;
    case 'road-lantern':
      return EMBER_COSTS.roadLantern;
    case 'chest':
      return EMBER_COSTS.chest;
  }
}

export function isLit(state: GameState, id: RoadLanternId): boolean {
  return state.flags.includes(FLAGS.lit(id));
}

export function chestOpened(state: GameState): boolean {
  return state.flags.includes(FLAGS.chest);
}

/** Whether a spend would go through, and why not ('done' = already bought,
 *  'full' = a rest would restore nothing, 'needs-earned' = a 0-HP revive
 *  needs embers earned on Habitica). */
export function checkSpend(state: GameState, spend: EmberSpend, ctx: SpendContext = {}): SpendCheck {
  const cost = spendCost(spend);
  if (spend.kind === 'road-lantern' && isLit(state, spend.id)) return { ok: false, cost, reason: 'done' };
  if (spend.kind === 'chest' && chestOpened(state)) return { ok: false, cost, reason: 'done' };
  if ((spend.kind === 'rest' || spend.kind === 'home-rest') && state.hp >= state.maxHp && state.mana >= state.maxMana) {
    return { ok: false, cost, reason: 'full' };
  }
  if (state.embers < cost) return { ok: false, cost, reason: 'short' };
  if (isRevive(state, spend, ctx) && state.xpEmbers < cost) return { ok: false, cost, reason: 'needs-earned' };
  return { ok: true, cost };
}

export class EmberSpendError extends Error {
  readonly reason: SpendReason;

  constructor(reason: SpendReason) {
    super(
      reason === 'short'
        ? 'Not enough embers.'
        : reason === 'done'
          ? 'Already done.'
          : reason === 'full'
            ? 'Already rested.'
            : 'Reviving needs embers earned on Habitica.',
    );
    this.name = 'EmberSpendError';
    this.reason = reason;
  }
}

/** Apply a spend immutably; throws EmberSpendError when checkSpend says no. */
export function spendEmbers(state: GameState, spend: EmberSpend, ctx: SpendContext = {}): GameState {
  const current = validateSave(state);
  const check = checkSpend(current, spend, ctx);
  if (!check.ok) throw new EmberSpendError(check.reason);
  // A revive is paid from XP-earned embers; anything else spends gifted and
  // quest embers first, keeping earned ones for when they matter most.
  const gifted = current.embers - current.xpEmbers;
  const fromXp = isRevive(current, spend, ctx) ? check.cost : Math.max(0, check.cost - gifted);
  const paid = { ...current, embers: current.embers - check.cost, xpEmbers: current.xpEmbers - fromXp };
  switch (spend.kind) {
    case 'rest':
    case 'home-rest':
      // A warm rest bought with real-life progress: full local vitals. Never
      // a Habitica operation — the account's HP is untouched.
      return { ...paid, hp: paid.maxHp, mana: paid.maxMana };
    case 'road-lantern':
      return { ...paid, flags: [...paid.flags, FLAGS.lit(spend.id)] };
    case 'chest':
      return {
        ...paid,
        flags: [...paid.flags, FLAGS.chest],
        inventory: paid.inventory.includes(CHARM_ITEM) ? paid.inventory : [...paid.inventory, CHARM_ITEM],
      };
  }
}
