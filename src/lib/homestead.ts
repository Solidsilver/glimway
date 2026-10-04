import raw from '../../content/homestead.json' with { type: 'json' };
import { loadWilds } from './wilds/data.ts';

export interface HomeGrid { width: number; height: number }
export interface HomeTier { tier: number; id: string; name: string; purchasable: boolean; embers: number }
export interface HomeItem { id: string; name: string; category: 'furniture' | 'decor' | 'utility'; footprint: [number, number]; where: ('indoor' | 'outdoor')[]; minTier: number; embers: number; materials: Record<string, number> }
export interface HomesteadData { tiers: HomeTier[]; outdoor: HomeGrid; indoor: HomeGrid; commons: { tileSize: number; columns: number; gap: number; originX: number; originY: number }; items: HomeItem[] }
const integer = (n: unknown, min = 0): n is number => Number.isSafeInteger(n) && (n as number) >= min;
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function validateHomesteadData(value: unknown): HomesteadData {
  const bad = () => { throw new Error('invalid homestead'); };
  if (!object(value)) return bad();
  const h = value as unknown as HomesteadData;
  if (!Array.isArray(h.tiers) || h.tiers.length !== 5 || !object(h.outdoor) || !object(h.indoor) || h.outdoor.width !== 16 || h.outdoor.height !== 12 || h.indoor.width !== 12 || h.indoor.height !== 10 || !object(h.commons) || !integer(h.commons.tileSize, 1) || !integer(h.commons.columns, 1) || !integer(h.commons.gap) || !integer(h.commons.originX) || !integer(h.commons.originY) || !Array.isArray(h.items) || h.items.length === 0) return bad();
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
