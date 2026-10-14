/**
 * A server camp's claim prompt through the real WildsEntities claim path
 * (shared-fights.md 1.9, F-F's `camp_claimable`): the near read's word for the
 * camp's exact cycle is the only thing that offers a claim. A fallen camp
 * shows cleared (its respawn timer running) and stays claimable for its
 * witnesses until its next cycle; the room's completion only asks for a read,
 * and an older cycle's corpses never make the next cycle claimable.
 */
import './helpers/scene-modules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';

const { WildsNearResultSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js');
const store = await import('../src/game/wilds/store.ts');
const { WildsEntities } = await import('../src/game/wilds/entities.ts');
const { ServerCampOutcome } = await import('../src/game/wilds/camp-fights.ts');
const { forgetChunks, loadChunk } = await import('../src/game/wilds/chunks.ts');
const { chunkAt } = await import('./wilds-fixture.ts');

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { case: string; json: JsonValue }[];
const NEAR = fixtures.find((f) => f.case === 'valid-near')!.json as Record<string, any>;
const WICK = NEAR.wick.id as string;
const ID = 'camp:-2:-4:0';

/** A near read naming the camp's state (the server's projection already applied, as it sends it). */
const nearWith = (state: Record<string, unknown>) =>
  fromJson(WildsNearResultSchema, { ...structuredClone(NEAR), entities: [{ id: ID, epoch: WICK, ...state }], personalClaims: [], ground: [], ways: [] } as JsonValue);

const nowSec = () => Math.floor(Date.now() / 1000);
const later = () => nowSec() + 600;
const past = () => nowSec() - 5;

async function rig() {
  store.resetWilds({ quiet: true });
  forgetChunks();
  /** What the server's next near read says (each read the claim asks for). */
  let next = nearWith({ cycle: 0, state: 'available' });
  const claims: { cycle: number }[] = [];
  let refusal: string | null = null;
  const chunk = async (epoch: string, _layer: number, cx: number, cy: number) => {
    const m = chunkAt('whitequiet-0-4', cx, cy);
    m.epochId = epoch;
    m.entities = cx === -2 && cy === -4 ? [{ ...m.entities[0]!, id: ID, kind: 'camp', enemies: ['wisp', 'beetle'], material: '', poi: '' }] : [];
    return m;
  };
  const session = {
    state: { area: 'outdoors' },
    link: {
      status: 'online',
      api: { operations: { near: async () => next, chunk } },
      wildsClaim: async (req: { cycle: number }) => {
        claims.push({ cycle: req.cycle });
        if (refusal) return { ok: false, code: refusal };
        const entity = { $typeName: 'glimway.v1.WildsEntityState', id: ID, epoch: WICK, cycle: req.cycle, state: 'cleared', availableAt: later(), campClaimable: false };
        next = nearWith({ cycle: req.cycle, state: 'cleared', availableAt: later(), campClaimable: false });
        return { ok: true, result: { entity, epoch: WICK, materials: {}, loot: null, papers: [] } };
      },
    },
  };
  /** The room's answer for the camp (true all dead, false one stands, undefined no room). */
  let room: boolean | undefined = undefined;
  let asks = 0;
  const layer = Object.create(WildsEntities.prototype) as any;
  layer.deps = { session, hero: () => ({ x: -2 * 384 + 80, y: -4 * 384 + 80 }) };
  layer.campOutcome = new ServerCampOutcome(() => room, async () => { asks++ });
  await loadChunk(session.link.api.operations, WICK, -2, -4);
  const thing = () => store.chunkThings(-2, -4)[0]!;
  return {
    claims,
    layer,
    thing,
    set room(v: boolean | undefined) { room = v; },
    get asks() { return asks; },
    refuse: (code: string | null) => { refusal = code; },
    /** The server's next read, and applying a read now. */
    serve: (state: Record<string, unknown>) => (next = nearWith(state)),
    read: (state: Record<string, unknown>) => store.applyNear(nearWith(state), store.readMark()),
    frame: () => layer.watchCamps([thing()]),
    claimable: () => layer.claimable(thing(), nowSec()) as boolean,
    claim: () => layer.claimConnected(thing()) as Promise<void>,
  };
}

test('a fallen cycle is claimable for a witness while the camp shows cleared, and only once', async () => {
  const r = await rig();
  r.read({ cycle: 3, state: 'available' });
  r.room = false;
  r.frame();
  assert.equal(r.claimable(), false, 'standing');
  r.room = true;
  r.frame();
  assert.equal(r.asks, 1, 'the room’s completion asks for the server’s word');
  assert.equal(r.claimable(), false, 'dead rows alone are not a claim');
  // The fall is stored: the read shows the camp cleared in cycle 3, its timer running, claimable for this reader.
  const fell = { cycle: 3, state: 'cleared', availableAt: later(), campClaimable: true };
  r.read(fell);
  assert.equal(store.entityAvailable(r.thing(), nowSec()), false);
  assert.equal(r.claimable(), true, 'claimable though unavailable: its own cycle fell');
  r.room = undefined;
  assert.equal(r.claimable(), true, 'a down socket keeps the confirmed word');
  r.serve(fell);
  await r.claim();
  assert.deepEqual(r.claims, [{ cycle: 3 }], 'the claim names the fallen cycle');
  assert.equal(r.claimable(), false, 'claimed this cycle');
});

test('the next cycle never inherits the last one’s word or its corpses', async () => {
  const r = await rig();
  // The read said cycle 3 claimable, but its timer has run: the camp is in cycle 4 now.
  r.read({ cycle: 3, state: 'cleared', availableAt: past(), campClaimable: true });
  assert.equal(store.entityCycle(r.thing(), nowSec()), 4);
  r.room = true;
  r.frame();
  assert.equal(r.claimable(), false, 'cycle 3’s word and corpses do not offer cycle 4');
  // The claim’s fresh read agrees: cycle 4 is up and unfought.
  r.serve({ cycle: 4, state: 'available' });
  await r.claim();
  assert.deepEqual(r.claims, [], 'nothing sent');
});

test('a respawn’s standing rows hide a prompt; a refusal as not a witness ends it for the cycle', async () => {
  const r = await rig();
  const fell = { cycle: 1, state: 'cleared', availableAt: later(), campClaimable: true };
  r.read(fell);
  r.room = false;
  assert.equal(r.claimable(), false, 'the room shows it standing');
  r.room = true;
  assert.equal(r.claimable(), true);
  r.serve(fell);
  r.refuse('condition-unmet');
  await r.claim();
  assert.deepEqual(r.claims, [{ cycle: 1 }]);
  assert.equal(r.claimable(), false, 'not this account’s cycle to claim');
});

test('a claim refused as not yet defeated stays open for the next press', async () => {
  const r = await rig();
  const fell = { cycle: 2, state: 'cleared', availableAt: later(), campClaimable: true };
  r.read(fell);
  r.room = true;
  r.serve(fell);
  r.refuse('not-defeated');
  await r.claim();
  assert.equal(r.claimable(), true, 'the fall may still be landing');
  r.refuse(null);
  await r.claim();
  assert.deepEqual(r.claims, [{ cycle: 2 }, { cycle: 2 }]);
  assert.equal(r.claimable(), false);
});
