/**
 * Item definitions (content/items.json; docs/items/), validated against the
 * schema (proto/glimway/content/v1/items.proto) the same way the Go loader
 * (content/items.go) is, plus the pure helpers the inventory panel and the
 * game use: grade rules, wear states, icons, effects in words, pockets and
 * the off hand. No Phaser, no network.
 */
import { RESIDENTS, residentById, residentAt } from './residents.ts';
import itemsRaw from '../../content/items.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { ItemsSchema, type ItemAffinityValid, type ItemDefValid, type ItemGoodValid, type ItemGradeValid, type ItemMenderValid, type ItemPickupValid, type ItemSellerValid, type ItemsRulesValid, type PocketEffectValid, type HeldEffectValid, type UseEffectValid } from './gen/glimway/content/v1/items_pb.js';
import { HOMESTEAD_DATA } from './homestead.ts';
import { loadWilds } from './wilds/data.ts';
import { CALENDAR } from './calendar.ts';
import { ECONOMY } from './economy.ts';

const ITEM_TABS = ['tools', 'supplies', 'keepsakes', 'home', 'papers'] as const;
const ITEM_KINDS = ['tool', 'consumable', 'material', 'fitting', 'part', 'seed', 'keepsake', 'home-good', 'paper', 'off-hand', 'carry-gear'] as const;
const FITTING_KINDS = ['bite', 'hold', 'heft', 'glow', 'grip', 'remember'] as const;
/** Use effects the game applies today; a consumable is usable when all of its are. */
const IMPLEMENTED_USES: readonly string[] = ['restore-hp', 'restore-mana', 'clear-unmoored', 'ease-unmoored'];
const PICKUP_AREAS = ['village', 'woodland', 'ruin', 'commons'] as const;

type ItemTab = (typeof ITEM_TABS)[number];
type ItemKind = (typeof ITEM_KINDS)[number];
type FittingKind = (typeof FITTING_KINDS)[number];
export type AtZero = 'breaks' | 'blunt' | 'cracked' | 'never';
/** How a tool looks and behaves now (server-computed; also the icon state). */
export type WearState = 'whole' | 'worn' | 'blunt' | 'cracked' | 'dull';

/** One small, typed help (use, pocket or held: each carries its own type vocabulary). */
export type ItemEffect = UseEffectValid | PocketEffectValid | HeldEffectValid;
export type ItemAffinity = ItemAffinityValid;
/** One item definition, vocabularies narrowed once, at the loader. */
export type ItemDef = Omit<ItemDefValid, 'kind' | 'tab' | 'grade' | 'atZero' | 'fitting'> & {
  kind: ItemKind;
  tab: ItemTab;
  grade?: 'cheap' | 'heirloom' | 'special';
  atZero?: 'breaks' | 'blunt' | 'cracked';
  fitting?: FittingKind;
};
export type ItemPickup = Omit<ItemPickupValid, 'area'> & { area: (typeof PICKUP_AREAS)[number] };
/** One thing a seller sells (for embers), and what they say. */
export type ItemGood = ItemGoodValid;
/** A person or stall that sells goods: a named resident, or a festival-day stall. */
export type ItemSeller = Omit<ItemSellerValid, 'area' | 'tx' | 'ty'> & { area: string; tx: number; ty: number };
export type ItemMender = Omit<ItemMenderValid, 'area'> & { area: (typeof PICKUP_AREAS)[number] };
export type ItemGrade = ItemGradeValid;
/** Where the named residents stand (shared with the server's checks; derived, never authored). */
interface ItemResident { id: string; area: string; tx: number; ty: number }
export interface ItemRules extends Omit<ItemsRulesValid, 'menders'> { menders: ItemMender[]; residents: ItemResident[] }
export interface Items { rules: ItemRules; items: ItemDef[]; pickups: ItemPickup[]; sellers?: ItemSeller[] }

const AT_ZERO_FOR_GRADE: Record<string, readonly string[]> = { cheap: ['breaks'], heirloom: ['blunt', 'cracked'], special: ['never'] };

/** Throws on anything content/items.go would refuse. */
export function validateItems(value: unknown): Items {
  const bad = (why: string): never => {
    throw new Error(`invalid items: ${why}`);
  };
  const v = decodeContent(ItemsSchema, value, 'items', ['items', 'pickups', 'sellers']) as unknown as Items;
  const r = v.rules;
  const defs = new Map<string, ItemDef>();
  for (const d of v.items) {
    if (defs.has(d.id)) return bad(`duplicate id ${d.id}`);
    defs.set(d.id, d);
  }
  const npcs = new Set<string>();
  for (const m of r.menders) {
    if (npcs.has(m.npc)) return bad(`duplicate mender ${m.npc}`);
    npcs.add(m.npc);
  }
  for (const d of v.items) {
    const fail = (why: string): never => bad(`item ${d.id}: ${why}`);
    if (d.kind === 'tool') {
      const g = d.grade && r.grades[d.grade];
      if (!g) return fail('grade');
      if ((g.atZero === 'never') !== !d.uses) return fail('uses');
      if (d.atZero !== undefined && !AT_ZERO_FOR_GRADE[d.grade!].includes(d.atZero)) return fail('atZero');
      if (!d.actions.length) return fail('actions');
      const zero = d.atZero ?? g.atZero;
      if ((zero === 'blunt' || zero === 'cracked') !== !!d.repair) return fail('repair');
      if (d.repair) {
        const costsOK = (m: Record<string, number>) => Object.keys(m).length > 0 && Object.entries(m).every(([id, n]) => { const def = defs.get(id); return !!def && isStackable(def) && n >= 1 && n <= 1_000_000; });
        const rep = d.repair;
        if (!costsOK(rep.bench) || (rep.mender !== undefined && !costsOK(rep.mender)) || (!rep.mender && !rep.menderEmbers)) return fail('repair cost');
      }
    }
    if ((d.kind === 'consumable') !== !!d.use?.length) return fail('use');
    if (d.kind === 'home-good' && HOMESTEAD_DATA.items.find((h) => h.id === d.id)?.name !== d.name) return fail('home good not in homestead.json');
  }
  // Everything that can already be carried has a definition.
  const wilds = loadWilds();
  for (const m of wilds.materials) if (defs.get(m)?.kind !== 'material') bad(`wilds material ${m}`);
  for (const t of wilds.trinkets) if (defs.get(t)?.kind !== 'keepsake') bad(`wilds trinket ${t}`);
  if (defs.get(ECONOMY.charmItem)?.kind !== 'keepsake') bad('charm');
  const pickups = new Set<string>();
  for (const p of v.pickups) {
    const d = defs.get(p.item);
    if (pickups.has(p.id)) return bad(`duplicate pickup ${p.id}`);
    if (!d || !(isStackable(d) || isInstanced(d)) || (isInstanced(d) && p.qty !== 1)) return bad(`pickup ${p.id}`);
    if (p.usesLeft !== undefined && p.usesLeft > 0 && (d.kind !== 'tool' || p.usesLeft > (d.uses ?? 0))) return bad(`pickup ${p.id}: usesLeft`);
    pickups.add(p.id);
  }
  // Sellers: people and stalls that sell goods for embers (a festival
  // seller stands on its day only).
  const festivals = CALENDAR.festivals.map((f) => f.name);
  const sellers = new Set<string>();
  for (const s of v.sellers ?? []) {
    if (sellers.has(s.id)) return bad(`duplicate seller ${s.id}`);
    if (typeof s.npc !== 'string' || !s.npc || (s.with !== undefined ? !residentById(s.with) : !PICKUP_AREAS.includes(s.area as never))) return bad(`seller ${s.id}: place`);
    if (s.festival !== '' && !festivals.includes(s.festival)) return bad(`seller ${s.id}: festival`);
    sellers.add(s.id);
    const goods = new Set<string>();
    for (const g of s.goods) {
      const d = defs.get(g.item);
      if (goods.has(g.item)) return bad(`seller ${s.id}: duplicate good ${g.item}`);
      if (!d || !isStackable(d)) return bad(`seller ${s.id} good ${g.item}`);
      goods.add(g.item);
    }
  }
  // Compatibility for the outdoor builder while lane B switches to cycles.
  // These rows are derived from residents.json, never authored in items.json.
  const exterior = (id: string) => {
    const res = residentById(id)!;
    return Object.values(res.spots).find(s => !s.area.startsWith('in:')) ?? Object.values(res.spots)[0]!;
  };
  return {
    ...v,
    rules: {
      ...r,
      menders: r.menders.map((m) => ({ ...m, area: m.area as (typeof PICKUP_AREAS)[number] })),
      residents: RESIDENTS.residents.filter(res => res.id !== 'finn').map(res => ({ id: res.id, area: exterior(res.id).area, tx: exterior(res.id).tx, ty: exterior(res.id).ty })),
    },
    sellers: v.sellers?.map(s => s.with ? { ...s, area: exterior(s.with).area, tx: exterior(s.with).tx, ty: exterior(s.with).ty } : s),
  };
}

export const ITEMS: Items = validateItems(itemsRaw);
export const ITEM_RULES: ItemRules = ITEMS.rules;
const BY_ID = new Map(ITEMS.items.map((d) => [d.id, d]));

export function itemDef(id: string): ItemDef | null {
  return BY_ID.get(id) ?? null;
}

const titleCase = (id: string) => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** A display name for any carried id (home goods from homestead.json). */
export function itemName(id: string): string {
  return itemDef(id)?.name ?? HOMESTEAD_DATA.items.find((h) => h.id === id)?.name ?? titleCase(id);
}

/** Wire kind for moving it: material, item (other stacks), instance or decoration. */
export function assetKind(d: Pick<ItemDef, 'kind'>): 'material' | 'item' | 'instance' | 'decoration' {
  if (d.kind === 'material') return 'material';
  if (d.kind === 'home-good') return 'decoration';
  return isInstanced(d) ? 'instance' : 'item';
}

export function offHandable(d: Pick<ItemDef, 'kind' | 'offHand'>): boolean {
  return d.kind === 'off-hand' || d.offHand === true;
}

/** Instanced items are kept one by one; every other carried item is a stack by count. */
export function isInstanced(d: Pick<ItemDef, 'kind'>): boolean {
  return ['tool', 'off-hand', 'carry-gear', 'fitting'].includes(d.kind);
}
export function isStackable(d: Pick<ItemDef, 'kind'>): boolean {
  return !isInstanced(d) && d.kind !== 'home-good';
}

export function atZeroRule(d: ItemDef): AtZero {
  if (d.kind !== 'tool') return 'never';
  return (d.atZero ?? ITEM_RULES.grades[d.grade ?? 'special'].atZero) as AtZero;
}

export function slotCount(d: ItemDef): number {
  if (d.kind !== 'tool') return 0;
  return d.slots ?? ITEM_RULES.grades[d.grade ?? 'special'].slots;
}

/** Heirlooms and story keepsakes stay with the one they were given to. */
export function giveable(d: ItemDef): boolean {
  if (d.bound) return false;
  return !(d.grade && ITEM_RULES.grades[d.grade].bound);
}

export function usableNow(d: ItemDef): boolean {
  return d.kind === 'consumable' && !!d.use?.length && d.use.every((e) => IMPLEMENTED_USES.includes(e.type));
}

/** Condition as a 0..1 fraction (1 for things that never wear). */
export function conditionFraction(v: { condition: number; maxCondition: number }): number {
  return v.maxCondition > 0 ? Math.max(0, Math.min(1, v.condition / v.maxCondition)) : 1;
}

/** Dullness as a 0..1 fraction for warden-set tools (0: sharp, 1: dullest). */
export function toolDullness(v: { condition: number; maxCondition: number; wardenSet?: boolean }): number {
  if (!v.wardenSet || v.maxCondition === 0) return 0;
  return Math.max(0, Math.min(1, 1 - v.condition / v.maxCondition));
}

/** Working speed multiplier for a warden-set tool (1.0 sharp; 0.5 dullest, 0.75 with Bite). */
export function toolWorkSpeed(v: { condition: number; maxCondition: number; wardenSet?: boolean; fittings?: Array<{ fitting: string }> }): number {
  if (!v.wardenSet || v.maxCondition === 0) return 1;
  const dullness = toolDullness(v);
  const hasBite = v.fittings?.some((f) => f.fitting === 'bite') ?? false;
  const minSpeed = hasBite ? 0.75 : 0.5;
  return Math.round((1 - dullness * (1 - minSpeed)) * 100) / 100;
}

/**
 * The icon state for a tool's art (items-pass frames: whole, worn, blunt,
 * cracked). A dull warden-set tool shows worn.
 */
export function iconState(id: string, state: WearState): string | undefined {
  const d = itemDef(id);
  if (!d || d.kind !== 'tool' || atZeroRule(d) === 'never') return undefined;
  if (state === 'dull') return 'worn';
  return state;
}

/** The art id to draw (an icon override, else the id). */
export function iconId(id: string): string {
  const icon = itemDef(id)?.icon;
  return icon ? icon : id;
}

/** "Breaks at zero" / "Blunt at zero until mended" / "Never wears". */
export function wearRuleLine(d: ItemDef): string {
  switch (atZeroRule(d)) {
    case 'breaks':
      return `Wears out after about ${d.uses} uses, then breaks.`;
    case 'blunt':
      return `About ${d.uses} uses before it's blunt. Mend it at your bench, or ask Silas or Orrin.`;
    case 'cracked':
      return `About ${d.uses} uses before it cracks. Mend it at your bench, or ask Silas or Orrin.`;
    default:
      return d.kind === 'tool' ? 'Never wears.' : '';
  }
}

const FITTING_WORDS: Record<FittingKind, string> = {
  bite: 'Bite: fewer swings',
  hold: 'Hold: wears slower',
  heft: 'Heft: lighter and faster',
  glow: 'Glow: a faint light',
  grip: 'Grip: rarely dropped',
  remember: 'Remember: never breaks',
};
export function fittingLine(kind: string): string {
  return FITTING_WORDS[kind as FittingKind] ?? kind;
}

/** Small helps in words (never "+X%": docs/items/overview.md principle 3). */
export function effectLine(e: ItemEffect): string {
  switch (e.type) {
    case 'restore-hp':
      return 'Mends you a little';
    case 'restore-mana':
      return e.seconds ? 'Mana comes back slowly' : 'Mana comes back';
    case 'clear-unmoored':
      return 'Clears the drift’s sway at once';
    case 'ease-unmoored':
      return 'Eases the drift’s sway';
    case 'wisps-forget':
      return 'Wisps forget you for a while';
    case 'refill-lantern':
      return 'Refills a lantern';
    case 'light-post':
      return 'Lights a lantern post';
    case 'papers-glint':
      return 'Papers glint brighter';
    case 'notice-later':
      return `${e.target ? e.target[0].toUpperCase() + e.target.slice(1) : 'Things'} take longer to notice you`;
    case 'gather-more':
      return `A little extra ${e.target ?? ''} when gathering`.trim();
    case 'pond-skip':
      return 'One more skip on the pond';
    case 'wend-gives-more':
      return 'The Wend gives small things back more often';
    case 'light':
      return 'Lights the way';
    case 'wisps-keep-off':
      return 'Wisps keep further off';
    case 'compass':
      return 'Leans toward the nearest named light';
    case 'remedy-at-hand':
      return 'A remedy always at hand';
    case 'whistle':
      return 'Echoes nearby answer it';
    case 'papers-chime':
      return 'Hidden papers chime back';
    default:
      return e.type;
  }
}

/** The off-hand helps for a class: the affinity version when it matches. */
export function heldEffects(d: ItemDef, cls: string | null): ItemEffect[] {
  if (d.affinity && cls && d.affinity.class === cls) return d.affinity.held;
  return d.held ?? [];
}

/** Pickups lying in an area that this player hasn't taken yet. */
export function pickupsIn(area: string, taken: readonly string[]): ItemPickup[] {
  return ITEMS.pickups.filter((p) => p.area === area && !taken.includes(p.id));
}

export function pickupById(id: string): ItemPickup | null {
  return ITEMS.pickups.find((p) => p.id === id) ?? null;
}

/** The mender (Silas, Orrin) whose spot is within reach, if any. */
export function menderNear(area: string, x: number, y: number, tile = 16): ItemMender | null {
  for (const m of ITEM_RULES.menders) {
    if (m.area !== area) continue;
    const dx = x - (m.tx * tile + tile / 2);
    const dy = y - (m.ty * tile + tile / 2);
    const r = m.radiusTiles * tile;
    if (dx * dx + dy * dy <= r * r) return m;
  }
  return null;
}

/** A seller by id (shared content; the server checks the same rows). */
export function sellerFor(id: string, now?: number): ItemSeller | null {
  const seller = ITEMS.sellers?.find(s => s.id === id) ?? null;
  if (seller?.with && now !== undefined) return { ...seller, ...residentAt(seller.with, now)! };
  return seller;
}

/** Any pocketed keepsake gives this help (e.g. papers-glint). */
export function pocketHelps(pocketed: readonly (string | null)[], type: string): boolean {
  return pocketed.some((id) => !!id && !!itemDef(id)?.pocket?.some((e) => e.type === type));
}

/** What the hero is doing this frame, as far as the off hand cares. */
export interface HeroActivity {
  seated: boolean;
  /** Swinging, casting, rolling or reeling from a hit: fighting. */
  fighting: boolean;
  /** Chopping, digging or drawing water (gathering, when it comes). */
  working?: boolean;
}

/** How long the off-hand item stays tucked away after the last swing (ms). */
export const OFF_HAND_TUCK_MS = 1200;

/**
 * The off-hand item is put away while you sit, work or fight, and comes back
 * a moment afterward (the player never manages it). Returns whether it is
 * tucked now and until when.
 */
export function offHandTuck(a: HeroActivity, now: number, tuckedUntil: number): { tucked: boolean; until: number } {
  const until = a.seated || a.fighting || a.working ? now + OFF_HAND_TUCK_MS : tuckedUntil;
  return { tucked: now < until, until };
}

/** "a comfrey salve", "2 Lamp Wicks", "Finn's oatcakes", "the Empty Chair". */
export function giftPhrase(itemId: string, qty: number): string {
  const name = itemName(itemId);
  // Preserve names that already carry an article, a maker's name, or proper-name casing.
  const article = name.match(/^(a|an|the)\s/i)?.[1]?.toLowerCase();
  const proper = /[’']s\b/.test(name);
  const articleName = name.replace(/^(?:a|an|the)\s/i, '');
  const shown = article ? `${article} ${article === 'the' ? articleName : articleName.toLowerCase()}` : proper ? name : name.toLowerCase();
  if (qty === 1) {
    if (article) return shown;
    if (proper) return shown;
    return `${/^[aeiou]/i.test(shown) ? 'an' : 'a'} ${shown}`;
  }
  if (article) return `${qty} ${shown.replace(/^(?:a|an|the)\s/i, '')}`;
  return `${qty} ${name}${name.endsWith('s') ? '' : 's'}`;
}
