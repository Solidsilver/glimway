import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/clock.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { recovered, nextTurning, calendarAt, validateCalendar } from '../src/lib/clock.ts';
import { refusalMatchesRule } from './helpers/vector-rule.ts';
import { QUESTS, STORY, VITALS, PAPER_RULES, validatePapers } from '../src/lib/story-tables.ts';
// The calendar loader vectors: the shipped clock plus mutations, each
// refusal naming its rule — the same file the Go test runs.
for (const v of vectors.loader) test(`shared calendar loader: ${v.name}`, () => {
  const base = JSON.parse(readFileSync(new URL('../content/clock.json', import.meta.url), 'utf8'));
  const value = structuredClone(base);
  for (const e of v.edits) { let target = value as any; for (const key of e.path.slice(0, -1)) target = target[key]; if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value; }
  if (v.valid) assert.doesNotThrow(() => validateCalendar(value));
  else assert.throws(() => validateCalendar(value), (e: Error) => refusalMatchesRule(e, v.rule), v.rule);
});
test('shared clock recovery vectors', () => { for (const v of vectors.recovery) assert.equal(recovered(v.stored,v.rate,v.cap,v.since,v.now),v.expected); assert.equal(nextTurning(0),calendarAt(0).nextTurning); });
test('shared server story tables validate', () => { assert.equal(QUESTS[0]!.id,'lantern-road'); assert.equal(STORY.namespaces.find(n => n.prefix === 'paper:')?.writer,'server'); assert.equal(VITALS.regenCap,16); });

test('paper loader retains full rules and rejects incomplete catalogs', () => {
 assert.equal(PAPER_RULES.get('joss-penhallow-letter-map-case')?.unbuilt, true);
 assert.equal(PAPER_RULES.get('mary-fenns-cairn-slip')?.paper, 'will-of-elias-fenn');
 assert.throws(() => validatePapers({ papers: [{ id: 'p', collection: 'c', source: 'placed', rule: { kind: 'placed' } }] }));
});
