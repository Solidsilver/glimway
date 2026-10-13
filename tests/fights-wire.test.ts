import test from 'node:test';
import assert from 'node:assert/strict';
import { fromBinary, fromJsonString, toBinary, equals } from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';
import { PresenceMessageSchema } from '../src/lib/gen/glimway/v2/presence_pb.js';
import fixtures from '../content/vectors/fights-wire.json' with { type: 'json' };
const validator = createValidator();
for (const v of fixtures) test(`contract 10 wire: ${v.name}`, () => {
  const message = fromJsonString(PresenceMessageSchema, JSON.stringify(v.json));
  const bytes = toBinary(PresenceMessageSchema, message);
  assert.equal(Buffer.from(bytes).toString('hex'), v.binaryHex);
  const decoded = fromBinary(PresenceMessageSchema, Buffer.from(v.binaryHex, 'hex'));
  assert.ok(equals(PresenceMessageSchema, decoded, message));
  assert.equal(validator.validate(PresenceMessageSchema, decoded).kind, v.valid ? 'valid' : 'invalid');
  if (message.event.case === 'fightSwing') assert.ok(bytes.length < 1024);
});
