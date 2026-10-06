import test from 'node:test';
import assert from 'node:assert/strict';
import { hasWitnessed, isWitnessBeat, witnessCopy, witnessFlag, witnessJournalEntries, witnessMoment, witnessName } from '../src/content/witness.ts';
import { journalEntries } from '../src/content/world.ts';
import { ECHOES } from '../src/content/echoes.ts';

const LONG = 'Bartholomew-the-Extraordinarily-Long-Named-Keeper-of-Lamps';

test('only the three shared beats are witnessed', () => {
  for (const b of ['warden', 'lantern', 'echo:hollis', 'echo:nan']) assert.ok(isWitnessBeat(b), b);
  for (const b of ['clue', 'echo:', 'echo:stranger', 'echo:nan:softened', '', null, 3]) assert.ok(!isWitnessBeat(b), String(b));
  // The Six, as the Echo camps know them.
  for (const e of ECHOES) assert.ok(isWitnessBeat(`echo:${e.member}`), e.member);
});

test('a witness flag is kept once per beat and traveler, and is never an economy flag', () => {
  const f = witnessFlag('echo:nan', 'olive-id', 'Olive');
  assert.equal(f, 'witness:echo-nan:olive-id:Olive');
  assert.ok(f.length <= 128);
  assert.ok(witnessFlag('warden', '0123456789abcdef0123456789abcdef0123', LONG).length <= 128);
  assert.doesNotMatch(f, /^(embers:|lit:|opened:)/);
  // Once: a renamed traveler is still the same traveler.
  assert.ok(hasWitnessed([f], 'echo:nan', 'olive-id'));
  assert.ok(!hasWitnessed([f], 'echo:tam', 'olive-id'));
  assert.ok(!hasWitnessed([f], 'echo:nan', 'bob-id'));
  assert.ok(!hasWitnessed([witnessFlag('echo:nan', 'olive-id-2', 'Olive')], 'echo:nan', 'olive-id'));
  assert.equal(witnessName('  \u0007 '), 'A fellow traveler');
});

test('the journal says "you were there", in voice and short, without naming whose Echo it was', () => {
  const flags = [witnessFlag('warden', 'o', 'Olive'), witnessFlag('lantern', 'o', 'Olive'), witnessFlag('echo:bett', 'r', 'Rue'), 'echo:hollis'];
  const entries = witnessJournalEntries(flags);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((e) => e.title === witnessCopy.journalTitle));
  assert.match(entries[0].body, /Olive spoke the naming/);
  assert.match(entries[2].body, /Rue/);
  // Never the Echo's owner: that is the settler's to learn.
  for (const e of entries) for (const echo of ECHOES) assert.ok(!e.body.includes(echo.name.split(' ')[0]), echo.name);
  // And they join the journal (not before, with no flags).
  assert.equal(journalEntries('new', flags).filter((e) => e.title === witnessCopy.journalTitle).length, 3);
  assert.equal(journalEntries('new', []).filter((e) => e.title === witnessCopy.journalTitle).length, 0);
  const samples: string[] = [witnessCopy.wardenRises, witnessCopy.wardenFloat, witnessCopy.journalTitle];
  for (const name of ['Olive', LONG, '']) {
    for (const b of ['warden', 'lantern', 'echo:nan'] as const) samples.push(witnessMoment(b, name));
    samples.push(...witnessJournalEntries([witnessFlag('warden', 'x', name), witnessFlag('lantern', 'x', name), witnessFlag('echo:tam', 'x', name)]).map((e) => e.body));
  }
  for (const s of samples) {
    assert.ok(s.length > 0 && s.length <= 160, `${s.length}: ${s}`);
    assert.doesNotMatch(s, /undefined|NaN|habitica|reward|\bembers?\b/i, s);
  }
});
