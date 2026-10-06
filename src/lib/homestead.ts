import raw from '../../content/homestead.json' with { type: 'json' };
import itemsRaw from '../../content/items.json' with { type: 'json' };
import { loadWilds } from './wilds/data.ts';
import { LAND, buildableKind, clearedSet, effectiveKind, generateLand, homeLights, isLit, type Land, type Light } from './homestead-land.ts';

/** Material ids a purchase bill may name: the Wilds materials, plus any material in the catalogue (seasoned timber). */
const MATERIAL_ITEMS = new Set(
  ((itemsRaw as { items: { id: string; kind: string }[] }).items ?? []).filter((i) => i.kind === 'material').map((i) => i.id)
);

export interface HomeGrid { width: number; height: number }
export interface HomeTier { tier: number; id: string; name: string; purchasable: boolean; embers: number; materials?: Record<string, number> }
export interface HomeItem { id: string; name: string; category: 'furniture' | 'decor' | 'utility'; footprint: [number, number]; where: ('indoor' | 'outdoor')[]; minTier: number; embers: number; materials: Record<string, number>; craftOnly?: boolean }
/** A rectangle in the land's or a room's local grid tiles. */
export interface HomeRect { x: number; y: number; w: number; h: number }
/**
 * Every homestead's wild land (generated per gate: src/lib/homestead-land.ts,
 * server/internal/land): its size, the home site (camp/cottage), the gate
 * mouth in the south edge, the home's own light, and how wild it is.
 */
export interface HomeLand {
  generator: number;
  width: number;
  height: number;
  site: HomeRect;
  gate: { x: number; w: number };
  startLight: { x: number; y: number; radius: number };
  trees: number;
  stumps: number;
  boulders: number;
  streamPermille: number;
  slopePermille: number;
}
/**
 * The gates along the Commons lane, in the client's tiles (`tileSize` px).
 * Gate g is in fence column fenceX[g % 2] and row floor(g / 2): the listed
 * rows, then one more every `rowPitch` tiles. Silas's table (px) is where
 * a joint deed is signed: both partners within `radius`.
 */
export interface CommonsLane {
  tileSize: number;
  fenceX: [number, number];
  gateRows: number[];
  rowPitch: number;
  spareGates: number;
  silasTable: { x: number; y: number; radius: number };
}
export interface LanternPosts { item: string; radius: number; nameMax: number; costs: Record<string, number>[]; growth: Record<string, number> }
export interface HomesteadData {
  tiers: HomeTier[];
  indoor: HomeGrid;
  land: HomeLand;
  commons: CommonsLane;
  /** The home site and the gate path: decorations cannot cover them. */
  outdoorReserved: HomeRect[];
  /** The doorway inside: kept clear so nobody walls themselves in. */
  indoorReserved: HomeRect[];
  lanternPosts: LanternPosts;
  deeds: { firstFree: boolean; embers: number };
  clearTileEmbers: number;
  desolation: { desolateAfterDays: number; deedLostAfterDays: number };
  jointDeed: { confirmWindowSeconds: number; inviteHours: number };
  personalChest: { maxUnits: number };
  items: HomeItem[];
}
export type HomeScene = 'indoor' | 'outdoor';
const integer = (n: unknown, min = 0): n is number => Number.isSafeInteger(n) && (n as number) >= min;
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function validReserved(list: unknown, g: HomeGrid): boolean {
  return Array.isArray(list) && list.every((r) => object(r) && integer(r.x) && integer(r.y) && integer(r.w, 1) && integer(r.h, 1) && r.x + r.w <= g.width && r.y + r.h <= g.height);
}
function validLand(l: unknown): l is HomeLand {
  if (!object(l) || l.generator !== 1 || !integer(l.width, 20) || l.width > 120 || !integer(l.height, 16) || l.height > 120) return false;
  const g = { width: l.width, height: l.height };
  const gate = l.gate as Record<string, unknown>;
  const light = l.startLight as Record<string, unknown>;
  return validReserved([l.site], g) && object(gate) && integer(gate.x, 1) && integer(gate.w, 1) && gate.x + gate.w < l.width &&
    object(light) && integer(light.x, 1) && integer(light.y, 1) && integer(light.radius, 1) && light.x < l.width && light.y < l.height &&
    integer(l.trees) && integer(l.stumps) && integer(l.boulders) && integer(l.streamPermille) && l.streamPermille <= 1000 && integer(l.slopePermille) && l.slopePermille <= 1000;
}
function validLane(c: unknown): c is CommonsLane {
  if (!object(c) || !integer(c.tileSize, 1) || !Array.isArray(c.fenceX) || c.fenceX.length !== 2 || !Array.isArray(c.gateRows) || c.gateRows.length === 0 || !integer(c.rowPitch, 2) || !integer(c.spareGates, 1)) return false;
  const t = c.silasTable as Record<string, unknown>;
  if (!object(t) || !integer(t.x) || !integer(t.y) || !integer(t.radius, 1)) return false;
  const rows = c.gateRows as unknown[];
  return integer(c.fenceX[0]) && integer(c.fenceX[1]) && c.fenceX[1] > c.fenceX[0] && rows.every((y, i) => integer(y) && (i === 0 || y >= (rows[i - 1] as number) + 2));
}
function validCosts(m: unknown, allowEmpty = false): boolean {
  return object(m) && (allowEmpty || Object.keys(m).length > 0) && Object.entries(m).every(([id, n]) => loadWilds().materials.includes(id) && integer(n, allowEmpty ? 0 : 1));
}
function validPosts(p: unknown): p is LanternPosts {
  return object(p) && typeof p.item === 'string' && !!p.item && integer(p.radius, 1) && integer(p.nameMax, 1) && p.nameMax <= 80 && Array.isArray(p.costs) && p.costs.length > 0 && p.costs.every((c) => validCosts(c)) && validCosts(p.growth, true);
}
export function validateHomesteadData(value: unknown): HomesteadData {
  const bad = () => { throw new Error('invalid homestead'); };
  if (!object(value)) return bad();
  const h = value as unknown as HomesteadData;
  if (!Array.isArray(h.tiers) || h.tiers.length !== 5 || !object(h.indoor) || h.indoor.width !== 12 || h.indoor.height !== 10 || !validLand(h.land) || !validLane(h.commons) || !validReserved(h.outdoorReserved, { width: h.land.width, height: h.land.height }) || !validReserved(h.indoorReserved, h.indoor) || !validPosts(h.lanternPosts) || !Array.isArray(h.items) || h.items.length === 0) return bad();
  if (!object(h.deeds) || typeof h.deeds.firstFree !== 'boolean' || !integer(h.deeds.embers, 1) || !integer(h.clearTileEmbers, 1) || !object(h.desolation) || !integer(h.desolation.desolateAfterDays, 1) || !integer(h.desolation.deedLostAfterDays, h.desolation.desolateAfterDays + 1) || !object(h.jointDeed) || !integer(h.jointDeed.confirmWindowSeconds, 5) || !integer(h.jointDeed.inviteHours, 1) || !object(h.personalChest) || !integer(h.personalChest.maxUnits, 1)) return bad();
  h.tiers.forEach((t, i) => { if (!object(t) || t.tier !== i || t.id !== `tier-${i}` || typeof t.name !== 'string' || !t.name || t.purchasable !== (i === 1 || i === 2) || !integer(t.embers) || (i === 1 || i === 2 ? t.embers <= 0 : t.embers !== 0)) bad(); });
  for (const t of h.tiers) {
    if (t.tier === 2 ? !object(t.materials) || Object.keys(t.materials).length === 0 : t.materials !== undefined && Object.keys(t.materials).length !== 0) return bad();
    for (const [id, qty] of Object.entries(t.materials ?? {})) if (!loadWilds().materials.includes(id) || !integer(qty, 1) || qty > 1_000_000) return bad();
  }
  const seen = new Set<string>();
  for (const v of h.items) {
    if (!object(v) || typeof v.id !== 'string' || !v.id || seen.has(v.id) || typeof v.name !== 'string' || !v.name || !['furniture', 'decor', 'utility'].includes(v.category) || !integer(v.minTier) || v.minTier > 4 || !Array.isArray(v.footprint) || v.footprint.length !== 2 || !integer(v.footprint[0], 1) || !integer(v.footprint[1], 1) || !Array.isArray(v.where) || v.where.length < 1 || v.where.length > 2 || new Set(v.where).size !== v.where.length || !v.where.every(p => ['indoor', 'outdoor'].includes(p)) || !integer(v.embers) || !object(v.materials) || Object.keys(v.materials).length > 3 || (v.embers > 0) === (Object.keys(v.materials).length > 0)) return bad();
    if (v.craftOnly !== undefined && typeof v.craftOnly !== 'boolean') return bad();
    for (const [id, qty] of Object.entries(v.materials)) if ((!loadWilds().materials.includes(id) && !MATERIAL_ITEMS.has(id)) || !integer(qty, 1)) return bad();
    seen.add(v.id);
  }
  if (!seen.has(h.lanternPosts.item)) return bad();
  return h;
}
export const HOMESTEAD_DATA = validateHomesteadData(raw);

// ------------------------------------------------------------ geometry

/** The land as a placement grid. */
export function landGrid(data: HomesteadData = HOMESTEAD_DATA): HomeGrid {
  return { width: data.land.width, height: data.land.height };
}

/**
 * Gate g on the Commons lane: its fence tile (the top of a two-tile gap) and
 * the lane side it opens from (west fence: the land lies west). The server
 * reads the same rule from the same content.
 */
export function gateTile(gate: number, data: HomesteadData = HOMESTEAD_DATA): { tx: number; ty: number; side: 'west' | 'east' } {
  const c = data.commons;
  const side = gate % 2 === 0 ? 'west' : 'east';
  const row = Math.floor(gate / 2);
  const last = c.gateRows.length - 1;
  return { tx: c.fenceX[gate % 2], ty: row <= last ? c.gateRows[row] : c.gateRows[last] + (row - last) * c.rowPitch, side };
}

/** Gate rows the Commons map shows for this many gates (at least the designed rows). */
export function gateRowCount(gates: number, data: HomesteadData = HOMESTEAD_DATA): number {
  return Math.max(data.commons.gateRows.length, Math.ceil(gates / 2));
}

/** The area id of gate g's homestead map. */
export function homeArea(gate: number): string {
  return `home:${gate}`;
}

/** Gate number of a `home:<g>` area id (null for anything else). */
export function parseHomeArea(area: string): number | null {
  const m = /^home:(0|[1-9]\d{0,3})$/.exec(area);
  return m ? Number(m[1]) : null;
}

export function homeItem(id: string): HomeItem | undefined {
  return HOMESTEAD_DATA.items.find((i) => i.id === id);
}

export type Rotation = 0 | 90 | 180 | 270;

/** Footprint in tiles after rotation (a quarter turn swaps width and depth). */
export function rotatedFootprint(item: HomeItem, rotation: number): [number, number] {
  const [w, h] = item.footprint;
  return rotation === 90 || rotation === 270 ? [h, w] : [w, h];
}

/** Square footprints look the same every way round, so rotating one does nothing. */
export function canRotate(item: HomeItem): boolean {
  return item.footprint[0] !== item.footprint[1];
}

// ------------------------------------------------------------ placement

/**
 * A decoration instance: placed on a homestead (scene set), or in the
 * caller's pack (scene null). Lantern posts carry their given name.
 */
export interface HomeInstance {
  id: string;
  itemDef: string;
  scene: HomeScene | null;
  x: number | null;
  y: number | null;
  rotation: Rotation | null;
  name?: string | null;
}

export type PlacementProblem = 'invalid-placement' | 'tier-required' | 'out-of-bounds' | 'placement-overlap' | 'land-blocked' | 'unlit' | 'post-holds-land' | 'name-required';

const overlaps = (a: HomeRect, b: HomeRect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** The ground a placement is checked against outdoors: the land and its cleared tiles. */
export interface PlacementGround {
  land: Land;
  cleared: ReadonlySet<string>;
}

function footprintRect(it: HomeInstance, data: HomesteadData): HomeRect | null {
  const def = data.items.find((i) => i.id === it.itemDef);
  if (!def || it.x === null || it.y === null) return null;
  const [w, h] = rotatedFootprint(def, it.rotation ?? 0);
  return { x: it.x, y: it.y, w, h };
}

/** Lights holding the land: the home's own and every placed post but `except`. */
function lightsWithout(items: readonly HomeInstance[], except: string | null, data: HomesteadData): Light[] {
  return homeLights(items.filter((i) => i.itemDef === data.lanternPosts.item && i.scene === 'outdoor' && i.id !== except && i.x !== null && i.y !== null) as { x: number; y: number }[], data);
}

function rectLit(lights: readonly Light[], r: HomeRect): boolean {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (!isLit(lights, x, y)) return false;
  return true;
}

/**
 * After a change, is every outdoor piece still on lit ground? Each piece
 * (a post too) must be lit by the home's light or another post: a post
 * cannot hold up itself, so land never floats on a chain back to nothing.
 */
export function everythingLit(items: readonly HomeInstance[], data: HomesteadData = HOMESTEAD_DATA): boolean {
  for (const it of items) {
    if (it.scene !== 'outdoor') continue;
    const r = footprintRect(it, data);
    if (r && !rectLit(lightsWithout(items, it.id, data), r)) return false;
  }
  return true;
}

/**
 * The server's placement rules (server/internal/api/homestead.go,
 * validatePlacement), run locally so the grid can show a spot as free or
 * blocked before anything is sent. The server still decides. `ground` is
 * the land outdoors (omitted: only the grid rules are checked).
 */
export function checkPlacement(
  home: { tier: number; items: readonly HomeInstance[] },
  instance: HomeInstance,
  scene: HomeScene,
  x: number,
  y: number,
  rotation: number,
  data: HomesteadData = HOMESTEAD_DATA,
  ground?: PlacementGround
): PlacementProblem | null {
  const def = data.items.find((i) => i.id === instance.itemDef);
  if (!def || ![0, 90, 180, 270].includes(rotation) || !def.where.includes(scene)) return 'invalid-placement';
  if (home.tier < def.minTier || (scene === 'indoor' && home.tier < 1)) return 'tier-required';
  const grid = scene === 'indoor' ? data.indoor : landGrid(data);
  const [w, h] = rotatedFootprint(def, rotation);
  if (x < 0 || y < 0 || x > grid.width - w || y > grid.height - h) return 'out-of-bounds';
  const here = { x, y, w, h };
  const reserved = scene === 'indoor' ? data.indoorReserved : data.outdoorReserved;
  if (reserved.some((r) => overlaps(here, r))) return 'placement-overlap';
  for (const other of home.items) {
    if (other.id === instance.id || other.scene !== scene) continue;
    const r = footprintRect(other, data);
    if (r && overlaps(here, r)) return 'placement-overlap';
  }
  if (scene === 'outdoor' && ground) {
    for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) if (!buildableKind(effectiveKind(ground.land, ground.cleared, tx, ty))) return 'land-blocked';
  }
  if (scene === 'outdoor') {
    if (!rectLit(lightsWithout(home.items, instance.id, data), here)) return 'unlit';
    const moved = home.items.filter((i) => i.id !== instance.id).concat({ ...instance, scene, x, y, rotation: rotation as Rotation });
    if (def.id === data.lanternPosts.item && !everythingLit(moved, data)) return 'post-holds-land';
  }
  return null;
}

/** What planting needs to know of a home's land. */
export interface PlantLand {
  landSeed: number;
  cleared: readonly [number, number][];
  items: readonly HomeInstance[];
  plants?: readonly { x: number; y: number }[];
}

/**
 * Ground a seed or sapling can go into (the server's plantBlocked): open
 * grass, off the home site and the gate path, clear of placed pieces and
 * of other plants. Stumps kept in lamplight stand on tree tiles, so they
 * never count as grass.
 */
export function plantable(home: PlantLand, tx: number, ty: number, data: HomesteadData = HOMESTEAD_DATA, land: Land = generateLand(home.landSeed, data.land)): boolean {
  if (effectiveKind(land, clearedSet(home.cleared), tx, ty) !== LAND.GRASS) return false;
  const here = { x: tx, y: ty, w: 1, h: 1 };
  if (data.outdoorReserved.some((r) => overlaps(here, r))) return false;
  for (const it of home.items) {
    if (it.scene !== 'outdoor') continue;
    const r = footprintRect(it, data);
    if (r && overlaps(here, r)) return false;
  }
  return !(home.plants ?? []).some((p) => p.x === tx && p.y === ty);
}

/** The plantable tile nearest a spot on the land (px), within a step of it; null when there's none. */
export function plantTileNear(home: PlantLand, at: { x: number; y: number }, data: HomesteadData = HOMESTEAD_DATA): [number, number] | null {
  const land = generateLand(home.landSeed, data.land);
  const cx = Math.floor(at.x / 16);
  const cy = Math.floor(at.y / 16);
  let best: { d: number; tile: [number, number] } | null = null;
  for (let ty = cy - 1; ty <= cy + 1; ty++) {
    for (let tx = cx - 1; tx <= cx + 1; tx++) {
      const d = Math.hypot(at.x - (tx * 16 + 8), at.y - (ty * 16 + 8));
      if (d > 24 || !plantable(home, tx, ty, data, land)) continue;
      if (!best || d < best.d) best = { d, tile: [tx, ty] };
    }
  }
  return best?.tile ?? null;
}

/** Can this placed piece be put away without leaving anything in the dark? */
export function checkRemoval(home: { items: readonly HomeInstance[] }, instance: HomeInstance, data: HomesteadData = HOMESTEAD_DATA): PlacementProblem | null {
  if (instance.itemDef !== data.lanternPosts.item || instance.scene !== 'outdoor') return null;
  return everythingLit(home.items.filter((i) => i.id !== instance.id), data) ? null : 'post-holds-land';
}

/** A lantern post's name, tidied (null: not a usable name). */
export function cleanPostName(raw: string, data: HomesteadData = HOMESTEAD_DATA): string | null {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || [...name].length > data.lanternPosts.nameMax || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}
