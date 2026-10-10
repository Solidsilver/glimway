import test from 'node:test';
import assert from 'node:assert/strict';
import { DEED_PANEL_COPY, PELL, PELL_DEED, allPellLines, allPellProse } from '../src/content/pell.ts';
import { SILAS_YARD } from '../src/content/expansion-writing.ts';
import { homeErrorText } from '../src/content/errors.ts';

/** The old currencies: glims are meant everywhere in the Yard and the deed office (silas-yard.md 1.8). */
const OLD_COIN = /\b(embers?|gold)\b/i;
/** The text rules tests/world.test.ts holds the story to. */
const OUT_OF_WORLD = /\b(habitica|xp|habits?|tasks?|to-?dos?|dailies|streaks?|app)\b/i;

function yardLines(): string[] {
  const { tabQuotes, spots, ...talk } = SILAS_YARD;
  const { build, ...tabs } = tabQuotes;
  return [...Object.values(talk), ...Object.values(build), ...Object.values(tabs), ...Object.values(spots)];
}

test('Pell meets you in a few short lines and has a rotation of six to eight (silas-yard.md 2.6)', () => {
  assert.equal(PELL.name, 'Pell');
  assert.equal(PELL.firstMeeting.speaker, 'Pell');
  assert.ok(PELL.firstMeeting.lines.length >= 2 && PELL.firstMeeting.lines.length <= 4);
  assert.ok(PELL.idleLines.length >= 6 && PELL.idleLines.length <= 8);
  assert.equal(new Set(PELL.idleLines).size, PELL.idleLines.length, 'an idle line repeats');
  // The design's line opens the rotation, and the first meeting says where Pell came from.
  assert.equal(PELL.idleLines[0], 'Plot ledger’s open. Mind the ink.');
  assert.match(PELL.firstMeeting.lines.join(' '), /Count House/);
  assert.match(PELL.firstMeeting.lines.join(' '), /timber, not ink/);
});

test('every Pell, deed-panel and Yard line is non-empty, fits the box, stays in-world and says glims', () => {
  const lines = [...allPellLines(), ...yardLines()];
  assert.ok(lines.length > 50);
  for (const line of lines) {
    assert.ok(line.trim().length > 0, 'an empty line');
    assert.equal(line, line.trim(), `stray whitespace: "${line}"`);
    assert.ok(line.length <= 160, `${line.length} chars: ${line}`);
    assert.doesNotMatch(line, OUT_OF_WORLD, line);
    assert.doesNotMatch(line, OLD_COIN, line);
    assert.doesNotMatch(line, /undefined|NaN|\{|\}/, line);
  }
  for (const text of allPellProse()) {
    assert.ok(text.trim().length > 0);
    assert.doesNotMatch(text, OUT_OF_WORLD, text);
    assert.doesNotMatch(text, OLD_COIN, text);
  }
});

test('the deed lines read their numbers: first deed free, glims after, the ink window in words', () => {
  assert.equal(PELL_DEED.buyNote(0), 'First deed: free');
  assert.equal(PELL_DEED.buyNote(10), '10 glims');
  assert.equal(PELL_DEED.buyNote(1), '1 glim');
  assert.equal(PELL_DEED.buyShort(10), 'Needs 10 glims');
  assert.match(PELL_DEED.bought('Lot 3', 0), /nothing to pay/);
  assert.match(PELL_DEED.bought('Lot 3', 10), /^10 glims, received/);
  assert.match(PELL_DEED.signedWaiting(60), /about a minute\.$/);
  assert.match(PELL_DEED.signedWaiting(120), /about 2 minutes\.$/);
  assert.match(PELL_DEED.signedWaiting(30), /about 30 seconds\.$/);
  // Giving up: Pell strikes the name, and the take-back window is said only when nobody's left on the deed.
  assert.match(PELL_DEED.giveUpShared('Tansy’s Place'), /^Pell strikes your name from Tansy’s Place\./);
  assert.match(PELL_DEED.giveUpAlone('Tansy’s Place', 3, 14), /^Pell strikes your name from Tansy’s Place\..*after 3 days.*after 14 days/);
  assert.notDeepEqual(PELL_DEED.struck(true), PELL_DEED.struck(false));
  assert.equal(DEED_PANEL_COPY.giveUp, 'Give up your place on the deed');
});

test('Silas points at Pell for deeds, has a quote for every tab, and a label for every display', () => {
  assert.match(SILAS_YARD.pellPointer, /^Pell keeps the deeds, through the side door\./);
  assert.match(SILAS_YARD.pellPointerGuest, /^Pell keeps the deeds/);
  assert.match(SILAS_YARD.tin, /LEAVE IT IN THE TIN\.$/);
  assert.equal(SILAS_YARD.mendAway, 'Silas mends when he\'s here.');
  assert.deepEqual(Object.keys(SILAS_YARD.tabQuotes).sort(), ['build', 'furnish', 'materials', 'mend']);
  assert.deepEqual(Object.keys(SILAS_YARD.tabQuotes.build).sort(), ['built', 'camp', 'cottage']);
  assert.deepEqual(
    [SILAS_YARD.spots.furnish, SILAS_YARD.spots.materials, SILAS_YARD.spots.mend],
    ['Look at the pieces', 'Look at the timber', 'Look at the mending bench'],
  );
  // Silas no longer sells deeds or signs them at his table.
  for (const line of yardLines()) assert.doesNotMatch(line, /I['’]ll (sell|draw) you|my table/, line);
  assert.doesNotMatch(homeErrorText('not-at-table'), /Silas/);
  assert.match(homeErrorText('not-at-table'), /Pell/);
});
