import raw from '../../content/presence.json' with { type: 'json' };
import type { PresenceMessage as GeneratedMessage, PresencePosition as GeneratedPosition, PresencePlayer as GeneratedPlayer, PresenceAvatar as GeneratedAvatar, PresenceAppearance } from './gen/glimway/v1/presence_pb.js';
export interface PresenceRules {
  maxSessionConnections: number; maxPlayerConnections: number; revalidateFailures: number;
  incomingMessagesPerSecond: number; incomingBurst: number; incomingExcessMs: number;
  emotes: string[]; positionHz: number; emoteCooldownMs: number; joinCooldownMs: number;
  maxConnections: number; maxRoomPlayers: number; messageBytes: number; queueMessages: number;
  authTimeoutMs: number; idleTimeoutMs: number; pingIntervalMs: number; pongTimeoutMs: number;
  leaveGraceMs: number; revalidateMs: number; writeTimeoutMs: number;
}
export function validatePresence(value: unknown): PresenceRules {
  const p = value as PresenceRules;
  const bad = (): never => { throw new Error('invalid presence'); };
  if (!p || typeof p !== 'object' || !Array.isArray(p.emotes) || p.emotes.length < 1 || p.emotes.length > 16 || new Set(p.emotes).size !== p.emotes.length || !p.emotes.every(id => typeof id === 'string' && /^[a-z0-9-]{1,32}$/.test(id))) return bad();
  for (const [n,min,max] of [[p.maxSessionConnections,1,16],[p.maxPlayerConnections,1,32],[p.revalidateFailures,1,10],[p.incomingMessagesPerSecond,1,120],[p.incomingBurst,1,240],[p.positionHz,1,20],[p.maxConnections,1,512],[p.maxRoomPlayers,1,p.maxConnections],[p.messageBytes,128,4096],[p.queueMessages,4,128]] as const) if (!Number.isSafeInteger(n) || n < min || n > max) return bad();
  for (const n of [p.incomingExcessMs,p.emoteCooldownMs,p.joinCooldownMs,p.authTimeoutMs,p.idleTimeoutMs,p.pingIntervalMs,p.pongTimeoutMs,p.leaveGraceMs,p.revalidateMs,p.writeTimeoutMs]) if (!Number.isSafeInteger(n) || n < 1 || n > 120_000) return bad();
  if (p.maxSessionConnections > p.maxPlayerConnections || p.pingIntervalMs >= p.idleTimeoutMs || p.pongTimeoutMs >= p.idleTimeoutMs) return bad();
  return p;
}
export const PRESENCE = validatePresence(raw);
type Fields<T> = Omit<T, '$typeName' | '$unknown'>;
type Payload<K> = Fields<Extract<GeneratedMessage['event'], { case: K }>['value']>;
type Event<K> = { type: K } & Payload<K>;
/** Views of generated payloads normalize nullable JSON fields for the game. */
export type PresenceAvatar = Omit<Fields<GeneratedAvatar>, 'appearance' | 'equipped' | 'costume' | 'selectedPet' | 'selectedMount'> & {
  appearance: Fields<PresenceAppearance>;
  equipped: Record<string, string | null>;
  costume: Record<string, string | null>;
  selectedPet: string | null;
  selectedMount: string | null;
};
export type PresencePosition = Required<Omit<Fields<GeneratedPosition>, 'facing' | 'habiticaId'>> & {
  facing: Required<Fields<NonNullable<GeneratedPosition['facing']>>>;
};
export type PresencePlayer = Omit<Fields<GeneratedPlayer>, 'avatar' | 'pos'> & {
  avatar: PresenceAvatar | null;
  pos: PresencePosition | null;
};
export type PresenceClientMessage = Event<'auth'> | Pick<Event<'join'>, 'type' | 'area'>
  | ({ type: 'pos' } & PresencePosition) | Pick<Event<'emote'>, 'type' | 'id'> | Event<'heartbeat'>;
export type PresenceServerMessage = Event<'ready'> | Event<'leave'> | Event<'gift'> | Event<'witness'>
  | (Pick<Event<'room'>, 'type' | 'area'> & { players: PresencePlayer[] })
  | (Pick<Event<'join'>, 'type' | 'area'> & { player: PresencePlayer })
  | ({ type: 'pos'; habiticaId: string } & PresencePosition)
  | (Event<'emote'> & { habiticaId: string });
export const PRESENCE_CLOSE = { unauthorized: 4001, superseded: 4002, replaced: 4003, idle: 4004 } as const;
