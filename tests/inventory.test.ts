import test from 'node:test';
import assert from 'node:assert/strict';
import { assetOf, costLine, inventoryEntries, materialsFromPack, newestFirst, newTabs, unseen, wearWords, type InventoryEntry } from '../src/lib/inventory.ts';
/** Entries by tab, in the bag's usual order (nothing seen yet): the old tab groups. */
const group = (entries: readonly InventoryEntry[]) => {
  const out = {} as Record<'tools' | 'supplies' | 'keepsakes' | 'home', { main: InventoryEntry[]; road: InventoryEntry[] }>;
  for (const t of ['tools', 'supplies', 'keepsakes', 'home'] as const) {
    const list = newestFirst(entries.filter((e) => e.tab === t), new Map());
    out[t] = { main: list.filter((e) => e.section === 'main'), road: list.filter((e) => e.section === 'road') };
  }
  return out;
};


const names = (list: { name: string }[]) => list.map((e) => e.name);

test('a pack sorts into supplies, keepsakes and the road', () => {
  const entries = inventoryEntries({
    pack: ['field-journal', 'hearthwick-map', 'tin-whistle', 'ember-charm', 'whittled-fox', 'lantern-route-rubbing'],
    materials: { timber: 12, stone: 4, fiber: 0, amber: 0 },
  });
  const g = group(entries);
  assert.deepEqual(names(g.supplies.main), ['Timber', 'Stone'], 'materials in their own order, only what you have');
  assert.deepEqual(g.supplies.main.map((e) => e.qty), [12, 4]);
  assert.deepEqual(names(g.keepsakes.main), ['Ember Charm', 'Tin Whistle', 'Whittled Fox'], 'the charm first, then trinkets by name');
  assert.deepEqual(g.tools.main, [], 'no tools yet');
  assert.deepEqual(g.tools.road.map((e) => e.id), ['field-journal', 'hearthwick-map', 'lantern-route-rubbing'], 'quest items in story order');
  assert.equal(g.tools.road[2].name, 'Wenna’s Naming, Copied Out', 'descriptions from existing content');
  assert.deepEqual(g.home.main, []);
  // Delivered art for materials and trinkets; the charm draws its pixel icon.
  assert.equal(g.supplies.main[0].art, 'icon-timber');
  assert.equal(g.keepsakes.main[2].art, 'icon-whittled-fox');
  assert.equal(g.keepsakes.main[0].art, null);
  assert.ok(g.keepsakes.main.every((e) => e.blurb.length > 0));
});

test('in a world, server counts win: materials, items and crafted pieces', () => {
  const entries = inventoryEntries({
    pack: ['field-journal', 'tin-whistle', 'lamp-wick'],
    materials: { timber: 3, stone: 0, fiber: 7, amber: 1 },
    items: { 'tin-whistle': 2, 'lamp-wick': 5, 'wooden-peg': 1 },
  });
  const g = group(entries);
  assert.deepEqual(g.supplies.main.map((e) => `${e.name}×${e.qty}`), ['Timber×3', 'Fiber×7', 'Amber×1', 'Lamp Wick×5', 'Wooden Peg×1']);
  assert.ok(g.supplies.main.find((e) => e.id === 'lamp-wick')!.blurb.length > 0, 'crafted pieces have a line');
  assert.deepEqual(g.keepsakes.main.map((e) => `${e.name}×${e.qty}`), ['Tin Whistle×2']);
});

test('home goods count set-out and put-away pieces, by name', () => {
  const g = group(
    inventoryEntries({
      pack: [],
      decorations: [
        { itemDef: 'wooden-stool', scene: 'outdoor' },
        { itemDef: 'wooden-stool', scene: null },
        { itemDef: 'braided-rug', scene: 'indoor' },
        { itemDef: 'oak-table', scene: null },
      ],
    }),
  );
  assert.deepEqual(
    g.home.main.map((e) => [e.name, e.placed, e.stored]),
    [
      ['Braided Rug', 1, 0],
      ['Oak Table', 0, 1],
      ['Wooden Stool', 1, 1],
    ],
  );
  assert.ok(g.home.main.every((e) => e.tab === 'home' && e.blurb.length > 0));
});

test('unknown ids still show, title-cased, and duplicates count once', () => {
  const g = group(inventoryEntries({ pack: ['warden-seal', 'odd-thing', 'odd-thing'] }));
  assert.deepEqual(names(g.tools.road), ['Warden Seal']);
  assert.deepEqual(names(g.keepsakes.main), ['Odd Thing']);
});

test('new dots: what this device has not seen, by tab', () => {
  const entries = inventoryEntries({ pack: ['field-journal', 'tin-whistle'], materials: { fiber: 2, timber: 0, stone: 0, amber: 0 } });
  const seen = new Set(['quest:field-journal']);
  assert.deepEqual(unseen(entries, seen).map((e) => e.key).sort(), ['item:tin-whistle', 'material:fiber']);
  assert.deepEqual([...newTabs(entries, seen)].sort(), ['keepsakes', 'supplies']);
  assert.equal(newTabs(entries, new Set(entries.map((e) => e.key))).size, 0);
});

test('the guest material parser reads the pack format (TODO(D): the Wilds still write it)', () => {
  assert.deepEqual(materialsFromPack(['material:amber:3', 'material:bogus:9', 'material:stone:x', 'tin-whistle']), { timber: 0, stone: 0, fiber: 0, amber: 3 });
});

test('newest first: unseen things lead, then the most recently seen, quest things last', () => {
  const entries = inventoryEntries({ pack: ['field-journal', 'lamp-wick', 'whittled-fox'], materials: { timber: 4, amber: 1, stone: 0, fiber: 0 } });
  const keys = (list: { key: string }[]) => list.map((e) => e.key);
  // Seen in two looks: timber first, then the wick (the wick is the more recent).
  const order = keys(newestFirst(entries, new Map([['material:timber', 1], ['item:lamp-wick', 2]])));
  const unseenKeys = ['material:amber', 'item:whittled-fox'];
  assert.deepEqual(new Set(order.slice(0, 2)), new Set(unseenKeys), 'unseen things lead');
  assert.deepEqual(order.slice(2, 4), ['item:lamp-wick', 'material:timber'], 'then the most recently seen');
  assert.equal(order.at(-1), 'quest:field-journal', 'quest things last');
});

test('newest first: things seen in one look keep the usual order among themselves', () => {
  const entries = inventoryEntries({ pack: ['whittled-fox'], materials: { timber: 4, stone: 2, amber: 1, fiber: 0 } });
  const keys = (list: { key: string }[]) => list.map((e) => e.key);
  // Timber, stone and amber seen together (one stamp), the fox in a later look.
  const at = new Map([['material:amber', 1], ['material:timber', 1], ['material:stone', 1], ['item:whittled-fox', 2]]);
  assert.deepEqual(keys(newestFirst(entries, at)), ['item:whittled-fox', 'material:timber', 'material:stone', 'material:amber']);
});

test('the card helpers: cost lines, hand-over assets, wear in words', () => {
  assert.equal(costLine({ timber: 2, fiber: 1 }), '2 timber, 1 fiber');
  assert.equal(costLine(undefined), '');
  assert.deepEqual(assetOf({ id: 'timber', instance: null, maker: null }), { kind: 'material', id: 'timber', qty: 1, maker: '' });
  assert.deepEqual(assetOf({ id: 'lamp-wick', instance: null, maker: { id: 'u1', name: 'Wren' } }), { kind: 'item', id: 'lamp-wick', qty: 1, maker: 'u1' });
  const tool = { id: 'a1', itemDef: 'bench-axe', condition: 20, maxCondition: 30, usesLeft: 20, state: 'worn', wardenSet: false, fittings: [], maker: null } as const;
  assert.deepEqual(assetOf({ id: 'bench-axe', instance: tool as never, maker: null }), { kind: 'instance', id: 'bench-axe', qty: 1, instance: 'a1' });
  assert.equal(wearWords(tool as never), '20 uses left');
  assert.equal(wearWords({ ...tool, state: 'blunt' } as never), 'Blunt. Mend it to use it again.');
  assert.equal(wearWords({ ...tool, maxCondition: 0 } as never), 'Never wears');
  assert.equal(wearWords({ ...tool, wardenSet: true, condition: 30 } as never), 'Sharp');
});
