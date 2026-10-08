import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  HEIRLOOM_REFUSALS,
  NORTH_BRIDGE_DONE,
  RESIDENT_REACH_TILES,
  heirloomReadiness,
  heirloomRefusalFor,
  heirloomRefusalLine,
  type HeirloomContext,
} from '../src/content/heirlooms.ts';
import { ITEM_RULES } from '../src/lib/items.ts';

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

// ------------------------------------------------------------ playtest 1: offers the server will grant


const centre = (t: { tx: number; ty: number }) => ({ x: t.tx * 16 + 8, y: t.ty * 16 + 8 });
const silasRow = ITEM_RULES.menders.find((m) => m.npc === 'silas')!;
const orrinRow = ITEM_RULES.menders.find((m) => m.npc === 'orrin')!;
const adaRow = ITEM_RULES.residents.find((r) => r.id === 'ada')!;

function ctx(over: Partial<HeirloomContext>): HeirloomContext {
  return { area: 'commons', ...centre(silasRow), flags: [], worldFlags: [], online: true, inFlight: false, ...over };
}

test('Silas offers the axe only where and when the server grants it', () => {
  const knows = ['echo:hollis'];
  assert.deepEqual(heirloomReadiness('brack-felling-axe', ctx({ flags: knows })), { ok: true });
  // No beat at all before Hollis's name is known, or once the axe is given.
  assert.equal(heirloomReadiness('brack-felling-axe', ctx({})), null);
  assert.equal(heirloomReadiness('brack-felling-axe', ctx({ flags: [...knows, 'heirloom:brack-felling-axe'] })), null);
  // The server's radius (the mender row's radiusTiles), measured from the row's tile centre.
  const at = centre(silasRow);
  const r = silasRow.radiusTiles * 16;
  assert.deepEqual(heirloomReadiness('brack-felling-axe', ctx({ flags: knows, x: at.x + r, y: at.y })), { ok: true });
  assert.deepEqual(heirloomReadiness('brack-felling-axe', ctx({ flags: knows, x: at.x + r + 1, y: at.y })), { ok: false, why: 'too-far' });
  assert.deepEqual(heirloomReadiness('brack-felling-axe', ctx({ flags: knows, area: 'village' })), { ok: false, why: 'too-far' });
  assert.deepEqual(heirloomReadiness('brack-felling-axe', ctx({ flags: knows, online: false })), { ok: false, why: 'offline' });
  assert.deepEqual(heirloomReadiness('brack-felling-axe', ctx({ flags: knows, inFlight: true })), { ok: false, why: 'busy' });
});

test('Orrin, Ada and Nan\'s camp use the server\'s conditions and reach', () => {
  const orrin = { area: orrinRow.area, ...centre(orrinRow) };
  assert.equal(heirloomReadiness('orrins-mason-pick', ctx({ ...orrin })), null, 'the bridge must stand first');
  assert.deepEqual(heirloomReadiness('orrins-mason-pick', ctx({ ...orrin, worldFlags: [NORTH_BRIDGE_DONE] })), { ok: true });
  assert.deepEqual(heirloomReadiness('orrins-mason-pick', ctx({ ...orrin, x: orrin.x, y: orrin.y + orrinRow.radiusTiles * 16 + 2, worldFlags: [NORTH_BRIDGE_DONE] })), { ok: false, why: 'too-far' });

  const ada = { area: adaRow.area, ...centre(adaRow) };
  assert.equal(heirloomReadiness('ada-garden-spade', ctx({ ...ada, flags: ['ada-oil-gifts:2'] })), null);
  assert.deepEqual(heirloomReadiness('ada-garden-spade', ctx({ ...ada, flags: ['ada-oil-gifts:3'] })), { ok: true });
  assert.deepEqual(heirloomReadiness('ada-garden-spade', ctx({ ...ada, x: ada.x - RESIDENT_REACH_TILES * 16 - 1, flags: ['ada-oil-gifts:3'] })), { ok: false, why: 'too-far' });

  assert.equal(heirloomReadiness('nans-lamplighter-pole', ctx({ area: 'wilds' })), null, 'Nan\'s echo must be settled');
  assert.deepEqual(heirloomReadiness('nans-lamplighter-pole', ctx({ area: 'wilds', flags: ['echo:nan'] })), { ok: true });
  assert.deepEqual(heirloomReadiness('nans-lamplighter-pole', ctx({ area: 'village', flags: ['echo:nan'] })), { ok: false, why: 'too-far' });
});

test('the resident reach is the server\'s, and every server refusal has a giver\'s reply', () => {
  const go = readFileSync(new URL('../server/internal/api/item_slots.go', import.meta.url), 'utf8');
  assert.equal(Number(/const residentReachTiles = (\d+)/.exec(go)?.[1]), RESIDENT_REACH_TILES);
  // grantHeirloom's codes, as the giver hears them.
  assert.equal(heirloomRefusalFor('too-far-away'), 'too-far');
  assert.equal(heirloomRefusalFor('condition-unmet'), 'not-yet');
  assert.equal(heirloomRefusalFor('already-granted'), 'granted');
  assert.equal(heirloomRefusalFor('offline'), 'offline');
  assert.equal(heirloomRefusalFor('busy'), 'busy');
  assert.equal(heirloomRefusalFor('internal'), 'failed');
  for (const id of HEIRLOOM_IDS) {
    for (const why of ['too-far', 'not-yet', 'granted', 'offline', 'busy', 'failed'] as const) {
      const { speaker, line } = heirloomRefusalLine(id, why);
      assert.equal(speaker, HEIRLOOMS[id].speaker, 'the giver says it, in the conversation');
      assert.ok(line.length > 0 && line.length <= 160, `${id}/${why}: ${line}`);
      assert.ok(allHeirloomLines().includes(line));
    }
    assert.equal(Object.keys(HEIRLOOM_REFUSALS[id]).length, 6);
  }
});
