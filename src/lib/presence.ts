import raw from '../../content/presence.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { PresenceSchema } from './gen/glimway/content/v1/presence_pb.js';
import type { PresenceMessage as GeneratedMessage, PresencePosition as GeneratedPosition, PresencePlayer as GeneratedPlayer, PresenceAvatar as GeneratedAvatar, PresenceAppearance } from './gen/glimway/v2/presence_pb.js';
export interface PresenceRules {
  maxSessionConnections: number; maxPlayerConnections: number; revalidateFailures: number;
  incomingMessagesPerSecond: number; incomingBurst: number; incomingExcessMs: number;
  emotes: string[]; positionHz: number; emoteCooldownMs: number; joinCooldownMs: number;
  maxConnections: number; maxRoomPlayers: number; messageBytes: number; queueMessages: number;
  authTimeoutMs: number; idleTimeoutMs: number; pingIntervalMs: number; pongTimeoutMs: number;
  leaveGraceMs: number; revalidateMs: number; writeTimeoutMs: number;
}
/**
 * Reads presence JSON through the schema (proto/glimway/content/v1/
 * presence.proto): the bounds, the emote vocabulary and uniqueness and
 * the capacity/ping orderings are all on it; nothing is left in code.
 */
export function validatePresence(value: unknown): PresenceRules {
  return decodeContent(PresenceSchema, value, 'presence', []) as unknown as PresenceRules;
}
export const PRESENCE = validatePresence(raw);
type Fields<T> = Omit<T, '$typeName' | '$unknown'>;
type Payload<K> = Fields<Extract<GeneratedMessage['event'], { case: K }>['value']>;
type Event<K> = { type: K } & Payload<K>;
/** Views of generated payloads normalize nullable fields for the game. */
export type PresenceAvatar = Omit<Fields<GeneratedAvatar>, 'appearance' | 'equipped' | 'costume' | 'selectedPet' | 'selectedMount'> & {
  appearance: Fields<PresenceAppearance>;
  equipped: Record<string, string | null>;
  costume: Record<string, string | null>;
  selectedPet: string | null;
  selectedMount: string | null;
};
/** `pose` is the wire's optional one ("riding" | "fishing"; absent on foot). */
export type PresencePosition = Required<Omit<Fields<GeneratedPosition>, 'facing' | 'accountId' | 'pose'>> & {
  facing: Required<Fields<NonNullable<GeneratedPosition['facing']>>>;
  pose?: string;
};
export type PresencePlayer = Omit<Fields<GeneratedPlayer>, 'avatar' | 'pos'> & {
  avatar: PresenceAvatar | null;
  pos: PresencePosition | null;
};
export type PresenceClientMessage = Event<'auth'> | Pick<Event<'join'>, 'type' | 'area'>
  | ({ type: 'pos' } & PresencePosition) | Pick<Event<'emote'>, 'type' | 'id'> | Event<'heartbeat'>
  | Pick<Event<'ability'>, 'type' | 'ability' | 'x' | 'y'>;
export type PresenceServerMessage = Event<'ready'> | Event<'leave'> | Event<'gift'> | Event<'witness'>
  | (Pick<Event<'room'>, 'type' | 'area'> & { players: PresencePlayer[] })
  | (Pick<Event<'join'>, 'type' | 'area'> & { player: PresencePlayer })
  | ({ type: 'pos'; accountId: string } & PresencePosition)
  | (Event<'emote'> & { accountId: string })
  | (Pick<Event<'ability'>, 'type' | 'ability' | 'x' | 'y'> & { accountId: string });
export const PRESENCE_CLOSE = { unauthorized: 4001, superseded: 4002, replaced: 4003, idle: 4004, reloadNeeded: 4005 } as const;
