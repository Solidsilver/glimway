import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assetKind,
  atZeroRule,
  conditionFraction,
  effectLine,
  giveable,
  heldEffects,
  iconState,
  itemDef,
  itemName,
  ITEMS,
  ITEM_RULES,
  menderNear,
  giftPhrase,
  offHandTuck,
  OFF_HAND_TUCK_MS,
  pickupsIn,
  pocketHelps,
  slotCount,
  usableNow,
  validateItems,
  wearRuleLine,
  toolDullness,
  toolWorkSpeed,
  type Items,
} from '../src/lib/items.ts';
import { fitTargets, groupInventory, modelEntries } from '../src/lib/inventory.ts';
import { CRAFTING, validateCrafting } from '../src/lib/workshop.ts';
import { parseItems, parseItemsAction, parseStorage } from '../src/lib/api/parse.ts';
import type { InstanceView, ItemsView } from '../src/lib/api/types.ts';
import { serializeItemVectors } from '../scripts/items-vectors.ts';
import { buildArea, type WorldData } from '../src/game/worlds.ts';
import { allPlacements } from '../src/content/papers.ts';
import { buildCommons } from '../src/game/commons.ts';

// ------------------------------------------------------------ the data

test('items.json loads with a representative set and the shared rules', () => {
  assert.ok(ITEMS.items.length >= 30);
  const axe = itemDef('bench-axe')!;
  assert.equal(atZeroRule(axe), 'breaks');
  assert.equal(slotCount(axe), 1);
  assert.equal(assetKind(axe), 'instance');
  const brack = itemDef('brack-felling-axe')!;
  assert.equal(atZeroRule(brack), 'blunt');
  assert.equal(slotCount(brack), 3);
  assert.equal(giveable(brack), false, 'heirlooms stay with the one they were given to');
  assert.equal(atZeroRule(itemDef('nans-lamplighter-pole')!), 'cracked');
  assert.equal(atZeroRule(itemDef('oak-mark-punch')!), 'never');
  assert.equal(usableNow(itemDef('keepers-twists')!), true);
  assert.equal(usableNow(itemDef('comfrey-salve')!), true);
  assert.equal(giveable(itemDef('whittled-fox')!), false, 'story keepsakes are kept or returned');
  assert.equal(giveable(itemDef('work-glove')!), true);
  assert.equal(assetKind(itemDef('timber')!), 'material');
  assert.equal(assetKind(itemDef('lamp-wick')!), 'item');
  // Existing ids keep their names (and the new ones carry the catalogue's).
  assert.equal(itemName('lamp-wick'), 'Lamp Wick');
  assert.equal(itemName('whittled-fox'), 'Whittled Fox');
  assert.equal(itemName('wooden-stool'), 'Wooden Stool', 'home goods from homestead.json');
});

test('gift phrases preserve makers, articles, and named pieces', () => {
  assert.equal(giftPhrase('oatcakes', 1), "Finn's oatcakes");
  assert.equal(giftPhrase('blue-moss', 1), 'a pinch of blue moss');
  assert.equal(giftPhrase('empty-chair', 1), 'the Empty Chair');
});

test('the Go loader derives the same rules (content/vectors/items.json is current)', () => {
  assert.equal(readFileSync(new URL('../content/vectors/items.json', import.meta.url), 'utf8'), serializeItemVectors(), 'run npm run vectors:items');
});

test('the validator refuses malformed rows, like content/items.go', () => {
  const cases: [string, (v: Items) => void][] = [
    ['duplicate id', (v) => (v.items[1].id = v.items[0].id)],
    ['unknown kind', (v) => ((v.items[0] as { kind: string }).kind = 'weapon')],
    ['tab mismatch', (v) => (v.items[0].tab = 'supplies')],
    ['cheap tool blunt', (v) => (v.items[0].atZero = 'blunt')],
    ['heirloom without repair', (v) => delete v.items.find((d) => d.id === 'brack-felling-axe')!.repair],
    ['repair with an instance', (v) => (v.items.find((d) => d.id === 'brack-felling-axe')!.repair!.bench = { 'bench-axe': 1 })],
    ['fitting without a kind', (v) => delete v.items.find((d) => d.id === 'loose-road-nail')!.fitting],
    ['unknown use effect', (v) => (v.items.find((d) => d.id === 'oatcakes')!.use = [{ type: 'fly' }])],
    ['pocket help on a tool', (v) => (v.items[0].pocket = [{ type: 'papers-glint' }])],
    ['off-hand item that holds nothing', (v) => delete v.items.find((d) => d.id === 'carters-lantern')!.held],
    ['missing trinket', (v) => (v.items = v.items.filter((d) => d.id !== 'whittled-fox'))],
    ['two tools in one pickup', (v) => (v.pickups.find((p) => p.id === 'dropped-bucket')!.qty = 2)],
    ['pickup off the map of areas', (v) => ((v.pickups[0] as { area: string }).area = 'wilds')],
    ['hold that wears faster', (v) => (v.rules.wear.holdPointsPerUse = 9)],
  ];
  for (const [name, mutate] of cases) {
    const copy = structuredClone(ITEMS);
    mutate(copy);
    assert.throws(() => validateItems(copy), undefined, name);
  }
  assert.doesNotThrow(() => validateItems(structuredClone(ITEMS)));
});

test('recipes make tools as instances and charge any carried stack', () => {
  const axe = CRAFTING.recipes.find((r) => r.id === 'craft-bench-axe')!;
  assert.equal(axe.output.kind, 'instance');
  assert.ok(CRAFTING.recipes.some((r) => 'wooden-peg' in r.materials && 'timber' in r.materials), 'the stave bucket takes pegs');
  const bad = structuredClone(CRAFTING);
  bad.recipes.find((r) => r.id === 'craft-bench-axe')!.output.kind = 'item';
  assert.throws(() => validateCrafting(bad));
});

// ------------------------------------------------------------ helpers

test('wear states pick the delivered icon frames; condition is a fraction', () => {
  assert.equal(iconState('bench-axe', 'whole'), 'whole');
  assert.equal(iconState('bench-axe', 'worn'), 'worn');
  assert.equal(iconState('brack-felling-axe', 'blunt'), 'blunt');
  assert.equal(iconState('nans-lamplighter-pole', 'cracked'), 'cracked');
  assert.equal(iconState('bench-axe', 'dull'), 'worn', 'a dull warden-set tool shows worn');
  assert.equal(iconState('oak-mark-punch', 'whole'), undefined, 'never wears: one frame');
  assert.equal(iconState('timber', 'whole'), undefined);
  assert.equal(conditionFraction({ condition: 45, maxCondition: 90 }), 0.5);
  assert.equal(conditionFraction({ condition: 0, maxCondition: 0 }), 1);
  // Every tool state the server can report has a frame in the items pass.
  const manifest = JSON.parse(readFileSync(new URL('../public/assets/fingersnap/items-pass/manifest.json', import.meta.url), 'utf8')) as { frames: { key: string }[] };
  const frames = new Set(manifest.frames.map((f) => f.key));
  // Every tool that wears has its state frames, or one plain frame (the
  // watering can) that the panel shows in every state.
  for (const d of ITEMS.items.filter((d) => d.kind === 'tool' && atZeroRule(d) !== 'never')) {
    const states = ['whole', 'worn', ...(atZeroRule(d) === 'breaks' ? [] : [atZeroRule(d)])];
    assert.ok(states.every((s) => frames.has(`item-${d.id}-${s}`)) || frames.has(`item-${d.id}`), d.id);
  }
  for (const d of ['brack-felling-axe', 'nans-lamplighter-pole', 'bench-axe']) assert.ok(frames.has(`item-${d}-whole`) && frames.has(`item-${d}-worn`), d);
});

test('helps read as words, never numbers; affinity changes the off-hand help', () => {
  for (const d of ITEMS.items) for (const e of [...(d.use ?? []), ...(d.pocket ?? []), ...(d.held ?? [])]) assert.doesNotMatch(effectLine(e), /\d|%/);
  const lantern = itemDef('carters-lantern')!;
  assert.notDeepEqual(heldEffects(lantern, 'warrior'), heldEffects(lantern, 'rogue'));
  assert.equal(pocketHelps(['whittled-fox', null], 'papers-glint'), true);
  assert.equal(pocketHelps(['work-glove'], 'papers-glint'), false);
  assert.match(wearRuleLine(itemDef('brack-felling-axe')!), /Mend it/);
});

test('the off hand is tucked away while sitting or fighting, and comes back after', () => {
  let t = offHandTuck({ seated: false, fighting: false }, 1000, 0);
  assert.equal(t.tucked, false);
  t = offHandTuck({ seated: false, fighting: true }, 2000, t.until);
  assert.equal(t.tucked, true);
  t = offHandTuck({ seated: false, fighting: false }, 2000 + OFF_HAND_TUCK_MS - 1, t.until);
  assert.equal(t.tucked, true, 'still put away a moment after the swing');
  t = offHandTuck({ seated: false, fighting: false }, 2000 + OFF_HAND_TUCK_MS, t.until);
  assert.equal(t.tucked, false);
  assert.equal(offHandTuck({ seated: true, fighting: false }, 5000, 0).tucked, true);
});

test('menders stand where Silas and Orrin do', () => {
  const commons = buildCommons();
  const village = buildArea('village');
  const silas = ITEM_RULES.menders.find((m) => m.npc === 'silas')!;
  const orrin = ITEM_RULES.menders.find((m) => m.npc === 'orrin')!;
  const o = village.npcs.find((n) => n.id === 'orrin')!;
  assert.deepEqual([orrin.tx, orrin.ty], [o.tx, o.ty]);
  assert.deepEqual([silas.tx, silas.ty], [commons.features.silas.tx, commons.features.silas.ty]);
  assert.equal(menderNear('village', o.tx * 16 + 8, o.ty * 16 + 30)?.npc, 'orrin');
  assert.equal(menderNear('village', 0, 0), null);
  assert.equal(menderNear('commons', o.tx * 16 + 8, o.ty * 16 + 8), null, 'right spot, wrong area');
});

test('a gift reads like a line someone would say', () => {
  assert.equal(giftPhrase('comfrey-salve', 1), 'a comfrey salve');
  assert.equal(giftPhrase('amber-bead', 1), 'an amber bead');
  assert.equal(giftPhrase('lamp-wick', 2), '2 Lamp Wicks');
  assert.equal(giftPhrase('nans-lamplighter-pole', 1), "Nan's lamplighter pole");
});

// ------------------------------------------------------------ pickups

type Tile = { tx: number; ty: number };
const key = (t: Tile) => `${t.tx},${t.ty}`;
function blocked(w: WorldData): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) if (w.solid[y][x]) out.add(key({ tx: x, ty: y }));
  const spots: Tile[] = [...w.trees, ...w.bushes, ...w.rocks, ...w.npcs, ...w.props];
  if (w.well) spots.push(w.well);
  if (w.mural) spots.push(w.mural);
  for (const s of spots) out.add(key(s));
  return out;
}
function reachable(w: WorldData): Set<string> {
  const b = blocked(w);
  const seen = new Set<string>([key(w.spawn)]);
  const queue: Tile[] = [w.spawn];
  while (queue.length) {
    const t = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { tx: t.tx + dx, ty: t.ty + dy };
      if (n.tx < 0 || n.ty < 0 || n.tx >= w.width || n.ty >= w.height || seen.has(key(n)) || b.has(key(n))) continue;
      seen.add(key(n));
      queue.push(n);
    }
  }
  return seen;
}

test('every pickup lies on a walkable, reachable tile, clear of exits and other things to press E at', () => {
  assert.ok(ITEMS.pickups.length >= 3);
  for (const p of ITEMS.pickups) {
    const w = buildArea(p.area);
    const t = { tx: p.tx, ty: p.ty };
    assert.ok(!blocked(w).has(key(t)), `${p.id} at ${key(t)} is not walkable`);
    assert.ok(reachable(w).has(key(t)), `${p.id} at ${key(t)} cannot be reached`);
    assert.ok(!w.exits.some((e) => t.tx >= e.tx - 1 && t.tx <= e.tx + e.tw && t.ty >= e.ty - 1 && t.ty <= e.ty + e.th), `${p.id} sits on an exit`);
    const others: Tile[] = [...w.npcs, ...w.emberSpots, ...w.discoverySpots, ...allPlacements().filter((q) => q.source.area === p.area).map((q) => q.source)];
    for (const s of [w.mural, w.shrine, w.library, w.well]) if (s) others.push(s);
    for (const q of ITEMS.pickups) if (q !== p && q.area === p.area) others.push(q);
    for (const o of others) assert.ok(Math.hypot(o.tx - t.tx, o.ty - t.ty) >= 3, `${p.id} is crowded by ${key(o)}`);
  }
  assert.deepEqual(pickupsIn('village', ['well-rope-coil']).map((p) => p.id), ['oatcake-parcel'], 'taken ones are gone');
});

// ------------------------------------------------------------ the model in the panel

const inst = (id: string, itemDef: string, extra: Partial<InstanceView> = {}): InstanceView => ({
  id,
  itemDef,
  condition: 90,
  maxCondition: 90,
  usesLeft: 30,
  state: 'whole',
  wardenSet: false,
  fittings: [],
  maker: null,
  ...extra,
});

function view(extra: Partial<ItemsView> = {}): ItemsView {
  return {
    stacks: [
      { itemDef: 'timber', qty: 5, maker: null },
      { itemDef: 'lamp-wick', qty: 2, maker: { id: 'wren', name: 'Wren' } },
      { itemDef: 'lamp-wick', qty: 1, maker: null },
      { itemDef: 'whittled-fox', qty: 1, maker: null },
      { itemDef: 'keepers-twists', qty: 3, maker: null },
    ],
    instances: [
      inst('a1', 'bench-axe', { condition: 30, usesLeft: 10, state: 'worn', maker: { id: 'wren', name: 'Wren' } }),
      inst('b1', 'brack-felling-axe', { condition: 0, maxCondition: 240, usesLeft: 0, state: 'blunt' }),
      inst('n1', 'loose-road-nail'),
      inst('l1', 'carters-lantern', { maxCondition: 0, condition: 0, usesLeft: 0 }),
    ],
    pockets: [{ slot: 'pocket-1', itemDef: 'whittled-fox', instance: null }],
    offHand: { open: true, class: 'warrior', itemDef: 'carters-lantern', instance: 'l1' },
    pickedUp: [],
    thanks: [],
    ...extra,
  };
}

test('the item model fills the inventory tabs: one row per maker, one per tool, with what each can do', () => {
  const entries = modelEntries(view(), { pack: ['field-journal', 'hearthwick-map'], decorations: [] });
  const g = groupInventory(entries);
  assert.deepEqual(g.supplies.main.map((e) => e.key).sort(), ['inst:n1', 'item:keepers-twists', 'item:lamp-wick', 'item:lamp-wick@wren', 'material:timber'].sort());
  const wick = entries.find((e) => e.key === 'item:lamp-wick@wren')!;
  assert.equal(wick.maker?.name, 'Wren');
  assert.equal(wick.qty, 2);
  const axe = entries.find((e) => e.key === 'inst:a1')!;
  assert.equal(axe.tab, 'tools');
  assert.equal(axe.stateArt, 'item-bench-axe-worn');
  assert.equal(axe.mendable, false, 'bench tools are not mended');
  assert.equal(axe.giveable, true);
  const brack = entries.find((e) => e.key === 'inst:b1')!;
  assert.equal(brack.stateArt, 'item-brack-felling-axe-blunt');
  assert.equal(brack.mendable, true);
  assert.equal(brack.giveable, false);
  const fox = entries.find((e) => e.key === 'item:whittled-fox')!;
  assert.equal(fox.pocket, 1);
  assert.deepEqual(fox.helps, ['Papers glint brighter']);
  const lantern = entries.find((e) => e.key === 'inst:l1')!;
  assert.equal(lantern.inHand, true);
  assert.equal(lantern.carryable, true);
  assert.ok(lantern.helps!.length >= 2, 'the warrior affinity');
  assert.equal(entries.find((e) => e.key === 'item:keepers-twists')!.usable, true);
  assert.deepEqual(g.tools.road.map((e) => e.id), ['field-journal', 'hearthwick-map'], 'quest things still ride along');
  // Without a class the off hand closes: nothing is carryable.
  const closed = modelEntries(view({ offHand: { open: false, class: null, itemDef: null, instance: null } }), { pack: [], decorations: [] });
  assert.equal(closed.find((e) => e.key === 'inst:l1')!.carryable, false);
});

test('a fitting goes on a tool with a free slot and no fitting of its kind', () => {
  const v = view();
  const nail = v.instances.find((i) => i.id === 'n1')!;
  assert.deepEqual(fitTargets(v, nail).map((t) => t.id), ['a1', 'b1']);
  v.instances[0].fittings = [{ id: 'x', itemDef: 'tarrow-edge-strip', fitting: 'bite', condition: 90, maxCondition: 90, usesLeft: 30, maker: null }];
  assert.deepEqual(fitTargets(v, nail).map((t) => t.id), ['b1'], 'the cheap axe has one slot');
  v.instances[1].fittings = [{ id: 'y', itemDef: 'iron-oak-wedge', fitting: 'hold', condition: 90, maxCondition: 90, usesLeft: 30, maker: null }];
  assert.deepEqual(fitTargets(v, nail).map((t) => t.id), [], 'one of each kind');
});

// ------------------------------------------------------------ parsing

const snapshot = {
  state: { version: 1, area: 'village', position: { x: 1, y: 1 }, quest: 'new', hp: 10, maxHp: 50, mana: 5, maxMana: 30, inventory: [], discoveries: [], defeatedEnemies: [], playSeconds: 0, embers: 0, flags: [], emberXp: 0, xpEmbers: 0 },
  rev: 3,
  vitalsSource: 'demo',
  habiticaId: 'alice',
  displayName: 'Alice',
  habiticaPartyId: null,
  worldId: 'w',
  saveOrigin: 'fresh',
  pending: 0,
  verifiedXp: 0,
  flagged: false,
};

test('item responses parse, and malformed instances are refused', () => {
  const v = view();
  const items = parseItems({ ...snapshot, items: v });
  assert.equal(items.items.instances.length, 4);
  assert.equal(items.items.offHand.class, 'warrior');
  const action = parseItemsAction({ ...snapshot, result: { items: v, wear: { broke: true, state: 'broken', wornOut: [], returned: ['amber-bead'], itemDef: 'bench-axe', usesLeft: 0, condition: 0, instance: null } } });
  assert.equal(action.result.wear?.broke, true);
  assert.deepEqual(action.result.wear?.returned, ['amber-bead']);
  assert.throws(() => parseItems({ ...snapshot, items: { ...v, instances: [{ ...v.instances[0], condition: 99, maxCondition: 90 }] } }));
  assert.throws(() => parseItems({ ...snapshot, items: { ...v, instances: [{ ...v.instances[0], state: 'shiny' }] } }));
});

test('a storage read without a home still carries your own chest', () => {
  const counts = { materials: { stone: 5 }, items: {}, decorations: {}, instances: [] };
  const r = parseStorage({ ...snapshot, home: null, inventory: counts, storage: null, personal: counts, shared: 'not-a-member' });
  assert.equal(r.home, null);
  assert.equal(r.storage, null);
  assert.equal(r.shared, 'not-a-member');
  assert.equal(r.personal.materials.stone, 5);
});

test('warden-set tools compute dullness and working speed correctly', () => {
  // Non-warden tool: dullness 0, speed 1
  assert.equal(toolDullness({ condition: 50, maxCondition: 120, wardenSet: false }), 0);
  assert.equal(toolWorkSpeed({ condition: 50, maxCondition: 120, wardenSet: false }), 1);

  // Sharp warden tool
  assert.equal(toolDullness({ condition: 120, maxCondition: 120, wardenSet: true }), 0);
  assert.equal(toolWorkSpeed({ condition: 120, maxCondition: 120, wardenSet: true }), 1);

  // Half worn
  assert.equal(toolDullness({ condition: 60, maxCondition: 120, wardenSet: true }), 0.5);
  assert.equal(toolWorkSpeed({ condition: 60, maxCondition: 120, wardenSet: true }), 0.75);
  // Half worn with Bite
  assert.equal(toolWorkSpeed({ condition: 60, maxCondition: 120, wardenSet: true, fittings: [{ fitting: 'bite' }] }), 0.88);

  // Dullest (0 condition)
  assert.equal(toolDullness({ condition: 0, maxCondition: 120, wardenSet: true }), 1);
  assert.equal(toolWorkSpeed({ condition: 0, maxCondition: 120, wardenSet: true }), 0.5);
  // Dullest with Bite
  assert.equal(toolWorkSpeed({ condition: 0, maxCondition: 120, wardenSet: true, fittings: [{ fitting: 'bite' }] }), 0.75);
});

test('modelEntries formats warden-set descriptions across all dullness stages', () => {
  const baseView: ItemsView = {
    stacks: [],
    instances: [
      { id: 'w1', itemDef: 'bench-axe', condition: 120, maxCondition: 120, usesLeft: 40, state: 'whole', wardenSet: true, fittings: [{ id: 'f1', itemDef: 'warden-sliver', fitting: 'remember', condition: 0, maxCondition: 0, usesLeft: 0, maker: null }], maker: null },
      { id: 'w2', itemDef: 'bench-axe', condition: 60, maxCondition: 120, usesLeft: 20, state: 'whole', wardenSet: true, fittings: [{ id: 'f2', itemDef: 'warden-sliver', fitting: 'remember', condition: 0, maxCondition: 0, usesLeft: 0, maker: null }], maker: null },
      { id: 'w3', itemDef: 'bench-axe', condition: 0, maxCondition: 120, usesLeft: 0, state: 'dull', wardenSet: true, fittings: [{ id: 'f3', itemDef: 'warden-sliver', fitting: 'remember', condition: 0, maxCondition: 0, usesLeft: 0, maker: null }], maker: null },
      { id: 'w4', itemDef: 'bench-axe', condition: 0, maxCondition: 120, usesLeft: 0, state: 'dull', wardenSet: true, fittings: [{ id: 'f4', itemDef: 'warden-sliver', fitting: 'remember', condition: 0, maxCondition: 0, usesLeft: 0, maker: null }, { id: 'f5', itemDef: 'tarrow-edge-strip', fitting: 'bite', condition: 10, maxCondition: 10, usesLeft: 10, maker: null }], maker: null },
    ],
    pockets: [],
    offHand: { open: false, class: null, itemDef: null, instance: null },
    pickedUp: [],
    thanks: [],
  };

  const entries = modelEntries(baseView, { pack: [], decorations: [] });
  const e1 = entries.find((e) => e.key === 'inst:w1')!;
  assert.equal(e1.rule, 'Warden-set: sharp. Never breaks; dulls with use and heals overnight or on a lit tool rack.');

  const e2 = entries.find((e) => e.key === 'inst:w2')!;
  assert.equal(e2.rule, 'Warden-set: dulling with use (20 uses left). Heals overnight or on a lit tool rack.');

  const e3 = entries.find((e) => e.key === 'inst:w3')!;
  assert.equal(e3.rule, 'Warden-set: at its dullest (works at half speed). Sharp by morning or after an hour on a lit tool rack.');

  const e4 = entries.find((e) => e.key === 'inst:w4')!;
  assert.equal(e4.rule, 'Warden-set: at its dullest (works at three-quarters speed). Sharp by morning or after an hour on a lit tool rack.');
});
