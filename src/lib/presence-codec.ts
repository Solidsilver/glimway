import { create, fromBinary, toBinary, type Message } from '@bufbuild/protobuf';
import { FightSwingSchema, PresenceFrameSchema, PresenceMessageSchema, PresenceAuthSchema, PresenceJoinSchema, PresencePositionSchema, PresenceEmoteSchema, PresenceHeartbeatSchema, PresenceAbilitySchema, type PresenceAvatar as WireAvatar, type PresenceMessage as WireMessage, type PresencePlayer as WirePlayer, type PresencePosition as WirePosition } from './gen/glimway/v2/presence_pb.js';
import { PRESENCE_POSES, type PresenceAvatar, type PresenceClientMessage, type PresencePlayer, type PresencePose, type PresencePosition, type PresenceServerMessage } from './presence.ts';

export const PRESENCE_PROTOCOL = 'glimway.presence.v4';

export function encodePresence(message: PresenceClientMessage): Uint8Array {
  // create() builds generated messages directly; presence never passes through JSON.
  const envelope = create(PresenceMessageSchema);
  switch (message.type) {
    case 'fightSwing': envelope.event = { case: 'fightSwing', value: create(FightSwingSchema, message) }; break;
    case 'auth': envelope.event = { case: 'auth', value: create(PresenceAuthSchema, { lease: message.lease }) }; break;
    case 'join': envelope.event = { case: 'join', value: create(PresenceJoinSchema, { area: message.area }) }; break;
    case 'pos': envelope.event = { case: 'pos', value: create(PresencePositionSchema, { x: message.x, y: message.y, facing: message.facing, moving: message.moving, ...(poseOf(message.pose) ? { pose: message.pose } : {}) }) }; break;
    case 'emote': envelope.event = { case: 'emote', value: create(PresenceEmoteSchema, { id: message.id }) }; break;
    case 'heartbeat': envelope.event = { case: 'heartbeat', value: create(PresenceHeartbeatSchema) }; break;
    case 'ability': envelope.event = { case: 'ability', value: create(PresenceAbilitySchema, { ability: message.ability, x: message.x, y: message.y, fight: message.fight }) }; break;
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

/**
 * One server frame (v4): the events it carries, in order, each decoded as
 * if it had come alone. An event this build doesn't know, or one that fails
 * its checks, is left out without losing the others. Anything that isn't a
 * binary frame decodes to no events.
 */
export function decodePresenceFrame(data: unknown): PresenceServerMessage[] {
  if (!(data instanceof ArrayBuffer || data instanceof Uint8Array)) return [];
  const { events } = fromBinary(PresenceFrameSchema, data instanceof Uint8Array ? data : new Uint8Array(data));
  const out: PresenceServerMessage[] = [];
  for (const event of events) {
    const m = decodeEvent(event);
    if (m) out.push(m);
  }
  return out;
}

/** One event's bytes (a PresenceMessage), as tests and fixtures hold them. */
export function decodePresence(data: unknown): PresenceServerMessage | null {
  if (!(data instanceof ArrayBuffer || data instanceof Uint8Array)) return null;
  return decodeEvent(fromBinary(PresenceMessageSchema, data instanceof Uint8Array ? data : new Uint8Array(data)));
}

function decodeEvent({ event }: WireMessage): PresenceServerMessage | null {
  switch (event.case) {
    case 'fightJoin':
      return event.value.room > 0 && event.value.critSeed > 0 && event.value.roomKey ? { type: 'fightJoin', ...fields(event.value) } : null;
    case 'fightDelta':
      return event.value.room > 0 && (event.value.changed.length + event.value.spawned.length + event.value.removed.length > 0) ? { type: 'fightDelta', ...fields(event.value) } : null;
    case 'fightEvent':
      return event.value.room > 0 && event.value.kind >= 1 && event.value.kind <= 5 ? { type: 'fightEvent', ...fields(event.value) } : null;
    case 'fightSwingResult':
    case 'ready': case 'leave': case 'gift': return { type: event.case, ...fields(event.value) } as PresenceServerMessage;
    case 'witness': return event.value.name ? { type: 'witness', ...fields(event.value) } : null;
    case 'room': return { type: 'room', area: event.value.area, players: event.value.players.map(player) };
    case 'join': return event.value.player ? { type: 'join', area: event.value.area, player: player(event.value.player) } : null;
    case 'pos': {
      const p = position(event.value);
      return p && event.value.accountId !== undefined ? { type: 'pos', accountId: event.value.accountId, ...p } : null;
    }
    case 'emote': return event.value.accountId !== undefined ? { type: 'emote', accountId: event.value.accountId, id: event.value.id } : null;
    case 'homeChanged': return event.value.gate < 8 ? { type: 'homeChanged', gate: event.value.gate } : null;
    case 'avatarChange': {
      const a = avatar(event.value.avatar);
      return event.value.accountId && a ? { type: 'avatarChange', accountId: event.value.accountId, avatar: a } : null;
    }
    case 'ability': {
      const a = event.value;
      if (a.accountId === undefined || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return null;
      const heal = a.pulseHeal !== undefined && Number.isFinite(a.pulseHeal) && a.pulseHeal > 0 ? { pulseHeal: a.pulseHeal } : {};
      return { type: 'ability', accountId: a.accountId, ability: a.ability, x: a.x, y: a.y, ...heal };
    }
    default: return null;
  }
}
