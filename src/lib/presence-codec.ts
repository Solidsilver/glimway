import { create, fromBinary, toBinary, type Message } from '@bufbuild/protobuf';
import { PresenceMessageSchema, PresenceAuthSchema, PresenceJoinSchema, PresencePositionSchema, PresenceEmoteSchema, PresenceHeartbeatSchema, type PresenceAvatar as WireAvatar, type PresencePlayer as WirePlayer, type PresencePosition as WirePosition } from './gen/glimway/v2/presence_pb.js';
import { PRESENCE_POSES, type PresenceAvatar, type PresenceClientMessage, type PresencePlayer, type PresencePose, type PresencePosition, type PresenceServerMessage } from './presence.ts';

export const PRESENCE_PROTOCOL = 'glimway.presence.v2';

export function encodePresence(message: PresenceClientMessage): Uint8Array {
  // create() builds generated messages directly; presence never passes through JSON.
  const envelope = create(PresenceMessageSchema);
  switch (message.type) {
    case 'auth': envelope.event = { case: 'auth', value: create(PresenceAuthSchema, { lease: message.lease }) }; break;
    case 'join': envelope.event = { case: 'join', value: create(PresenceJoinSchema, { area: message.area }) }; break;
    case 'pos': envelope.event = { case: 'pos', value: create(PresencePositionSchema, { x: message.x, y: message.y, facing: message.facing, moving: message.moving, ...(poseOf(message.pose) ? { pose: message.pose } : {}) }) }; break;
    case 'emote': envelope.event = { case: 'emote', value: create(PresenceEmoteSchema, { id: message.id }) }; break;
    case 'heartbeat': envelope.event = { case: 'heartbeat', value: create(PresenceHeartbeatSchema) }; break;
  }
  return toBinary(PresenceMessageSchema, envelope);
}

function fields<T extends Message>(message: T): Omit<T, '$typeName' | '$unknown'> {
  const { $typeName, $unknown, ...values } = message;
  return values;
}
/** A pose this build draws, or undefined: an unknown one reads as on foot. */
export function poseOf(pose: string | undefined): PresencePose | undefined {
  return (PRESENCE_POSES as readonly string[]).includes(pose ?? '') ? (pose as PresencePose) : undefined;
}
function position(p: WirePosition | undefined): PresencePosition | null {
  if (!p || p.x === undefined || p.y === undefined || p.moving === undefined || p.facing?.x === undefined || p.facing.y === undefined) return null;
  if (![p.x, p.y, p.facing.x, p.facing.y].every(Number.isFinite)) return null;
  const pose = poseOf(p.pose);
  return { x: p.x, y: p.y, moving: p.moving, facing: { x: p.facing.x, y: p.facing.y }, ...(pose ? { pose } : {}) };
}
function avatar(a: WireAvatar | undefined): PresenceAvatar | null {
  if (!a?.appearance) return null;
  const slots = (values: WireAvatar['equipped']) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.kind.case === 'stringValue' ? value.kind.value : null]));
  // The server's resolved follower and the mount that's out (crafts.md 6.1); '' is none.
  return { appearance: fields(a.appearance), equipped: slots(a.equipped), costume: slots(a.costume), useCostume: a.useCostume, selectedPet: a.selectedPet || null, selectedMount: a.selectedMount || null };
}
function player(p: WirePlayer): PresencePlayer {
  return { accountId: p.accountId, displayName: p.displayName, avatar: avatar(p.avatar), pos: position(p.pos) };
}

export function decodePresence(data: unknown): PresenceServerMessage | null {
  if (!(data instanceof ArrayBuffer || data instanceof Uint8Array)) return null;
  const { event } = fromBinary(PresenceMessageSchema, data instanceof Uint8Array ? data : new Uint8Array(data));
  switch (event.case) {
    case 'ready': case 'leave': case 'gift': return { type: event.case, ...fields(event.value) } as PresenceServerMessage;
    case 'witness': return event.value.name ? { type: 'witness', ...fields(event.value) } : null;
    case 'room': return { type: 'room', area: event.value.area, players: event.value.players.map(player) };
    case 'join': return event.value.player ? { type: 'join', area: event.value.area, player: player(event.value.player) } : null;
    case 'pos': {
      const p = position(event.value);
      return p && event.value.accountId !== undefined ? { type: 'pos', accountId: event.value.accountId, ...p } : null;
    }
    case 'emote': return event.value.accountId !== undefined ? { type: 'emote', accountId: event.value.accountId, id: event.value.id } : null;
    case 'avatarChange': {
      const a = avatar(event.value.avatar);
      return event.value.accountId && a ? { type: 'avatarChange', accountId: event.value.accountId, avatar: a } : null;
    }
    default: return null;
  }
}
