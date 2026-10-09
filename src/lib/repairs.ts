import repairsRaw from '../../content/repairs.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { RepairsSchema, type RepairDefValid, type RepairsValid } from './gen/glimway/content/v1/repairs_pb.js';
import { CALENDAR } from './calendar.ts';
import { itemDef } from './items.ts';

/** The village repairs (proto/glimway/content/v1/repairs.proto), with the schema's required fields non-optional. */
export type RepairsData = RepairsValid;
export type RepairDef = RepairDefValid;

/**
 * Throws on anything content/repairs.go would refuse: the rules that span
 * entries or families, in Go's order with Go's tags — the schema's own
 * (protovalidate) rules ran in decodeContent before these, outside a
 * production build.
 */
export function validateRepairs(value: unknown): RepairsData {
  const data = decodeContent(RepairsSchema, value, 'repairs', ['repairs']) as RepairsData;
  const bad = (why: string): never => { throw new Error(`invalid repairs: ${why}`); };
  const ids = new Set<string>();
  for (const r of data.repairs) {
    if (ids.has(r.id)) return bad(`duplicate id ${r.id}`);
    ids.add(r.id);
    // The part mends it, the gift pays it: both are catalogue items of a
    // kind a player can hold.
    const part = itemDef(r.part);
    if (!part || !['part', 'material', 'consumable'].includes(part.kind)) return bad(`${r.id} part`);
    if (r.gift && !itemDef(r.gift.id)) return bad(`${r.id} gift`);
    // The opening wick is a calendar wick of a calendar length.
    if (r.openFrom && (!CALENDAR.wicks.includes(r.openFrom.wick) || r.openFrom.day > CALENDAR.wickDays)) return bad(`${r.id} openFrom`);
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
