import test from 'node:test';
import assert from 'node:assert/strict';
import { REPAIR_RULES, repairFor, repairsForArea } from '../src/lib/repairs.ts';
import { allKeepsakeLines, keepsakeAsk, keepsakeReturnAction, parseKeepsakeAction } from '../src/game/keepsakes.ts';
import { itemDef } from '../src/lib/items.ts';

test('repairs rules match crafting and lore canon', () => {
  assert.equal(REPAIR_RULES.rules.maxOpen, 3);
  assert.deepEqual(REPAIR_RULES.rules.scripted, ['well-rope', 'fence-rail']);
  assert.equal(REPAIR_RULES.repairs.length, 6);

  for (const r of REPAIR_RULES.repairs) {
    assert.ok(r.id.length > 0);
    assert.ok(r.reaction.length <= 160, `reaction for ${r.id} exceeds 160 chars`);
    assert.ok(r.description.length <= 160, `description for ${r.id} exceeds 160 chars`);
    assert.ok(r.mendedDescription.length <= 160, `mendedDescription for ${r.id} exceeds 160 chars`);
    // In-world check: no real-world apps or task terms
    for (const text of [r.reaction, r.description, r.mendedDescription, r.name]) {
      assert.doesNotMatch(text, /habitica|todo|task|points|xp|gold/i, `text in ${r.id} contains real-world task term`);
    }
  }

  const well = repairFor('well-rope');
  assert.ok(well);
  assert.equal(well.part, 'fibre-rope');
  assert.equal(well.resident, 'hazel');
  assert.equal(well.reaction, 'Bread tastes of the well again.');

  const fence = repairFor('fence-rail');
  assert.ok(fence);
  assert.equal(fence.part, 'split-rail');
  assert.equal(fence.resident, 'silas');

  const library = repairFor('library-roof');
  assert.ok(library);
  assert.equal(library.part, 'slates');
  assert.equal(library.resident, 'mara');

  const bench = repairFor('bench-slat');
  assert.ok(bench);
  assert.equal(bench.part, 'oak-slat');
  assert.equal(bench.resident, 'orrin');

  const lamp = repairFor('village-lamp');
  assert.ok(lamp);
  assert.equal(lamp.part, 'lamp-wick');
  assert.equal(lamp.resident, 'ada');

  const hame = repairFor('gate-hame');
  assert.ok(hame);
  assert.equal(hame.part, 'oilcloth-wrap');
  assert.equal(hame.area, 'commons');
  assert.equal(hame.resident, 'silas');

  assert.equal(repairsForArea('village').length, 5);
  assert.equal(repairsForArea('commons').length, 1);
});

test('each repair names a real part and a real resident', () => {
  for (const r of REPAIR_RULES.repairs) {
    const part = itemDef(r.part);
    assert.ok(part, `part ${r.part} of ${r.id} is defined`);
    assert.ok(['part', 'material', 'consumable'].includes(part.kind), `part ${r.part} is craftable goods`);
    assert.ok(['hazel', 'silas', 'mara', 'orrin', 'ada'].includes(r.resident), `resident of ${r.id} is a villager`);
    assert.ok(r.gift === undefined || itemDef(r.gift.id), `gift of ${r.id} is a real item`);
  }
});

test('carrying a keepsake adds the line, with give it back and not yet', () => {
  const carried = ['knotted-halter'];
  const ask = keepsakeAsk('ada', [], carried);
  assert.ok(ask);
  assert.match(ask.line, /Tam/);
  assert.equal(ask.choices.length, 2);
  assert.equal(ask.choices[0].text, 'Give it back');
  assert.equal(ask.choices[1].text, 'Not yet');
  assert.equal(ask.choices[0].action, 'keep:return:knotted-halter:ada');
  // Not carried, or already returned: no line at all.
  assert.equal(keepsakeAsk('ada', [], ['tin-whistle']), null);
  assert.equal(keepsakeAsk('ada', ['returned:knotted-halter'], carried), null);
  // A resident with no keepsake in the village, and an unknown one.
  assert.equal(keepsakeAsk('mara', [], ['knotted-halter']), null);
  assert.equal(keepsakeAsk('nobody', [], []), null);
  // Whistle to Hazel, fox to Silas.
  assert.match(keepsakeAsk('hazel', [], ['tin-whistle'])!.line, /Joss/);
  assert.match(keepsakeAsk('silas', [], ['whittled-fox'])!.line, /Hollis/);
});

test('keepsake lines keep the canon rules', () => {
  for (const line of allKeepsakeLines()) {
    assert.ok(line.length <= 160, `line too long (${line.length}): ${line}`);
    assert.doesNotMatch(line, /habitica|todo|task|points|xp|gold|app\b/i, `real-life term in: ${line}`);
  }
  const parsed = parseKeepsakeAction(keepsakeReturnAction('tin-whistle', 'hazel'));
  assert.deepEqual(parsed, { def: 'tin-whistle', target: 'hazel' });
  assert.equal(parseKeepsakeAction('home:claim:3'), null);
});
