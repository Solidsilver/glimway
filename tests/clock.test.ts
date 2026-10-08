import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/clock.json' with { type: 'json' };
import { recovered, nextTurning, calendarAt } from '../src/lib/clock.ts';
import { QUESTS, STORY, VITALS, PAPER_RULES, validatePapers } from '../src/lib/story-tables.ts';
test('shared clock recovery vectors', () => { for (const v of vectors.recovery) assert.equal(recovered(v.stored,v.rate,v.cap,v.since,v.now),v.expected); assert.equal(nextTurning(0),calendarAt(0).nextTurning); });
test('shared server story tables validate', () => { assert.equal(QUESTS[0]!.id,'lantern-road'); assert.equal(STORY.namespaces.find(n => n.prefix === 'paper:')?.writer,'server'); assert.equal(VITALS.regenCap,16); });

test('paper loader retains full rules and rejects incomplete catalogs', () => {
 assert.equal(PAPER_RULES.get('joss-penhallow-letter-map-case')?.unbuilt, true);
 assert.equal(PAPER_RULES.get('mary-fenns-cairn-slip')?.paper, 'will-of-elias-fenn');
 assert.throws(() => validatePapers({ papers: [{ id: 'p', collection: 'c', source: 'placed', rule: { kind: 'placed' } }] }));
});
