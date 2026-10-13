// JSON is only a readable test fixture format, never a presence transport.
import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from '@bufbuild/protobuf';
import { PresenceMessageSchema } from '../src/lib/gen/glimway/v2/presence_pb.js';
export function encodeTestPresence(message: object): Uint8Array {
  const { type, ...payload } = message as Record<string, unknown>;
  try {
    return toBinary(PresenceMessageSchema, fromJson(PresenceMessageSchema, { [String(type)]: payload } as JsonValue));
  } catch { return Uint8Array.from([0x1a, 0x20]); }
}
export function decodeTestPresence(data: string | Uint8Array): any {
  if (typeof data === 'string') throw new Error('expected binary');
  const envelope = fromBinary(PresenceMessageSchema, data);
  const json = toJson(PresenceMessageSchema, envelope, { alwaysEmitImplicit: true }) as Record<string, any>;
  const type = envelope.event.case;
  return { type, ...json[type!] };
}
/**
 * A server frame (v3) carrying these events, in order, assembled the way the
 * server does it: each event's bytes prefixed with field 1's tag and length,
 * so a deliberately malformed event travels as it is.
 */
export function encodeTestFrame(messages: object[]): Uint8Array {
  const parts: number[] = [];
  for (const m of messages) {
    const event = encodeTestPresence(m);
    parts.push(0x0a);
    let n = event.length;
    while (n >= 0x80) { parts.push((n & 0x7f) | 0x80); n >>>= 7; }
    parts.push(n);
    parts.push(...event);
  }
  return Uint8Array.from(parts);
}
