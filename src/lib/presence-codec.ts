import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from '@bufbuild/protobuf';
import { PresenceMessageSchema } from './gen/glimway/v1/presence_pb.js';
import type { PresenceClientMessage, PresenceServerMessage } from './presence.ts';

export const PRESENCE_PROTOCOL = 'glimway.presence.v1';

export function encodePresence(message: PresenceClientMessage): Uint8Array {
  const { type, ...payload } = message;
  return toBinary(PresenceMessageSchema, fromJson(PresenceMessageSchema, { [type]: payload } as JsonValue));
}

/** Both deployments decode with the generated schema. Old tabs use JSON. */
export function decodePresence(data: unknown): PresenceServerMessage | null {
  const binary = data instanceof ArrayBuffer || data instanceof Uint8Array;
  let envelope;
  if (binary) {
    envelope = fromBinary(PresenceMessageSchema, data instanceof Uint8Array ? data : new Uint8Array(data));
  } else {
    const { type, ...payload } = JSON.parse(String(data));
    if (type === 'witness' && typeof payload.name !== 'string') return null;
    if (typeof type !== 'string' || !PresenceMessageSchema.fields.some(field => field.name === type)) return null;
    envelope = fromJson(PresenceMessageSchema, { [type]: payload }, { ignoreUnknownFields: true });
  }
  const type = envelope.event.case;
  if (!type) return null;
  const json = toJson(PresenceMessageSchema, envelope, { alwaysEmitImplicit: true }) as Record<string, any>;
  const payload = json[type];
  const player = (p: Record<string, any>) => {
    p.pos ??= null;
    p.avatar ??= null;
    if (p.avatar) {
      p.avatar.selectedPet ??= null;
      p.avatar.selectedMount ??= null;
    }
    return p;
  };
  if (type === 'room') payload.players = (payload.players ?? []).map(player);
  if (type === 'join' && payload.player) payload.player = player(payload.player);
  return { type, ...payload } as PresenceServerMessage;
}
