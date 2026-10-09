import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DescMessage } from '@bufbuild/protobuf';
import { decodeWire } from '../src/lib/api/wire.ts';
import * as companions from '../src/lib/gen/glimway/v1/companions_pb.js';
import * as fishing from '../src/lib/gen/glimway/v1/fishing_pb.js';
import * as goods from '../src/lib/gen/glimway/v1/goods_pb.js';
import * as op from '../src/lib/gen/glimway/v1/op_pb.js';
import * as operations from '../src/lib/gen/glimway/v1/operations_pb.js';
import * as state from '../src/lib/gen/glimway/v1/state_pb.js';
import * as presence from '../src/lib/gen/glimway/v2/presence_pb.js';

/**
 * The Crafts lanes' sample messages (content/vectors/crafts-fixtures.json),
 * the shared fixtures lanes B-G build against: each one decodes through the
 * generated decoder the game will use (the Go side replays the same file in
 * server/internal/api/crafts_fixtures_test.go).
 */
const doc = JSON.parse(readFileSync(new URL('../content/vectors/crafts-fixtures.json', import.meta.url), 'utf8')) as {
  messages: { name: string; type: string; json: unknown }[];
};

const schemas = new Map<string, DescMessage>();
for (const module of [companions, fishing, goods, op, operations, state, presence]) {
  for (const value of Object.values(module)) {
    if (typeof value === 'object' && value && 'kind' in value && value.kind === 'message') schemas.set((value as DescMessage).typeName, value as DescMessage);
  }
}

test('every crafts fixture decodes through the generated messages', () => {
  assert.ok(doc.messages.length >= 30, 'the lanes have their samples');
  for (const f of doc.messages) {
    const schema = schemas.get(f.type);
    assert.ok(schema, `${f.name}: no schema for ${f.type}`);
    const decoded = decodeWire(schema, f.json);
    assert.equal((decoded as { $typeName: string }).$typeName, f.type);
  }
});

test('the fixtures speak the shapes the lanes read', () => {
  const by = new Map(doc.messages.map((m) => [m.name, decodeWire(schemas.get(m.type)!, m.json) as never as Record<string, any>]));
  assert.deepEqual(by.get('companions')!.yardPets, ['Cat-Siamese', 'Owl-Spooky', 'Wolf-Cubic']);
  assert.equal(by.get('companions-fallbacks')!.followPet, '');
  assert.equal(by.get('stall')!.out, true);
  assert.equal(by.get('stall-empty')!.mount, '');
  assert.equal(by.get('magic')!.classMark, 'mage');
  assert.equal(by.get('magic-no-craft')!.classMark, undefined, 'an absent wrapper reads as none');
  assert.equal(by.get('vitals-ability-ready')!.abilityReadyAt.kindle, 1791400004.5);
  assert.deepEqual(by.get('report-request')!.abilityCasts, {});
  assert.equal(by.get('report-result')!.allyHeal, 7.2);
  assert.equal(by.get('fishing-cast')!.readyAt, 1791400010.25);
  assert.equal(by.get('fishing-state-empty')!.cast, undefined, 'no open cast');
  assert.equal(by.get('fishery-state')!.stock, 11.5);
  assert.equal(by.get('fish-settle-result')!.wear.usesLeft, 29);
  assert.equal(by.get('fishing-waters')!.waters[0].band, 'healthy');
  assert.equal(by.get('presence-ability')!.accountId, 'fixture-account');
  assert.equal(by.get('presence-ability-outgoing')!.accountId, undefined, 'the client sends no account id');
  assert.equal(by.get('presence-position-riding')!.pose, 'riding');
  assert.equal(by.get('presence-position-fishing')!.pose, 'fishing');
  // The homestead side lane E draws first: stalls, yard pets, the stable's
  // bay count, and the results and envelope its operations answer as.
  const home = by.get('home-view')!;
  assert.equal(home.stalls[0]!.out, true);
  assert.equal(home.stalls[0]!.mount, 'Wolf-Shade');
  assert.equal(home.stalls[0]!.ownerName, 'Tam');
  assert.equal(home.stalls[1]!.mount, '');
  assert.equal(home.yardPets[0]!.pet, 'Cat-Siamese');
  assert.equal(home.items[1]!.itemDef, 'stable');
  assert.equal(home.items[1]!.stalls, 2, 'the stable carries its bay count');
  assert.equal(by.get('stall-result')!.home.id, 'home:12');
  assert.equal(by.get('mount-out-result')!.companions.mountOut, 'Wolf-Shade');
  assert.deepEqual(by.get('stable-extend-result')!.materials, { timber: 12, stone: 6, fiber: 2 });
  assert.equal((by.get('envelope-stall') as { result: { case: string } }).result.case, 'stall');
  const state = by.get('player-state')!;
  assert.equal(state.companions.followPet, 'Fox-Golden');
  assert.equal(state.magic.levelMark, 20);
  assert.equal(state.magic.classMark, 'mage');
  assert.equal(state.fishing.cast.band, 'healthy');
});
