import raw from '../../content/combat.json' with { type: 'json' };
import type { HabiticaClass } from './habitica/types.ts';
import { decodeContent } from './content-proto.ts';
import { CombatSchema, type CombatValid } from './gen/glimway/content/v1/combat_pb.js';

/**
 * Reads combat JSON through the schema (proto/glimway/content/v1/
 * combat.proto): cooldowns, class rows, kit formulas and attack geometry
 * are validated together. Ability mana stays in the ability table.
 */
export function validateCombat(value: unknown): CombatValid {
  // Required nested tuning is reflected in the generated Valid type.
  return decodeContent(CombatSchema, value, 'combat', []) as unknown as CombatValid;
}

export const COMBAT_TUNING = validateCombat(raw);
const data = COMBAT_TUNING;

export const SIGNATURE_COOLDOWN_SECONDS = data.signatureCooldownSeconds;
export const BASIC_ATTACK_COOLDOWN_SECONDS: Record<HabiticaClass, number> = Object.fromEntries(
  Object.entries(data.classes).map(([id, rule]) => [id, rule.basicAttackCooldownSeconds]),
) as Record<HabiticaClass, number>;
export const HEAL_FORMULA = data.heal;
