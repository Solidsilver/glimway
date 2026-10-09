import raw from '../../content/combat.json' with { type: 'json' };
import type { HabiticaClass } from './habitica/types.ts';
import { decodeContent } from './content-proto.ts';
import { CombatSchema, type CombatValid } from './gen/glimway/content/v1/combat_pb.js';

/**
 * Reads combat JSON through the schema (proto/glimway/content/v1/
 * combat.proto): the fixed signature cooldown, the four classes with
 * positive numbers and the heal formula are all on it; nothing is left
 * in code.
 */
export function validateCombat(value: unknown): CombatValid {
  // The schema requires heal; the Valid type says so.
  return decodeContent(CombatSchema, value, 'combat', []) as unknown as CombatValid;
}

const data = validateCombat(raw);

export const SIGNATURE_COOLDOWN_SECONDS = data.signatureCooldownSeconds;
export const BASIC_ATTACK_COOLDOWN_SECONDS: Record<HabiticaClass, number> = Object.fromEntries(
  Object.entries(data.classes).map(([id, rule]) => [id, rule.basicAttackCooldownSeconds]),
) as Record<HabiticaClass, number>;
export const CAST_COST: Record<HabiticaClass, number> = Object.fromEntries(
  Object.entries(data.classes).map(([id, rule]) => [id, rule.castCost]),
) as Record<HabiticaClass, number>;
export const HEAL_FORMULA = data.heal;
