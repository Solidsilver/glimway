import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/presence.json' with { type: 'json' };
import presenceRaw from '../content/presence.json' with { type: 'json' };
import { PRESENCE, PRESENCE_CLOSE, validatePresence } from '../src/lib/presence.ts';
import { refusalMatchesRule } from './helpers/vector-rule.ts';
test('presence content shares bounded rates, emotes and protocol limits', () => {
  assert.equal(PRESENCE.positionHz,8); assert.equal(PRESENCE.messageBytes,1024); assert.equal(PRESENCE.maxConnections,128);assert.equal(PRESENCE.maxRoomPlayers,32);
  assert.deepEqual(PRESENCE.emotes,['wave','nod','cheer','thanks','lantern']);assert.equal(PRESENCE_CLOSE.superseded,4002);
});

test('presence admission and ingress limits are bounded and shared', () => {
  assert.equal(PRESENCE.maxSessionConnections, 2);
  assert.equal(PRESENCE.maxPlayerConnections, 4);
  assert.equal(PRESENCE.revalidateFailures, 3);
  assert.equal(PRESENCE.incomingMessagesPerSecond, 30);
  assert.equal(PRESENCE.incomingBurst, 60);
  assert.equal(PRESENCE.incomingExcessMs, 5000);
});

// The loader vectors: the shipped presence plus mutations, each refusal
// naming its rule — the same file the Go test runs.
interface Edit { path: (string | number)[]; value?: unknown; remove?: boolean }
for (const v of vectors.loader) test(`shared presence loader: ${v.name}`, () => {
  const value = structuredClone(presenceRaw) as Record<string, unknown>;
  for (const e of v.edits as Edit[]) { let target = value as any; for (const key of e.path.slice(0, -1)) target = target[key]; if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value; }
  if (v.valid) assert.doesNotThrow(() => validatePresence(value));
  else assert.throws(() => validatePresence(value), (e: Error) => refusalMatchesRule(e, v.rule), v.rule);
});
test('presence loader refuses the empty and the null outright', () => {
  for (const raw of [null, {}, [], { ...presenceRaw, emotes: [null] }]) assert.throws(() => validatePresence(raw));
});
