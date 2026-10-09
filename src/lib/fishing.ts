/**
 * The fishery rules (content/fishing.json; docs/design/crafts.md 5.4).
 * Shared with the Go server (content/fishing.go): the fullness bands and
 * their waits, the hold and cast spacing, and each water's banks and
 * species. The stock itself is server state; the band from a stock is only
 * ever a preview here.
 */
import raw from '../../content/fishing.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { FishingSchema, type FishingValid, type FishBandValid, type FishWaterValid, type FishBankValid } from './gen/glimway/content/v1/fishing_pb.js';
import { CALENDAR } from './calendar.ts';
import { itemDef, isStackable } from './items.ts';

export type FishBand = FishBandValid;
export type FishWater = FishWaterValid;
export type FishBank = FishBankValid;
/** The fishery rules (proto/glimway/content/v1/fishing.proto), with the schema's required fields non-optional. */
export type FishingData = FishingValid;

/** Throws on anything content/fishing.go would refuse. */
export function validateFishing(value: unknown): FishingData {
  const data = decodeContent(FishingSchema, value, 'fishing', ['waters']) as FishingData;
  const bad = (why: string): never => { throw new Error(`invalid fishing: ${why}`); };
  const bands = new Set<string>();
  data.bands.forEach((b, i) => {
    if (bands.has(b.id)) return bad(`duplicate band ${b.id}`);
    bands.add(b.id);
    if (i > 0 && b.atLeastPercent >= data.bands[i - 1]!.atLeastPercent) return bad(`band order ${b.id}`);
  });
  // The last band floors at 0: a water with fish in it always has a band
  // (5.3, "very low: under 20 % but at least one fish").
  const floor = data.bands[data.bands.length - 1]!;
  if (floor.atLeastPercent !== 0) return bad(`band floor ${floor.id}`);
  const marks: readonly string[] = CALENDAR.marks;
  const waters = new Set<string>();
  for (const w of data.waters) {
    if (waters.has(w.id)) return bad(`duplicate water ${w.id}`);
    waters.add(w.id);
    const banks = new Set<string>();
    for (const bank of w.banks) {
      if (banks.has(bank.id)) return bad(`${w.id} duplicate bank ${bank.id}`);
      banks.add(bank.id);
      for (const mark of bank.closedIn) if (!marks.includes(mark)) return bad(`${w.id} bank ${bank.id} closed mark ${mark}`);
    }
    const species = new Set<string>();
    for (const s of w.species) {
      if (species.has(s.item)) return bad(`${w.id} duplicate species ${s.item}`);
      species.add(s.item);
      const d = itemDef(s.item);
      if (!d || !isStackable(d)) return bad(`${w.id} unknown species ${s.item}`);
    }
  }
  return data;
}

export const FISHING: FishingData = validateFishing(raw);

export function waterFor(id: string): FishWater | undefined {
  return FISHING.waters.find((w) => w.id === id);
}

export function bankFor(water: FishWater, id: string): FishBank | undefined {
  return water.banks.find((b) => b.id === id);
}

/** The waters of one area (the GET /api/fishing/waters?area= answer's rows). */
export function watersForArea(area: string): FishWater[] {
  return FISHING.waters.filter((w) => w.area === area);
}

/**
 * The band a fullness percentage falls in (design 5.3: the first whose
 * atLeastPercent it reaches). A water with no fish has no band — an empty
 * water refuses.
 */
export function bandAt(fullnessPercent: number): FishBand | undefined {
  return FISHING.bands.find((b) => fullnessPercent >= b.atLeastPercent);
}

/** The wait to a bite in a band, in seconds. */
export function waitSeconds(band: FishBand): number {
  return band.waitSeconds;
}
