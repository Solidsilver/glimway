import raw from '../../content/residents.json' with { type: 'json' };
import { ResidentsSchema, type ResidentPhaseValid, type ResidentSpotValid, type ResidentValid, type ResidentsValid } from './gen/glimway/content/v1/residents_pb.js';
import { knownContentArea, roomFor, roomContainsTile, roomWalkable, type Room } from './rooms.ts';
import { cycleAt } from './clock.ts';
import { decodeContent } from './content-proto.ts';

/** The generated messages (proto/glimway/content/v1/residents.proto), with the schema's required fields non-optional. */
export type Residents = ResidentsValid;
export type Resident = ResidentValid;
export type ResidentSpot = ResidentSpotValid;
export type ResidentPhase = ResidentPhaseValid;

/** The rules that reach into rooms and the cycle's arithmetic: duplicate ids, an offset inside the period, spot areas and homes that name rooms, spots that stand somewhere real, and a cycle whose minutes make one full period. Field rules live on the schema. */
function residentRules(doc: Residents): void {
  const bad = (s: string): never => { throw new Error(`invalid residents: ${s}`); };
  const seen = new Set<string>();
  for (const r of doc.residents) {
    // One id per resident: the loader's own rule, naming the duplicate.
    if (seen.has(r.id)) bad(`duplicate id ${r.id}`);
    seen.add(r.id);
    if ((r.offsetMinutes ?? 0) >= doc.periodMinutes) bad(`offset ${r.id}`);
    if (r.home !== undefined && !roomFor(r.home)) bad(`home ${r.id}`);
    for (const s of Object.values(r.spots)) {
      if (!knownContentArea(s.area)) bad(`spot ${r.id}`);
      const room = roomFor(s.area);
      if (room && !residentSpotFits(room, s)) bad(`blocked spot ${r.id}`);
    }
    if (r.cycle.reduce((n, p) => n + p.minutes, 0) !== doc.periodMinutes) bad(`phase total ${r.id}`);
  }
}

export function validateResidents(value: unknown): Residents {
  const doc = decodeContent(ResidentsSchema, value, 'residents', ['residents']) as Residents;
  residentRules(doc);
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
/** Where someone stands: a spot's fields, plain (a resolved place, not a message). */
export interface ResidentPlace { area: string; tx: number; ty: number; seated?: boolean }
/** The cycle-backed area and tile, or null for an unknown person. Unix seconds. */
export function residentAt(id: string, now: number): ResidentPlace | null {
  const resident = residentById(id);
  if (!resident) return null;
  const { area, tx, ty, seated } = resident.spots[cycleAt(resident, now).spot]!;
  return seated === undefined ? { area, tx, ty } : { area, tx, ty, seated };
}
