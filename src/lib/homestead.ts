import raw from '../../content/homestead.json' with { type: 'json' };
import { loadWilds } from './wilds/data.ts';

export interface HomeGrid { width: number; height: number }
export interface HomeTier { tier: number; id: string; name: string; purchasable: boolean; embers: number }
export interface HomeItem { id: string; name: string; category: 'furniture' | 'decor' | 'utility'; footprint: [number, number]; where: ('indoor' | 'outdoor')[]; minTier: number; embers: number; materials: Record<string, number> }
/** A rectangle in a plot's or room's local grid tiles. */
export interface HomeRect { x: number; y: number; w: number; h: number }
/**
 * Where plots sit on the Commons map, in the client's tiles (`tileSize` px).
 * Plot i is in column i % columns.length and row floor(i / columns.length);
 * the listed rows are the designed ones and later rows continue down the lane
 * every `rowPitch` tiles. The server's plot bounds use the same rule.
 */
export interface CommonsLayout { tileSize: number; columns: number[]; rows: number[]; rowPitch: number }
export interface HomesteadData {
  tiers: HomeTier[];
  outdoor: HomeGrid;
  indoor: HomeGrid;
  commons: CommonsLayout;
  /** The camp/cottage tiles of every plot: decorations cannot cover them. */
  outdoorReserved: HomeRect[];
  /** The doorway inside: kept clear so nobody walls themselves in. */
  indoorReserved: HomeRect[];
  items: HomeItem[];
}
export type HomeScene = 'indoor' | 'outdoor';
const integer = (n: unknown, min = 0): n is number => Number.isSafeInteger(n) && (n as number) >= min;
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function validLayout(c: unknown, plot: HomeGrid): boolean {
  if (!object(c) || !integer(c.tileSize, 1) || !Array.isArray(c.columns) || !Array.isArray(c.rows) || c.columns.length === 0 || c.rows.length === 0 || !integer(c.rowPitch, plot.height)) return false;
  const spaced = (list: unknown[], size: number) => list.every((v, i) => integer(v) && (i === 0 || v >= (list[i - 1] as number) + size));
  return spaced(c.columns, plot.width) && spaced(c.rows, plot.height);
}
function validReserved(list: unknown, g: HomeGrid): boolean {
  return Array.isArray(list) && list.every((r) => object(r) && integer(r.x) && integer(r.y) && integer(r.w, 1) && integer(r.h, 1) && r.x + r.w <= g.width && r.y + r.h <= g.height);
}
export function validateHomesteadData(value: unknown): HomesteadData {
  const bad = () => { throw new Error('invalid homestead'); };
  if (!object(value)) return bad();
  const h = value as unknown as HomesteadData;
  if (!Array.isArray(h.tiers) || h.tiers.length !== 5 || !object(h.outdoor) || !object(h.indoor) || h.outdoor.width !== 16 || h.outdoor.height !== 12 || h.indoor.width !== 12 || h.indoor.height !== 10 || !validLayout(h.commons, h.outdoor) || !validReserved(h.outdoorReserved, h.outdoor) || !validReserved(h.indoorReserved, h.indoor) || !Array.isArray(h.items) || h.items.length === 0) return bad();
  h.tiers.forEach((t, i) => { if (!object(t) || t.tier !== i || t.id !== `tier-${i}` || typeof t.name !== 'string' || !t.name || t.purchasable !== (i === 1) || !integer(t.embers) || (i === 1 ? t.embers <= 0 : t.embers !== 0)) bad(); });
  const seen = new Set<string>();
  for (const v of h.items) {
    if (!object(v) || typeof v.id !== 'string' || !v.id || seen.has(v.id) || typeof v.name !== 'string' || !v.name || !['furniture', 'decor', 'utility'].includes(v.category) || !integer(v.minTier) || v.minTier > 4 || !Array.isArray(v.footprint) || v.footprint.length !== 2 || !integer(v.footprint[0], 1) || !integer(v.footprint[1], 1) || v.footprint[0] > 12 || v.footprint[1] > 10 || !Array.isArray(v.where) || v.where.length < 1 || v.where.length > 2 || new Set(v.where).size !== v.where.length || !v.where.every(p => ['indoor', 'outdoor'].includes(p)) || !integer(v.embers) || !object(v.materials) || Object.keys(v.materials).length > 2 || (v.embers > 0) === (Object.keys(v.materials).length > 0)) return bad();
    for (const [id, qty] of Object.entries(v.materials)) if (!loadWilds().materials.includes(id) || !integer(qty, 1)) return bad();
    seen.add(v.id);
  }
  return h;
}
export const HOMESTEAD_DATA = validateHomesteadData(raw);

// ------------------------------------------------------------ geometry

/** Plot i's top-left tile on the Commons map. */
export function plotTile(index: number, data: HomesteadData = HOMESTEAD_DATA): { tx: number; ty: number } {
  const c = data.commons;
  const col = index % c.columns.length;
  const row = Math.floor(index / c.columns.length);
  const last = c.rows.length - 1;
  return { tx: c.columns[col], ty: row <= last ? c.rows[row] : c.rows[last] + (row - last) * c.rowPitch };
}

/** Plot i's pixel rectangle: what the server returns as `bounds`. */
export function plotBounds(index: number, data: HomesteadData = HOMESTEAD_DATA): { x: number; y: number; width: number; height: number } {
  const { tx, ty } = plotTile(index, data);
  const t = data.commons.tileSize;
  return { x: tx * t, y: ty * t, width: data.outdoor.width * t, height: data.outdoor.height * t };
}

/** Plot rows the Commons map shows for this many plots (at least the designed rows). */
export function plotRows(count: number, data: HomesteadData = HOMESTEAD_DATA): number {
  return Math.max(data.commons.rows.length, Math.ceil(count / data.commons.columns.length));
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

/** One owned decoration instance (the server's `home.items` rows). */
export interface HomeInstance {
  id: string;
  itemDef: string;
  scene: HomeScene | null;
  x: number | null;
  y: number | null;
  rotation: Rotation | null;
}

export type PlacementProblem = 'invalid-placement' | 'tier-required' | 'out-of-bounds' | 'placement-overlap';

const overlaps = (a: HomeRect, b: HomeRect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * The server's placement rules (server/internal/api/homestead.go,
 * validatePlacement), run locally so the grid can show a spot as free or
 * blocked before anything is sent. The server still decides.
 */
export function checkPlacement(
  home: { tier: number; items: readonly HomeInstance[] },
  instance: HomeInstance,
  scene: HomeScene,
  x: number,
  y: number,
  rotation: number,
  data: HomesteadData = HOMESTEAD_DATA
): PlacementProblem | null {
  const def = data.items.find((i) => i.id === instance.itemDef);
  if (!def || ![0, 90, 180, 270].includes(rotation) || !def.where.includes(scene)) return 'invalid-placement';
  if (home.tier < 1 || home.tier < def.minTier) return 'tier-required';
  const grid = scene === 'indoor' ? data.indoor : data.outdoor;
  const [w, h] = rotatedFootprint(def, rotation);
  if (x < 0 || y < 0 || x > grid.width - w || y > grid.height - h) return 'out-of-bounds';
  const here = { x, y, w, h };
  const reserved = scene === 'indoor' ? data.indoorReserved : data.outdoorReserved;
  if (reserved.some((r) => overlaps(here, r))) return 'placement-overlap';
  for (const other of home.items) {
    if (other.id === instance.id || other.scene !== scene || other.x === null || other.y === null) continue;
    const od = data.items.find((i) => i.id === other.itemDef);
    if (!od) continue;
    const [ow, oh] = rotatedFootprint(od, other.rotation ?? 0);
    if (overlaps(here, { x: other.x, y: other.y, w: ow, h: oh })) return 'placement-overlap';
  }
  return null;
}
