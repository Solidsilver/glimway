import test from 'node:test';
import assert from 'node:assert/strict';
import { REPAIR_RULES, repairFor, repairsForArea } from '../src/lib/repairs.ts';
import { allKeepsakeLines, echoKeepsakeOffer, keepsakeAsk, keepsakeReturnAction, keepsakeSpeaker, keepsakeThanks, parseKeepsakeAction } from '../src/game/keepsakes.ts';
import { itemDef, ITEMS, ITEM_RULES } from '../src/lib/items.ts';
import { CRAFTING } from '../src/lib/workshop.ts';
import { buildArea } from '../src/game/worlds.ts';

test('repairs rules match crafting and lore canon', () => {
  assert.equal(REPAIR_RULES.rules.maxOpen, 3);
  assert.equal(REPAIR_RULES.rules.perWick, 1);
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

  // The hame waits for its Carting Day window (content, read finding 2);
  // the well never breaks again (N1): water is a dependency, not a chore.
  assert.deepEqual(hame.openFrom, { wick: 'Cart', day: 5 });
  assert.equal(repairFor('well-rope')?.weather, false);
  assert.equal(repairFor('fence-rail')?.weather ?? true, true);
  for (const r of REPAIR_RULES.repairs) {
    if (!r.openFrom) continue;
    assert.ok(r.openFrom.day >= 1 && r.openFrom.day <= 7, `openFrom day of ${r.id}`);
  }
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
  // The thanks wait for the server's yes: the choice closes on a neutral
  // line, and the words come from keepsakeThanks after the return lands.
  assert.deepEqual(ask.choices[0].reply, ['You hold it out.']);
  assert.doesNotMatch(ask.choices[0].reply?.join(' ') ?? '', /knot|receipts|leaf/);
  assert.match(keepsakeThanks('knotted-halter').join(' '), /oil receipts/);
  assert.equal(keepsakeSpeaker('ada'), 'Ada');
  assert.equal(keepsakeSpeaker('silas'), 'Silas');
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

test('carrying an ownerless keepsake at its Echo camp offers to leave it there', () => {
  // Nan's road-nails at her camp: the leave goes through the server's
  // `return` op (the same action the residents' talk uses).
  const offer = echoKeepsakeOffer('nan', [], ['road-nails']);
  assert.ok(offer);
  assert.equal(offer.def, 'road-nails');
  assert.equal(offer.label, 'Leave the eleven road-nails here');
  assert.equal(offer.action, 'keep:return:road-nails:nan');
  assert.ok(offer.lines.length > 0);
  assert.ok(offer.guest.length > 0);
  // Bett's candle at hers.
  const bett = echoKeepsakeOffer('bett', [], ['beeswax-candle', 'road-nails']);
  assert.ok(bett);
  assert.equal(bett.def, 'beeswax-candle');
  assert.equal(bett.action, 'keep:return:beeswax-candle:bett');
  // Not carried, already left, or no keepsake at that camp: no offer.
  assert.equal(echoKeepsakeOffer('nan', [], []), null);
  assert.equal(echoKeepsakeOffer('nan', ['returned:road-nails'], ['road-nails']), null);
  assert.equal(echoKeepsakeOffer('dorrit', [], ['work-glove']), null);
  assert.equal(echoKeepsakeOffer('hollis', [], ['whittled-fox']), null);
  // The camp's offers belong to their person: nails are not Bett's.
  assert.equal(echoKeepsakeOffer('bett', [], ['road-nails']), null);
});

test('every repair part has a source a player can get', () => {
  const sources = new Set<string>();
  for (const r of CRAFTING.recipes) if (r.output.kind === 'item') sources.add(r.output.id);
  for (const p of ITEMS.pickups) sources.add(p.item);
  for (const r of REPAIR_RULES.repairs) {
    assert.ok(sources.has(r.part), `repair ${r.id} needs ${r.part}, which has no recipe or pickup`);
  }
  // The design's bills for the three parts the first review found missing
  // (fine work wants seasoned timber: the oak slat, per the crafting doc).
  const bill = (id: string) => CRAFTING.recipes.find((r) => r.output.id === id);
  assert.deepEqual(bill('split-rail')?.materials, { timber: 2, 'wooden-peg': 2 });
  assert.deepEqual(bill('slates')?.materials, { stone: 3 });
  assert.equal(bill('slates')?.output.qty, 3);
  assert.deepEqual(bill('oak-slat')?.materials, { 'seasoned-timber': 1, 'wooden-peg': 1 });
});

test('the world is built from the shared spots the server checks', () => {
  // The well, Ada and Hazel stand where the shared content says (the
  // server's draw-water and keepsake-return checks read the same rows).
  const v = buildArea('village');
  const well = repairFor('well-rope')!.pos;
  assert.deepEqual(v.well, { tx: well.tx, ty: well.ty });
  for (const res of ITEM_RULES.residents) {
    const npc = buildArea(res.area).npcs.find((n) => n.id === res.id);
    assert.ok(npc, `${res.id} stands in ${res.area}`);
    assert.deepEqual({ tx: npc!.tx, ty: npc!.ty }, { tx: res.tx, ty: res.ty });
  }
  // Silas from the menders rows, in the Commons.
  const c = buildArea('commons');
  const silas = ITEM_RULES.menders.find((m) => m.npc === 'silas')!;
  assert.ok(silas);
  const silasInteractable = c.npcs.find((n) => n.id === 'silas');
  if (silasInteractable) assert.deepEqual({ tx: silasInteractable.tx, ty: silasInteractable.ty }, { tx: silas.tx, ty: silas.ty });
});
