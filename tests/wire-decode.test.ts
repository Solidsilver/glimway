import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorld, parseWorldChoice } from '../src/lib/api/world.ts';
import { parseHome, parseShelf } from '../src/lib/api/homestead.ts';
import { parseItems, parseItemsAction } from '../src/lib/api/items.ts';
import { parseMail, parseCraft } from '../src/lib/api/village.ts';
import type { JsonValue } from '@bufbuild/protobuf';

/**
 * The migrated response parsers decode through the strict wire decoder
 * (`decodeWire`, as operations do): HTTP's one JSON spelling — canonical
 * names, real numbers — and every known field present, since the server
 * emits them all (EmitUnpopulated). Unknown future fields stay tolerated.
 */

const state = { version: 1, area: 'village', position: { x: 1, y: 1 }, quest: 'new', hp: 10, maxHp: 50, mana: 5, maxMana: 30, inventory: [], discoveries: [], defeatedEnemies: [], playSeconds: 0, embers: 0, flags: [], emberXp: 0, xpEmbers: 0 };
const snapshot = { state, version: 3, vitalsSource: 'demo' as const, accountId: 'alice', displayName: 'Alice', habiticaPartyId: null, worldId: 'w', pending: 0, verifiedXp: 0, flagged: false };

const worldRef = { id: 'w1', ownerId: 'o', ownerName: 'Ora', members: 2, ownerHere: true, party: true };
const worldView = {
  world: worldRef,
  isOwner: true,
  inParty: true,
  partyHome: true,
  partyWorld: null,
  partyCanOpen: false,
  ownWorld: null,
  prompt: false,
  leaving: { gate: -1, last: false, outgoing: 0, incoming: 0, wardenTools: 0, deedCost: 0 },
  moveOpensAt: 0,
  moveOpensIn: 0,
  leaver: null,
  movedOutAt: 0,
};

const shelfView = {
  gate: 3,
  homeId: 'h1',
  ownerName: 'Ora',
  names: ['Ora'],
  slots: [{ slot: 0, kind: 'item', itemDef: 'tallow', qty: 1, price: 0, maker: null, instance: null, stockedBy: 'o', stockedAt: 100 }],
  takenToday: false,
  canStock: true,
  hasShelf: true,
};

const instance = (id: string, itemDef: string, extra: Record<string, unknown> = {}) => ({ id, itemDef, condition: 90, maxCondition: 90, usesLeft: 30, state: 'whole', wardenSet: false, dullness: null, speed: null, fittings: [], maker: null, ...extra });
const itemsView = {
  stacks: [{ itemDef: 'timber', qty: 5, maker: null }],
  instances: [instance('a1', 'bench-axe')],
  pockets: [{ slot: 'pocket-1', itemDef: null, instance: null }],
  offHand: { open: false, class: null, itemDef: null, instance: null },
  pickedUp: [],
  thanks: [],
};
const itemsResult = {
  items: itemsView,
  wear: null,
  used: '',
  pickup: '',
  given: null,
  mended: '',
  created: [],
  gathered: [],
  plant: null,
  land: null,
  returned: '',
  paper: null,
  heirloom: '',
  adaOilCount: 0,
  goldGiven: 0,
  bought: null,
};
const workshopView = { home: null, inventory: { materials: {}, items: {}, decorations: {}, instances: [] }, storage: null, personal: { materials: {}, items: {}, decorations: {}, instances: [] }, shared: 'not-a-member' };
const mailView = {
  id: 'm1',
  worldId: 'w',
  fromId: 'o',
  toId: 'alice',
  fromName: 'Ora',
  toName: 'Alice',
  asset: { kind: 'item', id: 'tallow', qty: 1, instance: '', maker: null },
  sentAt: 100,
  claimedAt: null,
  returnedAt: null,
  returnReason: null,
};

/** Over one top-level answer: the parsed read, `over` merged at each level. */
const deep = (base: Record<string, unknown>, over: Record<string, unknown>): JsonValue => ({ ...base, ...over }) as never;

test('a world answer missing known fields is refused, not zero-filled', () => {
  assert.throws(() => parseWorld(deep(snapshot, { world: {}, leaving: {} })));
  assert.throws(() => parseWorld(deep(snapshot, { ...worldView, leaving: undefined })), 'no leaving view');
  assert.throws(() => parseWorld(deep(snapshot, { ...worldView, moveOpensIn: undefined })), 'no moveOpensIn');
  assert.throws(() => parseWorld(deep(snapshot, { ...worldView, world: { ...worldRef, members: undefined } })), 'no members');
});

test('snake_case aliases are refused, nested ones included', () => {
  assert.throws(() => parseWorld(deep(snapshot, { ...worldView, move_opens_in: 5 })), 'top-level alias');
  assert.throws(() => parseWorld(deep(snapshot, { ...worldView, world: { ...worldRef, owner_name: 'Ora' } })), 'nested alias');
  assert.throws(() => parseWorld(deep(snapshot, { ...worldView, leaving: { ...worldView.leaving, deed_cost: 2 } })), 'deeply nested alias');
});

test('numeric strings and non-finite spellings are refused', () => {
  assert.throws(() => parseWorld(deep(snapshot, { world: { ...worldRef, members: '2' } })), 'numeric string');
  assert.throws(() => parseWorld(deep(snapshot, { ...worldView, moveOpensIn: 'Infinity' })), 'Infinity');
  assert.throws(() => parseWorld(deep(snapshot, { ...worldView, moveOpensIn: '-Infinity' })), '-Infinity');
  assert.throws(() => parseWorld(deep(snapshot, { ...worldView, moveOpensIn: 'NaN' })), 'NaN');
});

test('bad counts are refused', () => {
  assert.throws(() => parseShelf(deep(snapshot, { shelf: { ...shelfView, gate: -1 } })), 'negative gate');
  assert.throws(() => parseShelf(deep(snapshot, { shelf: { ...shelfView, slots: [{ ...shelfView.slots[0], qty: -1 }] } })), 'negative qty');
  assert.throws(() => parseShelf(deep(snapshot, { shelf: { ...shelfView, slots: [{ ...shelfView.slots[0], slot: 0.5 }] } })), 'fractional slot');
});

test('malformed homestead, items, mail and craft answers are refused', () => {
  assert.throws(() => parseHome(deep(snapshot, { gate: 3, landSeed: 0, home: { id: '', gate: 3, worldId: 'w', tier: 1, members: [], member: false, desolate: false, landSeed: 0, cleared: [], postsBought: 0, nextPost: {}, indoor: null, items: [], stumps: [], plants: [] }, materials: {} })), 'empty home id');
  assert.throws(() => parseItems(deep(snapshot, { result: { ...itemsResult, items: { ...itemsView, instances: [{ ...itemsView.instances[0], item_def: 'bench-axe' }] } } })), 'nested alias in an instance');
  assert.throws(() => parseItemsAction(deep(snapshot, { result: { ...itemsResult, wear: { broke: false, woreOut: false, state: 'whole', wornOut: [], returned: [], itemDef: 'x', usesLeft: '3', condition: 0, instance: null, makerId: '' } } })), 'numeric string wear');
  assert.throws(() => parseCraft(deep(snapshot, { hearthCraft: null, craft: { ...workshopView, recipeId: 'plank', output: { kind: 'item', id: 'plank', qty: 1, instance: '', maker: 'Infinity' } } })), 'non-finite maker');
  assert.throws(() => parseMail(deep(snapshot, { mail: [{ ...mailView, sentAt: '100' }] })), 'numeric string sentAt');
  assert.throws(() => parseMail(deep(snapshot, { mail: [{ ...mailView, asset: { ...mailView.asset, qty: '1' } }] })), 'numeric string qty');
});

test('unknown future fields are tolerated, wherever they sit', () => {
  const next = { someFutureField: { nested: [1, 2] } };
  const w = parseWorld(deep(snapshot, deep(worldView, next) as Record<string, unknown>));
  assert.equal(w.world.id, 'w1');
  const s = parseShelf(deep(snapshot, { shelf: deep(shelfView, next) as Record<string, unknown>, ...next }));
  assert.equal(s.shelf.gate, 3);
  const i = parseItems(deep(snapshot, { result: deep(itemsResult, next) as Record<string, unknown> }));
  assert.equal(i.items.stacks[0]!.qty, 5);
});

test('the world choice answers through the same decoder', () => {
  const choice = { habiticaId: 'hab-1', displayName: 'Alice', partyWorld: null, partyCanOpen: true, partyAdmitted: false };
  assert.equal(parseWorldChoice({ worldChoice: choice })?.partyCanOpen, true);
  assert.throws(() => parseWorldChoice({ worldChoice: { ...choice, party_can_open: true } }), 'alias refused');
  assert.throws(() => parseWorldChoice({ worldChoice: { ...choice, habiticaId: undefined } }), 'missing field');
});
