import { parseItemsResult } from '../src/lib/api/parse.ts';
import { createRemoteLibrary } from '../src/lib/papers/library.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { create, toJson, toBinary, type DescMessage, type JsonValue } from '@bufbuild/protobuf';
import * as op from '../src/lib/gen/glimway/v1/op_pb.js';
import * as operations from '../src/lib/gen/glimway/v1/operations_pb.js';
import * as profile from '../src/lib/gen/glimway/v1/profile_pb.js';
import * as state from '../src/lib/gen/glimway/v1/state_pb.js';
import * as wilds from '../src/lib/gen/glimway/v1/wilds_pb.js';
import * as village from '../src/lib/gen/glimway/v1/village_pb.js';
import * as homestead from '../src/lib/gen/glimway/v1/homestead_pb.js';
import * as items from '../src/lib/gen/glimway/v1/items_pb.js';
import * as world from '../src/lib/gen/glimway/v1/world_pb.js';
import { decodeWire } from '../src/lib/api/wire.ts';
import { decodePlayerState } from '../src/lib/api/state-contract.ts';
import { FakeOperations, createOperationsApi, decodeEnvelope, decodeMixed } from '../src/lib/api/operations.ts';
import { ApiError, errorFromResponse, isSettledRefusal, isReloadNeeded, isOutboxClientBug, needsReconciliation } from '../src/lib/api/errors.ts';
import { decodeChunk, validateChunk, FakeChunks, entityIn, decorAt, PortError } from '../src/lib/api/chunks.ts';
import { profileFor, earnsXP } from '../src/lib/profile.ts';
import { createApiClient, claimDeviceId } from '../src/lib/api/client.ts';
import { SIGNATURE_COOLDOWN_SECONDS, BASIC_ATTACK_COOLDOWN_SECONDS } from '../src/lib/combat-timing.ts';

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { name: string; case: string; json: JsonValue; binaryHex?: string }[];
const schemas = new Map<string, DescMessage>();
for (const module of [op, operations, profile, state, wilds, village, world]) for (const value of Object.values(module)) if (typeof value === 'object' && value && 'kind' in value && value.kind === 'message') schemas.set(value.typeName, value as DescMessage);
const valid = fixtures.find(f => f.name === 'glimway.v1.PlayerState' && f.case === 'valid')!.json;
test('Go ProtoJSON fixtures decode in TS for every new request and result, including empty collections', () => {
  for (const f of fixtures) {
    if (f.name === 'mixed') { assert.deepEqual(Object.keys(f.json as object).sort(), ['result', 'state']); assert.ok(decodeMixed(f.json, r => { assert.equal(typeof r, 'object'); return r; }).state.account); continue; }
    const schema = schemas.get(f.name)!; assert.ok(schema, f.name);
    const decoded = decodeWire(schema, f.json);
    if (f.binaryHex) { const c = decodeChunk(Uint8Array.from(Buffer.from(f.binaryHex, 'hex'))); assert.deepEqual(c, decoded); }
    // ES omits absent messages; Go EmitUnpopulated writes null. Compare with
    // the generated decoder's normalized presence semantics.
    const normalize = (raw: JsonValue): JsonValue => Array.isArray(raw) ? raw.map(normalize) : raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null).map(([k, v]) => [k, normalize(v)])) : raw;
    assert.deepEqual(normalize(toJson(schema, decoded, { alwaysEmitImplicit: true })), normalize(f.json), `${f.name} ${f.case}`);
  }
});
test('current state validation rejects malformed numbers, identities and missing fields', () => {
  const decoded = decodePlayerState(valid); assert.ok(decoded.account!.accountId);
  const body = valid as Record<string, any>;
  for (const value of ['3', NaN, Infinity, -1, 0.5]) assert.throws(() => decodePlayerState({ ...body, version: value }));
  assert.throws(() => decodePlayerState({ ...body, vitals: null }));
  assert.throws(() => decodePlayerState({ ...body, account: { ...body.account, profileSource: 'future' } }));
  assert.throws(() => decodePlayerState({ ...body, account: { ...body.account, account_id: body.account.accountId } }));
  assert.deepEqual(decodePlayerState({ ...body, future: true }), decoded);
});
test('stateful error parsing validates state and preserves uncertain outbox outcomes', () => {
  const refusal = errorFromResponse(409, { error: { code: 'not-next-step' }, state: valid });
  assert.ok(refusal.state); assert.equal(isSettledRefusal(refusal), true);
  for (const [status, code] of [[429, 'claim-rate'], [409, 'not-implemented'], [409, 'report-required'], [503, 'internal']] as const) assert.equal(isSettledRefusal(errorFromResponse(status, { error: { code }, state: valid })), false);
  assert.equal(errorFromResponse(409, { error: { code: 'not-next-step' }, state: {} }).code, 'bad-response');
  assert.equal(errorFromResponse(409, 'not-next-step').code, 'unavailable');
  assert.equal(isSettledRefusal(new ApiError('bad-response', { status: 200 })), false);
});
test('typed operations facade and fake expose session, play and operation contracts before C2', async () => {
  const fake = new FakeOperations(); fake.responses.set('/api/session', [{ state: valid }]);
  assert.equal((await fake.api.login(create(state.LoginRequestSchema, { userId: 'subject', token: 'test' }))).answer.case, 'state');
  const envelope = fixtures.find(f => f.name === 'glimway.v1.Envelope' && f.case === 'valid')!.json;
  fake.responses.set('/api/report', [envelope]);
  assert.equal((await fake.api.report(create(operations.ReportRequestSchema, { lease: 'lease', client: 'client', generation: 'generation', seq: 1, basis: 1, place: { area: 'village' } }))).result.case, 'report');
  assert.equal(fake.calls.length, 2); assert.throws(() => decodeEnvelope({ state: valid }));
  const badAck = structuredClone(envelope) as Record<string, any>; badAck.report.casts = -1; assert.throws(() => decodeEnvelope(badAck), { code: 'bad-response' });
  let headers: Headers | undefined;
  const api = createApiClient({ fetchImpl: (async (_url, init) => { headers = new Headers(init?.headers); return new Response(JSON.stringify({ state: valid, leaseActive: false }), { headers: { 'content-type': 'application/json' } }); }) as typeof fetch });
  await api.operations.state(); assert.equal(headers!.get('X-Glimway-Contract'), '6');
});
function chunk() { return create(wilds.WildsChunkSchema, { epochId: 'epoch', region: 'inner-1', realm: 'hearthwick', look: 'tangle', generatorVersion: 2, size: 24, cx: 1, cy: 0, palette: ['grass'], ground: new Uint8Array(288), solid: new Uint8Array(72), spawn: { tx: 1, ty: 1 }, decor: { kinds: ['tree'], kind: [0], tx: [2], ty: [3], ox: [1], oy: [-2], variant: [0], flags: new Uint8Array(1) }, entities: [{ id: 'node:1:0:0', kind: 'node', tx: 3, ty: 4, material: 'timber' }], exits: [{ tx: 12, ty: 0, tw: 1, th: 1, dir: wilds.Dir.NORTH, to: 'chunk:outer-1:1:1', entry: { tx: 12, ty: 23 } }] }); }
test('packed chunks validate bodies, decor and legitimate cross-region exits on binary decode', async () => {
  const c = chunk(); assert.deepEqual(decodeChunk(toBinary(wilds.WildsChunkSchema, c)), c);
  assert.equal(entityIn(c, 'node:1:0:0')!.material, 'timber'); assert.deepEqual(decorAt(c, 2, 3), [0]);
  // The way home: the Tangle's entry chunk, its south edge.
  c.cy = 1; c.exits[0]!.ty = 23; c.exits[0]!.dir = wilds.Dir.SOUTH;
  c.exits[0]!.to = 'commons'; c.exits[0]!.entry!.tx = 23; c.exits[0]!.entry!.ty = 2; validateChunk(c);
  c.exits[0]!.to = 'chunk:outer-1:3:0'; assert.throws(() => validateChunk(c));
  const bad = chunk(); bad.decor!.flags = new Uint8Array(); assert.throws(() => validateChunk(bad));
  const key = { world: 'world', epoch: 'epoch', layer: 0, cx: 1, cy: 0 }; const fake = new FakeChunks(); fake.values.set(FakeChunks.key(key), chunk());
  const read = await fake.chunk(key); read.entities.length = 0; assert.equal((await fake.chunk(key)).entities.length, 1);
  await assert.rejects(fake.chunk({ ...key, cx: 9 }), { code: 'missing' }); fake.values.set(FakeChunks.key(key), new PortError('epoch-ended')); await assert.rejects(fake.chunk(key), { code: 'epoch-ended' });
});
test('client profile and cooldown seams agree', async () => {
  assert.equal(profileFor({ profileSource: 'none', profile: undefined }), null); assert.equal(earnsXP({ profileSource: 'none' }), false); assert.equal(earnsXP({ profileSource: 'habitica' }), true);
  assert.equal(SIGNATURE_COOLDOWN_SECONDS, 1); assert.equal(BASIC_ATTACK_COOLDOWN_SECONDS.healer, 2.5);
});

test('realistic Go fixtures pass the facade and mixed domain parser', async () => {
  const get = (kind: string) => fixtures.find(f => f.case === kind)!.json;
  assert.ok(errorFromResponse(409, get('valid-refusal')).state);
  const fake = new FakeOperations();
  fake.responses.set('/api/world/choice', [get('world-choice')]);
  assert.equal((await fake.api.worldChoice()).answer.case, 'worldChoice');
  fake.responses.set('/api/play', [get('valid-play')]);
  assert.equal((await fake.api.play(create(state.PlayRequestSchema, { clientId: 'client' }))).reportClient, 'client');
  fake.responses.set('/api/state', [get('valid-state')]);
  assert.equal((await fake.api.state()).leaseActive, true);
  fake.responses.set('/api/wilds/region/outer-1', [get('valid-region')]);
  const region = await fake.api.region('outer-1');
  assert.equal(region.echoes[0]!.member, 'tam'); assert.equal(region.entities[0]!.state, 'harvested');
  for (const f of fixtures.filter(f => f.case.startsWith('fall-') || ['claim-loot', 'lantern-loot'].includes(f.case))) assert.ok(decodeEnvelope(f.json).result.case);
  const mixed = decodeMixed(get('keyed-items'), parseItemsResult);
  assert.equal(mixed.result.gathered![0]!.qty, 2); assert.equal(mixed.result.items.stacks[0]!.itemDef, 'timber');
  const owned = decodeWire(profile.HabiticaUserSchema, get('nullable-ownership'));
  assert.deepEqual((toJson(profile.HabiticaUserSchema, owned) as Record<string, any>).items.pets, { released: null, zero: 0, negative: -1, owned: true });
});

test('report keepalive and returned geometry identities are enforced', async () => {
  let extra: unknown;
  const envelope = fixtures.find(f => f.name === 'glimway.v1.Envelope' && f.case === 'valid')!.json;
  const facade = createOperationsApi(async (_method, _path, _body, options) => { extra = options; return envelope; });
  await facade.report(create(operations.ReportRequestSchema), { keepalive: true });
  assert.deepEqual(extra, { keepalive: true });
  const bytes = toBinary(wilds.WildsChunkSchema, chunk());
  const geometry = createOperationsApi(async () => bytes);
  assert.equal((await geometry.chunk('epoch', 0, 1, 0)).cx, 1);
  for (const args of [['wrong-epoch', 0, 1, 0], ['epoch', -1, 1, 0], ['epoch', 0, 0, 0], ['epoch', 0, 1, 1]] as const) await assert.rejects(geometry.chunk(...args), { code: 'bad-response' });
  const wrongRegion = createOperationsApi(async () => fixtures.find(f => f.case === 'valid-region')!.json);
  await assert.rejects(wrongRegion.region('inner-1'), { code: 'bad-response' });
});

test('outbox error decisions separate gameplay refusals, client bugs and reconciliation', () => {
  assert.ok(isReloadNeeded(new ApiError('reload-needed', { status: 409 })));
  assert.equal(isReloadNeeded(new Error('reload-needed')), false);
  const bug = errorFromResponse(400, { error: { code: 'invalid-json' } });
  assert.ok(isOutboxClientBug(bug)); assert.equal(isSettledRefusal(bug), false);
  const mismatch = errorFromResponse(409, { error: { code: 'idempotency-mismatch' }, state: valid });
  assert.ok(needsReconciliation(mismatch)); assert.equal(isSettledRefusal(mismatch), false);
  for (const code of ['superseded', 'reload-needed', 'unknown'] as const) assert.equal(isSettledRefusal(new ApiError(code, { status: 409, state: decodePlayerState(valid) })), false);
});

test('every raw client call and remote library call carries contract 6', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ error: { code: 'internal' } }), { status: 500, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  const client = createApiClient({ fetchImpl });
  // The keyed requests are generated messages (requests.ts builds them);
  // the other calls take their plain arguments as before.
  const envelope = { op: { lease: 'L', key: 'k' }, where: { area: 'village', x: 1, y: 1 } };
  const messageArgs: Record<string, () => unknown[]> = {
    shelfAction: () => [create(homestead.ShelfRequestSchema, { ...envelope, action: 'stock', gate: 1, slot: 0 })],
    homeAction: () => ['buy', create(homestead.HomesteadRequestSchema, { ...envelope })],
    storageMove: () => [create(village.StorageMoveRequestSchema, { ...envelope, direction: 'deposit', asset: { kind: 'material', id: 'timber', qty: 1 } })],
    craft: () => [create(village.CraftRequestSchema, { ...envelope, recipeId: 'plank', qty: 1 })],
    hearthCraft: () => [create(village.HearthCraftRequestSchema, { ...envelope, recipeId: 'plank', qty: 1 })],
    deskCopy: () => [create(village.DeskCopyRequestSchema, { ...envelope, pageId: 'p', qty: 1 })],
    mailSend: () => [create(village.MailSendRequestSchema, { ...envelope, toId: 't', asset: { kind: 'item', id: 'tallow', qty: 1 } })],
    mailClaim: () => ['m1', create(village.MailKeyedRequestSchema, { ...envelope })],
    mailRecall: () => ['m1', create(village.MailKeyedRequestSchema, { ...envelope })],
    contribute: () => ['p1', create(village.ContributeRequestSchema, { ...envelope, materials: { timber: 1 } })],
    itemAction: () => ['use', create(items.ItemsRequestSchema, { ...envelope, itemDef: 'tallow' })],
  };
  for (const [name, method] of Object.entries(client.raw)) {
    const before = calls.length;
    const args = messageArgs[name] ? messageArgs[name]() : [{}, {}];
    try { await (method as (...args: unknown[]) => Promise<unknown>)(...args); } catch {}
    assert.equal(calls.length, before + 1, name);
  }
  const library = createRemoteLibrary({ fetchImpl });
  await library.load();
  assert.equal(calls.length, Object.keys(client.raw).length + 1);
  for (const call of calls) assert.equal(new Headers(call.init?.headers).get('X-Glimway-Contract'), '6', call.url);
});

test('device ownership persists independently of tab clients', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const id = claimDeviceId(storage); assert.match(id, /^[A-Za-z0-9_-]{1,128}$/); assert.equal(claimDeviceId(storage), id);
  values.set('glimway-device-id', 'bad:id'); assert.notEqual(claimDeviceId(storage), 'bad:id');
});

test('contract 6 preserves quest times, gate spends and server item grants', () => {
  const fixture = fixtures.find(f => f.name === 'glimway.v1.Envelope' && f.case === 'quest-gates')!;
  const decoded = decodeEnvelope(fixture.json);
  assert.equal(decoded.state!.story!.reachedAt['set-to-rise'],1791400000);
  assert.equal(decoded.state!.story!.gateAt['set-to-rise'],1791400000);
  assert.equal(decoded.result.case,'questStep');
  if (decoded.result.case === 'questStep') {
    assert.equal(decoded.result.value.embersSpent,1);
    assert.equal(decoded.result.value.taken[0]!.def,'flour');
    assert.equal(decoded.result.value.given[0]!.qty,2);
  }
  for (const field of ['reachedAt','gateAt']) for (const at of [-1,Infinity,'1']) {
    const body = structuredClone(valid) as Record<string, any>; body.story[field] = { 'lantern-road': at };
    assert.throws(() => decodePlayerState(body));
  }
  for (const code of ['not-yet','not-here','needs-habitica','companion-not-owned','no-stable','stall-taken','stalls-in-use','stable-full','already-casting','cast-too-soon','water-still','no-cast']) assert.equal(errorFromResponse(409, { error: { code }, state: valid }).code,code);
});
