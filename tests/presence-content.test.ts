import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESENCE, PRESENCE_CLOSE, validatePresence } from '../src/lib/presence.ts';
test('presence content shares bounded rates, emotes and protocol limits', () => {
  assert.equal(PRESENCE.positionHz,8); assert.equal(PRESENCE.messageBytes,1024); assert.equal(PRESENCE.maxConnections,128);assert.equal(PRESENCE.maxRoomPlayers,32);
  assert.deepEqual(PRESENCE.emotes,['wave','nod','cheer','thanks','lantern']);assert.equal(PRESENCE_CLOSE.superseded,4002);
});
test('presence loader rejects malformed limits and duplicate or unsafe emotes', () => {
  for (const mutate of [(p:typeof PRESENCE)=>{p.emotes.push(p.emotes[0]);},(p:typeof PRESENCE)=>{p.emotes=['<script>'];},(p:typeof PRESENCE)=>{p.positionHz=100;},(p:typeof PRESENCE)=>{p.maxConnections=0;},(p:typeof PRESENCE)=>{p.maxRoomPlayers=129;},(p:typeof PRESENCE)=>{p.messageBytes=100_000;},(p:typeof PRESENCE)=>{p.queueMessages=10000;},(p:typeof PRESENCE)=>{p.idleTimeoutMs=0;},(p:typeof PRESENCE)=>{p.pingIntervalMs=p.idleTimeoutMs;}]) {const p=structuredClone(PRESENCE);mutate(p);assert.throws(()=>validatePresence(p));}
  for (const raw of [null,{},[],{...PRESENCE,emotes:[null]}]) assert.throws(()=>validatePresence(raw));
});

test('presence admission and ingress limits are bounded and shared', () => {
  assert.equal(PRESENCE.maxSessionConnections, 2);
  assert.equal(PRESENCE.maxPlayerConnections, 4);
  assert.equal(PRESENCE.revalidateFailures, 3);
  assert.equal(PRESENCE.incomingMessagesPerSecond, 30);
  assert.equal(PRESENCE.incomingBurst, 60);
  assert.equal(PRESENCE.incomingExcessMs, 5000);
  for (const [key, value] of [
    ['maxSessionConnections', 0], ['maxSessionConnections', 5],
    ['maxPlayerConnections', 33], ['revalidateFailures', 11],
    ['incomingMessagesPerSecond', 0], ['incomingBurst', 241], ['incomingExcessMs', 0],
  ]) assert.throws(() => validatePresence({ ...PRESENCE, [key]: value }));
});
