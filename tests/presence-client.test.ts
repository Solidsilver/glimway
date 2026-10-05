import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PresenceClient,
  closeAction,
  isPresenceArea,
  normalFacing,
  presenceAreaFor,
  presenceBackoff,
  type PresenceStatus,
  type SocketLike,
  type Timers,
} from '../src/lib/presence-client.ts';
import type { PresencePlayer } from '../src/lib/presence.ts';

/** Manual clock: `advance` runs due timers in order. */
function fakeTimers() {
  let t = 1_000;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    now: () => t,
    set: (fn, ms) => {
      const id = ++seq;
      due.set(id, { at: t + ms, fn });
      return id;
    },
    clear: (h) => void due.delete(h as number),
  };
  return {
    timers,
    get now() {
      return t;
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }
      t = end;
    },
  };
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: any[] = [];
  closedWith: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }
  // Server side
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const player = (id: string, over: Partial<PresencePlayer> = {}): PresencePlayer => ({ habiticaId: id, displayName: id, avatar: null, pos: null, ...over });

function rig() {
  const clock = fakeTimers();
  const sockets: FakeSocket[] = [];
  const statuses: PresenceStatus[] = [];
  const events: any[] = [];
  const client = new PresenceClient({
    url: 'ws://test/ws',
    makeSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    timers: clock.timers,
    random: () => 0.5,
    handlers: {
      status: (s) => statuses.push(s),
      room: (area, players) => events.push({ room: area, players: players.map((p) => p.habiticaId) }),
      join: (area, p) => events.push({ join: area, id: p.habiticaId }),
      leave: (id) => events.push({ leave: id }),
      pos: (id, p) => events.push({ pos: id, x: p.x }),
      emote: (id, e) => events.push({ emote: id, id: e }),
    },
  });
  const sock = () => sockets[sockets.length - 1];
  /** Connect and finish auth. */
  const live = () => {
    client.start('L'.repeat(64));
    sock().open();
    sock().push({ type: 'ready', habiticaId: 'me' });
  };
  const sentTypes = () => sock().sent.map((m) => m.type);
  return { clock, client, sockets, sock, statuses, events, live, sentTypes };
}

const at = (x: number, moving = true) => ({ x, y: 100, facing: { x: 1, y: 0 }, moving });

test('auth goes first, in the message (never the URL); nothing else until ready', () => {
  const r = rig();
  r.client.setArea('village');
  r.client.position(at(10, false));
  r.client.start('lease-abc');
  assert.equal(r.sock().url, 'ws://test/ws');
  assert.ok(!r.sock().url.includes('lease'));
  r.sock().open();
  assert.deepEqual(r.sock().sent, [{ type: 'auth', lease: 'lease-abc' }]);
  assert.equal(r.client.emote('wave'), false, 'no emotes before ready');
  r.sock().push({ type: 'ready', habiticaId: 'me' });
  assert.deepEqual(r.sentTypes(), ['auth', 'join']);
  assert.equal(r.sock().sent[1].area, 'village');
  assert.equal(r.client.status, 'live');
});

test('after the room roster, peers learn where we stand (even standing still)', () => {
  const r = rig();
  r.live();
  r.client.setArea('village');
  r.client.position(at(40, false));
  r.sock().push({ type: 'room', area: 'village', players: [player('bob')] });
  r.clock.advance(200);
  const pos = r.sock().sent.filter((m) => m.type === 'pos');
  assert.equal(pos.length, 1);
  assert.deepEqual(pos[0], { type: 'pos', x: 40, y: 100, facing: { x: 1, y: 0 }, moving: false });
  assert.deepEqual(r.events[0], { room: 'village', players: ['bob'] });
});

test('positions go out at most 8 Hz while moving; the latest sample is not lost; a final stop follows', () => {
  const r = rig();
  r.live();
  r.client.setArea('village');
  r.sock().push({ type: 'room', area: 'village', players: [] });
  // 60 frames in a second of walking.
  for (let i = 0; i < 60; i++) {
    r.client.position(at(i));
    r.clock.advance(1000 / 60);
  }
  r.client.position(at(60, false)); // stop
  r.clock.advance(300);
  const pos = r.sock().sent.filter((m) => m.type === 'pos');
  assert.ok(pos.length <= 10, `${pos.length} position messages in ~1.3 s`);
  assert.ok(pos.length >= 8);
  assert.deepEqual(pos[pos.length - 1], { type: 'pos', x: 60, y: 100, facing: { x: 1, y: 0 }, moving: false }, 'the final stop');
  // Standing still afterwards sends nothing more.
  const n = r.sock().sent.length;
  for (let i = 0; i < 30; i++) {
    r.client.position(at(60, false));
    r.clock.advance(100);
  }
  assert.equal(r.sock().sent.filter((m) => m.type === 'pos').length, pos.length);
  assert.ok(r.sock().sent.length >= n);
});

test('position spacing never drops below 125 ms', () => {
  const r = rig();
  const stamps: number[] = [];
  r.live();
  const s = r.sock();
  const send = s.send.bind(s);
  s.send = (d: string) => {
    if (JSON.parse(d).type === 'pos') stamps.push(r.clock.now);
    send(d);
  };
  r.client.setArea('village');
  r.sock().push({ type: 'room', area: 'village', players: [] });
  for (let i = 0; i < 100; i++) {
    r.client.position(at(i));
    r.clock.advance(7);
  }
  r.clock.advance(500);
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= 125, `gap ${stamps[i] - stamps[i - 1]}`);
});

test('area changes are paced by the join cooldown, and the latest area wins', () => {
  const r = rig();
  r.live();
  r.client.setArea('village');
  r.client.setArea('woodland');
  r.client.setArea('ruin');
  assert.deepEqual(r.sock().sent.filter((m) => m.type === 'join').map((m) => m.area), ['village']);
  r.clock.advance(499);
  assert.equal(r.sock().sent.filter((m) => m.type === 'join').length, 1);
  r.clock.advance(2);
  assert.deepEqual(r.sock().sent.filter((m) => m.type === 'join').map((m) => m.area), ['village', 'ruin']);
  // A roster for the area we left is ignored.
  r.sock().push({ type: 'room', area: 'village', players: [player('ghost')] });
  assert.equal(r.events.length, 0);
  // An area presence doesn't cover sends nothing.
  r.client.setArea('somewhere-else');
  r.clock.advance(1000);
  assert.equal(r.sock().sent.filter((m) => m.type === 'join').length, 2);
});

test('emotes: shared ids only, one per 2 s', () => {
  const r = rig();
  r.live();
  r.client.setArea('village');
  assert.equal(r.client.emote('dance'), false);
  assert.equal(r.client.emote('wave'), true);
  assert.equal(r.client.emote('cheer'), false);
  assert.ok(r.client.emoteWait() > 0);
  r.clock.advance(2000);
  assert.equal(r.client.emote('cheer'), true);
  assert.deepEqual(r.sock().sent.filter((m) => m.type === 'emote').map((m) => m.id), ['wave', 'cheer']);
});

test('a still socket sends a heartbeat about every 20 s; activity postpones it', () => {
  const r = rig();
  r.live();
  r.client.setArea('village');
  r.clock.advance(19_000);
  assert.equal(r.sentTypes().filter((t) => t === 'heartbeat').length, 0);
  r.clock.advance(1_500);
  assert.equal(r.sentTypes().filter((t) => t === 'heartbeat').length, 1);
  r.clock.advance(10_000);
  r.client.emote('nod');
  r.clock.advance(15_000);
  assert.equal(r.sentTypes().filter((t) => t === 'heartbeat').length, 1, 'the emote counted as activity');
  r.clock.advance(6_000);
  assert.equal(r.sentTypes().filter((t) => t === 'heartbeat').length, 2);
});

test('relayed messages reach the handlers; malformed ones are ignored', () => {
  const r = rig();
  r.live();
  r.client.setArea('village');
  r.sock().push({ type: 'join', area: 'village', player: player('bob') });
  r.sock().push({ type: 'pos', habiticaId: 'bob', x: 5, y: 6, facing: { x: 0, y: 1 }, moving: true });
  r.sock().push({ type: 'pos', habiticaId: 'bob', x: 'nope', y: 6 });
  r.sock().push({ type: 'emote', habiticaId: 'bob', id: 'wave' });
  r.sock().push({ type: 'emote', habiticaId: 'bob', id: 'not-an-emote' });
  r.sock().push({ type: 'leave', habiticaId: 'bob' });
  r.sock().onmessage?.({ data: '{nope' });
  assert.deepEqual(r.events, [{ join: 'village', id: 'bob' }, { pos: 'bob', x: 5 }, { emote: 'bob', id: 'wave' }, { leave: 'bob' }]);
});

test('lost transport reconnects with backoff, re-auths and re-joins', () => {
  const r = rig();
  r.live();
  r.client.setArea('commons');
  r.sock().drop(1006);
  assert.equal(r.client.status, 'retrying');
  assert.equal(r.sockets.length, 1);
  r.clock.advance(999);
  assert.equal(r.sockets.length, 1);
  r.clock.advance(5);
  assert.equal(r.sockets.length, 2, 'one second later');
  r.sock().open();
  r.sock().push({ type: 'ready', habiticaId: 'me' });
  assert.deepEqual(r.sentTypes(), ['auth', 'join']);
  assert.equal(r.sock().sent[1].area, 'commons');
  // Repeated failures back off further.
  r.sock().drop(1013);
  r.clock.advance(1_100);
  r.sock().drop(1006);
  const before = r.sockets.length;
  r.clock.advance(1_900);
  assert.equal(r.sockets.length, before, 'waits ~2 s the second time');
  r.clock.advance(200);
  assert.equal(r.sockets.length, before + 1);
});

test('a refused upgrade (seen as 1006) and a flood close keep retrying with bounded backoff', () => {
  const r = rig();
  r.live();
  for (let i = 0; i < 12; i++) {
    r.sock().drop(1006);
    r.clock.advance(31_000);
  }
  assert.equal(r.sockets.length, 13, 'still trying, at most every ~30 s');
  r.sock().open();
  r.sock().push({ type: 'ready', habiticaId: 'me' });
  assert.equal(r.client.status, 'live');
  r.sock().onclose?.({ code: 1008, reason: 'rate-limited' });
  assert.equal(r.client.status, 'retrying');
});

test('superseded, unauthorized, replaced and protocol rejections stop for good', () => {
  for (const [code, status] of [[4002, 'superseded'], [4001, 'unauthorized'], [4003, 'replaced'], [1008, 'rejected']] as const) {
    const r = rig();
    r.live();
    r.sock().drop(code);
    r.clock.advance(120_000);
    assert.equal(r.sockets.length, 1, `no reconnect after ${code}`);
    assert.equal(r.client.status, status);
  }
});

test('stop closes the socket and cancels everything; a new lease restarts it', () => {
  const r = rig();
  r.live();
  r.client.setArea('village');
  r.client.stop();
  assert.equal(r.sock().closedWith, 1000);
  assert.equal(r.client.status, 'off');
  r.clock.advance(60_000);
  assert.equal(r.sockets.length, 1);
  r.client.start('lease-2');
  assert.equal(r.sockets.length, 2);
  r.client.start('lease-2'); // same lease: no churn
  assert.equal(r.sockets.length, 2);
  r.client.start('lease-3');
  assert.equal(r.sockets.length, 3);
  assert.equal(r.sockets[1].closedWith, 1000);
});

test('helpers: areas, facing, backoff, close codes', () => {
  for (const a of ['village', 'woodland', 'ruin', 'commons', 'wilds:inner-1:0:1', 'wilds:outer-1:2:0']) assert.equal(isPresenceArea(a), true, a);
  for (const a of ['wilds', 'wilds:inner-1:01:1', 'wilds:inner-1:-1:0', 'chunk:inner-1:0:0', 'cottage', '']) assert.equal(isPresenceArea(a), false, a);
  assert.equal(presenceAreaFor('chunk:inner-1:2:1'), 'wilds:inner-1:2:1');
  assert.equal(presenceAreaFor('village'), 'village');
  assert.equal(presenceAreaFor('wilds'), null);
  assert.deepEqual(normalFacing({ x: 3, y: 4 }), { x: 0.6, y: 0.8 });
  assert.deepEqual(normalFacing({ x: 0, y: 0 }), { x: 0, y: 1 });
  const f = normalFacing({ x: 1, y: 1 });
  assert.ok(Math.abs(f.x * f.x + f.y * f.y - 1) < 0.01);
  assert.equal(presenceBackoff(1, () => 0.5), 1000);
  assert.equal(presenceBackoff(3, () => 0.5), 4000);
  assert.equal(presenceBackoff(20, () => 0.5), 30_000);
  assert.ok(presenceBackoff(1, () => 0) >= 800 && presenceBackoff(1, () => 1) <= 1200);
  assert.equal(closeAction(4004), 'retry');
  assert.equal(closeAction(1001), 'retry');
  assert.equal(closeAction(1006), 'retry');
  assert.equal(closeAction(1009), 'rejected');
  // Fix round 6: a flood close and DB trouble back off; other 1008s are bugs.
  assert.equal(closeAction(1008, 'rate-limited'), 'retry');
  assert.equal(closeAction(1008, 'invalid-position'), 'rejected');
  assert.equal(closeAction(1011, 'auth-unavailable'), 'retry');
});
