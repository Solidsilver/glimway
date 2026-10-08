import test from 'node:test';
import assert from 'node:assert/strict';
import { noteServerClock, serverSkew } from '../src/lib/server-time.ts';
import { serverNow, setGameNow } from '../src/game/clock.ts';

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

test('the server’s clock: the Date header’s skew (half a second past its truncated second), and an exact stamp preferred', () => {
  const received = Date.parse('2026-10-08T14:00:10.000Z');
  // The server is two minutes ahead.
  noteServerClock(headers({ date: 'Thu, 08 Oct 2026 14:02:10 GMT' }), received);
  assert.equal(serverSkew(), 120.5);
  // A stamp from the server's own clock (a dev clock included) wins over the Date header.
  noteServerClock(headers({ date: 'Thu, 08 Oct 2026 14:02:10 GMT', 'x-glimway-now': String(received / 1000 + 3600.25) }), received);
  assert.equal(serverSkew(), 3600.25);
  // Nothing usable: the last skew stands.
  noteServerClock(headers({ date: 'not a date' }), received);
  noteServerClock(undefined, received);
  assert.equal(serverSkew(), 3600.25);
  noteServerClock(headers({ date: new Date(received).toUTCString() }), received);
  assert.equal(serverSkew(), 0.5);
});

test('serverNow: the device clock and the skew; a moved dev clock is the time instead', () => {
  noteServerClock(headers({ date: new Date(Date.now() + 300_000).toUTCString() }));
  assert.ok(Math.abs(serverNow() - (Date.now() / 1000 + 300)) < 2);
  setGameNow(2_000_000_000);
  assert.ok(Math.abs(serverNow() - 2_000_000_000) < 2, 'a playtest moves both clocks to the same moment');
  setGameNow(null);
  noteServerClock(headers({ date: new Date().toUTCString() }));
});
