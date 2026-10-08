/**
 * The inventory, as data: everything you carry, sorted into the panel's tabs
 * (docs/hands-on-design.md section 2). Pure: the panel feeds it the pack's
 * quest things, the server counts it has, and your home's decorations.
 *
 * Today's sources:
 * - the pack (`GameState.inventory`): quest items and the Ember Charm;
 * - server counts in a world (materials, items, decorations), when read;
 * - your home's decoration instances (placed or not).
 *
 * Tools have no items yet: that tab shows its empty state until the richer
 * item model (wear, effects) lands.
 */
import { ITEM_INFO } from '../content/world.ts';
import { DECORATIONS_EMBER, DECORATIONS_MATERIAL, MATERIALS, MORE_TRINKETS, TRINKETS } from '../content/expansion-writing.ts';
import { CRAFTED_BLURBS, inventoryCopy as INVENTORY_WEAR } from '../content/inventory.ts';
import { CRAFTING } from './workshop.ts';
import { QUEST_ITEMS } from './api/progress.ts';
import { CHARM_ITEM } from './embers.ts';
import type { Asset, InstanceView, ItemsView, MakerView } from './api/types.ts';
import { assetKind, itemName, effectLine, slotCount, giveable, heldEffects, iconId, iconState, itemDef, offHandable, usableNow, wearRuleLine, type ItemDef } from './items.ts';

export type InventoryTab = 'tools' | 'supplies' | 'keepsakes' | 'home' | 'papers';
export type ItemTab = Exclude<InventoryTab, 'papers'>;
type ItemKind =
  | 'material'
  | 'crafted'
  | 'trinket'
  | 'charm'
  | 'quest'
  | 'decoration'
  | 'other'
  // The item model (a world): content/items.json kinds.
  | 'tool'
  | 'off-hand'
  | 'carry-gear'
  | 'fitting'
  | 'consumable'
  | 'part'
  | 'seed'
  | 'keepsake';

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
  /** The item model (in a world): one instance (tools, gear, fittings). */
  instance?: InstanceView;
  /** Who made it (a maker's mark), when anyone did. */
  maker?: MakerView | null;
  /** The art frame for its current wear state (item-bench-axe-worn), when there is one. */
  stateArt?: string | null;
  /** What it can do here: one use, a pocket, the off hand, a hand-over, mending. */
  usable?: boolean;
  pocketable?: boolean;
  carryable?: boolean;
  giveable?: boolean;
  mendable?: boolean;
  /** Which pocket holds it (1, 2), or whether the off hand does. */
  pocket?: number | null;
  inHand?: boolean;
  /** Its helps and rules, in words. */
  helps?: string[];
  rule?: string;
}

export interface InventorySource {
  /** GameState.inventory. */
  pack: readonly string[];
  /** Known material balances (a world's, or the Wilds' latest). */
  materials?: Record<string, number> | null;
  /** Known item counts in a world (trinkets, crafted pieces). Ids in the pack count 1 without them. */
  items?: Record<string, number> | null;
  /** Your home's decorations: one per instance, `scene` null when not set out. */
  decorations?: ReadonlyArray<{ itemDef: string; scene: string | null }>;
}

/**
 * The pack entry prefix for a material balance. Guest packs kept materials
 * this way (`material:<id>:<qty>`); the Wilds store still writes and reads
 * the form until the server owns the balance (TODO(D), src/game/wilds/store.ts).
 */
export const MATERIAL_ITEM_PREFIX = 'material:';

/** A guest's materials from their pack (`material:<id>:<qty>`), every material listed. TODO(D): goes with src/game/wilds/store.ts's guest pack. */
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

/** Everything carried, described (unsorted; see `newestFirst`). */
export function inventoryEntries(src: InventorySource): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  for (const m of MATERIALS) {
    const qty = Math.max(0, Math.floor(src.materials?.[m.id] ?? 0));
    if (qty > 0) {
      out.push({ key: `material:${m.id}`, tab: 'supplies', section: 'main', kind: 'material', id: m.id, name: m.name, blurb: m.blurb, qty, art: `icon-${m.id}`, icon: MATERIAL_ICON[m.id] ?? 'sparkle' });
    }
  }
  // Pack items, counted by the server where it has told us.
  const seen = new Set<string>();
  for (const id of src.pack) {
    if (seen.has(id)) continue;
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

// ------------------------------------------------------------ the item model (a world)

const KIND_OF: Record<string, ItemKind> = {
  tool: 'tool',
  'off-hand': 'off-hand',
  'carry-gear': 'carry-gear',
  fitting: 'fitting',
  consumable: 'consumable',
  material: 'material',
  part: 'part',
  seed: 'seed',
  keepsake: 'keepsake',
};

/** An item's picture (its art key, and the icon when the art isn't drawn): the bag's, everywhere it's listed. */
export function itemArt(d: ItemDef): { art: string; icon: string } {
  const legacyArt = MATERIAL_ICON[d.id] ? `icon-${d.id}` : ART_ICONS.has(d.id) ? `icon-${d.id}` : null;
  return {
    art: legacyArt ?? iconId(d.id),
    icon: d.kind === 'material' ? (MATERIAL_ICON[d.id] ?? 'stone') : d.kind === 'tool' ? 'sword' : d.kind === 'keepsake' ? 'sparkle' : 'bag',
  };
}

function modelEntry(d: ItemDef, base: Partial<InventoryEntry> & { key: string; qty: number }, view: ItemsView): InventoryEntry {
  const pocket = view.pockets.findIndex((p) => p.itemDef === d.id && !base.instance);
  const hand = view.offHand.open && (base.instance ? view.offHand.instance === base.instance.id : !view.offHand.instance && view.offHand.itemDef === d.id);
  const helps = [...(d.pocket ?? []), ...(d.use ?? []), ...(offHandable(d) ? heldEffects(d, view.offHand.class) : [])].map(effectLine);
  // Each class has an affinity item that works a little better in their hands.
  if (d.affinity && view.offHand.class === d.affinity.class) helps.push(`A little better in a ${d.affinity.class}’s hands`);
  const pic = itemArt(d);
  return {
    tab: d.tab === 'papers' ? 'supplies' : d.tab,
    section: 'main',
    kind: KIND_OF[d.kind] ?? 'other',
    id: d.id,
    name: d.name,
    blurb: d.blurb,
    art: pic.art,
    // A stack drawn in a state of another item's art (dried flowers: the
    // bloom flowers' dried posy); the panel falls back to `art`.
    stateArt: d.iconState ? `item-${iconId(d.id)}-${d.iconState}` : null,
    icon: pic.icon,
    maker: null,
    usable: usableNow(d),
    pocketable: d.kind === 'keepsake',
    carryable: offHandable(d) && view.offHand.open,
    giveable: giveable(d),
    mendable: false,
    pocket: pocket >= 0 ? pocket + 1 : null,
    inHand: hand,
    helps,
    rule: wearRuleLine(d),
    ...base,
  };
}

/**
 * Everything carried in a world, from the server's item model: stacks (one
 * row per maker), instances (one row each, with condition and fittings),
 * plus the save's quest things and your home's decorations.
 */
export function modelEntries(view: ItemsView, src: Pick<InventorySource, 'pack' | 'decorations'>): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  for (const st of view.stacks) {
    const d = itemDef(st.itemDef);
    if (!d) continue;
    const key = d.kind === 'material' ? `material:${d.id}` : st.maker ? `item:${d.id}@${st.maker.id}` : `item:${d.id}`;
    const prior = out.find((e) => e.key === key);
    if (prior) {
      prior.qty += st.qty;
      continue;
    }
    out.push(modelEntry(d, { key, qty: st.qty, maker: st.maker }, view));
  }
  for (const inst of view.instances) {
    const d = itemDef(inst.itemDef);
    if (!d) continue;
    const state = iconState(d.id, inst.state);
    out.push(
      modelEntry(
        d,
        {
          key: `inst:${inst.id}`,
          qty: 1,
          instance: inst,
          maker: inst.maker,
          stateArt: state ? `item-${iconId(d.id)}-${state}` : null,
          mendable: !!d.repair && inst.condition < inst.maxCondition,
          rule: inst.wardenSet
            ? inst.condition === inst.maxCondition
              ? 'Warden-set: sharp. Never breaks; dulls with use and heals overnight or on a lit tool rack.'
              : inst.condition === 0
                ? inst.fittings?.some((f) => f.fitting === 'bite')
                  ? 'Warden-set: at its dullest (works at three-quarters speed). Sharp by morning or after an hour on a lit tool rack.'
                  : 'Warden-set: at its dullest (works at half speed). Sharp by morning or after an hour on a lit tool rack.'
                : `Warden-set: dulling with use (${inst.usesLeft === 1 ? '1 use left' : `${inst.usesLeft} uses left`}). Heals overnight or on a lit tool rack.`
            : wearRuleLine(d),
        },
        view,
      ),
    );
  }
  // Quest things ride in the save, as before.
  const seen = new Set<string>();
  for (const id of src.pack) {
    if (!QUEST_ITEMS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(describe(id, 1));
  }
  for (const e of inventoryEntries({ pack: [], materials: {}, decorations: src.decorations })) out.push(e);
  return out;
}

/** Which instances could take this fitting (tools in the pack with a free slot and no fitting of its kind). */
export function fitTargets(view: ItemsView, fitting: InstanceView): InstanceView[] {
  const kind = itemDef(fitting.itemDef)?.fitting;
  return view.instances.filter((t) => {
    const d = itemDef(t.itemDef);
    if (!d || d.kind !== 'tool' || t.id === fitting.id) return false;
    return t.fittings.length < slotCount(d) && !t.fittings.some((f) => f.fitting === kind);
  });
}

const MATERIAL_ORDER = MATERIALS.map((m) => m.id);
const KIND_ORDER: Record<ItemKind, number> = {
  material: 0,
  crafted: 1,
  charm: 0,
  trinket: 1,
  other: 2,
  quest: 0,
  decoration: 0,
  tool: 0,
  'off-hand': 1,
  'carry-gear': 2,
  consumable: 2,
  fitting: 3,
  part: 4,
  seed: 5,
  keepsake: 1,
};

function compare(a: InventoryEntry, b: InventoryEntry): number {
  if (a.section === 'road' && b.section === 'road') return QUEST_ITEMS.indexOf(a.id) - QUEST_ITEMS.indexOf(b.id);
  const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (k !== 0) return k;
  if (a.kind === 'material' && b.kind === 'material') {
    const rank = (id: string) => (MATERIAL_ORDER.indexOf(id) + MATERIAL_ORDER.length + 1) % (MATERIAL_ORDER.length + 1);
    return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
  }
  return a.name.localeCompare(b.name);
}

/** Entries not yet seen on this device. */
export function unseen(entries: readonly InventoryEntry[], seen: ReadonlySet<string>): InventoryEntry[] {
  return entries.filter((e) => !seen.has(e.key));
}

/** Which tabs have something new (for the tab dots). */
export function newTabs(entries: readonly InventoryEntry[], seen: ReadonlySet<string>): Set<ItemTab> {
  return new Set(unseen(entries, seen).map((e) => e.tab));
}

/**
 * Newest first: what this device hasn't seen yet leads (in the usual order),
 * then everything else, the most recently seen batch first. Things seen
 * together (one look at the bag) share a stamp and keep the usual order
 * among themselves. Quest things stay at the end, in story order.
 */
export function newestFirst(entries: readonly InventoryEntry[], seenAt: ReadonlyMap<string, number>): InventoryEntry[] {
  const main = entries.filter((e) => e.section === 'main');
  const road = entries.filter((e) => e.section === 'road').sort(compare);
  const fresh = main.filter((e) => !seenAt.has(e.key)).sort(compare);
  const old = main.filter((e) => seenAt.has(e.key)).sort((a, b) => seenAt.get(b.key)! - seenAt.get(a.key)! || compare(a, b));
  return [...fresh, ...old, ...road];
}

/** What a recipe or a mend costs, in words: "2 timber, 1 fiber". */
export function costLine(cost: Record<string, number> | undefined): string {
  return Object.entries(cost ?? {})
    .map(([id, n]) => `${n} ${itemName(id).toLowerCase()}`)
    .join(', ');
}

/** The asset one of an entry is, for a hand-over (an instance by id; a stack with its maker). */
export function assetOf(e: Pick<InventoryEntry, 'id' | 'instance' | 'maker'>): Asset {
  const d = itemDef(e.id);
  const kind = d ? assetKind(d) : 'item';
  if (e.instance) return { kind: 'instance', id: e.id, qty: 1, instance: e.instance.id } as Asset;
  return { kind: kind === 'instance' ? 'item' : kind, id: e.id, qty: 1, maker: e.maker ? e.maker.id : '' } as Asset;
}

/** A tool's wear in words: "Sharp", "30 uses left", "Blunt…" (warden-set tools dull and come back). */
export function wearWords(i: InstanceView): string {
  if (i.wardenSet) {
    if (i.condition === i.maxCondition) return 'Sharp';
    if (i.condition === 0) return INVENTORY_WEAR.state['dull'] ?? 'Dull. Sharp again by morning.';
    return INVENTORY_WEAR.usesLeft(i.usesLeft);
  }
  return i.maxCondition === 0 ? INVENTORY_WEAR.neverWears : (INVENTORY_WEAR.state[i.state] ?? INVENTORY_WEAR.usesLeft(i.usesLeft));
}
