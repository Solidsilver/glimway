/**
 * The ability table (content/abilities.json; docs/design/crafts.md 4.1).
 * Shared with the Go server (content/abilities.go): who has the move, from
 * which level, what it costs, how often it can be used, and its numbers.
 */
import raw from '../../content/abilities.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { AbilitiesSchema, type AbilityValid, type AbilitiesValid } from './gen/glimway/content/v1/abilities_pb.js';

export type Ability = AbilityValid;
/** The ability table (proto/glimway/content/v1/abilities.proto), with the schema's required fields non-optional. */
export type AbilitiesData = AbilitiesValid;

/** Throws on anything content/abilities.go would refuse. */
export function validateAbilities(value: unknown): AbilitiesData {
  const data = decodeContent(AbilitiesSchema, value, 'abilities', ['abilities']) as AbilitiesData;
  const bad = (why: string): never => { throw new Error(`invalid abilities: ${why}`); };
  const seen = new Set<string>();
  const signature = new Set<string>();
  const combat = new Set<string>();
  for (const a of data.abilities) {
    if (seen.has(a.id)) return bad(`duplicate id ${a.id}`);
    seen.add(a.id);
    if (a.kind === 'signature') {
      if (a.level !== 10) return bad(`${a.id} signature level`);
      if (signature.has(a.class)) return bad(`${a.id} second signature`);
      signature.add(a.class);
    } else if (a.kind === 'combat') {
      if (combat.has(a.class)) return bad(`${a.id} second move`);
      combat.add(a.class);
    }
  }
  for (const klass of ['warrior', 'mage', 'healer', 'rogue']) {
    if (!signature.has(klass)) return bad(`${klass} has no signature`);
  }
  return data;
}

export const ABILITIES: AbilitiesData = validateAbilities(raw);

export function abilityFor(id: string): Ability | undefined {
  return ABILITIES.abilities.find((a) => a.id === id);
}

/** A hero's moves: their class's signature and combat move (design 4.2). */
export function abilitiesForClass(klass: string): Ability[] {
  return ABILITIES.abilities.filter((a) => a.class === klass);
}

/** The moves a hero has: their craft's moves at or below their level mark. */
export function unlockedAbilities(klass: string | null, levelMark: number): Ability[] {
  if (!klass) return [];
  return abilitiesForClass(klass).filter((a) => a.level <= levelMark);
}
