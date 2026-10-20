import { decodeTestPresence } from './presence-wire.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { create, fromBinary, fromJson, toBinary, type JsonValue } from '@bufbuild/protobuf';
import { parseCreatedInvite, parseInviteList } from '../src/lib/api/invites.ts';
import { parseCalendar } from '../src/lib/api/calendar.ts';
import { SERVER_ERROR_CODES, errorFromResponse } from '../src/lib/api/errors.ts';
import { decodePresence, decodePresenceFrame, encodePresence, PRESENCE_PROTOCOL } from '../src/lib/presence-codec.ts';
import { PresenceFrameSchema, PresenceMessageSchema } from '../src/lib/gen/glimway/v2/presence_pb.js';
import { PresenceClient, type SocketLike } from '../src/lib/presence-client.ts';
import type { PresenceClientMessage } from '../src/lib/presence.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../server/internal/api/testdata/${name}.json`, import.meta.url), 'utf8'));

test('generated calendar decoder reads the original Go HTTP fixtures without shape changes', () => {
  for (const { body } of fixture('calendar')) assert.deepEqual(parseCalendar(body), body);
  const base = fixture('calendar')[0].body;
  assert.deepEqual(parseCalendar({ ...base, futureField: [] }), base);
  for (const value of ['1767571200', null, Infinity, 'NaN']) {
    assert.throws(() => parseCalendar({ ...base, startsAt: value }), { code: 'bad-response' });
  }
});

test('generated error enum preserves every original wire string and unknown-version behavior', () => {
  const responses = fixture('errors-v3');
  const since = ['not-yet', 'not-here', 'needs-habitica', 'companion-not-owned', 'no-stable', 'stall-taken', 'stalls-in-use', 'stable-full', 'already-casting', 'cast-too-soon', 'water-still', 'no-cast', 'purse-busy', 'top-up-limit', 'insufficient-gold', 'own-stock', 'gear-not-owned', 'insufficient-glims', 'top-up-cap', 'already-laid', 'not-your-path', 'cannot-lay-here', 'beyond-frontier', 'lantern-full', 'no-home', 'cannot-hold', 'no-camp', 'camp-not-empty', 'no-lamp', 'lamp-lit', 'not-common', 'not-your-lamp', 'in-a-fight', 'pouch-unbound', 'lamp-elsewhere', 'lamp-packed', 'lamp-unlit', 'lamp-gone', 'no-landing', 'needs-keeper', 'lamp-named', 'invalid-naming', 'not-your-camp', 'not-in-world', 'already-tapped', 'beyond-sight', 'beyond-border'];
  assert.deepEqual([...SERVER_ERROR_CODES].sort(), [...responses.map((r: any) => r.error.code), ...since].sort());
  for (const response of responses) assert.equal(errorFromResponse(409, response).code, response.error.code);
  assert.equal(errorFromResponse(409, { error: { code: 'a-future-server-code' } }).code, 'unknown');
});

test('Go binary fixtures preserve presence fields in the generated decoder', () => {
  for (const { json, binaryHex } of fixture('presence-v2')) {
    assert.ok(binaryHex);
    const bytes = Uint8Array.from(Buffer.from(binaryHex, 'hex'));
    const clientEvent = ['auth', 'heartbeat', 'pos', 'emote', 'join'].includes(json.type) && !('accountId' in json) && !('player' in json);
    if (clientEvent) assert.deepEqual(decodeTestPresence(bytes), json);
    else {
      assert.deepEqual(decodePresence(bytes), json);
      assert.deepEqual(decodePresence(bytes.buffer), json);
    }
    assert.equal(decodePresence(JSON.stringify(json)), null);
    if (['auth', 'heartbeat', 'pos', 'emote', 'join'].includes(json.type) && !('accountId' in json) && !('player' in json)) {
      assert.deepEqual(Buffer.from(encodePresence(json)).toString('hex'), binaryHex);
    }
  }
  assert.equal(decodePresence(Uint8Array.from([0x7a, 0])), null, 'unknown future event');
  assert.throws(() => decodePresence(Uint8Array.from([0x1a, 0x20])));
});

class ContractSocket implements SocketLike {
  readyState = 1;
  binaryType = '';
  sent: (string | Uint8Array)[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly protocol: string;
  constructor(protocol: string) { this.protocol = protocol; }
  send(data: string | Uint8Array) { this.sent.push(data); }
  close() { this.readyState = 3; }
  /** One server frame carrying these events (v3), as an ArrayBuffer like a browser's. */
  server(...messages: Record<string, unknown>[]) {
    const events = messages.map(({ type, ...payload }) => fromJson(PresenceMessageSchema, { [String(type)]: payload } as JsonValue));
    const data = toBinary(PresenceFrameSchema, create(PresenceFrameSchema, { events })).buffer;
    this.onmessage?.({ data });
  }
}

test('Go frame fixtures: a lone event and a batch decode to their events in order', () => {
  const frames = fixture('presence-frame') as { events: Record<string, unknown>[]; binaryHex: string }[];
  assert.equal(frames.length, 2);
  for (const { events, binaryHex } of frames) {
    const bytes = Uint8Array.from(Buffer.from(binaryHex, 'hex'));
    assert.deepEqual(decodePresenceFrame(bytes), events);
    assert.deepEqual(decodePresenceFrame(bytes.buffer), events);
  }
  assert.equal(frames[0].events.length, 1);
  assert.equal(frames[1].events.length, 3);
  // An event this build doesn't know, inside a batch, is skipped without losing the others.
  const unknown = Uint8Array.from([0x7a, 0]);
  const readyFixture = (fixture('presence-v2') as { json: { type: string }; binaryHex: string }[]).find(f => f.json.type === 'ready')!;
  const ready = Uint8Array.from(Buffer.from(readyFixture.binaryHex, 'hex'));
  const batch = toBinary(PresenceFrameSchema, create(PresenceFrameSchema, { events: [fromBinary(PresenceMessageSchema, unknown), fromBinary(PresenceMessageSchema, ready), fromBinary(PresenceMessageSchema, unknown)] }));
  assert.deepEqual(decodePresenceFrame(batch), [readyFixture.json]);
  assert.deepEqual(decodePresenceFrame(new Uint8Array(0)), [], 'an empty frame');
  assert.deepEqual(decodePresenceFrame('{"type":"ready"}'), [], 'not binary');
  assert.throws(() => decodePresenceFrame(Uint8Array.from([0x0a, 0x20])), 'a truncated frame');
});

test('the client dispatches a batched frame in order, each event as if alone', () => {
  const socket = new ContractSocket(PRESENCE_PROTOCOL);
  const seen: string[] = [];
  const client = new PresenceClient({
    url: 'ws://example/ws',
    makeSocket: () => socket,
    handlers: {
      ready: () => seen.push('ready'),
      room: (area, players) => seen.push(`room:${area}:${players.length}`),
      pos: (id) => seen.push(`pos:${id}`),
      leave: (id) => seen.push(`leave:${id}`),
      emote: (id, emote) => seen.push(`emote:${id}:${emote}`),
    },
  });
  try {
    client.setArea('woodland');
    client.start('a'.repeat(64));
    socket.onopen?.({});
    socket.server({ type: 'ready', accountId: 'alice' });
    socket.server(
      { type: 'room', area: 'woodland', players: [] },
      { type: 'pos', accountId: 'bob', x: 1, y: 2, facing: { x: 0, y: 1 }, moving: true },
      { type: 'emote', accountId: 'bob', id: 'wave' },
      { type: 'leave', accountId: 'bob' },
    );
    assert.deepEqual(seen, ['ready', 'room:woodland:0', 'pos:bob', 'emote:bob:wave', 'leave:bob']);
  } finally { client.stop(); }
});

for (const protocol of [PRESENCE_PROTOCOL]) {
  test(`presence client negotiates binary for the entire connection`, () => {
    const socket = new ContractSocket(protocol);
    let offered: string[] | undefined;
    const events: unknown[] = [];
    const client = new PresenceClient({
      url: 'ws://example/ws',
      makeSocket: (_url, protocols) => { offered = protocols; return socket; },
      handlers: { ready: id => events.push(id), pos: (id, pos) => events.push({ id, pos }) },
    });
    try {
      client.setArea('woodland');
      client.start('a'.repeat(64));
      assert.deepEqual(offered, [PRESENCE_PROTOCOL]);
      assert.equal(socket.binaryType, 'arraybuffer');
      socket.onopen?.({});
      const sent = (): PresenceClientMessage[] => socket.sent.map(data => decodeTestPresence(data) as PresenceClientMessage);
      assert.deepEqual(sent(), [{ type: 'auth', lease: 'a'.repeat(64) }]);
      // Generated binary payloads drive the real client.
      socket.server({ type: 'ready', accountId: 'alice' });
      assert.equal(client.status, 'live');
      assert.deepEqual(sent()[1], { type: 'join', area: 'woodland' });
      socket.server({ type: 'pos', accountId: 'bob', x: 0, y: 2, facing: { x: 0, y: 1 }, moving: false });
      assert.deepEqual(events, ['alice', { id: 'bob', pos: { x: 0, y: 2, facing: { x: 0, y: 1 }, moving: false } }]);
      assert.ok(socket.sent.every(data => protocol ? data instanceof Uint8Array : typeof data === 'string'));
    } finally { client.stop(); }
  });
}

for (const negotiated of ['', 'glimway.presence.future']) {
  test(`missing or incompatible protocol (${negotiated}) requires a reload without auth or retry`, () => {
    const socket = new ContractSocket(negotiated);
    let opens = 0;
    const client = new PresenceClient({ url: 'ws://example/ws', makeSocket: () => { opens++; return socket; } });
    client.start('a'.repeat(64));
    socket.onopen?.({});
    assert.equal(client.status, 'reload-needed');
    assert.equal(socket.sent.length, 0);
    client.start('a'.repeat(64));
    assert.equal(opens, 1);
    client.stop();
  });
}
test('server close 4005 requires reload and latches the current lease', () => {
  const socket = new ContractSocket(PRESENCE_PROTOCOL);
  let opens = 0;
  const client = new PresenceClient({ url: 'ws://example/ws', makeSocket: () => { opens++; return socket; } });
  client.start('a'.repeat(64));
  socket.onclose?.({ code: 4005, reason: 'reload-needed' });
  assert.equal(client.status, 'reload-needed');
  client.start('a'.repeat(64));
  assert.equal(opens, 1);
  client.stop();
});

test('generated invite decoders preserve the original Go HTTP keys, zeros and numeric times', () => {
  for (const { method, body } of fixture('invites')) {
    const parse = method === 'POST' ? parseCreatedInvite : parseInviteList;
    assert.deepEqual(parse(body), body);
    assert.deepEqual(parse({ ...body, futureField: [] }), body);
    if (method === 'GET' && body.invites.length) {
      assert.deepEqual(parse({ ...body, invites: body.invites.map((v: unknown) => ({ ...(v as object), futureField: true })) }), body);
    }
  }
  const created = fixture('invites').find((f: any) => f.method === 'POST').body;
  for (const key of ['createdAt', 'expiresAt']) {
    for (const value of [null, '2200000000', Infinity, 'NaN', '-Infinity']) {
      assert.throws(() => parseCreatedInvite({ ...created, [key]: value }), { code: 'bad-response' });
    }
  }
  for (const key of ['id', 'code', 'used', 'createdAt', 'expiresAt']) {
    const { [key]: omitted, ...missing } = created;
    assert.throws(() => parseCreatedInvite(missing), { code: 'bad-response' });
  }
  const list = fixture('invites')[0].body;
  for (const key of ['invites', 'remaining', 'outstandingLimit', 'partyWorld', 'partyAdmitted']) {
    const { [key]: omitted, ...missing } = list;
    assert.throws(() => parseInviteList(missing), { code: 'bad-response' });
  }
  for (const value of [-1, 1.5, 2147483648, '0', null, Infinity]) {
    assert.throws(() => parseInviteList({ ...list, remaining: value }), { code: 'bad-response' });
  }
  for (const value of ['yes', null, 0]) {
    assert.throws(() => parseInviteList({ ...list, partyWorld: value }), { code: 'bad-response' });
  }
});


test('invite decoders reject proto-name aliases at every boundary, including valid duplicate values', () => {
  const created = fixture('invites').find((f: any) => f.method === 'POST').body;
  const populated = fixture('invites').find((f: any) => f.name === 'populated').body;
  for (const [alias, key] of [['created_at', 'createdAt'], ['expires_at', 'expiresAt']]) {
    for (const value of ['NaN', 'Infinity', '-Infinity', null, created[key]]) {
      for (const aliasFirst of [true, false]) {
        const duplicate = aliasFirst ? { [alias]: value, ...created } : { ...created, [alias]: value };
        assert.throws(() => parseCreatedInvite(duplicate), { code: 'bad-response' });
        assert.throws(() => parseInviteList({ ...populated, invites: [{ ...populated.invites[0], [alias]: value }] }), { code: 'bad-response' });
      }
    }
  }
  for (const [alias, key] of [['outstanding_limit', 'outstandingLimit'], ['party_world', 'partyWorld'], ['party_admitted', 'partyAdmitted']]) {
    for (const value of ['-4', null, populated[key]]) {
      assert.throws(() => parseInviteList({ ...populated, [alias]: value }), { code: 'bad-response' });
      assert.throws(() => parseInviteList({ [alias]: value, ...populated }), { code: 'bad-response' });
    }
  }
  for (const key of ['remaining', 'outstandingLimit']) {
    for (const value of [-1, 1.5, 2147483648, '0', null, Infinity, NaN]) {
      assert.throws(() => parseInviteList({ ...populated, [key]: value }), { code: 'bad-response' });
    }
    assert.equal(parseInviteList({ ...populated, [key]: 2147483647 })[key as 'remaining' | 'outstandingLimit'], 2147483647);
  }
});
