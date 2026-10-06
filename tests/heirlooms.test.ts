import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEIRLOOMS,
  HEIRLOOM_IDS,
  ADA_OIL_REPLIES,
  knowsHollisName,
  countAdaOilGifts,
  grantedHeirlooms,
  heirloomJournalEntries,
  allHeirloomLines,
  allHeirloomJournal,
  type HeirloomId,
} from '../src/content/heirlooms.ts';

test('all four heirlooms are defined with canon details', () => {
  assert.equal(HEIRLOOM_IDS.length, 4);
  const expected: HeirloomId[] = [
    'brack-felling-axe',
    'orrins-mason-pick',
    'ada-garden-spade',
    'nans-lamplighter-pole',
  ];
  assert.deepEqual([...HEIRLOOM_IDS], expected);

  for (const id of HEIRLOOM_IDS) {
    const h = HEIRLOOMS[id];
    assert.ok(h, `missing heirloom ${id}`);
    assert.equal(h.id, id);
    assert.ok(h.name.length > 0);
    assert.ok(h.speaker.length > 0);
    assert.ok(h.toast.length > 0);
    assert.ok(h.journal.title.length > 0);
    assert.ok(h.journal.body.length > 0);

    // Dialogue rules: 2-4 lines, each <= 160 chars
    assert.ok(h.dialogueLines.length >= 2 && h.dialogueLines.length <= 4, `${id} lines count: ${h.dialogueLines.length}`);
    for (const line of h.dialogueLines) {
      assert.ok(line.length > 0 && line.length <= 160, `${id} line length ${line.length}: ${line}`);
    }
  }
});

test('Ada oil replies are short, cozy, and within 160 chars', () => {
  for (const [n, lines] of Object.entries(ADA_OIL_REPLIES)) {
    assert.ok(lines.length > 0, `gift ${n} has no lines`);
    for (const line of lines) {
      assert.ok(line.length <= 160, `gift ${n} line too long: ${line}`);
    }
  }
});

test('knowsHollisName needs a flag that names Hollis, not quest progress', () => {
  // New game: false
  assert.equal(knowsHollisName([], 'new'), false);
  assert.equal(knowsHollisName([], 'accepted'), false);

  // Quest progress alone: false
  assert.equal(knowsHollisName([], 'clue-found'), false, 'quest progress alone is not enough');
  assert.equal(knowsHollisName([], 'guardian-defeated'), false, 'quest progress alone is not enough');
  assert.equal(knowsHollisName([], 'lantern-lit'), false, 'quest progress alone is not enough');
  assert.equal(knowsHollisName([], 'complete'), false);
  assert.equal(knowsHollisName(['echo:hollis'], 'new'), true);
  assert.equal(knowsHollisName(['paper:silas-pine-offcut-scrap'], 'new'), true);

  // Early stage but read the ledger: true
  assert.equal(knowsHollisName(['paper:ashwatch-ledger-excerpts'], 'new'), true);
  assert.equal(knowsHollisName(['paper:ashwatch-ledger-excerpts'], 'accepted'), true);

  // Early stage but returned Hollis's whittled fox: true
  assert.equal(knowsHollisName(['returned:whittled-fox'], 'new'), true);
});

test('countAdaOilGifts tracks gift count from flags', () => {
  assert.equal(countAdaOilGifts([]), 0);
  assert.equal(countAdaOilGifts(['other-flag']), 0);
  assert.equal(countAdaOilGifts(['ada-oil-gifts:1']), 1);
  assert.equal(countAdaOilGifts(['ada-oil-gifts:1', 'ada-oil-gifts:2']), 2);
  assert.equal(countAdaOilGifts(['ada-oil-gifts:1', 'ada-oil-gifts:2', 'ada-oil-gifts:3']), 3);
});

test('grantedHeirlooms and heirloomJournalEntries reflect saved flags', () => {
  const flags = ['heirloom:brack-felling-axe', 'heirloom:orrins-mason-pick'];
  const granted = grantedHeirlooms(flags);
  assert.deepEqual(granted, ['brack-felling-axe', 'orrins-mason-pick']);

  const entries = heirloomJournalEntries(flags);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, HEIRLOOMS['brack-felling-axe'].journal.title);
  assert.equal(entries[1].title, HEIRLOOMS['orrins-mason-pick'].journal.title);
});

test('allHeirloomLines and allHeirloomJournal gather all authored text', () => {
  const lines = allHeirloomLines();
  assert.ok(lines.length >= 14); // 4 heirlooms * 3 lines + 2 Ada replies = 14 lines
  for (const l of lines) {
    assert.ok(l.length <= 160);
  }

  const journals = allHeirloomJournal();
  assert.equal(journals.length, 4);
});
