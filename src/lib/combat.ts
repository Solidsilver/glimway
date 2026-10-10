import { SIGNATURE_COOLDOWN_SECONDS, BASIC_ATTACK_COOLDOWN_SECONDS, HEAL_FORMULA } from './combat-timing.ts';
import { profileFor } from './profile.ts';
import { abilitiesForClass, type Ability } from './abilities.ts';
import { wardPulseHeal } from './combat-moves.ts';
import { DEMO_CHARACTER } from '../content/world.ts';
import { toInternalClass } from './habitica/mapping.ts';
import type { EffectiveStats, HabiticaClass, HabiticaProfile } from './habitica/types.ts';

/**
 * Shared combat contract for the runtime (docs/m3-implementation.md,
 * docs/design/crafts.md 4). getCombatKit is pure: the runtime implements
 * effects, this module only derives the numbers and identity. The moves
 * come from the ability table (content/abilities.json): a hero has their
 * craft's moves at or below their level mark. Extreme imported stats are
 * bounded with diminishing returns so one absurd account cannot dominate.
 */

/** Hyperbolic diminishing returns: 0..max, half-saturated at `halfway`. */
function diminishing(bonus: number, max: number, halfway: number): number {
  return max * (bonus / (bonus + halfway));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}


/** A move as the kit carries it: the table's row, its numbers spelled out (0 where the row has none). */
export interface KitMove {
  id: string;
  name: string;
  kind: 'signature' | 'combat';
  level: number;
  mana: number;
  /** Seconds between casts (a signature's is the report's 1 s). */
  cooldown: number;
  icon: string;
  numbers: { durationSeconds: number; staggerSeconds: number; radiusTiles: number; slow: number; reachTiles: number; pulses: number; pulseHealFraction: number };
}

export interface CombatKit {
  /** The hero's craft: null for a hero who fights with what's in hand. */
  class: HabiticaClass | null;
  /** Character display name (profile name, or the demo name). */
  name: string;
  basicName: string;
  /** F / the ✦: null without a craft or under level 10. */
  signature: KitMove | null;
  /** R / the second ✦: the level-20 move, null until then. */
  move: KitMove | null;
  /** The craft's moves still ahead of the level mark (the Character panel's locked lines). */
  ahead: KitMove[];
  meleeDamage: number;
  signatureDamage: number;
  /** Fraction of incoming damage absorbed, 0..~0.45. */
  mitigation: number;
  /** Critical hit chance, 0..~0.45. */
  critChance: number;
  /** Seconds between basic attacks. */
  basicAttackCooldown: number;
  /** A Mend's heal (the healer's signature); 0 for every other kit. */
  healAmount: number;
  /** One Ward-light pulse: `pulseHealFraction` of a Mend (0 without the move). */
  wardPulseHeal: number;
}

const BASIC_NAMES: Record<HabiticaClass, string> = { warrior: 'Slash', mage: 'Bolt', rogue: 'Stab', healer: 'Tap' };
const DAMAGE_STAT: Record<HabiticaClass, keyof EffectiveStats> = { warrior: 'str', mage: 'int', rogue: 'per', healer: 'int' };
/** What's in hand: a plain slash at the old starter's cadence (crafts.md 4.2). */
const CLASSLESS_BASIC = { name: 'Slash', cooldown: 0.6 };

/** The server's level and class marks (`PlayerState.magic`, crafts.md 4.2). */
export interface MagicMarks {
  levelMark: number;
  /** The last class a sync saw (null or absent: none yet). */
  classMark?: string | null;
}

/** The level mark a kit reads: the server's mark, or the profile's level when that's higher (the next sync raises the mark). */
export function levelMarkOf(profile: HabiticaProfile | null, magic: MagicMarks | null | undefined): number {
  return Math.max(magic?.levelMark ?? 0, profile?.level ?? 0);
}

/**
 * The hero's craft (crafts.md 4.2): the profile's class, or, when Habitica
 * reports none, the class mark of a hero whose level mark is 10 or more (a
 * rebirth). A hero who never had a class has none.
 */
export function craftOf(profile: HabiticaProfile | null, magic: MagicMarks | null | undefined): HabiticaClass | null {
  if (!profile) return null;
  if (profile.class) return profile.class;
  // Habitica's spelling (`wizard`) reads as the game's (`mage`), whichever the server stored.
  const mark = toInternalClass(magic?.classMark);
  return mark && levelMarkOf(profile, magic) >= 10 ? mark : null;
}

function kitMove(a: Ability): KitMove {
  const n = a.numbers;
  return {
    id: a.id,
    name: a.name,
    kind: a.kind === 'signature' ? 'signature' : 'combat',
    level: a.level,
    mana: a.mana,
    cooldown: a.kind === 'signature' ? SIGNATURE_COOLDOWN_SECONDS : a.cooldownSeconds,
    icon: a.icon,
    numbers: {
      durationSeconds: n?.durationSeconds ?? 0,
      staggerSeconds: n?.staggerSeconds ?? 0,
      radiusTiles: n?.radiusTiles ?? 0,
      slow: n?.slow ?? 1,
      reachTiles: n?.reachTiles ?? 0,
      pulses: n?.pulses ?? 0,
      pulseHealFraction: n?.pulseHealFraction ?? 0,
    },
  };
}

/**
 * Combat kit for a character. A `null` profile (no Habitica hero) fights
 * with what's in hand on the demo stats. `magic` is the server's marks
 * (`PlayerState.magic`); without it the profile's own level counts. The
 * healer's Mend is a damaging pulse PLUS a heal — both `signatureDamage`
 * and `healAmount` are live numbers the runtime applies together.
 */
export function getCombatKit(profile: HabiticaProfile | null, magic: MagicMarks | null = null): CombatKit {
  profile = profileFor({ profileSource: profile ? 'habitica' : 'none', profile });
  const craft = craftOf(profile, magic);
  const mark = levelMarkOf(profile, magic);
  const stats = profile ? profile.stats : DEMO_CHARACTER.stats;
  const moves = craft ? abilitiesForClass(craft).map(kitMove) : [];
  const has = (m: KitMove) => m.level <= mark;
  const signature = moves.find((m) => m.kind === 'signature' && has(m)) ?? null;
  const move = moves.find((m) => m.kind === 'combat' && has(m)) ?? null;
  const healAmount = signature?.id === 'mend'
    ? round2(HEAL_FORMULA.base + diminishing(stats.int, HEAL_FORMULA.maximumBonus, HEAL_FORMULA.halfway))
    : 0;
  return {
    class: craft,
    name: profile ? profile.name : DEMO_CHARACTER.name,
    basicName: craft ? BASIC_NAMES[craft] : CLASSLESS_BASIC.name,
    signature,
    move,
    ahead: moves.filter((m) => !has(m)),
    meleeDamage: round2(5 + diminishing(stats.str, 24, 60)),
    signatureDamage: signature && craft ? round2(8 + diminishing(stats[DAMAGE_STAT[craft]], 30, 70)) : 0,
    mitigation: round2(diminishing(stats.con, 0.45, 90)),
    critChance: round2(0.05 + diminishing(stats.per, 0.4, 80)),
    basicAttackCooldown: craft ? BASIC_ATTACK_COOLDOWN_SECONDS[craft] : CLASSLESS_BASIC.cooldown,
    healAmount,
    wardPulseHeal: move?.id === 'ward-light' ? wardPulseHeal(healAmount, move.numbers.pulseHealFraction) : 0,
  };
}

/** The levels a move arrives at: the unlock notice is for the level mark crossing one of them (crafts.md 4.2). */
const UNLOCK_LEVELS = [10, 20];

/**
 * The unlock notice, or null: only when the level mark crosses 10 or 20
 * against the one the client held (never for a class-mark change alone),
 * and one line even when a mark crosses both — "New at level 20: Cleave on
 * F and Stand on R." The marks alone decide: the profile's own level is
 * left out, since a sync that raised the mark raised it too.
 */
export function unlockNotice(profile: HabiticaProfile | null, before: MagicMarks | null, after: MagicMarks | null): string | null {
  const from = before?.levelMark ?? 0;
  const to = after?.levelMark ?? 0;
  if (!after || !UNLOCK_LEVELS.some((level) => from < level && level <= to)) return null;
  const marked = profile ? { ...profile, level: 0 } : null;
  const was = getCombatKit(marked, { ...after, levelMark: from });
  const now = getCombatKit(marked, after);
  const fresh = [now.signature, now.move].filter((m): m is KitMove => !!m && m.id !== was.signature?.id && m.id !== was.move?.id);
  if (fresh.length === 0) return null;
  if (fresh.length === 1) return unlockLine(fresh[0]);
  const [sig, move] = fresh;
  return `New at level ${move.level}: ${sig.name} on F and ${move.name} on R.`;
}

/** One move's notice: "New at level 20: Kindle. It's on R, and the second ✦ on phones." */
export function unlockLine(m: KitMove): string {
  return m.kind === 'signature'
    ? `New at level ${m.level}: ${m.name}. It’s on F, and the ✦ on phones.`
    : `New at level ${m.level}: ${m.name}. It’s on R, and the second ✦ on phones.`;
}
