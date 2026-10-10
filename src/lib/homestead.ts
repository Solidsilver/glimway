import raw from '../../content/homestead.json' with { type: 'json' };
import itemsRaw from '../../content/items.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { HomesteadSchema } from './gen/glimway/content/v1/homestead_pb.js';
import { furnishingFor } from './furnishings.ts';
import { loadWilds } from './wilds/data.ts';
import { LAND, buildableKind, clearedSet, effectiveKind, homeLights, isLit, servedLand, type Land, type Light } from './homestead-land.ts';
import { tileAt, tileMid } from './tile.ts';

/** Material ids a purchase bill may name: the Wilds materials, plus any material in the items catalogue (seasoned timber). */
const MATERIAL_ITEMS = new Set(
  ((itemsRaw as { items: { id: string; kind: string }[] }).items ?? []).filter((i) => i.kind === 'material').map((i) => i.id)
);

export type HomeScene = 'indoor' | 'outdoor' | 'gate';
export type HomeItemCategory = 'furniture' | 'decor' | 'utility';
interface HomeTier { tier: number; id: string; name: string; purchasable: boolean; glims: number; materials?: Record<string, number> }
export interface HomeItem { id: string; name: string; category: HomeItemCategory; footprint: [number, number]; where: HomeScene[]; minTier: number; glims: number; materials: Record<string, number>; craftOnly?: boolean; building?: boolean }
/** A rectangle in the land's or a room's local grid tiles. */
export interface HomeRect { x: number; y: number; w: number; h: number }
export interface HomeGrid { width: number; height: number }
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
export interface LanternPosts { item: string; radius: number; nameMax: number; costs: { materials: Record<string, number> }[]; growth: Record<string, number> }
/** The stable's growth rules (design 3.2): one piece, a bay at a time. */
export interface HomesteadStable { item: string; maxStalls: number; stallCost: Record<string, number>; growth: Record<string, number> }
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
  deeds: { firstFree: boolean; glims: number };
  clearTileGlims: number;
  desolation: { desolateAfterDays: number; deedLostAfterDays: number };
  jointDeed: { confirmWindowSeconds: number; inviteHours: number };
  personalChest: { maxUnits: number };
  items: HomeItem[];
  stable: HomesteadStable;
}

/** Throws on anything content/homestead.go would refuse. */
export function validateHomesteadData(value: unknown): HomesteadData {
  const bad = (why = ''): never => { throw new Error(`invalid homestead${why ? ': ' + why : ''}`); };
  const h = decodeContent(HomesteadSchema, value, 'homestead', ['tiers', 'items']) as unknown as HomesteadData;
  // Each row only refers to the furnishings catalogue by id for its name
  // and footprint; the loader fills them in (a row that spells them out
  // must match the catalogue, never disagree with it).
  for (const v of h.items) {
    const f = furnishingFor(v.id);
    if (!f) return bad(`item ${v.id} not in the furnishings catalogue`);
    if (v.name !== '' && v.name !== f.name) return bad(`item ${v.id} names itself`);
    const fp: unknown = v.footprint;
    if (fp !== undefined && (fp as unknown[]).length !== 0 && ((fp as unknown[]).length !== 2 || v.footprint[0] !== f.footprint[0] || v.footprint[1] !== f.footprint[1])) return bad(`item ${v.id} footprint`);
    (v as { name: string }).name = f.name;
    (v as { footprint: [number, number] }).footprint = [f.footprint[0], f.footprint[1]];
  }
  // The tier ladder is the designed five; only Cottage and Workshop are
  // bought, and only the Workshop takes a materials bill.
  h.tiers.forEach((t, i) => {
    if (t.tier !== i || t.id !== `tier-${i}` || !t.name || t.purchasable !== (i === 1 || i === 2) || (i === 1 || i === 2 ? t.glims <= 0 : t.glims !== 0)) bad(`tier ${i}`);
  });
  for (const t of h.tiers) {
    const materials = t.materials ?? {};
    if (t.tier === 2 ? Object.keys(materials).length === 0 : Object.keys(materials).length !== 0) return bad(`tier ${t.tier} materials`);
    for (const [id, qty] of Object.entries(materials)) if (!loadWilds().materials.includes(id) || qty < 1 || qty > 1_000_000) return bad(`tier ${t.tier} material ${id}`);
  }
  // Reserved rectangles sit inside their grids.
  const reservedOK = (list: HomeRect[], w: number, ht: number) => list.every((r) => r.x + r.w <= w && r.y + r.h <= ht);
  if (!reservedOK(h.outdoorReserved, h.land.width, h.land.height) || !reservedOK(h.indoorReserved, h.indoor.width, h.indoor.height)) return bad('reserved');
  // Gate rows go down the lane two tiles apart.
  const rows = h.commons.gateRows;
  if (rows.some((y, i) => i > 0 && y < rows[i - 1] + 2)) return bad('gate rows');
  // The lantern posts' bills name Wilds materials; growth never takes one back.
  const billsOK = (m: Record<string, number>, allowEmpty: boolean) => (allowEmpty || Object.keys(m).length > 0) && Object.entries(m).every(([id, n]) => loadWilds().materials.includes(id) && (allowEmpty ? n >= 0 : n >= 1) && n <= 1_000_000);
  if (!h.lanternPosts.costs.every((c) => billsOK(c.materials, false)) || !billsOK(h.lanternPosts.growth, true)) return bad('post bills');
  const seen = new Set<string>();
  for (const v of h.items) {
    if (seen.has(v.id)) return bad(`duplicate id ${v.id}`);
    seen.add(v.id);
    for (const [id, qty] of Object.entries(v.materials)) if ((!loadWilds().materials.includes(id) && !MATERIAL_ITEMS.has(id)) || qty < 1) return bad(`item ${v.id} material ${id}`);
  }
  if (!seen.has(h.lanternPosts.item)) return bad('post item');
  // The stable grows from its own row: its piece is in the build list, its
  // first extra bay's bill names carried materials, and each bay after that
  // only adds to materials the bill already names.
  const stable = h.stable;
  if (!seen.has(stable.item)) return bad(`stable item ${stable.item}`);
  for (const [id, qty] of Object.entries(stable.stallCost)) if ((!loadWilds().materials.includes(id) && !MATERIAL_ITEMS.has(id)) || qty < 1) return bad(`stable stall cost ${id}`);
  for (const [id, qty] of Object.entries(stable.growth)) if (!(id in stable.stallCost) || qty < 0) return bad(`stable growth ${id}`);
  return h;
}
export const HOMESTEAD_DATA = validateHomesteadData(raw);

/**
 * Silas's Yard, in its sections: the buildings (structures on the plot, the
 * content's `building` flag), then the finished pieces (priced in glims) and
 * the pieces from the Wilds (materials only). Workbench-only pieces aren't sold.
 */
export function shopSections(data: HomesteadData = HOMESTEAD_DATA): { buildings: HomeItem[]; finished: HomeItem[]; wilds: HomeItem[] } {
  const sold = data.items.filter((i) => !i.craftOnly);
  const pieces = sold.filter((i) => !i.building);
  return { buildings: sold.filter((i) => i.building), finished: pieces.filter((i) => i.glims > 0), wilds: pieces.filter((i) => i.glims === 0) };
}

// ------------------------------------------------------------ geometry

/** The land as a placement grid. */
function landGrid(data: HomesteadData = HOMESTEAD_DATA): HomeGrid {
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

/** The materials the `extra`-th extra bay of a homestead's stable costs (1-based). */
export function stallCost(extra: number, data: HomesteadData = HOMESTEAD_DATA): Record<string, number> {
  const n = Math.max(1, extra);
  const out: Record<string, number> = {};
  for (const [m, v] of Object.entries(data.stable.stallCost)) out[m] = v + (data.stable.growth[m] ?? 0) * (n - 1);
  return out;
}

export type Rotation = 0 | 90 | 180 | 270;

/** Footprint in tiles after rotation (a quarter turn swaps width and depth). */
export function rotatedFootprint(item: HomeItem, rotation: number): [number, number] {
  const [w, h] = item.footprint;
  return rotation === 90 || rotation === 270 ? [h, w] : [w, h];
}

/** Square footprints look the same every way round, so rotating one does nothing. */
export function canRotate(item: HomeItem, data: HomesteadData = HOMESTEAD_DATA): boolean {
  // The stable faces front only (indoors.md 7.0's four facings; its bays grow east).
  return item.footprint[0] !== item.footprint[1] && item.id !== data.stable.item;
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
  /** The stable's stall count (crafts.md 3.2); absent on every other piece. */
  stalls?: number | null;
}

export type PlacementProblem = 'invalid-placement' | 'tier-required' | 'out-of-bounds' | 'placement-overlap' | 'plant-in-the-way' | 'land-blocked' | 'unlit' | 'post-holds-land' | 'name-required';

const overlaps = (a: HomeRect, b: HomeRect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** The ground a placement is checked against outdoors: the land and its cleared tiles. */
export interface PlacementGround {
  land: Land;
  cleared: ReadonlySet<string>;
}

function footprintRect(it: HomeInstance, data: HomesteadData): HomeRect | null {
  const def = data.items.find((i) => i.id === it.itemDef);
  if (!def || it.x === null || it.y === null) return null;
  const [w, h] = rotatedFootprint(grownItem(def, it, data), it.rotation ?? 0);
  return { x: it.x, y: it.y, w, h };
}

/**
 * The stable grows east with its stalls (crafts.md 3.2): 4 × 3 with stall 1,
 * plus 2 × 3 a stall. Every other piece is its catalogue footprint.
 */
export function stableFootprint(stalls: number, data: HomesteadData = HOMESTEAD_DATA): [number, number] {
  const base = data.items.find((i) => i.id === data.stable.item)?.footprint ?? [4, 3];
  const n = Math.max(1, Math.min(data.stable.maxStalls, Math.floor(stalls) || 1));
  return [base[0] + 2 * (n - 1), base[1]];
}

/** A catalogue row with the footprint this instance stands on (the stable's grows). */
export function grownItem(def: HomeItem, it: Pick<HomeInstance, 'itemDef' | 'stalls'>, data: HomesteadData = HOMESTEAD_DATA): HomeItem {
  return def.id === data.stable.item ? { ...def, footprint: stableFootprint(it.stalls ?? 1, data) } : def;
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
function everythingLit(items: readonly HomeInstance[], data: HomesteadData = HOMESTEAD_DATA): boolean {
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
  home: { tier: number; items: readonly HomeInstance[]; plants?: readonly { x: number; y: number }[] },
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
  if (def.id === data.stable.item && rotation !== 0) return 'invalid-placement';
  if (home.tier < def.minTier || (scene === 'indoor' && home.tier < 1)) return 'tier-required';
  if (scene === 'gate') {
    if (home.items.some((i) => i.id !== instance.id && i.scene === 'gate')) return 'placement-overlap';
    return null;
  }
  const grid = scene === 'indoor' ? data.indoor : landGrid(data);
  const [w, h] = rotatedFootprint(grownItem(def, instance, data), rotation);
  if (x < 0 || y < 0 || x > grid.width - w || y > grid.height - h) return 'out-of-bounds';
  const here = { x, y, w, h };
  const reserved = scene === 'indoor' ? data.indoorReserved : data.outdoorReserved;
  if (reserved.some((r) => overlaps(here, r))) return 'placement-overlap';
  for (const other of home.items) {
    if (other.id === instance.id || other.scene !== scene) continue;
    const r = footprintRect(other, data);
    if (r && overlaps(here, r)) return 'placement-overlap';
  }
  // Nothing goes down on top of something growing.
  if (scene === 'outdoor' && (home.plants ?? []).some((p) => overlaps(here, { x: p.x, y: p.y, w: 1, h: 1 }))) return 'plant-in-the-way';
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

/**
 * The ground a new stall would take (crafts.md 3.1): the 2 × 3 tiles east of
 * the stable's last bay must be inside the land, clear of pieces and plants,
 * buildable and lit. Only those tiles: the stable's own ground is not asked
 * again. Null when a bay fits, or the problem (`out-of-bounds`,
 * `placement-overlap`, `plant-in-the-way`, `land-blocked`, `unlit`).
 */
export function stallGroundProblem(
  home: { tier: number; items: readonly HomeInstance[]; plants?: readonly { x: number; y: number }[] },
  stable: HomeInstance,
  data: HomesteadData = HOMESTEAD_DATA,
  ground?: PlacementGround
): PlacementProblem | null {
  if (stable.x === null || stable.y === null) return 'invalid-placement';
  const [w, h] = stableFootprint(stable.stalls ?? 1, data);
  // A bay-sized stand-in piece, checked by the ordinary placement rules.
  const bay: HomeItem = { id: '__stable-bay', name: 'Stall', category: 'utility', footprint: [2, h], where: ['outdoor'], minTier: 0, glims: 0, materials: {} };
  const withBay = { ...data, items: [...data.items, bay] };
  return checkPlacement(home, { id: '__stable-bay', itemDef: bay.id, scene: null, x: null, y: null, rotation: null }, 'outdoor', stable.x + w, stable.y, 0, withBay, ground);
}

/** What planting needs to know of a home's land (its gate names the served land). */
export interface PlantLand {
  gate: number;
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
export function plantable(home: PlantLand, tx: number, ty: number, data: HomesteadData = HOMESTEAD_DATA, land: Land | null = servedLand(home.gate)): boolean {
  // Until the server's land has been read, nothing is plantable.
  if (!land) return false;
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
  const land = servedLand(home.gate);
  if (!land) return null;
  const cx = tileAt(at.x);
  const cy = tileAt(at.y);
  let best: { d: number; tile: [number, number] } | null = null;
  for (let ty = cy - 1; ty <= cy + 1; ty++) {
    for (let tx = cx - 1; tx <= cx + 1; tx++) {
      const d = Math.hypot(at.x - tileMid(tx), at.y - tileMid(ty));
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

/** A lantern post's name, tidied; all Unicode controls are rejected before normalization. */
export function cleanPostName(raw: string, data: HomesteadData = HOMESTEAD_DATA): string | null {
  if (/\p{Cc}/u.test(raw)) return null;
  // Match strings.Fields / unicode.IsSpace in Go; JavaScript's \s and trim
  // also remove U+FEFF, which Go preserves as part of the name.
  const name = raw.split(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u).filter(Boolean).join(' ');
  if (!name || [...name].length > data.lanternPosts.nameMax) return null;
  return name;
}
