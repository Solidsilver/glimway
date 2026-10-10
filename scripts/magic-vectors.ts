import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getCombatKit } from '../src/lib/combat.ts';
import { abilityFor } from '../src/lib/abilities.ts';
import { friendPulseHeal, wardPulseTimes } from '../src/lib/combat-moves.ts';
import { toHabiticaProfile } from '../src/lib/habitica/mapping.ts';
import { FIXTURES_BY_KEY, gearLookupFor } from '../src/lib/habitica/fixtures.ts';

/**
 * The heal numbers both sides compute (crafts.md 4.3-4.5; review F4):
 * a healer's Mend from INT, one Ward-light pulse and one whole ward, the
 * pulse times, and a friend's fallback. Replayed by tests/combat.test.ts
 * and server/internal/rules/magic_vectors_test.go.
 */
export function magicVectors() {
  const fixture = FIXTURES_BY_KEY.lowLevel;
  const base = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
  const ward = abilityFor('ward-light');
  if (!ward?.numbers?.pulses || !ward.numbers.durationSeconds || !ward.numbers.pulseHealFraction) throw new Error('ward-light numbers');
  const { pulses, durationSeconds, pulseHealFraction } = ward.numbers;
  const healers = [0, 1, 2.5, 7, 10, 13.37, 33, 50, 60, 99.9, 150, 400, 1000, 100000].map((int) => {
    const kit = getCombatKit({ ...base, class: 'healer', level: 20, stats: { str: 0, int, con: 0, per: 0 } });
    return { int, mend: kit.healAmount, pulse: kit.wardPulseHeal, ward: kit.wardPulseHeal * pulses };
  });
  return {
    healers,
    pulseTimes: { durationSeconds, pulses, at: wardPulseTimes(durationSeconds, pulses) },
    friend: [undefined, 0, -1, 3.544].map((relayed) => ({ relayed: relayed ?? null, pulse: friendPulseHeal(relayed, pulseHealFraction) })),
  };
}

export const serializeMagicVectors = () => JSON.stringify(magicVectors(), null, 2) + '\n';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL('../content/vectors/magic.json', import.meta.url), serializeMagicVectors());
}
