import { encodeTestPresence, decodeTestPresence } from './presence-wire.ts';
import { PRESENCE_PROTOCOL } from '../src/lib/presence-codec.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PresenceFeed, type FeedLink } from '../src/game/presence-feed.ts';
import { EV } from '../src/game/event-names.ts';
import { RENDER_DELAY_MS } from '../src/lib/presence-interp.ts';
import type { SocketLike, Timers } from '../src/lib/presence-client.ts';

/**
 * The real PresenceFeed with a stub link and bus, fake sockets and a manual
 * clock (review-6: the feed's link checks must not override the client).
 */

function clock() {
  let t = 10_000;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void; every?: number }>();
  const timers: Timers = {
    now: () => t,
    set: (fn, ms) => (due.set(++seq, { at: t + ms, fn }), seq),
    clear: (h) => void due.delete(h as number),
  };
  return {
    timers,
    now: () => t,
    every: (fn: () => void, ms: number) => (due.set(++seq, { at: t + ms, fn, every: ms }), seq),
    cancel: (h: unknown) => void due.delete(h as number),
    pending: () => due.size,
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, d] = next;
        t = Math.max(t, d.at);
        if (d.every) d.at = t + d.every;
        else due.delete(id);
        d.fn();
      }
      t = end;
    },
  };
}

class FakeSocket implements SocketLike {
  readonly protocol = PRESENCE_PROTOCOL;
  readyState = 0;
  sent: any[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string | Uint8Array) {
    this.sent.push(decodeTestPresence(d));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(m: object) {
    this.onmessage?.({ data: encodeTestPresence(m) });
  }
  drop(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function rig() {
  const c = clock();
  const sockets: FakeSocket[] = [];
  const handlers = new Map<string, Set<Function>>();
  const emitted: Array<{ event: string; payload: any }> = [];
  const bus = {
    on: (e: string, fn: Function) => (handlers.get(e) ?? handlers.set(e, new Set()).get(e)!).add(fn),
    off: (e: string, fn: Function) => handlers.get(e)?.delete(fn),
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
      for (const fn of handlers.get(event) ?? []) fn(payload);
    },
  };
  const link = { active: true, status: 'online', lease: 'L1', beats: 0, beat: async () => void link.beats++ } as FeedLink & { beats: number; lease: string | null; status: string; active: boolean };
  const feed = new PresenceFeed({
    link,
    bus,
    url: 'ws://test/ws',
    makeSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    timers: c.timers,
    every: c.every,
    cancel: c.cancel,
    now: c.now,
  });
  const sock = () => sockets[sockets.length - 1];
  const ready = () => {
    sock().open();
    sock().push({ type: 'ready', accountId: 'me' });
  };
  return { c, sockets, sock, ready, link, feed, bus, handlers, emitted };
}

test('terminal closes stay closed through link checks while the link stays online (review-6 #1)', () => {
  for (const [code, reason, status] of [
    [4001, 'unauthorized', 'unauthorized'],
    [4002, 'superseded', 'superseded'],
    [4003, 'replaced', 'replaced'],
    [1008, 'invalid-position', 'rejected'],
  ] as const) {
    const r = rig();
    r.ready();
    assert.equal(r.feed.live, true);
    r.sock().drop(code, reason);
    // Polls and link events keep coming, with the same lease still held.
    r.c.advance(60_000);
    r.bus.emit(EV.link, { status: 'online' });
    assert.equal(r.sockets.length, 1, `no reconnect after ${code}`);
    assert.equal(r.feed.client.status, status);
    if (code === 4001 || code === 4002) assert.ok(r.link.beats >= 1, 'the link is asked to confirm');
    // A new lease (the player took over again / signed in again) starts it.
    r.link.lease = 'L2';
    r.c.advance(2_000);
    assert.equal(r.sockets.length, 2, `a new lease restarts after ${code}`);
    r.feed.stop();
  }
});

test('refused upgrades back off toward 30 s even with link checks every 2 s (review-6 #2)', () => {
  const r = rig();
  const opened: number[] = [r.c.now()];
  for (let i = 0; i < 6; i++) {
    const n = r.sockets.length;
    r.sock().drop(1006); // what a browser shows for a 429 presence-session-limit
    while (r.sockets.length === n) r.c.advance(100);
    opened.push(r.c.now());
  }
  const gaps = opened.slice(1).map((t, i) => t - opened[i]);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] >= gaps[i - 1], `gaps: ${gaps.join(', ')}`);
  // 1, 2, 4, 8, 16, then the 30 s cap (each ±20% jitter).
  assert.ok(gaps[gaps.length - 1] >= 24_000, `backs off toward 30 s: ${gaps.join(', ')}`);
  // Sign-in and the lease were never touched.
  assert.equal(r.link.beats, 0);
  r.feed.stop();
});

test('a reconnect roster moves peers who moved while we were away, and clears unknown positions (review-6 #3)', () => {
  const r = rig();
  r.feed.setArea('village');
  r.ready();
  r.sock().push({
    type: 'room',
    area: 'village',
    players: [
      { accountId: 'bob', displayName: 'Bob', avatar: null, pos: { x: 10, y: 20, facing: { x: 1, y: 0 }, moving: false } },
      { accountId: 'cy', displayName: 'Cy', avatar: null, pos: { x: 50, y: 50, facing: { x: 0, y: 1 }, moving: false } },
    ],
  });
  r.c.advance(1_000);
  const drawn = (id: string) => r.feed.peersIn('village').find((p) => p.accountId === id)?.track.at(r.c.now());
  assert.equal(drawn('bob')?.x, 10);
  // Our transport drops; Bob walks to x=500 and stops meanwhile.
  r.sock().drop(1006);
  assert.equal(r.feed.client.status, 'retrying');
  r.c.advance(1_500);
  r.ready();
  r.sock().push({
    type: 'room',
    area: 'village',
    players: [
      { accountId: 'bob', displayName: 'Bob', avatar: null, pos: { x: 500, y: 20, facing: { x: 1, y: 0 }, moving: false } },
      { accountId: 'cy', displayName: 'Cy', avatar: null, pos: null },
    ],
  });
  r.c.advance(RENDER_DELAY_MS + 10);
  assert.equal(drawn('bob')?.x, 500, 'drawn where the roster says, not where we last saw them');
  assert.equal(drawn('cy'), null, 'no known position: not drawn at a stale one');
  r.feed.stop();
});

test('maker heart range uses the same six tile radius as the server', () => {
  const r = rig();
  r.feed.setArea('village');
  r.ready();
  r.feed.position({ x: 0, y: 0, facing: { x: 0, y: 1 }, moving: false });
  r.sock().push({
    type: 'room', area: 'village', players: [
      { accountId: 'near', displayName: 'Near', avatar: null, pos: { x: 96, y: 0, facing: { x: 0, y: 1 }, moving: false } },
      { accountId: 'far', displayName: 'Far', avatar: null, pos: { x: 97, y: 0, facing: { x: 0, y: 1 }, moving: false } },
    ],
  });
  r.c.advance(RENDER_DELAY_MS + 10);
  assert.equal(r.feed.isWithin('near', 6 * 16), true);
  assert.equal(r.feed.isWithin('far', 6 * 16), false);
  r.feed.stop();
});

test('stop closes the socket and removes the poll and the bus listener (review-6 #4)', () => {
  const r = rig();
  r.ready();
  assert.equal(r.handlers.get(EV.link)?.size, 1);
  const timersBefore = r.c.pending();
  assert.ok(timersBefore > 0);
  r.feed.stop();
  assert.equal(r.sock().closed, true);
  assert.equal(r.handlers.get(EV.link)?.size, 0, 'bus listener removed');
  assert.equal(r.c.pending(), 0, 'no poll, retry, heartbeat or stable timers left');
  r.bus.emit(EV.link, { status: 'online' });
  r.c.advance(120_000);
  assert.equal(r.sockets.length, 1, 'nothing reopens it');
  assert.equal(r.feed.running, false);
  r.feed.stop(); // idempotent
});

test('crafts: a peer\'s pose follows their positions, a look change mid-visit is redrawn, and our pose goes out', () => {
  const r = rig();
  r.feed.setArea('village');
  r.ready();
  const avatar = JSON.parse(JSON.stringify(
    { appearance: { size: 'slim', shirt: 'blue', skin: 'fair', hairColor: 'brown', hairStyle: 1, background: '', hairBangs: 0, hairMustache: 0, hairBeard: 0, hairFlower: 0 }, equipped: {}, costume: {}, useCostume: false, selectedPet: 'Fox-Golden', selectedMount: 'Wolf-Shade' },
  ));
  r.sock().push({ type: 'room', area: 'village', players: [{ accountId: 'bob', displayName: 'Bob', avatar, pos: { x: 10, y: 20, facing: { x: 1, y: 0 }, moving: true, pose: 'riding' } }] });
  const bob = () => r.feed.peersIn('village').find((p) => p.accountId === 'bob')!;
  assert.equal(bob().pose, 'riding');
  assert.equal(bob().avatar?.selectedPet, 'Fox-Golden');
  r.sock().push({ type: 'pos', accountId: 'bob', x: 12, y: 20, facing: { x: 1, y: 0 }, moving: true });
  assert.equal(bob().pose, undefined, 'on foot again');
  const look = bob().look;
  r.sock().push({ type: 'avatarChange', accountId: 'bob', avatar: { ...avatar, selectedPet: 'Cat-Siamese', selectedMount: '' } });
  assert.equal(bob().avatar?.selectedPet, 'Cat-Siamese');
  assert.equal(bob().avatar?.selectedMount, null, 'the mount went home');
  assert.ok(bob().look > look, 'the renderer redraws them');
  // Someone not in the room (their mount came home to the stable here): the
  // stable hears it, and nobody is drawn for them.
  const heard: string[] = [];
  r.bus.on(EV.companionsOf, (p) => heard.push(p.accountId));
  r.sock().push({ type: 'avatarChange', accountId: 'carol', avatar: { ...avatar, selectedMount: '' } });
  // Bob, in the room: a new follower is no news for the stable; a mount going out is.
  r.sock().push({ type: 'avatarChange', accountId: 'bob', avatar: { ...avatar, selectedPet: 'Owl-Spooky', selectedMount: '' } });
  r.sock().push({ type: 'avatarChange', accountId: 'bob', avatar: { ...avatar, selectedPet: 'Owl-Spooky', selectedMount: 'Wolf-Shade' } });
  assert.deepEqual(heard, ['carol', 'bob']);
  assert.equal(r.feed.peersIn('village').some((p) => p.accountId === 'carol'), false);
  // Ours: a pose change at the same spot is still news.
  r.c.advance(1_000);
  r.feed.position({ x: 5, y: 5, facing: { x: 0, y: 1 }, moving: false });
  r.c.advance(1_000);
  const before = r.sock().sent.filter((m) => m.type === 'pos').length;
  r.feed.position({ x: 5, y: 5, facing: { x: 0, y: 1 }, moving: false, pose: 'riding' });
  r.c.advance(1_000);
  const pos = r.sock().sent.filter((m) => m.type === 'pos');
  assert.ok(pos.length > before);
  assert.equal(pos.at(-1).pose, 'riding');
  r.feed.stop();
});
