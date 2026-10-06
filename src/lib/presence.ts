import raw from '../../content/presence.json' with { type: 'json' };
import type { HabiticaProfile } from './habitica/types.ts';
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
/** Visual fields only; no stats, vitals, XP, credentials or collection lists. */
export type PresenceAvatar = Pick<HabiticaProfile, 'appearance' | 'equipped' | 'costume' | 'useCostume' | 'selectedPet' | 'selectedMount'>;
export interface PresencePosition { x: number; y: number; facing: { x: number; y: number }; moving: boolean }
export interface PresencePlayer { habiticaId: string; displayName: string; avatar: PresenceAvatar | null; pos: PresencePosition | null }
export type PresenceClientMessage =
  | { type: 'auth'; lease: string }
  | { type: 'join'; area: string }
  | ({ type: 'pos' } & PresencePosition)
  | { type: 'emote'; id: string }
  | { type: 'heartbeat' };
export type PresenceServerMessage =
  | { type: 'ready'; habiticaId: string }
  | { type: 'room'; area: string; players: PresencePlayer[] }
  | { type: 'join'; area: string; player: PresencePlayer }
  | { type: 'leave'; habiticaId: string }
  | ({ type: 'pos'; habiticaId: string } & PresencePosition)
  | { type: 'emote'; habiticaId: string; id: string }
  | { type: 'gift'; fromName: string; kind: string; itemDef: string; qty: number };
export const PRESENCE_CLOSE = { unauthorized: 4001, superseded: 4002, replaced: 4003, idle: 4004 } as const;
