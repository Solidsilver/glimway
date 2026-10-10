import test from 'node:test';
import assert from 'node:assert/strict';
import vitalsRaw from '../content/vitals.json' with { type: 'json' };
import combatRaw from '../content/combat.json' with { type: 'json' };
import contractRaw from '../content/contract.json' with { type: 'json' };
import papersRaw from '../content/papers.json' with { type: 'json' };
import storyRaw from '../content/story.json' with { type: 'json' };
import vitalsVectors from '../content/vectors/vitals.json' with { type: 'json' };
import combatVectors from '../content/vectors/combat.json' with { type: 'json' };
import contractVectors from '../content/vectors/contract.json' with { type: 'json' };
import papersVectors from '../content/vectors/papers.json' with { type: 'json' };
import storyVectors from '../content/vectors/story.json' with { type: 'json' };
import { VITALS, validateVitals, PAPER_RULES, validatePapers, STORY, validateStory } from '../src/lib/story-tables.ts';
import { validateCombat } from '../src/lib/combat-timing.ts';
import { CONTRACT_NUMBER, validateContract } from '../src/lib/contract.ts';
import { refusalMatchesRule } from './helpers/vector-rule.ts';

interface Edit { path: (string | number)[]; value?: unknown; remove?: boolean }
function edited(base: unknown, edits: Edit[]): unknown {
  const value = structuredClone(base);
  for (const e of edits) { let target = value as any; for (const key of e.path.slice(0, -1)) target = target[key]; if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value; }
  return value;
}

// Every family ships loader vectors: the shipped file plus mutations,
// each refusal naming its rule — the same file the Go test runs.
const families: [string, unknown, { name: string; valid: boolean; rule?: string; edits: Edit[] }[], (v: unknown) => unknown][] = [
  ['vitals', vitalsRaw, vitalsVectors.loader, validateVitals],
  ['combat', combatRaw, combatVectors.loader, validateCombat],
  ['contract', contractRaw, contractVectors.loader, validateContract],
  ['papers', papersRaw, papersVectors.loader, validatePapers],
  ['story', storyRaw, storyVectors.loader, validateStory],
];
for (const [family, base, vectors, validate] of families) {
  for (const v of vectors) test(`shared ${family} loader: ${v.name}`, () => {
    const value = edited(base, v.edits);
    if (v.valid) assert.doesNotThrow(() => validate(value));
    else assert.throws(() => validate(value), (e: Error) => refusalMatchesRule(e, v.rule!), v.rule);
  });
}

test('the shipped tables load through the schemas', () => {
  assert.equal(VITALS.regenCap, 16);
  assert.equal(CONTRACT_NUMBER, 6);
  assert.equal(STORY.namespaces.find(n => n.prefix === 'paper:')?.writer, 'server');
  // The reshaped ids read back as the map of maps the client speaks.
  assert.equal(STORY.ids['defeated:']?.['stone-warden'], 'ruin');
  assert.equal(PAPER_RULES.get('joss-penhallow-letter-map-case')?.unbuilt, true);
  assert.equal(PAPER_RULES.get('mary-fenns-cairn-slip')?.paper, 'will-of-elias-fenn');
});
