/**
 * The inventory, as data: everything you carry, sorted into the panel's tabs
 * (docs/hands-on-design.md section 2). Pure: the panel feeds it the save's
 * pack, any server counts it has, and your home's decorations.
 *
 * Today's sources, unchanged:
 * - the pack (`GameState.inventory`): quest items, the Ember Charm, Wilds
 *   trinkets, crafted pieces, and a guest's materials as `material:<id>:<qty>`
 *   entries;
 * - server counts in a world (materials, items, decorations), when read;
 * - your home's decoration instances (placed or not).
 *
 * Tools have no items yet: that tab shows its empty state until the richer
 * item model (wear, effects) lands.
 */
import { ITEM_INFO } from '../content/world.ts';
import { DECORATIONS_EMBER, DECORATIONS_MATERIAL, MATERIALS, MORE_TRINKETS, TRINKETS } from '../content/expansion-writing.ts';
import { CRAFTED_BLURBS } from '../content/inventory.ts';
import { CRAFTING } from './workshop.ts';
import { QUEST_ITEMS } from './api/progress.ts';
import { CHARM_ITEM } from './embers.ts';

export type InventoryTab = 'tools' | 'supplies' | 'keepsakes' | 'home' | 'papers';
export type ItemTab = Exclude<InventoryTab, 'papers'>;
export type ItemKind = 'material' | 'crafted' | 'trinket' | 'charm' | 'quest' | 'decoration' | 'other';

export interface InventoryEntry {
  /** Stable per device: what the "new" dot remembers. */
  key: string;
  tab: ItemTab;
  /** `road`: quest items, in the small "For the road" section. */
  section: 'main' | 'road';
  kind: ItemKind;
  id: string;
  name: string;
  blurb: string;
  qty: number;
  /** A delivered art icon (`icon-timber`, …), when there is one. */
  art: string | null;
  /** The pixel Icon to draw when the art isn't there. */
  icon: string;
  /** Home goods: how many are set out and how many are put away. */
  placed?: number;
  stored?: number;
}

export interface InventorySource {
  /** GameState.inventory. */
  pack: readonly string[];
  /** Known material balances (a world's, or the Wilds' latest); else read from the pack. */
  materials?: Record<string, number> | null;
  /** Known item counts in a world (trinkets, crafted pieces). Ids in the pack count 1 without them. */
  items?: Record<string, number> | null;
  /** Your home's decorations: one per instance, `scene` null when not set out. */
  decorations?: ReadonlyArray<{ itemDef: string; scene: string | null }>;
}

/** Pack entries that carry a guest's material balance. */
export const MATERIAL_ITEM_PREFIX = 'material:';

/** A guest's materials from their pack (`material:<id>:<qty>`), every material listed. */
export function materialsFromPack(pack: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MATERIALS) out[m.id] = 0;
  for (const entry of pack) {
    if (!entry.startsWith(MATERIAL_ITEM_PREFIX)) continue;
    const rest = entry.slice(MATERIAL_ITEM_PREFIX.length);
    const at = rest.lastIndexOf(':');
    const id = rest.slice(0, at);
    const qty = Number(rest.slice(at + 1));
    if (id in out && Number.isInteger(qty) && qty > 0) out[id] = qty;
  }
  return out;
}

const MATERIAL_ICON: Record<string, string> = { timber: 'menu', stone: 'stone', fiber: 'roll', amber: 'ember' };
const TRINKET_BY_ID = new Map([...TRINKETS, ...MORE_TRINKETS].map((t) => [t.id, t]));
const CRAFTED_BY_ID = new Map(CRAFTING.utilityItems.map((u) => [u.id, u]));
const DECORATION_BY_ID = new Map([...DECORATIONS_EMBER, ...DECORATIONS_MATERIAL].map((d) => [d.id, d]));
/** Trinkets and crafted pieces with delivered icons (the art pack's `icon-*` frames). */
const ART_ICONS = new Set(['whittled-fox', 'beeswax-candle', 'river-glass-bead', 'spare-bootlace', 'tin-whistle', 'lamp-wick', 'oilcloth-wrap', 'wooden-peg']);

const titleCase = (id: string) => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** One pack id, described. */
function describe(id: string, qty: number): InventoryEntry {
  const art = ART_ICONS.has(id) ? `icon-${id}` : null;
  if (QUEST_ITEMS.includes(id)) {
    const info = ITEM_INFO[id];
    return { key: `quest:${id}`, tab: 'tools', section: 'road', kind: 'quest', id, name: info?.name ?? titleCase(id), blurb: info?.blurb ?? '', qty, art: null, icon: info?.icon ?? 'scroll' };
  }
  if (id === CHARM_ITEM) {
    const info = ITEM_INFO[id];
    return { key: `item:${id}`, tab: 'keepsakes', section: 'main', kind: 'charm', id, name: info?.name ?? 'Ember Charm', blurb: info?.blurb ?? '', qty, art: null, icon: 'ember' };
  }
  const crafted = CRAFTED_BY_ID.get(id);
  if (crafted) {
    return { key: `item:${id}`, tab: 'supplies', section: 'main', kind: 'crafted', id, name: crafted.name, blurb: CRAFTED_BLURBS[id] ?? '', qty, art, icon: 'sparkle' };
  }
  const trinket = TRINKET_BY_ID.get(id);
  if (trinket) {
    return { key: `item:${id}`, tab: 'keepsakes', section: 'main', kind: 'trinket', id, name: trinket.name, blurb: trinket.blurb, qty, art, icon: 'sparkle' };
  }
  const info = ITEM_INFO[id];
  return { key: `item:${id}`, tab: 'keepsakes', section: 'main', kind: 'other', id, name: info?.name ?? titleCase(id), blurb: info?.blurb ?? '', qty, art, icon: info?.icon ?? 'sparkle' };
}

/** Everything carried, described (unsorted; see `groupInventory`). */
export function inventoryEntries(src: InventorySource): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  // Materials: known balances win over the pack's guest entries.
  const materials = src.materials ?? materialsFromPack(src.pack);
  for (const m of MATERIALS) {
    const qty = Math.max(0, Math.floor(materials[m.id] ?? 0));
    if (qty > 0) {
      out.push({ key: `material:${m.id}`, tab: 'supplies', section: 'main', kind: 'material', id: m.id, name: m.name, blurb: m.blurb, qty, art: `icon-${m.id}`, icon: MATERIAL_ICON[m.id] ?? 'sparkle' });
    }
  }
  // Pack items, counted by the server where it has told us.
  const seen = new Set<string>();
  for (const id of src.pack) {
    if (id.startsWith(MATERIAL_ITEM_PREFIX) || seen.has(id)) continue;
    seen.add(id);
    const qty = src.items?.[id] ?? 1;
    if (qty > 0) out.push(describe(id, qty));
  }
  for (const [id, n] of Object.entries(src.items ?? {})) {
    if (!seen.has(id) && n > 0) {
      seen.add(id);
      out.push(describe(id, n));
    }
  }
  // Home goods: per piece, how many are set out and how many put away.
  const byDef = new Map<string, { placed: number; stored: number }>();
  for (const d of src.decorations ?? []) {
    const row = byDef.get(d.itemDef) ?? { placed: 0, stored: 0 };
    if (d.scene) row.placed += 1;
    else row.stored += 1;
    byDef.set(d.itemDef, row);
  }
  for (const [id, row] of byDef) {
    const def = DECORATION_BY_ID.get(id);
    out.push({
      key: `decoration:${id}`,
      tab: 'home',
      section: 'main',
      kind: 'decoration',
      id,
      name: def?.name ?? titleCase(id),
      blurb: def?.blurb ?? '',
      qty: row.placed + row.stored,
      art: null,
      icon: 'home',
      placed: row.placed,
      stored: row.stored,
    });
  }
  return out;
}

const MATERIAL_ORDER = MATERIALS.map((m) => m.id);
const KIND_ORDER: Record<ItemKind, number> = { material: 0, crafted: 1, charm: 0, trinket: 1, other: 2, quest: 0, decoration: 0 };

function compare(a: InventoryEntry, b: InventoryEntry): number {
  if (a.section === 'road' && b.section === 'road') return QUEST_ITEMS.indexOf(a.id) - QUEST_ITEMS.indexOf(b.id);
  const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (k !== 0) return k;
  if (a.kind === 'material' && b.kind === 'material') return MATERIAL_ORDER.indexOf(a.id) - MATERIAL_ORDER.indexOf(b.id);
  return a.name.localeCompare(b.name);
}

export type InventoryGroups = Record<ItemTab, { main: InventoryEntry[]; road: InventoryEntry[] }>;

/**
 * Entries by tab, sorted: supplies are materials (timber, stone, fiber,
 * amber) then crafted pieces by name; keepsakes the charm, then trinkets by
 * name, then anything else; home goods by name; the road's quest items in
 * story order.
 */
export function groupInventory(entries: readonly InventoryEntry[]): InventoryGroups {
  const out: InventoryGroups = {
    tools: { main: [], road: [] },
    supplies: { main: [], road: [] },
    keepsakes: { main: [], road: [] },
    home: { main: [], road: [] },
  };
  for (const e of entries) out[e.tab][e.section].push(e);
  for (const tab of Object.values(out)) {
    tab.main.sort(compare);
    tab.road.sort(compare);
  }
  return out;
}

/** Entries not yet seen on this device. */
export function unseen(entries: readonly InventoryEntry[], seen: ReadonlySet<string>): InventoryEntry[] {
  return entries.filter((e) => !seen.has(e.key));
}

/** Which tabs have something new (for the tab dots). */
export function newTabs(entries: readonly InventoryEntry[], seen: ReadonlySet<string>): Set<ItemTab> {
  return new Set(unseen(entries, seen).map((e) => e.tab));
}
