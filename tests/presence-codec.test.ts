import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { create, fromJson, toBinary, type JsonValue } from '@bufbuild/protobuf';
import { decodePresence, encodePresence, poseOf } from '../src/lib/presence-codec.ts';
import { PresenceMessageSchema, PresencePositionSchema, PresenceAvatarChangeSchema } from '../src/lib/gen/glimway/v2/presence_pb.js';
import { decodeTestPresence } from './presence-wire.ts';

/** Lane A's sample messages (content/vectors/crafts-fixtures.json), by name. */
const fixtures = new Map(
  (JSON.parse(readFileSync(new URL('../content/vectors/crafts-fixtures.json', import.meta.url), 'utf8')) as { messages: { name: string; json: JsonValue }[] }).messages.map((m) => [m.name, m.json]),
);
const wire = (event: Record<string, JsonValue>) => toBinary(PresenceMessageSchema, fromJson(PresenceMessageSchema, event as JsonValue));

test('presence codec: a position carries its pose, both ways; an unknown pose reads as on foot', () => {
  const riding = decodePresence(wire({ pos: fixtures.get('presence-position-riding')! }));
  assert.deepEqual(riding, { type: 'pos', accountId: 'fixture-account', x: 412.5, y: 318, moving: true, facing: { x: 0, y: 1 }, pose: 'riding' });
  const fishing = decodePresence(wire({ pos: fixtures.get('presence-position-fishing')! }));
  assert.equal((fishing as { pose?: string }).pose, 'fishing');
  const odd = toBinary(PresenceMessageSchema, create(PresenceMessageSchema, { event: { case: 'pos', value: create(PresencePositionSchema, { x: 1, y: 2, moving: false, facing: { x: 0, y: 1 }, accountId: 'a', pose: 'flying' }) } }));
  assert.equal('pose' in (decodePresence(odd) as object), false);

  const sent = decodeTestPresence(encodePresence({ type: 'pos', x: 10, y: 20, facing: { x: 1, y: 0 }, moving: true, pose: 'riding' }));
  assert.equal(sent.type, 'pos');
  assert.equal(sent.pose, 'riding');
  const onFoot = decodeTestPresence(encodePresence({ type: 'pos', x: 10, y: 20, facing: { x: 1, y: 0 }, moving: true }));
  assert.equal(onFoot.pose, undefined);
  assert.equal(poseOf('riding'), 'riding');
  assert.equal(poseOf(''), undefined);
});

test('presence codec: an avatar change carries the resolved follower and the mount that is out', () => {
  const m = decodePresence(wire({ avatarChange: fixtures.get('presence-avatar-change')! }));
  assert.equal(m?.type, 'avatarChange');
  if (m?.type !== 'avatarChange') return;
  assert.equal(m.accountId, 'fixture-account');
  assert.equal(typeof m.avatar.appearance, 'object');
  // '' on the wire means none.
  const cleared = toBinary(PresenceMessageSchema, create(PresenceMessageSchema, { event: { case: 'avatarChange', value: create(PresenceAvatarChangeSchema, { accountId: 'b', avatar: { ...fromJson(PresenceAvatarChangeSchema, fixtures.get('presence-avatar-change')!).avatar!, selectedPet: '', selectedMount: '' } }) } }));
  const c = decodePresence(cleared);
  assert.equal(c?.type === 'avatarChange' && c.avatar.selectedPet, null);
  assert.equal(c?.type === 'avatarChange' && c.avatar.selectedMount, null);
  // No avatar: dropped.
  const none = toBinary(PresenceMessageSchema, create(PresenceMessageSchema, { event: { case: 'avatarChange', value: create(PresenceAvatarChangeSchema, { accountId: 'b' }) } }));
  assert.equal(decodePresence(none), null);
});

test('presence codec: a relayed Ward-light carries the hub\'s pulse; a client never sends one', () => {
  const ward = decodePresence(wire({ ability: { ability: 'ward-light', x: 1, y: 2, accountId: 'a', pulseHeal: 6.4 } }));
  assert.deepEqual(ward, { type: 'ability', accountId: 'a', ability: 'ward-light', x: 1, y: 2, pulseHeal: 6.4 });
  const none = decodePresence(wire({ ability: { ability: 'ward-light', x: 1, y: 2, accountId: 'a' } }));
  assert.equal('pulseHeal' in (none as object), false);
  const zero = decodePresence(wire({ ability: { ability: 'ward-light', x: 1, y: 2, accountId: 'a', pulseHeal: 0 } }));
  assert.equal('pulseHeal' in (zero as object), false, 'zero reads as none: the fallback applies');
  const sent = decodeTestPresence(encodePresence({ type: 'ability', ability: 'ward-light', x: 1, y: 2 }));
  assert.equal(sent.pulseHeal, undefined);
});
