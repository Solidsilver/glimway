import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJson, toBinary, type JsonValue } from '@bufbuild/protobuf';
import { parseCalendar } from '../src/lib/api/calendar.ts';
import { SERVER_ERROR_CODES, errorFromResponse } from '../src/lib/api/errors.ts';
import { decodePresence, encodePresence, PRESENCE_PROTOCOL } from '../src/lib/presence-codec.ts';
import { PresenceMessageSchema } from '../src/lib/gen/glimway/v1/presence_pb.js';
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
  const responses = fixture('errors');
  assert.deepEqual([...SERVER_ERROR_CODES].sort(), responses.map((r: any) => r.error.code).sort());
  for (const response of responses) assert.equal(errorFromResponse(409, response).code, response.error.code);
  assert.equal(errorFromResponse(409, { error: { code: 'a-future-server-code' } }).code, 'unknown');
});

test('Go binary fixtures and legacy JSON decode to the same presence events', () => {
  for (const { json, binaryHex } of fixture('presence')) {
    assert.ok(binaryHex);
    const bytes = Uint8Array.from(Buffer.from(binaryHex, 'hex'));
    assert.deepEqual(decodePresence(bytes), json);
    assert.deepEqual(decodePresence(bytes.buffer), json);
    assert.deepEqual(decodePresence(JSON.stringify(json)), json);
    if (['auth', 'heartbeat', 'pos', 'emote', 'join'].includes(json.type) && !('habiticaId' in json) && !('player' in json)) {
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
  server(message: Record<string, unknown>) {
    const { type, ...payload } = message;
    const data = this.protocol ? toBinary(PresenceMessageSchema, fromJson(PresenceMessageSchema, { [String(type)]: payload } as JsonValue)).buffer : JSON.stringify(message);
    this.onmessage?.({ data });
  }
}

for (const protocol of ['', PRESENCE_PROTOCOL]) {
  test(`presence client negotiates and uses ${protocol ? 'binary' : 'legacy JSON'} for the entire connection`, () => {
    const socket = new ContractSocket(protocol);
    let offered: string[] | undefined;
    const events: unknown[] = [];
    const client = new PresenceClient({
      url: 'ws://example/ws',
      makeSocket: (_url, protocols) => { offered = protocols; return socket; },
      handlers: { ready: id => events.push(id), pos: (id, pos) => events.push({ id, pos }) },
    });
    try {
      client.setArea('village');
      client.start('a'.repeat(64));
      assert.deepEqual(offered, [PRESENCE_PROTOCOL]);
      assert.equal(socket.binaryType, 'arraybuffer');
      socket.onopen?.({});
      const sent = (): PresenceClientMessage[] => socket.sent.map(data => (typeof data === 'string' ? JSON.parse(data) : decodePresence(data)) as PresenceClientMessage);
      assert.deepEqual(sent(), [{ type: 'auth', lease: 'a'.repeat(64) }]);
      // Same new-server payloads feed both an old JSON connection and a new binary one.
      socket.server({ type: 'ready', habiticaId: 'alice' });
      assert.equal(client.status, 'live');
      assert.deepEqual(sent()[1], { type: 'join', area: 'village' });
      socket.server({ type: 'pos', habiticaId: 'bob', x: 0, y: 2, facing: { x: 0, y: 1 }, moving: false });
      assert.deepEqual(events, ['alice', { id: 'bob', pos: { x: 0, y: 2, facing: { x: 0, y: 1 }, moving: false } }]);
      assert.ok(socket.sent.every(data => protocol ? data instanceof Uint8Array : typeof data === 'string'));
    } finally { client.stop(); }
  });
}
