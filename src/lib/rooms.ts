import raw from '../../content/rooms.json' with { type: 'json' };
import story from '../../content/story.json' with { type: 'json' };
import { canPlace, furnishingFor, type Furnishing, type PlaceOn } from './furnishings.ts';
import { decodeContent } from './content-proto.ts';
import {
  RoomsSchema,
  type RoomDoorValid,
  type RoomFurnishingValid,
  type RoomLightValid,
  type RoomOutsideValid,
  type RoomPropValid,
  type RoomSpotValid,
  type RoomTileValid,
  type RoomValid,
  type RoomsValid,
} from './gen/glimway/content/v1/rooms_pb.js';

/** The generated messages (proto/glimway/content/v1/rooms.proto), with the schema's required fields non-optional. */
export type Rooms = RoomsValid;
export type Room = RoomValid;
export type RoomDoor = RoomDoorValid;
export type RoomFacing = 'front' | 'left' | 'right' | 'diag';
export type RoomProp = RoomPropValid;
export type RoomFurnishing = RoomFurnishingValid;
export type RoomSpot = RoomSpotValid;
export type RoomLight = RoomLightValid;
export type RoomOutside = RoomOutsideValid;
export type RoomTile = RoomTileValid;
export interface RoomFootprint { char: string; tx: number; ty: number; tw: number; th: number }

const ROOM_ID = /^in:(village|woodland|ruin|commons):([a-z0-9]+(?:-[a-z0-9]+)*)(?::([2-9]|[1-9][0-9]+))?$/;
const HOME_ROOM_ID = /^in:home:(0|[1-9][0-9]{0,3})$/;
/** The room vocabulary, checked on the schema; walking the map uses it. */
const LEGEND: Record<string, string> = { '#': 'wall', '=': 'back-wall', w: 'window', '.': 'planks', ':': 'flagstone', D: 'doorway', '^': 'stairs-up', v: 'stairs-down', '@': 'arrive' };
const int = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

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

/** The rules that read the map or reach across rooms: prop and door geometry, claimed characters, where a room's spots and pieces stand, stairs, and every reference between rooms. Field rules live on the schema. */
function roomRules(doc: Rooms): void {
  const bad = (s: string): never => { throw new Error(`invalid rooms: ${s}`); };
  const seen = new Map<string, Room>(), spots = new Set(Object.keys(story.spots));
  for (const r of doc.rooms) {
    if (seen.has(r.id)) bad(`room ${r.id}`);
    seen.set(r.id, r);
    const props = new Set<string>(), solidProps = new Set<string>();
    for (const p of r.props) {
      // Every prop is a catalogue piece, in a facing it has.
      const piece = furnishingFor(p.art);
      if (!piece || p.facing !== undefined && !Object.hasOwn(piece.facings, p.facing)) bad(`prop piece ${r.id} ${p.art}`);
      props.add(p.char);
      if (p.solid) solidProps.add(p.char);
    }
    let arrive = 0;
    for (let y = 0; y < r.map.length; y++) {
      const row = r.map[y]!;
      for (let x = 0; x < row.length; x++) {
        const c = row[x]!; if (c === '@') arrive++;
        if (!LEGEND[c] && !props.has(c)) bad(`unclaimed character ${r.id}`);
        if ((x === 0 || y === 0 || x === row.length - 1 || y === r.map.length - 1) && c !== '#' && c !== 'D' && !solidProps.has(c)) bad(`open boundary ${r.id}`);
      }
    }
    for (const p of r.props) {
      const groups = roomFootprints(r, p.char), piece = furnishingFor(p.art)!;
      if (!groups.length || groups.some(f => !f.tw || f.tw !== piece.footprint[0] || f.th !== piece.footprint[1])) bad(`prop footprint ${r.id}`);
    }
    const chars = new Set<string>(); let front = false;
    for (const d of r.doors) {
      const groups = roomFootprints(r, d.at); if (groups.length !== 1 || !groups[0]!.tw) bad(`door footprint ${r.id}`);
      if (d.kind === 'door') {
        front = true; const f = groups[0]!;
        if (d.side === 'north' && f.ty !== 0 || d.side === 'south' && f.ty + f.th !== r.map.length || d.side === 'west' && f.tx !== 0 || d.side === 'east' && f.tx + f.tw !== r.map[0]!.length) bad(`door side ${r.id}`);
      }
      chars.add(d.at);
    }
    for (const c of ['D','^','v']) if (roomFootprints(r, c).length && !chars.has(c)) bad(`unclaimed exit ${r.id}`);
    if (arrive !== (front ? 1 : 0)) bad(`arrival ${r.id}`);
    for (const [name, s] of Object.entries(r.spots)) {
      if (spots.has(name) || !roomContainsTile(r, s.tx, s.ty)) bad(`spot ${name}`);
      if (![[0,0],[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => roomWalkable(r, s.tx + dx!, s.ty + dy!))) bad(`blocked spot ${name}`);
      spots.add(name);
    }
    for (const l of r.lights) if (!roomContainsTile(r, l.tx, l.ty)) bad(`light ${r.id}`);
    if (!validRoomFurnishings(r)) bad(`furnishings ${r.id}`);
  }
  for (const r of doc.rooms) {
    // A floor shares its outdoor parent's building: floor 1 must exist.
    if (roomParent(r.id) !== r.parent && !seen.has(roomParent(r.id))) bad(`missing floor 1 ${r.id}`);
    for (const d of r.doors) if (d.kind === 'stair') {
      const target = seen.get(d.to);
      if (!target || target.parent !== r.parent || !roomWalkable(target, d.entry.tx, d.entry.ty) || !target.doors.some(back => back.kind === 'stair' && back.to === r.id)) bad(`stair target ${r.id}`);
    }
  }
}

export function validateRooms(value: unknown): Rooms {
  const doc = decodeContent(RoomsSchema, value, 'rooms', 'rooms') as Rooms;
  roomRules(doc);
  return doc;
}

/** The floor a free-standing furnishing may stand on: planks, flagstones, the arrival tile. */
const FLOOR = '.:@';
/** The back wall, where wall pieces hang (also in front of a piece standing against it, on its row: a shelf's sign). */
const BACK_WALL = '=w';

/**
 * A room's furnishings (2.8): every piece known, in a facing it has, placed
 * where `canPlace` lets it go: on another piece listed before it (its offer
 * and slot), on the back wall, or on open floor (a rug under it counts as
 * the floor, design 2.8), inside the room and off the props.
 */
function validRoomFurnishings(r: Room): boolean {
  const placed: { piece: Furnishing; tiles: Set<string> }[] = [];
  for (let i = 0; i < r.furnishings.length; i++) {
    const f = r.furnishings[i]!;
    const piece = furnishingFor(f.piece);
    if (!piece || f.facing !== undefined && !Object.hasOwn(piece.facings, f.facing)) return false;
    if (f.parent !== undefined) {
      if (f.parent < 0 || f.parent >= i || f.tx !== undefined || f.ty !== undefined) return false;
      const offer = f.offer ?? 'top', slot = f.slot ?? 0;
      if (offer !== 'top' && offer !== 'shelves' || slot < 0) return false;
      const host = placed[f.parent]?.piece;
      if (!host || !canPlace(piece, { kind: 'surface', host, offer }, slot)) return false;
      placed.push({ piece, tiles: new Set() });
      continue;
    }
    if (f.offer !== undefined || f.slot !== undefined || f.tx === undefined || f.ty === undefined || f.tx < 0 || f.ty < 0) return false;
    const tiles = new Set<string>(), [tw, th] = piece.footprint;
    for (let y = f.ty; y < f.ty + th; y++) for (let x = f.tx; x < f.tx + tw; x++) {
      if (!roomContainsTile(r, x, y)) return false;
      const c = r.map[y]![x]!;
      const onBackWall = BACK_WALL.includes(c) || y === 1 && r.props.some(p => p.char === c);
      if (piece.mount === 'wall' ? !onBackWall : !FLOOR.includes(c)) return false;
      tiles.add(`${x},${y}`);
    }
    let onRug = false, rugUnder = false;
    for (const p of placed) {
      if (p.piece.layer !== 'under') continue;
      let all = true;
      for (const t of tiles) { all = all && p.tiles.has(t); rugUnder = rugUnder || p.tiles.has(t); }
      onRug = onRug || all;
    }
    const onto: PlaceOn = { kind: piece.mount === 'wall' ? 'wall' : onRug ? 'rug' : 'floor' };
    // A rug never lies on another rug.
    if (!canPlace(piece, onto) || piece.layer === 'under' && rugUnder) return false;
    placed.push({ piece, tiles });
  }
  return true;
}

export const ROOMS = validateRooms(raw);
