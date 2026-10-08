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
