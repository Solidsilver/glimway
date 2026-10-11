/**
 * A camp come round on its timer, through the real WildsEntities claim
 * (round 1 of the c08 review, finding 4): the fight is fought under the
 * cycle the server's read projects (one ahead of the depleted one), so the
 * fresh read before the claim names the same cycle and the won fight counts.
 * Another cycle still needs its own fight, and nothing is claimable unwon.
 */
import './helpers/scene-modules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';

const { WildsNearResultSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js');
const store = await import('../src/game/wilds/store.ts');
const { WildsEntities } = await import('../src/game/wilds/entities.ts');
const { CampFights } = await import('../src/game/wilds/camp-fights.ts');
const { forgetChunks, loadChunk } = await import('../src/game/wilds/chunks.ts');
const { chunkAt } = await import('./wilds-fixture.ts');

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { case: string; json: JsonValue }[];
const NEAR = fixtures.find((f) => f.case === 'valid-near')!.json as Record<string, any>;
const WICK = NEAR.wick.id as string;
const ID = 'camp:-2:-4:0';

/** A near read naming the camp's state (the server's projection already applied, as it sends it). */
const nearWith = (state: Record<string, unknown>) =>
  fromJson(WildsNearResultSchema, { ...structuredClone(NEAR), entities: [{ id: ID, epoch: WICK, ...state }], personalClaims: [], ground: [], ways: [] } as JsonValue);

type Enemy = { id: string; dead: boolean };

function rig() {
  store.resetWilds({ quiet: true });
  forgetChunks();
  const enemies = {
    enemies: [] as Enemy[],
    spawns: 0,
    spawnWilds(id: string) {
      this.spawns++;
      this.enemies.push({ id, dead: false });
    },
    removeWilds(prefix: string) {
      this.enemies = this.enemies.filter((e) => !e.id.startsWith(prefix));
    },
  };
  /** What the server's next near read says (each read the claim asks for). */
  let next = nearWith({ cycle: 0, state: 'available' });
  const claims: { cycle: number }[] = [];
  const chunk = async (epoch: string, _layer: number, cx: number, cy: number) => {
    const m = chunkAt('whitequiet-0-4', cx, cy);
    m.epochId = epoch;
    m.entities = cx === -2 && cy === -4 ? [{ ...m.entities[0]!, id: ID, kind: 'camp', enemies: ['wisp'], material: '', poi: '' }] : [];
    return m;
  };
  const session = {
    state: { area: 'wilds' },
    link: {
      status: 'online',
      api: { operations: { near: async () => next, chunk } },
      wildsClaim: async (req: { cycle: number }) => {
        claims.push({ cycle: req.cycle });
        const availableAt = Math.floor(Date.now() / 1000) + 600;
        const entity = { $typeName: 'glimway.v1.WildsEntityState', id: ID, epoch: WICK, cycle: req.cycle, state: 'cleared', availableAt };
        // The server holds the claim: its later reads say depleted.
        next = nearWith({ cycle: req.cycle, state: 'cleared', availableAt, by: 'me' });
        return { ok: true, result: { entity, epoch: WICK, materials: {}, loot: null, papers: [] } };
      },
    },
  };
  const layer = Object.create(WildsEntities.prototype) as any;
  layer.deps = { session, enemies, hero: () => ({ x: -2 * 384 + 80, y: -4 * 384 + 80 }) };
  layer.camps = new CampFights({
    spawn: (c: unknown) => layer.spawnCamp(c),
    remove: (id: string) => enemies.removeWilds(`wilds:${id}:`),
    alive: (id: string) => enemies.enemies.some((e) => !e.dead && e.id.startsWith(`wilds:${id}:`)),
  });
  layer.campOutcome = layer.camps;
  const thing = () => store.chunkThings(-2, -4)[0]!;
  return {
    enemies,
    claims,
    layer,
    thing,
    /** The server's next read. */
    serve: (state: Record<string, unknown>) => (next = nearWith(state)),
    frame: () => layer.reconcileCamps([thing()]),
    win: () => enemies.enemies.forEach((e) => (e.dead = true)),
    claimable: () => layer.claimable(thing(), Math.floor(Date.now() / 1000)) as boolean,
    claim: () => layer.claimConnected(thing()) as Promise<void>,
    chunk,
  };
}

const past = () => Math.floor(Date.now() / 1000) - 5;

test('a camp come round on its timer is claimed after one fight, under the cycle the server projects', async () => {
  const r = rig();
  // Depleted (cycle 0), its timer runs out while you stand beside it: no read in between.
  store.applyNear(nearWith({ cycle: 0, state: 'cleared', availableAt: past() }), store.readMark());
  await loadChunk(r.layer.deps.session.link.api.operations, WICK, -2, -4);
  assert.equal(store.entityCycle(r.thing(), Math.floor(Date.now() / 1000)), 1, 'its next cycle, as the server reads it');
  r.frame();
  assert.equal(r.enemies.spawns, 1, 'the respawned camp is fought');
  assert.equal(r.claimable(), false, 'not before its creatures are down');
  r.win();
  r.frame();
  assert.equal(r.claimable(), true);
  // The claim's fresh read projects cycle 1, available.
  r.serve({ cycle: 1, state: 'available' });
  await r.claim();
  assert.deepEqual(r.claims, [{ cycle: 1 }], 'the won fight counts: one claim, for the projected cycle');
  r.frame();
  assert.equal(r.enemies.spawns, 1, 'no second fight for the same respawn');
  assert.equal(r.claimable(), false, 'claimed: depleted again');
});

test('a timer respawn still needs its fight, another cycle its own, and another player’s claim ends it', async () => {
  const r = rig();
  store.applyNear(nearWith({ cycle: 0, state: 'cleared', availableAt: past() }), store.readMark());
  await loadChunk(r.layer.deps.session.link.api.operations, WICK, -2, -4);
  r.frame();
  // Unwon: the claim's read finds it available, but nothing is sent.
  r.serve({ cycle: 1, state: 'available' });
  await r.claim();
  assert.deepEqual(r.claims, [], 'no free claim for a respawn not fought');
  r.frame();
  assert.equal(r.enemies.spawns, 1, 'the same fight goes on');
  // Someone else claims cycle 1 and its timer runs out too: the read says cycle 2, a new fight.
  r.win();
  r.frame();
  store.applyNear(nearWith({ cycle: 1, state: 'cleared', availableAt: past(), by: 'them' }), store.readMark());
  r.frame();
  assert.equal(r.enemies.spawns, 2, 'cycle 2 is fought again');
  assert.equal(r.claimable(), false, 'cycle 1’s win doesn’t count for it');
  // Another player claims mid-fight: the creatures go, nothing to claim.
  store.applyNear(nearWith({ cycle: 2, state: 'cleared', availableAt: Math.floor(Date.now() / 1000) + 600, by: 'them' }), store.readMark());
  r.frame();
  assert.equal(r.enemies.enemies.length, 0);
  assert.equal(r.claimable(), false);
});
