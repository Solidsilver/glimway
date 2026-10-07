import repairsRaw from '../../content/repairs.json' with { type: 'json' };

interface RepairPos {
  tx: number;
  ty: number;
}

interface RepairGift {
  kind: string;
  id: string;
  qty: number;
}

interface RepairOpenFrom {
  wick: string;
  day: number;
}

export interface RepairDef {
  id: string;
  name: string;
  part: string;
  area: 'village' | 'commons';
  target: string;
  pos: RepairPos;
  resident: string;
  reaction: string;
  gift?: RepairGift;
  hint: string;
  description: string;
  mendedDescription: string;
  worldFlag: string;
  /** Festival chores only break from this day of this wick (the hame before Carting Day). */
  openFrom?: RepairOpenFrom;
  /** Weather can break it again (default true). The well's rope mends once and stays mended. */
  weather?: boolean;
}

interface RepairsRulesConfig {
  maxOpen: number;
  /** One new weather breakage every `perWick` wicks. */
  perWick: number;
  scripted: string[];
}

export interface RepairsData {
  rules: RepairsRulesConfig;
  repairs: RepairDef[];
}

function validateRepairs(data: RepairsData): RepairsData {
  if (!data.rules || data.rules.maxOpen <= 0 || data.rules.perWick <= 0 || !Array.isArray(data.rules.scripted) || data.rules.scripted.length === 0) {
    throw new Error('invalid repairs: rules');
  }
  if (!Array.isArray(data.repairs) || data.repairs.length === 0) {
    throw new Error('invalid repairs: empty');
  }
  const ids = new Set<string>();
  for (const r of data.repairs) {
    if (!r.id || ids.has(r.id)) throw new Error(`invalid repairs: id ${r.id}`);
    if (!r.name) throw new Error(`invalid repairs: name ${r.id}`);
    if (r.worldFlag !== `repair:${r.id}:mended`) throw new Error(`invalid repairs: worldFlag ${r.id}`);
    if (r.area !== 'village' && r.area !== 'commons') throw new Error(`invalid repairs: area ${r.id}`);
    if (r.pos.tx < 0 || r.pos.ty < 0) throw new Error(`invalid repairs: pos ${r.id}`);
    if (!r.reaction || r.reaction.length > 160) throw new Error(`invalid repairs: reaction ${r.id}`);
    if (!r.description || r.description.length > 160) throw new Error(`invalid repairs: description ${r.id}`);
    if (!r.mendedDescription || r.mendedDescription.length > 160) throw new Error(`invalid repairs: mendedDescription ${r.id}`);
    ids.add(r.id);
  }
  for (const s of data.rules.scripted) {
    if (!ids.has(s)) throw new Error(`invalid repairs: missing scripted id ${s}`);
  }
  return data;
}

export const REPAIR_RULES: RepairsData = validateRepairs(repairsRaw as unknown as RepairsData);

export function repairFor(id: string): RepairDef | undefined {
  return REPAIR_RULES.repairs.find((r) => r.id === id);
}

export function repairsForArea(area: string): RepairDef[] {
  return REPAIR_RULES.repairs.filter((r) => r.area === area);
}
