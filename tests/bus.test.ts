import test from 'node:test';
import assert from 'node:assert/strict';
import { Bus, bus, EV, listen } from '../src/game/events.ts';

/**
 * The game ↔ UI bus (src/game/events.ts): a typed emitter that keeps
 * Phaser's `on(name, fn, ctx)` shape, without Phaser.
 */

type Map = { a: { n: number }; b: void; c: { what?: string } | undefined };

test('emit calls each listener with the payload and its context, in order', () => {
  const b = new Bus<Map>();
  const seen: string[] = [];
  const owner = { name: 'owner', on(p: { n: number }) { seen.push(`${this.name}:${p.n}`); } };
  b.on('a', owner.on, owner);
  b.on('a', (p) => seen.push(`plain:${p.n}`));
  assert.equal(b.emit('a', { n: 1 }), true);
  assert.deepEqual(seen, ['owner:1', 'plain:1']);
  assert.equal(b.emit('b'), false, 'nobody listens');
});

test('off removes by function, by function and context, or every listener of a name', () => {
  const b = new Bus<Map>();
  let hits = 0;
  const fn = () => hits++;
  const x = {};
  const y = {};
  b.on('b', fn, x);
  b.on('b', fn, y);
  b.off('b', fn, x);
  b.emit('b');
  assert.equal(hits, 1, 'only the other context is left');
  b.off('b', fn);
  b.emit('b');
  assert.equal(hits, 1);
  b.on('b', fn).on('b', () => hits++);
  b.off('b');
  assert.equal(b.listenerCount('b'), 0);
});

test('once fires a single time', () => {
  const b = new Bus<Map>();
  let hits = 0;
  b.once('b', () => hits++);
  b.emit('b');
  b.emit('b');
  assert.equal(hits, 1);
  assert.equal(b.listenerCount('b'), 0);
});

test('an emit walks the listeners as they were when it started', () => {
  const b = new Bus<Map>();
  const seen: string[] = [];
  const second = () => seen.push('second');
  b.on('b', () => {
    seen.push('first');
    b.off('b', second);
    b.on('b', () => seen.push('added'));
  });
  b.on('b', second);
  b.emit('b');
  assert.deepEqual(seen, ['first', 'second'], 'removed mid-emit still runs; added mid-emit waits');
  seen.length = 0;
  b.emit('b');
  assert.deepEqual(seen, ['first', 'added']);
});

test('an optional payload may be left out', () => {
  const b = new Bus<Map>();
  const got: unknown[] = [];
  b.on('c', (p) => got.push(p?.what));
  b.emit('c');
  b.emit('c', { what: 'mail' });
  assert.deepEqual(got, [undefined, 'mail']);
});

test('listen subscribes a set of handlers and hands back their unsubscribe', () => {
  const seen: string[] = [];
  const stop = listen({
    [EV.thought]: (p) => seen.push(p.text),
    [EV.libraryOpen]: () => seen.push('library')
  });
  bus.emit(EV.thought, { text: 'hm' });
  bus.emit(EV.libraryOpen);
  stop();
  bus.emit(EV.thought, { text: 'gone' });
  assert.deepEqual(seen, ['hm', 'library']);
  assert.equal(bus.listenerCount(EV.thought), 0);
});

test('every event name is unique', () => {
  const names = Object.values(EV);
  assert.equal(new Set(names).size, names.length);
});
