import repairsRaw from '../../content/repairs.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { RepairsSchema, type RepairDefValid, type RepairsValid } from './gen/glimway/content/v1/repairs_pb.js';
import { CALENDAR } from './calendar.ts';
import { itemDef } from './items.ts';

/** The village repairs (proto/glimway/content/v1/repairs.proto), with the schema's required fields non-optional. */
export type RepairsData = RepairsValid;
export type RepairDef = RepairDefValid;

/** Throws on anything content/repairs.go would refuse. */
export function validateRepairs(value: unknown): RepairsData {
  const data = decodeContent(RepairsSchema, value, 'repairs', ['repairs']) as RepairsData;
  const bad = (why: string): never => { throw new Error(`invalid repairs: ${why}`); };
  if (data.rules.maxOpen <= 0 || data.rules.perWick <= 0 || data.rules.scripted.length === 0) return bad('rules');
  const ids = new Set<string>();
  for (const r of data.repairs) {
    // The part mends it, the gift pays it: both are catalogue items of a
    // kind a player can hold; the opening wick is a calendar one of a
    // calendar length.
    const part = itemDef(r.part);
    if (!part || !['part', 'material', 'consumable'].includes(part.kind)) return bad(`part ${r.id}`);
    if (r.gift && !itemDef(r.gift.id)) return bad(`gift ${r.id}`);
    if (r.openFrom && (!CALENDAR.wicks.includes(r.openFrom.wick) || r.openFrom.day > CALENDAR.wickDays)) return bad(`openFrom ${r.id}`);
    if (ids.has(r.id)) return bad(`duplicate id ${r.id}`);
    if (r.worldFlag !== `repair:${r.id}:mended`) return bad(`worldFlag ${r.id}`);
    if (r.area !== 'village' && r.area !== 'commons') return bad(`area ${r.id}`);
    if (!r.reaction || r.reaction.length > 160) return bad(`reaction ${r.id}`);
    if (!r.description || r.description.length > 160) return bad(`description ${r.id}`);
    if (!r.mendedDescription || r.mendedDescription.length > 160) return bad(`mendedDescription ${r.id}`);
    ids.add(r.id);
  }
  for (const s of data.rules.scripted) {
    if (!ids.has(s)) return bad(`scripted ${s}`);
  }
  return data;
}

export const REPAIR_RULES: RepairsData = validateRepairs(repairsRaw);

export function repairFor(id: string): RepairDef | undefined {
  return REPAIR_RULES.repairs.find((r) => r.id === id);
}

export function repairsForArea(area: string): RepairDef[] {
  return REPAIR_RULES.repairs.filter((r) => r.area === area);
}
