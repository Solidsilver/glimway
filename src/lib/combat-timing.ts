import data from '../../content/combat.json' with { type: 'json' };
import type { HabiticaClass } from './habitica/types.ts';

export const SIGNATURE_COOLDOWN_SECONDS = data.signatureCooldownSeconds;
export const BASIC_ATTACK_COOLDOWN_SECONDS: Record<HabiticaClass, number> = Object.fromEntries(
  Object.entries(data.classes).map(([id, rule]) => [id, rule.basicAttackCooldownSeconds]),
) as Record<HabiticaClass, number>;
export const CAST_COST: Record<HabiticaClass, number> = Object.fromEntries(
  Object.entries(data.classes).map(([id, rule]) => [id, rule.castCost]),
) as Record<HabiticaClass, number>;
export const HEAL_FORMULA = data.heal;
