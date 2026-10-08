import raw from '../../content/rooms.json' with { type: 'json' };
import story from '../../content/story.json' with { type: 'json' };
import { canPlace, furnishingFor, type Furnishing, type PlaceOn } from './furnishings.ts';

export interface RoomTile { tx: number; ty: number }
export interface RoomDoor { id: string; kind: 'door' | 'stair'; at: string; side: 'north' | 'south' | 'east' | 'west'; to: string; outside?: RoomTile; entry: RoomTile }
export type RoomFacing = 'front' | 'left' | 'right' | 'diag';
/** A signature piece drawn on its map letter: `art` names a furnishings piece (design 2.8). */
export interface RoomProp { art: string; char: string; solid: boolean; facing?: RoomFacing }
/**
 * A furnishing placed in a room by catalogue id (2.8): on the floor (or a
 * rug) by its footprint's top-left tile, on the back wall, or on an earlier
 * piece's surface (`parent`, its `offer` and `slot`). Never blocks: the
 * room's dressing.
 */
export interface RoomFurnishing { piece: string; tx?: number; ty?: number; facing?: RoomFacing; parent?: number; offer?: 'top' | 'shelves'; slot?: number }
export interface RoomSpot extends RoomTile { label: string }
export interface RoomLight extends RoomTile { kind: 'hearth' | 'lamp' | 'window'; r: number }
export interface RoomOutside { building: string; window?: RoomTile; chimney?: { x: number; y: number } }
export interface Room { id: string; name: string; parent: string; map: string[]; doors: RoomDoor[]; props: RoomProp[]; spots: Record<string, RoomSpot>; lights: RoomLight[]; outside?: RoomOutside; furnishings?: RoomFurnishing[] }
export interface Rooms { legend: Record<string, string>; rooms: Room[] }
export interface RoomFootprint extends RoomTile { char: string; tw: number; th: number }
const ROOM_ID = /^in:(village|woodland|ruin|commons):([a-z0-9]+(?:-[a-z0-9]+)*)(?::([2-9]|[1-9][0-9]+))?$/;
const HOME_ROOM_ID = /^in:home:(0|[1-9][0-9]{0,3})$/;
const LEGEND: Record<string, string> = { '#': 'wall', '=': 'back-wall', w: 'window', '.': 'planks', ':': 'flagstone', D: 'doorway', '^': 'stairs-up', v: 'stairs-down', '@': 'arrive' };
const id = (s: unknown): s is string => typeof s === 'string' && s.length <= 100 && /^[a-z0-9-]+$/.test(s);
const int = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const tile = (v: unknown): v is RoomTile => obj(v) && keys(v, ['tx','ty']) && int(v.tx) && int(v.ty);
/** Also parses removed rooms so a saved place can recover to its parent. */
export function roomParent(area: string): string {
  if (HOME_ROOM_ID.test(area)) return area.slice(3);
  const m = ROOM_ID.exec(area);
  return m ? m[3] ? `in:${m[1]}:${m[2]}` : m[1]! : area;
}
export function rootArea(area: string): string { return HOME_ROOM_ID.test(area) ? area.slice(3) : ROOM_ID.exec(area)?.[1] ?? area; }
export function roomFor(area: string): Room | null { return ROOMS.rooms.find(r => r.id === area) ?? null; }
export function knownRoom(area: string): boolean { return HOME_ROOM_ID.test(area) || roomFor(area) !== null; }
export function knownContentArea(area: string): boolean { return ['village', 'woodland', 'ruin', 'commons'].includes(area) || knownRoom(area); }
export function roomContainsTile(room: Room, tx: number, ty: number): boolean { return int(tx) && int(ty) && ty < room.map.length && tx < room.map[ty]!.length; }
export function roomWalkable(room: Room, tx: number, ty: number): boolean {
  if (!roomContainsTile(room, tx, ty)) return false;
  const char = room.map[ty]![tx]!;
  return !'#=w'.includes(char) && !(room.props.find(p => p.char === char)?.solid ?? false);
}
/** Each four-connected group in map order, including separate sack piles. */
export function roomFootprints(room: Room, char: string): RoomFootprint[] {
  const seen = new Set<string>(); const out: RoomFootprint[] = [];
  for (let ty = 0; ty < room.map.length; ty++) for (let tx = 0; tx < room.map[ty]!.length; tx++) {
    if (room.map[ty]![tx] !== char || seen.has(`${tx},${ty}`)) continue;
    const group = [{ tx, ty }]; seen.add(`${tx},${ty}`);
    let minX = tx, maxX = tx, minY = ty, maxY = ty;
    for (let i = 0; i < group.length; i++) {
      const p = group[i]!; minX = Math.min(minX, p.tx); maxX = Math.max(maxX, p.tx); minY = Math.min(minY, p.ty); maxY = Math.max(maxY, p.ty);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const x = p.tx + dx!, y = p.ty + dy!, key = `${x},${y}`;
        if (roomContainsTile(room, x, y) && room.map[y]![x] === char && !seen.has(key)) { seen.add(key); group.push({ tx: x, ty: y }); }
      }
    }
    const tw = maxX - minX + 1, th = maxY - minY + 1;
    out.push({ char, tx: minX, ty: minY, tw: tw * th === group.length ? tw : 0, th });
  }
  return out;
}
export function validateRooms(value: unknown): Rooms {
  const bad = (s: string): never => { throw new Error(`invalid rooms: ${s}`); };
  if (!obj(value) || !obj(value.legend) || Object.keys(value.legend).length !== Object.keys(LEGEND).length || !Object.entries(LEGEND).every(([c, v]) => value.legend && (value.legend as Record<string, unknown>)[c] === v) || !Array.isArray(value.rooms) || !value.rooms.length) return bad('empty rooms/legend');
  const doc = value as unknown as Rooms, seen = new Map<string, Room>(), spots = new Set(Object.keys(story.spots));
  for (const r of doc.rooms) {
    const match = typeof r?.id === 'string' ? ROOM_ID.exec(r.id) : null;
    if (!obj(r) || !keys(r, ['id','name','parent','map','doors','props','spots','lights','outside','furnishings']) || !match || seen.has(r.id) || r.parent !== match[1] || typeof r.name !== 'string' || !r.name || !Array.isArray(r.map) || r.map.length < 3 || r.map.length > 128 || typeof r.map[0] !== 'string' || r.map[0].length < 3 || r.map[0].length > 128 || !Array.isArray(r.doors) || !r.doors.length || !Array.isArray(r.props) || !obj(r.spots) || !Array.isArray(r.lights)) return bad(`room ${r?.id}`);
    seen.set(r.id, r); const props = new Set<string>();
    for (const p of r.props) {
      if (!obj(p) || !keys(p, ['art','char','solid','facing']) || typeof p.char !== 'string' || !/^[A-Za-z]$/.test(p.char) || props.has(p.char) || LEGEND[p.char] || !id(p.art) || typeof p.solid !== 'boolean') return bad(`prop ${r.id}`);
      // Every prop is a catalogue piece, in a facing it has.
      const piece = furnishingFor(p.art);
      if (!piece || p.facing !== undefined && !Object.hasOwn(piece.facings, p.facing)) return bad(`prop piece ${r.id} ${p.art}`);
      props.add(p.char);
    }
    let arrive = 0;
    for (let y = 0; y < r.map.length; y++) {
      const row = r.map[y]!; if (typeof row !== 'string' || row.length !== r.map[0]!.length) return bad(`ragged map ${r.id}`);
      for (let x = 0; x < row.length; x++) {
        const c = row[x]!; if (c === '@') arrive++;
        if (!LEGEND[c] && !props.has(c)) return bad(`unclaimed character ${r.id}`);
        if ((x === 0 || y === 0 || x === row.length - 1 || y === r.map.length - 1) && c !== '#' && c !== 'D' && !r.props.some(p => p.char === c && p.solid)) return bad(`open boundary ${r.id}`);
      }
    }
    for (const c of props) {
      const groups = roomFootprints(r, c), piece = furnishingFor(r.props.find(p => p.char === c)!.art)!;
      if (!groups.length || groups.some(f => !f.tw || f.tw !== piece.footprint[0] || f.th !== piece.footprint[1])) return bad(`prop footprint ${r.id}`);
    }
    const doors = new Set<string>(), chars = new Set<string>(); let front = false;
    for (const d of r.doors) {
      if (!obj(d) || !keys(d, ['id','kind','at','side','to','outside','entry']) || !id(d.id) || doors.has(d.id) || chars.has(d.at) || !['north','south','east','west'].includes(d.side) || !['door','stair'].includes(d.kind) || !tile(d.entry) || (d.kind === 'door' && (d.at !== 'D' || d.to !== r.parent || !tile(d.outside))) || (d.kind === 'stair' && (!['^','v'].includes(d.at) || d.outside !== undefined))) return bad(`door ${r.id}`);
      const groups = roomFootprints(r, d.at); if (groups.length !== 1 || !groups[0]!.tw) return bad(`door footprint ${r.id}`);
      if (d.kind === 'door') {
        front = true; const f = groups[0]!;
        if (d.side === 'north' && f.ty !== 0 || d.side === 'south' && f.ty + f.th !== r.map.length || d.side === 'west' && f.tx !== 0 || d.side === 'east' && f.tx + f.tw !== r.map[0]!.length) return bad(`door side ${r.id}`);
      }
      doors.add(d.id); chars.add(d.at);
    }
    for (const c of ['D','^','v']) if (roomFootprints(r, c).length && !chars.has(c)) return bad(`unclaimed exit ${r.id}`);
    if (arrive !== (front ? 1 : 0)) return bad(`arrival ${r.id}`);
    for (const [name, s] of Object.entries(r.spots)) {
      if (!id(name) || spots.has(name) || !obj(s) || !keys(s, ['tx','ty','label']) || !int(s.tx) || !int(s.ty) || typeof s.label !== 'string' || !s.label || !roomContainsTile(r, s.tx, s.ty) || ![[0,0],[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => roomWalkable(r, s.tx + dx!, s.ty + dy!))) return bad(`spot ${name}`);
      spots.add(name);
    }
    for (const l of r.lights) if (!obj(l) || !keys(l, ['tx','ty','kind','r']) || !int(l.tx) || !int(l.ty) || !roomContainsTile(r, l.tx, l.ty) || !['hearth','lamp','window'].includes(l.kind) || !int(l.r) || l.r < 1 || l.r > 128) return bad(`light ${r.id}`);
    const o = r.outside;
    if (o !== undefined && (!obj(o) || !id(o.building) || o.window !== undefined && !tile(o.window) || o.chimney !== undefined && (!obj(o.chimney) || !int(o.chimney.x) || !int(o.chimney.y)))) return bad(`outside ${r.id}`);
    if (r.furnishings !== undefined && !validRoomFurnishings(r)) return bad(`furnishings ${r.id}`);
  }
  for (const r of doc.rooms) {
    if (roomParent(r.id) !== r.parent && !seen.has(roomParent(r.id))) return bad(`missing floor 1 ${r.id}`);
    for (const d of r.doors) if (d.kind === 'stair') {
      const target = seen.get(d.to);
      if (!target || target.parent !== r.parent || !roomWalkable(target, d.entry.tx, d.entry.ty) || !target.doors.some(back => back.kind === 'stair' && back.to === r.id)) return bad(`stair target ${r.id}`);
    }
  }
  return doc;
}
/** The floor a free-standing furnishing may stand on: planks, flagstones, the arrival tile. */
const FLOOR = '.:@';
/** The back wall, where wall pieces hang. */
const BACK_WALL = '=w';

/**
 * A room's furnishings (2.8): every piece known, in a facing it has, placed
 * where `canPlace` lets it go: on another piece listed before it (its offer
 * and slot), on the back wall, or on open floor (a rug under it counts as
 * the floor, design 2.8), inside the room and off the props.
 */
function validRoomFurnishings(r: Room): boolean {
  const list = r.furnishings;
  if (!Array.isArray(list)) return false;
  const placed: { piece: Furnishing; tiles: Set<string> }[] = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i] as unknown;
    if (!obj(f) || !keys(f, ['piece','tx','ty','facing','parent','offer','slot'])) return false;
    const piece = typeof f.piece === 'string' ? furnishingFor(f.piece) : null;
    if (!piece || f.facing !== undefined && (typeof f.facing !== 'string' || !Object.hasOwn(piece.facings, f.facing))) return false;
    if (f.parent !== undefined) {
      if (!int(f.parent) || f.parent >= i || f.tx !== undefined || f.ty !== undefined) return false;
      const offer = f.offer ?? 'top', slot = f.slot ?? 0;
      if (offer !== 'top' && offer !== 'shelves' || !int(slot)) return false;
      if (!canPlace(piece, { kind: 'surface', host: placed[f.parent]!.piece, offer }, slot)) return false;
      placed.push({ piece, tiles: new Set() });
      continue;
    }
    if (f.offer !== undefined || f.slot !== undefined || !int(f.tx) || !int(f.ty)) return false;
    const tiles = new Set<string>(), [tw, th] = piece.footprint;
    for (let y = f.ty; y < f.ty + th; y++) for (let x = f.tx; x < f.tx + tw; x++) {
      if (!roomContainsTile(r, x, y)) return false;
      const c = r.map[y]![x]!;
      if (piece.mount === 'wall' ? !BACK_WALL.includes(c) : !FLOOR.includes(c)) return false;
      tiles.add(`${x},${y}`);
    }
    const onRug = piece.mount !== 'wall' && placed.some(p => p.piece.layer === 'under' && [...tiles].every(t => p.tiles.has(t)));
    const onto: PlaceOn = { kind: piece.mount === 'wall' ? 'wall' : onRug ? 'rug' : 'floor' };
    if (!canPlace(piece, onto)) return false;
    // A rug never lies on another rug.
    if (piece.layer === 'under' && placed.some(p => p.piece.layer === 'under' && [...tiles].some(t => p.tiles.has(t)))) return false;
    placed.push({ piece, tiles });
  }
  return true;
}

export const ROOMS = validateRooms(raw);
