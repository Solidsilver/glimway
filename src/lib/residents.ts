import raw from '../../content/residents.json' with { type: 'json' };
import { knownContentArea, roomFor, roomWalkable, roomContainsTile, type Room } from './rooms.ts';
import { cycleAt } from './clock.ts';

export interface ResidentSpot { area: string; tx: number; ty: number; seated?: boolean }
export interface ResidentPhase { spot: string; minutes: number }
export interface Resident { id: string; offsetMinutes?: number; home?: string; spots: Record<string, ResidentSpot>; cycle: ResidentPhase[] }
export interface Residents { periodMinutes: number; graceSeconds: number; residents: Resident[] }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length <= 100 && /^[a-z0-9-]+$/.test(v);
const int = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export function validateResidents(value: unknown): Residents {
  const bad = (s: string): never => { throw new Error(`invalid residents: ${s}`); };
  if (!obj(value) || !int(value.periodMinutes) || value.periodMinutes < 1 || value.periodMinutes > 1440 || !int(value.graceSeconds) || value.graceSeconds > value.periodMinutes * 60 || !Array.isArray(value.residents) || !value.residents.length) return bad('period/grace/empty');
  const doc = value as unknown as Residents, seen = new Set<string>();
  for (const r of doc.residents) {
    if (!obj(r) || !keys(r, ['id','offsetMinutes','home','spots','cycle']) || !id(r.id) || seen.has(r.id) || !int(r.offsetMinutes ?? 0) || (r.offsetMinutes ?? 0) >= doc.periodMinutes || !obj(r.spots) || !Object.keys(r.spots).length || !Array.isArray(r.cycle) || !r.cycle.length) return bad('resident');
    if (r.home !== undefined && !roomFor(r.home)) return bad(`home ${r.id}`);
    for (const [name, s] of Object.entries(r.spots)) {
      if (!id(name) || !obj(s) || !keys(s, ['area','tx','ty','seated']) || typeof s.area !== 'string' || !knownContentArea(s.area) || !int(s.tx) || !int(s.ty) || s.seated !== undefined && typeof s.seated !== 'boolean') return bad(`spot ${r.id}`);
      const room = roomFor(s.area); if (room && !residentSpotFits(room, s)) return bad(`blocked spot ${r.id}`);
    }
    let total = 0; const used = new Set<string>();
    for (const p of r.cycle) { if (!obj(p) || !keys(p, ['spot','minutes']) || typeof p.spot !== 'string' || !Object.hasOwn(r.spots, p.spot) || !int(p.minutes) || p.minutes < 1) return bad(`phase ${r.id}`); total += p.minutes; used.add(p.spot); }
    if (total !== doc.periodMinutes || used.size !== Object.keys(r.spots).length) return bad(`phase total/unused spot ${r.id}`);
    if (r.home !== undefined && !Object.values(r.spots).some(s => s.area === r.home)) return bad(`unused home ${r.id}`);
    seen.add(r.id);
  }
  return doc;
}
/** A seated resident may occupy furniture beside a walkable tile, never a wall. */
export function residentSpotFits(room: Room, spot: ResidentSpot): boolean {
  if (roomWalkable(room, spot.tx, spot.ty)) return true;
  if (!spot.seated || !roomContainsTile(room, spot.tx, spot.ty)) return false;
  const char = room.map[spot.ty]![spot.tx]!;
  return room.props.some(p => p.char === char) && [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => roomWalkable(room, spot.tx + dx!, spot.ty + dy!));
}
export const RESIDENTS = validateResidents(raw);
export function residentById(id: string): Resident | null { return RESIDENTS.residents.find(r => r.id === id) ?? null; }
/** The cycle-backed area and tile, or null for an unknown person. Unix seconds. */
export function residentAt(id: string, now: number): ResidentSpot | null {
  const resident = residentById(id);
  return resident ? resident.spots[cycleAt(resident, now).spot]! : null;
}
