import { DEMO_CHARACTER } from '../content/world.ts';
import type {
  CombatKit,
  EffectiveStats,
  HabiticaClass,
  HabiticaProfile,
  SignatureAbility,
} from './habitica/types.ts';

/**
 * Shared combat contract for the runtime (docs/m3-implementation.md).
 * getCombatKit is pure: the runtime implements effects, this module only
 * derives the numbers and identity. Extreme imported stats are bounded with
 * diminishing returns so one absurd account cannot dominate the demo.
 */

/** Hyperbolic diminishing returns: 0..max, half-saturated at `halfway`. */
function diminishing(bonus: number, max: number, halfway: number): number {
  return max * (bonus / (bonus + halfway));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface KitTemplate {
  basicName: string;
  signatureName: string;
  signature: SignatureAbility;
  manaCost: number;
  cooldown: number;
  damageStat: keyof EffectiveStats;
}

const KITS: Record<HabiticaClass, KitTemplate> = {
  warrior: {
    basicName: 'Slash',
    signatureName: 'Cleave',
    signature: 'cleave',
    manaCost: 12,
    cooldown: 1.2,
    damageStat: 'str',
  },
  mage: {
    basicName: 'Bolt',
    signatureName: 'Fingersnap',
    signature: 'bolt',
    manaCost: 15,
    cooldown: 0.6,
    damageStat: 'int',
  },
  rogue: {
    basicName: 'Stab',
    signatureName: 'Shadowstep',
    signature: 'dash',
    manaCost: 10,
    cooldown: 1.5,
    damageStat: 'per',
  },
  healer: {
    basicName: 'Tap',
    signatureName: 'Mend',
    signature: 'heal',
    manaCost: 18,
    cooldown: 2.5,
    damageStat: 'int',
  },
};

/** Classless starter: the existing demo bolt. */
const STARTER: KitTemplate = {
  basicName: 'Slash',
  signatureName: 'Fingersnap',
  signature: 'bolt',
  manaCost: 15,
  cooldown: 0.6,
  damageStat: 'int',
};

/**
 * Combat kit for a character. `null` profile yields the classless starter
 * kit on demo stats (existing demo bolt behavior). The healer signature is a
 * damaging pulse PLUS a heal — both `signatureDamage` and `healAmount` are
 * live numbers the runtime applies together.
 */
export function getCombatKit(profile: HabiticaProfile | null): CombatKit {
  const template = profile && profile.class ? KITS[profile.class] : STARTER;
  const stats = profile ? profile.stats : DEMO_CHARACTER.stats;

  return {
    class: profile ? profile.class : null,
    name: profile ? profile.name : DEMO_CHARACTER.name,
    basicName: template.basicName,
    signatureName: template.signatureName,
    signature: template.signature,
    meleeDamage: round2(5 + diminishing(stats.str, 24, 60)),
    signatureDamage: round2(8 + diminishing(stats[template.damageStat], 30, 70)),
    mitigation: round2(diminishing(stats.con, 0.45, 90)),
    critChance: round2(0.05 + diminishing(stats.per, 0.4, 80)),
    manaCost: template.manaCost,
    cooldown: template.cooldown,
    healAmount: template.signature === 'heal'
      ? round2(6 + diminishing(stats.int, 20, 60))
      : 0,
  };
}

export type { CombatKit, SignatureAbility };
